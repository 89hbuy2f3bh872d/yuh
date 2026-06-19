// SlotEngine — cluster-pays tumbling slots (orthogonal clusters of 5+, no diagonals).
// Scatter triggers (by count on the triggering grid):
//   3 → Regular bonus (per-spin multipliers)
//   4 → Super bonus  (global multiplier, applied to the whole bonus at the end)
//   5 → Hidden bonus (overpowered Super — more spins + boosted multipliers; NOT buyable)
// Retriggers inside a bonus: 3 scatters +2 spins, 4 +4, 5 +6 (rare).
// Whole round resolved server-side; client animates. Base/buy RTP ≈ 96%.
// NOTE: per-win pays are kept FRACTIONAL (rounded only at the round total) — rounding each
// tiny win to integer FC at low bets badly distorts RTP (the dominant small win sits on a .5
// boundary, doubling on a 0.005 payScale change). Concentrated reels (low dead-spin %) make
// that win dominant, so this matters.

const MUL = "M:";
function rnd() { return Math.random(); }
function wpick(reel) { let t = 0; for (let i = 0; i < reel.length; i++) t += reel[i][1]; let r = rnd() * t; for (let i = 0; i < reel.length; i++) { r -= reel[i][1]; if (r <= 0) return reel[i][0]; } return reel[reel.length - 1][0]; }
function rollMult(table) { let t = 0; for (let i = 0; i < table.length; i++) t += table[i][1]; let r = rnd() * t; for (let i = 0; i < table.length; i++) { r -= table[i][1]; if (r <= 0) return table[i][0]; } return table[table.length - 1][0]; }

// per-rank base pay for cluster sizes {5+,8+,10+,15+}; multiplied by payScale.
function payRows(a, b, c, d) { return [[15, d], [10, c], [8, b], [5, a]]; }

const TRIG = { regular: 3, super: 4, hidden: 5 }; // scatters needed
const SPINS = { regular: 8, super: 16, hidden: 18 }; // more spins → steadier bonus (Super profits more often)
const HIDDEN_BOOST = 1.7; // hidden bonus multiplier-symbol frequency boost

