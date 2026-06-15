import http from "http";
import { URL } from "url";
import crypto from "crypto";
import https from "https";
import zlib from "zlib";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { GoldSlotAPI } from "./GoldSlotAPI.mjs";

// ── ESM __dirname shim ──────────────────────────────────────────────────────
// IMPORTANT: define BOTH before any path.resolve() calls at module scope.
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// These must come AFTER both __filename and __dirname are fully defined.
const GAMES_ASSETS_DIR = path.resolve(__dirname, "../games/assets");
const FAVICON_PATH     = path.resolve(GAMES_ASSETS_DIR, "favicon.ico");

const FLUXER_AUTH_URL  = "https://web.canary.fluxer.app/oauth2/authorize";
const FLUXER_TOKEN_URL = "https://api.fluxer.app/v1/oauth2/token";
const FLUXER_ME_URL    = "https://api.fluxer.app/v1/users/@me";

// 1 FC coin = 1 GoldSlot point  (adjust ratio here if needed)
const FC_TO_GS_RATIO = 1;

// ── MIME map ────────────────────────────────────────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".webp": "image/webp",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".mp3":  "audio/mpeg",
  ".ogg":  "audio/ogg",
  ".wav":  "audio/wav",
  ".mp4":  "video/mp4",
  ".webm": "video/webm",
  ".woff": "font/woff",
  ".woff2":"font/woff2",
  ".ttf":  "font/ttf",
  ".txt":  "text/plain; charset=utf-8",
};
function getMime(fp) { return MIME[path.extname(fp).toLowerCase()] ?? "application/octet-stream"; }

// ── Asset cache ─────────────────────────────────────────────────────────────
const _assetCache = new Map();

function normalizeAssetUrlPath(p) {
  const clean = String(p || "").split("?")[0].split("#")[0].replace(/\\/g, "/");
  const norm  = path.posix.normalize(clean);
  return norm.startsWith("/") ? norm : `/${norm}`;
}

function assetUrlToDiskPath(urlPath) {
  const n = normalizeAssetUrlPath(urlPath);
  if (!n.startsWith("/assets/")) return null;
  const rel = n.slice("/assets/".length);
  if (rel.includes("\0") || rel.startsWith("/") || rel.includes("../") || rel === "..") return null;
  const disk = path.resolve(GAMES_ASSETS_DIR, rel);
  const chk  = path.relative(GAMES_ASSETS_DIR, disk).replace(/\\/g, "/");
  if (chk.startsWith("..") || path.isAbsolute(chk)) return null;
  return disk;
}

function _preloadAssets() {
  _assetCache.clear();
  if (!fs.existsSync(GAMES_ASSETS_DIR)) {
    console.warn(`[Web] Assets dir missing: ${GAMES_ASSETS_DIR}`);
    return;
  }
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile()) continue;
      try {
        const buf = fs.readFileSync(full);
        const rel = path.relative(GAMES_ASSETS_DIR, full).replace(/\\/g, "/");
        _assetCache.set(normalizeAssetUrlPath(`/assets/${rel}`), { buf, mime: getMime(full) });
      } catch (e) { console.error("[Web] Asset preload:", e); }
    }
  };
  walk(GAMES_ASSETS_DIR);
  console.log(`[Web] Preloaded ${_assetCache.size} game asset(s) into memory.`);
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────
function rawFetch(url, opts = {}, maxRedirects = 4) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod    = parsed.protocol === "https:" ? https : http;
    const bodyBuf = opts.body ? Buffer.from(opts.body) : Buffer.alloc(0);
    const headers = {
      "User-Agent": "Mozilla/5.0 (compatible; SirGreenCasino/3.0)",
      Accept: "*/*",
      "Accept-Encoding": "gzip, deflate, br",
      ...(opts.headers ?? {}),
      "Content-Length": bodyBuf.length,
    };
    const r = mod.request(
      { hostname: parsed.hostname, port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search, method: opts.method ?? "GET", headers },
      (res) => {
        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location && maxRedirects > 0)
          return resolve(rawFetch(new URL(res.headers.location, url).toString(), opts, maxRedirects - 1));
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          const enc = (res.headers["content-encoding"] ?? "").toLowerCase();
          const decomp = enc === "br" ? zlib.brotliDecompressSync(raw)
                       : enc === "gzip" ? zlib.gunzipSync(raw)
                       : enc === "deflate" ? zlib.inflateSync(raw) : raw;
          resolve({ statusCode: res.statusCode, headers: res.headers, body: decomp });
        });
      });
    r.on("error", reject);
    if (bodyBuf.length) r.write(bodyBuf);
    r.end();
  });
}
async function nodeFetch(url, opts = {}) {
  return (await rawFetch(url, opts)).body.toString("utf8");
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    out[decodeURIComponent(part.slice(0, idx).trim())] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end",  () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function serveBufferWithRanges(req, res, buf, mime, cc = "public, max-age=86400") {
  const total = buf.length;
  const rh = req.headers.range;
  if (rh) {
    const m = /bytes=(\d*)-(\d*)/.exec(rh);
    const start = m && m[1] ? parseInt(m[1],10) : 0;
    const end   = m && m[2] ? parseInt(m[2],10) : total - 1;
    const safe  = Math.min(end, total - 1);
    if (start >= total || start > safe) { res.writeHead(416,{"Content-Range":`bytes */${total}`}); return res.end(); }
    res.writeHead(206,{"Content-Range":`bytes ${start}-${safe}/${total}`,"Accept-Ranges":"bytes","Content-Length":safe-start+1,"Content-Type":mime,"Cache-Control":cc});
    return res.end(buf.slice(start, safe+1));
  }
  res.writeHead(200,{"Content-Type":mime,"Content-Length":total,"Accept-Ranges":"bytes","Cache-Control":cc});
  res.end(buf);
}

