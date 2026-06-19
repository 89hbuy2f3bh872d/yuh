# SirGreen Casino — Installation & Deploy Guide

A complete, from-scratch setup guide for the SirGreen casino bot + web app.
Use this to bring the project up on a fresh VPS, or to migrate it to a new one.

> **Read first:** [`CLAUDE.md`](./CLAUDE.md) (canonical architecture) and
> [`GLM.md`](./GLM.md) (deeper "how it works"). This guide is the operational
> companion to those.

---

## 0. Architecture at a glance

Two long-running processes, run under **PM2**, backed by **one** database
(SpacetimeDB):

```
Discord ──> Node bot (index.mjs)  ──localhost /internal/*──> Bun web (web/server.ts) ──ws──> SpacetimeDB
Browser ──HTTPS (Cloudflare)────>  Bun web ──ws──> SpacetimeDB  (the ENTIRE datastore)
```

| Process | PM2 name | Runtime | Entry | Role |
|---|---|---|---|---|
| Bot | `sirgreen-bot` | Node 20+ | `index.mjs` | Discord client, chat commands, internal DM endpoint. **No DB client** — every data op is HTTP to the web's `/internal/*`. |
| Web | `sirgreen-web` | Bun | `web/server.ts` | HTTP routes, sessions, money endpoints, realtime WebSocket, OAuth, **the single SpacetimeDB connection**. |

- **Database: SpacetimeDB (STDB)** — Rust module `spacetimedb/src/lib.rs`,
  module name `sirgreen-6ls47`, published to a **local** STDB host
  (`ws://127.0.0.1:3000`). Owns *everything*: balances, banks, notifications,
  profiles, sessions, guilds, stats, holdings, assets, tickets, rakeback,
  login tokens, kv. **Mongo is gone** (only the one-time migration script reads it).
- **Edge:** Cloudflare in front of Bun on `:80` (passes WebSockets automatically).
  An nginx-reverse-proxy setup is also provided in `deploy/` if you don't use Cloudflare.
- `web/src/module_bindings/` is **generated on the VPS** by `spacetime generate`
  — it is NOT in the repo and not on the dev box.

---

## 1. Prerequisites

- **VPS:** any Linux (Ubuntu 22.04+ recommended), 1–2 vCPU, 1–2 GB RAM minimum.
  Root/sudo access. Ports `80` (and `443` if you terminate TLS yourself) open.
- **Domain** pointed at the VPS (e.g. `sirgreen.online`), proxied through Cloudflare
  (orange cloud) — recommended. Or an A record directly at the VPS for the nginx setup.
- **Accounts/keys you must have ready:**
  - A Fluxer bot application → **bot token**, **OAuth client ID**, **client secret**
    (Fluxer Developer Portal).
  - A FluxerList server ID + API key (for the vote-gated tax feature).
  - (If migrating an existing install) your old MongoDB connection string — only
    used by `scripts/migrate-to-stdb.mjs`, once.

---

## 2. Install system runtimes

### 2.1 System packages
```bash
sudo apt update && sudo apt install -y git curl build-essential pkg-config libssl-dev \
                                       ca-certificates nginx ufw
```

### 2.2 Node.js 20 (the bot)
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # v20.x
```

### 2.3 Bun (the web service)
```bash
curl -fsSL https://bun.sh/install | bash
# add to PATH per the installer's message, then:
source ~/.bashrc
bun --version
```

### 2.4 PM2 (process manager)
```bash
sudo npm install -g pm2
# make PM2 survive reboots:
pm2 startup systemd -u $(whoami) --hp $HOME
# (run the command it prints)
```

### 2.5 Rust toolchain (to build the STDB module)
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
# Add the wasm32 target (STDB modules compile to WASM):
rustup target add wasm32-unknown-unknown
```

### 2.6 SpacetimeDB CLI (2.6+)
```bash
curl --proto '=https' --tlsv1.2 -sSf https://install.spacetimedb.com | sh
spacetime version   # confirm it's installed
```

