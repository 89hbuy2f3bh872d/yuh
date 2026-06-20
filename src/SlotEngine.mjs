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
function rnd() {
  return Math.random();
}
function wpick(reel) {
  let t = 0;
  for (let i = 0; i < reel.length; i++) t += reel[i][1];
  let r = rnd() * t;
  for (let i = 0; i < reel.length; i++) {
    r -= reel[i][1];
    if (r <= 0) return reel[i][0];
  }
  return reel[reel.length - 1][0];
}
function rollMult(table) {
  let t = 0;
  for (let i = 0; i < table.length; i++) t += table[i][1];
  let r = rnd() * t;
  for (let i = 0; i < table.length; i++) {
    r -= table[i][1];
    if (r <= 0) return table[i][0];
  }
  return table[table.length - 1][0];
}

// per-rank base pay for cluster sizes {5+,8+,10+,15+}; multiplied by payScale.
function payRows(a, b, c, d) {
  return [
    [15, d],
    [10, c],
    [8, b],
    [5, a],
  ];
}

const TRIG = { regular: 3, super: 4, hidden: 5 }; // scatters needed
const SPINS = { regular: 8, super: 16, hidden: 18 }; // more spins → steadier bonus (Super profits more often)
const HIDDEN_BOOST = 1.7; // hidden bonus multiplier-symbol frequency boost

const CANDY = {
  id: "candy",
  name: "Candy Cascade",
  tag: "Cluster pays · tumbling candies",
  color: "#ec4899",
  W: 6,
  H: 5,
  minCluster: 5,
  maxWinX: 5000,
  payScale: 0.39,
  sym: {
    blue: "🔵",
    green: "🟢",
    purple: "🟣",
    red: "🔴",
    apple: "🍎",
    grape: "🍇",
    melon: "🍉",
  },
  reel: [
    ["blue", 140],
    ["green", 95],
    ["purple", 58],
    ["red", 22],
    ["apple", 10],
    ["grape", 5],
    ["melon", 3],
  ],
  pays: {
    blue: payRows(0.2, 0.5, 1.0, 2.5),
    green: payRows(0.25, 0.6, 1.2, 3),
    purple: payRows(0.3, 0.8, 1.6, 4),
    red: payRows(0.4, 1.0, 2.2, 6),
    apple: payRows(0.6, 1.5, 3, 10),
    grape: payRows(0.9, 2.2, 5, 15),
    melon: payRows(1.5, 4, 9, 25),
  },
  scatter: {
    id: "SC",
    emoji: "🍭",
    chance: 0.017,
    payX: { 3: 2, 4: 5, 5: 20, 6: 100 },
  },
  mult: {
    emoji: "🍬",
    chance: 0.17,
    table: [
      [2, 54],
      [3, 33],
      [5, 10],
      [10, 3],
    ],
  },
};
const OLYMPUS = {
  id: "olympus",
  name: "Thunder Gods",
  tag: "Cluster pays · global multiplier bonus",
  color: "#eab308",
  W: 6,
  H: 5,
  minCluster: 5,
  maxWinX: 5000,
  payScale: 0.39,
  sym: {
    ring: "💍",
    glass: "⏳",
    chalice: "🏺",
    crown: "👑",
    blue: "💙",
    green: "💚",
    red: "❤️",
  },
  reel: [
    ["ring", 140],
    ["glass", 95],
    ["chalice", 58],
    ["crown", 22],
    ["blue", 10],
    ["green", 5],
    ["red", 3],
  ],
  pays: {
    ring: payRows(0.2, 0.5, 1, 2.5),
    glass: payRows(0.25, 0.6, 1.2, 3),
    chalice: payRows(0.3, 0.8, 1.6, 4),
    crown: payRows(0.45, 1.1, 2.4, 7),
    blue: payRows(0.6, 1.5, 3, 10),
    green: payRows(0.9, 2.4, 5.5, 16),
    red: payRows(1.6, 4.5, 10, 30),
  },
  scatter: {
    id: "SC",
    emoji: "⚡",
    chance: 0.017,
    payX: { 3: 2, 4: 5, 5: 20, 6: 100 },
  },
  mult: {
    emoji: "🪙",
    chance: 0.17,
    table: [
      [2, 54],
      [3, 33],
      [5, 10],
      [10, 3],
    ],
  },
};

