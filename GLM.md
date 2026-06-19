# GLM.md — Project Knowledge & Context

A living memory of the **SirGreen Casino** codebase (Discord/Fluxer bot + web app) as
understood across working sessions. This complements `CLAUDE.md` (the canonical context)
with deeper "how it actually works / gotchas / decisions" notes. **Read `CLAUDE.md`
first**, then this.

---

## 0. TL;DR

- Two processes under PM2: `sirgreen-bot` (Node `index.mjs`) + `sirgreen-web` (Bun/Elysia `web/server.ts`).
- **ONE database: SpacetimeDB** — owns the ENTIRE datastore (balances, banks,
  notifications, profiles, sessions, guilds, stats, holdings, assets, tickets, rakeback,
  login tokens, command stats, custom tiers). MongoDB was fully migrated out
  (`scripts/migrate-to-stdb.mjs`); the running app no longer touches Mongo.
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
Browser ──HTTPS(Cloudflare)──> Bun web ──ws──> SpacetimeDB (the entire datastore)
```

- `web/server.ts` is the core (~1150 lines): all HTTP routes, sessions, money endpoints,
  OAuth, the realtime WebSocket hub, the investing price engine, AND the single STDB conn.
- `web/src/stdb.ts` is the single STDB connection: reducer wrappers + per-table subs +
  in-memory caches for **every** table.
- `src/Database.mjs` is a thin **facade** over STDB (web: `{stdb}`) or the web's
  `/internal/*` API (bot: `{http}`) — same method names as the old Mongo layer.
- The bot runs **no DB client**; it delegates every data op to the web via `/internal/*`
  (loopback + shared secret). `src/stdbBridge.mjs` is deleted.

### Process responsibilities
| Concern | Owner |
|---|---|
| **The entire datastore** (balances, banks, notifications, profiles, sessions, guilds, serverstats, shop, tickets, cases, assets, holdings, rakeback, login tokens, command stats) | **STDB** (`spacetimedb/src/lib.rs`) |
| HTTP routing, sessions, money endpoints, WS hub, invest engine, STDB connection | `web/server.ts` + `web/src/stdb.ts` |
| Data facade (parse JSON blobs, cache reads, reducer calls) | `src/Database.mjs` |
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
| `candy` | Candy Cascade | 6×5 | multiplier | **~96%** | Regular per-spin / Super global mult |
| `olympus` | Thunder Gods | 6×5 | multiplier | **~96%** | Regular per-spin / Super global mult |
| `bandit` | Wild Bandit | **6×5** | **bandit** | **~96.3–96.4%** | **scatter-pays + Golden Squares + Collectors, 3 tiers** |

Candy/olympus: **~96% RTP**. Reels concentrated HARD (`140/95/58/22/10/5/3`, `payScale 0.39`)
→ **dead spins ~18.6%** (was ~37%), **small hits ~72.5%** — "prefer small hits over dead
spins". `SPINS.super 16 / hidden 18` (was 12/15) + mult table capped at ×10 (`[[2,54],[3,33],
[5,10],[10,3]]`, dropped the ×25): steadier bonus → **Super buy now profits ~39% / busts ~19%
/ median 0.86×** (was 37% / 32% / 0.76×). Concentrating the reel cuts dead spins AND smooths
free-spin wins in one move; `payScale` then holds RTP. Bandit: own engine, max win **10000×**.

> **RTP rounding trap (cost me hours):** per-win pays were `Math.round(x*bet)`. With the
> concentrated reel the dominant win is the blue 5-cluster (pay 0.2). At bet 20,
> `round(0.2·payScale·20)=round(payScale·4)` flips 1→2 exactly at payScale 0.375 → a **20% RTP
> cliff** (84%↔109%) over a 0.005 payScale step, with ZERO cap hits. Fix: `evaluate` keeps the
> win **fractional**; only the round TOTAL is rounded (`runRound` already does). Now RTP is
> bet-independent (96.2% at bet 20 / 100 / 2000). Measure RTP at a HIGH bet (≥2000) to see the
> true value — low-bet integer rounding lies.

### Wild Bandit = "Le Bandit" engine (`engine: "bandit"`) — full rebuild 2026
**Scatter-pays, NOT clusters.** 5+ of a symbol ANYWHERE wins (`banditEval` counts each symbol;
the **Wild** 🃏 counts toward every symbol). Super Cascade removes ALL of every winning symbol
(+ wilds); refill drops in. Per-symbol minimum counts (lows pay only at 10/12+, premiums at 5+)
keep PAYING wins occasional so the cascade terminates. `payScale 0.285`, `cascCap 6`.
- **Golden Squares** = winning cells → fixed `goldSet` positions (they **never move** — client
  paints `.cell.gold` by index). `revealedSet` = gold already paid (each pays ONCE per
  accumulation → bounds RTP).
- **Rainbow** (per-grid roll: base 1.6%, bonus 30%, or forced) **activates** the not-yet-revealed
  gold → `resolveReveal`: each reveals a **Coin** (bronze/silver/gold band, value skewed low via
  `r²`), a **Clover** (×2–10 to 8-adjacent coins), or a rare **Collector** (`pCollector .05` →
  doubles the whole haul). `payX = sum × (collector?2:1)`, capped (`baseCap 40` in base, `cap
  10000` in bonus — base cap keeps base RTP stable, big wins live in the bonus).
- **Modes** (camera scatter 📷 `chance .0065`): 3→`luck` (8 spins, gold consumed on activation),
  4→`gold` (12, gold persists), 5→`rainbow` (12, 🌈 every spin, no bronze). Retrig 2cams+2/3cams+4.
- **4 paid buys** (auto-priced to ~96%): feature (5× cam odds), rainbow (forced 🌈), luck, gold.
- **RTP tuning lesson:** scatter-pays with few symbols → cascades NEVER terminate (every grid
  wins) → runaway (measured 12,808% before tuning). Fixes that worked: per-symbol min counts +
  `revealedSet` pay-once + `baseCap` (kills the heavy base tail) + low base-rainbow rate + low
  `scatter.chance` (the 3-cam trigger EV is a big chunk of base RTP). The coin RTP is heavy-
  tailed — tune by component (cluster vs coin vs bonus-trigger), not by total. Buys auto-price
  so only BASE needs nailing.
- `runBanditRound` envelope adds per-spin `gold[]`, `reveal{events:[{pos,type,tier?,val?,mult?}],
  collected,sum,collectors}`, `rainbow`, `coinWin`. Client `revealReveal()` pops coin/clover/
  collector chips on the cells, sweeps to `#winMeter` when a Collector pays.

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

- Single-writer price engine in `web/server.ts`. **Hard-to-game market model**: a shared
  **market factor** (`mktDrift`) moves all assets together, weak **momentum** (`mom`, low
  weight → lag-1 autocorrelation ≈ 0, a random walk — NOT trending, so "sell on the first
  up-tick" has no edge), **volatility clustering** (`volState`, GARCH-lite), and a **FIXED
  fair-value anchor** (`baseline` does NOT chase price → genuine over/undervaluation).
  **Cubic mean-reversion** at extremes: `-0.01*dev - 0.9*dev³` — gentle in the normal band,
  hard correction when |dev| > ~15% (overbought snaps back). Demand `bias` from trades is a
  transient shove. Bounded ±14%/tick, 2% fee sink. **Slippage spread** (`investSlippage`):
  big trades execute at a worse price (up to 6% adverse) → round-tripping is net-negative.
  `INVEST_TICK_MS = 25_000`. Validated: exploit (sell on first up-tick) = 0% win / -4.8% avg;
  even perfect-timing holds net only +0.2% after fees+slippage.
- **FC-T** (`_id: "fct"`, formerly `flx` "FluxCoin Index") — its price tracks **total FC in
  circulation** (the money supply, via `stdb.totalSupply()`), like USD-T tracking reserves.
  Fair value = supply / 1M (1M FC → 1.00 FC-T); `investTick` smooths toward it (12%/tick)
  with a tiny noise wiggle. Other assets use the random-walk model above.
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

## 6. Rakeback (Stake-style cashback on the theoretical house edge)

`rakeback = wager × (effectiveTaxBps/10000) × rakebackPct`. Accrues on **all play** (not just
losses), per-selected-server. Real cash, no wagering requirement, instant-claim from the lobby
Rakeback tile. Default `rakebackPct = 5%` (per-guild, owner-configurable 0–20 via
`POST /api/server/rakeback`). **Halts during a tax holiday** (taxBps=0 → house earns nothing
to rebate — matches Stake's model).

- **Storage**: Mongo `rakeback` collection, keyed `{_id: uid+"@"+gid}` with `{accrued, wagered,
  claimed}`. Methods in `Database.mjs`: `addRakeback`, `getRakeback`, `claimRakeback`,
  `setGuildRakebackPct`, `getGuildRakebackPct`.
- **Accrual hooks**: `accrueRakeback(uid, gid, wager, taxBps)` in `server.ts` (fire-and-forget,
  resolves pct from a 60s `rakebackPctCache`). Called at slots spin, house `wager()`, cards
  `wager()`, and case-battle via the injected `onWager` callback (which also closes the gap
  where case battles weren't recording `serverstats`).
- **Endpoints**: `GET /api/rakeback` (pending/claimed/pct for the selected server),
  `POST /api/rakeback/claim` (credits via `stdb.credit`, 1.5s rate-limit, notifies),
  `POST /api/server/rakeback` (owner/servers-admin sets pct, broadcasts via `server-econ`).
- **UI**: lobby Rakeback tile (`games/lobby.html`) — shows pending FC + Claim button, per-server,
  greys out with "Select a server" when no `srv` cookie. Refreshes on balance WS push.
- **Math**: 1000 FC @ 15% tax, 5% rakeback → `1000×0.15×0.05 = 7 FC` accrued.

---

## 7. Realtime / WebSocket

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

## 8. Sessions / auth

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

## 9. Multi-tenant economy

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

## 10. Elysia/Bun gotchas (see CLAUDE.md §4)

- **No top-level `await`** in `web/server.ts` (PM2's bun-fork `require()`s the entry).
  Use `.then()` chains for background init.
- `set.redirect` NOT honored → use `redir(set, url)` helper (manual 302).
- Set-Cookie via raw headers doesn't stick → use Elysia **`cookie`** API.
- Static files via `Bun.file(path)`. WS upgrade reads cookie via `.derive()`.
- **Watch for duplicate `const` in the same handler scope** — Bun fails to parse → PM2
  crash-loop. Scan for it after editing `server.ts`.

---

## 11. Local validation checklist (no Bun/STDB locally)

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

## 12. Deploy

- **Web/page/bot only** (no Rust): `pm2 restart sirgreen-web` (+ `sirgreen-bot` if
  `index.mjs`/`CommandHandler.mjs`/`Database.mjs`/`stdbBridge.mjs` changed). Pages are
  static — asset `?v=` cache-bust is automatic.
- **STDB module change**: `cd spacetimedb && spacetime publish -s local sirgreen-6ls47 &&
  spacetime generate --lang typescript --module-path . --out-dir ../web/src/module_bindings &&
  pm2 restart sirgreen-web`. Additive migrations (new table/reducer) don't wipe.
- `module_bindings/` is generated **on the VPS only** — not in the repo, not on dev box.
- Cloudflare fronts the origin (Bun on :80), passes WebSockets automatically.

---

## 13. Session-specific decisions & fixes (for continuity)

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
12. **Plinko real physics**: was a scripted polyline (ball followed fixed waypoints, never
    touched pegs). Rewrote as gravity-integrated physics body: bounces UP off each peg
    (negative vy), parabolic arcs between pegs, ball trail, peg-glow on the exact hit peg.
    Deterministic via server path (triangular-field peg sequence). Sim-verified: all paths
    land in the correct bucket.
13. **Invest market nerf (anti-manipulation)**: old model had strong positive autocorrelation
    (+0.33) → "sell when it stops rising" was a guaranteed profit. Fixed: weak momentum
    (autocorr ≈ 0), FIXED baseline anchor (no rubber-band), cubic mean-reversion at extremes,
    + slippage spread on trades. Exploit win rate 0%; perfect-timing net +0.2%.
14. **&leaderboard showed everyone at 1000**: Mongo `bal` is a stale starter never updated
    (balances live in STDB). Fix: `stdb.topBalances(n)` reads the live account cache →
    `/internal/leaderboard/:limit` → `stdbBridge.leaderboard()` → command uses it for "rich"
    mode. "earners" (total wagered) still reads Mongo (correct — that's where it lives).
15. **FC-T (was FluxCoin Index / flx)**: renamed to `fct`, price now tracks total FC in
    circulation (`stdb.totalSupply()` / 1M) like USD-T. Migration in `seedAssets`: renames
    the legacy `flx` doc + re-keys holdings `h.flx`→`h.fct`.
16. **Plinko physics v2 (spring-steered)**: v1 used a fixed lateral-velocity kick at each
    peg with no damping → ball drifted sideways off-screen. Rewrote: horizontal **spring**
    pulls the ball toward its target peg X (can't leave the path), damped bounce on contact,
    hard board-bound clamp as safety net. Sim-verified: all paths land correctly, ball
    never leaves bounds. v3 (time-based fall): velocity integration stalled at the top on
    laggy frames → rewrote as `y = ½gt²` from an always-increasing fall timer (stall-proof).
17. **Case battle shared mode**: split the entry POT (guaranteed loss after rake). Fixed to
    split total reward VALUE — good pulls now profit everyone. Net RTP ≈ 90%.
18. **Rakeback**: Stake-style cashback (`wager × houseEdge × pct`) on all play, per-server.
    New `rakeback` collection + `accrueRakeback` hooks at every wager site (slots,
    house, cards, case-battle — the last also closes the serverstats gap). Claim from the
    lobby tile. Owner-configurable pct (default 5%). Halts during tax holidays.
19. **Mongo → STDB migration (whole datastore)**: replaced all 10 Mongo collections with
    13 new STDB tables (`user_profile`, `session`, `guild`, `server_stats`, `server_player`,
    `holding`, `invest_asset`, `ticket`, `rakeback_ledger`, `login_token`, `stat_counter`,
    `daily_stat`, `kv`) + the 3 original ledger tables. `Database.mjs` became a two-backend
    facade (web=`{stdb}` cache/reducer; bot=`{http}` to `/internal/*`); the bot no longer
    runs any DB client; `stdbBridge.mjs` deleted. Key design choices: JSON fields are opaque
    `String` blobs (merge/parse in JS, not Rust — no `serde_json` needed); atomic numeric ops
    are Rust i64/f64 math; return-value reducers do the full op + `Err` on failure, then JS
    reads the cache (`claim_rakeback` credits the balance *inside* the txn → route doesn't
    re-credit); unbounded `players[]` → relational `server_player` + `player_count`; composite
    PKs are single `owner|asset`/`uid@gid`/`gid|uid` strings. `pruneExpiredSessions` moved to
    a web timer. One-time `scripts/migrate-to-stdb.mjs` (POSTs Mongo rows to `/internal/migrate`
    → `import_*` reducers; balances NOT migrated — the ledger already owns them). Couldn't be
    runtime-tested on the dev box (no Bun/STDB/`module_bindings`) — `cargo check` + `node --check`
    pass; the TS layers (`stdb.ts`, `server.ts`) verify on first VPS deploy. Biggest untested
    assumption: codegen camelCases reducer ARG names (matches the confirmed name/field casing).

---

## 14. Conventions & standing constraints (from CLAUDE.md §8)

- Game outcomes server-authoritative + non-exploitable.
- STDB owns money; Mongo owns the rest. Never write balances to Mongo.
- Rate-limit money endpoints: `rl(map, key, ms)` + per-IP global limiter. Plinko = 50ms.
- Icons: Lucide first. Emoji only for playful content.
- Escape user-controlled strings (`esc()` server-side, page-local `esc()` client-side).
  Validate hex (`safeHex`/`HEX_RE`), uids (`/^\d{17,20}$/`), guild ids, amounts.
- No global music — per-slot themes only; mutable.
- `/internal/*` is loopback-only + shared-secret; rejects `cf-connecting-ip`/`x-forwarded-for`.
