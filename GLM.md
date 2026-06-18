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
  intentional** — the win is decided at spin, just paid later.
  - **Restart-safe (2026):** the pending win is ALSO persisted to Mongo (`psl` on the user
    doc) on spin and `$unset` on collect, so a web restart between spin and collect doesn't
    eat it. On boot, `recoverPendingSlots()` (gated on `stdb.ready()`) credits every leftover
    `psl`. So a win is paid even if the player never clicks/sees collect, across tab-close
    AND restarts. (Narrow residual: a re-spin within ~3s of boot can overwrite a leftover
    before recovery — negligible.)
- **Stateless house** (plinko/coinflip/double): deduct → resolve → `payWin` (creditWin with tax) in one call.
- **Stateful house** (mines/hilo/chicken) + **cards** (blackjack/baccarat): deduct at start, `payWin` on resolve/cashout.

---

## 3. Slots (`src/SlotEngine.mjs` + `games/slots.html` + `games/assets/css/slots.css`)

Cluster-pays tumbling slots. Orthogonal clusters of 5+ identical symbols (no diagonals).
Scatters trigger bonuses. **Two distinct bonus engines coexist** — multiplier (candy/olympus)
and Golden Square (bandit). The client is **engine-keyed** (`GAME.engine`), never game-id-keyed.

### Games & RTP
| id | name | grid | engine | base RTP | bonus model |
|---|---|---|---|---|---|
| `candy` | Candy Cascade | 6×5 | multiplier | ~87% | Regular per-spin / Super global mult |
| `olympus` | Thunder Gods | 6×5 | multiplier | ~86% | Regular per-spin / Super global mult |
| `bandit` | Wild Bandit | **6×5** | **bandit** | **~82%** | **Golden Squares + Rainbow + 3 tiers** |

Candy/olympus: `payScale`-tuned, reels concentrated for ~37% dead spins.
Bandit: 6×5, max win **10000×**, base RTP ~82% (bonus potential pushes blended toward 96%).

### Wild Bandit — Golden Square model (`engine: "bandit"`)
- **Camera scatter** `SC` (📷) triggers free spins: 3→`luck` (8), 4→`gold` (12), 5→`rainbow` (12).
- **Rainbow symbol** `RB` (🌈) lands on the grid; when present on the final settled grid it
  **activates** stored Golden Squares → each reveals a coin (Bronze/Silver/Gold band).
