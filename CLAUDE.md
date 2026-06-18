# SirGreen Casino — Project Context (CLAUDE.md)

A Discord (Fluxer) casino bot + web app. Virtual currency **FluxCoins (FC)**. Public site: **https://sirgreen.online** (Cloudflare-fronted). This file is the canonical context for working in this repo — read it first.

---

## 1. Architecture (two processes + two databases)

Two long-running processes, run under **PM2** as `sirgreen-bot` and `sirgreen-web`:

- **Node bot** — `index.mjs`. The `@fluxerjs/core` Discord bot: chat commands (`commands/*.mjs`), presence, internal DM endpoint. Talks to the web service over localhost for balance ops.
- **Bun + Elysia web service** — `web/server.ts`. Owns HTTP routing, static assets, sessions, all money endpoints, and the realtime WebSocket. This is the core file (~1000 lines).

Two databases, **strict ownership** — do not cross these lines:

- **SpacetimeDB (STDB)** — Rust module `spacetimedb/src/lib.rs`, name `sirgreen-6ls47`, published to a **local** host (`ws://127.0.0.1:3000`). Owns **balances, transactions, notifications, per-server banks**. Every reducer is an atomic ACID transaction → race-free, no app-level locks, fast. This is the money ledger.
- **MongoDB** (`fluxer_casino`) — `src/Database.mjs`. Owns **everything else**: user profiles, sessions, guilds, per-server stats, shop/economy config, support tickets, case tiers, login tokens.

