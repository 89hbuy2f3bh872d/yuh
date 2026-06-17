// SlotEngine — server-authoritative "pay-anywhere + tumble" slot engine.
// Three games, each modelled on a well-known title's playstyle (renamed):
//   candy   → "Candy Cascade"  (Sweet Bonanza style: 6x5, tumble, free-spin multiplier bombs)
//   olympus → "Thunder Gods"   (Gates of Olympus style: 6x5, tumble, multiplier orbs base+free)
//   bandit  → "Wild Bandit"    (Le Bandit style: 5x5, tumble, bonus coin multipliers)
//
// A whole round (base spin + any triggered free spins) is resolved in one call and
// returned as a sequence the client animates. Balance moves once, server-side.

const MUL = "M:"; // multiplier-cell prefix, e.g. "M:50"

function rnd() { return Math.random(); }
function wpick(reel) {
  let t = 0;
  for (let i = 0; i < reel.length; i++) t += reel[i][1];
  let r = rnd() * t;
  for (let i = 0; i < reel.length; i++) { r -= reel[i][1]; if (r <= 0) return reel[i][0]; }
  return reel[reel.length - 1][0];
}
function rollMult(table) {
  // table: [[value, weight], ...]
  let t = 0;
  for (let i = 0; i < table.length; i++) t += table[i][1];
  let r = rnd() * t;
  for (let i = 0; i < table.length; i++) { r -= table[i][1]; if (r <= 0) return table[i][0]; }
  return table[table.length - 1][0];
}

// ── Game definitions ────────────────────────────────────────────────────────
// pays: { symId: [[minCount, xOfTotalBet], ...] } sorted high→low count.
// reel: weighted pay-symbol picker. scatter/mult roll separately per cell.
const GAMES = {
  candy: {
    id: "candy", name: "Candy Cascade", tag: "Tumbling candies · bomb multipliers",
    color: "#ec4899", W: 6, H: 5, minPay: 8, maxWinX: 5000, payScale: 0.38,
    sym: { blue: "🔵", green: "🟢", purple: "🟣", red: "🔴", apple: "🍎", plum: "🫐", grape: "🍇", melon: "🍉" },
    scatter: { id: "SC", emoji: "🍭", chance: 0.028, count: 4, spins: 10, retrigCount: 3, retrigSpins: 5, payX: { 4: 3, 5: 5, 6: 100 } },
    mult: { when: "free", chance: 0.05, emoji: "🍬", table: [[2, 40], [3, 30], [5, 22], [10, 14], [25, 7], [50, 3], [100, 1]] },
    buyX: 60,
    reel: [["blue", 50], ["green", 42], ["purple", 36], ["red", 30], ["apple", 22], ["plum", 16], ["grape", 11], ["melon", 7]],
    pays: {
      blue: [[12, 2], [10, 0.75], [8, 0.25]],
      green: [[12, 2.5], [10, 0.9], [8, 0.4]],
      purple: [[12, 3], [10, 1], [8, 0.5]],
      red: [[12, 4], [10, 1.5], [8, 0.6]],
      apple: [[12, 10], [10, 2], [8, 0.8]],
      plum: [[12, 12], [10, 2.5], [8, 1]],
      grape: [[12, 15], [10, 5], [8, 1.5]],
      melon: [[12, 25], [10, 7.5], [8, 2]],
    },
  },
  olympus: {
    id: "olympus", name: "Thunder Gods", tag: "Multiplier orbs strike anytime",
    color: "#eab308", W: 6, H: 5, minPay: 8, maxWinX: 5000, payScale: 0.27,
    sym: { ring: "💍", glass: "⏳", chalice: "🏺", crown: "👑", blue: "💙", green: "💚", purple: "🔮", red: "❤️" },
    scatter: { id: "SC", emoji: "⚡", chance: 0.026, count: 4, spins: 15, retrigCount: 3, retrigSpins: 5, payX: { 4: 3, 5: 5, 6: 100 } },
    mult: { when: "free", chance: 0.04, emoji: "🪙", table: [[2, 42], [3, 30], [5, 20], [10, 14], [20, 8], [50, 4], [100, 2], [250, 1], [500, 1]] },
    buyX: 95,
    reel: [["ring", 48], ["glass", 42], ["chalice", 36], ["crown", 28], ["blue", 22], ["green", 16], ["purple", 11], ["red", 7]],
    pays: {
      ring: [[12, 2], [10, 0.5], [8, 0.25]],
      glass: [[12, 2.5], [10, 0.75], [8, 0.4]],
      chalice: [[12, 3], [10, 1], [8, 0.5]],
      crown: [[12, 5], [10, 1.5], [8, 0.8]],
      blue: [[12, 8], [10, 2], [8, 1]],
      green: [[12, 10], [10, 2.5], [8, 1.2]],
      purple: [[12, 15], [10, 5], [8, 1.5]],
      red: [[12, 50], [10, 10], [8, 2]],
    },
  },
  bandit: {
    id: "bandit", name: "Wild Bandit", tag: "Heist coins · sticky bonus multipliers",
    color: "#f59e0b", W: 5, H: 5, minPay: 6, maxWinX: 5000, payScale: 0.25,
    sym: { ten: "🔟", j: "🅹", q: "🆀", k: "🅺", a: "🅰️", boot: "👢", hat: "🤠", gun: "🔫", gold: "🪙", bandit: "💰" },
    scatter: { id: "SC", emoji: "⭐", chance: 0.024, count: 3, spins: 10, retrigCount: 3, retrigSpins: 3, payX: { 3: 3, 4: 10, 5: 50 } },
    mult: { when: "free", chance: 0.08, emoji: "💵", table: [[2, 40], [3, 30], [5, 20], [10, 12], [25, 6], [50, 3], [100, 1]] },
    buyX: 30,
    reel: [["ten", 46], ["j", 42], ["q", 38], ["k", 32], ["a", 26], ["boot", 18], ["hat", 13], ["gun", 9], ["gold", 6], ["bandit", 4]],
    pays: {
      ten: [[10, 1.5], [8, 0.4], [6, 0.15]],
      j: [[10, 1.8], [8, 0.5], [6, 0.2]],
      q: [[10, 2], [8, 0.6], [6, 0.25]],
      k: [[10, 2.5], [8, 0.8], [6, 0.3]],
      a: [[10, 3], [8, 1], [6, 0.4]],
      boot: [[10, 5], [8, 1.5], [6, 0.6]],
      hat: [[10, 8], [8, 2], [6, 0.8]],
      gun: [[10, 12], [8, 3], [6, 1]],
      gold: [[10, 20], [8, 5], [6, 1.5]],
      bandit: [[10, 50], [8, 10], [6, 2]],
    },
  },
};

