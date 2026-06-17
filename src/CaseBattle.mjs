// CaseBattle — runtime-agnostic case-battle engine, extracted from WebServer.mjs so
// the Bun/Elysia service can run the exact same logic. Balances + record-game + the
// player avatar lookup are injected, so this file never touches Mongo or SpacetimeDB
// directly. Behaviour is identical to the original in-process implementation.
//
// Injected deps (opts):
//   bal.deduct(uid, amount)  → Promise<boolean>   (false = couldn't afford; no change)
//   bal.credit(uid, amount)  → Promise<void>
//   bal.getBalance(uid)      → Promise<number>
//   getAvatar(uid)           → Promise<string>
//   db.getCustomTiers()      → Promise<array>
//   db.saveCustomTiers(arr)  → Promise<void>
//   db.recordGame(uid, won, amount) → Promise<void>

import crypto from "node:crypto";

export const CB_BUILTIN_TIERS = [
  { id: "bronze", label: "Bronze", entry: 100, color: "#CD7F32", bg: "#1a0e06", builtIn: true, items: [
    { s: "🪙", n: "Copper Coin", v: 15, w: 35 }, { s: "🪙", n: "Silver Coin", v: 30, w: 25 }, { s: "🔵", n: "Steel Ball", v: 50, w: 20 },
    { s: "🟡", n: "Gold Flake", v: 75, w: 12 }, { s: "💎", n: "Ruby Shard", v: 120, w: 5 }, { s: "👑", n: "Bronze Crown", v: 200, w: 2 }, { s: "🔮", n: "Mystery Box", v: 350, w: 1 } ] },
  { id: "iron", label: "Iron", entry: 250, color: "#A8A8B0", bg: "#0e0e1a", builtIn: true, items: [
    { s: "⚙️", n: "Iron Gear", v: 40, w: 32 }, { s: "🪨", n: "Iron Ore", v: 80, w: 25 }, { s: "🔩", n: "Steel Bolt", v: 130, w: 18 },
    { s: "🛠️", n: "Tool Kit", v: 200, w: 12 }, { s: "⚔️", n: "Iron Sword", v: 300, w: 8 }, { s: "🛡️", n: "Iron Shield", v: 500, w: 3 }, { s: "👑", n: "Iron Helm", v: 800, w: 2 } ] },
  { id: "silver", label: "Silver", entry: 500, color: "#C0C0C0", bg: "#0e0e1a", builtIn: true, items: [
    { s: "🥈", n: "Silver Bar", v: 75, w: 30 }, { s: "🪙", n: "Gold Coin", v: 150, w: 25 }, { s: "🔵", n: "Sapphire", v: 250, w: 18 },
    { s: "🟡", n: "Gold Nugget", v: 400, w: 12 }, { s: "💎", n: "Diamond Chip", v: 700, w: 8 }, { s: "👑", n: "Silver Crown", v: 1200, w: 4 }, { s: "🏆", n: "Grand Trophy", v: 2000, w: 2 }, { s: "🔮", n: "Void Crystal", v: 3500, w: 1 } ] },
  { id: "platinum", label: "Platinum", entry: 1000, color: "#E5E4E2", bg: "#0a0a14", builtIn: true, items: [
    { s: "⬜", n: "Platinum Bar", v: 180, w: 28 }, { s: "💠", n: "Platinum Chip", v: 400, w: 24 }, { s: "🟣", n: "Amethyst", v: 700, w: 18 },
    { s: "🔵", n: "Platinum Ring", v: 1100, w: 12 }, { s: "🟡", n: "Gold Chain", v: 1800, w: 10 }, { s: "👑", n: "Platinum Crown", v: 3000, w: 5 }, { s: "🔮", n: "Ethereal Pearl", v: 5500, w: 2 }, { s: "✨", n: "Mythic Token", v: 9000, w: 1 } ] },
  { id: "emerald", label: "Emerald", entry: 1500, color: "#50C878", bg: "#02180a", builtIn: true, items: [
    { s: "🟢", n: "Emerald Chip", v: 250, w: 28 }, { s: "💚", n: "Heart Emerald", v: 500, w: 22 }, { s: "🟩", n: "Emerald Bar", v: 900, w: 18 },
    { s: "🟢", n: "Emerald Ring", v: 1500, w: 12 }, { s: "🌿", n: "Forest Crown", v: 2500, w: 10 }, { s: "🏺", n: "Ancient Vase", v: 4500, w: 6 }, { s: "🦚", n: "Phoenix Feather", v: 8000, w: 3 }, { s: "🌳", n: "World Tree Sap", v: 15000, w: 1 } ] },
  { id: "gold", label: "Gold", entry: 2500, color: "#FFD700", bg: "#1a1400", builtIn: true, items: [
    { s: "🥇", n: "Gold Coin", v: 400, w: 28 }, { s: "💎", n: "Emerald", v: 800, w: 22 }, { s: "🟡", n: "Gold Bar", v: 1500, w: 18 },
    { s: "🔵", n: "Sapphire Large", v: 2500, w: 12 }, { s: "👑", n: "Gold Crown", v: 4000, w: 10 }, { s: "🏆", n: "Champion Trophy", v: 7000, w: 5 }, { s: "🔮", n: "Astral Orb", v: 12000, w: 3 }, { s: "🌟", n: "Celestial Crown", v: 22000, w: 2 } ] },
  { id: "ruby", label: "Ruby", entry: 5000, color: "#E0115F", bg: "#1a0010", builtIn: true, items: [
    { s: "❤️", n: "Ruby Heart", v: 700, w: 26 }, { s: "🔴", n: "Ruby Bar", v: 1500, w: 22 }, { s: "💖", n: "Love Gem", v: 2800, w: 18 },
    { s: "🌹", n: "Eternal Rose", v: 4500, w: 12 }, { s: "👑", n: "Ruby Crown", v: 7500, w: 10 }, { s: "💝", n: "Royal Heart", v: 13000, w: 6 }, { s: "🌺", n: "Crimson Bloom", v: 22000, w: 4 }, { s: "❤️‍🔥", n: "Heart of Fire", v: 40000, w: 2 } ] },
  { id: "diamond", label: "Diamond", entry: 10000, color: "#00D4FF", bg: "#00081a", builtIn: true, items: [
    { s: "💎", n: "Diamond", v: 2000, w: 28 }, { s: "🌟", n: "Star Shard", v: 5000, w: 22 }, { s: "👑", n: "Royal Crown", v: 10000, w: 18 },
    { s: "🏆", n: "Legend Trophy", v: 18000, w: 12 }, { s: "🔮", n: "Void Gem", v: 30000, w: 8 }, { s: "⚡", n: "Thunder Orb", v: 50000, w: 5 }, { s: "🌌", n: "Galaxy Core", v: 90000, w: 4 }, { s: "💠", n: "Infinity Crown", v: 180000, w: 3 } ] },
  { id: "obsidian", label: "Obsidian", entry: 25000, color: "#1B1B3A", bg: "#000005", builtIn: true, items: [
    { s: "🖤", n: "Obsidian Shard", v: 4000, w: 26 }, { s: "🟣", n: "Void Pearl", v: 9000, w: 22 }, { s: "⚫", n: "Dark Matter", v: 18000, w: 18 },
    { s: "🌑", n: "Eclipse Stone", v: 30000, w: 12 }, { s: "👁️", n: "All-Seeing Eye", v: 50000, w: 10 }, { s: "🦇", n: "Shadow Wings", v: 85000, w: 6 }, { s: "🌚", n: "Black Hole", v: 150000, w: 4 }, { s: "👹", n: "Demon Heart", v: 280000, w: 2 } ] },
  { id: "mythic", label: "Mythic", entry: 100000, color: "#FF6B9D", bg: "#1a0010", builtIn: true, items: [
    { s: "🌸", n: "Sakura Bloom", v: 20000, w: 24 }, { s: "🎴", n: "Legend Card", v: 45000, w: 22 }, { s: "🏯", n: "Castle Tower", v: 80000, w: 18 },
    { s: "🐉", n: "Dragon Scale", v: 130000, w: 14 }, { s: "🦄", n: "Unicorn Horn", v: 220000, w: 10 }, { s: "👑", n: "Divine Crown", v: 380000, w: 6 }, { s: "🌌", n: "Universe Shard", v: 600000, w: 4 }, { s: "✨", n: "God Slayer", v: 1000000, w: 2 } ] },
];

