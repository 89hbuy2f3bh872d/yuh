/**
 * GoldSlotAPI.mjs
 * Thin wrapper around the agent.goldslotpalase.com v4 REST API.
 * All methods return the parsed JSON body from the API.
 * Throws on network errors; callers should handle API-level { code } values.
 */

import https from "https";
import http from "http";
import zlib from "zlib";
import { URL } from "url";

export class GoldSlotAPI {
  /**
   * @param {string} apiToken   - Bearer token from agent settings
   * @param {string} [baseUrl]  - defaults to https://agent.goldslotpalase.com
   */
  constructor(apiToken, baseUrl = "https://agent.goldslotpalase.com") {
    this.apiToken = apiToken;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  // ---------------------------------------------------------------------------
  // Internal HTTP helper
  // ---------------------------------------------------------------------------
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
                enc === "br"
                  ? zlib.brotliDecompressSync(raw)
                  : enc === "gzip"
                    ? zlib.gunzipSync(raw)
                    : enc === "deflate"
                      ? zlib.inflateSync(raw)
                      : raw;
            } catch {
              decomp = raw;
            }
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

  // ---------------------------------------------------------------------------
  // 1. Agent Account
  // ---------------------------------------------------------------------------

  /** Get agent information */
  agentInfo() {
    return this._post("/v4/agent/info");
  }

  // ---------------------------------------------------------------------------
  // 2. User Account
  // ---------------------------------------------------------------------------

  /**
   * Create a user in the GoldSlot system.
   * @param {string} userId   - unique identifier (e.g. Discord/Fluxer user ID)
   * @param {string} [lang]   - language code 1-33 (default 1 = English)
   */
  userCreate(userId, lang = 1) {
    return this._post("/v4/user/create", { user_id: String(userId), language: lang });
  }

  /**
   * Get GoldSlot user info (balance, status …)
   * @param {string} userId
   */
  userInfo(userId) {
    return this._post("/v4/user/info", { user_id: String(userId) });
  }

  // ---------------------------------------------------------------------------
  // 3. User Wallet  (Transfer Mode)
  // ---------------------------------------------------------------------------

  /**
   * Deposit points into the user's GoldSlot wallet.
   * @param {string} userId
   * @param {number} amount    - positive integer
   * @param {string} [txId]    - unique transaction ID you supply
   */
  walletDeposit(userId, amount, txId) {
    const tx_id = txId ?? `dep_${userId}_${Date.now()}`;
    return this._post("/v4/wallet/deposit", {
      user_id: String(userId),
      amount: Math.floor(amount),
      tx_id,
    });
  }

  /**
   * Withdraw a specific amount from the user's GoldSlot wallet.
   * @param {string} userId
   * @param {number} amount
   * @param {string} [txId]
   */
  walletWithdraw(userId, amount, txId) {
    const tx_id = txId ?? `wd_${userId}_${Date.now()}`;
    return this._post("/v4/wallet/withdraw", {
      user_id: String(userId),
      amount: Math.floor(amount),
      tx_id,
    });
  }

  /**
   * Withdraw ALL funds from the user's GoldSlot wallet back to the agent.
   * @param {string} userId
   * @param {string} [txId]
   */
  walletWithdrawAll(userId, txId) {
    const tx_id = txId ?? `wdall_${userId}_${Date.now()}`;
    return this._post("/v4/wallet/withdraw-all", {
      user_id: String(userId),
      tx_id,
    });
  }

  // ---------------------------------------------------------------------------
  // 4. Game Details
  // ---------------------------------------------------------------------------

  /**
   * Get list of available game providers.
   * @param {number} [lang]  - language code (default 1 = English)
   */
  getProviders(lang = 1) {
    return this._post("/v4/game/providers", { language: lang });
  }

  /**
   * Get games for a specific provider.
   * @param {string} provider  - provider code e.g. "PP", "CQ9", "PG"
   * @param {number} [lang]
   */
  getGames(provider, lang = 1) {
    return this._post("/v4/game/games", { provider, language: lang });
  }

  /**
   * Get ALL games across all providers.
   * @param {number} [lang]
   */
  getAllGames(lang = 1) {
    return this._post("/v4/game/all", { language: lang });
  }

  // ---------------------------------------------------------------------------
  // 5. Game Launch
  // ---------------------------------------------------------------------------

  /**
   * Get the launch URL for a game.
   * @param {string} userId
   * @param {string} gameId    - game_id from the games list
   * @param {string} [returnUrl] - URL to return to after the game
   * @param {number} [lang]
   */
  getGameUrl(userId, gameId, returnUrl = "", lang = 1) {
    return this._post("/v4/game/game-url", {
      user_id: String(userId),
      game_id: String(gameId),
      return_url: returnUrl,
      language: lang,
    });
  }

  /**
   * Get list of currently running (online) games.
   */
  getOnlineGames() {
    return this._post("/v4/game/online-games");
  }

  // ---------------------------------------------------------------------------
  // 6. Game Transactions
  // ---------------------------------------------------------------------------

  /**
   * Search transactions by time range.
   * @param {string} startDate  - "YYYY-MM-DD HH:mm:ss"
   * @param {string} endDate
   * @param {object} [opts]     - optional filters: user_id, provider, page, page_size
   */
  getTransactions(startDate, endDate, opts = {}) {
    return this._post("/v4/game/transaction", {
      start_date: startDate,
      end_date: endDate,
      ...opts,
    });
  }

  // ---------------------------------------------------------------------------
  // 7. Statistics
  // ---------------------------------------------------------------------------

  /**
   * Get per-user statistics.
   * @param {string} userId
   * @param {string} startDate
   * @param {string} endDate
   */
  getUserStats(userId, startDate, endDate) {
    return this._post("/v4/statistics/user", {
      user_id: String(userId),
      start_date: startDate,
      end_date: endDate,
    });
  }
}
