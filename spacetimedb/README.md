# SirGreen — SpacetimeDB transaction module

SpacetimeDB owns **balances, transactions, and notifications**. MongoDB keeps
everything else (user profiles, sessions, cases, stats). Every reducer here runs
in an ACID transaction, so balance moves are atomic and race-free with no app
locks — and fast enough to take heavy traffic on a cheap VPS.

Module name (production): **`sirgreen-6ls47`**

## Tables (subscribe to these for realtime)

- `account { owner: String (pk), balance: i64 }`
- `notification { id: u64 (pk, auto), owner, kind, amount, from_tag, msg, ts(ms), read }`
  - indexed by `owner` (`by_owner`)

## Reducers (the transaction API)

| reducer | args | effect |
|---|---|---|
| `ensure_account` | owner | create at 0 if missing (call on login) |
| `credit` | owner, amount | add funds (daily/work/admin/payout) |
| `deduct` | owner, amount | remove funds; **aborts** if insufficient |
| `settle` | owner, bet, payout | atomic round: take bet, pay payout; aborts if can't cover bet |
| `transfer` | from, to, amount, from_tag | atomic move + "pay" notification to receiver |
| `set_exact` | owner, balance | admin: set an exact balance |
| `add_notification` | owner, kind, amount, from_tag, msg | system notification |
| `mark_read` | owner | mark all of a user's notifications read |

Balances are clamped (`MAX_BALANCE 1e12`, `MAX_DELTA 1e9`); notifications capped to
the newest 50 per user. A failed reducer leaves state untouched (no partial debit).

## Build / publish (on the VPS)

```bash
cd spacetimedb
spacetime build                       # compiles the WASM module (cargo check already passes)
spacetime publish sirgreen-6ls47      # publish to your running SpacetimeDB host
```

## Generate the TypeScript client bindings

The Bun web service is the **only** process that talks to SpacetimeDB directly
(TS-native). Generate its bindings:

```bash
spacetime generate --lang typescript --out-dir web/src/module_bindings --project-path spacetimedb
```

## Architecture (how it all connects)

```
                 ┌───────────────────────────┐
   Discord  ───► │  Node bot  (index.mjs)     │
                 │  balance ops ─┐            │
                 └───────────────┼────────────┘
                                 │ localhost HTTP (shared secret)
                                 ▼
   Browser ◄──WebSocket──►  ┌──────────────────────────────┐      ┌──────────────┐
   (balance + notifs live)  │  Bun + Elysia web service     │◄────►│ SpacetimeDB  │
                            │  (web/) — STDB client + WS    │ subs │ sirgreen-6ls47│
                            └───────────────┬───────────────┘      └──────────────┘
                                            │
                                            ▼
                                       ┌──────────┐
                                       │ MongoDB  │  (profiles, sessions, cases, stats)
                                       └──────────┘
```

- **Bun web service** holds the single SpacetimeDB connection, subscribes to
  `account`/`notification`, and pushes changes to browsers over its own WebSocket.
  Money endpoints (spin, transfer, buy, cashout) call STDB reducers.
- **Node bot** stays on Node (Fluxer SDK untouched). For balance ops it calls the
  Bun service's internal HTTP endpoints (`/internal/*`, shared-secret auth) instead
  of running the SpacetimeDB TS SDK under Node. One localhost hop, no cross-runtime
  binding pain.
- **Fresh start**: accounts begin at 0 in STDB; existing Mongo balances are not
  migrated (per decision).

## config.json additions (both processes read these)

```jsonc
{
  "spacetime": { "uri": "ws://127.0.0.1:3000", "module": "sirgreen-6ls47", "token": "<stdb-identity-token>" },
  "web": { "port": 8080, "internalSecret": "<random-long-secret>" }
}
```