// Reskin a base cluster-pays game: keep its tuned reels/pays/payScale/scatter (so base RTP is
// unchanged) and swap emojis/name/color. mult.chance only affects BONUS spins (auto-priced via
// buyCost), and maxWinX is a rarely-hit round cap — both safe to vary. New sym keys map 1:1 onto
// the base's low→high symbol order (Object key insertion order is preserved for string keys).
function reskin(base, o) {
  const keys = Object.keys(base.pays),
    newKeys = Object.keys(o.sym);
  const sym = {},
    reel = [],
    pays = {};
  keys.forEach((k, i) => {
    const nk = newKeys[i];
    sym[nk] = o.sym[nk];
    reel.push([nk, base.reel[i][1]]);
    pays[nk] = base.pays[k].map((t) => [t[0], t[1]]);
  });
  return {
    id: o.id,
    name: o.name,
    tag: o.tag,
    color: o.color,
    W: base.W,
    H: base.H,
    minCluster: base.minCluster,
    maxWinX: o.maxWinX || base.maxWinX,
    payScale: base.payScale,
    sym,
    reel,
    pays,
    scatter: {
      id: "SC",
      emoji: o.scatterEmoji,
      chance: base.scatter.chance,
      payX: { ...base.scatter.payX },
    },
    mult: {
      emoji: o.multEmoji,
      chance: o.multChance != null ? o.multChance : base.mult.chance,
      table: base.mult.table.map((t) => [t[0], t[1]]),
    },
  };
}

const GAMES = {
  candy: CANDY,
  olympus: OLYMPUS,
  fruit: reskin(CANDY, {
    id: "fruit",
    name: "Fruit Frenzy",
    tag: "Cluster pays · juicy tumbling fruits",
    color: "#f97316",
    maxWinX: 5000,
    multChance: 0.15,
    sym: {
      cherry: "🍒",
      orange: "🍊",
      lemon: "🍋",
      berry: "🍓",
      peach: "🍑",
      kiwi: "🥝",
      mango: "🥭",
    },
    scatterEmoji: "🍉",
    multEmoji: "🍇",
  }),
  gems: reskin(OLYMPUS, {
    id: "gems",
    name: "Gem Galaxy",
    tag: "Cluster pays · crystalline clusters",
    color: "#06b6d4",
    maxWinX: 6000,
    multChance: 0.18,
    sym: {
      sapphire: "💎",
      crystal: "🔮",
      prism: "💠",
      topaz: "🟨",
      emerald: "🟩",
      ruby: "🟥",
      amethyst: "🟪",
    },
    scatterEmoji: "🌟",
    multEmoji: "✨",
  }),
  ocean: reskin(CANDY, {
    id: "ocean",
    name: "Ocean Odyssey",
    tag: "Cluster pays · deep-sea swarms",
    color: "#0ea5e9",
    maxWinX: 4500,
    multChance: 0.16,
    sym: {
      guppy: "🐟",
      tuna: "🐠",
      crab: "🦀",
      shrimp: "🦐",
      squid: "🦑",
      octo: "🐙",
      shark: "🦈",
    },
    scatterEmoji: "🐚",
    multEmoji: "🫧",
  }),
  cosmos: reskin(OLYMPUS, {
    id: "cosmos",
    name: "Cosmic Clusters",
    tag: "Cluster pays · stellar multipliers",
    color: "#8b5cf6",
    maxWinX: 7000,
    multChance: 0.19,
    sym: {
      moon: "🌑",
      planet: "🪐",
      comet: "☄️",
      star: "⭐",
      nova: "🌟",
      galaxy: "🌌",
      ufo: "🛸",
    },
    scatterEmoji: "🌠",
    multEmoji: "🛰️",
  }),
  clover: reskin(CANDY, {
    id: "clover",
    name: "Lucky Lanterns",
    tag: "Cluster pays · festival lanterns",
    color: "#dc2626",
    maxWinX: 5500,
    multChance: 0.2,
    sym: {
      lantern: "🏮",
      envelope: "🧧",
      fish: "🎏",
      wind: "🎐",
      dragon: "🐲",
      coin: "🪙",
      panda: "🐼",
    },
    scatterEmoji: "🎆",
    multEmoji: "🍀",
  }),
};

