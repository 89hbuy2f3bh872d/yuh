import { MongoClient } from "mongodb";

/**
 * Compact field names to minimise Atlas free-tier storage (512 MB):
 *   _id  = userId (string, replaces separate userId field)
 *   bal  = balance
 *   tw   = totalWon
 *   tl   = totalLost
 *   gp   = gamesPlayed
 *   ld   = lastDaily (Unix ms)
 *   st   = sessionTokens Map { token -> expiry }
 */

function dbNameFromUri(uri, fallback) {
  fallback = fallback || "casino";
  try {
    const stripped = uri.replace(/^mongodb(\+srv)?:\/\//, "https://");
    const u = new URL(stripped);
    const name = u.pathname.replace(/^\//, "").split("?")[0];
    return name || fallback;
  } catch (_) { return fallback; }
}

export class Database {
  constructor(uri, dbNameOverride) {
    this._uri = uri;
    this._dbName = (dbNameOverride && dbNameOverride.trim()) ? dbNameOverride : dbNameFromUri(uri);
  }

  async connect() {
    this._client = new MongoClient(this._uri);
    await this._client.connect();
    this._db = this._client.db(this._dbName);
    this._users = this._db.collection("u"); // short collection name
    console.log(`[DB] Connected → ${this._dbName}.u`);
  }

  // Upsert-on-first-touch; returns compact doc
  async getUser(userId) {
    const r = await this._users.findOneAndUpdate(
      { _id: userId },
      { $setOnInsert: { _id: userId, bal: 1000, tw: 0, tl: 0, gp: 0, ld: 0 } },
      { upsert: true, returnDocument: "after" }
    );
    return r.value ?? r;
  }

  async updateBalance(userId, delta) {
    const r = await this._users.findOneAndUpdate(
      { _id: userId },
      { $inc: { bal: delta } },
      { upsert: true, returnDocument: "after" }
    );
    return r.value ?? r;
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

  // Web session tokens — stored in the user doc as a small object to avoid a separate collection
  async createSession(userId, token, ttlMs) {
    const expiry = Date.now() + (ttlMs ?? 10 * 60 * 1000);
    await this._users.updateOne(
      { _id: userId },
      { $set: { [`st.${token}`]: expiry } },
      { upsert: true }
    );
  }

  async validateSession(userId, token) {
    const u = await this._users.findOne({ _id: userId });
    const expiry = u?.st?.[token];
    if (!expiry || Date.now() > expiry) return false;
    return true;
  }

  async revokeSession(userId, token) {
    await this._users.updateOne({ _id: userId }, { $unset: { [`st.${token}`]: "" } });
  }

  // Prune expired sessions (call periodically)
  async pruneExpiredSessions() {
    const now = Date.now();
    const users = await this._users.find({ st: { $exists: true } }).toArray();
    for (const u of users) {
      if (!u.st) continue;
      const unset = {};
      for (const [tok, exp] of Object.entries(u.st)) {
        if (exp < now) unset[`st.${tok}`] = "";
      }
      if (Object.keys(unset).length)
        await this._users.updateOne({ _id: u._id }, { $unset: unset });
    }
  }
}
