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
    W: 6, H: 5, minCluster: 5, maxWinX: 5000, payScale: 0.995,
    sym: { blue: "🔵", green: "🟢", purple: "🟣", red: "🔴", apple: "🍎", grape: "🍇", melon: "🍉" },
    reel: [["blue", 90], ["green", 68], ["purple", 50], ["red", 26], ["apple", 14], ["grape", 8], ["melon", 4]],
    pays: {
      blue: payRows(0.2, 0.5, 1.0, 2.5), green: payRows(0.25, 0.6, 1.2, 3),
      purple: payRows(0.3, 0.8, 1.6, 4), red: payRows(0.4, 1.0, 2.2, 6),
      apple: payRows(0.6, 1.5, 3, 10), grape: payRows(0.9, 2.2, 5, 15), melon: payRows(1.5, 4, 9, 25),
    },
    scatter: { id: "SC", emoji: "🍭", chance: 0.0163, payX: { 3: 2, 4: 5, 5: 20, 6: 100 } },
    mult: { emoji: "🍬", chance: 0.17, table: [[2, 52], [3, 34], [5, 11], [10, 3], [25, 0.9]] },
  },
  olympus: {
    id: "olympus", name: "Thunder Gods", tag: "Cluster pays · global multiplier bonus", color: "#eab308",
    W: 6, H: 5, minCluster: 5, maxWinX: 5000, payScale: 1.01,
    sym: { ring: "💍", glass: "⏳", chalice: "🏺", crown: "👑", blue: "💙", green: "💚", red: "❤️" },
    reel: [["ring", 90], ["glass", 68], ["chalice", 50], ["crown", 26], ["blue", 14], ["green", 8], ["red", 4]],
    pays: {
      ring: payRows(0.2, 0.5, 1, 2.5), glass: payRows(0.25, 0.6, 1.2, 3),
      chalice: payRows(0.3, 0.8, 1.6, 4), crown: payRows(0.45, 1.1, 2.4, 7),
      blue: payRows(0.6, 1.5, 3, 10), green: payRows(0.9, 2.4, 5.5, 16), red: payRows(1.6, 4.5, 10, 30),
    },
    scatter: { id: "SC", emoji: "⚡", chance: 0.0163, payX: { 3: 2, 4: 5, 5: 20, 6: 100 } },
    mult: { emoji: "🪙", chance: 0.17, table: [[2, 52], [3, 34], [5, 11], [10, 3], [25, 0.9]] },
  },
  bandit: {
    id: "bandit", name: "Wild Bandit", tag: "Cluster pays · Golden Squares & Rainbow", color: "#f59e0b",
    engine: "bandit",
    W: 6, H: 5, minCluster: 5, maxWinX: 10000, payScale: 1.0,
    sym: { clover: "🍀", coin: "🪙", gem: "💎", key: "🗝️", sack: "💰", crown: "👑", raccoon: "🦝" },
    reel: [["clover", 100], ["coin", 74], ["gem", 50], ["key", 28], ["sack", 15], ["crown", 7], ["raccoon", 3]],
    pays: {
      clover: payRows(0.2, 0.5, 1, 2.5), coin: payRows(0.25, 0.6, 1.2, 3), gem: payRows(0.3, 0.8, 1.6, 4),
      key: payRows(0.45, 1.1, 2.4, 6), sack: payRows(0.7, 1.8, 4, 11), crown: payRows(1.2, 3, 7, 20), raccoon: payRows(2.5, 6, 14, 40),
    },
    // Camera scatter triggers free spins: 3 → Luck, 4 → All That Glitters Is Gold, 5 → Treasure (Rainbow)
    scatter: { id: "SC", emoji: "📷", chance: 0.0145, payX: { 3: 1, 4: 3, 5: 10, 6: 50 } },
    // Rainbow symbol lands on the grid and activates stored Golden Squares (reveals coins)
    rainbow: { id: "RB", emoji: "🌈", chance: 0.011 },
    // Coin reveal bands (value in bet-multiples) when a Rainbow activates a Golden Square.
    // Per-reveal EV ~0.08x: a base spin's Rainbow activates ~7-15 accumulated squares →
    // ~1x; across the bonus this keeps coin RTP sane while Silver/Gold stay exciting.
    // tier: label; w: relative weight; lo/hi: payout band in x-bet.
    coins: [
      { tier: "bronze", w: 1000, lo: 0.02, hi: 0.12 },
      { tier: "silver", w: 40, lo: 0.5, hi: 2 },
      { tier: "gold", w: 1.5, lo: 5, hi: 50 },
    ],
    // Free-spin tiers by camera count
    tiers: { 3: { mode: "luck", spins: 8 }, 4: { mode: "gold", spins: 12 }, 5: { mode: "rainbow", spins: 12 } },
    // Paid feature entries (mult = cost in stake multiples)
    buys: [
      { id: "feature", label: "FeatureSpins", top: "Bonus Hunt", mult: 3 },
      { id: "rainbow", label: "Rainbow Spins", top: "Guaranteed 🌈", mult: 50 },
      { id: "luck", label: "Luck of the Bandit", top: "Buy · 8 spins", mult: 100 },
      { id: "gold", label: "All That Glitters", top: "Buy · 12 spins", mult: 250 },
    ],
  },
};

