/**
 * GoldSlotAPI.mjs — agent.goldslotpalase.com v4
 *
 * CONFIRMED from live API + verbose logging:
 *   MODE: Seamless — the callback URL IS the wallet.
 *         /v4/wallet/* endpoints are NOT used.
 *
 *   /v4/user/create  → body: { name }                    → returns user_code (integer)
 *   /v4/game/all     → returns games with field: game_code (e.g. "vs20fruitsw")
 *   /v4/game/game-url→ body: { user_code:    integer,     ← MUST be integer, not string
 *                              game_symbol:   string,      ← SAME VALUE as game_code from /game/all
 *                              language:      integer,       ← 1 = English
 *                              lobby_url:     string,       ← back button URL
 *                              callback_url:  string }      ← seamless wallet POST target
 *
 *   ⚠️  The field name mismatch is intentional on GoldSlot's side:
 *       /game/all       uses   game_code
 *       /game/game-url  uses   game_symbol
 *       Both fields carry the same value (e.g. "vs20fruitsw").
 *       Sending game_code to /game/game-url returns 1002 VALIDATION_ERROR
 *       with data: [{"field":"game_symbol","message":"The game_symbol field is required."}]
 *
 *   Callback from GoldSlot server → POST /callback
 *     data.account = the name string passed to userCreate ("gs_<localUid>")
 *     commands: authenticate, balance, bet, win, cancel, status
 *
 *   VALIDATION_ERROR 1002 causes:
 *     - Using game_code instead of game_symbol in /game/game-url  ← WAS THE BUG
 *     - Sending unknown field names
 *     - Missing required fields (callback_url in seamless mode)
 *     - user_code passed as string instead of integer
 */

import https from "https";
import http  from "http";
import zlib  from "zlib";
import { URL } from "url";

const TAG = "[GoldSlotAPI]";

function safeName(raw, fallback) {
  let n = String(raw ?? fallback ?? "").trim().replace(/[\x00-\x1f]/g, "").trim();
  if (n.length < 2) n = (n + "__").slice(0, Math.max(2, n.length + 2));
  return n.slice(0, 64);
}

export class GoldSlotAPI {
  constructor(apiToken, baseUrl = "https://agent.goldslotpalase.com", callbackUrl = "") {
    this.apiToken    = apiToken;
    this.baseUrl     = baseUrl.replace(/\/$/, "");
    this.callbackUrl = callbackUrl;

    console.log(`${TAG} Constructed`);
    console.log(`${TAG}   baseUrl     = ${this.baseUrl}`);
    console.log(`${TAG}   callbackUrl = ${this.callbackUrl || "(EMPTY — will cause 1002 in seamless mode!)"}`);
    console.log(`${TAG}   apiToken    = ${this.apiToken ? this.apiToken.slice(0,8) + "…" : "(MISSING — will cause TOKEN_NOT_FOUND!)"}`);
  }

  _post(path, body = {}) {
    return new Promise((resolve, reject) => {
      const fullUrl  = `${this.baseUrl}${path}`;
      const parsed   = new URL(fullUrl);
      const payload  = Buffer.from(JSON.stringify(body));
      const headers  = {
        Authorization:     `Bearer ${this.apiToken}`,
        Accept:            "application/json",
        "Content-Type":    "application/json",
        "Content-Length":  payload.length,
        "User-Agent":      "FluxerCasinoBot/4.0",
        "Accept-Encoding": "gzip, deflate, br",
      };

      console.log(`${TAG} ── REQUEST ──────────────────────────────`);
      console.log(`${TAG}   POST ${fullUrl}`);
      console.log(`${TAG}   Body (${payload.length} bytes): ${payload.toString("utf8")}`);
      console.log(`${TAG}   Field types: ${Object.entries(body).map(([k,v])=>`${k}:${typeof v}`).join(" | ")}`);
      console.log(`${TAG} ─────────────────────────────────────────`);

      const mod = parsed.protocol === "https:" ? https : http;
      const req = mod.request({
        hostname: parsed.hostname,
        port:     parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path:     parsed.pathname + parsed.search,
        method:   "POST",
        headers,
      }, (res) => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          const enc = (res.headers["content-encoding"] ?? "").toLowerCase();
          let decomp;
          try {
            decomp = enc === "br"      ? zlib.brotliDecompressSync(raw)
                   : enc === "gzip"    ? zlib.gunzipSync(raw)
                   : enc === "deflate" ? zlib.inflateSync(raw)
                   : raw;
          } catch { decomp = raw; }

          const bodyStr = decomp.toString("utf8");

          console.log(`${TAG} ── RESPONSE ─────────────────────────────`);
          console.log(`${TAG}   POST ${path} → HTTP ${res.statusCode}`);
          console.log(`${TAG}   Body: ${bodyStr.slice(0, 800)}`);

          let parsed_body;
          try {
            parsed_body = JSON.parse(bodyStr);
            console.log(`${TAG}   code=${parsed_body.code} message=${parsed_body.message ?? "(none)"}`);
            if (parsed_body.data !== undefined && parsed_body.code !== 0)
              console.log(`${TAG}   data=${JSON.stringify(parsed_body.data).slice(0, 400)}`);
            if (parsed_body.code !== 0)
              console.warn(`${TAG} ⚠️  code=${parsed_body.code} on POST ${path} | sent: ${payload.toString("utf8")}`);
          } catch (e) {
            console.error(`${TAG}   JSON parse failed: ${e.message}`);
            console.log(`${TAG} ─────────────────────────────────────────`);
            return reject(new Error(`GoldSlot non-JSON (HTTP ${res.statusCode}): ${bodyStr.slice(0,200)}`));
          }

          console.log(`${TAG} ─────────────────────────────────────────`);
          resolve(parsed_body);
        });
      });

