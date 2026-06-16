import http   from "http";
import { URL } from "url";
import crypto  from "crypto";
import https   from "https";
import zlib    from "zlib";
import fs      from "fs";
import path    from "path";
import { fileURLToPath } from "url";
import { GoldSlotAPI }   from "./GoldSlotAPI.mjs";
import { AdminPanel }    from "./AdminPanel.mjs";

// ─── Feature flag ─────────────────────────────────────────────────────────────
const GOLDSLOT_ENABLED = false;
// ─────────────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const GAMES_ASSETS_DIR = path.resolve(__dirname, "../games/assets");
const GAMES_HTML_DIR   = path.resolve(__dirname, "../games");
const FAVICON_PATH     = path.resolve(GAMES_ASSETS_DIR, "favicon.ico");

const FLUXER_AUTH_URL  = "https://web.canary.fluxer.app/oauth2/authorize";
const FLUXER_TOKEN_URL = "https://api.fluxer.app/v1/oauth2/token";
const FLUXER_ME_URL    = "https://api.fluxer.app/v1/users/@me";

const PROVIDER_NAMES = {
  1:"Pragmatic Play",2:"CQ9",3:"PG Soft",4:"Booongo",5:"Playson",
  6:"Habanero",7:"Jili",8:"PlayStar",9:"XGaming",10:"Hacksaw",11:"Live",
};
function providerName(id) { return PROVIDER_NAMES[Number(id)] ?? `Provider ${id}`; }

const MIME = {
  ".html":"text/html; charset=utf-8",".js":"application/javascript; charset=utf-8",
  ".mjs":"application/javascript; charset=utf-8",".css":"text/css; charset=utf-8",
  ".json":"application/json; charset=utf-8",".png":"image/png",".jpg":"image/jpeg",
  ".jpeg":"image/jpeg",".gif":"image/gif",".webp":"image/webp",".svg":"image/svg+xml",
  ".ico":"image/x-icon",".mp3":"audio/mpeg",".ogg":"audio/ogg",".wav":"audio/wav",
  ".mp4":"video/mp4",".webm":"video/webm",".woff":"font/woff",".woff2":"font/woff2",
  ".ttf":"font/ttf",".txt":"text/plain; charset=utf-8",
};
function getMime(fp) { return MIME[path.extname(fp).toLowerCase()] ?? "application/octet-stream"; }

const _assetCache = new Map();

function normalizeAssetUrlPath(p) {
  const clean = String(p||"").split("?")[0].split("#")[0].replace(/\\/g,"/");
  const norm  = path.posix.normalize(clean);
  return norm.startsWith("/") ? norm : `/${norm}`;
}
function assetUrlToDiskPath(urlPath) {
  const n = normalizeAssetUrlPath(urlPath);
  if (!n.startsWith("/assets/")) return null;
  const rel = n.slice("/assets/".length);
  if (rel.includes("\0")||rel.startsWith("/")||rel.includes("../")||rel==="..") return null;
  const disk = path.resolve(GAMES_ASSETS_DIR, rel);
  const chk  = path.relative(GAMES_ASSETS_DIR, disk).replace(/\\/g, "/");
  if (chk.startsWith("..")||path.isAbsolute(chk)) return null;
  return disk;
}
function _preloadAssets() {
  _assetCache.clear();
  if (!fs.existsSync(GAMES_ASSETS_DIR)) { console.warn(`[Web] Assets dir missing: ${GAMES_ASSETS_DIR}`); return; }
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.isFile()) continue;
      try {
        const buf = fs.readFileSync(full);
        const rel = path.relative(GAMES_ASSETS_DIR, full).replace(/\\/g, "/");
        _assetCache.set(normalizeAssetUrlPath(`/assets/${rel}`), { buf, mime: getMime(full) });
      } catch(e) { console.error("[Web] Asset preload:", e); }
    }
  };
  walk(GAMES_ASSETS_DIR);
  console.log(`[Web] Preloaded ${_assetCache.size} game asset(s).`);
}

function rawFetch(url, opts = {}, maxRedirects = 4) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const mod     = parsed.protocol === "https:" ? https : http;
    const bodyBuf = opts.body ? Buffer.from(opts.body) : Buffer.alloc(0);
    const headers = {
      "User-Agent": "Mozilla/5.0 (compatible; SirGreenCasino/3.0)",
      Accept: "*/*",
      "Accept-Encoding": "gzip, deflate, br",
      ...(opts.headers ?? {}),
      "Content-Length": bodyBuf.length,
    };
    const r = mod.request({
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   opts.method ?? "GET",
      headers,
    }, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location && maxRedirects > 0)
        return resolve(rawFetch(new URL(res.headers.location, url).toString(), opts, maxRedirects - 1));
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const raw  = Buffer.concat(chunks);
        const enc  = (res.headers["content-encoding"] ?? "").toLowerCase();
        const decomp = enc === "br" ? zlib.brotliDecompressSync(raw)
                     : enc === "gzip" ? zlib.gunzipSync(raw)
                     : enc === "deflate" ? zlib.inflateSync(raw)
                     : raw;
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
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function serveBufferWithRanges(req, res, buf, mime, cc = "public, max-age=86400") {
  const total = buf.length, rh = req.headers.range;
  if (rh) {
    const m = /bytes=(\d*)-(\d*)/.exec(rh);
    const start = m && m[1] ? parseInt(m[1], 10) : 0;
    const end   = m && m[2] ? parseInt(m[2], 10) : total - 1;
    const safe  = Math.min(end, total - 1);
    if (start >= total || start > safe) { res.writeHead(416, { "Content-Range": `bytes */${total}` }); return res.end(); }
    res.writeHead(206, { "Content-Range": `bytes ${start}-${safe}/${total}`, "Accept-Length": safe - start + 1, "Content-Type": mime, "Cache-Control": cc });
    return res.end(buf.slice(start, safe + 1));
  }
  res.writeHead(200, { "Content-Type": mime, "Content-Length": total, "Accept-Ranges": "bytes", "Cache-Control": cc });
  res.end(buf);
}
function serveFileWithRanges(req, res, fp, mime = getMime(fp), cc = "public, max-age=86400") {
  fs.stat(fp, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404, { "Cache-Control": "no-store" }); return res.end("Not found"); }
    const total = stat.size, rh = req.headers.range;
    if (!rh) { res.writeHead(200, { "Content-Type": mime, "Content-Length": total, "Accept-Ranges": "bytes", "Cache-Control": cc }); return fs.createReadStream(fp).pipe(res); }
    const m     = /bytes=(\d*)-(\d*)/.exec(rh);
    const start = m && m[1] ? parseInt(m[1], 10) : 0;
    const end   = m && m[2] ? parseInt(m[2], 10) : total - 1;
    const safe  = Math.min(end, total - 1);
    if (start >= total || start > safe) { res.writeHead(416, { "Content-Range": `bytes */${total}` }); return res.end(); }
    res.writeHead(206, { "Content-Range": `bytes ${start}-${safe}/${total}`, "Accept-Ranges": "bytes", "Content-Length": safe - start + 1, "Content-Type": mime, "Cache-Control": cc });
    fs.createReadStream(fp, { start, end: safe }).pipe(res);
  });
}

// ─── HTML templates ───────────────────────────────────────────────────────────

const SHARED_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#09090b;--surface:#111113;--surface2:#18181b;--surface3:#1f1f23;--border:#27272a;--border2:#3f3f46;--accent:#22c55e;--accent-hover:#16a34a;--text:#fafafa;--text2:#a1a1aa;--text3:#71717a;--text4:#3f3f46;--gold:#eab308;--red:#ef4444;--blue:#3b82f6;--purple:#a855f7;--radius:8px;--radius-lg:12px}
html{-webkit-font-smoothing:antialiased;scroll-behavior:smooth}
body{background:var(--bg);color:var(--text);font-family:'Inter',system-ui,-apple-system,sans-serif;min-height:100vh;overflow-x:hidden}
a{color:inherit;text-decoration:none}
button{cursor:pointer;background:none;border:none;color:inherit;font:inherit}
::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--border);border-radius:99px}::-webkit-scrollbar-thumb:hover{background:var(--border2)}

.nav{position:sticky;top:0;z-index:100;backdrop-filter:blur(12px) saturate(1.2);-webkit-backdrop-filter:blur(12px) saturate(1.2);background:rgba(9,9,11,.8);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:.75rem;padding:.55rem 1.5rem;min-height:50px}
.nav-logo{display:flex;align-items:center;gap:.45rem;font-weight:800;font-size:.92rem;color:var(--text);letter-spacing:-.01em;white-space:nowrap}
.nav-logo .mark{width:22px;height:22px;border-radius:5px;background:var(--accent);display:flex;align-items:center;justify-content:center;color:var(--bg);font-weight:900;font-size:.7rem}
.nav-logo b{color:var(--accent)}
.nav-spacer{flex:1}
.nav-bal{display:flex;align-items:center;gap:.35rem;font-size:.76rem;font-weight:600;color:var(--text2);white-space:nowrap;background:var(--surface);border:1px solid var(--border);border-radius:99px;padding:.25rem .65rem .25rem .5rem}
.nav-bal b{color:var(--accent);font-weight:700;font-variant-numeric:tabular-nums}
.nav-tag{font-size:.68rem;color:var(--text3);font-weight:500}
.nav-link{font-size:.7rem;font-weight:600;color:var(--text3);padding:.3rem .65rem;border-radius:6px;transition:all .15s;display:inline-flex;align-items:center;gap:.3rem}
.nav-link:hover{background:var(--surface);color:var(--text)}