const GAMES = {
  candy: {
    id: "candy", name: "Candy Cascade", tag: "Cluster pays · tumbling candies", color: "#ec4899",
    W: 6, H: 5, minCluster: 5, maxWinX: 5000, payScale: 0.39,
    sym: { blue: "🔵", green: "🟢", purple: "🟣", red: "🔴", apple: "🍎", grape: "🍇", melon: "🍉" },
    reel: [["blue", 140], ["green", 95], ["purple", 58], ["red", 22], ["apple", 10], ["grape", 5], ["melon", 3]],
    pays: {
      blue: payRows(0.2, 0.5, 1.0, 2.5), green: payRows(0.25, 0.6, 1.2, 3),
      purple: payRows(0.3, 0.8, 1.6, 4), red: payRows(0.4, 1.0, 2.2, 6),
      apple: payRows(0.6, 1.5, 3, 10), grape: payRows(0.9, 2.2, 5, 15), melon: payRows(1.5, 4, 9, 25),
    },
    scatter: { id: "SC", emoji: "🍭", chance: 0.017, payX: { 3: 2, 4: 5, 5: 20, 6: 100 } },
    mult: { emoji: "🍬", chance: 0.17, table: [[2, 54], [3, 33], [5, 10], [10, 3]] },
  },
  olympus: {
    id: "olympus", name: "Thunder Gods", tag: "Cluster pays · global multiplier bonus", color: "#eab308",
    W: 6, H: 5, minCluster: 5, maxWinX: 5000, payScale: 0.39,
    sym: { ring: "💍", glass: "⏳", chalice: "🏺", crown: "👑", blue: "💙", green: "💚", red: "❤️" },
    reel: [["ring", 140], ["glass", 95], ["chalice", 58], ["crown", 22], ["blue", 10], ["green", 5], ["red", 3]],
    pays: {
      ring: payRows(0.2, 0.5, 1, 2.5), glass: payRows(0.25, 0.6, 1.2, 3),
      chalice: payRows(0.3, 0.8, 1.6, 4), crown: payRows(0.45, 1.1, 2.4, 7),
      blue: payRows(0.6, 1.5, 3, 10), green: payRows(0.9, 2.4, 5.5, 16), red: payRows(1.6, 4.5, 10, 30),
    },
    scatter: { id: "SC", emoji: "⚡", chance: 0.017, payX: { 3: 2, 4: 5, 5: 20, 6: 100 } },
    mult: { emoji: "🪙", chance: 0.17, table: [[2, 54], [3, 33], [5, 10], [10, 3]] },
  },
  // Wild Bandit ("Le Bandit"-style): 6×5, scatter-pays (5+ matching ANYWHERE), Wild
  // substitutes, Super Cascade (all matching removed), Golden Squares (fixed cells that a
  // Rainbow activates → reveal Coins / Clovers / Collectors). Max 10,000×. RTP ≈ 96.3-96.4%.
  // Has its OWN engine path (banditEval/banditCascade/runBanditSpin/runBanditRound).
  bandit: {
    id: "bandit", name: "Wild Bandit", tag: "Le Bandit · Golden Squares, Rainbows & Collectors", color: "#f59e0b",
    engine: "bandit",
    W: 6, H: 5, minMatch: 5, maxWinX: 10000, payScale: 0.285, cascCap: 6,
    sym: { ten: "🔟", jack: "🅙", queen: "🆀", king: "🅚", ace: "🅐", gem: "💎", ring: "💍", bandit: "🦝" }, // low→high
    wild: { id: "WILD", emoji: "🃏" },
    // lows common but pay only at high counts; premiums rare but pay at 5+. Keeps PAYING wins
    // occasional so the cascade terminates (only paying wins cascade). All pays ×payScale.
    reel: [["ten", 16], ["jack", 15], ["queen", 13], ["king", 11], ["ace", 9], ["gem", 6], ["ring", 4], ["bandit", 2.5], ["WILD", 3]],
    pays: {
      ten:    [[12, 1],   [10, 0.4]],
      jack:   [[12, 1.5], [10, 0.5]],
      queen:  [[12, 2],   [10, 0.7], [8, 0.3]],
      king:   [[12, 3],   [10, 1.2], [8, 0.5]],
      ace:    [[12, 5],   [10, 2],   [8, 0.8]],
      gem:    [[12, 12],  [10, 6],   [8, 3],   [5, 0.8]],
      ring:   [[12, 40],  [10, 20],  [8, 10],  [5, 2.5]],
      bandit: [[15, 200], [12, 90],  [10, 45], [8, 22], [5, 6]],
    },
    // Camera scatter triggers free spins: 3 → Luck, 4 → All That Glitters, 5 → Treasure
    scatter: { id: "SC", emoji: "📷", chance: 0.0065, payX: { 3: 1, 4: 3, 5: 10, 6: 50 } },
    // Rainbow lands (per-grid roll) and ACTIVATES the Golden Squares. Rare in base, common in bonus.
    rainbow: { id: "RB", emoji: "🌈", baseChance: 0.016, bonusChance: 0.30 },
    // Golden-square reveal: mostly a Coin, sometimes a Clover (×adjacent), rarely a Collector
    // (×2). Coin bands are bet-multiples (value skewed LOW via r²). Gold is very rare. The big
    // spec bands (.2-4 / 5-20 / 25-500) are scaled to hold RTP; gold still reaches ~125×.
    reveal: {
      pCollector: 0.05, pClover: 0.12,
      coin: [ { tier: "bronze", w: 100, lo: 0.05, hi: 1 }, { tier: "silver", w: 3, lo: 1.25, hi: 5 }, { tier: "gold", w: 0.12, lo: 6.25, hi: 125 } ],
      clover: [[2, 55], [3, 28], [5, 12], [10, 5]],   // adjacent-coin multiplier (×2–×10)
      cap: 10000,                                      // per-reveal cap in bonus (= maxWinX)
      baseCap: 40,                                     // tighter cap in BASE so base RTP is stable
    },
    tiers: { 3: { mode: "luck", spins: 8 }, 4: { mode: "gold", spins: 12 }, 5: { mode: "rainbow", spins: 12 } },
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
      // Keep the win FRACTIONAL — rounding each tiny win to integer FC at low bets distorts
      // RTP badly (the dominant small win sits on a .5 boundary). The round TOTAL is rounded once.
      if (x > 0) wins.push({ sym: s, emoji: cfg.sym[s], size: cells.length, positions: cells, win: x * bet });
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

// ── Wild Bandit ("Le Bandit") engine ──────────────────────────────────────
// Scatter-pays: 5+ of a symbol ANYWHERE wins (Wild counts toward every symbol). Super
// Cascade removes ALL of every winning symbol (+ wilds). Winning cells become Golden
// Squares (fixed positions, never move). A Rainbow ACTIVATES the Golden Squares, revealing
// Coins / Clovers / Collectors.
function banditCell(cfg, allowScatter) {
  if (allowScatter && rnd() < cfg.scatter.chance) return cfg.scatter.id;
  return wpick(cfg.reel); // reel includes the Wild
}
function banditGrid(cfg) { const n = cfg.W * cfg.H, g = new Array(n); for (let i = 0; i < n; i++) g[i] = banditCell(cfg, true); return g; }
function banditPay(cfg, sym, count) { const t = cfg.pays[sym], sc = cfg.payScale || 1; for (let i = 0; i < t.length; i++) if (count >= t[i][0]) return t[i][1] * sc; return 0; }
function banditEval(cfg, grid, bet) {
  const wildId = cfg.wild.id, counts = {}, posOf = {}, wildPos = [];
  for (let i = 0; i < grid.length; i++) {
    const s = grid[i];
    if (s === wildId) { wildPos.push(i); continue; }
    if (!cfg.pays[s]) continue; // scatter / nothing
    counts[s] = (counts[s] || 0) + 1; (posOf[s] || (posOf[s] = [])).push(i);
  }
  const wins = []; let anyWin = false;
  for (const s in counts) {
    const total = counts[s] + wildPos.length;
    if (total >= cfg.minMatch) {
      const x = banditPay(cfg, s, total);
      if (x > 0) { anyWin = true; wins.push({ sym: s, emoji: cfg.sym[s], count: total, positions: posOf[s].slice(), win: Math.round(x * bet) }); }
    }
  }
  if (anyWin && wildPos.length) wins.push({ sym: wildId, emoji: cfg.wild.emoji, count: wildPos.length, positions: wildPos, win: 0, wild: true });
  return wins;
}
function banditCascade(cfg, grid, rem) {
  const W = cfg.W, H = cfg.H;
  for (let col = 0; col < W; col++) {
    const keep = [];
    for (let row = H - 1; row >= 0; row--) { const idx = row * W + col; if (!rem.has(idx)) keep.push(grid[idx]); }
    while (keep.length < H) keep.push(banditCell(cfg, false)); // no scatter on refills
    for (let row = H - 1, k = 0; row >= 0; row--, k++) grid[row * W + col] = keep[k];
  }
}
// One coin value (bet-multiple). Value within a band is skewed LOW (r² product) so the big
// spec bands hold RTP. Rainbow mode drops Bronze entirely.
function rollCoinVal(cfg, noBronze) {
  const bands = cfg.reveal.coin.filter(c => !(noBronze && c.tier === "bronze"));
  let t = 0; for (const c of bands) t += c.w; let r = rnd() * t, band = bands[bands.length - 1];
  for (const c of bands) { r -= c.w; if (r <= 0) { band = c; break; } }
  const val = band.lo + (band.hi - band.lo) * (rnd() * rnd());
  return { tier: band.tier, val: Math.round(val * 100) / 100 };
}
// Resolve a Rainbow activation over `activate` gold positions: each reveals a Coin / Clover
// / Collector; clovers ×adjacent coins; each Collector collects the whole coin-sum again
// (rare → big). Returns {events, collected(FC), sum(bet-mult), collectors}.
function resolveReveal(cfg, bet, activate, mode) {
  const W = cfg.W, H = cfg.H, rv = cfg.reveal, noBronze = mode === "rainbow", cells = {};
  for (const pos of activate) {
    const r = rnd();
    if (r < rv.pCollector) cells[pos] = { type: "collector" };
    else if (r < rv.pCollector + rv.pClover) cells[pos] = { type: "clover", mult: rollMult(rv.clover) };
    else { const c = rollCoinVal(cfg, noBronze); cells[pos] = { type: "coin", tier: c.tier, val: c.val }; }
  }
  for (const p in cells) { // clovers ×adjacent coin values (8-neighbour)
    const cell = cells[p]; if (cell.type !== "clover") continue;
    const pos = +p, r = (pos / W) | 0, col = pos % W;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue; const nr = r + dr, nc = col + dc; if (nr < 0 || nr >= H || nc < 0 || nc >= W) continue;
      const nb = cells[nr * W + nc]; if (nb && nb.type === "coin") nb.val = Math.round(nb.val * cell.mult * 100) / 100;
    }
  }
  let sum = 0, collectors = 0;
  for (const p in cells) { const c = cells[p]; if (c.type === "coin") sum += c.val; else if (c.type === "collector") collectors++; }
  let payX = sum * (collectors > 0 ? 2 : 1);              // a Collector (rare) doubles the haul
  const cap = mode === "base" ? (rv.baseCap || rv.cap) : rv.cap;
  if (payX > cap) payX = cap;
  const events = Object.keys(cells).map(p => Object.assign({ pos: +p }, cells[p]));
  return { events, collected: Math.round(payX * bet), sum: Math.round(payX * 100) / 100, collectors };
}
// One bandit spin. goldSet = Golden Squares (fixed cells). revealedSet = gold already paid
// (so each square pays ONCE per accumulation — bounds RTP). A Rainbow activates the
// not-yet-revealed gold. base/luck consume all gold on activation; gold/rainbow keep it (new
// winners accrue and pay on later Rainbows).
function runBanditSpin(cfg, bet, goldSet, revealedSet, mode, forceRainbow, rainbowChance) {
  let cur = banditGrid(cfg);
  const scatters = countScatter(cfg, cur);
  const rainbow = forceRainbow || rnd() < (rainbowChance || 0);
  const steps = [];
  let baseWin = 0, guard = 0;
  while (guard++ < (cfg.cascCap || 40)) {
    const wins = banditEval(cfg, cur, bet);
    if (!wins.length) { steps.push({ grid: cur.slice(), wins: [], stepWin: 0 }); break; }
    let stepWin = 0; const rem = new Set();
    for (const w of wins) { stepWin += w.win; for (const p of w.positions) { rem.add(p); goldSet.add(p); } } // winners → fixed Golden Squares
    baseWin += stepWin;
    steps.push({ grid: cur.slice(), wins, stepWin });
    const next = cur.slice(); banditCascade(cfg, next, rem); cur = next;
  }
  let reveal = null, coinWin = 0;
  if (rainbow) {
    const act = [...goldSet].filter(p => !revealedSet.has(p));
    if (act.length) {
      reveal = resolveReveal(cfg, bet, act, mode);
      coinWin = reveal.collected;
      act.forEach(p => revealedSet.add(p));
      if (mode === "base" || mode === "luck") { goldSet.clear(); revealedSet.clear(); } // consumed
    }
  }
  let scatterWin = 0; const sc = scatters >= 6 ? 6 : scatters;
  if (cfg.scatter.payX && cfg.scatter.payX[sc]) scatterWin = Math.round(cfg.scatter.payX[sc] * bet);
  return { steps, baseWin, scatters, scatterWin, rainbow: !!(rainbow && (reveal || goldSet.size)), reveal, coinWin, gold: [...goldSet] };
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

function banditSpinOut(s, free, triggered, rt) {
  return { free: !!free, super: false, steps: s.steps, baseWin: s.baseWin, scatterWin: s.scatterWin, scatters: s.scatters,
    rainbow: s.rainbow, reveal: s.reveal, gold: s.gold, coinWin: s.coinWin,
    total: Math.round(s.baseWin + s.coinWin + s.scatterWin), triggered: !!triggered, retrigger: rt || 0,
    mults: [], multAdded: 0, multApplied: 0, globalMult: 0 };
}
function modeSpins(cfg, mode) { for (const k in cfg.tiers) if (cfg.tiers[k].mode === mode) return cfg.tiers[k].spins; return 8; }
function runBanditRound(cfg, bet, buy) {
  const spins = [];
  let totalWin = 0, mode = "base", freeLeft = 0, freeAwarded = 0, freeTriggered = false;
  let featureSpin = false, rainbowSpin = false;
  if (buy === "luck") mode = "luck";
  else if (buy === "gold") mode = "gold";
  else if (buy === "rainbow") { mode = "base"; rainbowSpin = true; }   // forced Rainbow each base spin
  else if (buy === "feature") { mode = "base"; featureSpin = true; }   // Bonus Hunt: boosted camera odds

  // BASE spin (skipped on direct-entry luck/gold buys). Gold squares are per-spin in base.
  if (mode === "base") {
    const gold = new Set(), revealed = new Set();
    const prevSc = cfg.scatter.chance;
    if (featureSpin) cfg.scatter.chance = prevSc * 5;
    const rbChance = rainbowSpin ? 1 : cfg.rainbow.baseChance;
    const s = runBanditSpin(cfg, bet, gold, revealed, "base", rainbowSpin, rbChance);
    cfg.scatter.chance = prevSc;
    totalWin += s.baseWin + s.coinWin + s.scatterWin;
    const tier = tierForCameras(s.scatters);
    spins.push(banditSpinOut(s, false, !!tier, 0));
    if (tier) mode = tier.mode;
  }

  if (mode !== "base") { freeTriggered = true; const t = modeSpins(cfg, mode); freeLeft = t; freeAwarded = t; }
  const forceRainbow = mode === "rainbow";
  const gold = new Set(), revealed = new Set(); // persist across the whole bonus (fixed cells)
  let guard = 0;
  while (freeTriggered && freeLeft > 0 && guard++ < 600) {
    freeLeft--;
    const rbChance = mode === "rainbow" ? 1 : cfg.rainbow.bonusChance;
    const s = runBanditSpin(cfg, bet, gold, revealed, mode, forceRainbow, rbChance);
    totalWin += s.baseWin + s.coinWin + s.scatterWin;
    const rt = banditRetrig(s.scatters);
    if (rt) { freeLeft += rt; freeAwarded += rt; }
    spins.push(banditSpinOut(s, true, false, rt));
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
      id: g.id, name: g.name, tag: g.tag, color: g.color, W: g.W, H: g.H, minCluster: g.minCluster || g.minMatch,
      sym: g.sym, pays,
      buy: { regular: g.buyRegular, super: g.buySuper },
    };
    if (g.engine === "bandit") {
      // Le Bandit: scatter-pays + Wild, camera tiers, Rainbow activates Golden Squares
      out.engine = "bandit";
      out.scatter = { emoji: g.scatter.emoji, tiers: g.tiers };
      out.rainbow = g.rainbow.emoji;
      out.wild = g.wild.emoji;
      out.coins = g.reveal.coin.map(c => ({ tier: c.tier, lo: c.lo, hi: c.hi }));
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

// Auto-price buy bonuses so their RTP ≈ target. Candy/olympus → 95% (2 buys).
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
      const TARGET = 0.96;
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