      req.on("error", (err) => {
        console.error(`${TAG} !! Network error on POST ${path}: ${err.message}`);
        reject(err);
      });

      req.write(payload);
      req.end();
    });
  }

  // ── 1. Agent ──────────────────────────────────────────────────────────────
  agentInfo() {
    console.log(`${TAG} agentInfo()`);
    return this._post("/v4/agent/info");
  }

  // ── 2. User ───────────────────────────────────────────────────────────────
  userCreate(name, parent) {
    const safed = safeName(name);
    const body  = { name: safed };
    if (parent) body.parent = parent;
    console.log(`${TAG} userCreate() name="${safed}" parent=${parent ?? "(none)"}`);
    return this._post("/v4/user/create", body);
  }

  userInfo(userCode) {
    console.log(`${TAG} userInfo() userCode=${userCode} type=${typeof userCode}`);
    return this._post("/v4/user/info", { user_code: Number(userCode) });
  }

  // ── 4. Game Details ───────────────────────────────────────────────────────
  getProviders(lang = 1) {
    console.log(`${TAG} getProviders() lang=${lang}`);
    return this._post("/v4/game/providers", { language: lang });
  }
  getGames(provider, lang = 1) {
    console.log(`${TAG} getGames() provider=${provider} lang=${lang}`);
    return this._post("/v4/game/games", { provider, language: lang });
  }
  getAllGames(lang = 1) {
    console.log(`${TAG} getAllGames() lang=${lang}`);
    return this._post("/v4/game/all", { language: lang });
  }

  // ── 5. Game Launch ────────────────────────────────────────────────────────
  //
  // ⚠️  /v4/game/all returns games using field name "game_code".
  //     /v4/game/game-url requires that same value under field name "game_symbol".
  //     These are the same value — different key names in different endpoints.
  //
  getGameUrl(userCode, gameSymbol, lobbyUrl = "", lang = 1) {
    const body = {
      user_code:   Number(userCode),     // integer — MUST NOT be string
      game_symbol: String(gameSymbol),   // ← was game_code — THIS was the 1002 bug
      language:    lang,
    };
    if (lobbyUrl)         body.lobby_url    = lobbyUrl;
    if (this.callbackUrl) body.callback_url = this.callbackUrl;

    console.log(`${TAG} getGameUrl() user_code=${body.user_code} game_symbol="${body.game_symbol}" lang=${lang}`);
    console.log(`${TAG}   lobby_url    = ${body.lobby_url    ?? "(not set)"}`);
    console.log(`${TAG}   callback_url = ${body.callback_url ?? "(NOT SET — required in seamless mode!)"}`);
    console.log(`${TAG}   Full body    = ${JSON.stringify(body)}`);

    if (!body.callback_url)
      console.warn(`${TAG} ⚠️  callbackUrl is EMPTY — seamless mode requires it.`);
    if (!Number.isInteger(body.user_code) || body.user_code <= 0)
      console.warn(`${TAG} ⚠️  user_code=${body.user_code} looks invalid — must be positive integer.`);

    return this._post("/v4/game/game-url", body);
  }

  getOnlineGames() {
    console.log(`${TAG} getOnlineGames()`);
    return this._post("/v4/game/online-games");
  }

  // ── 6. Transactions ───────────────────────────────────────────────────────
  getTransactions(startDate, endDate, opts = {}) {
    console.log(`${TAG} getTransactions() ${startDate} → ${endDate}`);
    return this._post("/v4/game/transaction", { start_date: startDate, end_date: endDate, ...opts });
  }

  // ── 7. Statistics ─────────────────────────────────────────────────────────
  getUserStats(userCode, startDate, endDate) {
    console.log(`${TAG} getUserStats() userCode=${userCode} ${startDate} → ${endDate}`);
    return this._post("/v4/statistics/user", {
      user_code:  Number(userCode),
      start_date: startDate,
      end_date:   endDate,
    });
  }
}
