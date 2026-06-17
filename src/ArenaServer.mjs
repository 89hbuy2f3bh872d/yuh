/**
 * ArenaServer — authoritative server-side engine for staked FPS duels.
 *
 * SECURITY MODEL
 * ──────────────
 * The server is the single source of truth for everything that affects payouts:
 * player positions, health, ammo, frags and the match outcome. Clients are
 * treated as untrusted terminals — they may ONLY send inputs (held movement
 * keys, look angles, and a "shoot requested" flag). The client's opinion of
 * whether a shot landed is never trusted; every shot is resolved by a
 * server-side raycast against the opponent's authoritative hitbox and the
 * world geometry. Movement, fire-rate, reload, and ammo are all enforced here
 * so a modified client cannot teleport, wallspeed, full-auto the glock, or
 * shoot through cover.
 *
 * Money flows through the same atomic escrow path as case battles
 * (db.atomicDeduct on entry, db.updateBalance on payout) and every match has
 * a `resolved` flag so the payout is idempotent. Disconnecting during a live
 * match past a grace window forfeits the pot, which closes the "unplug when
 * losing" loophole.
 *
 * LIFECYCLE: pending → countdown → live → done  (then pruned after 90s)
 */

import { WebSocketServer } from "ws";
import crypto from "crypto";

// ── Tick / timing ────────────────────────────────────────────────────────────
const TICK_HZ = 30;
const TICK_MS = 1000 / TICK_HZ;          // ~33ms simulation step
const BROADCAST_EVERY = 3;                // broadcast every Nth tick → 10 Hz state
const COUNTDOWN_MS = 3000;
const TIME_LIMIT_MS = 8 * 60 * 1000;      // hard cap so a match can never run forever
const FORFEIT_GRACE_MS = 25000;           // reconnect tolerance before a DC = forfeit
const STALE_PENDING_MS = 120 * 1000;      // prune unfilled lobbies
const DONE_KEEP_MS = 90 * 1000;           // keep finished match for late polls

// ── Match config ─────────────────────────────────────────────────────────────
const RAKE = 0.05;                        // house cut of the pot
const MIN_STAKE = 10;
const MAX_STAKE = 1_000_000;
const FRAG_CHOICES = [3, 5, 10, 15];

// ── World / physics (kept in sync with games/arena.html practice mode) ───────
const ROOM = 30, HALF = ROOM / 2;
const EYE = 1.7;
const MOVE_SPEED = 6;
const JUMP_VEL = 5.2;
const GRAVITY = 16;
const PLAYER_PAD = 0.5;                    // collision padding matching the client
const FIRE_CD_MS = 120;                    // min gap between shots
const RELOAD_MS = 1100;
const MAG = 17;
const BODY_DMG = 25;
const HEAD_DMG = 100;
const RESPAWN_MS = 1200;
const PITCH_MIN = -1.45, PITCH_MAX = 1.45;

// AABB colliders: {minX,maxX,minZ,maxZ}. Walls + crates — mirrors the client map.
const COLLIDERS = [
  // outer walls
  { minX: -HALF, maxX: HALF, minZ: -HALF - 0.5, maxZ: -HALF + 0.5 },
  { minX: -HALF, maxX: HALF, minZ: HALF - 0.5, maxZ: HALF + 0.5 },
  { minX: -HALF - 0.5, maxX: -HALF + 0.5, minZ: -HALF, maxZ: HALF },
  { minX: HALF - 0.5, maxX: HALF + 0.5, minZ: -HALF, maxZ: HALF },
  // crates [w, d, x, z] → half extents
  ...[[3, 4, -6, -5], [3, 4, 6, 5], [4, 2.8, 0, 0], [2.6, 2.6, -8, 7], [2.6, 2.6, 8, -7]]
    .map(([w, d, x, z]) => ({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 })),
];

// Spawn points spread around the arena corners/edges.
const SPAWNS = [
  { x: -(HALF - 3), z: -(HALF - 3) },
  { x: (HALF - 3), z: (HALF - 3) },
  { x: (HALF - 3), z: -(HALF - 3) },
  { x: -(HALF - 3), z: (HALF - 3) },
];

