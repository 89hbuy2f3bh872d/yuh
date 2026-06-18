# GLM.md — Project Knowledge & Context

A living memory of the **SirGreen Casino** codebase (Discord/Fluxer bot + web app) as
understood across working sessions. This complements `CLAUDE.md` (the canonical context)
with deeper "how it actually works / gotchas / decisions" notes. **Read `CLAUDE.md`
first**, then this.

---

## 0. TL;DR

- Two processes under PM2: `sirgreen-bot` (Node `index.mjs`) + `sirgreen-web` (Bun/Elysia `web/server.ts`).
- Two databases with **strict ownership**: **SpacetimeDB** owns the money ledger
  (balances, transactions, server banks); **MongoDB** owns everything else (users,
  sessions, guilds, stats, shop, assets, holdings).
- All game outcomes are **server-authoritative**; the client only animates.
- Pages are static `.html` in `games/`, each with scoped `<style>` + inline `<script>`,
  navigated via **pjax** (the runtime lives in `games/partials/sidebar.html`).
- Local dev box (Windows): **no `spacetime` CLI, no Bun, no `module_bindings/`** —
  validate with `node --check` (`.mjs`), `cargo check` (`spacetimedb/`), and
  `new Function(scriptText)` parse-checks on page `<script>` blocks.

---

## 1. Architecture at a glance

```
Discord ──> Node bot (index.mjs) ──localhost /internal/*──> Bun web (web/server.ts) ──ws──> SpacetimeDB
                  │                                              │
                  └──────────────── MongoDB (src/Database.mjs) ──┘
Browser ──HTTPS(Cloudflare)──> Bun web ──> STDB (balances) + Mongo (rest)
```

- `web/server.ts` is the core (~1470 lines): all HTTP routes, sessions, money endpoints,
  OAuth, the realtime WebSocket hub, and the investing price engine.
- `web/src/stdb.ts` is the single STDB connection: reducers + table subs + caches.
- `src/Database.mjs` is the Mongo layer, **shared by both processes** (Bun runs `.mjs`).
- The bot never touches STDB directly — it delegates to the web service via
  `src/stdbBridge.mjs` (loopback-only `/internal/*`).

### Process responsibilities (do not cross these lines)
| Concern | Owner |
|---|---|
| Balances, transactions, server banks, notifications | **STDB** (`spacetimedb/src/lib.rs`) |
| Users, sessions, guilds, serverstats, shop, tickets, cases, assets, holdings | **Mongo** (`src/Database.mjs`) |
| HTTP routing, sessions, money endpoints, WS hub, invest engine | `web/server.ts` |
| Discord chat commands | `commands/*.mjs` |

---

## 2. Money model (the trust anchor)

The STDB ledger is **atomic, clamped to `[0, MAX_BALANCE]`, non-negative, per-op-capped**.
No minting or double-spend is possible there. `lib.rs` consts:

- `MAX_BALANCE = 1e12`, `MAX_DELTA = 1e9` (per-op cap), `STARTER_BALANCE = 1000`.
- Reducers reject `amount <= 0`, enforce `tax <= payout` / `tax <= gross`, `balance >= bet`.

### Reducers in use
`ensure_account`, `credit`, `deduct`, `settle(owner,bet,payout)`,
`settle_win(owner,bet,payout,gid,tax)`, `credit_win(owner,gross,gid,tax)`,
`transfer`, `set_exact`, `bank_spend(gid,amount)`, `bank_set(gid,balance)` (unused by web),
`add_notification`, `mark_read`.

