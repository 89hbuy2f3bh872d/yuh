import { MongoClient } from "mongodb";

/**
 * Compact field names to minimise Atlas free-tier storage:
 *   _id = userId
 *   bal = balance
 *   tw  = totalWon
 *   tl  = totalLost
 *   gp  = gamesPlayed
 *   ld  = lastDaily (Unix ms)
 *   st  = session tokens { token -> expiry }
 */

const DEFAULTS = { bal: 1_000, tw: 0, tl: 0, gp: 0, ld: 0 };

// Maximum values to cap balance at (prevents overflow exploits)
const MAX_BALANCE  = 9_000_000_000_000; // 9 trillion FC
const MAX_DELTA    = 9_000_000_000_000; // max single balance change
const MAX_FIELD_INC = 9_000_000_000_000;

// User ID validation — Discord IDs are 17-20 digits
const USER_ID_RE = /^\d{17,20}$/;

function isValidUserId(uid) {
  return typeof uid === "string" && USER_ID_RE.test(uid.trim());
}

function clamp(n, lo, hi) {
  const v = Number(n) || 0;
  return Math.max(lo, Math.min(hi, v));
}

function dbNameFromUri(uri, fallback = "casino") {
  try {
    const u = new URL(uri.replace(/^mongodb(\+srv)?:\/\//, "https://"));
    const n = u.pathname.replace(/^\//, "").split("?")[0];
    return n || fallback;
  } catch { return fallback; }
}

function unwrap(r) {
  if (!r) return null;
  return r.value !== undefined ? r.value : r;
}

export class Database {
  constructor(uri, dbNameOverride) {
    this._uri    = uri;
    this._dbName = (dbNameOverride?.trim()) ? dbNameOverride : dbNameFromUri(uri);
  }

  async connect() {
    this._client = new MongoClient(this._uri);
    await this._client.connect();
    this._db      = this._client.db(this._dbName);
    this._users   = this._db.collection("u");
    this._stats   = this._db.collection("stats");
    this._guilds  = this._db.collection("guilds");
    // Ensure indexes
    try {
      await this._users.createIndex({ "st.e": -1 }); // session expiry TTL
      await this._stats.createIndex({ _id: 1 });
    } catch (_) { /* index may already exist */ }
    console.log(`[DB] Connected → ${this._dbName}.u`);
  }

  // ─── Input validation helpers ──────────────────────────────────────────────

  _uid(uid) {
    if (!isValidUserId(uid)) throw new Error(`Invalid userId: ${JSON.stringify(uid)}`);
    return uid.trim();
  }

  // ─── User record helpers ───────────────────────────────────────────────────

  async getUser(userId) {
    const id = this._uid(userId);
    const r = await this._users.findOneAndUpdate(
      { _id: id },
      [
        { $set: {
          bal: { $ifNull: ["$bal", DEFAULTS.bal] },
          tw:  { $ifNull: ["$tw",  DEFAULTS.tw]  },
          tl:  { $ifNull: ["$tl",  DEFAULTS.tl]  },
          gp:  { $ifNull: ["$gp",  DEFAULTS.gp]  },
          ld:  { $ifNull: ["$ld",  DEFAULTS.ld]  },
        } },
      ],
      { upsert: true, returnDocument: "after" }
    );
    return unwrap(r) ?? { _id: id, ...DEFAULTS };
  }

  /**
   * Atomically deduct `delta` from userId's balance, but ONLY if their
   * current balance is >= |delta|. Returns the new document on success,
   * or null if the user couldn't afford it.
   *
   * For positive `delta` (credit): cap at MAX_BALANCE.
   * For negative `delta` (debit): requires existing bal >= |delta|.
   */
  async atomicDeduct(userId, delta) {
    const id    = this._uid(userId);
    const d     = clamp(delta, -MAX_DELTA, MAX_DELTA);
    const exact = d < 0 ? d : { $min: [d, MAX_BALANCE - "$bal"] };

    // For deductions, use a conditional update that only succeeds if bal >= |delta|
    if (d < 0) {
      const r = await this._users.findOneAndUpdate(
        { _id: id, bal: { $gte: Math.abs(d) } },
        [{ $set: { bal: { $max: [0, { $add: ["$bal", d] }] } } }],
        { returnDocument: "after" }
      );
      return unwrap(r);
    }

    // For credits, just apply the delta capped at MAX_BALANCE
    const r = await this._users.findOneAndUpdate(
      { _id: id },
      [{ $set: { bal: { $min: [{ $add: [{ $ifNull: ["$bal", 0] }, d] }, MAX_BALANCE] } } }],
      { upsert: true, returnDocument: "after" }
    );
    return unwrap(r);
  }

  /**
   * Convenience wrapper: atomically deduct, record the game result, and
   * optionally credit winnings in a single logical operation.
   * Returns { ok: true, newBal } on success, { ok: false } if insufficient funds.
   */
  async atomicGame(userId, bet, wonAmount = 0) {
    const id    = this._uid(userId);
    const b     = clamp(Math.abs(bet), 0, MAX_DELTA);
    const w     = clamp(Math.abs(wonAmount), 0, MAX_DELTA);
    // Net change: -(bet) + wonAmount
    const net   = w - b;
    const newBal = await this.atomicDeduct(id, net);
    if (newBal === null) return { ok: false };
    // After atomicDeduct the bal field is guaranteed to be valid
    await this.recordGame(id, net > 0, Math.max(b, w));
    return { ok: true, newBal: newBal.bal };
  }

  async updateBalance(userId, delta) {
    const id = this._uid(userId);
    const d  = clamp(delta, -MAX_DELTA, MAX_DELTA);
    const r  = await this._users.findOneAndUpdate(
      { _id: id },
      [{ $set: { bal: { $min: [{ $add: [{ $ifNull: ["$bal", 0] }, d] }, MAX_BALANCE] } } }],
      { upsert: true, returnDocument: "after" }
    );
    return unwrap(r) ?? { bal: d };
  }

  async setLastDaily(userId, ts) {
    await this._users.updateOne(
      { _id: this._uid(userId) },
      { $set: { ld: clamp(ts, 0, Date.now()) } },
      { upsert: true }
    );
  }

  async setLastWork(userId, ts) {
    await this._users.updateOne(
      { _id: this._uid(userId) },
      { $set: { lw: clamp(ts, 0, Date.now()) } },
      { upsert: true }
    );
  }

  async recordGame(userId, won, amount) {
    const id   = this._uid(userId);
    const amt  = clamp(amount, 0, MAX_FIELD_INC);
    const inc  = { gp: 1 };
    if (won) inc.tw = amt; else inc.tl = amt;
    await this._users.updateOne({ _id: id }, { $inc: inc } , { upsert: true });
  }

  /**
   * Atomic two-party transfer using a MongoDB transaction.
   * Only succeeds if sender has sufficient funds AND both documents
   * are updated atomically. Returns true on success, false on failure.
   */
  async transfer(fromId, toId, amount) {
    const fId = this._uid(fromId);
    const tId = this._uid(toId);
    if (fId === tId) return false;
    const amt = clamp(Math.abs(amount), 1, MAX_DELTA);

    const session = this._client.startSession();
    try {
      let success = false;
      await session.withTransaction(async () => {
        // Check sender balance within the transaction
        const sender = await this._users.findOne(
          { _id: fId },
          { session, projection: { bal: 1 } }
        );
        if ((sender?.bal ?? 0) < amt) {
          // Abort the transaction
          await session.abortTransaction();
          return;
        }
        // Debit sender and credit receiver in one atomic batch
        await this._users.bulkWrite([
          { updateOne: {
              filter: { _id: fId },
              update: { $inc: { bal: -amt } },
              upsert: false, // must exist — we already checked
          }},
          { updateOne: {
              filter: { _id: tId },
              update: { $inc: { bal:  amt } },
              upsert: true,
          }},
        ], { session });
        success = true;
      }, { readPreference: "primary", readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
      return success;
    } finally {
      await session.endSession();
    }
  }

  async getLeaderboard(field, limit) {
    return this._users
      .find({})
      .sort({ [field ?? "bal"]: -1 })
      .limit(clamp(limit, 1, 100))
      .toArray();
  }

  // ─── Admin stats ───────────────────────────────────────────────────────────

  /** Increment a command counter. Called by CommandHandler on every invocation. */
  async recordCommand(cmdName) {
    if (!this._stats) return;
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    await this._stats.bulkWrite([
      // All-time total per command
      { updateOne: { filter: { _id: `cmd:${cmdName}` }, update: { $inc: { count: 1 } }, upsert: true } },
      // Daily bucket
      { updateOne: { filter: { _id: `daily:${today}` }, update: { $inc: { [`cmds.${cmdName}`]: 1, total: 1 } }, upsert: true } },
    ]);
  }

  /** Upsert a guild record whenever the bot receives a message from that guild. */
  async upsertGuild(guildId, data) {
    if (!this._guilds) return;
    await this._guilds.updateOne(
      { _id: guildId },
      { $set: { ...data, lastSeen: Date.now() }, $setOnInsert: { joinedAt: Date.now() } },
      { upsert: true }
    );
  }

  /** Pull all-time command counts. */
  async getCommandStats() {
    if (!this._stats) return [];
    return this._stats.find({ _id: /^cmd:/ }).sort({ count: -1 }).toArray();
  }

  /** Pull last N daily buckets. */
  async getDailyStats(days = 14) {
    if (!this._stats) return [];
    return this._stats.find({ _id: /^daily:/ }).sort({ _id: -1 }).limit(days).toArray();
  }

  /** Pull all known guilds. */
  async getGuilds() {
    if (!this._guilds) return [];
    return this._guilds.find({}).sort({ lastSeen: -1 }).toArray();
  }

  /** Pull top N users by balance. */
  async getAdminUserStats(limit = 20) {
    return this._users
      .find({})
      .sort({ bal: -1 })
      .limit(limit)
      .project({ _id: 1, bal: 1, tw: 1, tl: 1, gp: 1 })
      .toArray();
  }

  /** Aggregate totals across all users. */
  async getGlobalTotals() {
    const r = await this._users.aggregate([
      { $group: {
          _id: null,
          totalUsers:    { $sum: 1 },
          totalBalance:  { $sum: "$bal" },
          totalWon:      { $sum: "$tw" },
          totalLost:     { $sum: "$tl" },
          totalGames:    { $sum: "$gp" },
      } }
    ]).toArray();
    return r[0] ?? { totalUsers: 0, totalBalance: 0, totalWon: 0, totalLost: 0, totalGames: 0 };
  }

  // ─── Sessions ──────────────────────────────────────────────────────────────

  /**
   * Validates a session token for the given userId.
   * Also returns the expiry timestamp so the caller can use it as needed.
   * Returns null if invalid, or an object { uid, token, exp, ip } if valid.
   */
  async validateSession(userId, token) {
    if (!token || typeof token !== "string") return null;
    const id = this._uid(userId);
    const u  = await this._users.findOne(
      { _id: id, [`st.${token}`]: { $exists: true } },
      { projection: { [`st.${token}`]: 1 } }
    );
    const exp = u?.st?.[token];
    if (!exp || Date.now() > exp) return null;
    return { uid: id, token, exp };
  }

  async createSession(userId, token, ttlMs, ipAddress = null) {
    const id     = this._uid(userId);
    const expiry = Date.now() + clamp(ttlMs ?? 7_200_000, 60_000, 604_800_000);
    const fields = { [`st.${token}`]: expiry };
    if (ipAddress) fields["sessionMeta.lastIp"] = ipAddress;
    const r = await this._users.findOne({ _id: id });
    if (!r) {
      await this._users.updateOne(
        { _id: id },
        { $setOnInsert: { _id: id, ...DEFAULTS }, $set: fields },
        { upsert: true }
      );
    } else {
      await this._users.updateOne({ _id: id }, { $set: fields });
    }
  }

  /**
   * Rotate session: revoke old token and issue a new one.
   * Used on privilege escalation (e.g. admin login).
   */
  async rotateSession(userId, oldToken, newToken, ttlMs, ipAddress = null) {
    const id     = this._uid(userId);
    const expiry = Date.now() + clamp(ttlMs ?? 7_200_000, 60_000, 604_800_000);
    const fields = {
      [`st.${oldToken}`]: "",
      [`st.${newToken}`]: expiry,
    };
    if (ipAddress) fields["sessionMeta.lastIp"] = ipAddress;
    await this._users.updateOne({ _id: id }, {
      $unset: { [`st.${oldToken}`]: "" },
      $set: fields,
    });
  }

  async revokeSession(userId, token) {
    if (!token || typeof token !== "string") return;
    const id = this._uid(userId);
    await this._users.updateOne({ _id: id }, { $unset: { [`st.${token}`]: "" } });
  }

  /** Revoke ALL sessions for a user (e.g. on logout-all or admin ban). */
  async revokeAllSessions(userId) {
    const id = this._uid(userId);
    const u  = await this._users.findOne({ _id: id }, { projection: { st: 1 } });
    if (!u?.st) return;
    const unset = {};
    for (const tok of Object.keys(u.st)) unset[`st.${tok}`] = "";
    await this._users.updateOne({ _id: id }, { $unset: unset });
  }

  async pruneExpiredSessions() {
    const now   = Date.now();
    const users = await this._users.find({ st: { $exists: true } }).toArray();
    for (const u of users) {
      if (!u.st) continue;
      const unset = {};
      for (const [tok, exp] of Object.entries(u.st))
        if (exp < now) unset[`st.${tok}`] = "";
      if (Object.keys(unset).length)
        await this._users.updateOne({ _id: u._id }, { $unset: unset });
    }
  }
}