const KEYMAP = { KeyW: 1, KeyS: 1, KeyA: 1, KeyD: 1, Space: 1 };

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[decodeURIComponent(part.slice(0, i).trim())] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function blockedAt(x, z) {
  for (const c of COLLIDERS) {
    if (x > c.minX - PLAYER_PAD && x < c.maxX + PLAYER_PAD && z > c.minZ - PLAYER_PAD && z < c.maxZ + PLAYER_PAD) return true;
  }
  return false;
}

/** Ray vs AABB (slab method). Returns entry distance > 0, or null if no hit. */
function rayAABB(ox, oy, oz, dx, dy, dz, b) {
  let tmin = -Infinity, tmax = Infinity;
  const o = [ox, oy, oz], d = [dx, dy, dz];
  const lo = [b.minX, b.minY, b.minZ], hi = [b.maxX, b.maxY, b.maxZ];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < lo[i] || o[i] > hi[i]) return null;
    } else {
      let t1 = (lo[i] - o[i]) / d[i];
      let t2 = (hi[i] - o[i]) / d[i];
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
  }
  return tmax >= 0 && tmin >= 0 ? tmin : (tmax >= 0 ? 0 : null);
}

// World collider boxes extended with a tall Y range so the ray test treats
// walls/crates as full-height line-of-sight blockers.
const WORLD_BOXES = COLLIDERS.map(c => ({ minX: c.minX, maxX: c.maxX, minY: 0, maxY: 5, minZ: c.minZ, maxZ: c.maxZ }));

export class ArenaServer {
  constructor(db) {
    this.db = db;
    this.matches = new Map();              // matchId -> match
    this.uidToMatch = new Map();           // uid -> matchId (active, any phase)
    this._wss = null;
    this._tick = setInterval(() => this._loop(), TICK_MS);
  }

  /** Attach to the existing HTTP server (called once from WebServer.start). */
  attach(httpServer) {
    this._wss = new WebSocketServer({ noServer: true });
    httpServer.on("upgrade", (req, socket, head) => {
      let u; try { u = new URL(req.url, "http://localhost"); } catch { try { socket.destroy(); } catch {} return; }
      if (u.pathname !== "/arena/ws") { try { socket.destroy(); } catch {} return; } // don't leave stray upgrades hanging
      try {
        this._wss.handleUpgrade(req, socket, head, (ws) => this._onWs(ws, req));
      } catch (e) {
        console.error("[Arena] upgrade failed:", e?.message ?? e);
        try { socket.destroy(); } catch {}
      }
    });
    // Heartbeat: drop dead sockets so ghosts don't hold match slots.
    this._hb = setInterval(() => {
      if (!this._wss) return;
      this._wss.clients.forEach((ws) => {
        if (ws.isAlive === false) { try { ws.terminate(); } catch {} return; }
        ws.isAlive = false; try { ws.ping(); } catch {}
      });
    }, 30000);
  }