function payFor(cfg, sym, size) {
  const t = cfg.pays[sym],
    sc = cfg.payScale || 1;
  for (let i = 0; i < t.length; i++) if (size >= t[i][0]) return t[i][1] * sc;
  return 0;
}
function isMul(s) {
  return typeof s === "string" && s.startsWith(MUL);
}
function mulVal(s) {
  return parseInt(s.slice(MUL.length), 10) || 0;
}

function genCell(cfg, allowScatter, allowMult, boost) {
  if (allowScatter && rnd() < cfg.scatter.chance) return cfg.scatter.id;
  if (allowMult && cfg.mult && rnd() < cfg.mult.chance * (boost || 1))
    return MUL + rollMult(cfg.mult.table);
  return wpick(cfg.reel);
}
function genGrid(cfg, allowMult, boost) {
  const n = cfg.W * cfg.H,
    g = new Array(n);
  for (let i = 0; i < n; i++) g[i] = genCell(cfg, true, allowMult, boost);
  return g;
}

// orthogonal flood-fill clusters of identical pay symbols, size >= minCluster
function evaluate(cfg, grid, bet) {
  const W = cfg.W,
    H = cfg.H,
    n = W * H,
    seen = new Array(n).fill(false),
    wins = [];
  for (let i = 0; i < n; i++) {
    const s = grid[i];
    if (seen[i] || isMul(s) || s === cfg.scatter.id || !cfg.pays[s]) continue;
    const stack = [i],
      cells = [];
    seen[i] = true;
    while (stack.length) {
      const c = stack.pop();
      cells.push(c);
      const r = (c / W) | 0,
        col = c % W;
      const nb = [];
      if (r > 0) nb.push(c - W);
      if (r < H - 1) nb.push(c + W);
      if (col > 0) nb.push(c - 1);
      if (col < W - 1) nb.push(c + 1);
      for (const k of nb)
        if (!seen[k] && grid[k] === s) {
          seen[k] = true;
          stack.push(k);
        }
    }
    if (cells.length >= cfg.minCluster) {
      const x = payFor(cfg, s, cells.length);
      // Keep the win FRACTIONAL — rounding each tiny win to integer FC at low bets distorts
      // RTP badly (the dominant small win sits on a .5 boundary). The round TOTAL is rounded once.
      if (x > 0)
        wins.push({
          sym: s,
          emoji: cfg.sym[s],
          size: cells.length,
          positions: cells,
          win: x * bet,
        });
    }
  }
  return wins;
}

function collapse(cfg, grid, rem, allowMult, boost) {
  const W = cfg.W,
    H = cfg.H;
  for (let col = 0; col < W; col++) {
    const keep = [];
    for (let row = H - 1; row >= 0; row--) {
      const idx = row * W + col;
      if (!rem.has(idx)) keep.push(grid[idx]);
    }
    while (keep.length < H) keep.push(genCell(cfg, false, allowMult, boost)); // no scatter on refills
    for (let row = H - 1, k = 0; row >= 0; row--, k++)
      grid[row * W + col] = keep[k];
  }
}
function countScatter(cfg, grid) {
  let c = 0;
  for (let i = 0; i < grid.length; i++) if (grid[i] === cfg.scatter.id) c++;
  return c;
}
function gridMultCells(grid) {
  const a = [];
  for (let i = 0; i < grid.length; i++)
    if (isMul(grid[i])) a.push({ pos: i, val: mulVal(grid[i]) });
  return a;
}
// Replace every multiplier cell with a normal reel symbol that differs from its orthogonal
// neighbours (so it can't look like a cluster — the client renders server-provided wins and
// never re-evaluates). Used to hide multipliers on spins that produced no win.
function stripMults(cfg, grid) {
  const W = cfg.W,
    H = cfg.H;
  for (let i = 0; i < grid.length; i++) {
    if (!isMul(grid[i])) continue;
    const r = (i / W) | 0,
      col = i % W,
      neigh = new Set();
    if (r > 0) neigh.add(grid[i - W]);
    if (r < H - 1) neigh.add(grid[i + W]);
    if (col > 0) neigh.add(grid[i - 1]);
    if (col < W - 1) neigh.add(grid[i + 1]);
    let sym,
      t = 0;
    do {
      sym = wpick(cfg.reel);
    } while (neigh.has(sym) && ++t < 20);
    grid[i] = sym;
  }
}

