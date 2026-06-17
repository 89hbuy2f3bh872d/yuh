// SlotEngine — cluster-pays tumbling slots (orthogonal clusters of 5+, no diagonals).
// Two bonus types:
//   regular → free spins, per-spin multipliers apply to that spin only
//   super   → more free spins + a GLOBAL multiplier that accumulates every time an
//             x-symbol lands and multiplies every win for the rest of the bonus
// Whole round resolved server-side; client animates. Target RTP ≈ 87% (base via
// payScale; buy costs priced off measured bonus EV so buy RTP ≈ 87% too).

const MUL = "M:";
function rnd() { return Math.random(); }
function wpick(reel) { let t = 0; for (let i = 0; i < reel.length; i++) t += reel[i][1]; let r = rnd() * t; for (let i = 0; i < reel.length; i++) { r -= reel[i][1]; if (r <= 0) return reel[i][0]; } return reel[reel.length - 1][0]; }
function rollMult(table) { let t = 0; for (let i = 0; i < table.length; i++) t += table[i][1]; let r = rnd() * t; for (let i = 0; i < table.length; i++) { r -= table[i][1]; if (r <= 0) return table[i][0]; } return table[table.length - 1][0]; }

const TIERS = [
  // [minClusterSize, xOfTotalBet] — applied to each rank multiplier below
  [15, 1], [10, 1], [8, 1], [5, 1],
];
// per-rank base pay for cluster sizes {5+,8+,10+,15+}; multiplied by payScale.
function payRows(a, b, c, d) { return [[15, d], [10, c], [8, b], [5, a]]; }

const GAMES = {
  candy: {
    id: "candy", name: "Candy Cascade", tag: "Cluster pays · tumbling candies", color: "#ec4899",
    W: 6, H: 5, minCluster: 5, maxWinX: 5000, payScale: 2.05,
    sym: { blue: "🔵", green: "🟢", purple: "🟣", red: "🔴", apple: "🍎", grape: "🍇", melon: "🍉" },
    reel: [["blue", 46], ["green", 40], ["purple", 34], ["red", 28], ["apple", 20], ["grape", 13], ["melon", 8]],
    pays: {
      blue: payRows(0.2, 0.5, 1.0, 2.5), green: payRows(0.25, 0.6, 1.2, 3),
      purple: payRows(0.3, 0.8, 1.6, 4), red: payRows(0.4, 1.0, 2.2, 6),
      apple: payRows(0.6, 1.5, 3, 10), grape: payRows(0.9, 2.2, 5, 15), melon: payRows(1.5, 4, 9, 25),
    },
    scatter: { id: "SC", emoji: "🍭", chance: 0.0263, count: 4, regular: 12, super: 18, retrig: 3, retrigAdd: 5, payX: { 4: 3, 5: 5, 6: 100 } },
    mult: { emoji: "🍬", chance: 0.12, table: [[2, 36], [3, 27], [5, 18], [10, 12], [25, 7], [50, 3], [100, 2], [250, 1]] },
  },
  olympus: {
    id: "olympus", name: "Thunder Gods", tag: "Cluster pays · global multiplier bonus", color: "#eab308",
    W: 6, H: 5, minCluster: 5, maxWinX: 5000, payScale: 2.0,
    sym: { ring: "💍", glass: "⏳", chalice: "🏺", crown: "👑", blue: "💙", green: "💚", red: "❤️" },
    reel: [["ring", 46], ["glass", 40], ["chalice", 34], ["crown", 27], ["blue", 20], ["green", 13], ["red", 8]],
    pays: {
      ring: payRows(0.2, 0.5, 1, 2.5), glass: payRows(0.25, 0.6, 1.2, 3),
      chalice: payRows(0.3, 0.8, 1.6, 4), crown: payRows(0.45, 1.1, 2.4, 7),
      blue: payRows(0.6, 1.5, 3, 10), green: payRows(0.9, 2.4, 5.5, 16), red: payRows(1.6, 4.5, 10, 30),
    },
    scatter: { id: "SC", emoji: "⚡", chance: 0.0252, count: 4, regular: 14, super: 20, retrig: 3, retrigAdd: 5, payX: { 4: 3, 5: 5, 6: 100 } },
    mult: { emoji: "🪙", chance: 0.125, table: [[2, 40], [3, 28], [5, 19], [10, 12], [20, 8], [50, 4], [100, 2], [250, 1]] },
  },
  bandit: {
    id: "bandit", name: "Wild Bandit", tag: "Cluster pays · heist multipliers", color: "#f59e0b",
    W: 5, H: 5, minCluster: 5, maxWinX: 5000, payScale: 1.45,
    sym: { ten: "🔟", j: "🅹", q: "🆀", k: "🅺", a: "🅰️", gold: "🪙", bandit: "💰" },
    reel: [["ten", 44], ["j", 40], ["q", 34], ["k", 28], ["a", 21], ["gold", 13], ["bandit", 8]],
    pays: {
      ten: payRows(0.25, 0.6, 1.2, 3), j: payRows(0.3, 0.7, 1.4, 3.5), q: payRows(0.35, 0.9, 1.8, 4.5),
      k: payRows(0.45, 1.1, 2.4, 6), a: payRows(0.6, 1.5, 3.2, 9), gold: payRows(1, 2.6, 6, 18), bandit: payRows(1.8, 5, 11, 32),
    },
    scatter: { id: "SC", emoji: "⭐", chance: 0.0222, count: 3, regular: 12, super: 18, retrig: 3, retrigAdd: 4, payX: { 3: 3, 4: 10, 5: 50 } },
    mult: { emoji: "💵", chance: 0.16, table: [[2, 36], [3, 27], [5, 18], [10, 12], [25, 7], [50, 3], [100, 2], [250, 1]] },
  },
};

