/**
 * GoldSlotAPI.mjs
 * Thin wrapper around the agent.goldslotpalase.com v4 REST API.
 */

import https from "https";
import http from "http";
import zlib from "zlib";
import { URL } from "url";

/**
 * Sanitise a display name so it always meets the API's min-length-2 rule.
 * Strips to alphanumeric + spaces, then pads with "_" if still too short.
 */
function safeName(raw, fallback) {
  let n = String(raw ?? fallback ?? "").trim();
  // Remove characters the API is likely to reject (control chars, etc.)
  n = n.replace(/[\x00-\x1f]/g, "").trim();
  // Must be at least 2 chars
  if (n.length < 2) n = (n + "__").slice(0, Math.max(2, n.length + 2));
  // Truncate to a safe max (most APIs cap display names at 64)
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
                enc === "br"  ? zlib.brotliDecompressSync(raw) :
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
  /**
   * @param {string} userId
   * @param {string} [name]  - display name; must be ≥2 chars (enforced here)
   * @param {number} [lang]
   */
  userCreate(userId, name, lang = 1) {
    const displayName = safeName(name ?? userId, userId);
    return this._post("/v4/user/create", {
      user_id: String(userId),
      name: displayName,
      language: lang,
    });
  }

  userInfo(userId) {
    return this._post("/v4/user/info", { user_id: String(userId) });
  }

  // 3. Wallet (Transfer Mode)
  walletDeposit(userId, amount, txId) {
    return this._post("/v4/wallet/deposit", {
      user_id: String(userId),
      amount: Math.floor(amount),
      tx_id: txId ?? `dep_${userId}_${Date.now()}`,
    });
  }

  walletWithdraw(userId, amount, txId) {
    return this._post("/v4/wallet/withdraw", {
      user_id: String(userId),
      amount: Math.floor(amount),
      tx_id: txId ?? `wd_${userId}_${Date.now()}`,
    });
  }

  walletWithdrawAll(userId, txId) {
    return this._post("/v4/wallet/withdraw-all", {
      user_id: String(userId),
      tx_id: txId ?? `wdall_${userId}_${Date.now()}`,
    });
  }

  // 4. Game Details
  getProviders(lang = 1) { return this._post("/v4/game/providers", { language: lang }); }
  getGames(provider, lang = 1) { return this._post("/v4/game/games", { provider, language: lang }); }
  getAllGames(lang = 1) { return this._post("/v4/game/all", { language: lang }); }

  // 5. Game Launch
  getGameUrl(userId, gameId, returnUrl = "", lang = 1) {
    return this._post("/v4/game/game-url", {
      user_id: String(userId),
      game_id: String(gameId),
      return_url: returnUrl,
      language: lang,
    });
  }

  getOnlineGames() { return this._post("/v4/game/online-games"); }

  // 6. Transactions
  getTransactions(startDate, endDate, opts = {}) {
    return this._post("/v4/game/transaction", { start_date: startDate, end_date: endDate, ...opts });
  }

  // 7. Statistics
  getUserStats(userId, startDate, endDate) {
    return this._post("/v4/statistics/user", {
      user_id: String(userId),
      start_date: startDate,
      end_date: endDate,
    });
  }
}