function payIds(cfg) { return Object.keys(cfg.pays); }
function payFor(cfg, sym, count) {
  const tiers = cfg.pays[sym], sc = cfg.payScale || 1;
  for (let i = 0; i < tiers.length; i++) if (count >= tiers[i][0]) return tiers[i][1] * sc;
  return 0;
}

// one cell for a fresh drop / fill
function genCell(cfg, allowScatter, allowMult) {
  if (allowScatter && rnd() < cfg.scatter.chance) return cfg.scatter.id;
  if (allowMult && rnd() < cfg.mult.chance) return MUL + rollMult(cfg.mult.table);
  return wpick(cfg.reel);
}
function genGrid(cfg, free) {
  const n = cfg.W * cfg.H;
  const allowMult = cfg.mult.when === "always" || free;
  const g = new Array(n);
  for (let i = 0; i < n; i++) g[i] = genCell(cfg, true, allowMult);
  return g;
}

function evaluate(cfg, grid, bet) {
  const counts = {};
  for (let i = 0; i < grid.length; i++) { const s = grid[i]; counts[s] = (counts[s] || 0) + 1; }
  const wins = [];
  const ids = payIds(cfg);
  for (let k = 0; k < ids.length; k++) {
    const sym = ids[k];
    const c = counts[sym] || 0;
    if (c >= cfg.minPay) {
      const x = payFor(cfg, sym, c);
      if (x > 0) {
        const positions = [];
        for (let i = 0; i < grid.length; i++) if (grid[i] === sym) positions.push(i);
        wins.push({ sym, emoji: cfg.sym[sym], count: c, x, win: Math.round(x * bet), positions });
      }
    }
  }
  return wins;
}

// remove winning cells, drop survivors, fill the top with fresh cells
function collapse(cfg, grid, removeSet, free) {
  const W = cfg.W, H = cfg.H;
  const allowMult = cfg.mult.when === "always" || free;
  for (let col = 0; col < W; col++) {
    const keep = [];
    for (let row = H - 1; row >= 0; row--) { const idx = row * W + col; if (!removeSet.has(idx)) keep.push(grid[idx]); }
    while (keep.length < H) keep.push(genCell(cfg, false, allowMult)); // no scatter on tumble fills
    for (let row = H - 1, k = 0; row >= 0; row--, k++) grid[row * W + col] = keep[k];
  }
}