.wrap{padding:1.5rem;max-width:1100px;margin:0 auto}

.section-title{font-size:.7rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--text3);margin-bottom:1.1rem;display:flex;align-items:center;gap:.45rem}
.section-title::before{content:"";display:block;width:3px;height:12px;background:var(--accent);border-radius:2px}
.provider-title{font-size:.66rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--text3);margin:1.5rem 0 .5rem;padding-bottom:.35rem;border-bottom:1px solid var(--border)}
.games-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(155px,1fr));gap:.6rem}
.game-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;cursor:pointer;transition:all .15s}
.game-card:hover{border-color:var(--border2);transform:translateY(-2px);box-shadow:0 8px 30px rgba(0,0,0,.3)}
.game-thumb{width:100%;aspect-ratio:4/3;background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:2.2rem;overflow:hidden;position:relative}
.game-thumb img{width:100%;height:100%;object-fit:cover}
.game-info{padding:.4rem .55rem .55rem}
.game-name{font-size:.7rem;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.game-meta{font-size:.56rem;color:var(--text3);margin-top:.1rem}

.login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.5rem;background:radial-gradient(ellipse at 50% 0%,#0a1f0a 0%,var(--bg) 60%)}
.login-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);padding:2.5rem 2rem;max-width:380px;width:100%;text-align:center;position:relative}
.login-card::before{content:"";position:absolute;top:0;left:50%;transform:translateX(-50%);width:60%;height:1px;background:linear-gradient(90deg,transparent,var(--accent),transparent)}
.login-logo{font-size:2.5rem;margin-bottom:.5rem}
.login-title{font-size:1.6rem;font-weight:900;color:var(--text);letter-spacing:-.02em;margin-bottom:.15rem}
.login-title b{color:var(--accent)}
.login-sub{font-size:.66rem;letter-spacing:.15em;text-transform:uppercase;color:var(--text3);margin-bottom:1.5rem}
.login-desc{font-size:.85rem;color:var(--text2);display:block;margin-bottom:1.4rem;line-height:1.55}
.login-btn{display:inline-flex;align-items:center;justify-content:center;gap:.45rem;background:var(--accent);color:var(--bg);font-size:.85rem;font-weight:700;padding:.7rem 1.5rem;border-radius:var(--radius);transition:all .15s;width:100%}
.login-btn:hover{background:var(--accent-hover)}
.login-footer{margin-top:1.2rem;font-size:.62rem;color:var(--text4);line-height:1.6}

.err-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.5rem;background:radial-gradient(ellipse at 50% 0%,#0a1f0a 0%,var(--bg) 60%)}
.err-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);padding:2rem;max-width:400px;width:100%;text-align:center}
.err-card h1{color:var(--accent);font-size:1.2rem;font-weight:800;margin-bottom:.6rem}
.err-card p{color:var(--text2);margin-bottom:1rem;line-height:1.5;font-size:.85rem}
.err-btn{display:inline-flex;align-items:center;justify-content:center;background:var(--accent);color:var(--bg);font-weight:700;padding:.6rem 1.2rem;border-radius:var(--radius);font-size:.82rem;transition:all .15s}
.err-btn:hover{background:var(--accent-hover)}

.coming-soon-wrap{min-height:60vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:2rem;gap:.7rem}
.coming-soon-icon{font-size:3rem}
.coming-soon-title{font-size:1.3rem;font-weight:900;color:var(--text)}
.coming-soon-sub{font-size:.82rem;color:var(--text2);max-width:42ch;line-height:1.55}

#fcBar{position:fixed;top:0;left:0;right:0;z-index:9999;display:flex;align-items:center;gap:.6rem;padding:.4rem .75rem;background:rgba(9,9,11,.92);backdrop-filter:blur(12px) saturate(1.2);-webkit-backdrop-filter:blur(12px) saturate(1.2);border-bottom:1px solid var(--border);font-size:.76rem;min-height:44px;user-select:none;font-family:'Inter',system-ui,sans-serif;color:var(--text)}
.fc-back{background:var(--surface);border:1px solid var(--border);color:var(--text2);padding:.25rem .6rem;border-radius:6px;font-size:.7rem;font-weight:600;white-space:nowrap;transition:all .15s}
.fc-back:hover{border-color:var(--accent);color:var(--accent)}
.fc-spacer{flex:1}
.fc-title{font-size:.7rem;color:var(--text2);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px}
.fc-bal{display:flex;align-items:center;gap:.25rem;background:var(--surface);border:1px solid var(--border);border-radius:7px;padding:.2rem .5rem;font-weight:600;white-space:nowrap;font-size:.76rem}
.fc-bal strong{color:var(--accent);font-size:.86rem;font-variant-numeric:tabular-nums}
.fc-user{font-size:.65rem;color:var(--text3);white-space:nowrap;max-width:110px;overflow:hidden;text-overflow:ellipsis}
.fc-logout{font-size:.64rem;color:var(--text3);white-space:nowrap;transition:color .15s}
.fc-logout:hover{color:var(--accent)}
#gameFrame{position:fixed;top:44px;left:0;right:0;bottom:0;width:100%;height:calc(100% - 44px);border:none;display:block;background:var(--bg)}

@media(max-width:640px){.login-card{padding:1.8rem 1.3rem}.err-card{padding:1.5rem}.nav{padding:.5rem 1rem}.games-grid{grid-template-columns:repeat(auto-fill,minmax(135px,1fr))}}
`;

function shell(head, body) {
  return `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>SirGreen Casino</title>\n<style>${SHARED_CSS}</style>\n${head ?? ""}\n</head>\n<body>\n${body}\n</body>\n</html>`;
}

function lobbyPage(bal, tag, gamesByProvider) {
  let sections = "";
  if (!gamesByProvider || gamesByProvider.length === 0) {
    sections = `<p style="color:var(--text3);font-size:.85rem">No games available right now.</p>`;
  } else {
    for (const { provider, providerName: pn, games } of gamesByProvider) {
      const cards = games.map(g => {
        const gid   = esc(String(g.game_code ?? g.game_id ?? g.id ?? g.code ?? ""));
        const pid   = esc(String(g.provider_id ?? provider ?? ""));
        const thumb = g.game_image
          ? `<img src="${esc(g.game_image)}" alt="${esc(g.game_name ?? g.name)}" loading="lazy">`
          : `<span style="font-size:2.5rem">🎰</span>`;
        return `<div class="game-card" onclick="location.href='/game/${pid}/${gid}'">\n  <div class="game-thumb">${thumb}</div>\n  <div class="game-info"><div class="game-name">${esc(g.game_name ?? g.name ?? gid)}</div><div class="game-meta">${esc(g.game_type ?? g.type ?? pn ?? provider)}</div></div>\n</div>`;
      }).join("\n");
      sections += `<div class="provider-title">🎮 ${esc(pn ?? provider)}</div>\n<div class="games-grid">\n${cards}\n</div>\n`;
    }
  }
  return shell("", `<nav class="nav"><div class="nav-logo"><span class="mark">G</span><span>Sir<b>Green</b></span></div><div class="nav-spacer"></div><div class="nav-bal"><b>${Number(bal).toLocaleString()}</b>&nbsp;FC</div><span class="nav-tag">${esc(tag)}</span><a href="/case-battle" class="nav-link"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 17.5L3 6V3h3l11.5 11.5M13 19l6-6 3 3-6 6-3-3z"/></svg>Battles</a><a href="/logout" class="nav-link">Sign out</a></nav><div class="wrap"><div class="section-title">Game Lobby</div>${sections}</div>`);
}

function comingSoonPage(bal, tag) {
  return shell("", `<nav class="nav"><div class="nav-logo"><span class="mark">G</span><span>Sir<b>Green</b></span></div><div class="nav-spacer"></div><div class="nav-bal"><b>${Number(bal).toLocaleString()}</b>&nbsp;FC</div><span class="nav-tag">${esc(tag)}</span><a href="/logout" class="nav-link">Sign out</a></nav><div class="wrap"><div class="coming-soon-wrap"><div class="coming-soon-icon">🎰</div><div class="coming-soon-title">Games Coming Soon</div><div class="coming-soon-sub">The casino lobby is being set up. Check back shortly — slots, live tables, and more are on the way.</div></div></div>`);
}

function loginPage(authUrl) {
  return shell("", `<div class="login-wrap"><div class="login-card"><div class="login-logo">🎰</div><div class="login-title">Sir<b>Green</b></div><div class="login-sub">Powered by FluxCoins</div><span class="login-desc">Login with your <strong style="color:var(--accent)">Fluxer</strong> account to play with your FluxCoin balance.</span><a class="login-btn" href="${esc(authUrl)}">Login with Fluxer</a><div class="login-footer">Global FluxCoin economy across all Fluxer servers.<br>Play responsibly.</div></div></div>`);
}
function errPage(title, msg, href, label) {
  return shell("", `<div class="err-wrap"><div class="err-card"><h1>${esc(title)}</h1><p>${esc(msg)}</p><a class="err-btn" href="${esc(href ?? "/login")}">${esc(label ?? "Back")}</a></div></div>`);
}