function runSpin(cfg, bet, allowMult, boost) {
  let cur = genGrid(cfg, allowMult, boost);
  const scatters = countScatter(cfg, cur);
  const steps = [];
  let baseWin = 0,
    guard = 0;
  while (guard++ < 40) {
    const wins = evaluate(cfg, cur, bet);
    if (!wins.length) {
      steps.push({ grid: cur.slice(), wins: [], stepWin: 0 });
      break;
    }
    let stepWin = 0;
    const rem = new Set();
    for (const w of wins) {
      stepWin += w.win;
      for (const p of w.positions) rem.add(p);
    }
    baseWin += stepWin;
    steps.push({ grid: cur.slice(), wins, stepWin });
    const next = cur.slice();
    collapse(cfg, next, rem, allowMult, boost);
    cur = next;
  }
  // A multiplier only counts on a WINNING spin (placement irrelevant — they survive the
  // tumble to the final grid). If this spin produced no win, its multipliers are worthless,
  // so hide them: the player then only ever SEES multipliers on spins that collect them →
  // the global climbs every single time a multiplier is visible. Display-only; doesn't
  // change which multipliers count, so RTP is unchanged.
  if (allowMult && baseWin === 0)
    for (const st of steps) stripMults(cfg, st.grid);
  const mults = baseWin > 0 ? gridMultCells(steps[steps.length - 1].grid) : [];
  let scatterWin = 0;
  const sc = scatters >= 6 ? 6 : scatters;
  if (cfg.scatter.payX && cfg.scatter.payX[sc])
    scatterWin = Math.round(cfg.scatter.payX[sc] * bet);
  return { steps, baseWin, mults, scatters, scatterWin };
}

function modeForScatters(n) {
  if (n >= TRIG.hidden) return "hidden";
  if (n === TRIG.super) return "super";
  if (n >= TRIG.regular) return "regular";
  return null;
}
function retrigFor(n) {
  if (n >= 5) return 6;
  if (n === 4) return 4;
  if (n === 3) return 2;
  return 0;
}

// mode: 'base' | 'regular' | 'super' | 'hidden'. buy forces 'regular' or 'super' only.
function runRound(cfg, bet, buy) {
  const spins = [];
  let totalWin = 0,
    mode = "base",
    freeLeft = 0,
    freeAwarded = 0,
    freeTriggered = false;
  let globalMult = 1,
    superSum = 0;

  if (buy === "super") {
    mode = "super";
  } else if (buy === "regular") {
    mode = "regular";
  } else {
    const s = runSpin(cfg, bet, false, 1);
    totalWin += s.baseWin + s.scatterWin;
    const m = modeForScatters(s.scatters);
    spins.push({
      free: false,
      super: false,
      steps: s.steps,
      baseWin: s.baseWin,
      mults: [],
      multAdded: 0,
      scatterWin: s.scatterWin,
      scatters: s.scatters,
      total: s.baseWin + s.scatterWin,
      triggered: !!m,
    });
    mode = m || "base";
  }

  if (mode !== "base") {
    freeTriggered = true;
    freeLeft = SPINS[mode];
    freeAwarded = freeLeft;
  }
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
    let displayTotal = 0,
      added = 0,
      applied = 0;
    if (useGlobal) {
      // PROGRESSIVE global: a winning spin's multipliers raise the running global, then THIS
      // spin's win is paid at the current global. Climbing meter stays, but the payout is a
      // sum of (win × runningGlobal) instead of one giant end-multiply — far less swingy, so
      // the bonus breaks even / profits much more often (sum-of-products, not product-of-sums).
      if (s.baseWin > 0 && multSum > 0) {
        globalMult += multSum;
        added = multSum;
      }
      displayTotal = s.baseWin * globalMult + s.scatterWin;
      totalWin += displayTotal;
    } else {
      applied = s.baseWin > 0 && multSum > 0 ? multSum : 0;
      displayTotal = (applied ? s.baseWin * applied : s.baseWin) + s.scatterWin;
      totalWin += displayTotal;
    }
    const rt = retrigFor(s.scatters);
    if (rt) {
      freeLeft += rt;
      freeAwarded += rt;
    }
    spins.push({
      free: true,
      super: useGlobal,
      steps: s.steps,
      baseWin: s.baseWin,
      mults: (useGlobal ? added : applied) > 0 ? s.mults : [],
      multAdded: added,
      multApplied: applied,
      globalMult: useGlobal ? globalMult : 0,
      scatterWin: s.scatterWin,
      scatters: s.scatters,
      total: Math.round(displayTotal),
      retrigger: rt,
      freeLeft,
    });
    if (totalWin > cfg.maxWinX * bet) break;
  }

  // Progressive global is applied per-spin above, so there is no end-multiply. superMult=1
  // tells the client to skip the end-of-bonus multiply animation.
  const superMult = 1,
    superPre = 0;
  if (totalWin > cfg.maxWinX * bet) totalWin = cfg.maxWinX * bet;
  return {
    spins,
    totalWin: Math.round(totalWin),
    freeTriggered,
    freeAwarded,
    mode,
    superMult,
    superPre,
    globalFinal: globalMult,
  };
}

