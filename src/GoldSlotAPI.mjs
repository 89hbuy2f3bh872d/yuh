/**
 * GoldSlotAPI.mjs — agent.goldslotpalase.com v4
 *
 * CONFIRMED from Postman docs + live API behaviour:
 *   MODE: Seamless — the callback URL IS the wallet.
 *         /v4/wallet/* endpoints are NOT used.
 *
 *   /v4/user/create  → body: { name }          → returns user_code (integer)
 *   /v4/game/game-url→ body: { user_code: int,  → MUST be integer, not name string
 *                              game_code: string,
 *                              language: int,
 *                              lobby_url: string,   ← back button URL
 *                              callback_url: string }← seamless wallet URL
 *
 *   Callback from GoldSlot server → POST /callback
 *     data.account = the name string passed to userCreate ("gs_<localUid>")
 *     commands: authenticate, balance, bet, win, cancel, status
 *
 *   VALIDATION_ERROR 1002 causes:
 *     - Sending unknown field names (return_url instead of lobby_url)
 *     - Missing required fields (callback_url in seamless mode)
 *     - user_code passed as string instead of integer
 */

import https from "https";
import http  from "http";
import zlib  from "zlib";
import { URL } from "url";

function safeName(raw, fallback) {
  let n = String(raw ?? fallback ?? "").trim().replace(/[\x00-\x1f]/g, "").trim();
  if (n.length < 2) n = (n + "__").slice(0, Math.max(2, n.length + 2));
  return n.slice(0, 64);
}

export class GoldSlotAPI {
  constructor(apiToken, baseUrl = "https://agent.goldslotpalase.com", callbackUrl = "") {
    this.apiToken    = apiToken;
    this.baseUrl     = baseUrl.replace(/\/$/, "");
    this.callbackUrl = callbackUrl; // e.g. "https://www.sirgreen.online/callback"
  }

  _post(path, body = {}) {
    return new Promise((resolve, reject) => {
      const parsed  = new URL(`${this.baseUrl}${path}`);
      const payload = Buffer.from(JSON.stringify(body));
      const headers = {
        Authorization:     `Bearer ${this.apiToken}`,
        Accept:            "application/json",
        "Content-Type":    "application/json",
        "Content-Length":  payload.length,
        "User-Agent":      "FluxerCasinoBot/4.0",
        "Accept-Encoding": "gzip, deflate, br",
      };
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
          try   { resolve(JSON.parse(decomp.toString("utf8"))); }
          catch (e) { reject(new Error(`GoldSlot non-JSON (HTTP ${res.statusCode}): ${decomp.slice(0,200)}`)); }
        });
      });
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
  }

  // ── 1. Agent ──────────────────────────────────────────────────────────────
  agentInfo() { return this._post("/v4/agent/info"); }

  // ── 2. User ───────────────────────────────────────────────────────────────
  // Idempotent — safe to call every session. Returns { user_code, is_new_user }.
  userCreate(name, parent) {
    const body = { name: safeName(name) };
    if (parent) body.parent = parent;
    return this._post("/v4/user/create", body);
  }

  // Lookup by integer user_code.
  userInfo(userCode) {
    return this._post("/v4/user/info", { user_code: Number(userCode) });
  }

  // ── 4. Game Details ───────────────────────────────────────────────────────
  getProviders(lang = 1) { return this._post("/v4/game/providers", { language: lang }); }
  getGames(provider, lang = 1) { return this._post("/v4/game/games", { provider, language: lang }); }
  getAllGames(lang = 1)  { return this._post("/v4/game/all",      { language: lang }); }

  // ── 5. Game Launch ────────────────────────────────────────────────────────
  //
  // user_code  — integer returned by userCreate (NEVER the name string)
  // gameCode   — game_code string from getAllGames
  // lobbyUrl   — where the in-game back/exit button returns the player
  // lang       — language id (1 = English)
  //
  // Seamless mode requires callback_url so GoldSlot knows where to POST
  // bet/win/cancel events. Without it the API returns VALIDATION_ERROR 1002.
  getGameUrl(userCode, gameCode, lobbyUrl = "", lang = 1) {
    const body = {
      user_code: Number(userCode),   // integer — MUST NOT be string
      game_code: String(gameCode),
      language:  lang,
    };
    if (lobbyUrl)        body.lobby_url    = lobbyUrl;
    if (this.callbackUrl) body.callback_url = this.callbackUrl;
    return this._post("/v4/game/game-url", body);
  }

  getOnlineGames() { return this._post("/v4/game/online-games"); }

  // ── 6. Transactions ───────────────────────────────────────────────────────
  getTransactions(startDate, endDate, opts = {}) {
    return this._post("/v4/game/transaction", { start_date: startDate, end_date: endDate, ...opts });
  }

  // ── 7. Statistics ─────────────────────────────────────────────────────────
  getUserStats(userCode, startDate, endDate) {
    return this._post("/v4/statistics/user", {
      user_code:  Number(userCode),
      start_date: startDate,
      end_date:   endDate,
    });
  }
}