function payIds(cfg) { return Object.keys(cfg.pays); }
function payFor(cfg, sym, size) { const t = cfg.pays[sym], sc = cfg.payScale || 1; for (let i = 0; i < t.length; i++) if (size >= t[i][0]) return t[i][1] * sc; return 0; }
function isMul(s) { return typeof s === "string" && s.startsWith(MUL); }
function mulVal(s) { return parseInt(s.slice(MUL.length), 10) || 0; }

// cell generators
function genCell(cfg, allowScatter, allowMult) {
  if (allowScatter && rnd() < cfg.scatter.chance) return cfg.scatter.id;
  if (allowMult && rnd() < cfg.mult.chance) return MUL + rollMult(cfg.mult.table);
  return wpick(cfg.reel);
}
function genGrid(cfg, allowMult) { const n = cfg.W * cfg.H, g = new Array(n); for (let i = 0; i < n; i++) g[i] = genCell(cfg, true, allowMult); return g; }

// orthogonal flood-fill clusters of identical pay symbols, size >= minCluster
function evaluate(cfg, grid, bet) {
  const W = cfg.W, H = cfg.H, n = W * H, seen = new Array(n).fill(false), wins = [];
  for (let i = 0; i < n; i++) {
    const s = grid[i];
    if (seen[i] || isMul(s) || s === cfg.scatter.id || !cfg.pays[s]) continue;
    // BFS
    const stack = [i], cells = []; seen[i] = true;
    while (stack.length) {
      const c = stack.pop(); cells.push(c);
      const r = (c / W) | 0, col = c % W;
      const nb = [];
      if (r > 0) nb.push(c - W); if (r < H - 1) nb.push(c + W);
      if (col > 0) nb.push(c - 1); if (col < W - 1) nb.push(c + 1);
      for (const k of nb) if (!seen[k] && grid[k] === s) { seen[k] = true; stack.push(k); }
    }
    if (cells.length >= cfg.minCluster) {
      const x = payFor(cfg, s, cells.length);
      if (x > 0) wins.push({ sym: s, emoji: cfg.sym[s], size: cells.length, positions: cells, win: Math.round(x * bet) });
    }
  }
  return wins;
}

function collapse(cfg, grid, rem, allowMult) {
  const W = cfg.W, H = cfg.H;
  for (let col = 0; col < W; col++) {
    const keep = [];
    for (let row = H - 1; row >= 0; row--) { const idx = row * W + col; if (!rem.has(idx)) keep.push(grid[idx]); }
    while (keep.length < H) keep.push(genCell(cfg, false, allowMult)); // no scatter on refills
    for (let row = H - 1, k = 0; row >= 0; row--, k++) grid[row * W + col] = keep[k];
  }
}
function countScatter(cfg, grid) { let c = 0; for (let i = 0; i < grid.length; i++) if (grid[i] === cfg.scatter.id) c++; return c; }
function gridMultCells(grid) { const a = []; for (let i = 0; i < grid.length; i++) if (isMul(grid[i])) a.push({ pos: i, val: mulVal(grid[i]) }); return a; }

// One cascade. allowMult = multipliers can appear (bonus only).
function runSpin(cfg, bet, allowMult) {
  let cur = genGrid(cfg, allowMult);
  const scatters = countScatter(cfg, cur);
  const steps = [];
  let baseWin = 0, guard = 0;
  while (guard++ < 40) {
    const wins = evaluate(cfg, cur, bet);
    if (!wins.length) { steps.push({ grid: cur.slice(), wins: [], stepWin: 0 }); break; }
    let stepWin = 0; const rem = new Set();
    for (const w of wins) { stepWin += w.win; for (const p of w.positions) rem.add(p); }
    baseWin += stepWin;
    steps.push({ grid: cur.slice(), wins, stepWin });
    const next = cur.slice(); collapse(cfg, next, rem, allowMult); cur = next;
  }
  const finalGrid = steps[steps.length - 1].grid;
  const mults = gridMultCells(finalGrid);
  let scatterWin = 0;
  if (cfg.scatter.payX && cfg.scatter.payX[scatters]) scatterWin = Math.round(cfg.scatter.payX[scatters] * bet);
  return { steps, baseWin, mults, scatters, scatterWin, finalGrid };
}