- **Golden Squares**: winning cells become gold (persist visually). A Rainbow reveals coins
  for gold squares added **since the last reveal** (`revealedSet` bounds the payout — a square
  pays once per time it's won, not every Rainbow). Persistence per tier:
  - `luck`: gold squares clear after a Rainbow reveals them (consumed).
  - `gold`: squares stay gold + revealed for the whole feature (won't re-pay unless re-won).
  - `rainbow`: guaranteed Rainbow every spin; squares persist throughout.
- **Coin bands** (per-reveal EV ~0.08× to keep RTP sane): Bronze 0.02–0.12× (w1000),
  Silver 0.5–2× (w40), Gold 5–50× (w1.5). A Rainbow FeatureSpin boosts coins ×3.
- **Retriggers**: 2 cams +2, 3 cams +4 spins.
- **4 paid entries** (`cfg.buys`, all auto-priced to ~96%): FeatureSpins (5× scatter odds),
  Rainbow Spins (forced RB + 3× coins), Luck direct, Gold direct. FeatureSpins/Rainbow are
  **single base spins** (priced by single-spin EV, not full-round).
- `runBanditRound` emits the standard envelope `{spins, totalWin, freeTriggered, freeAwarded,
  mode, superMult:1, ...}` plus per-spin `gold[]`, `reveal[{pos,tier,val}]`, `rainbow`, `coinWin`.
  `spin()`/`buyCost()`/`listGames()` dispatch on `cfg.engine === "bandit"`.

(payScale ~doubled vs the dead-spin pass because the progressive-global change — below — cut
bonus payouts ~4×, so payScale was raised to restore overall ~87% RTP. Mult tables also
compressed: `chance .17/.17/.19`, table `[[2,52],[3,34],[5,11],[10,3],[25,.9]]`.)

### Super/Hidden bonus was too swingy to ever profit → PROGRESSIVE global (key fix)
Symptom: buying Super "never profits" (owner hit 3 busts). Measured: only **27% profit, 45%
return <0.5× cost, median 0.56×**. Cause: payout was `superSum × globalMult` (product → huge
right-skew), and the dead-spin retune made base wins tiny (`superSum` mean ~1.4× bet) while
`globalMult` ballooned (mean ~85, CV .44) — so the bonus was "tiny base × giant end-multiply,"
maximally swingy. Raising RTP barely helps (skew means even a fair 100%-RTP bonus profits
~32%); compressing the mult table does **nothing** to the shape (return/cost is scale-
invariant — the buy cost just re-prices). Regular bonus (per-spin multiply = sum-of-products)
was already far healthier (33% profit, median 0.72×). **Fix: Super/Hidden now apply the global
PROGRESSIVELY** — each winning free spin raises the running global, then that spin's win is paid
at the current global (`displayTotal = baseWin*globalMult + scatter`, accumulated; **no
end-multiply**, `superMult` returns 1 so the client skips `endMultiply`). Sum-of-products, not
product-of-sums → far less skew. Result: Super now **~32% profit, ~36% bust, median ~0.69×**
(matches Regular) while the climbing global meter is preserved. Client: per winning Super spin,
climb `#gmult` then pop `#winMeter` to `runningBefore+sp.total` (the win is already multiplied);
intro/paytable text changed from "applied at the end" → "boosts every win for the rest of the
bonus." NOTE: progressive cut bonus value ~4× → base RTP cratered to ~49%; restored by
~doubling payScale (above). Buy costs auto-re-priced (super ~296×→~70×).

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

- First pass: ~69%→~53% dead (candy/olympus), ~76%→~63% (bandit).
- **Second pass (2026, "prefer small hits over dead spins"):** concentrated the top symbols
  harder (candy/olympus reel `90/68/50/26/14/8/4`, bandit `105/76/52/26/13/7/4`) and dropped
  payScale to hold RTP. Now **~37.6% dead candy/olympus, ~40% bandit**; small hits (0–1× bet)
  ~58% (candy/olympus) / ~50% (bandit). Board alive ~60% of spins, mostly small wins.
- Method that works every time: **concentration sets dead% (and spikes RTP via bigger
  clusters); payScale then scales RTP back to ~87% linearly without touching dead%.** Don't
  over-concentrate (my first attempt `120/90/58/...` → 26% dead but RTP 298% and huge 10–15
  clusters; payScale-down then makes hits trivially tiny). The `90/68/50/26/14/8/4` level is
  the sweet spot for 6×5.
- A 5×5 grid (bandit) clusters less than 6×5, so it stays ~3pts higher dead-rate — inherent.
- RTP is heavy-tailed: single 800k runs swung olympus/bandit to 92–93%; the true mean over
  **3M** is 87.8 / 88.5 / 89.3% (candy/olympus/bandit). Measure ≥3M before trusting a base RTP.

### Client animation model
- Grid = `W×H` `.cell` divs (`#cell-{i}`, row-major). `.sym` child holds the emoji HTML.
- `symHtml(s)` is engine-aware: handles `SC` (scatter glow), `RB` (rainbow glow, bandit),
  `M:N` (multiplier badge), and falls back to `GAME.sym[s]` or ❔.
- **Bandit Golden Square render**: `paintGold(indices)` toggles `.cell.gold` (shimmering gold
  tile behind the symbol). `revealCoins(reveals)` spawns `.coin-fly.{tier}` chips that fly
  from each gold cell to `#winMeter`. Both fire in `animateSpin` after the tumble settles,
  gated on `GAME.engine==='bandit'`. Gold cleared on new round (`doSpin`).
- **Buy bar**: candy/olympus use the 2-button `.buy-col`; bandit uses a 4-button `.buy-row`
  built by `renderBuyBar()` from `GAME.buys`. `doSpin`/`setControls` handle both.
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
  per-step `win`/`pop`/`tumbleFall` loop → **render the final no-win step's grid**
  (it holds surviving multipliers — see bug note) → multiplier reveal.

### Multiplier-reveal bug (fixed)
In a Super/Hidden bonus, surviving multiplier symbols (`🪙`/`🍬`/`💵`) live on the
**final no-win step's grid** (the tumble loop always terminates by pushing a `{wins:[]}`
step; `mults` are extracted from that grid). The client's win loop `break`s on that
no-win step **before rendering it**, so the multiplier symbols were never on screen when
`flyMults` ran → they flew from the wrong position / looked like they "didn't add."
Fix: after the win loop, render `sp.steps[last].grid` before the reveal
(`if(lastRendered < steps.length-1) renderGrid(...)`). Server math was correct all along
(winning spins always bank multipliers); only the visual was broken.

Note: multipliers are intentionally **not** banked on zero-win spins — a multiplier with
nothing to multiply is discarded (standard cluster-slot rule). Tested banking them
unconditionally but it pushed base RTP to ~140% and made tuning intractable; reverted.

### Regular-bonus multiplier was applied but invisible (fixed)
On a winning Regular-bonus spin the server multiplied the win correctly
(`displayTotal = baseWin * multSum`, paid in `totalWin`) but the spin object only carried
`multAdded` (set **only** in the Super/Hidden global branch → `0` for Regular) and never
`multApplied`. The client's per-spin reveal checks `sp.multApplied>0`, so the ×N never
animated and the win meter just silently jumped — looked like "the multiplier didn't add."
Fix: server now sends **both** `multAdded` (global accrual) and `multApplied` (per-spin
multiply), and attaches `mults` only when one applies. Client reveal fires for **any**
spin with `multApplied>0` (not just `free`) and pops `#winMeter` to `runningBefore+total`.
All multipliers on the board count regardless of placement — they always survive the
tumble to the final grid, where `gridMultCells` reads them. Math/RTP unchanged
(~89.7/87.2/86.9% candy/olympus/bandit); this was purely a reveal/field-plumbing fix.

### Pages were uncached-busted → stale inline `<script>` (likely root cause of "fix didn't work")
`renderPage` reads the page fresh server-side and `?v=`-busts only `/assets/*.css|js`. The
page's **inline `<script>`** had **no cache-bust and no `Cache-Control`**, so the
browser/Cloudflare could serve a stale `slots.html` with old JS — client-side fixes silently
never reached the user after a deploy. Fix: `renderPage` now sends
`Cache-Control: private, no-cache, no-store, must-revalidate` on every rendered page. After
any page edit, a normal reload now gets fresh inline JS (no hard-refresh needed). **Locked
design: all bonuses keep the split (Regular per-spin, Super/Hidden global) — global-in-all
spiked RTP to ~174%, reverted.**

### Multipliers shown on NON-winning bonus spins looked "inconsistent" (root cause + fix)
A multiplier only counts on a spin that itself has a winning cluster (placement irrelevant —
mults survive the tumble to the final grid; verified 0 misses in ~30k winning spins, natural
+ buy, super + hidden). But multipliers also *spawned and rendered on non-winning spins*
(`mult.chance` per cell, ~3/grid), where they correctly don't count → the player sees a
multiplier on the board but the global meter doesn't move ("sometimes it adds, sometimes
not"). Real-bonus trace confirmed it: global climbs only on `baseWin>0` spins, flat on the
common no-win spins that still showed mults. Collect-all (count them anyway) was rejected by
the owner AND spikes RTP to ~174%. Fix: **`runSpin` strips multipliers from the displayed
grids of any spin with `baseWin===0`** (`stripMults` — replaces each mult with a reel symbol
that differs from its orthogonal neighbours so it can't fake a cluster; client never
re-evaluates). Now every multiplier the player SEES is on a winning spin and always collects
into the global → consistent. Display-only: which mults count is unchanged, so **RTP is
unchanged** (~87%). Design locked: Regular = per-spin multiply, Super/Hidden = global.

### Super/Hidden global multiplier — verified + hardened (client)
Rule (confirmed with the owner): on a **winning** spin (`baseWin>0`), **every** multiplier
on the board adds to the global, regardless of placement; multipliers on **non-winning**
spins do **not** count (briefly tried collect-all → reverted, it's not the wanted design).
Simulated 3000 super rounds × 3 games (~30k winning spins): **every** winning spin that
shows a multiplier yields `multAdded>0` → server math is 100% correct; the global and the
paid `totalWin` (`superSum*globalMult`) already include it. The "didn't add on screen"
report is therefore client/deploy-side: hardened `animateSpin` so the super reveal fires on
`multAdded>0` alone, recomputes mult positions from the final grid if `sp.mults` is empty
(`gridMults()`), and force-syncs `#gmultVal` to `sp.globalMult` so the meter can never
silently skip. NOTE: the page HTML is browser/Cloudflare-cached — after deploy the client
must hard-refresh (Ctrl/Cmd+Shift+R) to pick up new inline `<script>`.

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

- Single-writer price engine in `web/server.ts`. **Realistic market model** (not a fixed
  mean-reverting anchor): a shared **market factor** (`mktDrift`) moves all assets together,
  per-asset **momentum** (`mom`, autocorrelated returns → trends), **volatility clustering**
  (`volState`, GARCH-lite — |shock| raises near-future vol, decays to base), and a
  **drifting fundamental** (`baseline` random-walks toward price, not a fixed rubber-band).
  Demand `bias` from trades is a transient shove. Bounded ±14%/tick, 2% fee sink.
  `INVEST_TICK_MS = 25_000`. Validated: positive autocorrelation (trending), positive
  cross-asset correlation, no systematic floor/ceiling slides over 2k-tick multi-seed runs.
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

### Owner bank tools (2026) — `/servers` "Bank tools" dialog (`openBankTools`)
**Servers tab UI (reworked 2026):** compact cards (300px min). The bank + tax share one row
(tax inline as a chip). Six stat tiles in two rows of 3. All management actions (Shop, Bank,
Tax, Edit bank, Join link, Cases, Verify) are a **single horizontal icon action bar**
(`.svc-actions` → `.svc-act` chips) instead of 7 stacked full-width buttons — ~60% less
vertical footprint per card. `actBtn(cls,title,label,svgPath,onclick)` builds each chip;
color variants: `primary` (shop), `gold` (bank), `blue`/`danger` (verify/unverify).

Server OWNER (or a `servers` admin) can, from the Servers dashboard:
- **Bank → bank**: `POST /api/server/bank/transfer {fromGid,toGid,amount}` — `bankSpend(from)` +
  `creditWin(uid, amount, toGid, amount)` (the credit_win-as-bank-add trick: owner nets 0,
  dest bank += amount). No fee.
- **Withdraw → own wallet**: `POST /api/server/bank/withdraw {gid,amount}` — `bankSpend(gid,amount)`
  + `credit(uid, amount−5%)`. **5% fee is a sink**, **50k FC/day cap per owner** (Mongo `bwd={d,t}`
  ledger on the user doc, `bankWithdrawnToday`/`recordBankWithdraw`).
- **Pay all members**: `POST /api/server/bank/distribute {gid,amount}` — pays every registered
  user (`db.getGuildUserIds(gid)` = users with `gid` in `gids`) `amount` each; checks
  `bank ≥ amount×N`, `bankSpend(total)` then `credit` each in the background.
- All built from EXISTING reducers (no Rust redeploy). All owner/admin-gated, amount-validated,
  capped at `MAX_DELTA` (1e9), `rlBankOps`-throttled, audit-logged. Bank balances re-push via the
  existing STDB `server_bank` subscription.

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
8. **Slot multiplier reveal**: winning spins always bank multipliers server-side, but the
   client's win-loop `break`ed on the final no-win step **before rendering it** — so the
   surviving multiplier symbols were never drawn when `flyMults` ran. Fix: render
   `steps[last].grid` after the loop. (Design locked: multipliers only count on winning
   spins; banking on all spins spiked RTP to ~140-174%.)
9. **Invest market model rework**: replaced the fixed mean-reverting anchor with a realistic
   model — market factor (assets correlate), momentum (trends), vol-clustering (calm/spike
   regimes), drifting fundamental. Validated via 2k-tick multi-seed sims. Bounded ±14%/tick.
10. **Servers tab rework**: stacked 7 full-width buttons → single horizontal icon action bar;
    bank+tax merged into one row; 300px min card width. ~60% less vertical footprint.
11. **Wild Bandit rework (Golden Squares)**: replaced the multiplier model with a distinct
    engine — 6×5, camera scatters (3/4/5 → luck/gold/rainbow tiers), Rainbow symbol reveals
    coin values from accumulated Golden Squares. 4 paid feature buys (FeatureSpins, Rainbow
    Spins, Luck, Gold). Candy/olympus untouched. Key tuning lesson: a Rainbow revealing ALL
    gold squares blew RTP to 1212%; fixed by `revealedSet` (a square pays once per win, not
    per Rainbow) + low per-reveal coin EV (~0.08×). Base RTP ~82%, buys ~96%.
    Client: `paintGold`/`revealCoins`/4-button buy bar; server `/api/slots/spin` buy-id
    validation now checks `buyCost` instead of hardcoding super/regular.

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