export function listGames() {
  return Object.values(GAMES).map((g) => {
    const sc = g.payScale || 1,
      pays = {};
    for (const k of Object.keys(g.pays))
      pays[k] = g.pays[k].map((t) => [t[0], Math.round(t[1] * sc * 100) / 100]);
    return {
      id: g.id,
      name: g.name,
      tag: g.tag,
      color: g.color,
      W: g.W,
      H: g.H,
      minCluster: g.minCluster,
      sym: g.sym,
      pays,
      buy: { regular: g.buyRegular, super: g.buySuper },
      scatter: {
        emoji: g.scatter.emoji,
        regular: TRIG.regular,
        super: TRIG.super,
        hidden: TRIG.hidden,
        spins: SPINS,
      },
      mult: { emoji: g.mult.emoji },
    };
  });
}
export function getGame(id) {
  return GAMES[id] || null;
}
export function spin(id, bet, buy) {
  const cfg = GAMES[id];
  if (!cfg) throw new Error("Unknown game");
  const b = buy === "super" ? "super" : buy === "regular" ? "regular" : false; // hidden not buyable
  return runRound(cfg, bet, b);
}
export function buyCost(id, kind) {
  const cfg = GAMES[id];
  if (!cfg) return Infinity;
  return kind === "super" ? cfg.buySuper : cfg.buyRegular;
}
export const SLOT_GAME_IDS = Object.keys(GAMES);

// Auto-price buy bonuses so their RTP ≈ target. Results are cached to a JSON file so the
// Monte-Carlo sims only run once (not every boot — that blocked startup for ~1s).
// The cache key includes the pay tables + reels so any tuning change invalidates it.
import {
  existsSync as _fsExists,
  readFileSync as _fsRead,
  writeFileSync as _fsWrite,
} from "node:fs";
import { fileURLToPath as _furl } from "node:url";
import { dirname as _dir, join as _join } from "node:path";
const _PRICE_CACHE = _join(
  _dir(_furl(import.meta.url)),
  "_pricebuys.cache.json",
);
function _priceCacheKey() {
  // Hash the pay tables + reels + mult configs into a key. Any tuning change → new key.
  const parts = [];
  for (const id of SLOT_GAME_IDS) {
    const g = GAMES[id];
    parts.push(
      id,
      g.payScale,
      g.maxWinX,
      g.scatter.chance,
      g.mult ? JSON.stringify(g.mult.table) : "",
      JSON.stringify(g.pays),
      JSON.stringify(g.reel),
    );
  }
  return parts.join("|");
}
function _priceBuys() {
  const key = _priceCacheKey();
  try {
    const cached = JSON.parse(_fsRead(_PRICE_CACHE, "utf8"));
    if (cached && cached.key === key) {
      applyPrices(cached.prices);
      return;
    }
  } catch {}
  // Cache miss → run the sims.
  const N = 30000,
    bet = 20,
    prices = {};
  for (const id of SLOT_GAME_IDS) {
    const cfg = GAMES[id];
    prices[id] = {};
    const TARGET = 0.96;
    for (const kind of ["regular", "super"]) {
      let sum = 0;
      for (let i = 0; i < N; i++) sum += runRound(cfg, bet, kind).totalWin;
      prices[id][kind] = Math.max(5, Math.round(sum / N / bet / TARGET));
    }
  }
  try {
    _fsWrite(_PRICE_CACHE, JSON.stringify({ key, prices }));
  } catch {}
  applyPrices(prices);
}
function applyPrices(prices) {
  for (const id of SLOT_GAME_IDS) {
    const cfg = GAMES[id],
      p = prices[id];
    if (!p) continue;
    if (p.regular) cfg.buyRegular = p.regular;
    if (p.super) cfg.buySuper = p.super;
  }
}
_priceBuys();
