// Database — the data layer, now backed entirely by SpacetimeDB (migrated off MongoDB).
//
// TWO BACKENDS, same method surface so callers (web/server.ts, commands, CommandHandler)
// never change:
//   • WEB  → new Database({ stdb })            — reads STDB caches, calls STDB reducers.
//   • BOT  → new Database({ http: { base, secret } }) — thin client to the web's loopback
//            /internal/* endpoints (the bot runs no STDB client of its own).
//
// STDB owns ALL state now. JSON-shaped fields (perms, gids, shop, role_shop, ticket
// messages, asset hist, pet) are stored as opaque String blobs in STDB and parsed/merged
// here. Numeric/money changes are atomic reducers. There is NO Mongo, NO balance bridge.

import crypto from "node:crypto";

const DEFAULTS = { bal: 1_000, tw: 0, tl: 0, gp: 0, ld: 0 };

// Per-server tax on winnings, in basis points (1500 = 15%). Capped at 50%.
const DEFAULT_TAX_BPS = 1500;
const MAX_TAX_BPS = 5000;
const MAX_DELTA = 1_000_000_000; // mirrors STDB MAX_DELTA (per-op cap)

function clampTaxBps(bps) {
  const v = Math.round(Number(bps));
  if (!Number.isFinite(v)) return DEFAULT_TAX_BPS;
  return Math.max(0, Math.min(MAX_TAX_BPS, v));
}

// Investing — seed assets. FC-T tracks total FC in circulation; the rest are NFTs.
const INVEST_SEED = [
  {
    _id: "fct",
    kind: "fct",
    name: "FC-T",
    emoji: "🪙",
    color: "#f1c40f",
    price: 1.0,
    baseline: 1.0,
    vol: 0.004,
  },
  {
    _id: "pixelpeng",
    kind: "nft",
    name: "Pixel Penguin",
    emoji: "🐧",
    color: "#3b9dff",
    price: 5,
    baseline: 9,
    vol: 0.06,
  },
  {
    _id: "goldape",
    kind: "nft",
    name: "Gold Ape",
    emoji: "🦍",
    color: "#f5a623",
    price: 8,
    baseline: 16,
    vol: 0.07,
  },
  {
    _id: "cryptcat",
    kind: "nft",
    name: "Crypt Cat",
    emoji: "🐱",
    color: "#9b59b6",
    price: 3,
    baseline: 7,
    vol: 0.08,
  },
  {
    _id: "doomskull",
    kind: "nft",
    name: "Doom Skull",
    emoji: "💀",
    color: "#e74c3c",
    price: 6,
    baseline: 12,
    vol: 0.09,
  },
  {
    _id: "aquagem",
    kind: "nft",
    name: "Aqua Gem",
    emoji: "💠",
    color: "#1abc9c",
    price: 4,
    baseline: 10,
    vol: 0.075,
  },
];

const USER_ID_RE = /^\d{17,20}$/;
function isValidUserId(uid) {
  return typeof uid === "string" && USER_ID_RE.test(uid.trim());
}

// Session tokens are hex. Reject anything else (defensive; STDB PK is the token string).
const SESSION_TOKEN_RE = /^[a-f0-9]{24,128}$/i;
function isSessionToken(t) {
  return typeof t === "string" && SESSION_TOKEN_RE.test(t);
}

function clamp(n, lo, hi) {
  const v = Number(n) || 0;
  return Math.max(lo, Math.min(hi, v));
}