---

## 3. Get the code & install dependencies

```bash
cd ~
git clone https://github.com/vermingov/fluxer-casino-bot sirgreen
cd sirgreen
npm install            # bot deps (@fluxerjs/core, mongodb for the migration script)
```

> Bun does **not** need `npm install` for the web — it resolves `web/server.ts`'s
> TS imports directly (only `../src/*.mjs` + the generated `./module_bindings`).
> If you add npm deps that the web imports, run `bun install` too.

---

## 4. Start SpacetimeDB and publish the module

### 4.1 Run a local STDB host
Start a SpacetimeDB instance on `127.0.0.1:3000` and keep it running under PM2:

```bash
pm2 start "spacetime start --listen-addr 127.0.0.1:3000" --name sirgreen-stdb
pm2 save
```

> The exact flag may be `--listen-addr` or `--listen` depending on your CLI version —
> run `spacetime start --help` to confirm. The host must end up on `127.0.0.1:3000`
> (that's what `config.json` `spacetime.uri` points at).

### 4.2 Register a `local` server alias (used by `-s local`)
```bash
spacetime server add local http://127.0.0.1:3000
spacetime server set-default local   # optional, but convenient
```

### 4.3 Build & publish the module
```bash
cd ~/sirgreen/spacetimedb
spacetime build                       # compiles the Rust → WASM module
spacetime publish -s local sirgreen-6ls47 --yes
cd ~/sirgreen
```

### 4.4 Generate the TypeScript client bindings (the web needs these)
```bash
spacetime generate --lang typescript \
  --module-path spacetimedb \
  --out-dir web/src/module_bindings
```
`web/src/module_bindings/` is now created. It is git-ignored and **must be regenerated
on the VPS whenever the Rust module changes** (see §8).

### 4.5 (Optional) STDB identity token
For a self-hosted local host the connection usually works without a token. If your
STDB requires an authenticated identity, log in and copy the token into `config.json`:
```bash
spacetime login   # creates/prints an identity token
```

---

## 5. Configure `config.json`

`config.json` is git-ignored. Create it from the example and fill in your values:

```bash
cp config_example.json config.json
nano config.json
```

The code reads these keys (merge the example with this — the example is partly stale,
this is the authoritative list):

```jsonc
{
  "token":              "YOUR_FLUXER_BOT_TOKEN",
  "prefix":             "&",
  "owners":             ["YOUR_FLUXER_USER_ID"],   // owners[0] = the bot owner (all perms)
  "webBaseUrl":         "https://sirgreen.online",  // public URL (OAuth redirect base)
  "webHost":            "0.0.0.0",
  "webPort":            80,                         // Bun listen port (80 with Cloudflare)

  "fluxerClientId":     "YOUR_OAUTH_CLIENT_ID",
  "fluxerClientSecret": "YOUR_OAUTH_CLIENT_SECRET",

  "fluxerListServerId": "1512882040398159873",      // FluxerList server ID (vote-gating)
  "fluxerListApiKey":  "fl_your_api_key_here",

  // SpacetimeDB — the single datastore
  "spacetime": {
    "uri":    "ws://127.0.0.1:3000",
    "module": "sirgreen-6ls47",
    "token":  ""                              // omit/empty if your local host needs no auth
  },

  // Internal loopback bridge between bot and web
  "web": {
    "port":           80,                      // must match webPort above
    "internalSecret": "GENERATE_A_LONG_RANDOM_SECRET",  // SHARED SECRET — keep private
    "botPort":        8091                     // bot's internal /dm endpoint
  },

  // ONLY used by the one-time migration script (scripts/migrate-to-stdb.mjs).
  // The running app does NOT touch Mongo. Omit entirely on a fresh install.
  "mongodb": {
    "uri":      "mongodb+srv://...",
    "database": "fluxer_casino"
  }
}
```

Generate a strong internal secret:
```bash
openssl rand -hex 32
```

> ⚠️ **`web.internalSecret` is the shared secret guarding the `/internal/*` money-minting
> endpoints.** It must match nothing else and stay private. `/internal/*` is also
> loopback-only (the code rejects any request with `cf-connecting-ip`/`x-forwarded-for`).

---

## 6. Fluxer OAuth redirect URI

In the **Fluxer Developer Portal** for your application:

1. Set **Redirect URI** to: `https://sirgreen.online/oauth/callback`
   (i.e. `webBaseUrl` + `/oauth/callback`).
2. Save.

If you're not using a domain yet, use `http://YOUR_VPS_IP/oauth/callback` temporarily.

---

## 7. Start the app with PM2

From the repo root:

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 list        # should show sirgreen-bot + sirgreen-web (+ sirgreen-stdb from §4.1)
pm2 logs sirgreen-web --lines 30    # confirm "[web] SpacetimeDB connected"
pm2 logs sirgreen-bot --lines 30    # confirm "[Startup] Data layer → web /internal API"
```

`ecosystem.config.cjs` defines both processes:
- `sirgreen-bot` → `node index.mjs`
- `sirgreen-web` → `bun web/server.ts`

Make the whole PM2 list survive reboot (already did `pm2 startup` in §2.4):
```bash
pm2 save
```

---

## 8. Edge / TLS — pick one

### Option A — Cloudflare in front (recommended, matches current prod)
1. Point `sirgreen.online` (and `www`) at the VPS IP in Cloudflare, **proxied (orange cloud)**.
2. SSL/TLS mode: **Full** (Cloudflare→origin over HTTP:80 is fine; the app sends
   `Secure` cookies only when `x-forwarded-proto: https` is present, which Cloudflare sets).
3. Cloudflare passes WebSockets automatically — enable "WebSockets" in Network settings
   (on by default). The `/ws` upgrade works through the proxy.
4. Bun listens on `:80` (`webPort: 80`). No nginx needed.

### Option B — nginx reverse proxy (no Cloudflare, or for direct TLS)
Use `deploy/nginx-sirgreen.conf`. It terminates TLS, upgrades `/ws`, and caches `/assets/`.

```bash
# set webPort / web.port to 8080 in config.json first, restart sirgreen-web
sudo ln -s ~/sirgreen/deploy/nginx-sirgreen.conf /etc/nginx/sites-enabled/sirgreen
sudo certbot --nginx -d sirgreen.online -d www.sirgreen.online    # TLS
sudo nginx -t && sudo systemctl reload nginx
```
The nginx file proxies to `127.0.0.1:8080`, so Bun must listen on `8080`.

---

## 9. Verify

```bash
# health: web is up + STDB connected
curl -s http://127.0.0.1:80/ | head            # HTML (login page or lobby)
pm2 logs sirgreen-web --lines 20 | grep STDB   # "[web] SpacetimeDB connected"
# bot reached the web's internal API
pm2 logs sirgreen-bot --lines 20 | grep "Data layer"
```

Then in a browser:
- Open `https://sirgreen.online` → Fluxer OAuth login → lobby.
- In Discord, run `&web` in a server that has the bot → it DMs a login link that
  logs you in *and* selects that server.
- Run `&bal` → should show a balance (new accounts start at `STARTER_BALANCE` = 1000 FC).

---

## 10. Migrating an existing install (Mongo → STDB) — ONLY if upgrading an old box

Skip this on a fresh install. Only needed once, when moving from the legacy
Mongo-backed version to the current STDB-backed version.

```bash
# 1. Deploy the new module + web first (§4 and §7), with the web UP.
# 2. Make sure config.json still has mongodb.{uri,database} (the script reads it).
# 3. Run the migration (it POSTs Mongo rows to the web's /internal/migrate sink):
node scripts/migrate-to-stdb.mjs
# 4. Restart the bot so it picks up the HTTP-backed Database:
pm2 restart sirgreen-bot
# 5. Verify balances/leaderboard/etc, THEN you can drop Mongo.
```

The script is **idempotent** (the `import_*` reducers upsert). Balances are **not**
migrated — the STDB ledger already owns them. Order: publish → generate → restart web →
migrate → restart bot → verify → drop Mongo.

---

## 11. Switching VPS (backing up & restoring data)

STDB is now the single source of truth, so moving = moving the STDB data + the config.

### 11.1 On the OLD VPS — stop & back up
```bash
pm2 stop sirgreen-bot sirgreen-web sirgreen-stdb
# Back up the SpacetimeDB data directory (the host's --data-dir; default ~/.spacetime/data).
# Pin it explicitly when you start the host so you know where it lives:
#   pm2 start "spacetime start --listen-addr 127.0.0.1:3000 --data-dir /home/you/stdb-data" --name sirgreen-stdb
tar czf stdb-data.tgz -C /home/you stdb-data
# Back up the app config (contains secrets):
cp ~/sirgreen/config.json config-backup.json
# (optional) the whole repo is re-clonable, but config.json + stdb-data are the irreplaceable bits.
```

### 11.2 On the NEW VPS — restore
1. Do §2 (runtimes) and §3 (clone + `npm install`).
2. Install the same SpacetimeDB CLI version (§2.6).
3. Copy `stdb-data.tgz` and `config-backup.json` to the new VPS.
4. Restore the STDB data dir:
   ```bash
   tar xzf stdb-data.tgz -C /home/you
   ```
5. Place `config-backup.json` at `~/sirgreen/config.json`. Double-check `spacetime.uri`,
   `web.port`, `webBaseUrl`, and that the IP/domain now points at the new VPS.
6. Start the STDB host pointed at the restored data dir, then **re-publish the module**
   (the schema must match the data):
   ```bash
   pm2 start "spacetime start --listen-addr 127.0.0.1:3000 --data-dir /home/you/stdb-data" --name sirgreen-stdb
   cd ~/sirgreen/spacetimedb && spacetime publish -s local sirgreen-6ls47 --yes
   spacetime generate --lang typescript --module-path spacetimedb --out-dir ../web/src/module_bindings
   cd ~/sirgreen
   ```
7. Regenerate `module_bindings` (above) — they're not in the backup because they're
   generated, not source.
8. §7 (PM2 start), §8 (Cloudflare/nginx → repoint DNS to the new IP), §9 (verify).

> **Cloudflare note:** if you use Cloudflare, "switching VPS" can be as simple as
> changing the origin IP in the Cloudflare DNS dashboard — no code changes at all,
> as long as `webBaseUrl` stays the same domain.

---

## 12. Deploying code changes

### Web/page/bot code only (no Rust change) — the common case
```bash
cd ~/sirgreen
git pull
pm2 restart sirgreen-web
pm2 restart sirgreen-bot     # only if index.mjs / src/CommandHandler.mjs / src/Database.mjs changed
```
Pages are static HTML — picked up on web restart (asset `?v=` cache-bust is automatic).
The page HTML is served with `no-cache` so inline `<script>` changes always reach users.

### STDB module change (new table / reducer / Rust edit)
```bash
cd ~/sirgreen/spacetimedb
spacetime build
spacetime publish -s local sirgreen-6ls47 --yes
spacetime generate --lang typescript --module-path . --out-dir ../web/src/module_bindings
cd ~/sirgreen
pm2 restart sirgreen-web
```
Adding a table/reducer is an **additive migration** (no data wipe). Never run
`spacetime generate` on the dev box — `module_bindings/` is VPS-only.

### Quick reference — what triggers what
| Changed | Restart |
|---|---|
| `games/*` (HTML/CSS/JS) | `sirgreen-web` only |
| `web/server.ts`, `web/src/*` | `sirgreen-web` only |
| `src/Database.mjs`, `src/CommandHandler.mjs`, `index.mjs`, `commands/*` | `sirgreen-bot` (+ `sirgreen-web` if `Database.mjs` changed, since both load it) |
| `spacetimedb/src/lib.rs` | publish + generate + `sirgreen-web` |

---

## 13. Troubleshooting

| Symptom | Check |
|---|---|
| Bot exits: `config.web.internalSecret required` | `config.json` missing the `web` block — see §5. |
| Web logs `SpacetimeDB connect failed` | STDB host not running / wrong `spacetime.uri`. `pm2 logs sirgreen-stdb`; confirm `127.0.0.1:3000`. |
| Web 503 "Page not available" | A page HTML file is missing from `games/`. `git pull` / check the file exists. |
| Balances/bank stuck at 0 | `module_bindings/` stale or missing — regenerate (§4.4). A multi-table `.subscribe([...])` once silently dropped the bank sub — `stdb.ts` subscribes each table separately; don't change that. |
| Login loop / OAuth error | Redirect URI in the Fluxer Developer Portal must equal `webBaseUrl + /oauth/callback`. `webBaseUrl` must use the public domain. |
| `bun` not found by PM2 | Bun not on PM2's PATH. `pm2 restart sirgreen-web --update-env`, or ensure `~/.bun/bin` is in the shell PATH that PM2's startup script uses. |
| Duplicate `const` → PM2 crash-loop | A known Bun parse trap in `web/server.ts` (two `const` in one scope). Search the edited handler for a redeclared name. |
| Cookies not sticking | `set.redirect` isn't honored in this Elysia build; cookies must go through the `cookie` API (`setAuthCookies`). Direct `Set-Cookie` headers don't work. |
| WebSocket drops / no realtime | Cloudflare "WebSockets" must be on; with nginx, the `/ws` block must have the upgrade headers (see `deploy/nginx-sirgreen.conf`). |

### Useful commands
```bash
pm2 status                         # all processes
pm2 logs sirgreen-web --lines 50   # tail web
pm2 logs sirgreen-bot --lines 50   # tail bot
pm2 restart sirgreen-web           # bounce web after a code pull
spacetime sql -s local sirgreen-6ls47   # inspect tables (if your CLI supports `sql`)
```

---

## 14. Local dev notes (Windows / no VPS)

From `CLAUDE.md` §10: the dev box has **no Bun, no `spacetime` CLI, no
`module_bindings/`** — you can't run the web service or STDB locally. Validate with:

```bash
node --check src/HouseGames.mjs            # any .mjs — syntax check
cargo check                                 # in spacetimedb/ — Rust compiles
# page <script> parse check:
node -e "const fs=require('fs');const h=fs.readFileSync('games/slots.html','utf8');[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].forEach((m)=>new Function(m[1]));"
```
TS layers (`web/server.ts`, `web/src/*`) can't be type-checked locally either —
verify them on the first VPS deploy. The `diagnostics` from the editor will show
`Cannot find module 'elysia'` / `@types/bun` errors on the dev box; these are expected
and not real failures.

---

## 15. File map (quick orientation)

| Path | What |
|---|---|
| `index.mjs` | Bot entry — Discord client, internal `/dm` endpoint on `web.botPort`. |
| `web/server.ts` | **The core** — all HTTP routes, sessions, money endpoints, WS hub, OAuth, STDB connection. |
| `web/src/stdb.ts` | The single STDB client (reducers + per-table caches). |
| `web/src/module_bindings/` | Generated TS bindings (VPS-only, git-ignored). |
| `spacetimedb/src/lib.rs` | The STDB Rust module (all tables + reducers). |
| `src/Database.mjs` | Facade: web uses `{stdb}`, bot uses `{http}` to `/internal/*`. |
| `games/*.html` | Page templates. `games/partials/sidebar.html` = sidebar + persistent runtime. |
| `games/assets/css/app.css` | Shared CSS. |
| `ecosystem.config.cjs` | PM2 process definitions. |
| `deploy/nginx-sirgreen.conf` | Optional nginx reverse-proxy config. |
| `config.json` | Secrets + config (git-ignored). |
| `scripts/migrate-to-stdb.mjs` | One-time Mongo→STDB migration. |