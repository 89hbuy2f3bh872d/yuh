import http from "http";
import { URL } from "url";
import crypto from "crypto";
import https from "https";
import zlib from "zlib";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { preloadFishslotAssets, getFishslotAsset } from "./FishslotAssets.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAMES_ASSETS_DIR = path.resolve(__dirname, "../games/assets/sir-bandit");
const SIR_BANDIT_HTML = path.resolve(__dirname, "../games/sir-bandit.html");

const FLUXER_AUTH_URL = "https://web.canary.fluxer.app/oauth2/authorize";
const FLUXER_TOKEN_URL = "https://api.fluxer.app/v1/oauth2/token";
const FLUXER_ME_URL = "https://api.fluxer.app/v1/users/@me";

// ---------------------------------------------------------------------------
// MIME types
// ---------------------------------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};
function getMime(filePath) {
  return (
    MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream"
  );
}

// ---------------------------------------------------------------------------
// Asset preload cache — all files under games/assets/ read into memory once
// at startup so there are zero cold-read races on first request.
// ---------------------------------------------------------------------------
const _assetCache = new Map(); // normalised URL path → { buf, mime }

function _preloadAssets() {
  if (!fs.existsSync(GAMES_ASSETS_DIR)) return;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        try {
          const buf = fs.readFileSync(full);
          const rel =
            "/" + path.relative(GAMES_ASSETS_DIR, full).replace(/\\/g, "/");
          const urlKey = "/assets" + rel;
          _assetCache.set(urlKey, { buf, mime: getMime(full) });
        } catch (_) {}
      }
    }
  };
  walk(GAMES_ASSETS_DIR);
  console.log(`[Web] Preloaded ${_assetCache.size} game asset(s) into memory.`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function rawFetch(url, opts = {}, maxRedirects = 4) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === "https:" ? https : http;
    const bodyBuf = opts.body ? Buffer.from(opts.body) : Buffer.alloc(0);
    const headers = {
      "User-Agent": "Mozilla/5.0 (compatible; SirGreenCasino/2.0)",
      Accept: "*/*",
      "Accept-Encoding": "gzip, deflate, br",
      ...(opts.headers ?? {}),
      "Content-Length": bodyBuf.length,
    };
    const r = mod.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: opts.method ?? "GET",
        headers,
      },
      (res) => {
        if (
          [301, 302, 303, 307, 308].includes(res.statusCode) &&
          res.headers.location &&
          maxRedirects > 0
        )
          return resolve(
            rawFetch(
              new URL(res.headers.location, url).toString(),
              opts,
              maxRedirects - 1,
            ),
          );
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          const enc = (res.headers["content-encoding"] ?? "").toLowerCase();
          const decomp =
            enc === "br"
              ? zlib.brotliDecompressSync(raw)
              : enc === "gzip"
                ? zlib.gunzipSync(raw)
                : enc === "deflate"
                  ? zlib.inflateSync(raw)
                  : raw;
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: decomp,
          });
        });
      },
    );
    r.on("error", reject);
    if (bodyBuf.length) r.write(bodyBuf);
    r.end();
  });
}

async function nodeFetch(url, opts = {}) {
  const r = await rawFetch(url, opts);
  return r.body.toString("utf8");
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    out[decodeURIComponent(part.slice(0, idx).trim())] = decodeURIComponent(
      part.slice(idx + 1).trim(),
    );
  }
  return out;
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Serve a Buffer with range request support (required for <video>/<audio>)
// ---------------------------------------------------------------------------
function serveBufferWithRanges(
  req,
  res,
  buf,
  mime,
  cacheControl = "public, max-age=86400",
) {
  const total = buf.length;
  const rangeHeader = req.headers["range"];

  if (rangeHeader) {
    const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
    const start = match && match[1] ? parseInt(match[1], 10) : 0;
    const end = match && match[2] ? parseInt(match[2], 10) : total - 1;
    const safeEnd = Math.min(end, total - 1);
    const chunk = safeEnd - start + 1;
    if (start >= total || start > safeEnd) {
      res.writeHead(416, { "Content-Range": `bytes */${total}` });
      return res.end();
    }
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${safeEnd}/${total}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunk,
      "Content-Type": mime,
      "Cache-Control": cacheControl,
    });
    res.end(buf.slice(start, safeEnd + 1));
  } else {
    res.writeHead(200, {
      "Content-Type": mime,
      "Content-Length": total,
      "Accept-Ranges": "bytes",
      "Cache-Control": cacheControl,
    });
    res.end(buf);
  }
}