// mode: 'base' | 'regular' | 'super'. buy forces straight into a bonus.
function runRound(cfg, bet, buy) {
  const spins = [];
  let totalWin = 0, freeTriggered = false, freeAwarded = 0, freeLeft = 0, mode = "base";
  let globalMult = 1;

  function pushBase() {
    const s = runSpin(cfg, bet, false);
    let total = s.baseWin + s.scatterWin;
    totalWin += total;
    const trig = s.scatters >= cfg.scatter.count;
    spins.push({ free: false, super: false, steps: s.steps, baseWin: s.baseWin, mults: [], multApplied: 0, scatterWin: s.scatterWin, scatters: s.scatters, total, triggered: trig });
    return trig;
  }

  if (buy === "super") { mode = "super"; freeTriggered = true; freeLeft = cfg.scatter.super; freeAwarded = freeLeft; }
  else if (buy === "regular") { mode = "regular"; freeTriggered = true; freeLeft = cfg.scatter.regular; freeAwarded = freeLeft; }
  else {
    if (pushBase()) { mode = "regular"; freeTriggered = true; freeLeft = cfg.scatter.regular; freeAwarded = freeLeft; }
  }

  let guard = 0;
  while (freeTriggered && freeLeft > 0 && guard++ < 400) {
    freeLeft--;
    const s = runSpin(cfg, bet, true);
    const multSum = s.mults.reduce((a, m) => a + m.val, 0);
    let total, applied = 0, added = 0;
    if (mode === "super") {
      // X only counts toward the global multiplier when this spin actually HIT
      // (a winning cluster) AND an x landed.
      if (s.baseWin > 0 && multSum > 0) { globalMult += multSum; added = multSum; }
      applied = globalMult;
      total = (s.baseWin > 0 ? s.baseWin * globalMult : 0) + s.scatterWin;
    } else {
      applied = (s.baseWin > 0 && multSum > 0) ? multSum : 0;     // per-spin only
      total = (applied ? s.baseWin * applied : s.baseWin) + s.scatterWin;
    }
    totalWin += total;
    let retrig = false;
    if (s.scatters >= cfg.scatter.retrig) { freeLeft += cfg.scatter.retrigAdd; freeAwarded += cfg.scatter.retrigAdd; retrig = true; }
    spins.push({ free: true, super: mode === "super", steps: s.steps, baseWin: s.baseWin, mults: s.mults, multApplied: applied, multAdded: added, globalMult: mode === "super" ? globalMult : 0, scatterWin: s.scatterWin, scatters: s.scatters, total: Math.round(total), retrigger: retrig, freeLeft });
    if (totalWin > cfg.maxWinX * bet) break;
  }

  if (totalWin > cfg.maxWinX * bet) totalWin = cfg.maxWinX * bet;
  return { spins, totalWin: Math.round(totalWin), freeTriggered, freeAwarded, mode };
}

export function listGames() {
  return Object.values(GAMES).map(g => {
    const sc = g.payScale || 1, pays = {};
    for (const k of Object.keys(g.pays)) pays[k] = g.pays[k].map(t => [t[0], Math.round(t[1] * sc * 100) / 100]);
    return {
      id: g.id, name: g.name, tag: g.tag, color: g.color, W: g.W, H: g.H, minCluster: g.minCluster,
      sym: g.sym, pays,
      scatter: { emoji: g.scatter.emoji, count: g.scatter.count, regular: g.scatter.regular, super: g.scatter.super },
      mult: { emoji: g.mult.emoji },
      buy: { regular: g.buyRegular, super: g.buySuper },
    };
  });
}
export function getGame(id) { return GAMES[id] || null; }
export function spin(id, bet, buy) {
  const cfg = GAMES[id]; if (!cfg) throw new Error("Unknown game");
  const b = buy === "super" ? "super" : (buy === "regular" ? "regular" : false);
  return runRound(cfg, bet, b);
}
// buy costs (×bet) — assigned at load by tuning below.
export function buyCost(id, kind) { const cfg = GAMES[id]; if (!cfg) return Infinity; return kind === "super" ? cfg.buySuper : cfg.buyRegular; }
export const SLOT_GAME_IDS = Object.keys(GAMES);

// ── Auto-price buy bonuses so their RTP ≈ 87% (E[payout]/0.87). Runs once at load
//    with a quick Monte-Carlo; cheap enough (~40k spins/game/kind).
(function priceBuys() {
  const TARGET = 0.87, N = 30000, bet = 20;
  for (const id of SLOT_GAME_IDS) {
    const cfg = GAMES[id];
    for (const kind of ["regular", "super"]) {
      let sum = 0;
      for (let i = 0; i < N; i++) sum += runRound(cfg, bet, kind).totalWin;
      const avgX = (sum / N) / bet;             // avg bonus payout in bet-multiples
      const cost = Math.max(5, Math.round(avgX / TARGET));
      if (kind === "super") cfg.buySuper = cost; else cfg.buyRegular = cost;
    }
  }
})();