  // ── Authenticated connection ──────────────────────────────────────────────
  async _onWs(ws, req) {
    const c = parseCookies(req.headers.cookie);
    let uid = null;
    if (c.uid && c.sid) {
      const sess = await this.db.validateSession(c.uid, c.sid).catch(() => null);
      if (sess) uid = c.uid;
    }
    if (!uid) { try { ws.close(4001, "unauth"); } catch {} return; }

    ws.uid = uid;
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });
    ws.on("message", (raw) => this._onMsg(ws, String(raw)));
    ws.on("close", () => this._onClose(ws));
    ws.on("error", () => { try { ws.terminate(); } catch {} });

    // If this user has an active match, reattach (handles reconnect within grace).
    const matchId = this.uidToMatch.get(uid);
    if (matchId) this._attachSocket(ws, matchId);
    else this._safeSend(ws, { t: "hello", uid, match: null });
  }

  _attachSocket(ws, matchId) {
    const m = this.matches.get(matchId);
    if (!m) { this._safeSend(ws, { t: "hello", uid: ws.uid, match: null }); return; }
    const slot = m.slots.find(s => s.uid === ws.uid);
    if (!slot) { this._safeSend(ws, { t: "hello", uid: ws.uid, match: null }); return; }
    slot.ws = ws;
    slot.connected = true;
    slot.lastSeen = Date.now();
    // clear any pending forfeit for this player
    m.forfeitAt.delete(ws.uid);
    this._safeSend(ws, this._initMsg(m, slot));
  }

  _onMsg(ws, raw) {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const m = this.matches.get(this.uidToMatch.get(ws.uid) || "");
    if (!m || msg.t !== "input") {
      if (msg.t === "ping") this._safeSend(ws, { t: "pong" });
      return;
    }
    if (m.phase !== "live") return;
    // latest snapshot wins; store authoritative-ish input intent
    const st = m.state.get(ws.uid);
    if (!st) return;
    const k = msg.keys && typeof msg.keys === "object" ? msg.keys : {};
    st.input = {
      W: !!k.KeyW, S: !!k.KeyS, A: !!k.KeyA, D: !!k.KeyD, jump: !!k.Space,
      yaw: clampNum(msg.yaw, st.yaw, 1, false),
      pitch: clampNum(msg.pitch, 0, PITCH_MIN, true),
    };
    // pitch has a separate min/max
    if (typeof msg.pitch === "number") {
      st.input.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, msg.pitch));
    }
    if (msg.wantShoot) st.wantShoot = true;
    if (msg.wantReload) st._reloadReq = true;
  }

  _onClose(ws) {
    const uid = ws.uid;
    if (!uid) return;
    const matchId = this.uidToMatch.get(uid);
    const m = matchId && this.matches.get(matchId);
    if (!m) return;
    const slot = m.slots.find(s => s.uid === uid);
    if (slot && slot.ws === ws) {
      slot.ws = null;
      slot.connected = false;
      // Only forfeit during live play; pre-start leaving is handled by HTTP leave.
      if (m.phase === "live") {
        m.forfeitAt.set(uid, Date.now() + FORFEIT_GRACE_MS);
      }
    }
  }

  _safeSend(ws, obj) {
    if (!ws || ws.readyState !== 1) return;
    try { ws.send(JSON.stringify(obj)); } catch {}
  }

  // ── Public lobby API (called by WebServer HTTP routes) ─────────────────────

  createLobby({ uid, tag, avatar, mode, fragLimit, stake }) {
    if (this.uidToMatch.has(uid)) return { error: "You're already in a match" };
    const m = mode === "2v2" ? "2v2" : "1v1";
    const maxPlayers = m === "2v2" ? 4 : 2;
    const fl = FRAG_CHOICES.includes(Number(fragLimit)) ? Number(fragLimit) : 5;
    const sk = Math.max(MIN_STAKE, Math.min(MAX_STAKE, Math.floor(Number(stake) || 0)));
    if (!(sk >= MIN_STAKE)) return { error: "Invalid stake" };

    // Escrow the creator's stake atomically (synchronous deduction, refund on leave).
    // NOTE: caller (WebServer) performs the actual atomicDeduct BEFORE calling this,
    // since balance I/O must be awaited. We just record the charged amount.
    const id = crypto.randomBytes(8).toString("hex");
    const slots = new Array(maxPlayers).fill(null);
    slots[0] = this._mkSlot(0, uid, tag, avatar, sk);
    const match = {
      id, creatorUid: uid, mode: m, fragLimit: fl, stake: sk, maxPlayers,
      phase: "pending", createdAt: Date.now(),
      startsAt: 0, liveStartedAt: 0, resolvedAt: 0, resolved: false,
      slots,
      state: new Map(),
      events: [], winnerTeam: null, reason: null,
      forfeitAt: new Map(),
      config: { room: ROOM },
    };
    this.matches.set(id, match);
    this.uidToMatch.set(uid, id);
    return { matchId: id };
  }

  /** Caller must have already deducted the stake from the joining user. */
  joinLobby({ uid, tag, avatar, matchId }) {
    if (this.uidToMatch.has(uid)) return { error: "You're already in a match" };
    const m = this.matches.get(matchId);
    if (!m) return { error: "Match not found" };
    if (m.phase !== "pending") return { error: "Match has already started" };
    if (m.slots.filter(s => s).length >= m.maxPlayers) return { error: "Match is full" };
    const idx = m.slots.findIndex(s => !s);
    m.slots[idx] = this._mkSlot(idx, uid, tag, avatar, m.stake);
    this.uidToMatch.set(uid, matchId);
    if (m.slots.filter(s => s).length >= m.maxPlayers) this._startCountdown(m);
    return { matchId };
  }

  maxPlayersFor(mode) { return mode === "2v2" ? 4 : 2; }

  _mkSlot(idx, uid, tag, avatar, cost) {
    return { idx, uid, tag: tag || uid, avatar: avatar || "", cost, connected: false, ws: null, lastSeen: 0 };
  }

  leaveLobby({ uid, matchId }) {
    const m = this.matches.get(matchId);
    if (!m) return { error: "Match not found" };
    if (m.phase !== "pending") return { error: "Match already started — use abandon to forfeit" };
    const slot = m.slots.find(s => s && s.uid === uid);
    if (!slot) return { error: "Not in this match" };
    // Refund + remove. WebServer does the actual balance credit.
    this._removePlayer(m, uid);
    return { ok: true, refund: slot.cost };
  }

  /** Forfeit mid-match (instant). Returns ok so WebServer can reflect result. */
  abandonMatch({ uid, matchId }) {
    const m = this.matches.get(matchId);
    if (!m) return { error: "Match not found" };
    if (m.phase !== "live" && m.phase !== "countdown") return { error: "Nothing to abandon" };
    if (!m.slots.some(s => s && s.uid === uid)) return { error: "Not in this match" };
    // Mark this player's team as the loser via instant forfeit.
    const st = m.state.get(uid);
    const team = st ? st.team : (m.slots.find(s => s && s.uid === uid)?.idx < (m.maxPlayers / 2) ? 0 : 1);
    this._resolve(m, 1 - team, "forfeit");
    return { ok: true };
  }

  _removePlayer(m, uid) {
    const i = m.slots.findIndex(s => s && s.uid === uid);
    if (i >= 0) m.slots[i] = null;
    this.uidToMatch.delete(uid);
    m.state.delete(uid);
    // If creator left during pending, cancel + refund everyone
    if (m.phase === "pending") {
      const remaining = m.slots.filter(s => s);
      if (remaining.length === 0 || remaining.every(s => s.uid !== m.creatorUid)) {
        for (const s of remaining) {
          this.db.updateBalance(s.uid, s.cost).catch(() => {});
          this.uidToMatch.delete(s.uid);
        }
        m.slots = [];
        m._refunded = true;
        this.matches.delete(m.id);
      }
    }
  }

  listLobbies() {
    return [...this.matches.values()]
      .filter(m => m.phase === "pending")
      .map(m => ({
        id: m.id, mode: m.mode, fragLimit: m.fragLimit, stake: m.stake,
        pot: m.stake * this.maxPlayersFor(m.mode),
        maxPlayers: this.maxPlayersFor(m.mode),
        players: m.slots.filter(s => s).map(s => ({ uid: s.uid, tag: s.tag, avatar: s.avatar })),
        creatorUid: m.creatorUid, createdAt: m.createdAt,
      }))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Match state for HTTP polling (lobby view + lightweight live view). */
  getMatch(uid, matchId) {
    const m = this.matches.get(matchId);
    if (!m) return null;
    const me = m.slots.find(s => s && s.uid === uid);
    return {
      id: m.id, mode: m.mode, fragLimit: m.fragLimit, stake: m.stake,
      pot: m.stake * this.maxPlayersFor(m.mode),
      maxPlayers: this.maxPlayersFor(m.mode),
      phase: m.phase, createdAt: m.createdAt, startsAt: m.startsAt,
      liveStartedAt: m.liveStartedAt, resolvedAt: m.resolvedAt,
      winnerTeam: m.winnerTeam, reason: m.reason,
      isPlayer: !!me,
      slots: m.slots.map(s => s ? {
        uid: s.uid, tag: s.tag, avatar: s.avatar, connected: s.connected,
        team: m.state.get(s.uid)?.team ?? null,
        frags: m.state.get(s.uid)?.frags ?? 0,
      } : null),
    };
  }

  userActiveMatch(uid) { return this.uidToMatch.get(uid) || null; }

  // ── Match lifecycle ─────────────────────────────────────────────────────────

  _startCountdown(m) {
    m.phase = "countdown";
    m.startsAt = Date.now() + COUNTDOWN_MS;
  }

  _goLive(m) {
    // Build authoritative per-player state at spawns.
    m.state.clear();
    const halfTeams = m.maxPlayers / 2;
    m.slots.forEach((s, idx) => {
      if (!s) return;
      const spawn = SPAWNS[idx % SPAWNS.length];
      const team = idx < halfTeams ? 0 : 1;
      m.state.set(s.uid, {
        x: spawn.x, y: EYE, z: spawn.z, yaw: 0, pitch: 0, vy: 0, onGround: true,
        hp: 100, ammo: MAG, reloading: false, reloadUntil: 0, lastShot: 0,
        frags: 0, deaths: 0, team, idx, respawnAt: 0, dead: false,
        input: { W: false, S: false, A: false, D: false, jump: false, yaw: 0, pitch: 0 },
        wantShoot: false, _reloadReq: false,
      });
    });
    m.phase = "live";
    m.liveStartedAt = Date.now();
    // Tell everyone to enter the live view.
    for (const s of m.slots) if (s && s.ws) this._safeSend(s.ws, { t: "live", matchId: m.id });
  }

  _loop() {
    const now = Date.now();
    for (const m of [...this.matches.values()]) {
      if (m.phase === "countdown" && now >= m.startsAt) this._goLive(m);
      if (m.phase === "live") this._simulate(m, now);
      // prune
      if (m.phase === "pending" && now - m.createdAt > STALE_PENDING_MS) {
        for (const s of m.slots.filter(x => x)) {
          this.db.updateBalance(s.uid, s.cost).catch(() => {});
          this.uidToMatch.delete(s.uid);
        }
        this.matches.delete(m.id);
      }
      if (m.phase === "done" && now - m.resolvedAt > DONE_KEEP_MS) {
        for (const s of m.slots.filter(x => x)) if (this.uidToMatch.get(s.uid) === m.id) this.uidToMatch.delete(s.uid);
        this.matches.delete(m.id);
      }
    }
  }

  _simulate(m, now) {
    m.events = [];
    const dt = TICK_MS / 1000;
    const teamFrags = [0, 0];

    // 1) apply inputs + physics
    for (const [uid, st] of m.state) {
      if (st.dead) {
        if (now >= st.respawnAt) this._respawn(m, st);
        continue;
      }
      st.yaw = st.input.yaw;
      st.pitch = st.input.pitch;

      // movement
      const fx = Math.sin(st.yaw), fz = Math.cos(st.yaw);
      let mx = 0, mz = 0;
      if (st.input.W) { mx -= fx; mz -= fz; }
      if (st.input.S) { mx += fx; mz += fz; }
      if (st.input.A) { mx -= fz; mz += fx; }
      if (st.input.D) { mx += fz; mz -= fx; }
      const len = Math.hypot(mx, mz);
      if (len > 0) { mx = mx / len * MOVE_SPEED * dt; mz = mz / len * MOVE_SPEED * dt; }
      let nx = st.x + mx, nz = st.z + mz;
      // resolve axes separately against AABB world (matches client feel)
      nx = Math.max(-HALF + 0.6, Math.min(HALF - 0.6, nx));
      nz = Math.max(-HALF + 0.6, Math.min(HALF - 0.6, nz));
      if (!blockedAt(nx, st.z)) st.x = nx;
      if (!blockedAt(st.x, nz)) st.z = nz;
      // jump + gravity
      if (st.input.jump && st.onGround) { st.vy = JUMP_VEL; st.onGround = false; }
      st.vy -= GRAVITY * dt;
      st.y += st.vy * dt;
      if (st.y <= EYE) { st.y = EYE; st.vy = 0; st.onGround = true; }

      // reload handling
      if (st._reloadReq) { st._reloadReq = false; this._startReload(m, st, now); }
      if (st.reloading && now >= st.reloadUntil) { st.reloading = false; st.ammo = MAG; }

      // shoot
      if (st.wantShoot) {
        st.wantShoot = false;
        this._tryShoot(m, st, now);
      }
    }

    // 2) recompute team frags + win check
    for (const st of m.state.values()) teamFrags[st.team] += 0;
    for (const st of m.state.values()) teamFrags[st.team] = Math.max(teamFrags[st.team], 0);
    // sum frags per team
    let tf = [0, 0];
    for (const st of m.state.values()) tf[st.team] += st.frags;
    if (tf[0] >= m.fragLimit) { this._resolve(m, 0, "frags"); return; }
    if (tf[1] >= m.fragLimit) { this._resolve(m, 1, "frags"); return; }

    // 3) time limit
    if (now - m.liveStartedAt >= TIME_LIMIT_MS) {
      const winner = tf[0] === tf[1] ? -1 : (tf[0] > tf[1] ? 0 : 1);
      this._resolve(m, winner, "time");
      return;
    }

    // 4) forfeit checks
    const halfTeams = m.maxPlayers / 2;
    const teamAliveConnected = [0, 0];
    for (const s of m.slots.filter(x => x)) {
      const st = m.state.get(s.uid);
      if (!st) continue;
      const stillConnected = s.connected || !m.forfeitAt.has(s.uid);
      const graceExpired = m.forfeitAt.has(s.uid) && now >= m.forfeitAt.get(s.uid);
      if (!graceExpired) teamAliveConnected[st.team]++;
    }
    // a team with zero eligible players loses
    for (let t = 0; t < 2; t++) {
      if (teamAliveConnected[t] === 0) { this._resolve(m, 1 - t, "forfeit"); return; }
    }

    // 5) broadcast (throttled)
    m._tick = (m._tick || 0) + 1;
    if (m._tick % BROADCAST_EVERY === 0) this._broadcast(m, now);
  }

  _startReload(m, st, now) {
    if (st.reloading || st.ammo >= MAG) return;
    st.reloading = true;
    st.reloadUntil = now + RELOAD_MS;
    this._pushEvent(m, { t: "reload", uid: this._uidOfState(m, st) });
  }

  _tryShoot(m, st, now) {
    if (st.reloading) return;
    if (now - st.lastShot < FIRE_CD_MS) return;     // fire-rate cap
    if (st.ammo <= 0) { this._startReload(m, st, now); return; }
    st.ammo--;
    st.lastShot = now;
    const shooterUid = this._uidOfState(m, st);
    this._pushEvent(m, { t: "shot", uid: shooterUid });

    // Build the shot ray from the shooter's eye along their aim.
    const cp = Math.cos(st.pitch);
    const dx = -Math.sin(st.yaw) * cp, dy = Math.sin(st.pitch), dz = -Math.cos(st.yaw) * cp;
    const ox = st.x, oy = st.y, oz = st.z;

    // Find nearest world blocker distance.
    let wallDist = Infinity;
    for (const b of WORLD_BOXES) {
      const d = rayAABB(ox, oy, oz, dx, dy, dz, b);
      if (d !== null && d < wallDist) wallDist = d;
    }

    // Test enemy players' hitboxes. Head box beats body box at same distance.
    let best = null; // {dist, head, victim}
    for (const [ouid, os] of m.state) {
      if (os.dead || os.team === st.team) continue;     // friendly fire off
      const body = { minX: os.x - 0.45, maxX: os.x + 0.45, minY: 0.3, maxY: 1.7, minZ: os.z - 0.45, maxZ: os.z + 0.45 };
      const head = { minX: os.x - 0.34, maxX: os.x + 0.34, minY: 1.53, maxY: 2.2, minZ: os.z - 0.34, maxZ: os.z + 0.34 };
      const hd = rayAABB(ox, oy, oz, dx, dy, dz, head);
      const bd = rayAABB(ox, oy, oz, dx, dy, dz, body);
      // pick head hit if present (headshot priority)
      let pickDist = null, pickHead = false;
      if (hd !== null && bd !== null) { pickHead = hd <= bd + 0.01; pickDist = pickHead ? hd : bd; }
      else if (hd !== null) { pickHead = true; pickDist = hd; }
      else if (bd !== null) { pickHead = false; pickDist = bd; }
      if (pickDist === null) continue;
      if (pickDist < wallDist && (best === null || pickDist < best.dist)) {
        best = { dist: pickDist, head: pickHead, victim: ouid };
      }
    }
    if (!best) return;                                  // missed / wall-blocked
    const dmg = best.head ? HEAD_DMG : BODY_DMG;
    const victim = m.state.get(best.victim);
    victim.hp -= dmg;
    this._pushEvent(m, { t: "hit", by: shooterUid, victim: best.victim, head: best.head, dmg });
    if (victim.hp <= 0) this._registerFrag(m, shooterUid, best.victim);
  }

  _registerFrag(m, byUid, victimUid) {
    const killer = m.state.get(byUid);
    const victim = m.state.get(victimUid);
    if (killer) killer.frags++;
    if (victim) { victim.deaths++; victim.dead = true; victim.respawnAt = Date.now() + RESPAWN_MS; }
    this._pushEvent(m, { t: "frag", by: byUid, victim: victimUid });
  }

  _respawn(m, st) {
    const spawn = SPAWNS[(st.idx + Math.floor(Math.random() * 2)) % SPAWNS.length];
    st.x = spawn.x; st.z = spawn.z; st.y = EYE; st.vy = 0; st.onGround = true;
    st.hp = 100; st.ammo = MAG; st.reloading = false; st.dead = false;
    st.yaw = 0; st.pitch = 0;
    this._pushEvent(m, { t: "respawn", uid: this._uidOfState(m, st) });
  }

  _uidOfState(m, st) {
    for (const [u, s] of m.state) if (s === st) return u;
    return null;
  }

  _pushEvent(m, ev) {
    if (m.events.length < 64) m.events.push(ev);
  }

  // ── Resolution + payout (idempotent) ────────────────────────────────────────
  _resolve(m, winnerTeam, reason) {
    if (m.resolved) return;
    m.resolved = true;
    m.phase = "done";
    m.winnerTeam = winnerTeam;        // -1 = tie
    m.reason = reason;
    m.resolvedAt = Date.now();

    const pot = m.stake * m.maxPlayers;
    if (winnerTeam === -1) {
      // tie (time limit, equal frags) → refund everyone their stake, no rake
      for (const s of m.slots.filter(x => x)) {
        this.db.updateBalance(s.uid, s.cost).catch(() => {});
        this.db.recordGame(s.uid, false, s.cost).catch(() => {});
      }
    } else {
      const rake = Math.floor(pot * RAKE);
      const payout = pot - rake;
      const winners = m.slots.filter(x => x).filter(s => m.state.get(s.uid)?.team === winnerTeam);
      const share = Math.floor(payout / Math.max(1, winners.length));
      for (const s of m.slots.filter(x => x)) {
        const isWin = m.state.get(s.uid)?.team === winnerTeam;
        if (isWin) this.db.updateBalance(s.uid, share).catch(() => {});
        this.db.recordGame(s.uid, isWin, s.cost).catch(() => {});
      }
    }

    // broadcast final
    for (const s of m.slots.filter(x => x)) {
      if (s.ws) this._safeSend(s.ws, { t: "end", winnerTeam, reason, pot });
    }
  }

  _broadcast(m, now) {
    const payload = {
      t: "state",
      phase: m.phase,
      timeLeft: Math.max(0, TIME_LIMIT_MS - (now - m.liveStartedAt)),
      fragLimit: m.fragLimit,
      players: [...m.state.values()].map(st => ({
        uid: this._uidOfState(m, st), team: st.team, idx: st.idx,
        x: st.x, y: st.y, z: st.z, yaw: st.yaw,
        hp: Math.max(0, Math.round(st.hp)), ammo: st.ammo,
        reloading: st.reloading, dead: st.dead, frags: st.frags,
        connected: m.slots[st.idx]?.connected ?? false,
      })),
      events: m.events,
    };
    m.events = [];
    for (const s of m.slots.filter(x => x)) this._safeSend(s.ws, payload);
  }

  _initMsg(m, slot) {
    return {
      t: "hello", uid: slot.uid, match: {
        id: m.id, mode: m.mode, fragLimit: m.fragLimit, stake: m.stake,
        pot: m.stake * m.maxPlayers, phase: m.phase, startsAt: m.startsAt,
        maxPlayers: this.maxPlayersFor(m.mode),
      },
      you: { idx: slot.idx, team: slot.idx < this.maxPlayersFor(m.mode) / 2 ? 0 : 1 },
      slots: m.slots.map(s => s ? { uid: s.uid, tag: s.tag, idx: s.idx } : null),
    };
  }
}

function clampNum(v, fallback, lo, isMax) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return isMax ? Math.min(lo, n) : Math.max(lo, n);
}
