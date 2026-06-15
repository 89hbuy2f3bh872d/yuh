/**
 * GoldSlotAPI.mjs
 * Thin wrapper around the agent.goldslotpalase.com v4 REST API.
 *
 * KEY DESIGN NOTE:
 *   userCreate({ name }) returns { user_code, is_new_user }
 *   HOWEVER on this API version, userCreate returns the panel account/row ID
 *   in user_code, NOT the small integer user_code needed for wallet/game calls.
 *   Solution: always call userInfo({ name }) after userCreate to get the real
 *   user_code (a small integer like 1, 2, 3...).
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
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  _post(path, body = {}) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(`${this.baseUrl}${path}`);
      const payload = Buffer.from(JSON.stringify(body));
      const headers = {
        Authorization: `Bearer ${this.apiToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Content-Length": payload.length,
        "User-Agent": "FluxerCasinoBot/4.0",
        "Accept-Encoding": "gzip, deflate, br",
      };
      const mod = parsed.protocol === "https:" ? https : http;
      const req = mod.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method: "POST",
          headers,
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const raw = Buffer.concat(chunks);
            const enc = (res.headers["content-encoding"] ?? "").toLowerCase();
            let decomp;
            try {
              decomp =
                enc === "br"      ? zlib.brotliDecompressSync(raw) :
                enc === "gzip"    ? zlib.gunzipSync(raw) :
                enc === "deflate" ? zlib.inflateSync(raw) : raw;
            } catch { decomp = raw; }
            try {
              resolve(JSON.parse(decomp.toString("utf8")));
            } catch (e) {
              reject(new Error(`GoldSlot non-JSON (HTTP ${res.statusCode}): ${decomp.slice(0, 200)}`));
            }
          });
        },
      );
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
  }

  // 1. Agent
  agentInfo() { return this._post("/v4/agent/info"); }

  // 2. User Account
  // userCreate: name must be unique per agent. parent is the parent agent name.
  // Returns: { code, data: { user_code, is_new_user } }
  // NOTE: user_code returned here may be the panel account ID, not the real user_code.
  // Always follow up with userInfoByName to get the authoritative small integer user_code.
  userCreate(name, parent) {
    const body = { name: safeName(name) };
    if (parent) body.parent = parent;
    return this._post("/v4/user/create", body);
  }

  // userInfo: looks up by user_code (integer).
  userInfo(userCode) {
    return this._post("/v4/user/info", { user_code: Number(userCode) });
  }

  // userInfoByName: look up user by name — returns the real user_code small integer.
  userInfoByName(name) {
    return this._post("/v4/user/info", { name: safeName(name) });
  }

  // 3. Wallet (Transfer Mode)
  walletDeposit(userCode, amount, txId) {
    return this._post("/v4/wallet/deposit", {
      user_code: Number(userCode),
      amount: Math.floor(amount),
      tx_id: txId ?? `dep_${userCode}_${Date.now()}`,
    });
  }

  walletWithdraw(userCode, amount, txId) {
    return this._post("/v4/wallet/withdraw", {
      user_code: Number(userCode),
      amount: Math.floor(amount),
      tx_id: txId ?? `wd_${userCode}_${Date.now()}`,
    });
  }

  walletWithdrawAll(userCode, txId) {
    return this._post("/v4/wallet/withdraw-all", {
      user_code: Number(userCode),
      tx_id: txId ?? `wdall_${userCode}_${Date.now()}`,
    });
  }

  // 4. Game Details
  getProviders(lang = 1) { return this._post("/v4/game/providers", { language: lang }); }
  getGames(provider, lang = 1) { return this._post("/v4/game/games", { provider, language: lang }); }
  getAllGames(lang = 1) { return this._post("/v4/game/all", { language: lang }); }

  // 5. Game Launch
  getGameUrl(userCode, gameCode, returnUrl = "", lang = 1) {
    return this._post("/v4/game/game-url", {
      user_code:  Number(userCode),
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
      user_code: Number(userCode),
      start_date: startDate,
      end_date: endDate,
    });
  }
}