function countScatter(cfg, grid) {
  let c = 0; for (let i = 0; i < grid.length; i++) if (grid[i] === cfg.scatter.id) c++; return c;
}
function sumMultipliers(grid) {
  let s = 0;
  for (let i = 0; i < grid.length; i++) { const v = grid[i]; if (typeof v === "string" && v.startsWith(MUL)) s += parseInt(v.slice(MUL.length), 10) || 0; }
  return s;
}

// One spin = a tumble cascade. Returns the step-by-step sequence + totals.
function runSpin(cfg, bet, free) {
  let cur = genGrid(cfg, free);
  const scatters = countScatter(cfg, cur);
  const steps = [];
  let baseWin = 0;
  let guard = 0;
  while (guard++ < 40) {
    const wins = evaluate(cfg, cur, bet);
    if (!wins.length) { steps.push({ grid: cur.slice(), wins: [], stepWin: 0 }); break; }
    let stepWin = 0; const rem = new Set();
    for (const w of wins) { stepWin += w.win; for (const p of w.positions) rem.add(p); }
    baseWin += stepWin;
    steps.push({ grid: cur.slice(), wins, stepWin });
    const next = cur.slice();
    collapse(cfg, next, rem, free);
    cur = next;
  }
  const finalGrid = steps[steps.length - 1].grid;
  const multSum = sumMultipliers(finalGrid);
  // scatter pay (small consolation for landing scatters)
  let scatterWin = 0;
  if (cfg.scatter.payX && cfg.scatter.payX[scatters]) scatterWin = Math.round(cfg.scatter.payX[scatters] * bet);
  let total = baseWin;
  const multApplied = (baseWin > 0 && multSum > 0) ? multSum : 0;
  if (multApplied) total = baseWin * multApplied;
  total += scatterWin;
  return { steps, baseWin, multSum, multApplied, scatterWin, scatters, total: Math.round(total) };
}

// A full round: base spin, then free spins if triggered (or forced via buy).
function runRound(cfg, bet, buy) {
  const spins = [];
  let totalWin = 0;
  let freeLeft = 0;
  let freeTriggered = false;
  let freeAwarded = 0;

  if (buy) {
    freeTriggered = true; freeLeft = cfg.scatter.spins; freeAwarded = cfg.scatter.spins;
  } else {
    const s = runSpin(cfg, bet, false);
    totalWin += s.total;
    const trig = s.scatters >= cfg.scatter.count;
    spins.push(Object.assign({ free: false, triggered: trig }, s));
    if (trig) { freeTriggered = true; freeLeft = cfg.scatter.spins; freeAwarded = cfg.scatter.spins; }
  }

  let guard = 0;
  while (freeTriggered && freeLeft > 0 && guard++ < 300) {
    freeLeft--;
    const s = runSpin(cfg, bet, true);
    totalWin += s.total;
    let retrig = false;
    if (s.scatters >= cfg.scatter.retrigCount) { freeLeft += cfg.scatter.retrigSpins; freeAwarded += cfg.scatter.retrigSpins; retrig = true; }
    spins.push(Object.assign({ free: true, retrigger: retrig, freeLeft }, s));
    if (totalWin > cfg.maxWinX * bet) break;
  }

  if (totalWin > cfg.maxWinX * bet) totalWin = cfg.maxWinX * bet;
  return { spins, totalWin: Math.round(totalWin), freeTriggered, freeAwarded };
}

export function listGames() {
  return Object.values(GAMES).map(g => {
    const sc = g.payScale || 1;
    const pays = {};
    for (const k of Object.keys(g.pays)) pays[k] = g.pays[k].map(t => [t[0], Math.round(t[1] * sc * 100) / 100]);
    return {
      id: g.id, name: g.name, tag: g.tag, color: g.color, W: g.W, H: g.H,
      minPay: g.minPay, buyX: g.buyX, sym: g.sym,
      scatter: { emoji: g.scatter.emoji, count: g.scatter.count, spins: g.scatter.spins },
      mult: { emoji: g.mult.emoji, when: g.mult.when },
      pays,
    };
  });
}
export function getGame(id) { return GAMES[id] || null; }

// Public: resolve a spin/round. bet is total bet (already validated/affordable).
export function spin(id, bet, buy) {
  const cfg = GAMES[id];
  if (!cfg) throw new Error("Unknown game");
  return runRound(cfg, bet, !!buy);
}
export const SLOT_GAME_IDS = Object.keys(GAMES);