// JSON blob helpers (STDB stores these as opaque strings).
function parseArr(s) {
  try {
    const v = JSON.parse(s || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function parseObj(s) {
  try {
    const v = JSON.parse(s || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
function genId() {
  return crypto.randomBytes(9).toString("hex");
}
function todayUtc() {
  return new Date().toISOString().slice(0, 10);
} // YYYY-MM-DD

export class Database {
  constructor(opts = {}) {
    // WEB mode: { stdb: <Stdb instance> }.  BOT mode: { http: { base, secret } }.
    this.stdb = opts.stdb || null;
    this.http = opts.http || null;
  }

  // Deprecated no-ops kept so existing call sites don't break.
  attachBalanceBridge(_b) {
    /* balances live in STDB directly now */
  }

  async connect() {
    if (this.http) return; // bot: the web service owns the datastore
    await this.stdb.ready().catch(() => {});
    await this.seedAssets().catch(() => {});
    console.log("[DB] STDB-backed data layer ready");
  }

  // ─── HTTP helpers (bot mode) ────────────────────────────────────────────────
  async _post(path, body) {
    try {
      const r = await fetch(this.http.base + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal": this.http.secret,
        },
        body: JSON.stringify(body),
      });
      return r.ok ? await r.json() : { ok: false, error: "http " + r.status };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  _uid(uid) {
    if (!isValidUserId(uid))
      throw new Error(`Invalid userId: ${JSON.stringify(uid)}`);
    return uid.trim();
  }

  // ─── Users ──────────────────────────────────────────────────────────────────
  async getUser(userId) {
    if (this.http) {
      const d = await this._post("/internal/user", { uid: userId });
      return d && d.user ? d.user : { _id: String(userId), ...DEFAULTS };
    }
    const id = this._uid(userId);
    const p = this.stdb.getProfile(id);
    const bal = this.stdb.getBalance(id);
    if (!p) {
      // First touch — create the profile + account (background; cache fills shortly).
      this.stdb.upsertProfile(id, "", "");
      this.stdb.ensureAccount?.(id);
      return { _id: id, bal: bal || DEFAULTS.bal, ...DEFAULTS };
    }
    return {
      _id: id,
      bal,
      tw: p.tw,
      tl: p.tl,
      gp: p.gp,
      ld: p.ld,
      lw: p.lw,
      tag: p.tag,
      av: p.av,
      perms: parseArr(p.perms),
      gids: parseArr(p.gids),
      pet: p.pet ? parseObj(p.pet) : null,
    };
  }

  // Atomically deduct (delta<0) / credit (delta>0). Returns the new doc, or null if a
  // deduction couldn't be covered.
  async atomicDeduct(userId, delta) {
    const id = this._uid(userId);
    const d = clamp(delta, -MAX_DELTA, MAX_DELTA);
    if (d === 0) return { _id: id, bal: await this._bal(id) };
    if (this.http) {
      const res =
        d < 0
          ? await this._post("/internal/deduct", {
              uid: id,
              amount: Math.abs(d),
            })
          : await this._post("/internal/credit", { uid: id, amount: d });
      return res.ok ? { _id: id, bal: Number(res.bal || 0) } : null;
    }
    try {
      if (d < 0) await this.stdb.deduct(id, Math.abs(d));
      else await this.stdb.credit(id, d);
      return { _id: id, bal: this.stdb.getBalance(id) };
    } catch {
      return null;
    } // insufficient
  }

  // Take a bet, pay a win, record the result — atomically.
  async atomicGame(userId, bet, wonAmount = 0) {
    const id = this._uid(userId);
    const b = clamp(Math.abs(bet), 0, MAX_DELTA);
    const w = clamp(Math.abs(wonAmount), 0, MAX_DELTA);
    if (this.http) {
      const res = await this._post("/internal/game", {
        uid: id,
        bet: b,
        payout: w,
      });
      return res.ok
        ? { ok: true, newBal: Number(res.newBal || 0) }
        : { ok: false };
    }
    try {
      await this.stdb.settle(id, b, w);
    } catch {
      return { ok: false };
    }
    await this.recordGame(id, w > b, Math.max(b, w));
    return { ok: true, newBal: this.stdb.getBalance(id) };
  }

  async updateBalance(userId, delta) {
    const id = this._uid(userId);
    const d = clamp(delta, -MAX_DELTA, MAX_DELTA);
    if (d === 0) return { _id: id, bal: await this._bal(id) };
    if (this.http) {
      const res =
        d >= 0
          ? await this._post("/internal/credit", { uid: id, amount: d })
          : await this._post("/internal/deduct", {
              uid: id,
              amount: Math.abs(d),
            });
      return { _id: id, bal: Number(res.bal || 0) };
    }
    try {
      if (d >= 0) await this.stdb.credit(id, d);
      else await this.stdb.deduct(id, Math.abs(d));
    } catch {}
    return { _id: id, bal: this.stdb.getBalance(id) };
  }

  async _bal(id) {
    return this.http
      ? Number(
          (await this._post("/internal/user", { uid: id }))?.user?.bal || 0,
        )
      : this.stdb.getBalance(id);
  }

  async setLastDaily(userId, ts) {
    const id = this._uid(userId),
      t = clamp(ts, 0, Date.now());
    if (this.http)
      return void this._post("/internal/last-daily", { uid: id, ts: t });
    await this.stdb.setLastDaily(id, t);
  }
  async setLastWork(userId, ts) {
    const id = this._uid(userId),
      t = clamp(ts, 0, Date.now());
    if (this.http)
      return void this._post("/internal/last-work", { uid: id, ts: t });
    await this.stdb.setLastWork(id, t);
  }

  async recordGame(userId, won, amount) {
    const id = this._uid(userId),
      amt = clamp(amount, 0, MAX_DELTA);
    if (this.http)
      return void this._post("/internal/record-game", {
        uid: id,
        won: !!won,
        amount: amt,
      });
    await this.stdb.recordGameStats(id, !!won, amt);
  }

  // ─── Profiles / identity ────────────────────────────────────────────────────
  async setProfile(userId, { tag, avatar } = {}) {
    const id = this._uid(userId);
    if (this.http)
      return void this._post("/internal/profile", {
        uid: id,
        tag: tag || "",
        avatar: avatar || "",
      });
    await this.stdb.upsertProfile(
      id,
      typeof tag === "string" ? tag : "",
      typeof avatar === "string" ? avatar : "",
    );
  }

  async searchUsers(q, limit = 25, excludeId = null) {
    const lim = clamp(limit, 1, 50);
    const term = String(q ?? "")
      .trim()
      .toLowerCase();
    const out = [];
    for (const p of this.stdb.allProfiles()) {
      if (excludeId && p.owner === String(excludeId)) continue;
      if (
        term &&
        !(
          p.owner.toLowerCase().includes(term) ||
          (p.tag || "").toLowerCase().includes(term)
        )
      )
        continue;
      out.push({ _id: p.owner, tag: p.tag, av: p.av });
      if (out.length >= lim) break;
    }
    return out;
  }

  async searchUsersAdmin(q, limit = 30) {
    const lim = clamp(limit, 1, 100);
    const term = String(q ?? "")
      .trim()
      .toLowerCase();
    const out = [];
    for (const p of this.stdb.allProfiles()) {
      if (
        term &&
        !(
          p.owner.toLowerCase().includes(term) ||
          (p.tag || "").toLowerCase().includes(term)
        )
      )
        continue;
      out.push({
        _id: p.owner,
        tag: p.tag,
        av: p.av,
        bal: this.stdb.getBalance(p.owner),
        perms: parseArr(p.perms),
      });
    }
    out.sort((a, b) => (b.bal ?? 0) - (a.bal ?? 0));
    return out.slice(0, lim);
  }

  async getPerms(userId) {
    const id = this._uid(userId);
    const p = this.stdb.getProfile(id);
    return p ? parseArr(p.perms) : [];
  }
  async setPerms(userId, perms) {
    const id = this._uid(userId);
    const arr = Array.isArray(perms) ? [...new Set(perms.map(String))] : [];
    await this.stdb.setPerms(id, JSON.stringify(arr));
    return arr;
  }
  async listAdmins() {
    const out = [];
    for (const p of this.stdb.allProfiles()) {
      const perms = parseArr(p.perms);
      if (perms.length)
        out.push({
          _id: p.owner,
          tag: p.tag,
          av: p.av,
          bal: this.stdb.getBalance(p.owner),
          perms,
        });
    }
    return out.slice(0, 200);
  }

  async transfer(fromId, toId, amount, fromTag) {
    const fId = this._uid(fromId),
      tId = this._uid(toId);
    if (fId === tId) return false;
    const amt = clamp(Math.abs(amount), 1, MAX_DELTA);
    if (this.http) {
      const res = await this._post("/internal/transfer", {
        from: fId,
        to: tId,
        amount: amt,
        fromTag: fromTag || fId,
      });
      return !!res.ok;
    }
    try {
      await this.stdb.transfer(fId, tId, amt, fromTag || fId);
      return true;
    } catch {
      return false;
    }
  }

  // ─── Notifications ──────────────────────────────────────────────────────────
  async addNotification(userId, notif = {}) {
    const id = this._uid(userId);
    const n = {
      t: String(notif.type || "info").slice(0, 16),
      m: String(notif.msg || "").slice(0, 200),
      a: Number(notif.amount) || 0,
      f: String(notif.fromTag || "").slice(0, 64),
      ts: Date.now(),
    };
    if (this.http) {
      await this._post("/internal/notify", {
        uid: id,
        kind: n.t,
        amount: n.a,
        fromTag: n.f,
        msg: n.m,
      });
      return n;
    }
    await this.stdb.addNotification(id, n.t, n.a, n.f, n.m);
    return n;
  }
  async getNotifications(userId) {
    return this.stdb.getNotifications(this._uid(userId));
  }
  async markNotificationsRead(userId) {
    await this.stdb.markRead(this._uid(userId));
  }

  // ─── Leaderboards / stats ───────────────────────────────────────────────────
  async getLeaderboard(field, limit) {
    const lim = clamp(limit, 1, 100);
    const f = ["bal", "tw", "tl", "gp"].includes(field) ? field : "bal";
    if (this.http) {
      const d = await this._post("/internal/leaderboard-sorted", {
        field: f,
        limit: lim,
      });
      return Array.isArray(d.rows) ? d.rows : [];
    }
    const rows = this.stdb
      .allProfiles()
      .map((p) => ({
        _id: p.owner,
        bal: this.stdb.getBalance(p.owner),
        tw: p.tw,
        tl: p.tl,
        gp: p.gp,
        tag: p.tag,
        av: p.av,
      }));
    rows.sort((a, b) => (b[f] ?? 0) - (a[f] ?? 0));
    return rows.slice(0, lim);
  }

  async recordCommand(cmdName) {
    if (this.http)
      return void this._post("/internal/record-command", { cmd: cmdName });
    await this.stdb.recordCommand(
      String(cmdName || "").slice(0, 48),
      todayUtc(),
    );
  }
  async getCommandStats() {
    return this.stdb
      .allStatCounters()
      .map((c) => ({ _id: "cmd:" + c.key, count: c.count }))
      .sort((a, b) => b.count - a.count);
  }
  async getDailyStats(days = 14) {
    return this.stdb
      .allDailyStats()
      .map((d) => ({ _id: d.date, total: d.total }))
      .sort((a, b) => (a._id < b._id ? 1 : -1))
      .slice(0, days);
  }

  // ─── Guilds ─────────────────────────────────────────────────────────────────
  _guildDoc(g) {
    if (!g) return null;
    return {
      _id: g.gid,
      name: g.name,
      icon: g.icon,
      ownerId: g.ownerId,
      memberCount: g.memberCount,
      invite: g.invite,
      taxBps: g.taxBps,
      rakebackPct: g.rakebackPct,
      verified: g.verified,
      shop: parseObj(g.shop),
      roleShop: parseArr(g.roleShop),
      lastSeen: g.lastSeen,
      joinedAt: g.joinedAt,
    };
  }
  async upsertGuild(guildId, data = {}) {
    const gid = String(guildId);
    if (this.http)
      return void this._post("/internal/guild-upsert", { gid, ...data });
    await this.stdb.upsertGuild(
      gid,
      data.ownerId || "",
      data.name || "",
      data.icon || "",
      Math.floor(Number(data.memberCount) || 0),
    );
  }
  async getGuilds() {
    return this.stdb
      .allGuilds()
      .map((g) => this._guildDoc(g))
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  }
  async getGuildsByIds(ids) {
    if (!Array.isArray(ids) || !ids.length) return [];
    return ids
      .map((id) => this._guildDoc(this.stdb.getGuildRow(String(id))))
      .filter(Boolean);
  }
  async getGuild(id) {
    return this._guildDoc(this.stdb.getGuildRow(String(id)));
  }
  async notifyGuild(gid, data) {
    if (this.http)
      await this._post("/internal/guild", { gid: String(gid), ...data });
  }

  async addUserGuild(uid, guildId) {
    if (!isValidUserId(uid) || !guildId) return false;
    const id = uid.trim(),
      gid = String(guildId);
    if (this.http) {
      const res = await this._post("/internal/user-guild-add", {
        uid: id,
        gid,
      });
      return !!res.added;
    }
    const p = this.stdb.getProfile(id);
    const gids = p ? parseArr(p.gids) : [];
    if (gids.includes(gid)) return false;
    gids.push(gid);
    await this.stdb.setUserGuilds(id, JSON.stringify(gids.slice(0, 300)));
    return true;
  }
  async notifyUserGuilds(uid) {
    if (this.http)
      await this._post("/internal/user-guilds", { uid: String(uid) });
  }
  async getGuildUserIds(guildId) {
    if (!guildId) return [];
    const gid = String(guildId),
      out = [];
    for (const p of this.stdb.allProfiles())
      if (parseArr(p.gids).includes(gid) && isValidUserId(p.owner))
        out.push(p.owner);
    return out;
  }

  // Per-owner daily bank-withdraw ledger (stored on the profile as bwdDay/bwdTotal).
  async bankWithdrawnToday(uid, day) {
    if (!isValidUserId(uid)) return 0;
    const p = this.stdb.getProfile(uid.trim());
    return p && p.bwdDay === day ? Number(p.bwdTotal) || 0 : 0;
  }
  async tryRecordBankWithdraw(uid, day, amount, cap) {
    if (!isValidUserId(uid)) return false;
    const amt = Math.floor(Number(amount) || 0);
    if (!(amt > 0)) return false;
    try {
      await this.stdb.tryBankWithdraw(
        uid.trim(),
        String(day),
        amt,
        Math.floor(Number(cap) || 0),
      );
      return true;
    } catch {
      return false;
    }
  }

  // ─── Pending slot win (restart recovery; stored in kv as psl:<uid>) ──────────
  async setPendingSlot(uid, p) {
    if (!isValidUserId(uid)) return;
    await this.stdb.kvSet("psl:" + uid.trim(), JSON.stringify(p || {}));
  }
  async clearPendingSlot(uid) {
    if (!isValidUserId(uid)) return;
    await this.stdb.kvSet("psl:" + uid.trim(), "");
  }
  async loadPendingSlots() {
    const out = [];
    for (const r of this.stdb.allKv()) {
      if (!r.key.startsWith("psl:") || !r.val) continue;
      const uid = r.key.slice(4);
      out.push({ uid, ...parseObj(r.val) });
    }
    return out;
  }

  // ─── Last selected server (persisted in kv as srv:<uid>) ────────────────────
  // Source of truth for "remember my server" — survives refresh, restart, and
  // re-login. The web restores the `srv` cookie from this on OAuth/token login.
  async setLastServer(uid, gid) {
    if (this.http)
      return void this._post("/internal/last-server", {
        uid: String(uid),
        gid: String(gid || ""),
      });
    if (!isValidUserId(uid)) return;
    await this.stdb.kvSet("srv:" + uid.trim(), String(gid || ""));
  }
  async getLastServer(uid) {
    if (this.http) {
      const d = await this._post("/internal/last-server-get", {
        uid: String(uid),
      });
      return d && d.gid ? String(d.gid) : "";
    }
    if (!isValidUserId(uid)) return "";
    const r = this.stdb.getKv("srv:" + uid.trim());
    return r && r.val ? String(r.val) : "";
  }

  // ─── Role shop ──────────────────────────────────────────────────────────────
  async getRoleShop(id) {
    const gid = String(id);
    if (this.http) {
      const d = await this._post("/internal/role-shop", { gid });
      return Array.isArray(d.rows) ? d.rows : [];
    }
    return parseArr(this.stdb.getGuildRow(gid)?.roleShop);
  }
  async setRoleShop(id, arr) {
    const gid = String(id);
    const clean = (Array.isArray(arr) ? arr : [])
      .slice(0, 25)
      .map((r) => ({
        roleId: String(r.roleId),
        name: String(r.name || "Role").slice(0, 80),
        price: Math.floor(Number(r.price) || 0),
      }));
    if (this.http)
      return void this._post("/internal/role-shop-set", { gid, rows: clean });
    await this.stdb.setRoleShop(gid, JSON.stringify(clean));
  }
  async rolePurchase(uid, gid, price) {
    if (this.http)
      return this._post("/internal/role-purchase", { uid, gid, price });
    // web-side direct (unused by web today, but keep parity): deduct full, 75% → bank.
    const u = this._uid(uid),
      g = String(gid),
      p = Math.floor(Number(price) || 0);
    if (!(p > 0)) return { ok: false, error: "bad price" };
    try {
      await this.stdb.deduct(u, p);
    } catch {
      return { ok: false, error: "insufficient" };
    }
    const toBank = Math.floor(p * 0.75);
    if (toBank > 0)
      await this.stdb.creditWin(u, toBank, g, toBank).catch(() => {});
    return { ok: true, bal: this.stdb.getBalance(u), banked: toBank };
  }

  // ─── Investing ──────────────────────────────────────────────────────────────
  async seedAssets() {
    if (this.http) return;
    // Wait briefly for the invest_asset subscription to apply so we don't clobber live
    // prices by "seeding" assets that already exist. On a fresh DB this just waits out
    // the loop then seeds all six.
    for (let i = 0; i < 25 && this.stdb.allAssets().length === 0; i++)
      await new Promise((r) => setTimeout(r, 100));
    for (const a of INVEST_SEED) {
      if (!this.stdb.getAssetRow(a._id)) {
        await this.stdb.saveAsset({
          ...a,
          bias: 0,
          supply: 0,
          prevPrice: a.price,
          hist: [[Date.now(), a.price]],
          updatedAt: Date.now(),
        });
      }
    }
  }
  _assetDoc(a) {
    return a
      ? {
          _id: a.id,
          kind: a.kind,
          name: a.name,
          emoji: a.emoji,
          color: a.color,
          price: a.price,
          baseline: a.baseline,
          vol: a.vol,
          bias: a.bias,
          supply: a.supply,
          prevPrice: a.prevPrice,
          hist: parseArr(a.hist),
          updatedAt: a.updatedAt,
        }
      : null;
  }
  async getAssets() {
    return this.stdb
      .allAssets()
      .map((a) => this._assetDoc(a))
      .sort((a, b) =>
        a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a._id < b._id ? -1 : 1,
      );
  }
  async getAsset(id) {
    return this._assetDoc(this.stdb.getAssetRow(String(id)));
  }
  async saveAssets(list) {
    if (!Array.isArray(list)) return;
    for (const a of list) await this.stdb.saveAsset(a);
  }
  async totalHoldingUnits() {
    return this.stdb.totalHoldingUnits();
  }
  async getHoldings(uid) {
    const out = {};
    for (const h of this.stdb.getHoldingsFor(String(uid)))
      out[h.assetId] = { u: h.units, c: h.cost };
    return out;
  }
  async setHoldings(_uid, _h) {
    /* unused: positions move via addHolding/removeHolding */
  }
  async addHolding(uid, assetId, units, cost) {
    const u = Number(units) || 0;
    if (!(u > 0)) return;
    await this.stdb.addHolding(
      String(uid),
      String(assetId),
      u,
      Math.round(Number(cost) || 0),
    );
  }
  async removeHolding(uid, assetId, units) {
    const sellU = Number(units);
    if (!(sellU > 0)) return null;
    const id = String(uid),
      aid = String(assetId);
    const cur = this.stdb.getHoldingsFor(id).find((h) => h.assetId === aid);
    if (!cur || !(cur.units >= sellU - 1e-9)) return null;
    const costPortion = Math.round((cur.cost || 0) * (sellU / cur.units));
    try {
      await this.stdb.removeHolding(id, aid, sellU, costPortion);
      return { soldUnits: sellU, costPortion };
    } catch {
      return null;
    }
  }
  async investMe(uid) {
    return this._post("/internal/invest/me", { uid });
  }
  async investTrade(side, uid, assetId, amount) {
    return this._post("/internal/invest/trade", {
      side,
      uid,
      asset: assetId,
      amount,
    });
  }

  // ─── Guild economy (tax / invite / rakeback / verify / shop) ─────────────────
  async setGuildInvite(id, invite) {
    await this.stdb.setGuildInvite(
      String(id),
      invite ? String(invite).slice(0, 256) : "",
    );
  }
  async getGuildTax(id) {
    const g = this.stdb.getGuildRow(String(id));
    return Number.isFinite(g?.taxBps) ? clampTaxBps(g.taxBps) : DEFAULT_TAX_BPS;
  }
  async setGuildTax(id, bps) {
    const v = clampTaxBps(bps);
    await this.stdb.setGuildTax(String(id), v);
    return v;
  }

  async recordServerWager(gid, amount, uid) {
    if (!gid) return;
    await this.stdb.recordServerWager(
      String(gid),
      isValidUserId(uid) ? uid : "",
      Math.max(0, Math.floor(Number(amount) || 0)),
    );
  }
  async recordServerPayout(gid, payout, tax) {
    if (!gid) return;
    await this.stdb.recordServerPayout(
      String(gid),
      Math.max(0, Math.floor(Number(payout) || 0)),
      Math.max(0, Math.floor(Number(tax) || 0)),
    );
  }
  _statsDoc(s) {
    return s
      ? {
          _id: s.gid,
          gp: s.gp,
          wagered: s.wagered,
          payout: s.payout,
          taxed: s.taxed,
          big: s.big,
          players: s.playerCount,
          playerCount: s.playerCount,
          lastPlay: s.lastPlay,
        }
      : null;
  }
  async getServerStats(gid) {
    if (!gid) return null;
    return this._statsDoc(this.stdb.getStats(String(gid)));
  }
  async getServerStatsMany(gids) {
    if (!Array.isArray(gids) || !gids.length) return [];
    return gids
      .map((g) => this._statsDoc(this.stdb.getStats(String(g))))
      .filter(Boolean);
  }
  async getTopServerStats(sortKey, limit = 50) {
    const field =
      { wagered: "wagered", taxed: "taxed", games: "gp", payout: "payout" }[
        sortKey
      ] || "wagered";
    const rows = this.stdb.allStats().map((s) => this._statsDoc(s));
    rows.sort((a, b) => (b[field] ?? 0) - (a[field] ?? 0));
    return rows.slice(0, Math.min(200, Math.max(1, limit | 0)));
  }

  // ─── Rakeback ───────────────────────────────────────────────────────────────
  async addRakeback(uid, gid, wager, taxBps, pct) {
    if (!gid || !isValidUserId(uid)) return;
    const w = Math.max(0, Math.floor(Number(wager) || 0));
    const tb = Math.max(0, Number(taxBps) || 0);
    const p = Math.max(0, Math.min(20, Number(pct) || 0));
    if (!(w > 0) || !(tb > 0) || !(p > 0)) return;
    const earn = Math.floor((((w * tb) / 10000) * p) / 100);
    if (!(earn > 0)) return;
    await this.stdb.addRakeback(uid, String(gid), earn, w);
  }
  async getRakeback(uid, gid) {
    if (!gid || !isValidUserId(uid))
      return { accrued: 0, wagered: 0, claimed: 0 };
    const r = this.stdb.getRakebackRow(uid, String(gid));
    return {
      accrued: r?.accrued || 0,
      wagered: r?.wagered || 0,
      claimed: r?.claimed || 0,
    };
  }
  // Atomic claim: the STDB reducer zeroes accrued + credits the balance in one txn, so
  // the amount paid is exactly the balance delta. The route must NOT credit again.
  async claimRakeback(uid, gid) {
    if (!gid || !isValidUserId(uid)) return 0;
    const before = this.stdb.getBalance(uid);
    try {
      await this.stdb.claimRakeback(uid, String(gid));
    } catch {
      return 0;
    }
    return Math.max(0, this.stdb.getBalance(uid) - before);
  }
  async setGuildRakebackPct(gid, pct) {
    if (!gid) return;
    await this.stdb.setGuildRakeback(
      String(gid),
      Math.max(0, Math.min(20, Math.floor(Number(pct) || 0))),
    );
  }
  async getGuildRakebackPct(gid) {
    if (!gid) return 5;
    const g = this.stdb.getGuildRow(String(gid));
    const p = Number(g?.rakebackPct);
    return Number.isFinite(p) ? Math.max(0, Math.min(20, p)) : 5;
  }

  async getGuildEconomy(id) {
    const g = this.stdb.getGuildRow(String(id));
    return {
      taxBps: Number.isFinite(g?.taxBps)
        ? clampTaxBps(g.taxBps)
        : DEFAULT_TAX_BPS,
      shop: parseObj(g?.shop),
      verified: !!g?.verified,
    };
  }
  async setGuildVerified(id, on) {
    await this.stdb.setGuildVerified(String(id), !!on);
  }
  async mergeGuildShop(id, patch) {
    if (!patch) return;
    const g = this.stdb.getGuildRow(String(id));
    const shop = parseObj(g?.shop);
    for (const k of Object.keys(patch)) shop[k] = patch[k];
    await this.stdb.setGuildShop(String(id), JSON.stringify(shop));
  }

  // ─── Login tokens ───────────────────────────────────────────────────────────
  async createLoginToken(token, uid, guildId, ttlMs = 600_000) {
    const id = this._uid(uid),
      gid = guildId ? String(guildId) : "";
    if (this.http)
      return void this._post("/internal/login-token", {
        token: String(token),
        uid: id,
        gid,
        ttlMs,
      });
    await this.stdb.createLoginToken(
      String(token),
      id,
      gid,
      Date.now() + clamp(ttlMs, 60_000, 86_400_000),
    );
  }
  async consumeLoginToken(token) {
    if (!token) return null;
    const r = this.stdb.getLoginTokenRow(String(token));
    if (!r) return null;
    await this.stdb.consumeLoginToken(String(token));
    if (r.expAt && r.expAt < Date.now()) return null;
    return { uid: r.uid, gid: r.gid || null };
  }

  async setUserGuilds(userId, gids) {
    const id = this._uid(userId);
    await this.stdb.setUserGuilds(
      id,
      JSON.stringify(
        (Array.isArray(gids) ? gids : []).slice(0, 300).map(String),
      ),
    );
  }

  // ─── Admin aggregates ───────────────────────────────────────────────────────
  async getAdminUserStats(limit = 20) {
    const rows = this.stdb
      .allProfiles()
      .map((p) => ({
        _id: p.owner,
        bal: this.stdb.getBalance(p.owner),
        tw: p.tw,
        tl: p.tl,
        gp: p.gp,
        tag: p.tag,
        av: p.av,
      }));
    rows.sort((a, b) => (b.tw ?? 0) - (a.tw ?? 0));
    return rows.slice(0, clamp(limit, 1, 200));
  }
  async getGlobalTotals() {
    let totalUsers = 0,
      totalBalance = 0,
      totalWon = 0,
      totalLost = 0,
      totalGames = 0;
    for (const p of this.stdb.allProfiles()) {
      totalUsers++;
      totalBalance += this.stdb.getBalance(p.owner);
      totalWon += p.tw;
      totalLost += p.tl;
      totalGames += p.gp;
    }
    return { totalUsers, totalBalance, totalWon, totalLost, totalGames };
  }

  // ─── Sessions ───────────────────────────────────────────────────────────────
  async validateSession(userId, token) {
    if (!isSessionToken(token)) return null;
    const id = this._uid(userId);
    const s = this.stdb.getSessionRow(token);
    if (!s || s.owner !== id) return null;
    if (!s.expiryMs || Date.now() > s.expiryMs) return null;
    return { uid: id, token, exp: s.expiryMs };
  }
  async createSession(userId, token, ttlMs, _ip = null) {
    const id = this._uid(userId);
    await this.stdb.createSession(
      id,
      String(token),
      Date.now() + clamp(ttlMs ?? 7_200_000, 60_000, 604_800_000),
    );
  }
  async rotateSession(userId, oldToken, newToken, ttlMs, ip = null) {
    await this.createSession(userId, newToken, ttlMs, ip);
    if (oldToken && oldToken !== newToken && isSessionToken(oldToken))
      await this.stdb.revokeSession(String(oldToken));
  }
  async revokeSession(userId, token) {
    if (isSessionToken(token)) await this.stdb.revokeSession(String(token));
  }
  async revokeAllSessions(userId) {
    await this.stdb.revokeAllSessions(this._uid(userId));
  }
  async pruneExpiredSessions() {
    if (this.http) return;
    await this.stdb.pruneExpiredSessions();
  }

  // ─── Custom case tiers (kv singleton) ───────────────────────────────────────
  async getCustomTiers() {
    const r = this.stdb.getKv("custom_tiers");
    return r ? parseArr(r.val) : [];
  }
  async saveCustomTiers(tiers) {
    await this.stdb.kvSet(
      "custom_tiers",
      JSON.stringify(Array.isArray(tiers) ? tiers : []),
    );
  }

  // ─── Support tickets ────────────────────────────────────────────────────────
  _ticketDoc(t) {
    return t
      ? {
          _id: t.id,
          uid: t.uid,
          tag: t.tag,
          subject: t.subject,
          status: t.status,
          messages: parseArr(t.messages),
          updatedAt: t.updatedAt,
          createdAt: t.createdAt,
        }
      : null;
  }
  async createTicket(t) {
    const id = String(t._id || genId());
    await this.stdb.createTicket(
      id,
      this._uid(t.uid),
      String(t.tag || "").slice(0, 64),
      String(t.subject || "").slice(0, 200),
      JSON.stringify(Array.isArray(t.messages) ? t.messages : []),
      Number(t.createdAt) || Date.now(),
    );
    return { ...t, _id: id };
  }
  async listTickets(filter = {}) {
    let rows = this.stdb.allTickets().map((t) => this._ticketDoc(t));
    if (filter && filter.status)
      rows = rows.filter((t) => t.status === filter.status);
    if (filter && filter.uid)
      rows = rows.filter((t) => t.uid === String(filter.uid));
    rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return rows.slice(0, 200);
  }
  async getTicket(id) {
    return this._ticketDoc(this.stdb.getTicketRow(String(id)));
  }
  async addTicketMessage(id, msg) {
    const t = this.stdb.getTicketRow(String(id));
    if (!t) return;
    const msgs = parseArr(t.messages);
    msgs.push(msg);
    const status = msg.from === "admin" ? "answered" : "open";
    await this.stdb.addTicketMessage(
      String(id),
      JSON.stringify(msgs),
      status,
      Number(msg.at) || Date.now(),
    );
  }
  async setTicketStatus(id, status) {
    await this.stdb.setTicketStatus(String(id), String(status), Date.now());
  }
  async deleteTicket(id) {
    await this.stdb.deleteTicket(String(id));
  }

  // ─── Destructive wipe (owner-gated at the route) ────────────────────────────
  async wipeAll() {
    const tables = [
      "account",
      "server_bank",
      "notification",
      "user_profile",
      "session",
      "guild",
      "server_stats",
      "server_player",
      "holding",
      "invest_asset",
      "ticket",
      "rakeback_ledger",
      "login_token",
      "stat_counter",
      "daily_stat",
      "kv",
    ];
    for (const t of tables) await this.stdb.wipeTable(t);
    return true;
  }

  // ─── Pets ───────────────────────────────────────────────────────────────────
  async getPet(uid) {
    if (this.http) {
      const d = await this._post("/internal/pet-get", { uid });
      return d && d.pet ? d.pet : null;
    }
    const p = this.stdb.getProfile(this._uid(uid));
    return p && p.pet ? parseObj(p.pet) : null;
  }
  async savePet(uid, pet) {
    const id = this._uid(uid);
    if (this.http)
      return void this._post("/internal/pet-set", {
        uid: id,
        pet: pet || null,
      });
    await this.stdb.setPet(id, pet ? JSON.stringify(pet) : "");
  }
}