function gameWrapperPage(bal, tag, gameUrl, gameName) {
  const safeBal = Number(bal) || 0;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>${esc(gameName)} — SirGreen</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#09090b;--surface:#111113;--surface2:#18181b;--border:#27272a;--border2:#3f3f46;--accent:#22c55e;--accent-hover:#16a34a;--text:#fafafa;--text2:#a1a1aa;--text3:#71717a}
html,body{height:100%;overflow:hidden;font-family:'Inter',system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased;background:var(--bg);color:var(--text)}
a,button{color:inherit;cursor:pointer;background:none;border:none;font:inherit;text-decoration:none}
#fcBar{position:fixed;top:0;left:0;right:0;z-index:9999;display:flex;align-items:center;gap:.6rem;padding:.4rem .75rem;background:rgba(9,9,11,.92);backdrop-filter:blur(12px) saturate(1.2);-webkit-backdrop-filter:blur(12px) saturate(1.2);border-bottom:1px solid var(--border);font-size:.76rem;min-height:44px;user-select:none}
.fc-back{background:var(--surface);border:1px solid var(--border);color:var(--text2);padding:.25rem .6rem;border-radius:6px;font-size:.7rem;font-weight:600;white-space:nowrap;transition:all .15s}
.fc-back:hover{border-color:var(--accent);color:var(--accent)}
.fc-spacer{flex:1}
.fc-title{font-size:.7rem;color:var(--text2);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px}
.fc-bal{display:flex;align-items:center;gap:.25rem;background:var(--surface);border:1px solid var(--border);border-radius:7px;padding:.2rem .5rem;font-weight:600;white-space:nowrap;font-size:.76rem}
.fc-bal strong{color:var(--accent);font-size:.86rem;font-variant-numeric:tabular-nums}
.fc-user{font-size:.65rem;color:var(--text3);white-space:nowrap;max-width:110px;overflow:hidden;text-overflow:ellipsis}
.fc-logout{font-size:.64rem;color:var(--text3);white-space:nowrap;transition:color .15s}
.fc-logout:hover{color:var(--accent)}
#gameFrame{position:fixed;top:44px;left:0;right:0;bottom:0;width:100%;height:calc(100% - 44px);border:none;display:block;background:var(--bg)}
</style>
</head>
<body>
<div id="fcBar">
  <button class="fc-back" onclick="location.href='/lobby'">← Lobby</button>
  <span class="fc-title">${esc(gameName)}</span>
  <span class="fc-spacer"></span>
  <div class="fc-bal"><strong id="fcBalNum">${safeBal.toLocaleString()}</strong>&nbsp;FC</div>
  <span class="fc-user">${esc(tag)}</span>
  <a href="/logout" class="fc-logout">Sign out</a>
</div>
<iframe id="gameFrame" src="${esc(gameUrl)}" allow="autoplay; fullscreen" allowfullscreen></iframe>
<script>
(function(){
  async function refreshBal() {
    try {
      const r = await fetch('/api/balance');
      if (r.ok) { const d = await r.json(); document.getElementById('fcBalNum').textContent = (d.bal||0).toLocaleString(); }
    } catch(_) {}
  }
  setInterval(refreshBal, 8000);
  document.getElementById('gameFrame').addEventListener('load', refreshBal);
})();
</script>
</body>
</html>`;
}

// ─── WebServer class ──────────────────────────────────────────────────────────

export class WebServer {
  constructor(db, config) {
    this.db           = db;
    this.config       = config;
    this.port         = config.webPort ?? 80;
    this.clientId     = config.fluxerClientId ?? config.discordClientId ?? "";
    this.clientSecret = config.fluxerClientSecret ?? config.discordClientSecret ?? "";
    this.baseUrl      = config.webBaseUrl ?? "https://www.sirgreen.online";
    this.redirectUri  = `${this.baseUrl}/oauth/callback`;
    // Optional: bind sessions to the IP address they were created from.
    // Reduces token-theft window but may log out users behind aggressive NAT/CGNAT.
    this._sessionIpBinding  = Boolean(config.sessionIpBinding);
    this._sessionIpTolerance = Number(config.sessionIpToleranceMs ?? 0); // grace period for flaky IPs
    this._states      = new Map();
    const gsToken     = config.goldSlotApiToken ?? "";
    const gsUrl       = config.goldSlotApiUrl ?? "https://agent.goldslotpalase.com";
    const gsCbUrl     = `${this.baseUrl}/callback`;
    this.goldSlot     = gsToken ? new GoldSlotAPI(gsToken, gsUrl, gsCbUrl) : null;
    this.callbackToken = config.goldSlotCallbackToken ?? "";
    this.gsParent     = config.goldSlotParent ?? "";
    this._gamesCache  = null;
    this._gamesCacheTs = 0;
    this._gameById    = new Map();
    this._processedTrans = new Map();
    this._gsUserCache = new Map();
    this._admin       = new AdminPanel(db, config.prefix ?? "&");

    // ── Case Battle state ─────────────────────────────────────────────────────
    // battleId -> battle state
    this._cbActive  = new Map();
    // uid -> battleId  (prevents joining twice)
    this._cbUserBattle = new Map();
    // uid -> tag (fetched lazily, cached)
    this._cbTagCache = new Map();
    // Prune stale battles every 90 s
    setInterval(() => {
      const cut = Date.now() - 90 * 1000;
      for (const [id, b] of this._cbActive) {
        if (b.phase === "done" && b.resolvedAt < cut) this._cbActive.delete(id);
        else if (b.phase === "pending" && b.createdAt < cut) this._cbActive.delete(id);
      }
    }, 90_000);
  }

  // ─── Case Battle helpers ─────────────────────────────────────────────────

  /** Case tier definitions — built-in tiers. Custom tiers can be added via
   *  the admin panel and are loaded from MongoDB on connect (see loadCustomTiers). */
  static CB_BUILTIN_TIERS = [
    {
      id: "bronze", label: "Bronze", entry: 100,
      color: "#CD7F32", bg: "#1a0e06", builtIn: true,
      items: [
        { s: "🪙", n: "Copper Coin",   v: 15,  w: 35 },
        { s: "🪙", n: "Silver Coin",   v: 30,  w: 25 },
        { s: "🔵", n: "Steel Ball",    v: 50,  w: 20 },
        { s: "🟡", n: "Gold Flake",    v: 75,  w: 12 },
        { s: "💎", n: "Ruby Shard",    v: 120, w: 5  },
        { s: "👑", n: "Bronze Crown",  v: 200, w: 2  },
        { s: "🔮", n: "Mystery Box",   v: 350, w: 1  },
      ],
    },
    {
      id: "iron", label: "Iron", entry: 250,
      color: "#A8A8B0", bg: "#0e0e1a", builtIn: true,
      items: [
        { s: "⚙️", n: "Iron Gear",    v: 40,  w: 32 },
        { s: "🪨", n: "Iron Ore",     v: 80,  w: 25 },
        { s: "🔩", n: "Steel Bolt",   v: 130, w: 18 },
        { s: "🛠️", n: "Tool Kit",     v: 200, w: 12 },
        { s: "⚔️", n: "Iron Sword",   v: 300, w: 8  },
        { s: "🛡️", n: "Iron Shield",  v: 500, w: 3  },
        { s: "👑", n: "Iron Helm",    v: 800, w: 2  },
      ],
    },
    {
      id: "silver", label: "Silver", entry: 500,
      color: "#C0C0C0", bg: "#0e0e1a", builtIn: true,
      items: [
        { s: "🥈", n: "Silver Bar",    v: 75,   w: 30 },
        { s: "🪙", n: "Gold Coin",      v: 150,  w: 25 },
        { s: "🔵", n: "Sapphire",       v: 250,  w: 18 },
        { s: "🟡", n: "Gold Nugget",   v: 400,  w: 12 },
        { s: "💎", n: "Diamond Chip",  v: 700,  w: 8  },
        { s: "👑", n: "Silver Crown",  v: 1200, w: 4  },
        { s: "🏆", n: "Grand Trophy",  v: 2000, w: 2  },
        { s: "🔮", n: "Void Crystal",  v: 3500, w: 1  },
      ],
    },
    {
      id: "platinum", label: "Platinum", entry: 1000,
      color: "#E5E4E2", bg: "#0a0a14", builtIn: true,
      items: [
        { s: "⬜", n: "Platinum Bar",   v: 180,  w: 28 },
        { s: "💠", n: "Platinum Chip",  v: 400,  w: 24 },
        { s: "🟣", n: "Amethyst",       v: 700,  w: 18 },
        { s: "🔵", n: "Platinum Ring",  v: 1100, w: 12 },
        { s: "🟡", n: "Gold Chain",     v: 1800, w: 10 },
        { s: "👑", n: "Platinum Crown", v: 3000, w: 5  },
        { s: "🔮", n: "Ethereal Pearl", v: 5500, w: 2  },
        { s: "✨", n: "Mythic Token",   v: 9000, w: 1  },
      ],
    },
    {
      id: "emerald", label: "Emerald", entry: 1500,
      color: "#50C878", bg: "#02180a", builtIn: true,
      items: [
        { s: "🟢", n: "Emerald Chip",  v: 250,  w: 28 },
        { s: "💚", n: "Heart Emerald", v: 500,  w: 22 },
        { s: "🟩", n: "Emerald Bar",   v: 900,  w: 18 },
        { s: "🟢", n: "Emerald Ring",  v: 1500, w: 12 },
        { s: "🌿", n: "Forest Crown",  v: 2500, w: 10 },
        { s: "🏺", n: "Ancient Vase",  v: 4500, w: 6  },
        { s: "🦚", n: "Phoenix Feather",v:8000, w: 3  },
        { s: "🌳", n: "World Tree Sap",v: 15000,w: 1  },
      ],
    },
    {
      id: "gold", label: "Gold", entry: 2500,
      color: "#FFD700", bg: "#1a1400", builtIn: true,
      items: [
        { s: "🥇", n: "Gold Coin",        v: 400,   w: 28 },
        { s: "💎", n: "Emerald",          v: 800,   w: 22 },
        { s: "🟡", n: "Gold Bar",         v: 1500,  w: 18 },
        { s: "🔵", n: "Sapphire Large",   v: 2500,  w: 12 },
        { s: "👑", n: "Gold Crown",       v: 4000,  w: 10 },
        { s: "🏆", n: "Champion Trophy",  v: 7000,  w: 5  },
        { s: "🔮", n: "Astral Orb",        v: 12000, w: 3  },
        { s: "🌟", n: "Celestial Crown",   v: 22000, w: 2  },
      ],
    },
    {
      id: "ruby", label: "Ruby", entry: 5000,
      color: "#E0115F", bg: "#1a0010", builtIn: true,
      items: [
        { s: "❤️", n: "Ruby Heart",      v: 700,   w: 26 },
        { s: "🔴", n: "Ruby Bar",        v: 1500,  w: 22 },
        { s: "💖", n: "Love Gem",        v: 2800,  w: 18 },
        { s: "🌹", n: "Eternal Rose",    v: 4500,  w: 12 },
        { s: "👑", n: "Ruby Crown",      v: 7500,  w: 10 },
        { s: "💝", n: "Royal Heart",     v: 13000, w: 6  },
        { s: "🌺", n: "Crimson Bloom",   v: 22000, w: 4  },
        { s: "❤️‍🔥", n: "Heart of Fire", v: 40000, w: 2  },
      ],
    },
    {
      id: "diamond", label: "Diamond", entry: 10000,
      color: "#00D4FF", bg: "#00081a", builtIn: true,
      items: [
        { s: "💎", n: "Diamond",         v: 2000,  w: 28 },
        { s: "🌟", n: "Star Shard",        v: 5000,  w: 22 },
        { s: "👑", n: "Royal Crown",      v: 10000, w: 18 },
        { s: "🏆", n: "Legend Trophy",   v: 18000, w: 12 },
        { s: "🔮", n: "Void Gem",         v: 30000, w: 8  },
        { s: "⚡", n: "Thunder Orb",      v: 50000, w: 5  },
        { s: "🌌", n: "Galaxy Core",      v: 90000, w: 4  },
        { s: "💠", n: "Infinity Crown",   v: 180000,w: 3  },
      ],
    },
    {
      id: "obsidian", label: "Obsidian", entry: 25000,
      color: "#1B1B3A", bg: "#000005", builtIn: true,
      items: [
        { s: "🖤", n: "Obsidian Shard",   v: 4000,  w: 26 },
        { s: "🟣", n: "Void Pearl",       v: 9000,  w: 22 },
        { s: "⚫", n: "Dark Matter",      v: 18000, w: 18 },
        { s: "🌑", n: "Eclipse Stone",    v: 30000, w: 12 },
        { s: "👁️", n: "All-Seeing Eye",  v: 50000, w: 10 },
        { s: "🦇", n: "Shadow Wings",     v: 85000, w: 6  },
        { s: "🌚", n: "Black Hole",       v: 150000,w: 4  },
        { s: "👹", n: "Demon Heart",      v: 280000,w: 2  },
      ],
    },
    {
      id: "mythic", label: "Mythic", entry: 100000,
      color: "#FF6B9D", bg: "#1a0010", builtIn: true,
      items: [
        { s: "🌸", n: "Sakura Bloom",     v: 20000, w: 24 },
        { s: "🎴", n: "Legend Card",      v: 45000, w: 22 },
        { s: "🏯", n: "Castle Tower",     v: 80000, w: 18 },
        { s: "🐉", n: "Dragon Scale",     v: 130000,w: 14 },
        { s: "🦄", n: "Unicorn Horn",     v: 220000,w: 10 },
        { s: "👑", n: "Divine Crown",     v: 380000,w: 6  },
        { s: "🌌", n: "Universe Shard",   v: 600000,w: 4  },
        { s: "✨", n: "God Slayer",       v: 1000000,w: 2  },
      ],
    },
  ];

  // Custom tiers loaded from DB (see loadCustomTiers).
  _cbCustomTiers = [];

  async loadCustomTiers() {
    if (!this.db || !this.db._users) return;
    try {
      // Custom tiers stored as a singleton document in a dedicated collection
      this._cbCustomTiers = (await this.db.getCustomTiers?.()) || [];
    } catch (e) { /* collection may not exist yet */ }
  }

  /** Combined tier list (built-in + custom) */
  _cbAllTiers() {
    return [...WebServer.CB_BUILTIN_TIERS, ...this._cbCustomTiers];
  }

  _cbTierById(id) {
    return this._cbAllTiers().find(t => t.id === id) ?? null;
  }

  _cbPickItem(tier) {
    const total = tier.items.reduce((s, i) => s + i.w, 0);
    let r = Math.random() * total;
    for (const item of tier.items) { r -= item.w; if (r <= 0) return item; }
    return tier.items[tier.items.length - 1];
  }

  _cbOpenCases(cases) {
    // cases: [{tier, cost}]
    return cases.map(c => {
      const tier = this._cbTierById(c.tier);
      if (!tier) return { tier: c.tier, cost: c.cost, reward: null, value: 0 };
      const item = this._cbPickItem(tier);
      return { tier: c.tier, cost: c.cost, reward: item, value: item.v };
    });
  }

  _cbResolve(battle) {
    if (battle.phase === "done") return;
    const { mode, cases } = battle;
    const players = battle.players;

    // Each player opens all cases
    players.forEach(p => {
      const opened = this._cbOpenCases(cases);
      p.rewards = opened.map(o => o.reward);
      p.totalValue = opened.reduce((s, o) => s + (o.value || 0), 0);
      p.cost = cases.reduce((s, c) => s + (c.cost || 0), 0);
    });

    // Determine winner(s) and credit balances.
    if (mode === "shared") {
      battle.winnerUid = "shared";
      const rake = battle.jackpot ? 0 : Math.floor(battle.pot * 0.05);
      const share = Math.floor((battle.pot - rake) / players.length);
      players.forEach(p => {
        p.netWin = share - p.cost;
        this.db.updateBalance(p.uid, share).catch(() => {});
        this.db.recordGame(p.uid, p.netWin > 0, p.cost).catch(() => {});
      });
    } else {
      const maxValue = Math.max(...players.map(p => p.totalValue));
      const winners = players.filter(p => p.totalValue === maxValue);
      const rake = battle.jackpot ? 0 : Math.floor(battle.pot * 0.05);

      if (winners.length === 1) {
        battle.winnerUid = winners[0].uid;
        const winnerPayout = battle.pot - rake;
        players.forEach(p => {
          if (p === winners[0]) {
            p.netWin = winnerPayout - p.cost;
            this.db.updateBalance(p.uid, winnerPayout).catch(() => {});
          } else {
            p.netWin = -p.cost;
          }
          this.db.recordGame(p.uid, p.netWin > 0, p.cost).catch(() => {});
        });
      } else {
        battle.winnerUid = "tie";
        const share = Math.floor((battle.pot - rake) / winners.length);
        players.forEach(p => {
          if (winners.includes(p)) {
            p.netWin = share - p.cost;
            this.db.updateBalance(p.uid, share).catch(() => {});
          } else {
            p.netWin = -p.cost;
          }
          this.db.recordGame(p.uid, p.netWin > 0, p.cost).catch(() => {});
        });
      }
    }

    battle.phase = "done";
    battle.resolvedAt = Date.now();
    // Auto-cleanup: remove from active battles after 90s
    setTimeout(() => {
      const b = this._cbActive.get(battle.id);
      if (b && b.phase === "done" && Date.now() - b.resolvedAt > 80000) {
        this._cbActive.delete(battle.id);
        for (const p of b.players) {
          if (this._cbUserBattle.get(p.uid) === battle.id) this._cbUserBattle.delete(p.uid);
        }
      }
    }, 90_000);
  }

  _cbStartBattle(battle) {
    const isFast = battle.speed === "fast";
    const countdownMs = isFast ? 1500 : 3000;
    const caseCount = battle.cases.length;
    // Each case: spin (fixed) then a stagger gap before the next starts.
    // Fixed spin so the reel always has a satisfying scroll regardless of case count.
    const spinMs = isFast ? 900 : 1600;
    const staggerMs = isFast ? 350 : 550;

    battle.phase = "countdown";
    battle.startsAt = Date.now() + countdownMs;
    battle.caseStaggerMs = staggerMs;
    battle.caseSpinMs = spinMs;

    // countdown → opening phase → resolve after full animation
    const resolveAfter = countdownMs + 50 + staggerMs * caseCount + spinMs + 500;
    setTimeout(() => {
      const b = this._cbActive.get(battle.id);
      if (!b) return;
      b.phase = "opening";
      b.openedAt = Date.now();
      b.caseStaggerMs = staggerMs;
      b.caseSpinMs = spinMs;
      // Resolve rewards — _cbResolve sets phase to "done", then we override back to "opening"
      // so the frontend sees rewards available during the opening animation.
      this._cbResolve(b);
      b.phase = "opening";
      b._resolvedButAnimating = true;
      const animRemaining = staggerMs * caseCount + spinMs + 500;
      setTimeout(() => {
        const b2 = this._cbActive.get(battle.id);
        if (b2 && b2._resolvedButAnimating) {
          b2.phase = "done";
          b2.resolvedAt = Date.now();
        }
      }, animRemaining);
    }, countdownMs + 50);
  }

  // ─── GoldSlot helpers (unchanged) ─────────────────────────────────────────

  async _ensureGsUser(localUid) {
    if (!this.goldSlot) return null;
    if (this._gsUserCache.has(localUid)) return this._gsUserCache.get(localUid);
    const name = `gs_${localUid}`;
    try {
      const resp = await this.goldSlot.userCreate(name, this.gsParent || undefined);
      if (resp.code !== 0) { console.error("[GoldSlot] userCreate failed:", resp); return null; }
      const userCode = resp.data?.user_code ?? null;
      if (!userCode) { console.error("[GoldSlot] userCreate returned no user_code:", resp); return null; }
      const entry = { name, userCode };
      this._gsUserCache.set(localUid, entry);
      return entry;
    } catch(e) { console.error("[GoldSlot] _ensureGsUser:", e); return null; }
  }

  async _fetchGames() {
    if (!this.goldSlot) return [];
    const now = Date.now();
    if (this._gamesCache && now - this._gamesCacheTs < 10 * 60 * 1000) return this._gamesCache;
    let grouped = [];
    try {
      const resp = await this.goldSlot.getAllGames(1);
      if (resp.code === 0 && Array.isArray(resp.data) && resp.data.length > 0) {
        const first = resp.data[0];
        if (Array.isArray(first?.games)) {
          for (const prov of resp.data) {
            const games = Array.isArray(prov.games) ? prov.games : [];
            const pc    = String(prov.provider ?? prov.code ?? prov.id ?? "UNKNOWN");
            const pn    = String(prov.name ?? providerName(pc) ?? pc);
            for (const g of games) this._gameById.set(String(g.game_code ?? g.game_id ?? g.id ?? g.code ?? ""), { ...g, providerCode: pc, providerName: pn });
            if (games.length) grouped.push({ provider: pc, providerName: pn, games });
          }
        } else {
          const byProv = new Map();
          for (const g of resp.data) {
            const pid = g.provider_id ?? g.provider ?? g.provider_code ?? "UNKNOWN";
            const pc  = String(pid);
            const pn  = g.provider_name ?? providerName(pid);
            if (!byProv.has(pc)) byProv.set(pc, { provider: pc, providerName: pn, games: [] });
            byProv.get(pc).games.push(g);
            this._gameById.set(String(g.game_code ?? g.game_id ?? g.id ?? g.code ?? ""), { ...g, providerCode: pc, providerName: pn });
          }
          grouped = [...byProv.values()];
        }
      }
    } catch(e) { console.error("[GoldSlot] /v4/game/all exception:", e.message); }
    if (grouped.length > 0) { this._gamesCache = grouped; this._gamesCacheTs = now; }
    return grouped;
  }

  _markTrans(guid, entry) {
    if (!guid) return;
    this._processedTrans.set(guid, entry);
    if (this._processedTrans.size > 50000) {
      const iter = this._processedTrans.keys();
      for (let i = 0; i < 5000; i++) this._processedTrans.delete(iter.next().value);
    }
  }

  _isValidCallbackToken(req) {
    if (!this.callbackToken) return true;
    const incoming = (req.headers["callback-token"] ?? req.headers["Callback-Token"] ?? "").trim();
    return incoming === this.callbackToken;
  }

  _cbReply(res, result, status, data) {
    const body = { result, status };
    if (data !== undefined) body.data = data;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  async _handleCallback(req, res) {
    if (!this._isValidCallbackToken(req)) { console.warn("[Callback] Rejected — bad token"); return this._cbReply(res, 1, "INVALID_TOKEN"); }
    let payload;
    try { payload = JSON.parse(await readBody(req)); } catch { return this._cbReply(res, 1, "INVALID_JSON"); }
    const { command, data, check } = payload;
    if (!command || !data) return this._cbReply(res, 1, "MISSING_FIELDS");
    const gsAccount       = String(data.account ?? "");
    const localUid        = gsAccount.startsWith("gs_") ? gsAccount.slice(3) : gsAccount;
    const transGuid       = String(data.trans_guid ?? "");
    const cancelTransGuid = String(data.cancel_trans_guid ?? data.cancle_trans_guid ?? "");
    const amount          = Number(data.amount ?? 0);
    const checks          = String(check ?? "").split(",").map(s => s.trim());
    let user;
    try { user = await this.db.getUser(localUid); } catch(e) { console.error("[Callback] DB:", e); return this._cbReply(res, 1001, "INTERNAL_ERROR"); }
    if (checks.includes("21") && !user) return this._cbReply(res, 1, "USER_NOT_FOUND");
    if (checks.includes("22") && user?.banned) return this._cbReply(res, 1, "USER_INACTIVE");
    const currentBal = Math.round(Number(user?.bal ?? 0));
    if (command === "authenticate") { if (!user) return this._cbReply(res, 1, "USER_NOT_FOUND"); return this._cbReply(res, 0, "OK", { account: gsAccount, balance: currentBal }); }
    if (command === "balance") { if (!user) return this._cbReply(res, 1, "USER_NOT_FOUND"); return this._cbReply(res, 0, "OK", { balance: currentBal }); }
    if (command === "bet") {
      if (checks.includes("41") && transGuid && this._processedTrans.has(transGuid)) return this._cbReply(res, 0, "OK", { balance: currentBal });
      if (!user) return this._cbReply(res, 1, "USER_NOT_FOUND");
      const betAmt = Math.round(amount);
      if (betAmt > 0 && currentBal < betAmt) return this._cbReply(res, 1, "BALANCE_NOT_ENOUGH");
      let newBal = currentBal;
      if (betAmt > 0) {
        try { await this.db.updateBalance(localUid, -betAmt); const r = await this.db.getUser(localUid); newBal = Math.round(Number(r?.bal ?? currentBal - betAmt)); }
        catch(e) { console.error("[Callback] DB bet:", e); return this._cbReply(res, 1001, "INTERNAL_ERROR"); }
      }
      this._markTrans(transGuid, { type: "bet", localUid, amount: betAmt });
      return this._cbReply(res, 0, "OK", { balance: newBal });
    }
    if (command === "win") {
      if (checks.includes("41") && transGuid && this._processedTrans.has(transGuid)) { const ex = this._processedTrans.get(transGuid); if (ex?.type === "win") return this._cbReply(res, 0, "OK", { balance: currentBal }); }
      if (!user) return this._cbReply(res, 1, "USER_NOT_FOUND");
      const winAmt = Math.round(amount);
      let newBal = currentBal;
      if (winAmt > 0) {
        try { await this.db.updateBalance(localUid, winAmt); const r = await this.db.getUser(localUid); newBal = Math.round(Number(r?.bal ?? currentBal + winAmt)); await this.db.recordGame(localUid, true, winAmt).catch(() => {}); }
        catch(e) { console.error("[Callback] DB win:", e); return this._cbReply(res, 1001, "INTERNAL_ERROR"); }
      } else { await this.db.recordGame(localUid, false, 0).catch(() => {}); }
      this._markTrans(transGuid, { type: "win", localUid, amount: winAmt });
      return this._cbReply(res, 0, "OK", { balance: newBal });
    }
    if (command === "cancel") {
      if (checks.includes("43") && cancelTransGuid && this._processedTrans.has(cancelTransGuid)) return this._cbReply(res, 0, "OK", { balance: currentBal });
      if (!user) return this._cbReply(res, 1, "USER_NOT_FOUND");
      const originalBet = Math.round(this._processedTrans.get(transGuid)?.amount ?? amount);
      let newBal = currentBal;
      if (originalBet > 0) {
        try { await this.db.updateBalance(localUid, originalBet); const r = await this.db.getUser(localUid); newBal = Math.round(Number(r?.bal ?? currentBal + originalBet)); }
        catch(e) { console.error("[Callback] DB cancel:", e); return this._cbReply(res, 1001, "INTERNAL_ERROR"); }
      }
      this._markTrans(cancelTransGuid, { type: "cancel", localUid, amount: originalBet });
      if (transGuid) this._processedTrans.delete(transGuid);
      return this._cbReply(res, 0, "OK", { balance: newBal });
    }
    if (command === "status") {
      const entry = this._processedTrans.get(transGuid);
      if (checks.includes("42") && !entry) return this._cbReply(res, 1, "TRANSACTION_NOT_FOUND");
      return this._cbReply(res, 0, "OK", { account: gsAccount, trans_guid: transGuid, trans_status: entry ? "OK" : "NOT_FOUND" });
    }
    return this._cbReply(res, 1, "UNKNOWN_COMMAND");
  }

  // ─── Admin route helpers ──────────────────────────────────────────────────

  _buildAdminLoginUrl() {
    const state  = crypto.randomBytes(16).toString("hex");
    const expiry = Date.now() + 10 * 60 * 1000; // CSRF state valid for 10 min
    this._states.set(state, { createdAt: Date.now(), expiry });
    return `${FLUXER_AUTH_URL}?client_id=${encodeURIComponent(this.clientId)}&scope=identify+guilds&redirect_uri=${encodeURIComponent(this.redirectUri)}&response_type=code&state=${encodeURIComponent(state)}`;
  }

  async _handleAdminPanel(req, res) {
    const uid = this._uid(req);
    // Not logged in at all — show login page
    if (!uid) {
      const loginUrl = this._buildAdminLoginUrl();
      return this._html(res, 200, this._admin.loginRequired(loginUrl));
    }
    // Logged in but not the admin
    if (!this._admin.isAdmin(uid)) {
      console.warn(`[Admin] Unauthorised access attempt from uid=${uid}`);
      return this._html(res, 403, this._admin.accessDenied(uid));
    }
    // Authorised — render dashboard
    try {
      const html = await this._admin.render();
      // No-cache so every reload is fresh
      res.writeHead(200, { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store, no-cache" });
      res.end(html);
    } catch(e) {
      console.error("[Admin] render error:", e);
      this._html(res, 500, errPage("⚠️ Admin Error", e.message ?? "Internal error", "/admin/panel", "Retry"));
    }
  }

  // ─── Server lifecycle ─────────────────────────────────────────────────────

  async start() {
    _preloadAssets();
    // Load custom case tiers from DB
    await this.loadCustomTiers().catch(e => console.error("[CB] Custom tiers load:", e));
    if (GOLDSLOT_ENABLED) {
      this._fetchGames().catch(e => console.error("[GoldSlot] Pre-warm:", e));
    } else {
      console.log("[GoldSlot] Disabled — game lobby will show coming soon page.");
    }
    this._server = http.createServer((req, res) =>
      this._handle(req, res).catch(e => {
        console.error("[Web]", e);
        if (!res.headersSent) { res.writeHead(500); res.end("Internal error"); }
      })
    );
    this._server.listen(this.port, "0.0.0.0", () => console.log(`[Web] SirGreen Casino on port ${this.port}`));
    setInterval(() => {
      const now = Date.now();
      for (const [s, entry] of this._states) {
        const cutoff = entry.expiry ?? (Number(entry) + 15 * 60 * 1000);
        if (now > cutoff) this._states.delete(s);
      }
    }, 5 * 60 * 1000);
  }

  // ─── Main request handler ─────────────────────────────────────────────────

  async _handle(req, res) {
    const u = new URL(req.url, "http://localhost");
    const p = normalizeAssetUrlPath(u.pathname);

    if (p === "/") return this._redirect(res, "/lobby");

    if (p === "/favicon.ico") {
      if (fs.existsSync(FAVICON_PATH)) return serveFileWithRanges(req, res, FAVICON_PATH, "image/x-icon");
      res.writeHead(204); return res.end();
    }

    // ── Admin API (strict: only ADMIN_USER_ID) ───────────────────────────────
    if (p.startsWith("/api/admin/")) {
      const uid = this._uid(req);
      if (!uid || !this._admin.isAdmin(uid)) {
        res.writeHead(403, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        return res.end(JSON.stringify({ error: "Forbidden" }));
      }
      const body = req.method === "POST" || req.method === "PUT" || req.method === "PATCH" || req.method === "DELETE"
        ? await readBody(req).catch(() => "{}") : "{}";
      let data;
      try { data = JSON.parse(body); } catch { data = {}; }

      // GET /api/admin/users?search=xxx — search users by ID or tag
      if (p === "/api/admin/users" && req.method === "GET") {
        const u = new URL(req.url, "http://localhost");
        const search = u.searchParams.get("search") || "";
        const limit = Math.max(1, Math.min(100, Number(u.searchParams.get("limit")) || 20));
        let users;
        if (search) {
          // Search by ID prefix or balance
          const numSearch = Number(search);
          if (!isNaN(numSearch) && numSearch > 0) {
            users = await this.db._users.find({ bal: { $gte: numSearch } }).sort({ bal: -1 }).limit(limit).toArray();
          } else {
            // Fuzzy match on _id prefix
            users = await this.db._users.find({ _id: { $regex: search, $options: "i" } }).limit(limit).toArray();
          }
        } else {
          users = await this.db._users.find({}).sort({ bal: -1 }).limit(limit).toArray();
        }
        return this._json(res, 200, { users: users.map(u => ({ _id: u._id, bal: u.bal ?? 0, tw: u.tw ?? 0, tl: u.tl ?? 0, gp: u.gp ?? 0 })) });
      }

      // POST /api/admin/users/:id/balance — set or adjust a user's balance
      const balMatch = p.match(/^\/api\/admin\/users\/(\d+)\/balance$/);
      if (balMatch && (req.method === "POST" || req.method === "PATCH")) {
        const targetUid = balMatch[1];
        const { delta, set } = data;
        if (typeof set === "number") {
          // Absolute set — read current, compute delta
          const user = await this.db.getUser(targetUid);
          const current = Number(user?.bal ?? 0);
          const diff = set - current;
          await this.db.updateBalance(targetUid, diff);
          const updated = await this.db.getUser(targetUid);
          return this._json(res, 200, { bal: Number(updated?.bal ?? 0) });
        } else if (typeof delta === "number") {
          await this.db.updateBalance(targetUid, delta);
          const updated = await this.db.getUser(targetUid);
          return this._json(res, 200, { bal: Number(updated?.bal ?? 0) });
        }
        return this._json(res, 400, { error: "Provide delta or set" });
      }

      // GET /api/admin/cases — list all tiers (built-in + custom)
      if (p === "/api/admin/cases" && req.method === "GET") {
        return this._json(res, 200, { tiers: this._cbAllTiers() });
      }

      // POST /api/admin/cases — add a custom tier
      if (p === "/api/admin/cases" && req.method === "POST") {
        const { id, label, entry, color, bg, items } = data;
        if (!id || !label || !entry || !Array.isArray(items) || items.length === 0)
          return this._json(res, 400, { error: "id, label, entry, items[] required" });
        if (this._cbTierById(id))
          return this._json(res, 400, { error: "Tier ID already exists" });
        const tier = {
          id: String(id), label: String(label), entry: Number(entry),
          color: String(color || "#2ecc71"), bg: String(bg || "#0a1f0a"),
          builtIn: false,
          items: items.map(i => ({ s: String(i.s), n: String(i.n), v: Number(i.v), w: Number(i.w) })),
        };
        this._cbCustomTiers.push(tier);
        await this.db.saveCustomTiers(this._cbCustomTiers).catch(() => {});
        return this._json(res, 200, { tier });
      }

      // DELETE /api/admin/cases/:id — remove a custom tier
      const delCaseMatch = p.match(/^\/api\/admin\/cases\/(.+)$/);
      if (delCaseMatch && req.method === "DELETE") {
        const delId = delCaseMatch[1];
        const idx = this._cbCustomTiers.findIndex(t => t.id === delId);
        if (idx < 0) return this._json(res, 404, { error: "Not found or built-in" });
        this._cbCustomTiers.splice(idx, 1);
        await this.db.saveCustomTiers(this._cbCustomTiers).catch(() => {});
        return this._json(res, 200, { ok: true });
      }

      // GET /api/admin/battles — list active battles
      if (p === "/api/admin/battles" && req.method === "GET") {
        const battles = [...this._cbActive.values()].map(b => ({
          id: b.id, mode: b.mode, phase: b.phase, cost: b.cost, pot: b.pot,
          maxPlayers: b.maxPlayers, speed: b.speed, jackpot: b.jackpot, crazy: b.crazy,
          players: b.players.map(p => ({ uid: p.uid, tag: p.tag })),
          createdAt: b.createdAt, winnerUid: b.winnerUid,
        }));
        return this._json(res, 200, { battles });
      }

      // DELETE /api/admin/battles/:id — force-cancel a battle (refund all)
      const delBattleMatch = p.match(/^\/api\/admin\/battles\/([a-f0-9]+)$/);
      if (delBattleMatch && req.method === "DELETE") {
        const bId = delBattleMatch[1];
        const b = this._cbActive.get(bId);
        if (!b) return this._json(res, 404, { error: "Battle not found" });
        // Refund all players
        for (const p of b.players) {
          await this.db.updateBalance(p.uid, p.cost).catch(() => {});
          this._cbUserBattle.delete(p.uid);
        }
        this._cbActive.delete(bId);
        return this._json(res, 200, { ok: true });
      }

      return this._json(res, 404, { error: "Not found" });
    }

    // ── Admin panel ───────────────────────────────────────────────────────────
    if (p === "/admin/panel" || p === "/admin/panel/") {
      return this._handleAdminPanel(req, res);
    }
    // Block all other /admin/* sub-paths to avoid accidental exposure
    if (p.startsWith("/admin/")) {
      res.writeHead(404, { "Cache-Control": "no-store" }); return res.end("Not found");
    }

    if (p === "/callback") {
      if (req.method === "GET") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: true, service: "SirGreen Casino callback" })); }
      if (req.method === "POST") return this._handleCallback(req, res);
      res.writeHead(405, { Allow: "GET, POST" }); return res.end("Method Not Allowed");
    }

    if (p === "/api/goldslot/debug" && req.method === "GET") {
      if (!GOLDSLOT_ENABLED) return this._json(res, 503, { error: "GoldSlot is disabled" });
      if (!this.goldSlot) return this._json(res, 503, { error: "goldSlotApiToken not configured" });
      const out = {};
      try { out.agentInfo = await this.goldSlot.agentInfo(); } catch(e) { out.agentInfo = { error: e.message }; }
      return this._json(res, 200, out);
    }

    if (p.startsWith("/assets/")) {
      const cached = _assetCache.get(p);
      if (cached) return serveBufferWithRanges(req, res, cached.buf, cached.mime);
      const disk = assetUrlToDiskPath(p);
      if (disk && fs.existsSync(disk)) return serveFileWithRanges(req, res, disk, getMime(disk));
      res.writeHead(404, { "Cache-Control": "no-store" }); return res.end("Not found");
    }

    if (p === "/lobby" && req.method === "GET") {
      const uid = this._uid(req);
      if (!uid) return this._redirect(res, "/login");
      const user    = await this.db.getUser(uid);
      const cookies = parseCookies(req);
      const bal     = Number(user?.bal ?? 0);
      const tag     = decodeURIComponent(cookies.dtag ?? "Player");
      if (!GOLDSLOT_ENABLED) {
        const lobbyPath = path.join(GAMES_HTML_DIR, "lobby.html");
        if (fs.existsSync(lobbyPath)) {
          const lobbyHtml = fs.readFileSync(lobbyPath, "utf8")
            .replace("__BALANCE__", String(bal))
            .replace("__TAG__", esc(tag));
          return this._html(res, 200, lobbyHtml);
        }
        return this._html(res, 200, comingSoonPage(bal, tag));
      }
      const gamesByProvider = await this._fetchGames();
      return this._html(res, 200, lobbyPage(bal, tag, gamesByProvider));
    }

    if (p.startsWith("/game/") && req.method === "GET") {
      const uid = this._uid(req);
      if (!uid) return this._redirect(res, "/login");
      if (!GOLDSLOT_ENABLED) return this._redirect(res, "/lobby");
      const cookies  = parseCookies(req);
      const tag      = decodeURIComponent(cookies.dtag ?? "Player");
      // Validate that the path components are non-empty alphanum strings.
      // gameCode may legitimately contain hyphens/underscores, so we allow those.
      const rawParts = p.slice("/game/".length).split("/");
      const rawPid   = decodeURIComponent(rawParts[0] ?? "");
      const rawGame  = decodeURIComponent(rawParts.slice(1).join("/") ?? rawParts[0] ?? "");
      if (!/^\d{1,6}$/.test(rawPid)) return this._redirect(res, "/lobby");
      if (!rawGame || !/^[a-zA-Z0-9_-]{1,64}$/.test(rawGame)) return this._redirect(res, "/lobby");
      const providerId = Number(rawPid);
      const gameCode   = rawGame;
      if (!this.goldSlot) return this._html(res, 503, errPage("⚠️ Not Configured", "goldSlotApiToken is not set.", "/lobby", "Back"));
      await this._fetchGames();
      const gameMeta    = this._gameById.get(gameCode);
      const resolvedPid = (!isNaN(providerId) && providerId > 0) ? providerId : Number(gameMeta?.provider_id ?? gameMeta?.providerCode ?? NaN);
      if (isNaN(resolvedPid) || resolvedPid <= 0) return this._html(res, 400, errPage("⚠️ Error", `Unknown provider for game "${esc(gameCode)}".`, "/lobby", "Back to Lobby"));
      const gs = await this._ensureGsUser(uid);
      if (!gs) return this._html(res, 500, errPage("⚠️ Error", "Could not create your casino account.", "/lobby", "Back"));
      let gameUrl;
      try {
        const urlResp = await this.goldSlot.getGameUrl(gs.userCode, gameCode, resolvedPid, `${this.baseUrl}/lobby`, 1);
        const launchUrl = urlResp.data?.game_url ?? urlResp.data?.url ?? null;
        if (urlResp.code !== 0 || !launchUrl) return this._html(res, 500, errPage("⚠️ Error", `Could not launch game (code ${urlResp.code}).`, "/lobby", "Back to Lobby"));
        gameUrl = launchUrl;
      } catch(e) { console.error("[GoldSlot] getGameUrl:", e); return this._html(res, 500, errPage("⚠️ Error", "Game launch failed.", "/lobby", "Back")); }
      const gameName = gameMeta?.game_name ?? gameMeta?.name ?? gameCode;
      const user     = await this.db.getUser(uid);
      const bal      = Number(user?.bal ?? 0);
      return this._html(res, 200, gameWrapperPage(bal, tag, gameUrl, gameName));
    }

    // ── Case Battle page ─────────────────────────────────────────────────────
    if ((p === "/case-battle" || p.startsWith("/case-battle/")) && req.method === "GET") {
      const uid = this._uid(req);
      if (!uid) return this._redirect(res, "/login");
      const cookies = parseCookies(req);
      const tag     = decodeURIComponent(cookies.dtag ?? "Player");
      const user    = await this.db.getUser(uid);
      const bal     = Number(user?.bal ?? 0);
      const battleId = p.startsWith("/case-battle/") ? p.slice("/case-battle/".length) : null;
      const cbPath = path.join(GAMES_HTML_DIR, "case-battle.html");
      if (!fs.existsSync(cbPath)) return this._html(res, 503, errPage("Not Ready", "Case Battle is not available yet.", "/lobby", "Back"));
      const html = fs.readFileSync(cbPath, "utf8")
        .replace("__BALANCE__", String(bal))
        .replace("__TAG__", esc(tag))
        .replace("__UID__", uid)
        .replace("__BATTLE_ID__", battleId ?? "");
      return this._html(res, 200, html);
    }

    if (p === "/api/balance" && req.method === "GET") {
      const uid = this._uid(req);
      if (!uid) return this._json(res, 401, { error: "Not logged in" });
      const user = await this.db.getUser(uid);
      return this._json(res, 200, { bal: Number(user?.bal ?? 0) });
    }

    // ── Case Battle API ──────────────────────────────────────────────────────

    // GET /api/case-battle/tiers — all case tier definitions
    if (p === "/api/case-battle/tiers" && req.method === "GET") {
      const tiers = this._cbAllTiers().map(t => ({
        id: t.id, label: t.label, entry: t.entry,
        color: t.color, bg: t.bg, builtIn: !!t.builtIn,
        rtp: Math.round(t.items.reduce((s, i) => s + i.v * i.w, 0) /
                        t.items.reduce((s, i) => s + i.w, 0) / t.entry * 100),
        items: t.items.map(i => ({ s: i.s, n: i.n, v: i.v })),
      }));
      return this._json(res, 200, { tiers });
    }

    // GET /api/case-battle/list — open and in-progress battles
    if (p === "/api/case-battle/list" && req.method === "GET") {
      const uid = this._uid(req);
      const battles = [...this._cbActive.values()]
        .filter(b => b.phase !== "done")
        .map(b => {
          const players = b.players.map(p => ({
            uid: p.uid,
            tag: p.tag || p.uid,
            isCreator: p.uid === b.creatorUid,
          }));
          return {
            id: b.id,
            mode: b.mode,
            cases: b.cases,
            cost: b.cost,
            pot: b.pot,
            maxPlayers: b.maxPlayers,
            speed: b.speed || "normal",
            jackpot: !!b.jackpot,
            crazy: !!b.crazy,
            players,
            creatorUid: b.creatorUid,
            phase: b.phase,
            createdAt: b.createdAt,
            watcherCount: b.watchers ? b.watchers.size : 0,
          };
        })
        .sort((a, b) => a.createdAt - b.createdAt);
      return this._json(res, 200, { battles });
    }

    // POST /api/case-battle/create — create a new battle
    if (p === "/api/case-battle/create" && req.method === "POST") {
      const uid = this._uid(req);
      if (!uid) return this._json(res, 401, { error: "Not logged in" });
      const cookies = parseCookies(req);
      const tag = decodeURIComponent(cookies.dtag || uid);
      let data;
      try { data = JSON.parse(await readBody(req)); } catch { return this._json(res, 400, { error: "Invalid JSON" }); }
      const { cases, mode, maxPlayers, speed, jackpot, crazy } = data;

      if (!Array.isArray(cases) || cases.length === 0)
        return this._json(res, 400, { error: "At least one case is required" });
      if (!["regular", "shared"].includes(mode))
        return this._json(res, 400, { error: "Invalid mode" });
      const mp = Math.max(2, Math.min(8, Number(maxPlayers) || 2));
      // speed: "normal" | "fast" (faster reveal)
      const sp = speed === "fast" ? "fast" : "normal";
      // Jackpot mode: +50% to pot for winner (admin feature)
      const jp = !!jackpot;
      // Crazy mode: random multi-item reveal (admin feature)
      const cr = !!crazy;

      // Validate cases and compute entry cost
      const validatedCases = [];
      let entryCost = 0;
      for (const c of cases) {
        const tier = this._cbTierById(c.tier);
        if (!tier) return this._json(res, 400, { error: `Invalid tier: ${c.tier}` });
        const qty = Math.max(1, Math.min(20, Number(c.qty) || 1));
        for (let i = 0; i < qty; i++) {
          validatedCases.push({ tier: tier.id, cost: tier.entry });
          entryCost += tier.entry;
        }
      }

      // Deduct entry cost atomically
      const deducted = await this.db.atomicDeduct(uid, -entryCost);
      if (!deducted) return this._json(res, 200, { error: "Insufficient balance" });

      const battleId = crypto.randomBytes(8).toString("hex");
      const battle = {
        id: battleId,
        creatorUid: uid,
        mode,
        maxPlayers: mp,
        cases: validatedCases,
        cost: entryCost,
        pot: entryCost * mp,
        speed: sp,
        jackpot: jp,
        crazy: cr,
        phase: "pending",
        players: [{ uid, tag, cost: entryCost, rewards: [], totalValue: 0, netWin: 0 }],
        createdAt: Date.now(),
        resolvedAt: 0,
        winnerUid: null,
        watchers: new Set(),
      };
      this._cbActive.set(battleId, battle);
      this._cbUserBattle.set(uid, battleId);
      return this._json(res, 200, { battleId });
    }

    // POST /api/case-battle/:id/join — join an existing battle
    if (p.startsWith("/api/case-battle/") && p.endsWith("/join") && req.method === "POST") {
      const uid = this._uid(req);
      if (!uid) return this._json(res, 401, { error: "Not logged in" });
      const cookies = parseCookies(req);
      const tag = decodeURIComponent(cookies.dtag || uid);
      const battleId = p.slice("/api/case-battle/".length, -"/join".length);
      const battle = this._cbActive.get(battleId);
      if (!battle) return this._json(res, 200, { error: "Battle not found" });
      if (battle.phase !== "pending")
        return this._json(res, 200, { error: "Battle has already started" });
      if (battle.players.some(p => p.uid === uid))
        return this._json(res, 200, { error: "Already in this battle" });
      if (battle.players.length >= battle.maxPlayers)
        return this._json(res, 200, { error: "Battle is full" });

      const deducted = await this.db.atomicDeduct(uid, -battle.cost);
      if (!deducted) return this._json(res, 200, { error: "Insufficient balance" });

      battle.players.push({ uid, tag, cost: battle.cost, rewards: [], totalValue: 0, netWin: 0 });
      this._cbUserBattle.set(uid, battleId);

      // If now full, start the battle
      if (battle.players.length >= battle.maxPlayers) {
        this._cbStartBattle(battle);
      }

      return this._json(res, 200, { battleId });
    }

    // POST /api/case-battle/:id/watch — register as a watcher
    if (p.startsWith("/api/case-battle/") && p.endsWith("/watch") && req.method === "POST") {
      const uid = this._uid(req);
      if (!uid) return this._json(res, 401, { error: "Not logged in" });
      const battleId = p.slice("/api/case-battle/".length, -"/watch".length);
      const battle = this._cbActive.get(battleId);
      if (!battle) return this._json(res, 200, { error: "Battle not found" });
      // Don't let players in the battle register as watchers
      if (!battle.players.some(p => p.uid === uid)) {
        if (!battle.watchers) battle.watchers = new Set();
        battle.watchers.add(uid);
      }
      return this._json(res, 200, { battleId });
    }

    // GET /api/case-battle/:id — get battle state (also used for watching)
    if (p.startsWith("/api/case-battle/") && !p.includes("/join") && !p.includes("/create") && !p.includes("/watch") && req.method === "GET") {
      const uid = this._uid(req);
      if (!uid) return this._json(res, 401, { error: "Not logged in" });
      const battleId = p.slice("/api/case-battle/".length);
      const battle = this._cbActive.get(battleId);
      if (!battle) return this._json(res, 200, { notFound: true });
      const isPlayer = battle.players.some(p => p.uid === uid);

      return this._json(res, 200, {
        id: battle.id,
        mode: battle.mode,
        cases: battle.cases,
        cost: battle.cost,
        pot: battle.pot,
        maxPlayers: battle.maxPlayers,
        speed: battle.speed || "normal",
        jackpot: !!battle.jackpot,
        crazy: !!battle.crazy,
        creatorUid: battle.creatorUid,
        phase: battle.phase,
        startsAt: battle.startsAt || null,
        openedAt: battle.openedAt || null,
        caseStaggerMs: battle.caseStaggerMs || 600,
        caseSpinMs: battle.caseSpinMs || 400,
        winnerUid: battle.winnerUid,
        resolvedAt: battle.resolvedAt || null,
        isPlayer,
        players: battle.players.map(p => ({
          uid: p.uid,
          tag: p.tag || p.uid,
          cost: p.cost,
          rewards: p.rewards || [],
          totalValue: p.totalValue || 0,
          netWin: p.netWin || 0,
        })),
      });
    }

    if (p === "/login" && req.method === "GET") {
      if (!this.clientId) return this._html(res, 500, errPage("⚠️ Not Configured", "Add fluxerClientId, fluxerClientSecret, and webBaseUrl to config.json.", "#", "—"));
      const state  = crypto.randomBytes(16).toString("hex");
      const expiry = Date.now() + 10 * 60 * 1000;
      this._states.set(state, { createdAt: Date.now(), expiry });
      const authUrl = `${FLUXER_AUTH_URL}?client_id=${encodeURIComponent(this.clientId)}&scope=identify+guilds&redirect_uri=${encodeURIComponent(this.redirectUri)}&response_type=code&state=${encodeURIComponent(state)}`;
      return this._html(res, 200, loginPage(authUrl));
    }

    if (p === "/oauth/callback" && req.method === "GET") {
      const code  = u.searchParams.get("code");
      const state = u.searchParams.get("state");
      const stored = this._states.get(state);
      if (!code || !state || !stored) return this._html(res, 400, errPage("❌ Login Failed", "Invalid or expired login state.", "/login", "Try again"));
      // Reject stale or expired CSRF states
      if (Date.now() > (stored.expiry ?? 0)) {
        this._states.delete(state);
        return this._html(res, 400, errPage("❌ Login Failed", "Login state expired. Please try again.", "/login", "Try again"));
      }
      this._states.delete(state);
      let tokenData;
      try {
        const raw = await nodeFetch(FLUXER_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, grant_type: "authorization_code", code, redirect_uri: this.redirectUri }).toString(),
        });
        tokenData = JSON.parse(raw);
      } catch(e) { console.error("[OAuth]", e); return this._html(res, 500, errPage("⚠️ Error", "Could not reach Fluxer.", "/login", "Retry")); }
      if (!tokenData.access_token) return this._html(res, 400, errPage("❌ Login Failed", tokenData.error_description ?? tokenData.message ?? "Unknown error", "/login", "Try again"));
      let me;
      try { me = JSON.parse(await nodeFetch(FLUXER_ME_URL, { headers: { Authorization: `Bearer ${tokenData.access_token}` } })); }
      catch { return this._html(res, 500, errPage("⚠️ Error", "Could not fetch Fluxer profile.", "/login", "Retry")); }
      const userId    = me.id;
      const tag       = me.username ?? me.tag ?? userId;
      const avatar    = me.avatar ? `https://cdn.fluxer.app/avatars/${userId}/${me.avatar}.png?size=64` : "";
      const ip        = (req.headers["x-forwarded-for"] ?? req.headers["x-real-ip"] ?? "").split(",")[0].trim() || null;
      const oldSid    = parseCookies(req).sid; // revoke old session to prevent fixation
      const newSid    = crypto.randomBytes(32).toString("hex");
      if (oldSid) {
        await this.db.rotateSession(userId, oldSid, newSid, 2 * 60 * 60 * 1000, ip).catch(() => {});
      } else {
        await this.db.createSession(userId, newSid, 2 * 60 * 60 * 1000, ip);
      }
      const base = "HttpOnly; Path=/; Max-Age=7200; SameSite=Lax";
      res.setHeader("Set-Cookie", [
        `sid=${newSid}; ${base}`,
        `uid=${userId}; ${base}`,
        `dtag=${encodeURIComponent(tag)}; Path=/; Max-Age=7200; SameSite=Lax`,
        `dav=${encodeURIComponent(avatar)}; Path=/; Max-Age=7200; SameSite=Lax`,
      ]);
      // Redirect admins straight to the panel after login
      return this._redirect(res, this._admin.isAdmin(userId) ? "/admin/panel" : "/lobby");
    }

    if (p === "/logout") {
      const uid = this._uid(req);
      if (uid) { const c = parseCookies(req); if (c.sid) await this.db.revokeSession(uid, c.sid).catch(() => {}); }
      res.setHeader("Set-Cookie", ["sid=; Path=/; Max-Age=0", "uid=; Path=/; Max-Age=0", "dtag=; Path=/; Max-Age=0", "dav=; Path=/; Max-Age=0"]);
      return this._redirect(res, "/login");
    }

    res.writeHead(404); res.end("Not found");
  }

  _uid(req)  {
    const c = parseCookies(req);
    if (!c.sid || !c.uid) return null;
    // Optional IP-binding: reject sessions if the connecting IP changed.
    if (this._sessionIpBinding) {
      const ip = (req.headers["x-forwarded-for"] ?? req.headers["x-real-ip"] ?? "").split(",")[0].trim() || null;
      const cached = this._ipCache?.get(`${c.uid}:${c.sid}`);
      if (cached !== undefined && cached !== ip) {
        // Grace period: allow a brief window for legitimate IP shifts (e.g. mobile networks).
        const now = Date.now();
        const entry = this._ipGrace?.get(`${c.uid}:${c.sid}`);
        if (!entry || now - entry > this._sessionIpTolerance) {
          console.warn(`[Session] IP mismatch for uid=${c.uid}: cached=${cached} got=${ip}`);
          return null;
        }
      }
      if (!this._ipCache) this._ipCache = new Map();
      this._ipCache.set(`${c.uid}:${c.sid}`, ip);
    }
    return c.uid;
  }
  _html(res, s, b) { res.writeHead(s, { "Content-Type": "text/html;charset=utf-8" }); res.end(b); }
  _json(res, s, o) { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); }
  _redirect(res, l) { res.setHeader("Location", l); res.writeHead(302); res.end(); }
}