### STDB SDK specifics (hard-won, see CLAUDE.md §3)
- Builder uses `withDatabaseName` (NOT `withModuleName`).
- Reducers called with an **object of camelCase args**: `conn.reducers.settleWin({ owner, bet, payout, gid, tax })`.
- **Casing asymmetry:** reducers camelCase (`settle_win` → `settleWin`), but **table accessors may stay snake_case** (`server_bank` → `conn.db.server_bank`). `stdb.ts` resolves the bank table defensively: `#bankTable()` tries `serverBank ?? server_bank ?? serverbank`.
- **Subscribe each table separately** — a multi-query `.subscribe([...])` previously failed to apply the second table.
- BigInt: i64 reducer args passed as `BigInt(...)`; cached values normalized with `Number()`.

### Money flow per game family
- **Slots** (pay-on-collect): `stdb.deduct(uid, cost)` at spin → win held in in-memory
  `pendingSlots` Map → `stdb.creditWin(uid, win, gid, tax)` at `/api/slots/collect`
  (when the animation finishes). A 60s sweep credits stale wins so a closed tab never
  loses one; the next spin also auto-collects the previous. **This in-memory hold is
  intentional** — the win is decided at spin, just paid later. (Moving it to a STDB
  table is deploy-gated: needs VPS `spacetime publish` + `spacetime generate`; gains
  nothing since money is already atomic in STDB at both ends.)
- **Stateless house** (plinko/coinflip/double): deduct → resolve → `payWin` (creditWin with tax) in one call.
- **Stateful house** (mines/hilo/chicken) + **cards** (blackjack/baccarat): deduct at start, `payWin` on resolve/cashout.

---

## 3. Slots (`src/SlotEngine.mjs` + `games/slots.html` + `games/assets/css/slots.css`)

Cluster-pays tumbling slots. Orthogonal clusters of 5+ identical symbols (no diagonals).
Scatters trigger bonuses; multiplier symbols feed bonuses.

### Games & RTP (tuned for fewer dead spins — see note below)
| id | name | grid | payScale | reel (common→rare weights) | base RTP (500k) | dead% |
|---|---|---|---|---|---|---|
| `candy` | Candy Cascade | 6×5 | 1.13 | 60/52/44/26/16/9/5 | ~88.8% | ~54% |
| `olympus` | Thunder Gods | 6×5 | 1.10 | 60/52/44/25/16/9/5 | ~87.6% | ~53% |
| `bandit` | Wild Bandit | 5×5 | 1.96 | 58/50/42/26/16/9/5 | ~86.1% | ~63% |

- Buy-bonus costs are **auto-priced** at load (`priceBuys()` IIFE) for ~87% RTP via a
  30k-sample Monte Carlo per game/kind. **Buy RTP measured ~86-89%** — correctly priced.
- **There is NO adaptive/progressive/dynamic rigging.** `spin(id, bet, buy)` is pure and
  stateless — a big win does not change future odds. "Win big then get nothing" is just
  base-rate variance.
- RTP has wide measurement variance (±2-3% even at 200k spins) due to the heavy-tailed
  bonus distribution. Always measure with **N ≥ 500k** before tuning.
- `payRows(a,b,c,d)` builds the 4-tier cluster-size table `{15+, 10+, 8+, 5+}` × `payScale`.

### Dead-spin tuning (the key lesson)
**Dead-spin rate is driven by reel weighting, NOT payout amounts.** Raising payScale/payouts
makes wins bigger but does NOT reduce dead count (clusters form at the same frequency).
To cut dead spins you must **concentrate the reel weights toward common symbols** so they
cluster more readily, then **lower payScale** to keep RTP flat (~88%).

- Pre-tuning: ~69% dead (candy/olympus), ~76% dead (bandit, 5×5 grids cluster less).
- Post-tuning: ~53% dead (candy/olympus), ~63% dead (bandit). Tiny wins (0 < win < 1× bet)
  went from ~19% → ~38%, so the board feels alive far more often.
- A 5×5 grid (bandit) clusters less than 6×5, so it stays ~10pts higher dead-rate — inherent.