export class CaseBattle {
  constructor(opts) {
    this._bal = opts.bal;
    this._db = opts.db || {};
    this._getAvatar = opts.getAvatar || (async () => "");
    this.active = new Map();        // battleId → battle
    this.userBattle = new Map();    // uid → battleId
    this.custom = [];
    setInterval(() => {
      const cut = Date.now() - 90 * 1000;
      for (const [id, b] of this.active) {
        if (b.phase === "done" && b.resolvedAt < cut) this.active.delete(id);
        else if (b.phase === "pending" && b.createdAt < cut) this.active.delete(id);
      }
    }, 90_000);
  }

  async loadCustomTiers() { try { this.custom = (await this._db.getCustomTiers?.()) || []; } catch {} }
  allTiers() { return [...CB_BUILTIN_TIERS, ...this.custom]; }
  tierById(id) { return this.allTiers().find(t => t.id === id) ?? null; }
  pickItem(tier) { const total = tier.items.reduce((s, i) => s + i.w, 0); let r = Math.random() * total; for (const it of tier.items) { r -= it.w; if (r <= 0) return it; } return tier.items[tier.items.length - 1]; }
  makeBot(cost) {
    const names = ["Frosty", "NSGDX", "Viper", "Echo", "Rogue", "Blitz", "Nova", "Karma", "Specter", "Jinx", "Onyx", "Dash"];
    return { uid: "BOT:" + crypto.randomBytes(4).toString("hex"), tag: "BOT " + names[Math.floor(Math.random() * names.length)], bot: true, avatar: "", cost, rewards: [], totalValue: 0, netWin: 0 };
  }
  openCases(cases) { return cases.map(c => { const tier = this.tierById(c.tier); if (!tier) return { tier: c.tier, cost: c.cost, reward: null, value: 0 }; const it = this.pickItem(tier); return { tier: c.tier, cost: c.cost, reward: it, value: it.v }; }); }

