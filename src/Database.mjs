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

// Per-server tax on winnings, in basis points (1500 = 15%). Capped at 50%.
const DEFAULT_TAX_BPS = 1500;
const MAX_TAX_BPS = 5000;
function clampTaxBps(bps) {
  const v = Math.round(Number(bps));
  if (!Number.isFinite(v)) return DEFAULT_TAX_BPS;
  return Math.max(0, Math.min(MAX_TAX_BPS, v));
}

// Investing — seed assets. FC-T = the FluxCoin index whose value tracks total FC in
// circulation (like USD-T tracking dollar reserves); the rest are NFTs that start cheap
// and rise with demand. `baseline` = mean-reversion target, `vol` = volatility.
const INVEST_SEED = [
  { _id: "fct",       kind: "fct", name: "FC-T",          emoji: "🪙", color: "#f1c40f", price: 1.00, baseline: 1.00, vol: 0.004 },
  { _id: "pixelpeng", kind: "nft", name: "Pixel Penguin",  emoji: "🐧", color: "#3b9dff", price: 5,   baseline: 9,   vol: 0.060 },
  { _id: "goldape",   kind: "nft", name: "Gold Ape",       emoji: "🦍", color: "#f5a623", price: 8,   baseline: 16,  vol: 0.070 },
  { _id: "cryptcat",  kind: "nft", name: "Crypt Cat",      emoji: "🐱", color: "#9b59b6", price: 3,   baseline: 7,   vol: 0.080 },
  { _id: "doomskull", kind: "nft", name: "Doom Skull",     emoji: "💀", color: "#e74c3c", price: 6,   baseline: 12,  vol: 0.090 },
  { _id: "aquagem",   kind: "nft", name: "Aqua Gem",       emoji: "💠", color: "#1abc9c", price: 4,   baseline: 10,  vol: 0.075 },
];

// User ID validation — Discord IDs are 17-20 digits
const USER_ID_RE = /^\d{17,20}$/;

function isValidUserId(uid) {
  return typeof uid === "string" && USER_ID_RE.test(uid.trim());
}

