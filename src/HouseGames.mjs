// HouseGames — server-authoritative mini-games. Stateless games resolve in one
// call; stateful games (Mines, HiLo) keep per-user state here. Balance moves are
// done by the route layer (deduct on start/bet, credit on win/cashout).
const EDGE = 0.97; // ~3% house edge target

function rnd() { return Math.random(); }

// ── Plinko ──────────────────────────────────────────────────────────────
// Exported so the web layer can ship the bucket tables to the client board.
export const PLINKO = {
  low:  [10, 3, 1.6, 1.4, 1.1, 1, 0.5, 1, 1.1, 1.4, 1.6, 3, 10],
  med:  [33, 11, 4, 2, 1.1, 0.6, 0.3, 0.6, 1.1, 2, 4, 11, 33],
  high: [170, 24, 8.1, 2, 0.7, 0.2, 0.2, 0.2, 0.7, 2, 8.1, 24, 170],
};
export function plinko(bet, risk) {
  const table = PLINKO[risk] || PLINKO.med;
  const rows = table.length - 1; // 12
  const path = [];
  let slot = 0;
  for (let i = 0; i < rows; i++) { const r = rnd() < 0.5 ? 0 : 1; path.push(r); slot += r; }
  const mult = table[slot];
  return { path, slot, mult, payout: Math.round(bet * mult), rows, table };
}

// ── Coinflip / Double or Nothing ────────────────────────────────────────
export function coinflip(bet, side) {
  const roll = rnd() < 0.5 ? "heads" : "tails";
  const win = roll === side;
  const mult = win ? 1.96 : 0; // ~2% edge
  return { roll, win, mult, payout: Math.round(bet * mult) };
}
export function doubleOrNothing(bet) {
  const win = rnd() < 0.49; // ~2% edge on a 2x
  return { win, mult: win ? 2 : 0, payout: win ? bet * 2 : 0 };
}

// ── Chicken Road config. Each lane independently rolls a car-chance between
// DMIN..DMAX (10–50%) drawn at game start, so every run has a different risk
// ladder. The cumulative payout multiplier after clearing k lanes is
// EDGE × ∏(1/(1-death_i)) — the 3% edge is taken once at entry; each extra
// cross is then fair (no compounding), exactly like real Chicken games. High
// death rate keeps profit rare. 10% skill (when to cash) / 90% luck (the roll).
export const CHICKEN = { lanes: 18, dMin: 0.10, dMax: 0.50, maxMult: 5000 };

// ── Stateful games ──────────────────────────────────────────────────────
export class HouseState {
  constructor() { this.mines = new Map(); this.hilo = new Map(); this.chicken = new Map(); }

  // ── Chicken Road: cross lanes one at a time. Each lane's car-chance is fixed
  // at game start (10–50%); surviving locks that lane in (no re-roll, "road
  // block" — no cars after) and banks its multiplier. Cash out any time.
  // Clearing every lane forces a cashout at the top.
  startChicken(uid, bet) {
    const C = CHICKEN, deaths = [], mults = [];
    let m = EDGE; // 3% edge applied once at entry, then fair per cross
    for (let i = 0; i < C.lanes; i++) {
      const d = C.dMin + rnd() * (C.dMax - C.dMin); // this lane's car chance
      deaths.push(d);
      m = m / (1 - d);
      mults.push(Math.min(C.maxMult, +m.toFixed(2)));
    }
    this.chicken.set(uid, { bet, deaths, mults, step: 0, over: false });
    return { lanes: C.lanes, step: 0, mult: 1, mults, deaths: deaths.map((d) => Math.round(d * 100)), nextMult: mults[0], nextDeath: Math.round(deaths[0] * 100) };
  }
  chickenStep(uid) {
    const g = this.chicken.get(uid);
    if (!g || g.over) return { error: "No active game" };
    if (rnd() < g.deaths[g.step]) { g.over = true; this.chicken.delete(uid); return { dead: true, step: g.step }; }
    g.step++;
    const mult = g.mults[g.step - 1];
    if (g.step >= g.mults.length) { // crossed the whole road → forced cashout
      g.over = true; this.chicken.delete(uid);
      return { alive: true, step: g.step, mult, payout: Math.round(g.bet * mult), bet: g.bet, done: true };
    }
    return { alive: true, step: g.step, mult, payout: Math.round(g.bet * mult), nextMult: g.mults[g.step], nextDeath: Math.round(g.deaths[g.step] * 100) };
  }
  chickenCashout(uid) {
    const g = this.chicken.get(uid);
    if (!g || g.over) return { error: "No active game" };
    // Nothing banked yet → just cancel (refund the stake). The bet was deducted at
    // start; the route layer refunds it via STDB. This mirrors "cash out = back out"
    // in every game — you never strand a bet by cashing out with no progress.
    if (g.step < 1) { this.chicken.delete(uid); return { cancelled: true, refund: g.bet, bet: g.bet, step: 0 }; }
    const mult = g.mults[g.step - 1];
    this.chicken.delete(uid);
    return { mult, payout: Math.round(g.bet * mult), bet: g.bet, step: g.step };
  }
  chickenActive(uid) { return this.chicken.has(uid); }
  // If a game is still open when a new one starts (or on cashout-with-no-progress),
  // return the staked bet so it can be refunded. Idempotent — returns 0 if nothing open.
  chickenRefundIfOpen(uid) { const g = this.chicken.get(uid); if (!g || g.over) return 0; this.chicken.delete(uid); return g.bet; }
  clearChicken(uid) { this.chicken.delete(uid); }

