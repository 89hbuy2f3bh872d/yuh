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
    console.log(`[DB] Connected → ${this._dbName}.u`);
  }

  async getUser(userId) {
    const r = await this._users.findOneAndUpdate(
      { _id: userId },
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
    return unwrap(r) ?? { _id: userId, ...DEFAULTS };
  }

  async updateBalance(userId, delta) {
    const r = await this._users.findOneAndUpdate(
      { _id: userId },
      { $inc: { bal: delta } },
      { upsert: true, returnDocument: "after" }
    );
    return unwrap(r) ?? { bal: delta };
  }

  async setLastDaily(userId, ts) {
    await this._users.updateOne({ _id: userId }, { $set: { ld: ts } }, { upsert: true });
  }

  async recordGame(userId, won, amount) {
    await this._users.updateOne(
      { _id: userId },
      { $inc: { gp: 1, tw: won ? amount : 0, tl: won ? 0 : amount } },
      { upsert: true }
    );
  }

  async transfer(fromId, toId, amount) {
    const from = await this.getUser(fromId);
    if ((from.bal ?? 0) < amount) return false;
    await this._users.bulkWrite([
      { updateOne: { filter: { _id: fromId }, update: { $inc: { bal: -amount } }, upsert: true } },
      { updateOne: { filter: { _id: toId },   update: { $inc: { bal:  amount } }, upsert: true } },
    ]);
    return true;
  }

  async getLeaderboard(field, limit) {
    return this._users.find({}).sort({ [field ?? "bal"]: -1 }).limit(limit ?? 10).toArray();
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

  async createSession(userId, token, ttlMs) {
    const expiry = Date.now() + (ttlMs ?? 7_200_000);
    const r = await this._users.findOne({ _id: userId });
    if (!r) {
      await this._users.updateOne(
        { _id: userId },
        { $setOnInsert: { _id: userId, ...DEFAULTS }, $set: { [`st.${token}`]: expiry } },
        { upsert: true }
      );
    } else {
      await this._users.updateOne(
        { _id: userId },
        { $set: { [`st.${token}`]: expiry } }
      );
    }
  }

  async validateSession(userId, token) {
    const u = await this._users.findOne({ _id: userId });
    const exp = u?.st?.[token];
    return !!(exp && Date.now() <= exp);
  }

  async revokeSession(userId, token) {
    await this._users.updateOne({ _id: userId }, { $unset: { [`st.${token}`]: "" } });
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