### Client animation model
- Grid = `W×H` `.cell` divs (`#cell-{i}`, row-major). `.sym` child holds the emoji HTML.
- `animateFall(cells, fall[], delays[], dur)` — the core: places each cell's symbol,
  sets `translateY(-fall*unit)` start, commits, then transitions to `translateY(0)`.
  **Resets `opacity='1'`** (important after a spin-out).
- `dropGrid(cells)` — spin drop-in: **columns** from the top, **left→right** (mirrors the
  spin-out, which clears right→left); within a column cells cascade top→bottom.
- `tumbleFall(next, removed)` — win-tumble: survivors fall into holes, new symbols drop
  from above; vertical gravity, settles bottom→top within each column.
- `spinOut()` — pre-spin clear: tumbles the **whole board down out of frame, one COLUMN at
  a time (right→left)** — mirrored by `dropGrid`, which fills left→right. Within a column
  the bottom cell leaves first, cascading up. **No opacity fade** — cells keep their symbol
  and slide off the bottom. Skipped when the board is empty.
- `animateSpin` flow: `clearFx()` → `spinOut()` (if content) → `dropGrid(step0)` →
  per-step `win`/`pop`/`tumbleFall` loop → multiplier reveal.

### UI/UX notes (post-overhaul)
- Recessed "glassy" reel window (`.reel-stage`): inner shadows, top sheen, bottom vignette
  so symbols sit behind glass. `overflow:hidden` clips spin-out cells at the bottom edge.
- Cells: gradient + inner bevel + symbol drop-shadow. Win cells glow + pulse; dim cells
  desaturate. `cellFall` keyframe uses a soft settle easing (not an aggressive bounce).
- Tactile controls: gradient buttons with press/glow states. Lobby cards lift on hover.

---

## 4. House games (`src/HouseGames.mjs` + `games/house.html`)

Plinko/Coinflip/Double = **stateless**; Mines/HiLo/Chicken = **stateful** (per-uid state
in `HouseState` Maps). `EDGE = 0.97` (~3% house edge).

### Cash-out-with-nothing = cancel + refund (design invariant)
Cash out with zero progress must **refund the stake**, never strand the bet. Implemented as:
- `*Cashout(uid)` returns `{ cancelled: true, refund: bet, ... }` when no progress
  (chicken: `step < 1`; mines: no reveals; hilo: `mult <= 1`), and deletes the game.
- Route handler does `stdb.credit(uid, r.refund)` on cancel.
- `*RefundIfOpen(uid)` helpers refund a stranded open game at `start` (before deducting
  the new bet), so starting a new game never silently drops an open stake.

### Per-game math
- **Plinko**: 13 buckets, 12 rows, risk tables (low/med/high). Multi-ball (up to 10 drops).
- **Coinflip**: 1.96× win, ~2% edge.
- **Double or Nothing**: 49% win for 2×.
- **Mines**: 25 tiles, 1-24 mines. Mult = `∏ (25-i)/((25-m)-i) × EDGE`.
- **HiLo**: 13 ranks, higher-or-equal/lower-or-equal. `EDGE / pHi`, `EDGE / pLo`.
- **Chicken Road**: 18 lanes, each lane's car-chance 10-50% rolled at start. Cumulative
  mult = `EDGE × ∏(1/(1-death_i))` — edge taken once at entry, then fair per cross.

---

## 5. Investing (`web/server.ts` engine + `games/invest.html`)

- Single-writer price engine in `web/server.ts`: mean-reverting random walk + demand `bias`,
  bounded, 2% fee sink (net-deflationary). `INVEST_TICK_MS = 25_000`.
- Assets + holdings in Mongo (`assets`, `holdings` collections). Holdings shape:
  `{ _id: uid, h: { [assetId]: { u: units, c: costBasis } } }`.
- `investTick()` broadcasts `{ type:'prices', assets:[{id,price,prev}] }` over WS to ALL
  sockets — **prices only, no portfolio**.
