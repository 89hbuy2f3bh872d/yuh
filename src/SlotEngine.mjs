// SlotEngine — cluster-pays tumbling slots (orthogonal clusters of 5+, no diagonals).
// Scatter triggers (by count on the triggering grid):
//   3 → Regular bonus (per-spin multipliers)
//   4 → Super bonus  (global multiplier, applied to the whole bonus at the end)
//   5 → Hidden bonus (overpowered Super — more spins + boosted multipliers; NOT buyable)
// Retriggers inside a bonus: 3 scatters +2 spins, 4 +4, 5 +6 (rare).
// Whole round resolved server-side; client animates. Base/buy RTP ≈ 87%.

const MUL = "M:";
function rnd() { return Math.random(); }
function wpick(reel) { let t = 0; for (let i = 0; i < reel.length; i++) t += reel[i][1]; let r = rnd() * t; for (let i = 0; i < reel.length; i++) { r -= reel[i][1]; if (r <= 0) return reel[i][0]; } return reel[reel.length - 1][0]; }
function rollMult(table) { let t = 0; for (let i = 0; i < table.length; i++) t += table[i][1]; let r = rnd() * t; for (let i = 0; i < table.length; i++) { r -= table[i][1]; if (r <= 0) return table[i][0]; } return table[table.length - 1][0]; }

// per-rank base pay for cluster sizes {5+,8+,10+,15+}; multiplied by payScale.
function payRows(a, b, c, d) { return [[15, d], [10, c], [8, b], [5, a]]; }

const TRIG = { regular: 3, super: 4, hidden: 5 }; // scatters needed
const SPINS = { regular: 8, super: 12, hidden: 15 };
const HIDDEN_BOOST = 1.7; // hidden bonus multiplier-symbol frequency boost

const GAMES = {
  candy: {
    id: "candy", name: "Candy Cascade", tag: "Cluster pays · tumbling candies", color: "#ec4899",
    W: 6, H: 5, minCluster: 5, maxWinX: 5000, payScale: 1.13,
    sym: { blue: "🔵", green: "🟢", purple: "🟣", red: "🔴", apple: "🍎", grape: "🍇", melon: "🍉" },
    reel: [["blue", 60], ["green", 52], ["purple", 44], ["red", 26], ["apple", 16], ["grape", 9], ["melon", 5]],
    pays: {
      blue: payRows(0.2, 0.5, 1.0, 2.5), green: payRows(0.25, 0.6, 1.2, 3),
      purple: payRows(0.3, 0.8, 1.6, 4), red: payRows(0.4, 1.0, 2.2, 6),
      apple: payRows(0.6, 1.5, 3, 10), grape: payRows(0.9, 2.2, 5, 15), melon: payRows(1.5, 4, 9, 25),
    },
    scatter: { id: "SC", emoji: "🍭", chance: 0.0163, payX: { 3: 2, 4: 5, 5: 20, 6: 100 } },
    mult: { emoji: "🍬", chance: 0.11, table: [[2, 42], [3, 30], [5, 15], [10, 7], [25, 3], [50, 1.2], [100, 0.5], [250, 0.15]] },
  },
  olympus: {
    id: "olympus", name: "Thunder Gods", tag: "Cluster pays · global multiplier bonus", color: "#eab308",
    W: 6, H: 5, minCluster: 5, maxWinX: 5000, payScale: 1.10,
    sym: { ring: "💍", glass: "⏳", chalice: "🏺", crown: "👑", blue: "💙", green: "💚", red: "❤️" },
    reel: [["ring", 60], ["glass", 52], ["chalice", 44], ["crown", 25], ["blue", 16], ["green", 9], ["red", 5]],
    pays: {
      ring: payRows(0.2, 0.5, 1, 2.5), glass: payRows(0.25, 0.6, 1.2, 3),
      chalice: payRows(0.3, 0.8, 1.6, 4), crown: payRows(0.45, 1.1, 2.4, 7),
      blue: payRows(0.6, 1.5, 3, 10), green: payRows(0.9, 2.4, 5.5, 16), red: payRows(1.6, 4.5, 10, 30),
    },
    scatter: { id: "SC", emoji: "⚡", chance: 0.0163, payX: { 3: 2, 4: 5, 5: 20, 6: 100 } },
    mult: { emoji: "🪙", chance: 0.115, table: [[2, 42], [3, 30], [5, 15], [10, 7], [20, 3.5], [50, 1.3], [100, 0.55], [250, 0.18]] },
  },
  bandit: {
    id: "bandit", name: "Wild Bandit", tag: "Cluster pays · heist multipliers", color: "#f59e0b",
    W: 5, H: 5, minCluster: 5, maxWinX: 5000, payScale: 1.96,
    sym: { ten: "🔟", j: "🅹", q: "🆀", k: "🅺", a: "🅰️", gold: "🪙", bandit: "💰" },
    reel: [["ten", 58], ["j", 50], ["q", 42], ["k", 26], ["a", 16], ["gold", 9], ["bandit", 5]],
    pays: {
      ten: payRows(0.25, 0.6, 1.2, 3), j: payRows(0.3, 0.7, 1.4, 3.5), q: payRows(0.35, 0.9, 1.8, 4.5),
      k: payRows(0.45, 1.1, 2.4, 6), a: payRows(0.6, 1.5, 3.2, 9), gold: payRows(1, 2.6, 6, 18), bandit: payRows(1.8, 5, 11, 32),
    },
    scatter: { id: "SC", emoji: "⭐", chance: 0.018, payX: { 3: 2, 4: 6, 5: 25, 6: 120 } },
    mult: { emoji: "💵", chance: 0.15, table: [[2, 42], [3, 30], [5, 15], [10, 7], [25, 3], [50, 1.2], [100, 0.5], [250, 0.15]] },
  },
};