// ---------------------------------------------------------------------------
// Shared styles
// ---------------------------------------------------------------------------
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
.wrap{padding:1.2rem;max-width:960px;margin:0 auto}
.section-title{font-size:.85rem;font-weight:900;letter-spacing:.08em;text-transform:uppercase;color:#2ecc71;text-shadow:0 0 10px #2ecc7155;margin-bottom:1.1rem}
.games-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:.9rem}
.game-card{background:#0a1f0a;border:1px solid #2ecc7122;border-radius:11px;overflow:hidden;cursor:pointer;transition:transform .18s,box-shadow .18s,border-color .18s}
.game-card:hover{transform:translateY(-3px) scale(1.02);box-shadow:0 8px 28px #2ecc7133;border-color:#2ecc7166}
.game-thumb{width:100%;aspect-ratio:4/3;background:linear-gradient(135deg,#071507,#0d2b0d);display:flex;align-items:center;justify-content:center;font-size:3rem}
.game-info{padding:.45rem .55rem .55rem}
.game-name{font-size:.72rem;font-weight:700;color:#c8f5c8}
.game-meta{font-size:.6rem;color:#4a9a4a;margin-top:.12rem}
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
`;

function shell(head, body) {
  return `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>SirGreen Casino</title>\n<style>${SHARED_CSS}</style>\n${head ?? ""}\n</head>\n<body>\n${body}\n</body>\n</html>`;
}

function lobbyPage(bal, tag) {
  return shell(
    "",
    `
<nav class="nav">
  <div class="nav-logo">🎰 SirGreen Casino</div>
  <div class="nav-spacer"></div>
  <div class="nav-bal">Balance: <strong>${Number(bal).toLocaleString()} FC</strong></div>
  <span style="font-size:.75rem;color:#a8d5a8">${esc(tag)}</span>
  <a href="/logout" class="nav-logout">logout</a>
</nav>
<div class="wrap">
  <div class="section-title">🎮 Game Lobby</div>
  <div class="games-grid">
    <div class="game-card" onclick="location.href='/sirbandit'">
      <div class="game-thumb">⭐</div>
      <div class="game-info"><div class="game-name">⭐ Sir Bandit</div><div class="game-meta">6×5 slot — up to 30 lines</div></div>
    </div>
    <div class="game-card" onclick="location.href='/fishslot/'">
      <div class="game-thumb">🐟</div>
      <div class="game-info"><div class="game-name">🐟 Fish Slot</div><div class="game-meta">coming soon</div></div>
    </div>
  </div>
</div>`,
  );
}

function loginPage(authUrl) {
  return shell(
    "",
    `<div class="login-wrap"><div class="login-card"><div class="login-logo">🎰</div><div class="login-title">SirGreen Casino</div><div class="login-sub">Powered by FluxCoins</div><span class="login-desc">Login with your <strong style="color:#2ecc71">Fluxer</strong> account to play with your FluxCoin balance.</span><a class="login-btn" href="${esc(authUrl)}">&#128994;&nbsp; Login with Fluxer</a><div class="login-footer">Global FluxCoin economy across all Fluxer servers.<br>Play responsibly.</div></div></div>`,
  );
}

function errPage(title, msg, href, label) {
  return shell(
    "",
    `<div class="err-wrap"><div class="err-card"><h1>${esc(title)}</h1><p>${esc(msg)}</p><a class="err-btn" href="${esc(href ?? "/login")}">${esc(label ?? "Back")}</a></div></div>`,
  );
}

function fishslotWrapperPage(bal, tag) {
  const safeBal = Number(bal) || 0;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>Fish Slot — SirGreen Casino</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; overflow: hidden; background: #040d04; font-family: 'Segoe UI', system-ui, sans-serif; color: #e2ffe2; -webkit-font-smoothing: antialiased; }
a, button { color: inherit; cursor: pointer; background: none; border: none; font: inherit; text-decoration: none; }
#fcBar { position: fixed; top: 0; left: 0; right: 0; z-index: 9999; display: flex; align-items: center; gap: .6rem; padding: .38rem .75rem; background: rgba(4,13,4,.97); backdrop-filter: blur(12px); border-bottom: 2px solid #2ecc7133; font-size: .76rem; min-height: 42px; user-select: none; }
.fc-back { background:#0a1f0a;border:1px solid #2ecc7133;color:#a8e6a8;padding:.22rem .6rem;border-radius:6px;font-size:.7rem;font-weight:700;white-space:nowrap;transition:border-color .18s,color .18s; }
.fc-back:hover { border-color:#2ecc71;color:#2ecc71; }
.fc-spacer { flex: 1; }
.fc-bal { display:flex;align-items:center;gap:.28rem;background:#0a1f0a;border:1px solid #2ecc7133;border-radius:7px;padding:.22rem .55rem;font-weight:700;white-space:nowrap; }
.fc-bal strong { color:#2ecc71;font-size:.88rem; }
.fc-user { font-size:.67rem;color:#4a8a4a;white-space:nowrap;max-width:140px;overflow:hidden;text-overflow:ellipsis; }
.fc-logout { font-size:.64rem;color:#3a6b3a;border-bottom:1px solid #2ecc7122;white-space:nowrap; }
.fc-logout:hover { color:#2ecc71; }
#gameFrame { position:fixed;top:42px;left:0;right:0;bottom:0;width:100%;height:calc(100% - 42px);border:none;display:block;background:#040d04; }
</style>
</head>
<body>
<div id="fcBar">
  <button class="fc-back" onclick="location.href='/lobby'">&#8592; Lobby</button>
  <span class="fc-spacer"></span>
  <div class="fc-bal">💰&nbsp;<strong id="fcBalNum">${safeBal.toLocaleString()}</strong>&nbsp;FC</div>
  <span class="fc-user">${esc(tag)}</span>
  <a href="/logout" class="fc-logout">logout</a>
</div>
<iframe id="gameFrame" src="/fishslot/game/" allow="autoplay; fullscreen" allowfullscreen></iframe>
<script>
(function () {
  let bal = ${safeBal}; let busy = false;
  const frame = document.getElementById('gameFrame');
  const balNum = document.getElementById('fcBalNum');
  function post(msg) { try { frame.contentWindow.postMessage(msg, '*'); } catch (_) {} }
  function setDisplay(n) { bal = Math.max(0, Math.floor(Number(n)||0)); balNum.textContent = bal.toLocaleString(); }
  frame.addEventListener('load', function () { setTimeout(function () { post({ type: 'fluxer:init', balance: bal, bet: 10 }); }, 800); });
  window.addEventListener('message', async function (ev) {
    if (!ev.data || ev.data.type !== 'fluxer:result') return;
    if (busy) return; busy = true;
    const won = Number(ev.data.won) || 0;
    try {
      const r = await fetch('/api/fishslot/settle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ won }) });
      const d = await r.json();
      if (r.ok && d.newBal !== undefined) { setDisplay(d.newBal); post({ type: 'fluxer:sync', balance: d.newBal }); }
      else { const rb = await fetch('/api/balance'); const db = await rb.json(); if (db.bal !== undefined) { setDisplay(db.bal); post({ type: 'fluxer:sync', balance: db.bal }); } }
    } catch (_) { fetch('/api/balance').then(r=>r.json()).then(d=>{ if(d.bal!==undefined){ setDisplay(d.bal); post({type:'fluxer:sync',balance:d.bal}); } }).catch(()=>{}); }
    finally { busy = false; }
  });
  setInterval(function () { if (busy) return; fetch('/api/balance').then(r=>r.json()).then(d=>{ if(d.bal!==undefined&&d.bal!==bal){ setDisplay(d.bal); post({type:'fluxer:sync',balance:d.bal}); } }).catch(()=>{}); }, 8000);
})();
</script>
</body>
</html>`;
}

// ===========================================================================
// WEB SERVER
// ===========================================================================
export class WebServer {
  constructor(db, config) {
    this.db = db;
    this.config = config;
    this.port = config.webPort ?? 3420;
    this.clientId = config.fluxerClientId ?? config.discordClientId ?? "";
    this.clientSecret =
      config.fluxerClientSecret ?? config.discordClientSecret ?? "";
    this.baseUrl = config.webBaseUrl ?? "https://www.sirgreen.online";
    this.redirectUri = `${this.baseUrl}/oauth/callback`;
    this._states = new Map();
  }

  async start() {
    // Preload all game assets into memory before accepting requests
    _preloadAssets();
    await preloadFishslotAssets();

    this._server = http.createServer((req, res) =>
      this._handle(req, res).catch((e) => {
        console.error("[Web]", e);
        res.writeHead(500);
        res.end("Internal error");
      }),
    );
    this._server.listen(this.port, "0.0.0.0", () =>
      console.log(`[Web] SirGreen Casino on port ${this.port}`),
    );
    setInterval(
      () => {
        const cut = Date.now() - 15 * 60 * 1000;
        for (const [s, ts] of this._states)
          if (ts < cut) this._states.delete(s);
      },
      10 * 60 * 1000,
    );
  }

  async _handle(req, res) {
    const u = new URL(req.url, "http://localhost");
    const p = u.pathname;

    if (p === "/") return this._redirect(res, "/lobby");

    // ── Static game assets: /assets/* → served from memory cache ────────────
    if (p.startsWith("/assets/")) {
      const cached = _assetCache.get(p);
      if (!cached) {
        res.writeHead(404, { "Cache-Control": "no-store" });
        return res.end("Not found");
      }
      return serveBufferWithRanges(req, res, cached.buf, cached.mime);
    }

    // ── Sir Bandit ───────────────────────────────────────────────────────────
    if (p === "/sirbandit" || p === "/sirbandit/") {
      const uid = this._uid(req);
      if (!uid) return this._redirect(res, "/login");
      let html;
      try {
        html = fs.readFileSync(SIR_BANDIT_HTML, "utf8");
      } catch {
        return this._html(
          res,
          500,
          errPage(
            "Game not found",
            "sir-bandit.html missing.",
            "/lobby",
            "Back to lobby",
          ),
        );
      }
      // no-cache so the browser never serves a stale copy from disk
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache, no-store, must-revalidate",
      });
      return res.end(html);
    }

    // ── Sir Bandit settle ──────────────────────────────────────────────
    if (p === "/api/sirbandit/settle" && req.method === "POST") {
      const uid = this._uid(req);
      if (!uid) return this._json(res, 401, { error: "Not logged in" });
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return this._json(res, 400, { error: "Bad JSON" });
      }

      const won = Math.floor(Number(body.won) || 0);
      if (won > 50_000 || won < -100_000)
        return this._json(res, 400, { error: "Delta out of range" });

      const user = await this.db.getUser(uid);
      const curBal = Number(user?.bal ?? 0);
      const clamped = Math.max(-curBal, won);

      if (clamped !== 0) await this.db.updateBalance(uid, clamped);
      await this.db.recordGame(uid, won >= 0, Math.abs(won));

      const updated = await this.db.getUser(uid);
      return this._json(res, 200, {
        ok: true,
        newBal: Number(updated?.bal ?? 0),
      });
    }

    // ── Fish Slot wrapper ─────────────────────────────────────────────
    if (p === "/fishslot" || p === "/fishslot/") {
      const uid = this._uid(req);
      if (!uid) return this._redirect(res, "/login");
      const user = await this.db.getUser(uid);
      const cookies = parseCookies(req);
      const bal = Number(user?.bal ?? 0);
      const tag = decodeURIComponent(cookies.dtag ?? "Player");
      return this._html(res, 200, fishslotWrapperPage(bal, tag));
    }

    // ── Fish Slot game static files ───────────────────────────────
    if (p === "/fishslot/game" || p === "/fishslot/game/") {
      const asset = getFishslotAsset("/index.html");
      if (!asset) {
        res.writeHead(404);
        return res.end("Game files not found — restart the bot.");
      }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      return res.end(asset.body);
    }
    if (p.startsWith("/fishslot/")) {
      let assetPath = p.slice("/fishslot".length);
      if (assetPath.startsWith("/game/"))
        assetPath = assetPath.slice("/game".length);
      const asset = getFishslotAsset(assetPath);
      if (!asset) {
        res.writeHead(404);
        return res.end("Not found");
      }
      res.writeHead(200, {
        "Content-Type": asset.mime,
        "Cache-Control": asset.cacheControl,
        "Content-Length": asset.body.length,
      });
      return res.end(asset.body);
    }

    // ── Lobby ────────────────────────────────────────────────────────────
    if (p === "/lobby" && req.method === "GET") {
      const uid = this._uid(req);
      if (!uid) return this._redirect(res, "/login");
      const user = await this.db.getUser(uid);
      const cookies = parseCookies(req);
      return this._html(
        res,
        200,
        lobbyPage(
          Number(user?.bal ?? 0),
          decodeURIComponent(cookies.dtag ?? "Player"),
        ),
      );
    }

    // ── Fish Slot settle ────────────────────────────────────────────
    if (p === "/api/fishslot/settle" && req.method === "POST") {
      const uid = this._uid(req);
      if (!uid) return this._json(res, 401, { error: "Not logged in" });
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return this._json(res, 400, { error: "Bad JSON" });
      }
      const won = Math.floor(Number(body.won) || 0);
      if (won > 10_000)
        return this._json(res, 400, { error: "Payout out of range" });
      if (won !== 0) await this.db.updateBalance(uid, won);
      await this.db.recordGame(uid, won >= 0, Math.abs(won));
      const updated = await this.db.getUser(uid);
      return this._json(res, 200, {
        ok: true,
        newBal: Number(updated?.bal ?? 0),
      });
    }

    // ── Balance ──────────────────────────────────────────────────────────
    if (p === "/api/balance" && req.method === "GET") {
      const uid = this._uid(req);
      if (!uid) return this._json(res, 401, { error: "Not logged in" });
      const user = await this.db.getUser(uid);
      return this._json(res, 200, { bal: Number(user?.bal ?? 0) });
    }

    // ── Auth ─────────────────────────────────────────────────────────────
    if (p === "/login" && req.method === "GET") {
      if (!this.clientId) {
        return this._html(
          res,
          500,
          errPage(
            "\u26a0\ufe0f Not Configured",
            "Add fluxerClientId/fluxerClientSecret/webBaseUrl to config.json.",
            "#",
            "\u2014",
          ),
        );
      }
      const state = crypto.randomBytes(16).toString("hex");
      this._states.set(state, Date.now());
      const authUrl =
        `${FLUXER_AUTH_URL}` +
        `?client_id=${encodeURIComponent(this.clientId)}` +
        `&scope=identify+guilds` +
        `&redirect_uri=${encodeURIComponent(this.redirectUri)}` +
        `&response_type=code` +
        `&state=${encodeURIComponent(state)}`;
      return this._html(res, 200, loginPage(authUrl));
    }

    if (p === "/oauth/callback" && req.method === "GET") {
      const code = u.searchParams.get("code");
      const state = u.searchParams.get("state");
      if (!code || !state || !this._states.has(state))
        return this._html(
          res,
          400,
          errPage(
            "\u274c Login Failed",
            "Invalid or expired login state.",
            "/login",
            "Try again",
          ),
        );
      this._states.delete(state);
      let tokenData;
      try {
        const raw = await nodeFetch(FLUXER_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: this.clientId,
            client_secret: this.clientSecret,
            grant_type: "authorization_code",
            code,
            redirect_uri: this.redirectUri,
          }).toString(),
        });
        tokenData = JSON.parse(raw);
      } catch (e) {
        console.error("[OAuth]", e);
        return this._html(
          res,
          500,
          errPage(
            "\u26a0\ufe0f Error",
            "Could not reach Fluxer.",
            "/login",
            "Retry",
          ),
        );
      }
      if (!tokenData.access_token)
        return this._html(
          res,
          400,
          errPage(
            "\u274c Login Failed",
            tokenData.error_description ?? tokenData.message ?? "Unknown error",
            "/login",
            "Try again",
          ),
        );
      let me;
      try {
        me = JSON.parse(
          await nodeFetch(FLUXER_ME_URL, {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
          }),
        );
      } catch {
        return this._html(
          res,
          500,
          errPage(
            "\u26a0\ufe0f Error",
            "Could not fetch Fluxer profile.",
            "/login",
            "Retry",
          ),
        );
      }
      const userId = me.id;
      const tag = me.username ?? me.tag ?? userId;
      const avatar = me.avatar
        ? `https://cdn.fluxer.app/avatars/${userId}/${me.avatar}.png?size=64`
        : "";
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

    if (p === "/logout") {
      const uid = this._uid(req);
      if (uid) {
        const c = parseCookies(req);
        if (c.sid) await this.db.revokeSession(uid, c.sid).catch(() => {});
      }
      res.setHeader("Set-Cookie", [
        "sid=; Path=/; Max-Age=0",
        "uid=; Path=/; Max-Age=0",
        "dtag=; Path=/; Max-Age=0",
        "dav=; Path=/; Max-Age=0",
      ]);
      return this._redirect(res, "/login");
    }

    res.writeHead(404);
    res.end("Not found");
  }

  _uid(req) {
    const c = parseCookies(req);
    return c.sid && c.uid ? c.uid : null;
  }
  _html(res, s, b) {
    res.writeHead(s, { "Content-Type": "text/html;charset=utf-8" });
    res.end(b);
  }
  _json(res, s, o) {
    res.writeHead(s, { "Content-Type": "application/json" });
    res.end(JSON.stringify(o));
  }
  _redirect(res, l) {
    res.setHeader("Location", l);
    res.writeHead(302);
    res.end();
  }
}