- **Portfolio updates live client-side** via `livePortfolio(priceMap)` in `invest.html`:
  holdings only move on a trade (→ `load()`), but mark-to-market value recomputes from
  cached `window.__PF` positions + fresh prices each tick. No server round-trip needed.
- `synthHist()` backfills believable price history so the chart has a curve immediately
  (avoids "No price history yet" on fresh assets).
- Bot trades via `/internal/invest/*` (`investMe`, `investTrade`).

### CSS gotcha (fixed)
`.iv-chart-empty{display:grid}` overrode the UA `[hidden]{display:none}` (author > UA),
so the overlay stayed visible over a drawn chart AND swallowed canvas mouse events
(killing the hover crosshair). Fix: `.iv-chart-empty[hidden]{display:none}`.

---

## 6. Realtime / WebSocket

One socket per tab at `/ws`. The **central WS client lives in `sidebar.html`** (persistent
across pjax) and re-dispatches every message as a DOM event:
`window.dispatchEvent(new CustomEvent('sg:ws', { detail }))`. Pages subscribe with
`window.addEventListener('sg:ws', ...)`.

Message types: `init`, `balance`, `notification`, `ticket`, `bank`, `server-play`,
`server-econ`, `guild`, `servers`, `prices`, `auth`.

### pjax gotchas
- A page's inline `<script>` re-runs on **every** nav into it. Guard listener
  registration with a `window.__flag` (e.g. `if(!window.__ivWs)`), but let render/`load()`
  re-run.
- Scripts matching `/__pjax|__bgHex|__notif|__srvSel/` are the persistent runtime and
  are NOT re-executed.

---

## 7. Sessions / auth

- OAuth via Fluxer (`/login` → `/oauth/callback`). `oauthStates` map (10-min, single-use) for CSRF.
- Cookies: `sid` + `uid` (httpOnly), `dtag` + `dav`, `srv` (selected server).
  Set via `setAuthCookies(cookie, isHttps(request), {...})` — `Secure` only over HTTPS.
  Sessions = 2h TTL.
- **Token must match `/^[a-f0-9]{24,128}$/`** before Mongo field-path use (`isSessionToken`).
- **LOGIN-LOOP LESSON:** never put the same field path in both `$set` and `$unset`
  (Mongo rejects the whole update). OAuth callback always `createSession` (upsert) +
  revokes the old session separately.
- `&web` command mints a one-time login token → `/s/:token` logs in + selects that guild.

---

## 8. Multi-tenant economy

One **global balance** per user; the **selected server** (`srv` cookie) decides tax/stats.
Tax is on **PROFIT only** (winnings above stake). Default 1500 bps (15%), cap 5000, floor 1500.