function payFor(cfg, sym, size) { const t = cfg.pays[sym], sc = cfg.payScale || 1; for (let i = 0; i < t.length; i++) if (size >= t[i][0]) return t[i][1] * sc; return 0; }
function isMul(s) { return typeof s === "string" && s.startsWith(MUL); }
function mulVal(s) { return parseInt(s.slice(MUL.length), 10) || 0; }

function genCell(cfg, allowScatter, allowMult, boost) {
  if (allowScatter && rnd() < cfg.scatter.chance) return cfg.scatter.id;
  if (allowMult && rnd() < cfg.mult.chance * (boost || 1)) return MUL + rollMult(cfg.mult.table);
  return wpick(cfg.reel);
}
function genGrid(cfg, allowMult, boost) { const n = cfg.W * cfg.H, g = new Array(n); for (let i = 0; i < n; i++) g[i] = genCell(cfg, true, allowMult, boost); return g; }

// orthogonal flood-fill clusters of identical pay symbols, size >= minCluster
function evaluate(cfg, grid, bet) {
  const W = cfg.W, H = cfg.H, n = W * H, seen = new Array(n).fill(false), wins = [];
  for (let i = 0; i < n; i++) {
    const s = grid[i];
    if (seen[i] || isMul(s) || s === cfg.scatter.id || !cfg.pays[s]) continue;
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

function collapse(cfg, grid, rem, allowMult, boost) {
  const W = cfg.W, H = cfg.H;
  for (let col = 0; col < W; col++) {
    const keep = [];
    for (let row = H - 1; row >= 0; row--) { const idx = row * W + col; if (!rem.has(idx)) keep.push(grid[idx]); }
    while (keep.length < H) keep.push(genCell(cfg, false, allowMult, boost)); // no scatter on refills
    for (let row = H - 1, k = 0; row >= 0; row--, k++) grid[row * W + col] = keep[k];
  }
}
function countScatter(cfg, grid) { let c = 0; for (let i = 0; i < grid.length; i++) if (grid[i] === cfg.scatter.id) c++; return c; }
function gridMultCells(grid) { const a = []; for (let i = 0; i < grid.length; i++) if (isMul(grid[i])) a.push({ pos: i, val: mulVal(grid[i]) }); return a; }

function runSpin(cfg, bet, allowMult, boost) {
  let cur = genGrid(cfg, allowMult, boost);
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
    const next = cur.slice(); collapse(cfg, next, rem, allowMult, boost); cur = next;
  }
  const mults = gridMultCells(steps[steps.length - 1].grid);
  let scatterWin = 0;
  const sc = scatters >= 6 ? 6 : scatters;
  if (cfg.scatter.payX && cfg.scatter.payX[sc]) scatterWin = Math.round(cfg.scatter.payX[sc] * bet);
  return { steps, baseWin, mults, scatters, scatterWin };
}

function modeForScatters(n) { if (n >= TRIG.hidden) return "hidden"; if (n === TRIG.super) return "super"; if (n >= TRIG.regular) return "regular"; return null; }
function retrigFor(n) { if (n >= 5) return 6; if (n === 4) return 4; if (n === 3) return 2; return 0; }

// mode: 'base' | 'regular' | 'super' | 'hidden'. buy forces 'regular' or 'super' only.
function runRound(cfg, bet, buy) {
  const spins = [];
  let totalWin = 0, mode = "base", freeLeft = 0, freeAwarded = 0, freeTriggered = false;
  let globalMult = 1, superSum = 0;

  if (buy === "super") { mode = "super"; }
  else if (buy === "regular") { mode = "regular"; }
  else {
    const s = runSpin(cfg, bet, false, 1);
    totalWin += s.baseWin + s.scatterWin;
    const m = modeForScatters(s.scatters);
    spins.push({ free: false, super: false, steps: s.steps, baseWin: s.baseWin, mults: [], multAdded: 0, scatterWin: s.scatterWin, scatters: s.scatters, total: s.baseWin + s.scatterWin, triggered: !!m });
    mode = m || "base";
  }

  if (mode !== "base") { freeTriggered = true; freeLeft = SPINS[mode]; freeAwarded = freeLeft; }
  const useGlobal = mode === "super" || mode === "hidden";
  const boost = mode === "hidden" ? HIDDEN_BOOST : 1;

  let guard = 0;
  while (freeTriggered && freeLeft > 0 && guard++ < 500) {
    freeLeft--;
    const s = runSpin(cfg, bet, true, boost);
    // Every multiplier symbol on the board counts on a winning spin, regardless of
    // where it sits (they all survive the tumble to the final grid). Super/Hidden
    // accrue them into the global multiplier (applied at the end); Regular multiplies
    // that spin's win immediately.
    const multSum = s.mults.reduce((a, m) => a + m.val, 0);
    let displayTotal = 0, added = 0, applied = 0;
    if (useGlobal) {
      if (s.baseWin > 0 && multSum > 0) { globalMult += multSum; added = multSum; }
      displayTotal = s.baseWin + s.scatterWin;     // shown pre-global; multiplied at the end
      superSum += displayTotal;
    } else {
      applied = (s.baseWin > 0 && multSum > 0) ? multSum : 0;
      displayTotal = (applied ? s.baseWin * applied : s.baseWin) + s.scatterWin;
      totalWin += displayTotal;
    }
    const rt = retrigFor(s.scatters);
    if (rt) { freeLeft += rt; freeAwarded += rt; }
    spins.push({ free: true, super: useGlobal, steps: s.steps, baseWin: s.baseWin, mults: (useGlobal ? added : applied) > 0 ? s.mults : [], multAdded: added, multApplied: applied, globalMult: useGlobal ? globalMult : 0, scatterWin: s.scatterWin, scatters: s.scatters, total: Math.round(displayTotal), retrigger: rt, freeLeft });
    if (!useGlobal && totalWin > cfg.maxWinX * bet) break;
  }

  let superMult = 1, superPre = 0;
  if (useGlobal) { superMult = globalMult; superPre = Math.round(superSum); totalWin += superSum * globalMult; }
  if (totalWin > cfg.maxWinX * bet) totalWin = cfg.maxWinX * bet;
  return { spins, totalWin: Math.round(totalWin), freeTriggered, freeAwarded, mode, superMult, superPre };
}

export function listGames() {
  return Object.values(GAMES).map(g => {
    const sc = g.payScale || 1, pays = {};
    for (const k of Object.keys(g.pays)) pays[k] = g.pays[k].map(t => [t[0], Math.round(t[1] * sc * 100) / 100]);
    return {
      id: g.id, name: g.name, tag: g.tag, color: g.color, W: g.W, H: g.H, minCluster: g.minCluster,
      sym: g.sym, pays,
      scatter: { emoji: g.scatter.emoji, regular: TRIG.regular, super: TRIG.super, hidden: TRIG.hidden, spins: SPINS },
      mult: { emoji: g.mult.emoji },
      buy: { regular: g.buyRegular, super: g.buySuper },
    };
  });
}
export function getGame(id) { return GAMES[id] || null; }
export function spin(id, bet, buy) {
  const cfg = GAMES[id]; if (!cfg) throw new Error("Unknown game");
  const b = buy === "super" ? "super" : (buy === "regular" ? "regular" : false); // hidden not buyable
  return runRound(cfg, bet, b);
}
export function buyCost(id, kind) { const cfg = GAMES[id]; if (!cfg) return Infinity; return kind === "super" ? cfg.buySuper : cfg.buyRegular; }
export const SLOT_GAME_IDS = Object.keys(GAMES);

// Auto-price buy bonuses so their RTP ≈ 87% (E[payout]/0.87). Runs once at load.
(function priceBuys() {
  const TARGET = 0.87, N = 30000, bet = 20;
  for (const id of SLOT_GAME_IDS) {
    const cfg = GAMES[id];
    for (const kind of ["regular", "super"]) {
      let sum = 0;
      for (let i = 0; i < N; i++) sum += runRound(cfg, bet, kind).totalWin;
      const avgX = (sum / N) / bet;
      const cost = Math.max(5, Math.round(avgX / TARGET));
      if (kind === "super") cfg.buySuper = cost; else cfg.buyRegular = cost;
    }
  }
})();