  resolve(battle) {
    if (battle.phase === "done") return;
    const { cases } = battle, players = battle.players;
    const mode = battle.jackpot ? "jackpot" : (battle.crazy ? "crazy" : battle.mode);
    players.forEach(p => {
      const opened = this.openCases(cases);
      p.rewards = opened.map(o => o.reward);
      p.totalValue = opened.reduce((s, o) => s + (o.value || 0), 0);
      p.cost = cases.reduce((s, c) => s + (c.cost || 0), 0);
    });
    const credit = (p, amt) => { if (!p.bot && amt) this._bal.credit(p.uid, amt).catch(() => {}); };
    const record = (p) => { if (!p.bot) this._db.recordGame?.(p.uid, p.netWin > 0, p.cost)?.catch?.(() => {}); };

    if (mode === "jackpot") {
      const weights = players.map(p => Math.max(1, p.totalValue));
      const total = weights.reduce((s, w) => s + w, 0);
      players.forEach((p, i) => { p.winChance = weights[i] / total; });
      let r = Math.random() * total, widx = 0;
      for (let i = 0; i < players.length; i++) { r -= weights[i]; if (r <= 0) { widx = i; break; } }
      const winner = players[widx];
      battle.winnerUid = winner.uid; battle.jackpotWinnerIdx = widx;
      const payout = battle.pot;
      players.forEach(p => { p.netWin = (p === winner) ? payout - p.cost : -p.cost; if (p === winner) credit(p, payout); record(p); });
    } else if (mode === "shared") {
      battle.winnerUid = "shared";
      const rake = Math.floor(battle.pot * 0.05), share = Math.floor((battle.pot - rake) / players.length);
      players.forEach(p => { p.netWin = share - p.cost; credit(p, share); record(p); });
    } else {
      const vals = players.map(p => p.totalValue);
      const target = mode === "crazy" ? Math.min(...vals) : Math.max(...vals);
      const winners = players.filter(p => p.totalValue === target);
      const rake = Math.floor(battle.pot * 0.05);
      if (winners.length === 1) {
        battle.winnerUid = winners[0].uid; const payout = battle.pot - rake;
        players.forEach(p => { p.netWin = (p === winners[0]) ? payout - p.cost : -p.cost; if (p === winners[0]) credit(p, payout); record(p); });
      } else {
        battle.winnerUid = "tie"; const share = Math.floor((battle.pot - rake) / winners.length);
        players.forEach(p => { const win = winners.includes(p); p.netWin = win ? share - p.cost : -p.cost; if (win) credit(p, share); record(p); });
      }
    }
    battle.phase = "done"; battle.resolvedAt = Date.now();
    setTimeout(() => {
      const b = this.active.get(battle.id);
      if (b && b.phase === "done" && Date.now() - b.resolvedAt > 80000) {
        this.active.delete(battle.id);
        for (const p of b.players) if (this.userBattle.get(p.uid) === battle.id) this.userBattle.delete(p.uid);
      }
    }, 90_000);
  }