// Session tokens are hex (crypto.randomBytes(...).toString("hex")). Reject anything else
// so a cookie value can't inject Mongo dot-path / operator segments.
const SESSION_TOKEN_RE = /^[a-f0-9]{24,128}$/i;
function isSessionToken(t) { return typeof t === "string" && SESSION_TOKEN_RE.test(t); }

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
    this._bridge = null; // optional StdbBridge — when set, balances live in SpacetimeDB
  }

  /** Route balance reads/writes through SpacetimeDB (via the web service bridge). */
  attachBalanceBridge(bridge) { this._bridge = bridge; }

  async connect() {
    this._client = new MongoClient(this._uri);
    await this._client.connect();
    this._db      = this._client.db(this._dbName);
    this._users   = this._db.collection("u");
    this._stats   = this._db.collection("stats");
    this._guilds  = this._db.collection("guilds");
    this._tokens  = this._db.collection("logintokens");
    this._srvStats = this._db.collection("serverstats");
    this._rakeback = this._db.collection("rakeback");  // per-user-per-server rakeback ledger
    this._assets   = this._db.collection("assets");    // investing: tradeable assets + price history
    this._holdings = this._db.collection("holdings");  // investing: per-user positions
    // Ensure indexes
    try {
      await this._users.createIndex({ "st.e": -1 }); // session expiry TTL
      await this._stats.createIndex({ _id: 1 });
      await this._tokens.createIndex({ expAt: 1 }, { expireAfterSeconds: 0 }); // auto-expire login links
    } catch (_) { /* index may already exist */ }
    await this.seedAssets().catch(() => {});
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
    const doc = unwrap(r) ?? { _id: id, ...DEFAULTS };
    if (this._bridge) { try { doc.bal = await this._bridge.balance(id); } catch { /* keep mongo bal as fallback */ } }
    return doc;
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
    if (this._bridge) {
      const res = d < 0 ? await this._bridge.deduct(id, Math.abs(d)) : await this._bridge.credit(id, d);
      return res.ok ? { _id: id, bal: Number(res.bal || 0) } : null; // null = couldn't afford
    }
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
    if (this._bridge) {
      const res = await this._bridge.settle(id, b, w); // atomic in STDB: take bet, pay win
      if (!res.ok) return { ok: false };
      await this.recordGame(id, w > b, Math.max(b, w));
      return { ok: true, newBal: Number(res.bal || 0) };
    }
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
    if (this._bridge) {
      const res = d >= 0 ? await this._bridge.credit(id, d) : await this._bridge.deduct(id, Math.abs(d));
      return { _id: id, bal: Number(res.bal || 0) };
    }
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

  // ─── Fluxer identity cache (for the misc send-money picker) ──────────────────

  /**
   * Cache a user's Fluxer display name + avatar URL on their doc.
   * Called on every OAuth login so the misc picker can show real names
   * without per-user Fluxer API calls. Fields: tag (username), av (avatar URL).
   */
  async setProfile(userId, { tag, avatar } = {}) {
    const id = this._uid(userId);
    const set = {};
    if (typeof tag === "string" && tag.length) set.tag = tag.slice(0, 64);
    if (typeof avatar === "string") set.av = avatar.slice(0, 256);
    if (!Object.keys(set).length) return;
    await this._users.updateOne({ _id: id }, { $set: set }, { upsert: true });
  }

  /**
   * Search users for the transfer picker. Matches on _id prefix OR cached
   * tag (case-insensitive). Excludes excludeId. Returns lightweight docs —
   * NEVER leak other users' balances to a requester (bal omitted by caller).
   */
  async searchUsers(q, limit = 25, excludeId = null) {
    const lim = clamp(limit, 1, 50);
    const term = String(q ?? "").trim();
    let filter;
    if (!term) {
      filter = {};
    } else {
      // Escape regex metacharacters in the user-supplied term
      const safe = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const rx = { $regex: safe, $options: "i" };
      filter = { $or: [{ _id: rx }, { tag: rx }] };
    }
    if (excludeId) filter = { $and: [filter, { _id: { $ne: String(excludeId) } }] };
    return this._users
      .find(filter)
      .project({ _id: 1, tag: 1, av: 1 })
      .limit(lim)
      .toArray();
  }

  // ─── Admin permissions ──────────────────────────────────────────────────────

  /**
   * Admin-only user search for the User List tab. Returns full admin-relevant
   * fields (balance, perms). Use ONLY behind an admin gate.
   */
  async searchUsersAdmin(q, limit = 30) {
    const lim = clamp(limit, 1, 100);
    const term = String(q ?? "").trim();
    let filter;
    if (!term) {
      filter = {};
    } else {
      const safe = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const rx = { $regex: safe, $options: "i" };
      filter = { $or: [{ _id: rx }, { tag: rx }] };
    }
    return this._users
      .find(filter)
      .project({ _id: 1, tag: 1, av: 1, bal: 1, perms: 1 })
      .sort({ bal: -1 })
      .limit(lim)
      .toArray();
  }

  /** Get a user's admin permission array (empty if none). */
  async getPerms(userId) {
    const id = this._uid(userId);
    const u = await this._users.findOne({ _id: id }, { projection: { perms: 1 } });
    return Array.isArray(u?.perms) ? u.perms : [];
  }

  /** Overwrite a user's permission array (validated, deduped by caller). */
  async setPerms(userId, perms) {
    const id = this._uid(userId);
    const arr = Array.isArray(perms) ? [...new Set(perms.map(String))] : [];
    if (arr.length) await this._users.updateOne({ _id: id }, { $set: { perms: arr } }, { upsert: true });
    else await this._users.updateOne({ _id: id }, { $unset: { perms: "" } });
    return arr;
  }

  /** List all users that currently hold at least one admin permission. */
  async listAdmins() {
    return this._users
      .find({ perms: { $exists: true, $ne: [] } })
      .project({ _id: 1, tag: 1, av: 1, bal: 1, perms: 1 })
      .limit(200)
      .toArray();
  }

  /**
   * Atomic two-party transfer using a MongoDB transaction.
   * Only succeeds if sender has sufficient funds AND both documents
   * are updated atomically. Returns true on success, false on failure.
   */
  async transfer(fromId, toId, amount, fromTag) {
    const fId = this._uid(fromId);
    const tId = this._uid(toId);
    if (fId === tId) return false;
    const amt = clamp(Math.abs(amount), 1, MAX_DELTA);

    if (this._bridge) {
      const res = await this._bridge.transfer(fId, tId, amt, fromTag || fId); // atomic + notifies in STDB
      return !!res.ok;
    }

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
      if (success) {
        await this.addNotification(tId, { type: "pay", amount: amt, fromTag: fromTag || fId, msg: `received ${amt.toLocaleString()} FC` }).catch(() => {});
      }
      return success;
    } finally {
      await session.endSession();
    }
  }

  // ─── Notifications (per-user inbox; capped at 50 newest) ──────────────────────
  async addNotification(userId, notif = {}) {
    const id = this._uid(userId);
    const n = {
      t: String(notif.type || "info").slice(0, 16),
      m: String(notif.msg || "").slice(0, 200),
      a: Number(notif.amount) || 0,
      f: String(notif.fromTag || "").slice(0, 64),
      ts: Date.now(),
    };
    await this._users.updateOne(
      { _id: id },
      { $push: { nt: { $each: [n], $slice: -50 } }, $inc: { nu: 1 } },
      { upsert: true }
    ).catch(() => {});
    return n;
  }
  async getNotifications(userId) {
    const u = await this._users.findOne({ _id: this._uid(userId) }, { projection: { nt: 1, nu: 1 } });
    return { items: (u?.nt || []).slice().reverse(), unread: Math.max(0, Number(u?.nu || 0)) };
  }
  async markNotificationsRead(userId) {
    await this._users.updateOne({ _id: this._uid(userId) }, { $set: { nu: 0 } }).catch(() => {});
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
  async getGuildsByIds(ids) {
    if (!this._guilds || !Array.isArray(ids) || !ids.length) return [];
    return this._guilds.find({ _id: { $in: ids.map(String) } }).toArray();
  }
  async getGuild(id) { if (!this._guilds) return null; return this._guilds.findOne({ _id: String(id) }); }
  /** Push a guild name/icon change to the web service for realtime broadcast. */
  async notifyGuild(gid, data) { try { await this._bridge?.guildUpdate?.(String(gid), data); } catch { /* best-effort */ } }

  /** Associate a user with a guild (so the web server-selector lists it). Returns
   *  true if it was newly added. Lets the selector pick up servers a user joined
   *  after they last logged in, without needing a fresh OAuth. */
  async addUserGuild(uid, guildId) {
    if (!this._users || !isValidUserId(uid) || !guildId) return false;
    const r = await this._users.updateOne({ _id: uid.trim() }, { $addToSet: { gids: String(guildId) } }).catch(() => null);
    return !!(r && r.modifiedCount);
  }
  /** Tell the web service to push a "servers changed" event to this user's tabs. */
  async notifyUserGuilds(uid) { try { await this._bridge?.userGuildsChanged?.(String(uid)); } catch { /* best-effort */ } }

  /** All user IDs registered to a guild (it's in their `gids`). For bank-wide payouts. */
  async getGuildUserIds(guildId) {
    if (!this._users || !guildId) return [];
    const rows = await this._users.find({ gids: String(guildId) }, { projection: { _id: 1 } }).toArray().catch(() => []);
    return rows.map(r => String(r._id)).filter(isValidUserId);
  }
  /** Per-owner daily bank-withdraw ledger, stored on the user doc as `bwd = { d, t }`
   *  (UTC day string + total withdrawn that day). Caps cash-out from server banks. */
  async bankWithdrawnToday(uid, day) {
    if (!this._users || !isValidUserId(uid)) return 0;
    const u = await this._users.findOne({ _id: uid.trim() }, { projection: { bwd: 1 } }).catch(() => null);
    return (u?.bwd && u.bwd.d === day) ? (Number(u.bwd.t) || 0) : 0;
  }
  /** Atomically attempt a bank-withdraw ledger increment, respecting the daily cap.
   *  Returns true if it fit under the cap (and was recorded), false if it would exceed.
   *  Race-free: the conditional filter `bwd.t + amount <= cap` is evaluated atomically by
   *  Mongo, so two concurrent withdraws can't both pass the cap check. */
  async tryRecordBankWithdraw(uid, day, amount, cap) {
    if (!this._users || !isValidUserId(uid)) return false;
    const amt = Math.floor(Number(amount) || 0); if (!(amt > 0)) return false;
    // Case A: same day, current total + amt must be ≤ cap → $inc t.
    const a = await this._users.updateOne(
      { _id: uid.trim(), "bwd.d": day, $expr: { $lte: [{ $add: [{ $ifNull: ["$bwd.t", 0] }, amt] }, cap] } },
      { $inc: { "bwd.t": amt } }
    ).catch(() => null);
    if (a && a.modifiedCount > 0) return true;
    // Case B: no ledger yet today (or stale day) → set fresh {d, t: amt} if amt ≤ cap.
    if (amt <= cap) {
      const b = await this._users.updateOne(
        { _id: uid.trim(), $or: [{ bwd: { $exists: false } }, { "bwd.d": { $ne: day } }] },
        { $set: { bwd: { d: day, t: amt } } }
      ).catch(() => null);
      return !!(b && b.modifiedCount > 0);
    }
    return false;
  }

  // ─── Pending slot win (persisted so an uncollected win survives a web restart) ──
  async setPendingSlot(uid, p) {
    if (!this._users || !isValidUserId(uid)) return;
    await this._users.updateOne({ _id: uid.trim() }, { $set: { psl: p } }, { upsert: true }).catch(() => {});
  }
  async clearPendingSlot(uid) {
    if (!this._users || !isValidUserId(uid)) return;
    await this._users.updateOne({ _id: uid.trim() }, { $unset: { psl: "" } }).catch(() => {});
  }
  async loadPendingSlots() {
    if (!this._users) return [];
    const rows = await this._users.find({ psl: { $exists: true } }, { projection: { psl: 1 } }).toArray().catch(() => []);
    return rows.map(r => ({ uid: String(r._id), ...(r.psl || {}) }));
  }

  // ─── Server role shop (buy Discord roles with FC; 75% → server bank) ────────
  async getRoleShop(id) {
    if (!this._guilds) return [];
    const g = await this._guilds.findOne({ _id: String(id) }, { projection: { roleShop: 1 } }).catch(() => null);
    return Array.isArray(g?.roleShop) ? g.roleShop : [];
  }
  async setRoleShop(id, arr) {
    if (!this._guilds) return;
    const clean = (Array.isArray(arr) ? arr : []).slice(0, 25).map(r => ({ roleId: String(r.roleId), name: String(r.name || "Role").slice(0, 80), price: Math.floor(Number(r.price) || 0) }));
    await this._guilds.updateOne({ _id: String(id) }, { $set: { roleShop: clean } }, { upsert: true });
  }
  /** Charge a role purchase: deduct full price from the buyer, 75% → server bank (25% sink). */
  async rolePurchase(uid, gid, price) {
    if (this._bridge?.rolePurchase) return this._bridge.rolePurchase(uid, gid, price);
    return { ok: false, error: "no bridge" };
  }

  // ─── Investing (assets + per-user holdings) ─────────────────────────────────
  async seedAssets() {
    if (!this._assets) return;
    // One-time migration: rename the legacy "flx" (FluxCoin Index) to "fct" (FC-T), which
    // now tracks total FC in circulation. Preserve price/history if the doc exists.
    const legacy = await this._assets.findOne({ _id: "flx" }).catch(() => null);
    if (legacy && !await this._assets.findOne({ _id: "fct" }, { projection: { _id: 1 } }).catch(() => null)) {
      const fct = INVEST_SEED.find(a => a._id === "fct");
      await this._assets.insertOne({ ...legacy, ...fct, _id: "fct", kind: "fct", name: "FC-T", baseline: fct.baseline, vol: fct.vol }).catch(() => {});
      await this._assets.deleteOne({ _id: "flx" }).catch(() => {});
      // Re-key any holdings from flx → fct so existing positions carry over.
      await this._holdings.updateMany({ "h.flx": { $exists: true } }, { $rename: { "h.flx": "h.fct" } }).catch(() => {});
    }
    for (const a of INVEST_SEED) {
      const ex = await this._assets.findOne({ _id: a._id }, { projection: { _id: 1 } }).catch(() => null);
      if (!ex) await this._assets.insertOne({ ...a, bias: 0, supply: 0, prevPrice: a.price, hist: [[Date.now(), a.price]], updatedAt: Date.now() }).catch(() => {});
    }
  }
  async getAssets() { if (!this._assets) return []; return this._assets.find({}).sort({ kind: 1, _id: 1 }).toArray().catch(() => []); }
  async getAsset(id) { if (!this._assets) return null; return this._assets.findOne({ _id: String(id) }).catch(() => null); }
  /** Persist live asset state from the price engine (bulk upsert). */
  async saveAssets(list) {
    if (!this._assets || !Array.isArray(list) || !list.length) return;
    const ops = list.map(a => ({ updateOne: { filter: { _id: a._id }, update: { $set: a }, upsert: true } }));
    await this._assets.bulkWrite(ops, { ordered: false }).catch(() => {});
  }
  async getHoldings(uid) { if (!this._holdings) return {}; const d = await this._holdings.findOne({ _id: String(uid) }).catch(() => null); return (d && d.h) || {}; }
  async setHoldings(uid, h) { if (!this._holdings) return; await this._holdings.updateOne({ _id: String(uid) }, { $set: { h } }, { upsert: true }).catch(() => {}); }
  // Atomically ADD units + cost to a holding (buy). Race-free via $inc.
  async addHolding(uid, assetId, units, cost) {
    if (!this._holdings) return;
    const u = Number(units) || 0, c = Math.round(Number(cost) || 0);
    await this._holdings.updateOne({ _id: String(uid) }, { $inc: { [`h.${assetId}.u`]: u, [`h.${assetId}.c`]: c } }, { upsert: true }).catch(() => {});
  }
  // Atomically DEDUCT units guarded by having enough. Returns realized cost or null on
  // insufficient funds / lost race. The conditional filter prevents double-selling: two
  // concurrent sells can't both pass the `u >= sellU` guard.
  async removeHolding(uid, assetId, units) {
    if (!this._holdings) return null;
    const sellU = Number(units); if (!(sellU > 0)) return null;
    const doc = await this._holdings.findOne({ _id: String(uid) }).catch(() => null);
    const cur = doc?.h?.[assetId];
    if (!cur || !(cur.u >= sellU)) return null;
    const costPortion = Math.round((cur.c || 0) * (sellU / cur.u));
    const res = await this._holdings.updateOne(
      { _id: String(uid), [`h.${assetId}.u`]: { $gte: sellU } },
      { $inc: { [`h.${assetId}.u`]: -sellU, [`h.${assetId}.c`]: -costPortion } }
    ).catch(() => null);
    if (!res || res.modifiedCount === 0) return null;
    if (cur.u - sellU <= 1e-6) await this._holdings.updateOne({ _id: String(uid) }, { $unset: { [`h.${assetId}`]: "" } }).catch(() => {});
    return { soldUnits: sellU, costPortion };
  }
  /** Assets + the user's portfolio (bot path → web engine). */
  async investMe(uid) {
    if (this._bridge?.investMe) return this._bridge.investMe(uid);
    return { assets: [], portfolio: { positions: [], value: 0, cost: 0, pnl: 0 }, bal: 0 };
  }
  /** Buy/sell through the web price engine + STDB (bot path). */
  async investTrade(side, uid, assetId, amount) {
    if (this._bridge?.investTrade) return this._bridge.investTrade(side, uid, assetId, amount);
    return { ok: false, error: "no bridge" };
  }

  /** Set (or clear, when empty) a server's join invite. Caller must validate the URL. */
  async setGuildInvite(id, invite) {
    if (!this._guilds) return;
    if (invite) await this._guilds.updateOne({ _id: String(id) }, { $set: { invite: String(invite).slice(0, 256) } }, { upsert: true });
    else await this._guilds.updateOne({ _id: String(id) }, { $unset: { invite: "" } });
  }

  /** Per-server tax on winnings, in basis points (default 1500 = 15%). */
  async getGuildTax(id) {
    if (!this._guilds) return DEFAULT_TAX_BPS;
    const g = await this._guilds.findOne({ _id: String(id) }, { projection: { taxBps: 1 } });
    const bps = g?.taxBps;
    return Number.isFinite(bps) ? clampTaxBps(bps) : DEFAULT_TAX_BPS;
  }
  /** Set a server's winnings tax (basis points, clamped 0..MAX_TAX_BPS). */
  async setGuildTax(id, bps) {
    if (!this._guilds) return DEFAULT_TAX_BPS;
    const v = clampTaxBps(bps);
    await this._guilds.updateOne({ _id: String(id) }, { $set: { taxBps: v, lastSeen: Date.now() } }, { upsert: true });
    return v;
  }

  // ─── Per-server economy stats (owner dashboard) ─────────────────────────────
  // One doc per guild: gp=games, wagered, payout (paid to players), taxed (cut
  // into the server bank, cumulative), big=biggest single payout, players=unique.
  /** Count a wager placed on a server (one game). */
  async recordServerWager(gid, amount, uid) {
    if (!this._srvStats || !gid) return;
    const amt = Math.max(0, Math.floor(Number(amount) || 0));
    const upd = { $inc: { gp: 1, wagered: amt }, $set: { lastPlay: Date.now() } };
    if (isValidUserId(uid)) upd.$addToSet = { players: uid }; // unique player set
    await this._srvStats.updateOne({ _id: String(gid) }, upd, { upsert: true }).catch(() => {});
  }
  /** Record a payout (and the tax it fed into the server bank). */
  async recordServerPayout(gid, payout, tax) {
    if (!this._srvStats || !gid) return;
    const pay = Math.max(0, Math.floor(Number(payout) || 0));
    const tx = Math.max(0, Math.floor(Number(tax) || 0));
    await this._srvStats.updateOne(
      { _id: String(gid) },
      { $inc: { payout: pay, taxed: tx }, $max: { big: pay } },
      { upsert: true }
    ).catch(() => {});
  }
  async getServerStats(gid) {
    if (!this._srvStats || !gid) return null;
    return this._srvStats.findOne({ _id: String(gid) }).catch(() => null);
  }
  async getServerStatsMany(gids) {
    if (!this._srvStats || !Array.isArray(gids) || !gids.length) return [];
    return this._srvStats.find({ _id: { $in: gids.map(String) } }).toArray().catch(() => []);
  }
  /** Top servers by a stat field (global leaderboard). */
  async getTopServerStats(sortKey, limit = 50) {
    if (!this._srvStats) return [];
    const field = { wagered: "wagered", taxed: "taxed", games: "gp", payout: "payout" }[sortKey] || "wagered";
    return this._srvStats.find({}).sort({ [field]: -1 }).limit(Math.min(200, Math.max(1, limit | 0))).toArray().catch(() => []);
  }

  // ─── Rakeback (Stake-style cashback on the theoretical house edge) ─────────
  // Per-user-per-server ledger keyed by uid+"@"+gid. Accrual = wager × (taxBps/10000) × pct.
  // Accrual halts during a tax holiday (taxBps=0 → house earns nothing to rebate).
  /** Accrue rakeback for a wager. Fire-and-forget from every play site. */
  async addRakeback(uid, gid, wager, taxBps, pct) {
    if (!this._rakeback || !gid || !isValidUserId(uid)) return;
    const w = Math.max(0, Math.floor(Number(wager) || 0));
    const tb = Math.max(0, Number(taxBps) || 0);
    const p = Math.max(0, Math.min(20, Number(pct) || 0));
    if (!(w > 0) || !(tb > 0) || !(p > 0)) return;            // 0 tax (holiday) or 0% → no accrual
    const earn = Math.floor(w * tb / 10000 * p / 100);         // FC pending
    if (!(earn > 0)) return;
    await this._rakeback.updateOne(
      { _id: uid + "@" + gid },
      { $inc: { accrued: earn, wagered: w }, $set: { uid, gid, updatedAt: Date.now() } },
      { upsert: true }
    ).catch(() => {});
  }
  /** Read a player's rakeback state for a server. */
  async getRakeback(uid, gid) {
    if (!this._rakeback || !gid || !isValidUserId(uid)) return { accrued: 0, wagered: 0, claimed: 0 };
    const r = await this._rakeback.findOne({ _id: uid + "@" + gid }).catch(() => null);
    return { accrued: r?.accrued || 0, wagered: r?.wagered || 0, claimed: r?.claimed || 0 };
  }
  /** Atomically claim (read + zero) the pending rakeback. Returns the FC amount claimed.
   *  Uses findOneAndUpdate with a pipeline so the read-and-zero is a single atomic op —
   *  two concurrent claims can't both read the same accrued balance. */
  async claimRakeback(uid, gid) {
    if (!this._rakeback || !gid || !isValidUserId(uid)) return 0;
    // Pipeline: snapshot the current accrued into `claimAmt`, zero it, add to `claimed`.
    // findOneAndUpdate with a pipeline is atomic — no TOCTOU window.
    const r = await this._rakeback.findOneAndUpdate(
      { _id: uid + "@" + gid },
      [
        { $set: { claimAmt: { $ifNull: ["$accrued", 0] } } },
        { $set: { accrued: 0, claimed: { $add: [{ $ifNull: ["$claimed", 0] }, "$claimAmt"] }, updatedAt: Date.now() } },
      ],
      { upsert: true, returnDocument: "after" }
    ).catch(() => null);
    return Math.max(0, Math.floor(r?.claimAmt || 0));
  }
  /** Owner config: set a guild's rakeback percentage (0–20). */
  async setGuildRakebackPct(gid, pct) {
    if (!this._guilds || !gid) return;
    const p = Math.max(0, Math.min(20, Math.floor(Number(pct) || 0)));
    await this._guilds.updateOne({ _id: String(gid) }, { $set: { rakebackPct: p } }, { upsert: true }).catch(() => {});
  }
  /** Read a guild's configured rakeback percentage (default 5). */
  async getGuildRakebackPct(gid) {
    if (!this._guilds || !gid) return 5;
    const g = await this._guilds.findOne({ _id: String(gid) }, { projection: { rakebackPct: 1 } }).catch(() => null);
    const p = Number(g?.rakebackPct);
    return Number.isFinite(p) ? Math.max(0, Math.min(20, p)) : 5;
  }

  // ─── Per-server shop / economy (owner perks bought with the server bank) ─────
  /** Read a guild's economy bits: tax + shop perk state + verified flag. */
  async getGuildEconomy(id) {
    if (!this._guilds) return { taxBps: DEFAULT_TAX_BPS, shop: {}, verified: false };
    const g = await this._guilds.findOne({ _id: String(id) }, { projection: { taxBps: 1, shop: 1, verified: 1 } }).catch(() => null);
    return { taxBps: Number.isFinite(g?.taxBps) ? clampTaxBps(g.taxBps) : DEFAULT_TAX_BPS, shop: g?.shop || {}, verified: !!g?.verified };
  }

  /** Admin: mark a server verified (blue badge) or remove it. */
  async setGuildVerified(id, on) {
    if (!this._guilds) return;
    await this._guilds.updateOne({ _id: String(id) }, on ? { $set: { verified: true } } : { $unset: { verified: "" } }, { upsert: true });
  }
  /** Merge fields into a guild's `shop` sub-document (e.g. { featuredUntil: ts }). */
  async mergeGuildShop(id, patch) {
    if (!this._guilds || !patch) return;
    const set = { lastSeen: Date.now() };
    for (const k of Object.keys(patch)) set[`shop.${k}`] = patch[k];
    await this._guilds.updateOne({ _id: String(id) }, { $set: set }, { upsert: true }).catch(() => {});
  }

  // ─── Server-scoped login links (created by &web, consumed by the web /s/:token) ──
  async createLoginToken(token, uid, guildId, ttlMs = 600_000) {
    if (!this._tokens) return;
    await this._tokens.insertOne({ _id: String(token), uid: this._uid(uid), gid: guildId ? String(guildId) : null, expAt: new Date(Date.now() + ttlMs) }).catch(() => {});
  }
  async consumeLoginToken(token) {
    if (!this._tokens || !token) return null;
    const r = await this._tokens.findOneAndDelete({ _id: String(token) }).catch(() => null);
    const d = unwrap(r) ?? r?.value ?? r;
    if (!d || !d.uid) return null;
    if (d.expAt && new Date(d.expAt).getTime() < Date.now()) return null;
    return { uid: d.uid, gid: d.gid || null };
  }

  /** Cache which guilds a user belongs to (from OAuth scope=guilds at login). */
  async setUserGuilds(userId, gids) {
    await this._users.updateOne({ _id: this._uid(userId) }, { $set: { gids: (Array.isArray(gids) ? gids : []).slice(0, 300).map(String) } }, { upsert: true }).catch(() => {});
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
    // Token is interpolated into a Mongo field path (`st.<token>`) — only accept the
    // hex shape we mint, so a crafted cookie can't probe arbitrary nested keys.
    if (!isSessionToken(token)) return null;
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
    // NOTE: never put the same path in both $set and $unset — Mongo rejects the whole
    // update (path conflict), which previously silently dropped the new session and
    // bounced the user back to /login. Only set the NEW token; unset the OLD one.
    const set = { [`st.${newToken}`]: expiry };
    if (ipAddress) set["sessionMeta.lastIp"] = ipAddress;
    const update = oldToken && oldToken !== newToken
      ? { $set: set, $unset: { [`st.${oldToken}`]: "" } }
      : { $set: set };
    await this._users.updateOne({ _id: id }, update, { upsert: true });
  }

  async revokeSession(userId, token) {
    if (!isSessionToken(token)) return;
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

  // ─── Custom case tiers (for admin panel) ──────────────────────────────────

  async getCustomTiers() {
    if (!this._db) return [];
    const col = this._db.collection("cb_tiers");
    const doc = await col.findOne({ _id: "custom_tiers" });
    return doc?.tiers ?? [];
  }

  async saveCustomTiers(tiers) {
    if (!this._db) return;
    const col = this._db.collection("cb_tiers");
    await col.updateOne(
      { _id: "custom_tiers" },
      { $set: { tiers } },
      { upsert: true },
    );
  }

  // ─── Support tickets ──────────────────────────────────────────────────────
  async createTicket(t) { if (!this._db) return null; await this._db.collection("tickets").insertOne(t); return t; }
  async listTickets(filter = {}) { if (!this._db) return []; return this._db.collection("tickets").find(filter).sort({ updatedAt: -1 }).limit(200).toArray(); }
  async getTicket(id) { if (!this._db) return null; return this._db.collection("tickets").findOne({ _id: id }); }
  async addTicketMessage(id, msg) {
    if (!this._db) return;
    await this._db.collection("tickets").updateOne(
      { _id: id },
      { $push: { messages: msg }, $set: { updatedAt: msg.at, status: msg.from === "admin" ? "answered" : "open" } },
    );
  }
  async setTicketStatus(id, status) { if (!this._db) return; await this._db.collection("tickets").updateOne({ _id: id }, { $set: { status, updatedAt: Date.now() } }); }
  async deleteTicket(id) { if (!this._db) return; await this._db.collection("tickets").deleteOne({ _id: id }); }

  // ─── Destructive: wipe every collection (owner-gated at the route) ──────────
  async wipeAll() {
    if (!this._db) return false;
    const cols = await this._db.listCollections().toArray();
    for (const c of cols) {
      if (c.name.startsWith("system.")) continue;
      try { await this._db.collection(c.name).deleteMany({}); } catch (e) {}
    }
    return true;
  }

  // ─── Pets ─────────────────────────────────────────────────────────────────
  async getPet(uid) { const u = await this.getUser(uid); return u?.pet ?? null; }
  async savePet(uid, pet) {
    if (!this._users) return;
    const set = pet ? { pet } : {};
    const op = pet ? { $set: { pet } } : { $unset: { pet: "" } };
    await this._users.updateOne({ _id: String(uid) }, op, { upsert: true });
  }
}