`src/Database.mjs` is shared by both processes (Bun runs `.mjs` directly). Balance ops in the bot delegate to STDB via `src/stdbBridge.mjs` (HTTP → web's `/internal/*`); the web service calls STDB directly via `web/src/stdb.ts`.

```
Discord ──> Node bot (index.mjs) ──localhost /internal/*──> Bun web (web/server.ts) ──ws──> SpacetimeDB
                  │                                              │
                  └──────────────── MongoDB ─────────────────────┘
Browser ──HTTPS(Cloudflare)──> Bun web ──> STDB (balances) + Mongo (everything else)
```

---

## 2. Key files

| File | Role |
|------|------|
| `web/server.ts` | **The core.** All HTTP routes, sessions, money endpoints, WebSocket hub, OAuth, internal bridge. Elysia/Bun. |
| `web/src/stdb.ts` | STDB client wrapper (the single connection). Reducer calls + table subscriptions + caches (balance, bank, notifications). |
| `spacetimedb/src/lib.rs` | Rust STDB module: tables (`account`, `notification`, `server_bank`) + reducers. |
| `src/Database.mjs` | MongoDB layer (shared by bot + web). Users, sessions, guilds, serverstats, shop, tickets, cases, login tokens. |
| `src/stdbBridge.mjs` | Bot → web `/internal/*` HTTP client (balance ops, guild-rename push). |
| `index.mjs` | Node bot entry: client, presence, internal DM HTTP endpoint, bridge attach. |
| `src/CommandHandler.mjs` | Command dispatch + per-guild upsert + realtime guild-rename ping. |
| `commands/*.mjs` | Chat commands (`&web`, `&work`, games, etc.). |
| `src/HouseGames.mjs` | Server-authoritative house games (Plinko/Coinflip/Double/Mines/HiLo). Exports `PLINKO` tables. |
| `src/SlotEngine.mjs` | Cluster-pays slots (RTP ≈ 87%). |
| `src/CaseBattle.mjs` | Case-battle engine. |
| `src/AdminPanel.mjs` | Admin panel HTML + permission model (`PERMS`, `can`, `isAdmin`, `canSeePanel`, `OWNER_ID`). |
| `games/*.html` | Page templates (lobby, slots, house, leaderboard, servers, settings, misc, notifications, admin). Each has scoped `<style>` + inline `<script>`. |
| `games/partials/sidebar.html` | Sidebar + the persistent client runtime: pjax navigation, central WebSocket client, server selector, tax dialog. |
| `games/assets/css/app.css` | Shared CSS (shadcn-ish). |

---

## 3. SpacetimeDB specifics (read before touching `lib.rs` or `stdb.ts`)

- SDK is the unified `spacetimedb` npm package (CLI 2.6). Import `DbConnection` from the generated `./module_bindings`.
- Builder: `DbConnection.builder().withUri().withDatabaseName().withToken().onConnect().build()` — it's `withDatabaseName`, NOT `withModuleName`.
- **Reducers are called with an OBJECT of camelCase args**, not positional: `conn.reducers.settleWin({ owner, bet, payout, gid, tax })`. A reducer call returns a Promise: resolves on commit, rejects (SenderError) on `Err`.
- **Codegen casing asymmetry (important):** reducers are camelCased (`settle_win` → `settleWin`) but **table accessors may stay snake_case** (`server_bank` → `conn.db.server_bank`). `stdb.ts` resolves the bank table via `#bankTable()` trying `serverBank ?? server_bank ?? serverbank`. If you add a table, don't assume the accessor name — resolve defensively.
- Tables: `conn.db.<table>.onInsert/onUpdate/onDelete/iter`. Subscriptions: `conn.subscriptionBuilder().onApplied().subscribe([SQL])`. **Subscribe each table separately** — a multi-query `.subscribe([...])` previously failed to apply the second table (bank read 0 forever). Seed caches from `iter()` in `onApplied`.
- BigInt: i64 reducer args are passed as `BigInt(...)`; cached values normalized with `Number()`.
- **Consts in `lib.rs`:** `MAX_BALANCE=1e12`, `MAX_DELTA=1e9` (per-op cap), `STARTER_BALANCE=1000`. Balances clamp to `[0, MAX_BALANCE]`. Reducers reject `amount<=0`, enforce `tax<=payout`/`tax<=gross`, `balance>=bet`. **Keep this discipline for any new reducer** — it's why the ledger can't be exploited.
- Reducers: `ensure_account`, `credit`, `deduct`, `settle(owner,bet,payout)`, `settle_win(owner,bet,payout,gid,tax)`, `credit_win(owner,gross,gid,tax)`, `transfer`, `set_exact`, `bank_spend(gid,amount)`, `bank_set(gid,balance)` (unused by web — bank edits use credit_win/bank_spend instead), `add_notification`, `mark_read`.

### Deploy STDB changes (on the VPS)
```bash
cd spacetimedb
spacetime publish -s local sirgreen-6ls47
spacetime generate --lang typescript --module-path . --out-dir ../web/src/module_bindings
pm2 restart sirgreen-web
```
Adding a table/reducer is an **additive migration** (no wipe). `module_bindings/` is generated on the VPS — it is NOT in the repo and not on the dev box, so you can't run `spacetime generate` locally.

---

## 4. Elysia / Bun gotchas (hard-won)

- **No top-level `await`** anywhere in `web/server.ts` — PM2's bun-fork `require()`s the entry and async top-level modules fail. Do background init with `.then()` chains.
- `set.redirect` is NOT honored — use the `redir(set, url)` helper (manual 302 + Location).
- Set-Cookie via raw `Response` headers doesn't stick — use the Elysia **`cookie` API** (`cookie.sid.set({...})`). See `setAuthCookies()`.
- Static files via `Bun.file(path)`. Global hooks via `.onRequest()`. WebSocket via built-in `.ws("/ws")`; read the upgrade cookie via `.derive(({request}) => ({cookieHeader}))` → `ws.data.cookieHeader`.
- Config the code actually reads: `cfg.mongodb.uri` / `cfg.mongodb.database`, `cfg.web.port` (prod = 80), `cfg.web.internalSecret`, `cfg.web.botPort` (8091), `cfg.spacetime.{uri,module,token}`, `cfg.owners` (array — `["1512241609448620032"]` is THE bot owner), `cfg.fluxerClientId/Secret`, `cfg.webBaseUrl`, `cfg.fluxerListServerId/ApiKey`. (`config_example.json` is partly stale — trust the code.)
- **Watch for duplicate `const` in the same handler scope** — Bun fails to parse and PM2 crash-loops. This has bitten twice (`const now` declared twice). After editing `server.ts`, scan for it.

---

## 5. Realtime / WebSocket (prefer WS over polling — explicit user preference)

One socket per browser tab at `/ws`. On open it auths via the session cookie and subscribes the user to STDB pushes. The **central WS client lives in `sidebar.html`** (persistent across pjax) and re-dispatches every message as a DOM event: `window.dispatchEvent(new CustomEvent('sg:ws', { detail }))`. Pages subscribe with `window.addEventListener('sg:ws', ...)`.

Message types pushed: `init`, `balance`, `notification`, `ticket` (in-process broadcast via `wsClients`), `bank` (per-server bank, STDB sub → owners/managers in `ws.data.watchGids`), `server-play` (live stat deltas to watchers), `server-econ` (tax/holiday/shop — broadcast to ALL sockets), `guild` (rename/icon — broadcast to all).

Helpers in `server.ts`: `broadcastTicket`, `broadcastServerPlay`, `broadcastServerEcon`, `broadcastGuild`. Anything that changes shared state should push a WS event, not rely on the client polling.

### pjax (SPA navigation)
`sidebar.html` intercepts internal links, fetches the page, swaps `<main>`, mirrors head `<style>` into `#pjax-style`, and **re-executes body `<script>`s EXCEPT** those whose text matches `/__pjax|__bgHex|__notif|__srvSel/` (the persistent runtime, guarded by `window.__*` flags so they init once). Consequence: a page's inline script re-runs on every nav into it — guard listener registration with a `window.__flag`, but let render/`load()` re-run.

---

## 6. Sessions / auth / cookies

- OAuth via Fluxer (`/login` → `/oauth/callback`). Server-side `oauthStates` map (10-min, single-use) for CSRF on the state param.
- Cookies: `sid` + `uid` (httpOnly), `dtag` + `dav` (display tag/avatar), `srv` (selected server). Set via **`setAuthCookies(cookie, isHttps(request), {...})`** — `Secure` only when the request arrived over HTTPS (`x-forwarded-proto`), so direct-HTTP can't silently break login. Sessions are 2h TTL.
- Session store: a `st` sub-doc on the user (`st.<token> = expiry`). `validateSession`/`createSession`/`rotateSession`/`revokeSession` in `Database.mjs`. **Token must match `/^[a-f0-9]{24,128}$/`** before it's used in a Mongo field path (`isSessionToken`).
- **LOGIN-LOOP LESSON:** never put the same field path in both `$set` and `$unset` (Mongo rejects the whole update). The OAuth callback + `/s/:token` now **always `createSession` (upsert)** and revoke the old session separately — never depend on a rotate succeeding.
- `&web` command mints a one-time login token (`createLoginToken`, 10-min, TTL-indexed) → `/s/:token` logs in + selects that guild.

---

## 7. Multi-tenant economy (per-server banks, tax, shop, leaderboard)

**Locked design:** one **global balance** per user (same everywhere). The **selected server** (`srv` cookie) decides the cut/taxes/stats. Tax comes FROM the player's winnings (lowers effective RTP on taxed servers). Tax is on **PROFIT only** (winnings above stake).

- **Gate:** you can't gamble without a selected server. `requireServer(request, uid)` validates the `srv` cookie's guild **exists AND the user is a member** (do not weaken this — it was a critical vuln). Slots/house/case-battle all gate on it; reject `{needServer:true}` → client flashes the picker.
- **Tax:** default 1500 bps (15%), cap 5000 (50%), floor 15% for normal owners. `taxOnProfit(profit, bps)`. Per-guild `taxBps` in Mongo. Cached 60s in `taxCache`.
- **Tax-change rules:** lowering is always allowed (owner or `servers` admin); **raising requires a FluxerList vote** unless **exempt**. Exempt = the `tax` or `servers` permission (`isTaxExempt`). `GET/POST /api/server/tax`.
- **Tax holiday** (shop perk): effective tax = 0 while active (`holidayActive`/`effectiveTaxBps`). Shown as 0% everywhere, live. Removable early for a flat 50% refund.
- **Server bank** (STDB `server_bank` table): accrues tax. Owner perks (shop) spend it. Admin (`servers` perm) bank-edit via `POST /api/server/bank` (uses `credit_win`/`bank_spend`, audit-logged).
- **Shop** (`SHOP_ITEMS`, stored on guild `shop` sub-doc): `featured` (50k, 7d leaderboard pin), `tax_holiday` (25k, 48h), `accent` (15k, custom hex). Active duration perks can't be re-bought; accent recolor free once owned. Buy/remove throttled 4s/user+gid.
- **Per-server stats** (Mongo `serverstats`): `recordServerWager`/`recordServerPayout`. Shown on the dashboard, live via `server-play` WS.
- **Leaderboard** (`/leaderboard`, `GET /api/leaderboard?sort=`): ranks servers; featured pinned. Shows tax % + a **Join** link (only when the owner set a **fluxer.gg** invite — `normalizeFluxerInvite`, `POST /api/server/invite`) + a blue **verified** badge. Filters: `q`, `verified`, `minMembers`, `maxMembers`.
- **Verification:** admins (`servers` perm / owner) toggle a blue verified badge via `POST /api/server/verify`; stored as guild `verified`, broadcast on `server-econ`, shown to everyone on the leaderboard + dashboard.
- **Servers dashboard** (`/servers`): owner OR `servers`-perm admin. Per-server cards: live bank + stats, tax edit, shop, bank edit (admin), join-link edit, verify toggle, **server-case manager** (custom case tiers, RTP-capped ≤95% via `CaseBattle.validateServerCase`; scoped per-guild).
- **Role shop** (`&shop` Discord command, `commands/shop.mjs`): owners sell Discord roles for FC; buyer pays full, **75% → server bank, 25% sink**. Money via `/internal/role-purchase` (deduct + `creditWin` to bank). Stored on guild doc `roleShop[]`. Separate from the web perk-shop.
- **Investing** (`/invest` web tab `games/invest.html` + `&invest` command): trade NFTs + a FluxCoin index with FC. Price engine lives ONLY in `web/server.ts` (`investTick`, single writer; bot trades via `/internal/invest/*`) — mean-reverting random walk + demand `bias`, bounded, 2% fee sink (net-deflationary). Mongo `assets`+`holdings`; prices stream over WS as `{type:'prices'}`. FLX is a demand/market index (not yet literally circulation-derived).

### Permissions (`AdminPanel.PERMS`)
`balances`, `cases`, `battles`, `users`, `tickets`, `tax` (set tax with no floor/vote), `servers` (manage every server's bank/tax/shop). `OWNER_ID` (config.owners[0]) has all. `isAdmin` = owner or any perm. `canSeePanel` = owner or a perm that maps to a panel tab (so `tax`/`servers` don't show an empty Admin panel). All admin/server endpoints re-check permissions **server-side** — never trust the client's nav flags.

---

## 8. Conventions & standing constraints

- **Game outcomes server-authoritative + non-exploitable.** All randomness/resolution on the server; the client only animates.
- **STDB owns money; Mongo owns the rest.** Never write balances to Mongo.
- **Rate-limit money endpoints.** `rl(map, key, ms)` + per-IP global limiter. Plinko gets a lenient 50ms (multi-ball) but is NOT exempt.
- **Icons: Lucide first** (inline SVG). Emoji only for playful content (🎉 holiday, ✨ featured).
- **Escape user-controlled strings** before HTML (`esc()` server-side, page-local `esc()` client-side). Validate hex colors (`safeHex`/`HEX_RE`), user IDs (`/^\d{17,20}$/`), guild IDs, amounts. Reject, don't sanitize, where it touches a query/SQL.
- **No global music** — per-slot themes only; mutable.
- Slots RTP ≈ 87%. DB wipe is owner-only with multiple confirmations.
- `/internal/*` is **loopback-only + shared-secret** — bot use only; rejects requests carrying `cf-connecting-ip`/`x-forwarded-for`.

---

## 9. Security model (audited — keep these invariants)

The STDB ledger is the trust anchor: atomic, clamped, non-negative, per-op-capped. No minting/double-spend is possible there. The web layer's job is **authorization + input validation**:
- `requireServer` membership check (don't weaken).
- Permission checks server-side on every admin/server route.
- Session token shape validation before Mongo field-path use.
- STDB subscription SQL: owner must be digits-only.
- `/internal/*` loopback + secret.
- Cookie `httpOnly` (sid/uid) + HTTPS-conditional `Secure`; `sameSite=lax` gives CSRF protection on POSTs.

Residual/accepted: `/logout` is GET (low-risk CSRF), transfers can create an account for a valid-but-unused id (burn, not mint), admin bank-edit can inflate a bank (intentional owner-granted power, audit-logged).

---

## 10. Deploy

- **Web/page/bot code only** (no Rust change): `pm2 restart sirgreen-web` (and `sirgreen-bot` if `index.mjs`/`CommandHandler.mjs`/`Database.mjs`/`stdbBridge.mjs` changed). Pages are static — picked up on reload (asset `?v=` cache-bust is automatic).
- **STDB module change:** publish + generate + restart web (see §3).
- Cloudflare fronts the origin (Bun on :80) and passes WebSockets automatically.

### Local dev notes
- Windows dev box: `spacetime` CLI and Bun are NOT installed; `module_bindings/` is absent. You can't run the web service or STDB locally. Validate with: `node --check` on `.mjs`, `cargo check` in `spacetimedb/`, and parse page `<script>` blocks with a `vm.Script` check. `cargo` IS available for the Rust module.

---

## 11. Status

Multi-tenant economy fully shipped (4 phases: guild-scoped login + selector; per-server bank + vote-gated tax + gate; owner Servers dashboard + stats; leaderboard + shop). Plus tax-holiday realtime/refund, realtime guild names, login-loop fix, and a security pass.

**Deferred / known:** case-battle plays aren't taxed yet (slots+house only); server sessions are a fixed 2h (no inactivity expiry); the admin panel is still an iframe (CSS-isolation rework pending); leaderboard `bank` sort is approximate (top-100-by-wagered pool).

Ongoing project notes live in the auto-memory at `memory/multitenant-economy-phases.md`.
