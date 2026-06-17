// HouseGames — server-authoritative mini-games. Stateless games resolve in one
// call; stateful games (Mines, HiLo) keep per-user state here. Balance moves are
// done by the route layer (deduct on start/bet, credit on win/cashout).
const EDGE = 0.97; // ~3% house edge target

function rnd() { return Math.random(); }

// ── Plinko ──────────────────────────────────────────────────────────────
const PLINKO = {
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

// ── Stateful games ──────────────────────────────────────────────────────
export class HouseState {
  constructor() { this.mines = new Map(); this.hilo = new Map(); }

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
    if (!g || g.over || !g.revealed.length) return { error: "Nothing to cash out" };
    const mult = this.minesMult(g, g.revealed.length);
    const bombs = [...g.grid];
    this.mines.delete(uid);
    return { mult, payout: Math.round(g.bet * mult), bombs };
  }
  minesActive(uid) { return this.mines.has(uid); }

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
    if (!g || g.over || g.mult <= 1) return { error: "Nothing to cash out" };
    const payout = Math.round(g.bet * g.mult);
    const mult = g.mult;
    this.hilo.delete(uid);
    return { mult: +mult.toFixed(3), payout };
  }
  hiloActive(uid) { return this.hilo.has(uid); }
}

export const HOUSE_GAMES = [
  { id: "plinko", name: "Plinko", tag: "Drop the ball, chase the multiplier", color: "#a855f7" },
  { id: "mines", name: "Mines", tag: "Dodge the bombs, cash out anytime", color: "#ef4444" },
  { id: "coinflip", name: "Coinflip", tag: "Heads or tails — 1.96×", color: "#eab308" },
  { id: "hilo", name: "HiLo", tag: "Higher or lower, build a streak", color: "#22c55e" },
  { id: "double", name: "Double or Nothing", tag: "All in for 2× — 49%", color: "#3b82f6" },
];