- **Gate:** can't gamble without a selected server. `requireServer(request, uid)` validates
  the `srv` guild exists AND the user is a member (don't weaken — was a critical vuln).
- **Tax holiday** (shop perk): effective tax = 0 while active.
- **Server bank** (STDB `server_bank`): accrues tax. Owner/admin perks spend it.
- Tax comes FROM winnings → `stdb.creditWin(uid, payout, gid, tax)` routes it to the bank.
- `taxOnProfit(profit, bps)` = `min(profit, floor(profit*bps/10000))`.

### Permissions (`AdminPanel.PERMS`)
`balances`, `cases`, `battles`, `users`, `tickets`, `tax`, `servers`. `OWNER_ID`
(config.owners[0]) has all. `isAdmin` = owner or any perm. All admin/server endpoints
re-check permissions **server-side**.

---

## 9. Elysia/Bun gotchas (see CLAUDE.md §4)

- **No top-level `await`** in `web/server.ts` (PM2's bun-fork `require()`s the entry).
  Use `.then()` chains for background init.
- `set.redirect` NOT honored → use `redir(set, url)` helper (manual 302).
- Set-Cookie via raw headers doesn't stick → use Elysia **`cookie`** API.
- Static files via `Bun.file(path)`. WS upgrade reads cookie via `.derive()`.
- **Watch for duplicate `const` in the same handler scope** — Bun fails to parse → PM2
  crash-loop. Scan for it after editing `server.ts`.

---

## 10. Local validation checklist (no Bun/STDB locally)

```bash
node --check src/HouseGames.mjs          # any .mjs
node --check src/SlotEngine.mjs
cargo check                               # in spacetimedb/
# page <script> parse check:
node -e "const fs=require('fs');const h=fs.readFileSync('games/slots.html','utf8');[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].forEach((m,i)=>new Function(m[1]));"
# RTP measurement (large N — slots are high-variance):
node --input-type=module -e "import {spin} from './src/SlotEngine.mjs'; const N=300000,B=20; let t=0; for(let i=0;i<N;i++)t+=spin('candy',B,false).totalWin; console.log('RTP',(t/(B*N)*100).toFixed(2)+'%');"
```

---

## 11. Deploy

- **Web/page/bot only** (no Rust): `pm2 restart sirgreen-web` (+ `sirgreen-bot` if
  `index.mjs`/`CommandHandler.mjs`/`Database.mjs`/`stdbBridge.mjs` changed). Pages are
  static — asset `?v=` cache-bust is automatic.
- **STDB module change**: `cd spacetimedb && spacetime publish -s local sirgreen-6ls47 &&
  spacetime generate --lang typescript --module-path . --out-dir ../web/src/module_bindings &&
  pm2 restart sirgreen-web`. Additive migrations (new table/reducer) don't wipe.
- `module_bindings/` is generated **on the VPS only** — not in the repo, not on dev box.
- Cloudflare fronts the origin (Bun on :80), passes WebSockets automatically.

---

## 12. Session-specific decisions & fixes (for continuity)

1. **Chicken Road viewport** (`.cr-view`): had no width → flex-shrank to the full ~1840px
   track width inside the centered `.hg-board`, clipping the START lane + chicken.
   Fix: `.cr-view{width:100%}`.
2. **Invest chart overlay**: `display:grid` beat `[hidden]` → stuck visible, blocking hover.
   Fix: `.iv-chart-empty[hidden]{display:none}`.
3. **Invest portfolio realtime**: prices stream but portfolio didn't refresh. Fix:
   `livePortfolio(priceMap)` recomputes mark-to-market client-side each tick.
4. **Cash-out-with-nothing**: used to strand the bet. Now refunds via STDB in all games.
5. **Slot spin-out animation**: was a column-ripple with opacity fade. Now a clean
   win-tumble-style fall-down-out-of-frame (no fade), matching the hit cascade feel.
6. **Slot RTP**: olympus `payScale` 2.28 → 2.36 (84% → ~88%). candy/bandit verified fair.
   Confirmed **no adaptive rigging** — `spin()` is pure/stateless.
7. **Slot dead-spin reduction**: concentrated reel weights toward common symbols (so they
   cluster more often) + lowered payScale to keep RTP ~88%. Dead spins dropped ~69%→53%
   (candy/olympus), ~76%→63% (bandit). Key insight: dead-rate is a reel-weight problem,
   not a payout problem.

---

## 13. Conventions & standing constraints (from CLAUDE.md §8)

- Game outcomes server-authoritative + non-exploitable.
- STDB owns money; Mongo owns the rest. Never write balances to Mongo.
- Rate-limit money endpoints: `rl(map, key, ms)` + per-IP global limiter. Plinko = 50ms.
- Icons: Lucide first. Emoji only for playful content.
- Escape user-controlled strings (`esc()` server-side, page-local `esc()` client-side).
  Validate hex (`safeHex`/`HEX_RE`), uids (`/^\d{17,20}$/`), guild ids, amounts.
- No global music — per-slot themes only; mutable.
- `/internal/*` is loopback-only + shared-secret; rejects `cf-connecting-ip`/`x-forwarded-for`.