function payFor(cfg, sym, size) { const t = cfg.pays[sym], sc = cfg.payScale || 1; for (let i = 0; i < t.length; i++) if (size >= t[i][0]) return t[i][1] * sc; return 0; }
function isMul(s) { return typeof s === "string" && s.startsWith(MUL); }
function mulVal(s) { return parseInt(s.slice(MUL.length), 10) || 0; }

function genCell(cfg, allowScatter, allowMult, boost) {
  if (allowScatter && rnd() < cfg.scatter.chance) return cfg.scatter.id;
  if (allowMult && cfg.mult && rnd() < cfg.mult.chance * (boost || 1)) return MUL + rollMult(cfg.mult.table);
  // Bandit-only: Rainbow symbol (activates Golden Squares). Not spawned during base
  // cascades (only on initial grids); forced separately when a tier guarantees one.
  if (allowMult && cfg.rainbow && rnd() < cfg.rainbow.chance) return cfg.rainbow.id;
  return wpick(cfg.reel);
}
function genGrid(cfg, allowMult, boost) { const n = cfg.W * cfg.H, g = new Array(n); for (let i = 0; i < n; i++) g[i] = genCell(cfg, true, allowMult, boost); return g; }

// orthogonal flood-fill clusters of identical pay symbols, size >= minCluster
function evaluate(cfg, grid, bet) {
  const W = cfg.W, H = cfg.H, n = W * H, seen = new Array(n).fill(false), wins = [];
  const isRB = cfg.rainbow && cfg.rainbow.id;
  for (let i = 0; i < n; i++) {
    const s = grid[i];
    if (seen[i] || isMul(s) || s === cfg.scatter.id || (isRB && s === isRB) || !cfg.pays[s]) continue;
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
function findRainbow(cfg, grid) { for (let i = 0; i < grid.length; i++) if (grid[i] === cfg.rainbow.id) return i; return -1; }
function gridMultCells(grid) { const a = []; for (let i = 0; i < grid.length; i++) if (isMul(grid[i])) a.push({ pos: i, val: mulVal(grid[i]) }); return a; }
// Replace every multiplier cell with a normal reel symbol that differs from its orthogonal
// neighbours (so it can't look like a cluster — the client renders server-provided wins and
// never re-evaluates). Used to hide multipliers on spins that produced no win.
function stripMults(cfg, grid) {
  const W = cfg.W, H = cfg.H;
  for (let i = 0; i < grid.length; i++) {
    if (!isMul(grid[i])) continue;
    const r = (i / W) | 0, col = i % W, neigh = new Set();
    if (r > 0) neigh.add(grid[i - W]); if (r < H - 1) neigh.add(grid[i + W]);
    if (col > 0) neigh.add(grid[i - 1]); if (col < W - 1) neigh.add(grid[i + 1]);
    let sym, t = 0; do { sym = wpick(cfg.reel); } while (neigh.has(sym) && ++t < 20);
    grid[i] = sym;
  }
}

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
  // A multiplier only counts on a WINNING spin (placement irrelevant — they survive the
  // tumble to the final grid). If this spin produced no win, its multipliers are worthless,
  // so hide them: the player then only ever SEES multipliers on spins that collect them →
  // the global climbs every single time a multiplier is visible. Display-only; doesn't
  // change which multipliers count, so RTP is unchanged.
  if (allowMult && baseWin === 0) for (const st of steps) stripMults(cfg, st.grid);
  const mults = baseWin > 0 ? gridMultCells(steps[steps.length - 1].grid) : [];
  let scatterWin = 0;
  const sc = scatters >= 6 ? 6 : scatters;
  if (cfg.scatter.payX && cfg.scatter.payX[sc]) scatterWin = Math.round(cfg.scatter.payX[sc] * bet);
  return { steps, baseWin, mults, scatters, scatterWin };
}

// ── Wild Bandit: Golden Squares + Rainbow reveal ──────────────────────────
// Roll one coin reveal for a Golden Square: pick a tier by weight, then a value
// uniformly within that tier's [lo,hi] band (in bet-multiples).
function rollCoin(cfg) {
  const coins = cfg.coins, t = coins.reduce((a, c) => a + c.w, 0);
  let r = rnd() * t, band = coins[0];
  for (const c of coins) { r -= c.w; if (r <= 0) { band = c; break; } }
  const val = band.lo + rnd() * (band.hi - band.lo);
  return { tier: band.tier, val: Math.round(val * 100) / 100 };
}
// One bandit spin: generate grid, cascade, mark winners as Golden Squares, and if a
// Rainbow landed, reveal coins from the gold squares added SINCE the last reveal.
// goldSet: all gold positions (persistent, for display). revealedSet: positions already
// paid out (so a Rainbow only pays NEW gold). mode drives persistence semantics.
function runBanditSpin(cfg, bet, goldSet, revealedSet, mode, forceRainbow, coinMult) {
  coinMult = coinMult || 1;
  const allowMult = true; // enables Rainbow spawns via genCell
  let cur = genGrid(cfg, allowMult, 1);
  if (forceRainbow && findRainbow(cfg, cur) < 0) {
    // guaranteed-Rainbow tier: drop one onto a random non-scatter cell if none spawned
    let idx = -1, tries = 0;
    do { idx = (rnd() * (cfg.W * cfg.H)) | 0; tries++; } while ((cur[idx] === cfg.scatter.id || isMul(cur[idx])) && tries < 20);
    if (idx >= 0) cur[idx] = cfg.rainbow.id;
  }
  const scatters = countScatter(cfg, cur);
  const rainbowAt = findRainbow(cfg, cur);
  const steps = [];
  let baseWin = 0, guard = 0;
  while (guard++ < 40) {
    const wins = evaluate(cfg, cur, bet);
    if (!wins.length) { steps.push({ grid: cur.slice(), wins: [], stepWin: 0 }); break; }
    let stepWin = 0; const rem = new Set();
    for (const w of wins) { stepWin += w.win; for (const p of w.positions) { rem.add(p); goldSet.add(p); } } // winners → Golden Squares
    baseWin += stepWin;
    steps.push({ grid: cur.slice(), wins, stepWin });
    const next = cur.slice(); collapse(cfg, next, rem, allowMult, 1); cur = next;
  }
  // Rainbow resolution: a Rainbow reveals coins for gold squares that haven't been
  // revealed yet (added since the last Rainbow). This bounds the payout — a square pays
  // once per time it becomes gold, not every Rainbow. 'luck' clears all gold after a
  // reveal (squares consumed); 'gold'/'rainbow' keep them gold but mark them revealed.
  let reveal = [], coinWin = 0, rainbowLanded = rainbowAt >= 0;
  if (rainbowLanded) {
    for (const pos of goldSet) {
      if (revealedSet.has(pos)) continue;     // already paid this round
      const c = rollCoin(cfg); coinWin += c.val * coinMult; reveal.push({ pos, tier: c.tier, val: Math.round(c.val * coinMult * 100) / 100 });
      revealedSet.add(pos);
    }
    coinWin = Math.round(coinWin * bet);
    if (mode === "luck") { goldSet.clear(); revealedSet.clear(); }   // consumed
    // 'gold'/'rainbow': squares stay gold + revealed (won't re-pay unless re-won)
  }
  let scatterWin = 0;
  const sc = scatters >= 6 ? 6 : scatters;
  if (cfg.scatter.payX && cfg.scatter.payX[sc]) scatterWin = Math.round(cfg.scatter.payX[sc] * bet);
  return { steps, baseWin, scatters, scatterWin, rainbow: rainbowLanded, reveal, coinWin, gold: [...goldSet] };
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
  // Super/Hidden use the powerful GLOBAL multiplier (gated behind rare 4/5-scatter triggers
  // to hold RTP). Regular (common 3-scatter) multiplies each winning spin in place.
  const useGlobal = mode === "super" || mode === "hidden";
  const boost = mode === "hidden" ? HIDDEN_BOOST : 1;

  let guard = 0;
  while (freeTriggered && freeLeft > 0 && guard++ < 500) {
    freeLeft--;
    const s = runSpin(cfg, bet, true, boost);
    // On a WINNING spin, every multiplier anywhere on the board counts (placement/timing
    // irrelevant — they all survive the tumble to the final grid). No win → discarded.
    const multSum = s.mults.reduce((a, m) => a + m.val, 0);
    let displayTotal = 0, added = 0, applied = 0;
    if (useGlobal) {
      // PROGRESSIVE global: a winning spin's multipliers raise the running global, then THIS
      // spin's win is paid at the current global. Climbing meter stays, but the payout is a
      // sum of (win × runningGlobal) instead of one giant end-multiply — far less swingy, so
      // the bonus breaks even / profits much more often (sum-of-products, not product-of-sums).
      if (s.baseWin > 0 && multSum > 0) { globalMult += multSum; added = multSum; }
      displayTotal = s.baseWin * globalMult + s.scatterWin;
      totalWin += displayTotal;
    } else {
      applied = (s.baseWin > 0 && multSum > 0) ? multSum : 0;
      displayTotal = (applied ? s.baseWin * applied : s.baseWin) + s.scatterWin;
      totalWin += displayTotal;
    }
    const rt = retrigFor(s.scatters);
    if (rt) { freeLeft += rt; freeAwarded += rt; }
    spins.push({ free: true, super: useGlobal, steps: s.steps, baseWin: s.baseWin, mults: (useGlobal ? added : applied) > 0 ? s.mults : [], multAdded: added, multApplied: applied, globalMult: useGlobal ? globalMult : 0, scatterWin: s.scatterWin, scatters: s.scatters, total: Math.round(displayTotal), retrigger: rt, freeLeft });
    if (totalWin > cfg.maxWinX * bet) break;
  }

  // Progressive global is applied per-spin above, so there is no end-multiply. superMult=1
  // tells the client to skip the end-of-bonus multiply animation.
  const superMult = 1, superPre = 0;
  if (totalWin > cfg.maxWinX * bet) totalWin = cfg.maxWinX * bet;
  return { spins, totalWin: Math.round(totalWin), freeTriggered, freeAwarded, mode, superMult, superPre, globalFinal: globalMult };
}

// ── Wild Bandit round ─────────────────────────────────────────────────────
// buy: false | 'feature' | 'rainbow' | 'luck' | 'gold'
function tierForCameras(n) {
  const t = GAMES.bandit.tiers;
  if (n >= 5) return t[5];
  if (n === 4) return t[4];
  if (n >= 3) return t[3];
  return null;
}
// mid-bonus camera retrigger: 2 cams +2, 3 cams +4 (3 also re-triggers a tier bump in
// the real slot; we keep it simple — +4 spins, no tier change — for tractable math).
function banditRetrig(n) { if (n >= 3) return 4; if (n === 2) return 2; return 0; }

function runBanditRound(cfg, bet, buy) {
  const spins = [];
  let totalWin = 0, mode = "base", freeLeft = 0, freeAwarded = 0, freeTriggered = false;
  const goldSet = new Set();        // persistent Golden Square positions across the bonus
  const revealedSet = new Set();    // positions already paid out by a Rainbow (bounds payout)
  let featureSpin = false, rainbowSpin = false;

  // Resolve paid entries
  if (buy === "luck") { mode = "luck"; }
  else if (buy === "gold") { mode = "gold"; }
  else if (buy === "rainbow") { mode = "base"; rainbowSpin = true; }   // Rainbow FeatureSpins: base play, forced RB each spin
  else if (buy === "feature") { mode = "base"; featureSpin = true; }   // Bonus Hunt: base play with boosted scatter chance

  // BASE spin (skipped only on direct-entry buys luck/gold)
  if (mode === "base") {
    const prevChance = cfg.scatter.chance;
    if (featureSpin) cfg.scatter.chance = prevChance * 5; // 5× bonus odds
    const s = runBanditSpin(cfg, bet, goldSet, revealedSet, "base", rainbowSpin, rainbowSpin ? 3 : 1);
    cfg.scatter.chance = prevChance;
    totalWin += s.baseWin + s.coinWin + s.scatterWin;
    const tier = tierForCameras(s.scatters);
    spins.push({ free: false, super: false, steps: s.steps, baseWin: s.baseWin, scatterWin: s.scatterWin, scatters: s.scatters,
      rainbow: s.rainbow, reveal: s.reveal, gold: s.gold, coinWin: s.coinWin,
      total: s.baseWin + s.coinWin + s.scatterWin, triggered: !!tier, retrigger: 0, mults: [], multAdded: 0, multApplied: 0, globalMult: 0 });
    if (tier) { mode = tier.mode; }
  }

  if (mode !== "base") { freeTriggered = true; freeLeft = cfg.tiers[cfg.tiers[5].mode === mode ? 5 : cfg.tiers[4].mode === mode ? 4 : 3].spins; freeAwarded = freeLeft; }
  const forceRainbow = mode === "rainbow";

  let guard = 0;
  while (freeTriggered && freeLeft > 0 && guard++ < 500) {
    freeLeft--;
    const s = runBanditSpin(cfg, bet, goldSet, revealedSet, mode, forceRainbow);
    const spinTotal = s.baseWin + s.coinWin + s.scatterWin;
    totalWin += spinTotal;
    const rt = banditRetrig(s.scatters);
    if (rt) { freeLeft += rt; freeAwarded += rt; }
    spins.push({ free: true, super: false, steps: s.steps, baseWin: s.baseWin, scatterWin: s.scatterWin, scatters: s.scatters,
      rainbow: s.rainbow, reveal: s.reveal, gold: s.gold, coinWin: s.coinWin,
      total: Math.round(spinTotal), retrigger: rt, mults: [], multAdded: 0, multApplied: 0, globalMult: 0 });
    if (totalWin > cfg.maxWinX * bet) break;
  }

  if (totalWin > cfg.maxWinX * bet) totalWin = cfg.maxWinX * bet;
  return { spins, totalWin: Math.round(totalWin), freeTriggered, freeAwarded, mode, superMult: 1, superPre: 0, globalFinal: 1 };
}

export function listGames() {
  return Object.values(GAMES).map(g => {
    const sc = g.payScale || 1, pays = {};
    for (const k of Object.keys(g.pays)) pays[k] = g.pays[k].map(t => [t[0], Math.round(t[1] * sc * 100) / 100]);
    const out = {
      id: g.id, name: g.name, tag: g.tag, color: g.color, W: g.W, H: g.H, minCluster: g.minCluster,
      sym: g.sym, pays,
      buy: { regular: g.buyRegular, super: g.buySuper },
    };
    if (g.engine === "bandit") {
      // Golden-Square model: camera scatter tiers + Rainbow + multi-buy
      out.engine = "bandit";
      out.scatter = { emoji: g.scatter.emoji, tiers: g.tiers };
      out.rainbow = g.rainbow.emoji;
      out.buys = g.buys.map(b => ({ id: b.id, label: b.label, top: b.top, mult: b.mult }));
    } else {
      out.scatter = { emoji: g.scatter.emoji, regular: TRIG.regular, super: TRIG.super, hidden: TRIG.hidden, spins: SPINS };
      out.mult = { emoji: g.mult.emoji };
    }
    return out;
  });
}
export function getGame(id) { return GAMES[id] || null; }
export function spin(id, bet, buy) {
  const cfg = GAMES[id]; if (!cfg) throw new Error("Unknown game");
  if (cfg.engine === "bandit") {
    const b = (buy === "luck" || buy === "gold" || buy === "rainbow" || buy === "feature") ? buy : false;
    return runBanditRound(cfg, bet, b);
  }
  const b = buy === "super" ? "super" : (buy === "regular" ? "regular" : false); // hidden not buyable
  return runRound(cfg, bet, b);
}
export function buyCost(id, kind) {
  const cfg = GAMES[id]; if (!cfg) return Infinity;
  if (cfg.engine === "bandit") {
    if (Array.isArray(cfg.buys)) for (const b of cfg.buys) if (b.id === kind) return b.mult;
    return Infinity;
  }
  return kind === "super" ? cfg.buySuper : cfg.buyRegular;
}
export const SLOT_GAME_IDS = Object.keys(GAMES);

// Auto-price buy bonuses so their RTP ≈ target. Candy/olympus → 87% (2 buys).
// Bandit direct-entry buys (luck/gold) → 96%; FeatureSpins/Rainbow use fixed spec mults.
(function priceBuys() {
  const N = 30000, bet = 20;
  for (const id of SLOT_GAME_IDS) {
    const cfg = GAMES[id];
    if (cfg.engine === "bandit") {
      const TARGET = 0.96;
      // Direct-entry buys (luck/gold) are full bonus rounds → price by full-round EV.
      // FeatureSpins/Rainbow are SINGLE base spins → price by single-spin EV (their
      // mult × bet buys ONE spin, not a round). All auto-priced to ~96% RTP.
      for (const kind of ["luck", "gold", "feature", "rainbow"]) {
        let sum = 0;
        for (let i = 0; i < N; i++) sum += runBanditRound(cfg, bet, kind).totalWin;
        const avgX = (sum / N) / bet;
        const cost = Math.max(3, Math.round(avgX / TARGET));
        const entry = cfg.buys.find(b => b.id === kind);
        if (entry) entry.mult = cost;
      }
    } else {
      const TARGET = 0.87;
      for (const kind of ["regular", "super"]) {
        let sum = 0;
        for (let i = 0; i < N; i++) sum += runRound(cfg, bet, kind).totalWin;
        const avgX = (sum / N) / bet;
        const cost = Math.max(5, Math.round(avgX / TARGET));
        if (kind === "super") cfg.buySuper = cost; else cfg.buyRegular = cost;
      }
    }
  }
})();