  // Mines: 25-tile grid, M mines. Multiplier rises per safe reveal.
  startMines(uid, bet, mineCount) {
    const m = Math.max(1, Math.min(24, mineCount | 0));
    const set = new Set();
    while (set.size < m) set.add(Math.floor(rnd() * 25));
    this.mines.set(uid, { bet, mines: m, grid: set, revealed: [], over: false });
    return { mines: m };
  }
  minesMult(g, k) { // multiplier after k safe reveals
    let mult = 1;
    for (let i = 0; i < k; i++) mult *= (25 - i) / ((25 - g.mines) - i);
    return mult * EDGE;
  }
  minesReveal(uid, idx) {
    const g = this.mines.get(uid);
    if (!g || g.over) return { error: "No active game" };
    idx = idx | 0;
    if (idx < 0 || idx > 24 || g.revealed.includes(idx)) return { error: "Invalid tile" };
    if (g.grid.has(idx)) {
      g.over = true;
      const bombs = [...g.grid];
      this.mines.delete(uid);
      return { hit: true, idx, bombs };
    }
    g.revealed.push(idx);
    const mult = this.minesMult(g, g.revealed.length);
    const safeLeft = (25 - g.mines) - g.revealed.length;
    return { hit: false, idx, reveals: g.revealed.length, mult, payout: Math.round(g.bet * mult), safeLeft };
  }
  minesCashout(uid) {
    const g = this.mines.get(uid);
    if (!g || g.over) return { error: "No active game" };
    // No safe reveals yet → cancel and refund the stake (cash out = back out).
    if (!g.revealed.length) { this.mines.delete(uid); return { cancelled: true, refund: g.bet, bet: g.bet, bombs: [...g.grid] }; }
    const mult = this.minesMult(g, g.revealed.length);
    const bombs = [...g.grid];
    this.mines.delete(uid);
    return { mult, payout: Math.round(g.bet * mult), bet: g.bet, bombs };
  }
  minesActive(uid) { return this.mines.has(uid); }
  // Refund a stranded open game (started but never cashed/lost). 0 if nothing open.
  minesRefundIfOpen(uid) { const g = this.mines.get(uid); if (!g || g.over) return 0; this.mines.delete(uid); return g.bet; }
  clearMines(uid) { this.mines.delete(uid); }

  // HiLo: uniform 13-rank draws. "higher" = higher-or-equal, "lower" = lower-or-equal.
  drawRank() { return 1 + Math.floor(rnd() * 13); }
  startHilo(uid, bet) {
    const card = this.drawRank();
    this.hilo.set(uid, { bet, card, mult: 1, over: false });
    return { card, mult: 1, ...this.hiloOdds(card) };
  }
  hiloOdds(rank) {
    const pHi = (14 - rank) / 13;   // higher or equal
    const pLo = rank / 13;          // lower or equal
    return { higherMult: +(EDGE / pHi).toFixed(3), lowerMult: +(EDGE / pLo).toFixed(3) };
  }
  hiloGuess(uid, dir) {
    const g = this.hilo.get(uid);
    if (!g || g.over) return { error: "No active game" };
    const next = this.drawRank();
    const win = dir === "higher" ? next >= g.card : next <= g.card;
    const odds = this.hiloOdds(g.card);
    const stepMult = dir === "higher" ? odds.higherMult : odds.lowerMult;
    const prev = g.card;
    if (!win) { g.over = true; this.hilo.delete(uid); return { win: false, prev, next }; }
    g.mult *= stepMult;
    g.card = next;
    return Object.assign({ win: true, prev, next, mult: +g.mult.toFixed(3), payout: Math.round(g.bet * g.mult) }, this.hiloOdds(next));
  }
  hiloCashout(uid) {
    const g = this.hilo.get(uid);
    if (!g || g.over) return { error: "No active game" };
    // No winning streak yet → cancel and refund the stake (cash out = back out).
    if (g.mult <= 1) { this.hilo.delete(uid); return { cancelled: true, refund: g.bet, bet: g.bet }; }
    const payout = Math.round(g.bet * g.mult);
    const mult = g.mult, bet = g.bet;
    this.hilo.delete(uid);
    return { mult: +mult.toFixed(3), payout, bet };
  }
  hiloActive(uid) { return this.hilo.has(uid); }
  // Refund a stranded open game (started but never cashed/busted). 0 if nothing open.
  hiloRefundIfOpen(uid) { const g = this.hilo.get(uid); if (!g || g.over) return 0; this.hilo.delete(uid); return g.bet; }
  clearHilo(uid) { this.hilo.delete(uid); }
}

export const HOUSE_GAMES = [
  { id: "plinko", name: "Plinko", tag: "Drop the ball, chase the multiplier", color: "#a855f7" },
  { id: "mines", name: "Mines", tag: "Dodge the bombs, cash out anytime", color: "#ef4444" },
  { id: "coinflip", name: "Coinflip", tag: "Heads or tails — 1.96×", color: "#eab308" },
  { id: "hilo", name: "HiLo", tag: "Higher or lower, build a streak", color: "#22c55e" },
  { id: "double", name: "Double or Nothing", tag: "All in for 2× — 49%", color: "#3b82f6" },
  { id: "chicken", name: "Chicken Road", tag: "Cross the road, dodge the cars, cash out", color: "#f97316" },
];
