/**
 * GoldSlotAPI.mjs — agent.goldslotpalase.com v4
 *
 * KEY FINDING (from live logs):
 *   /v4/user/create returns user_code = panel account ID (large int, e.g. 407830262)
 *   /v4/user/info   does NOT accept { name }, only { user_code: int }
 *   /v4/wallet/*    returns USER_NOT_FOUND when called with user_code
 *   => wallet + game-url endpoints must be called with { name } not { user_code }
 */

import https from "https";
import http from "http";
import zlib from "zlib";
import { URL } from "url";

function safeName(raw, fallback) {
  let n = String(raw ?? fallback ?? "").trim().replace(/[\x00-\x1f]/g, "").trim();
  if (n.length < 2) n = (n + "__").slice(0, Math.max(2, n.length + 2));
  return n.slice(0, 64);
}

export class GoldSlotAPI {
  constructor(apiToken, baseUrl = "https://agent.goldslotpalase.com") {
    this.apiToken = apiToken;
    this.baseUrl  = baseUrl.replace(/\/$/, "");
  }

  _post(path, body = {}) {
    return new Promise((resolve, reject) => {
      const parsed  = new URL(`${this.baseUrl}${path}`);
      const payload = Buffer.from(JSON.stringify(body));
      const headers = {
        Authorization:    `Bearer ${this.apiToken}`,
        Accept:           "application/json",
        "Content-Type":   "application/json",
        "Content-Length": payload.length,
        "User-Agent":     "FluxerCasinoBot/4.0",
        "Accept-Encoding":"gzip, deflate, br",
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

  // 1. Agent
  agentInfo() { return this._post("/v4/agent/info"); }

  // 2. User
  // userCreate is idempotent — safe to call every session.
  userCreate(name, parent) {
    const body = { name: safeName(name) };
    if (parent) body.parent = parent;
    return this._post("/v4/user/create", body);
  }

  // userInfo by integer user_code (as documented)
  userInfo(userCode) {
    return this._post("/v4/user/info", { user_code: Number(userCode) });
  }

  // 3. Wallet — use name, NOT user_code (user_code causes USER_NOT_FOUND on this host)
  walletDeposit(name, amount, txId) {
    return this._post("/v4/wallet/deposit", {
      name:   safeName(name),
      amount: Math.floor(amount),
      tx_id:  txId ?? `dep_${Date.now()}`,
    });
  }

  walletWithdraw(name, amount, txId) {
    return this._post("/v4/wallet/withdraw", {
      name:   safeName(name),
      amount: Math.floor(amount),
      tx_id:  txId ?? `wd_${Date.now()}`,
    });
  }

  walletWithdrawAll(name, txId) {
    return this._post("/v4/wallet/withdraw-all", {
      name:  safeName(name),
      tx_id: txId ?? `wdall_${Date.now()}`,
    });
  }

  // 4. Game Details
  getProviders(lang = 1) { return this._post("/v4/game/providers", { language: lang }); }
  getGames(provider, lang = 1) { return this._post("/v4/game/games", { provider, language: lang }); }
  getAllGames(lang = 1) { return this._post("/v4/game/all", { language: lang }); }

  // 5. Game Launch — use name, NOT user_code
  getGameUrl(name, gameCode, returnUrl = "", lang = 1) {
    return this._post("/v4/game/game-url", {
      name:       safeName(name),
      game_code:  String(gameCode),
      return_url: returnUrl,
      language:   lang,
    });
  }

  getOnlineGames() { return this._post("/v4/game/online-games"); }

  // 6. Transactions
  getTransactions(startDate, endDate, opts = {}) {
    return this._post("/v4/game/transaction", { start_date: startDate, end_date: endDate, ...opts });
  }

  // 7. Statistics
  getUserStats(userCode, startDate, endDate) {
    return this._post("/v4/statistics/user", {
      user_code:  Number(userCode),
      start_date: startDate,
      end_date:   endDate,
    });
  }
}