function serveFileWithRanges(req, res, fp, mime = getMime(fp), cc = "public, max-age=86400") {
  fs.stat(fp, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404,{"Cache-Control":"no-store"}); return res.end("Not found"); }
    const total = stat.size;
    const rh = req.headers.range;
    if (!rh) {
      res.writeHead(200,{"Content-Type":mime,"Content-Length":total,"Accept-Ranges":"bytes","Cache-Control":cc});
      return fs.createReadStream(fp).pipe(res);
    }
    const m = /bytes=(\d*)-(\d*)/.exec(rh);
    const start = m && m[1] ? parseInt(m[1],10) : 0;
    const end   = m && m[2] ? parseInt(m[2],10) : total - 1;
    const safe  = Math.min(end, total - 1);
    if (start >= total || start > safe) { res.writeHead(416,{"Content-Range":`bytes */${total}`}); return res.end(); }
    res.writeHead(206,{"Content-Range":`bytes ${start}-${safe}/${total}`,"Accept-Ranges":"bytes","Content-Length":safe-start+1,"Content-Type":mime,"Cache-Control":cc});
    fs.createReadStream(fp, {start, end: safe}).pipe(res);
  });
}

// ── Shared CSS ───────────────────────────────────────────────────────────────
const SHARED_CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{-webkit-font-smoothing:antialiased;scroll-behavior:smooth}
body{background:#060e06;color:#e2ffe2;font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;overflow-x:hidden}
a{color:inherit;text-decoration:none}
button{cursor:pointer;background:none;border:none;color:inherit;font:inherit}
::-webkit-scrollbar{width:6px}::-webkit-scrollbar-track{background:#0a1a0a}::-webkit-scrollbar-thumb{background:#2ecc7155;border-radius:99px}
.nav{position:sticky;top:0;z-index:100;background:rgba(6,14,6,.92);backdrop-filter:blur(12px);border-bottom:1px solid #2ecc7122;display:flex;align-items:center;gap:.8rem;padding:.5rem 1.2rem;min-height:48px}
.nav-logo{font-weight:900;color:#2ecc71;font-size:.95rem;white-space:nowrap}
.nav-spacer{flex:1}
.nav-bal{font-size:.75rem;font-weight:700;color:#a8e6a8;white-space:nowrap}
.nav-bal strong{color:#2ecc71}
.nav-logout{font-size:.65rem;color:#3a6b3a;border-bottom:1px solid #2ecc7122}
.nav-logout:hover{color:#2ecc71}
.wrap{padding:1.2rem;max-width:1100px;margin:0 auto}
.section-title{font-size:.85rem;font-weight:900;letter-spacing:.08em;text-transform:uppercase;color:#2ecc71;text-shadow:0 0 10px #2ecc7155;margin-bottom:1.1rem}
.provider-title{font-size:.7rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#4a9a4a;margin:1.4rem 0 .55rem}
.games-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:.75rem}
.game-card{background:#0a1f0a;border:1px solid #2ecc7122;border-radius:11px;overflow:hidden;cursor:pointer;transition:transform .18s,box-shadow .18s,border-color .18s}
.game-card:hover{transform:translateY(-3px) scale(1.02);box-shadow:0 8px 28px #2ecc7133;border-color:#2ecc7166}
.game-thumb{width:100%;aspect-ratio:4/3;background:linear-gradient(135deg,#071507,#0d2b0d);display:flex;align-items:center;justify-content:center;font-size:2.5rem;overflow:hidden}
.game-thumb img{width:100%;height:100%;object-fit:cover}
.game-info{padding:.4rem .5rem .5rem}
.game-name{font-size:.68rem;font-weight:700;color:#c8f5c8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.game-meta{font-size:.58rem;color:#4a9a4a;margin-top:.1rem}
.login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
.login-card{background:linear-gradient(160deg,#0e230e,#071507);border:2px solid #2ecc7133;border-radius:18px;padding:2.2rem 1.8rem;max-width:360px;width:100%;text-align:center;box-shadow:0 0 50px #2ecc7111}
.login-logo{font-size:2.8rem;margin-bottom:.3rem}
.login-title{font-size:1.7rem;font-weight:900;color:#2ecc71;text-shadow:0 0 16px #2ecc71bb;margin-bottom:.2rem}
.login-sub{font-size:.68rem;letter-spacing:.22em;text-transform:uppercase;color:#4a9a4a;margin-bottom:1.2rem}
.login-desc{font-size:.84rem;color:#a8d5a8;display:block;margin-bottom:1.2rem;line-height:1.6}
.login-btn{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;background:linear-gradient(135deg,#27ae60,#2ecc71);color:#060e06;font-size:.9rem;font-weight:900;padding:.75rem 1.6rem;border-radius:9px;box-shadow:0 4px 18px #2ecc7144;transition:all .18s;width:100%}
.login-btn:hover{box-shadow:0 6px 26px #2ecc7166;transform:translateY(-1px)}
.login-footer{margin-top:1rem;font-size:.64rem;color:#2a4a2a;line-height:1.7}
.err-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
.err-card{background:#0e230e;border:2px solid #2ecc7133;border-radius:14px;padding:1.8rem;max-width:380px;width:100%;text-align:center;box-shadow:0 0 36px #2ecc7111}
.err-card h1{color:#2ecc71;font-size:1.3rem;margin-bottom:.7rem}
.err-card p{color:#a8d5a8;margin-bottom:.7rem;line-height:1.6}
.err-btn{display:inline-flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#27ae60,#2ecc71);color:#060e06;font-weight:900;padding:.65rem 1.3rem;border-radius:8px;margin-top:.5rem;cursor:pointer;font-size:.84rem;transition:all .18s}
.err-btn:hover{transform:translateY(-1px);box-shadow:0 4px 18px #2ecc7155}
.loading{text-align:center;padding:3rem;color:#4a9a4a;font-size:.85rem}
`;

function shell(head, body) {
  return `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>SirGreen Casino</title>\n<style>${SHARED_CSS}</style>\n${head ?? ""}\n</head>\n<body>\n${body}\n</body>\n</html>`;
}

function lobbyPage(bal, tag, gamesByProvider) {
  let sections = "";
  if (!gamesByProvider || gamesByProvider.length === 0) {
    sections = `<p style="color:#4a9a4a;font-size:.82rem">No games available right now. Please check back later.</p>`;
  } else {
    for (const { provider, providerName, games } of gamesByProvider) {
      const cards = games.map(g => {
        const gid = String(g.game_id ?? g.id ?? g.code ?? "");
        const thumb = g.image_url
          ? `<img src="${esc(g.image_url)}" alt="${esc(g.name)}" loading="lazy">`
          : `<span style="font-size:2.5rem">🎰</span>`;
        return `<div class="game-card" onclick="location.href='/game/${esc(gid)}'">
  <div class="game-thumb">${thumb}</div>
  <div class="game-info"><div class="game-name">${esc(g.name)}</div><div class="game-meta">${esc(g.game_type ?? g.type ?? provider)}</div></div>
</div>`;
      }).join("\n");
      sections += `<div class="provider-title">🎮 ${esc(providerName ?? provider)}</div>\n<div class="games-grid">\n${cards}\n</div>\n`;
    }
  }
  return shell("",
    `<nav class="nav">
  <div class="nav-logo">🎰 SirGreen Casino</div>
  <div class="nav-spacer"></div>
  <div class="nav-bal">Balance: <strong>${Number(bal).toLocaleString()} FC</strong></div>
  <span style="font-size:.75rem;color:#a8d5a8">${esc(tag)}</span>
  <a href="/logout" class="nav-logout">logout</a>
</nav>
<div class="wrap"><div class="section-title">🎮 Game Lobby</div>${sections}</div>`);
}

function loginPage(authUrl) {
  return shell("",
    `<div class="login-wrap"><div class="login-card"><div class="login-logo">🎰</div><div class="login-title">SirGreen Casino</div><div class="login-sub">Powered by FluxCoins</div><span class="login-desc">Login with your <strong style="color:#2ecc71">Fluxer</strong> account to play with your FluxCoin balance.</span><a class="login-btn" href="${esc(authUrl)}">&#128994;&nbsp; Login with Fluxer</a><div class="login-footer">Global FluxCoin economy across all Fluxer servers.<br>Play responsibly.</div></div></div>`);
}

function errPage(title, msg, href, label) {
  return shell("",
    `<div class="err-wrap"><div class="err-card"><h1>${esc(title)}</h1><p>${esc(msg)}</p><a class="err-btn" href="${esc(href ?? "/login")}">${esc(label ?? "Back")}</a></div></div>`);
}

function gameWrapperPage(bal, tag, gameUrl, gameName) {
  const safeBal = Number(bal) || 0;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>${esc(gameName)} — SirGreen Casino</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden;background:#040d04;font-family:'Segoe UI',system-ui,sans-serif;color:#e2ffe2;-webkit-font-smoothing:antialiased}
a,button{color:inherit;cursor:pointer;background:none;border:none;font:inherit;text-decoration:none}
#fcBar{position:fixed;top:0;left:0;right:0;z-index:9999;display:flex;align-items:center;gap:.6rem;padding:.38rem .75rem;background:rgba(4,13,4,.97);backdrop-filter:blur(12px);border-bottom:2px solid #2ecc7133;font-size:.76rem;min-height:42px;user-select:none}
.fc-back{background:#0a1f0a;border:1px solid #2ecc7133;color:#a8e6a8;padding:.22rem .6rem;border-radius:6px;font-size:.7rem;font-weight:700;white-space:nowrap;transition:border-color .18s,color .18s}
.fc-back:hover{border-color:#2ecc71;color:#2ecc71}
.fc-spacer{flex:1}
.fc-title{font-size:.72rem;color:#c8f5c8;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px}
.fc-bal{display:flex;align-items:center;gap:.28rem;background:#0a1f0a;border:1px solid #2ecc7133;border-radius:7px;padding:.22rem .55rem;font-weight:700;white-space:nowrap}
.fc-bal strong{color:#2ecc71;font-size:.88rem}
.fc-user{font-size:.67rem;color:#4a8a4a;white-space:nowrap;max-width:120px;overflow:hidden;text-overflow:ellipsis}
.fc-logout{font-size:.64rem;color:#3a6b3a;border-bottom:1px solid #2ecc7122;white-space:nowrap}
.fc-logout:hover{color:#2ecc71}
#gameFrame{position:fixed;top:42px;left:0;right:0;bottom:0;width:100%;height:calc(100% - 42px);border:none;display:block;background:#040d04}
</style>
</head>
<body>
<div id="fcBar">
  <button class="fc-back" onclick="exitGame()">&#8592; Lobby</button>
  <span class="fc-title">${esc(gameName)}</span>
  <span class="fc-spacer"></span>
  <div class="fc-bal">💰&nbsp;<strong id="fcBalNum">${safeBal.toLocaleString()}</strong>&nbsp;FC</div>
  <span class="fc-user">${esc(tag)}</span>
  <a href="/logout" class="fc-logout">logout</a>
</div>
<iframe id="gameFrame" src="${esc(gameUrl)}" allow="autoplay; fullscreen" allowfullscreen></iframe>
<script>
(function(){
  let leaving=false;
  async function syncBalance(){
    try{
      const r=await fetch('/api/goldslot/sync-balance',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      const d=await r.json();
      if(r.ok&&d.newBal!==undefined) document.getElementById('fcBalNum').textContent=d.newBal.toLocaleString();
    }catch(_){}
  }
  const timer=setInterval(syncBalance,15000);
  window.exitGame=async function(){
    if(leaving)return;
    leaving=true;
    clearInterval(timer);
    await syncBalance();
    location.href='/lobby';
  };
  document.getElementById('gameFrame').addEventListener('load',syncBalance);
})();
</script>
</body>
</html>`;
}

// ============================================================================
// WebServer
// ============================================================================
export class WebServer {
  constructor(db, config) {
    this.db            = db;
    this.config        = config;
    this.port          = config.webPort ?? 80;
    this.clientId      = config.fluxerClientId ?? config.discordClientId ?? "";
    this.clientSecret  = config.fluxerClientSecret ?? config.discordClientSecret ?? "";
    this.baseUrl       = config.webBaseUrl ?? "https://www.sirgreen.online";
    this.redirectUri   = `${this.baseUrl}/oauth/callback`;
    this._states       = new Map();

    const gsToken = config.goldSlotApiToken ?? "";
    const gsUrl   = config.goldSlotApiUrl   ?? "https://agent.goldslotpalase.com";
    this.goldSlot      = gsToken ? new GoldSlotAPI(gsToken, gsUrl) : null;
    this.callbackToken = config.goldSlotCallbackToken ?? "";

    this._gamesCache   = null;
    this._gamesCacheTs = 0;
    this._gameById     = new Map();

    // Idempotency store: trans_guid → { type, account, amount }
    // Max 50 000 entries; oldest 5 000 pruned when full.
    this._processedTrans = new Map();
  }

  // ── Game catalogue ──────────────────────────────────────────────────────────

  /**
   * Fetch full game list from GoldSlot API.
   *
   * Strategy 1 — POST /v4/game/all: handles two response shapes:
   *   Shape A: [{ provider, name, games:[...] }]
   *   Shape B: flat array of game objects (grouped by provider_code)
   *
   * Strategy 2 (fallback) — POST /v4/game/providers → POST /v4/game/games per provider.
   *
   * Results are cached for 10 minutes.
   */
  async _fetchGames() {
    if (!this.goldSlot) return [];
    const now = Date.now();
    if (this._gamesCache && now - this._gamesCacheTs < 10 * 60 * 1000) return this._gamesCache;

    let grouped = [];

    // ── Strategy 1: /v4/game/all ─────────────────────────────────────────────
    try {
      const resp = await this.goldSlot.getAllGames(1);
      console.log("[GoldSlot] /v4/game/all → code:", resp.code,
        "data:", Array.isArray(resp.data) ? `array[${resp.data.length}]` : typeof resp.data);

      if (resp.code === 0 && Array.isArray(resp.data) && resp.data.length > 0) {
        const first = resp.data[0];

        if (Array.isArray(first?.games)) {
          // Shape A: provider-grouped
          for (const prov of resp.data) {
            const games = Array.isArray(prov.games) ? prov.games : [];
            const pc = String(prov.provider ?? prov.code ?? prov.id ?? "UNKNOWN");
            const pn = String(prov.name ?? pc);
            for (const g of games)
              this._gameById.set(String(g.game_id ?? g.id ?? g.code ?? ""), { ...g, providerCode: pc, providerName: pn });
            if (games.length) grouped.push({ provider: pc, providerName: pn, games });
          }
        } else if (first?.game_id !== undefined || first?.id !== undefined || first?.code !== undefined) {
          // Shape B: flat list
          const byProv = new Map();
          for (const g of resp.data) {
            const pc = String(g.provider_code ?? g.provider ?? "UNKNOWN");
            const pn = String(g.provider_name ?? pc);
            if (!byProv.has(pc)) byProv.set(pc, { provider: pc, providerName: pn, games: [] });
            byProv.get(pc).games.push(g);
            this._gameById.set(String(g.game_id ?? g.id ?? g.code ?? ""), { ...g, providerCode: pc, providerName: pn });
          }
          grouped = [...byProv.values()];
        } else {
          console.warn("[GoldSlot] /v4/game/all unknown shape:", JSON.stringify(first).slice(0, 300));
        }
      }
    } catch (e) {
      console.error("[GoldSlot] /v4/game/all exception:", e.message);
    }

    // ── Strategy 2: providers → games per provider ───────────────────────────
    if (grouped.length === 0) {
      console.log("[GoldSlot] Falling back to providers+games fetch…");
      try {
        const provResp = await this.goldSlot.getProviders(1);
        console.log("[GoldSlot] /v4/game/providers → code:", provResp.code,
          "count:", Array.isArray(provResp.data) ? provResp.data.length : provResp.data);

        if (provResp.code === 0 && Array.isArray(provResp.data)) {
          for (const prov of provResp.data) {
            const pc = String(prov.provider ?? prov.code ?? prov.id ?? "UNKNOWN");
            const pn = String(prov.name ?? pc);
            try {
              const gr = await this.goldSlot.getGames(pc, 1);
              const games = Array.isArray(gr.data) ? gr.data : [];
              console.log(`[GoldSlot] provider=${pc} → ${games.length} games`);
              for (const g of games)
                this._gameById.set(String(g.game_id ?? g.id ?? g.code ?? ""), { ...g, providerCode: pc, providerName: pn });
              if (games.length) grouped.push({ provider: pc, providerName: pn, games });
            } catch (e) {
              console.error(`[GoldSlot] getGames(${pc}) error:`, e.message);
            }
          }
        }
      } catch (e) {
        console.error("[GoldSlot] getProviders exception:", e.message);
      }
    }

    if (grouped.length > 0) {
      this._gamesCache   = grouped;
      this._gamesCacheTs = now;
      const total = grouped.reduce((s, p) => s + p.games.length, 0);
      console.log(`[GoldSlot] Cached ${total} game(s) across ${grouped.length} provider(s).`);
    } else {
      // Don't cache empty results — retry next request
      console.warn("[GoldSlot] No games loaded. Check goldSlotApiToken and agent approval status.");
    }
    return grouped;
  }

  async _ensureGsUser(uid) {
    if (!this.goldSlot) return null;
    try {
      const info = await this.goldSlot.userInfo(uid);
      if (info.code === 0) return info.data;
      if (info.code === 2002) {
        const created = await this.goldSlot.userCreate(uid);
        if (created.code === 0) return created.data;
        console.error("[GoldSlot] userCreate failed:", created);
        return null;
      }
      console.error("[GoldSlot] userInfo error:", info);
      return null;
    } catch (e) {
      console.error("[GoldSlot] _ensureGsUser:", e);
      return null;
    }
  }

  async _depositToGS(uid) {
    if (!this.goldSlot) return 0;
    const user     = await this.db.getUser(uid);
    const fcBal    = Math.floor(Number(user?.bal ?? 0));
    if (fcBal <= 0) return 0;
    const gsPoints = Math.floor(fcBal / FC_TO_GS_RATIO);
    if (gsPoints <= 0) return 0;
    try {
      const resp = await this.goldSlot.walletDeposit(uid, gsPoints);
      if (resp.code === 0) { await this.db.updateBalance(uid, -fcBal); return gsPoints; }
      console.error("[GoldSlot] walletDeposit error:", resp);
      return 0;
    } catch (e) { console.error("[GoldSlot] _depositToGS:", e); return 0; }
  }

  async _withdrawFromGS(uid) {
    if (!this.goldSlot) return 0;
    try {
      const resp = await this.goldSlot.walletWithdrawAll(uid);
      if (resp.code === 0) {
        const returned = Math.floor(Number(resp.data?.amount ?? 0) * FC_TO_GS_RATIO);
        if (returned > 0) await this.db.updateBalance(uid, returned);
        return returned;
      }
      if (resp.code === 2006) return 0; // wallet already empty — fine
      console.error("[GoldSlot] walletWithdrawAll error:", resp);
      return 0;
    } catch (e) { console.error("[GoldSlot] _withdrawFromGS:", e); return 0; }
  }

  // ── Idempotency helper ──────────────────────────────────────────────────────
  _markTrans(guid, entry) {
    if (!guid) return;
    this._processedTrans.set(guid, entry);
    if (this._processedTrans.size > 50000) {
      const iter = this._processedTrans.keys();
      for (let i = 0; i < 5000; i++) this._processedTrans.delete(iter.next().value);
    }
  }

  // ── Callback token validation ───────────────────────────────────────────────
  _isValidCallbackToken(req) {
    if (!this.callbackToken) return true; // not configured → allow (dev mode)
    const incoming = (
      req.headers["callback-token"] ??
      req.headers["Callback-Token"] ??
      ""
    ).trim();
    return incoming === this.callbackToken;
  }

  /**
   * Send the GoldSlot callback response.
   * balance MUST be a plain integer — never a float.
   */
  _cbReply(res, result, status, data) {
    const body = { result, status };
    if (data !== undefined) body.data = data;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  // ============================================================================
  // GoldSlot Seamless Callback API
  // POST /callback
  //
  // Commands (all per the official spec):
  //   authenticate — verify user exists, return balance
  //   balance      — return current balance  (must reply <2 s)
  //   bet          — deduct bet amount       (must reply <2 s)
  //   win          — credit win amount (0 on loss)
  //   cancel       — refund a bet (BetCancel type 16)
  //   status       — report whether a trans_guid was processed
  // ============================================================================
  async _handleCallback(req, res) {
    if (!this._isValidCallbackToken(req)) {
      console.warn("[Callback] Rejected — bad Callback-Token");
      return this._cbReply(res, 1, "INVALID_TOKEN");
    }

    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      return this._cbReply(res, 1, "INVALID_JSON");
    }

    const { command, data, check } = payload;
    if (!command || !data) return this._cbReply(res, 1, "MISSING_FIELDS");

    // Parse fields — types matter (balance must be int)
    const account         = String(data.account         ?? "");
    const transGuid       = String(data.trans_guid      ?? "");
    const cancelTransGuid = String(data.cancel_trans_guid ?? data.cancle_trans_guid ?? "");
    const amount          = Number(data.amount ?? 0);   // may be 0 (loss win)
    const checks          = String(check ?? "").split(",").map(s => s.trim());

    // ── Resolve DB user ───────────────────────────────────────────────────────
    let user;
    try { user = await this.db.getUser(account); }
    catch (e) {
      console.error("[Callback] DB lookup failed:", e);
      return this._cbReply(res, 1001, "INTERNAL_ERROR");
    }

    // Check 21 — user must exist
    if (checks.includes("21") && !user) {
      console.warn(`[Callback] USER_NOT_FOUND account=${account} cmd=${command}`);
      return this._cbReply(res, 1, "USER_NOT_FOUND");
    }
    // Check 22 — user must not be banned/inactive
    if (checks.includes("22") && user?.banned) {
      return this._cbReply(res, 1, "USER_INACTIVE");
    }

    // Always work with integer balances
    const currentBal = Math.round(Number(user?.bal ?? 0));

    // ══ authenticate ══════════════════════════════════════════════════════════
    if (command === "authenticate") {
      if (!user) return this._cbReply(res, 1, "USER_NOT_FOUND");
      console.log(`[Callback] authenticate account=${account} bal=${currentBal}`);
      return this._cbReply(res, 0, "OK", { account, balance: currentBal });
    }

    // ══ balance ═══════════════════════════════════════════════════════════════
    // ⚠ Must respond within 2 seconds.
    if (command === "balance") {
      if (!user) return this._cbReply(res, 1, "USER_NOT_FOUND");
      console.log(`[Callback] balance account=${account} bal=${currentBal}`);
      return this._cbReply(res, 0, "OK", { balance: currentBal });
    }

    // ══ bet ═══════════════════════════════════════════════════════════════════
    // ⚠ Must respond within 2 seconds.
    // On timeout/500 GoldSlot automatically sends a cancel to refund the bet.
    if (command === "bet") {
      // Check 41 — idempotency: duplicate bet → return current balance silently
      if (checks.includes("41") && transGuid && this._processedTrans.has(transGuid)) {
        console.warn(`[Callback] Duplicate bet ignored trans=${transGuid}`);
        return this._cbReply(res, 0, "OK", { balance: currentBal });
      }
      if (!user) return this._cbReply(res, 1, "USER_NOT_FOUND");

      const betAmt = Math.round(amount); // integer

      // Check 31 — insufficient balance
      if (betAmt > 0 && currentBal < betAmt) {
        console.warn(`[Callback] BALANCE_NOT_ENOUGH account=${account} bal=${currentBal} bet=${betAmt}`);
        return this._cbReply(res, 1, "BALANCE_NOT_ENOUGH");
      }

      let newBal = currentBal;
      if (betAmt > 0) {
        try {
          await this.db.updateBalance(account, -betAmt);
          const refreshed = await this.db.getUser(account);
          newBal = Math.round(Number(refreshed?.bal ?? currentBal - betAmt));
        } catch (e) {
          console.error("[Callback] DB error on bet:", e);
          return this._cbReply(res, 1001, "INTERNAL_ERROR");
        }
      }

      this._markTrans(transGuid, { type: "bet", account, amount: betAmt });
      console.log(`[Callback] bet  account=${account} amount=${betAmt} newBal=${newBal} trans=${transGuid}`);
      return this._cbReply(res, 0, "OK", { balance: newBal });
    }

    // ══ win ═══════════════════════════════════════════════════════════════════
    // Called for both wins AND losses (amount=0 on loss). Always return OK.
    if (command === "win") {
      // Check 41 — idempotency
      if (checks.includes("41") && transGuid && this._processedTrans.has(transGuid)) {
        const existing = this._processedTrans.get(transGuid);
        if (existing?.type === "win") {
          console.warn(`[Callback] Duplicate win ignored trans=${transGuid}`);
          return this._cbReply(res, 0, "OK", { balance: currentBal });
        }
      }
      if (!user) return this._cbReply(res, 1, "USER_NOT_FOUND");

      const winAmt = Math.round(amount);
      let newBal = currentBal;

      if (winAmt > 0) {
        try {
          await this.db.updateBalance(account, winAmt);
          const refreshed = await this.db.getUser(account);
          newBal = Math.round(Number(refreshed?.bal ?? currentBal + winAmt));
          await this.db.recordGame(account, true, winAmt).catch(() => {});
        } catch (e) {
          console.error("[Callback] DB error on win:", e);
          return this._cbReply(res, 1001, "INTERNAL_ERROR");
        }
      } else {
        // Loss — record it if recordGame supports that
        await this.db.recordGame(account, false, 0).catch(() => {});
      }

      this._markTrans(transGuid, { type: "win", account, amount: winAmt });
      console.log(`[Callback] win  account=${account} amount=${winAmt} newBal=${newBal} trans=${transGuid}`);
      return this._cbReply(res, 0, "OK", { balance: newBal });
    }

    // ══ cancel ════════════════════════════════════════════════════════════════
    // Refunds a previous bet (BetCancel, type 16).
    // Sent on: timeout, 500 error, or explicit cancel.
    // Retried up to 50× every 2–4 s until OK.
    if (command === "cancel") {
      // Check 43 — idempotency: duplicate cancel
      if (checks.includes("43") && cancelTransGuid && this._processedTrans.has(cancelTransGuid)) {
        console.warn(`[Callback] Duplicate cancel ignored cancelTrans=${cancelTransGuid}`);
        return this._cbReply(res, 0, "OK", { balance: currentBal });
      }
      if (!user) return this._cbReply(res, 1, "USER_NOT_FOUND");

      // Use stored bet amount for exact refund; fall back to payload amount
      const originalBet = Math.round(
        this._processedTrans.get(transGuid)?.amount ?? amount
      );

      let newBal = currentBal;
      if (originalBet > 0) {
        try {
          await this.db.updateBalance(account, originalBet);
          const refreshed = await this.db.getUser(account);
          newBal = Math.round(Number(refreshed?.bal ?? currentBal + originalBet));
        } catch (e) {
          console.error("[Callback] DB error on cancel:", e);
          return this._cbReply(res, 1001, "INTERNAL_ERROR");
        }
      }

      // Mark cancel guid; void the original bet entry
      this._markTrans(cancelTransGuid, { type: "cancel", account, amount: originalBet });
      if (transGuid) this._processedTrans.delete(transGuid);

      console.log(`[Callback] cancel account=${account} refund=${originalBet} newBal=${newBal} trans=${transGuid}`);
      return this._cbReply(res, 0, "OK", { balance: newBal });
    }

    // ══ status ════════════════════════════════════════════════════════════════
    // GoldSlot checks whether a specific trans_guid was processed.
    if (command === "status") {
      const entry = this._processedTrans.get(transGuid);
      // Check 42 — if missing and check 42 is required, report not found
      if (checks.includes("42") && !entry) {
        return this._cbReply(res, 1, "TRANSACTION_NOT_FOUND");
      }
      console.log(`[Callback] status trans=${transGuid} found=${!!entry}`);
      return this._cbReply(res, 0, "OK", {
        account,
        trans_guid:   transGuid,
        trans_status: entry ? "OK" : "NOT_FOUND",
      });
    }

    console.warn(`[Callback] Unknown command: ${command}`);
    return this._cbReply(res, 1, "UNKNOWN_COMMAND");
  }

  // ── Server lifecycle ────────────────────────────────────────────────────────

  async start() {
    _preloadAssets();

    // Warm up the game catalogue in the background — errors are non-fatal
    this._fetchGames().catch(e => console.error("[GoldSlot] Pre-warm failed:", e));

    this._server = http.createServer((req, res) =>
      this._handle(req, res).catch(e => {
        console.error("[Web]", e);
        if (!res.headersSent) { res.writeHead(500); res.end("Internal error"); }
      }));

    this._server.listen(this.port, "0.0.0.0", () =>
      console.log(`[Web] SirGreen Casino on port ${this.port}`));

    // Clean up expired OAuth states every 10 minutes
    setInterval(() => {
      const cut = Date.now() - 15 * 60 * 1000;
      for (const [s, ts] of this._states) if (ts < cut) this._states.delete(s);
    }, 10 * 60 * 1000);
  }

  // ── Request router ──────────────────────────────────────────────────────────

  async _handle(req, res) {
    const u = new URL(req.url, "http://localhost");
    const p = normalizeAssetUrlPath(u.pathname);

    if (p === "/") return this._redirect(res, "/lobby");

    // Favicon
    if (p === "/favicon.ico") {
      if (fs.existsSync(FAVICON_PATH)) return serveFileWithRanges(req, res, FAVICON_PATH, "image/x-icon");
      res.writeHead(204); return res.end();
    }

    // ── GoldSlot Seamless Callback ──────────────────────────────────────────
    // GET /callback → 200 OK health-check (lets GoldSlot admin verify the URL)
    // POST /callback → actual seamless wallet handler
    if (p === "/callback") {
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: true, service: "SirGreen Casino callback" }));
      }
      if (req.method === "POST") return this._handleCallback(req, res);
      res.writeHead(405, { Allow: "GET, POST" }); return res.end("Method Not Allowed");
    }

    // ── Static game assets ──────────────────────────────────────────────────
    if (p.startsWith("/assets/")) {
      const cached = _assetCache.get(p);
      if (cached) return serveBufferWithRanges(req, res, cached.buf, cached.mime);
      const disk = assetUrlToDiskPath(p);
      if (disk && fs.existsSync(disk)) return serveFileWithRanges(req, res, disk, getMime(disk));
      console.warn("[Web] Asset cache miss, serving from disk:", p);
      res.writeHead(404, { "Cache-Control": "no-store" }); return res.end("Not found");
    }

    // ── Lobby ───────────────────────────────────────────────────────────────
    if (p === "/lobby" && req.method === "GET") {
      const uid = this._uid(req);
      if (!uid) return this._redirect(res, "/login");
      const user = await this.db.getUser(uid);
      const cookies = parseCookies(req);
      const bal = Number(user?.bal ?? 0);
      const tag = decodeURIComponent(cookies.dtag ?? "Player");
      const gamesByProvider = await this._fetchGames();
      return this._html(res, 200, lobbyPage(bal, tag, gamesByProvider));
    }

    // ── Launch game ─────────────────────────────────────────────────────────
    if (p.startsWith("/game/") && req.method === "GET") {
      const uid = this._uid(req);
      if (!uid) return this._redirect(res, "/login");
      const gameId = decodeURIComponent(p.slice("/game/".length).split("/")[0]);
      if (!gameId) return this._redirect(res, "/lobby");
      if (!this.goldSlot)
        return this._html(res, 503, errPage("⚠️ Not Configured", "goldSlotApiToken is not set in config.json.", "/lobby", "Back"));

      const gsUser = await this._ensureGsUser(uid);
      if (!gsUser)
        return this._html(res, 500, errPage("⚠️ Error", "Could not create your casino account. Try again.", "/lobby", "Back"));

      await this._depositToGS(uid);

      let gameUrl;
      try {
        const urlResp = await this.goldSlot.getGameUrl(uid, gameId, `${this.baseUrl}/lobby`, 1);
        if (urlResp.code !== 0 || !urlResp.data?.url)
          return this._html(res, 500, errPage("⚠️ Error",
            `Could not launch game (code ${urlResp.code}: ${urlResp.message ?? ""}). Check that the agent is Approved in the GoldSlot admin.`,
            "/lobby", "Back to Lobby"));
        gameUrl = urlResp.data.url;
      } catch (e) {
        console.error("[GoldSlot] getGameUrl:", e);
        return this._html(res, 500, errPage("⚠️ Error", "Game launch failed.", "/lobby", "Back"));
      }

      // Refresh game meta (usually cached)
      await this._fetchGames();
      const gameMeta = this._gameById.get(String(gameId));
      const gameName = gameMeta?.name ?? gameId;
      const cookies  = parseCookies(req);
      const user     = await this.db.getUser(uid);
      const bal      = Number(user?.bal ?? 0);
      const tag      = decodeURIComponent(cookies.dtag ?? "Player");
      return this._html(res, 200, gameWrapperPage(bal, tag, gameUrl, gameName));
    }

    // ── Sync balance (Transfer Mode pull-back) ──────────────────────────────
    if (p === "/api/goldslot/sync-balance" && req.method === "POST") {
      const uid = this._uid(req);
      if (!uid) return this._json(res, 401, { error: "Not logged in" });
      const returned = await this._withdrawFromGS(uid);
      if (returned > 0) await this.db.recordGame(uid, true, returned).catch(() => {});
      const updated = await this.db.getUser(uid);
      const newBal  = Number(updated?.bal ?? 0);
      return this._json(res, 200, { ok: true, newBal });
    }

    // ── Balance API ─────────────────────────────────────────────────────────
    if (p === "/api/balance" && req.method === "GET") {
      const uid = this._uid(req);
      if (!uid) return this._json(res, 401, { error: "Not logged in" });
      const user = await this.db.getUser(uid);
      return this._json(res, 200, { bal: Number(user?.bal ?? 0) });
    }

    // ── Login ───────────────────────────────────────────────────────────────
    if (p === "/login" && req.method === "GET") {
      if (!this.clientId)
        return this._html(res, 500, errPage("⚠️ Not Configured",
          "Add fluxerClientId, fluxerClientSecret, and webBaseUrl to config.json.", "#", "—"));
      const state = crypto.randomBytes(16).toString("hex");
      this._states.set(state, Date.now());
      const authUrl = `${FLUXER_AUTH_URL}?client_id=${encodeURIComponent(this.clientId)}&scope=identify+guilds&redirect_uri=${encodeURIComponent(this.redirectUri)}&response_type=code&state=${encodeURIComponent(state)}`;
      return this._html(res, 200, loginPage(authUrl));
    }

    // ── OAuth callback ──────────────────────────────────────────────────────
    if (p === "/oauth/callback" && req.method === "GET") {
      const code  = u.searchParams.get("code");
      const state = u.searchParams.get("state");
      if (!code || !state || !this._states.has(state))
        return this._html(res, 400, errPage("❌ Login Failed", "Invalid or expired login state.", "/login", "Try again"));
      this._states.delete(state);

      let tokenData;
      try {
        const raw = await nodeFetch(FLUXER_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id:     this.clientId,
            client_secret: this.clientSecret,
            grant_type:    "authorization_code",
            code,
            redirect_uri:  this.redirectUri,
          }).toString(),
        });
        tokenData = JSON.parse(raw);
      } catch (e) {
        console.error("[OAuth]", e);
        return this._html(res, 500, errPage("⚠️ Error", "Could not reach Fluxer.", "/login", "Retry"));
      }

      if (!tokenData.access_token)
        return this._html(res, 400, errPage("❌ Login Failed",
          tokenData.error_description ?? tokenData.message ?? "Unknown error", "/login", "Try again"));

      let me;
      try {
        me = JSON.parse(await nodeFetch(FLUXER_ME_URL, {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        }));
      } catch {
        return this._html(res, 500, errPage("⚠️ Error", "Could not fetch Fluxer profile.", "/login", "Retry"));
      }

      const userId  = me.id;
      const tag     = me.username ?? me.tag ?? userId;
      const avatar  = me.avatar ? `https://cdn.fluxer.app/avatars/${userId}/${me.avatar}.png?size=64` : "";
      const session = crypto.randomBytes(32).toString("hex");
      await this.db.createSession(userId, session, 2 * 60 * 60 * 1000);
      const base = "HttpOnly; Path=/; Max-Age=7200; SameSite=Lax";
      res.setHeader("Set-Cookie", [
        `sid=${session}; ${base}`,
        `uid=${userId}; ${base}`,
        `dtag=${encodeURIComponent(tag)}; Path=/; Max-Age=7200; SameSite=Lax`,
        `dav=${encodeURIComponent(avatar)}; Path=/; Max-Age=7200; SameSite=Lax`,
      ]);
      return this._redirect(res, "/lobby");
    }

    // ── Logout ──────────────────────────────────────────────────────────────
    if (p === "/logout") {
      const uid = this._uid(req);
      if (uid) {
        await this._withdrawFromGS(uid).catch(() => {});
        const c = parseCookies(req);
        if (c.sid) await this.db.revokeSession(uid, c.sid).catch(() => {};
      }
      res.setHeader("Set-Cookie", [
        "sid=; Path=/; Max-Age=0",
        "uid=; Path=/; Max-Age=0",
        "dtag=; Path=/; Max-Age=0",
        "dav=; Path=/; Max-Age=0",
      ]);
      return this._redirect(res, "/login");
    }

    res.writeHead(404); res.end("Not found");
  }

  _uid(req)       { const c = parseCookies(req); return c.sid && c.uid ? c.uid : null; }
  _html(res, s, b){ res.writeHead(s, { "Content-Type": "text/html;charset=utf-8" }); res.end(b); }
  _json(res, s, o){ res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); }
  _redirect(res, l){ res.setHeader("Location", l); res.writeHead(302); res.end(); }
}