  startBattle(battle) {
    const isFast = battle.speed === "fast";
    const countdownMs = isFast ? 1500 : 3000, caseCount = battle.cases.length;
    const spinMs = isFast ? 800 : 2000, gapMs = isFast ? 130 : 250, staggerMs = spinMs + gapMs;
    battle.jackpotWheelMs = battle.jackpot ? 2800 : 0;
    battle.phase = "countdown"; battle.startsAt = Date.now() + countdownMs;
    battle.caseStaggerMs = staggerMs; battle.caseSpinMs = spinMs;
    const openMs = (caseCount > 0 ? (caseCount - 1) * staggerMs + spinMs : 0) + 550;
    setTimeout(() => {
      const b = this.active.get(battle.id); if (!b) return;
      b.phase = "opening"; b.openedAt = Date.now(); b.caseStaggerMs = staggerMs; b.caseSpinMs = spinMs;
      this.resolve(b);
      b.phase = "opening"; b._resolvedButAnimating = true;
      setTimeout(() => { const b2 = this.active.get(battle.id); if (b2 && b2._resolvedButAnimating) { b2.phase = "done"; b2.resolvedAt = Date.now(); } }, openMs);
    }, countdownMs + 50);
  }

  // ── route operations (return plain payloads) ───────────────────────────────
  getTiers() {
    return { tiers: this.allTiers().map(t => ({
      id: t.id, label: t.label, entry: t.entry, color: t.color, bg: t.bg, builtIn: !!t.builtIn,
      rtp: Math.round(t.items.reduce((s, i) => s + i.v * i.w, 0) / t.items.reduce((s, i) => s + i.w, 0) / t.entry * 100),
      items: t.items.map(i => ({ s: i.s, n: i.n, v: i.v })),
    })) };
  }
  list() {
    return { battles: [...this.active.values()].filter(b => b.phase !== "done").map(b => ({
      id: b.id, mode: b.mode, cases: b.cases, cost: b.cost, pot: b.pot, maxPlayers: b.maxPlayers,
      speed: b.speed || "normal", jackpot: !!b.jackpot, crazy: !!b.crazy,
      players: b.players.map(p => ({ uid: p.uid, tag: p.tag || p.uid, isCreator: p.uid === b.creatorUid })),
      creatorUid: b.creatorUid, phase: b.phase, createdAt: b.createdAt, watcherCount: b.watchers ? b.watchers.size : 0,
    })).sort((a, b) => a.createdAt - b.createdAt) };
  }
  async create(uid, tag, avatar, data) {
    const { cases, mode, maxPlayers, speed, jackpot, crazy, hidden } = data || {};
    if (!Array.isArray(cases) || cases.length === 0) return { error: "At least one case is required" };
    if (!["regular", "shared"].includes(mode)) return { error: "Invalid mode" };
    const mp = Math.max(2, Math.min(8, Number(maxPlayers) || 2));
    const sp = speed === "fast" ? "fast" : "normal";
    const validatedCases = []; let entryCost = 0;
    for (const c of cases) {
      const tier = this.tierById(c.tier); if (!tier) return { error: `Invalid tier: ${c.tier}` };
      const qty = Math.max(1, Math.min(20, Number(c.qty) || 1));
      for (let i = 0; i < qty; i++) { validatedCases.push({ tier: tier.id, cost: tier.entry }); entryCost += tier.entry; }
    }
    if (!(await this._bal.deduct(uid, entryCost))) return { error: "Insufficient balance" };
    const av = avatar || await this._getAvatar(uid);
    const battleId = crypto.randomBytes(8).toString("hex");
    const battle = {
      id: battleId, creatorUid: uid, mode, maxPlayers: mp, cases: validatedCases, cost: entryCost, pot: entryCost * mp,
      speed: sp, jackpot: !!jackpot, crazy: !!crazy, hidden: !!hidden, phase: "pending",
      players: [{ uid, tag, avatar: av, cost: entryCost, rewards: [], totalValue: 0, netWin: 0 }],
      createdAt: Date.now(), resolvedAt: 0, winnerUid: null, watchers: new Set(), recreateAccepts: new Set(), recreateBattleId: null,
    };
    this.active.set(battleId, battle); this.userBattle.set(uid, battleId);
    return { battleId };
  }
  async join(uid, tag, avatar, battleId) {
    const battle = this.active.get(battleId);
    if (!battle) return { error: "Battle not found" };
    if (battle.phase !== "pending") return { error: "Battle has already started" };
    if (battle.players.some(p => p.uid === uid)) return { error: "Already in this battle" };
    if (battle.players.length >= battle.maxPlayers) return { error: "Battle is full" };
    if (!(await this._bal.deduct(uid, battle.cost))) return { error: "Insufficient balance" };
    const av = avatar || await this._getAvatar(uid);
    battle.players.push({ uid, tag, avatar: av, cost: battle.cost, rewards: [], totalValue: 0, netWin: 0 });
    this.userBattle.set(uid, battleId);
    if (battle.players.length >= battle.maxPlayers) this.startBattle(battle);
    return { battleId };
  }
  addBot(uid, battleId) {
    const battle = this.active.get(battleId);
    if (!battle) return { error: "Battle not found" };
    if (battle.creatorUid !== uid) return { error: "Only the creator can add bots" };
    if (battle.phase !== "pending") return { error: "Battle already started" };
    if (battle.players.length >= battle.maxPlayers) return { error: "Battle is full" };
    battle.players.push(this.makeBot(battle.cost));
    if (battle.players.length >= battle.maxPlayers) this.startBattle(battle);
    return { battleId };
  }
  async recreate(uid, battleId) {
    const battle = this.active.get(battleId);
    if (!battle) return { error: "Battle not found" };
    if (battle.phase !== "done") return { error: "Battle not finished" };
    const realPlayers = battle.players.filter(pl => !pl.bot);
    if (!realPlayers.some(pl => pl.uid === uid)) return { error: "You weren't in this battle" };
    if (battle.recreateBattleId) return { battleId: battle.recreateBattleId };
    if ((await this._bal.getBalance(uid)) < battle.cost) return { error: "Insufficient balance" };
    if (!battle.recreateAccepts) battle.recreateAccepts = new Set();
    battle.recreateAccepts.add(uid);
    const allAccepted = realPlayers.every(pl => battle.recreateAccepts.has(pl.uid));
    if (!allAccepted) return { accepted: battle.recreateAccepts.size, needed: realPlayers.length };
    if (battle._recreating) return { accepted: battle.recreateAccepts.size, needed: realPlayers.length, pending: true };
    battle._recreating = true;
    try {
      if (battle.recreateBattleId) return { battleId: battle.recreateBattleId };
      const charged = [];
      for (const pl of realPlayers) {
        if (!(await this._bal.deduct(pl.uid, battle.cost))) {
          for (const c of charged) await this._bal.credit(c, battle.cost).catch(() => {});
          battle.recreateAccepts.delete(pl.uid);
          return { error: `${pl.tag || pl.uid} can no longer afford it` };
        }
        charged.push(pl.uid);
      }
      const newId = crypto.randomBytes(8).toString("hex");
      const players = [];
      for (const pl of realPlayers) {
        players.push({ uid: pl.uid, tag: pl.tag, avatar: await this._getAvatar(pl.uid), cost: battle.cost, rewards: [], totalValue: 0, netWin: 0 });
        this.userBattle.set(pl.uid, newId);
      }
      const botCount = battle.players.filter(pl => pl.bot).length;
      for (let i = 0; i < botCount; i++) players.push(this.makeBot(battle.cost));
      const nb = {
        id: newId, creatorUid: battle.creatorUid, mode: battle.mode, maxPlayers: battle.maxPlayers,
        cases: battle.cases.map(c => ({ ...c })), cost: battle.cost, pot: battle.cost * battle.maxPlayers,
        speed: battle.speed, jackpot: battle.jackpot, crazy: battle.crazy, hidden: battle.hidden,
        phase: "pending", players, createdAt: Date.now(), resolvedAt: 0, winnerUid: null,
        watchers: new Set(), recreateAccepts: new Set(), recreateBattleId: null,
      };
      this.active.set(newId, nb); battle.recreateBattleId = newId;
      if (nb.players.length >= nb.maxPlayers) this.startBattle(nb);
      return { battleId: newId };
    } finally { battle._recreating = false; }
  }
  watch(uid, battleId) {
    const battle = this.active.get(battleId);
    if (!battle) return { error: "Battle not found" };
    if (!battle.players.some(p => p.uid === uid)) { if (!battle.watchers) battle.watchers = new Set(); battle.watchers.add(uid); }
    return { battleId };
  }
  state(uid, battleId, avatarFor) {
    const battle = this.active.get(battleId);
    if (!battle) return { notFound: true };
    const isPlayer = battle.players.some(p => p.uid === uid);
    const realPlayers = battle.players.filter(pl => !pl.bot);
    const reveal = battle.phase === "done";
    const maskOf = (pl) => !!battle.hidden && !reveal && isPlayer && pl.uid !== uid;
    return {
      id: battle.id, mode: battle.mode, cases: battle.cases, cost: battle.cost, pot: battle.pot, maxPlayers: battle.maxPlayers,
      speed: battle.speed || "normal", jackpot: !!battle.jackpot, crazy: !!battle.crazy, hidden: !!battle.hidden,
      creatorUid: battle.creatorUid, phase: battle.phase, startsAt: battle.startsAt || null, openedAt: battle.openedAt || null, now: Date.now(),
      caseStaggerMs: battle.caseStaggerMs || 600, caseSpinMs: battle.caseSpinMs || 400, jackpotWheelMs: battle.jackpotWheelMs || 0,
      jackpotWinnerIdx: typeof battle.jackpotWinnerIdx === "number" ? battle.jackpotWinnerIdx : null,
      winnerUid: battle.winnerUid, resolvedAt: battle.resolvedAt || null, isPlayer,
      recreate: { accepted: battle.recreateAccepts ? [...battle.recreateAccepts] : [], needed: realPlayers.length, newBattleId: battle.recreateBattleId || null },
      players: battle.players.map(p => { const m = maskOf(p); return {
        uid: p.uid, tag: p.tag || p.uid, avatar: p.avatar || (p.bot ? "" : (avatarFor ? avatarFor(p.uid) : "")), bot: !!p.bot, cost: p.cost,
        rewards: m ? [] : (p.rewards || []), totalValue: m ? 0 : (p.totalValue || 0), netWin: m ? 0 : (p.netWin || 0),
        winChance: battle.hidden ? null : (typeof p.winChance === "number" ? p.winChance : null), hiddenMasked: m,
      }; }),
    };
  }

  // ── tier admin (used by the admin panel port) ──────────────────────────────
  async addTier(tier) { if (this.tierById(tier.id)) return { error: "Tier id exists" }; this.custom.push(tier); await this._db.saveCustomTiers?.(this.custom); return { tier }; }
  async editTier(id, patch) { const i = this.custom.findIndex(t => t.id === id); if (i < 0) return { error: "Not found" }; this.custom[i] = { ...this.custom[i], ...patch, id, builtIn: false }; await this._db.saveCustomTiers?.(this.custom); return { tier: this.custom[i] }; }
  async deleteTier(id) { const i = this.custom.findIndex(t => t.id === id); if (i < 0) return { error: "Not found" }; this.custom.splice(i, 1); await this._db.saveCustomTiers?.(this.custom); return { ok: true }; }
}
