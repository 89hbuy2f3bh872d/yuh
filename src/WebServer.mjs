import http from "http";
import { URL } from "url";
import crypto from "crypto";
import https from "https";
import zlib from "zlib";
import { pendingSessions } from "../commands/fishslot.mjs";
import { getFishslotAsset } from "./FishslotAssets.mjs";

// ---------------------------------------------------------------------------
// Fluxer OAuth2
// ---------------------------------------------------------------------------
const FLUXER_AUTH_URL  = "https://web.canary.fluxer.app/oauth2/authorize";
const FLUXER_TOKEN_URL = "https://api.fluxer.app/v1/oauth2/token";
const FLUXER_ME_URL    = "https://api.fluxer.app/v1/users/@me";

// ---------------------------------------------------------------------------
// In-memory spin sessions  token -> { uid, bet, ts }
// ---------------------------------------------------------------------------
const spinSessions = new Map();
setInterval(() => {
  const cut = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of spinSessions) if (v.ts < cut) spinSessions.delete(k);
}, 5 * 60 * 1000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function rawFetch(url, opts = {}, maxRedirects = 4) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const mod     = parsed.protocol === "https:" ? https : http;
    const bodyBuf = opts.body ? Buffer.from(opts.body) : Buffer.alloc(0);
    const headers = {
      "User-Agent":      "Mozilla/5.0 (compatible; SirGreenCasino/2.0)",
      "Accept":          "*/*",
      "Accept-Encoding": "gzip, deflate, br",
      ...(opts.headers ?? {}),
      "Content-Length":  bodyBuf.length,
    };
    const r = mod.request(
      { hostname: parsed.hostname,
        port:     parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path:     parsed.pathname + parsed.search,
        method:   opts.method ?? "GET",
        headers },
      res => {
        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location && maxRedirects > 0)
          return resolve(rawFetch(new URL(res.headers.location, url).toString(), opts, maxRedirects - 1));
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          const enc = (res.headers["content-encoding"] ?? "").toLowerCase();
          const decomp = enc === "br"      ? zlib.brotliDecompressSync(raw)
                       : enc === "gzip"    ? zlib.gunzipSync(raw)
                       : enc === "deflate" ? zlib.inflateSync(raw)
                       : raw;
          resolve({ statusCode: res.statusCode, headers: res.headers, body: decomp });
        });
      }
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
    const idx = part.indexOf("="); if (idx < 0) continue;
    out[decodeURIComponent(part.slice(0, idx).trim())] =
      decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// RNG payout (house edge ~3%)
// Returns net delta relative to bet.
// ---------------------------------------------------------------------------
function rollPayout(bet) {
  const r = Math.random();
  if (r < 0.02)  return bet * 4;   // 5× total, 2%
  if (r < 0.07)  return bet * 2;   // 3× total, 5%
  if (r < 0.17)  return bet * 1;   // 2× total, 10%
  if (r < 0.47)  return 0;         // push, 30%
  return -bet;                      // lose, 53%
}

// ---------------------------------------------------------------------------
// Shared CSS
// ---------------------------------------------------------------------------
const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden;background:#040d04;-webkit-font-smoothing:antialiased}
body{font-family:'Segoe UI',system-ui,sans-serif;color:#e2ffe2}
a{color:inherit;text-decoration:none}
button{cursor:pointer;background:none;border:none;color:inherit;font:inherit}
`;

// ---------------------------------------------------------------------------
// Game page — C3 scripts load directly in THIS document (no iframe)
//
// The C3 canvas fills the entire viewport below our overlay bar.
// We intercept pointerdown on the canvas to detect spin clicks.
// All money logic is server-side; C3's internal balance display is ignored.
// ---------------------------------------------------------------------------
function gamePage(bal, tag, initBet, discordToken) {
  const safeBal   = Number(bal)     || 0;
  const safeInitBet = Number(initBet) || 10;
  const safeToken = esc(discordToken ?? "");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>Fish Slot</title>
<link rel="manifest" href="/fishslot/appmanifest.json">
<link rel="stylesheet" href="/fishslot/style.css">
<style>
${BASE_CSS}
/* ── overlay bar ── */
#fluxerBar {
  position: fixed;
  top: 0; left: 0; right: 0;
  z-index: 99999;
  display: flex;
  align-items: center;
  gap: .6rem;
  flex-wrap: wrap;
  padding: .4rem .8rem;
  background: rgba(4,13,4,.96);
  backdrop-filter: blur(10px);
  border-bottom: 1px solid #2ecc7122;
  font-family: 'Segoe UI', system-ui, sans-serif;
  font-size: .78rem;
  color: #e2ffe2;
  min-height: 44px;
  user-select: none;
}
#fluxerBar .fb-back {
  background: #0a1f0a;
  border: 1px solid #2ecc7133;
  color: #a8e6a8;
  padding: .25rem .6rem;
  border-radius: 6px;
  font-size: .72rem;
  font-weight: 700;
  white-space: nowrap;
  transition: border-color .18s, color .18s;
}
#fluxerBar .fb-back:hover { border-color: #2ecc71; color: #2ecc71; }
#fluxerBar .fb-title {
  font-weight: 900;
  color: #e2ffe2;
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
#fluxerBar .fb-bal {
  display: flex;
  align-items: center;
  gap: .3rem;
  background: #0a1f0a;
  border: 1px solid #2ecc7133;
  border-radius: 7px;
  padding: .25rem .6rem;
  font-weight: 700;
  white-space: nowrap;
}
#fluxerBar .fb-bal strong { color: #2ecc71; font-size: .9rem; }
#fluxerBar .fb-bet {
  display: flex;
  align-items: center;
  gap: .3rem;
  background: #0a1f0a;
  border: 1px solid #2ecc7133;
  border-radius: 7px;
  padding: .25rem .5rem;
  font-weight: 700;
}
#fluxerBar .fb-bet label { color: #4a9a4a; }
#fluxerBar .fb-bet input {
  width: 68px;
  background: #071507;
  border: 1px solid #2ecc7122;
  border-radius: 5px;
  color: #e2ffe2;
  font-size: .8rem;
  font-weight: 700;
  text-align: right;
  padding: .15rem .35rem;
  outline: none;
  font-family: inherit;
}
#fluxerBar .fb-bet input:focus { border-color: #2ecc71; }
#fluxerBar .fb-spin {
  background: linear-gradient(135deg,#27ae60,#2ecc71);
  color: #060e06;
  font-weight: 900;
  font-size: .78rem;
  padding: .28rem .8rem;
  border-radius: 7px;
  letter-spacing: .04em;
  box-shadow: 0 2px 10px #2ecc7144;
  transition: all .18s;
  white-space: nowrap;
}
#fluxerBar .fb-spin:hover:not(:disabled) { box-shadow: 0 4px 16px #2ecc7177; transform: translateY(-1px); }
#fluxerBar .fb-spin:disabled { opacity: .45; cursor: not-allowed; }
#fluxerBar .fb-logout { font-size: .65rem; color: #3a6b3a; border-bottom: 1px solid #2ecc7122; white-space: nowrap; }
#fluxerBar .fb-logout:hover { color: #2ecc71; }
/* result banner */
#fbBanner {
  display: none;
  position: fixed;
  bottom: 1.2rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 99999;
  background: #0e230e;
  border: 2px solid #2ecc7133;
  border-radius: 11px;
  padding: .6rem 1.2rem;
  font-family: 'Segoe UI', system-ui, sans-serif;
  font-weight: 700;
  font-size: .9rem;
  color: #e2ffe2;
  box-shadow: 0 4px 20px #2ecc7122;
  pointer-events: none;
  white-space: nowrap;
}
/* push C3 canvas down so it's not under the bar */
#c3canvas, canvas { margin-top: 44px !important; }
</style>
</head>
<body>

<!-- ── Fluxer FC overlay bar ── -->
<div id="fluxerBar">
  <button class="fb-back" onclick="location.href='/lobby'">&#8592; Lobby</button>
  <span class="fb-title">🐟 Fish Slot</span>
  <div class="fb-bal">💰 Balance:&nbsp;<strong id="fbBalNum">${safeBal.toLocaleString()}</strong>&nbsp;FC</div>
  <div class="fb-bet">
    <label for="fbBet">Bet:</label>
    <input id="fbBet" type="number" min="1" step="1" value="${safeInitBet}">
    <span style="color:#4a9a4a">FC</span>
  </div>
  <button id="fbSpinBtn" class="fb-spin">🎰 Spin</button>
  <a href="/logout" class="fb-logout">logout</a>
</div>

<!-- result banner -->
<div id="fbBanner"></div>

<!-- ── C3 game scripts (same document — no iframe) ── -->
<script>
if (location.protocol.substr(0,4) === "file") {
  alert("Web exports won't work until you upload them.");
}
</script>
<script src="/fishslot/scripts/supportcheck.js"></script>
<script src="/fishslot/scripts/offlineclient.js" type="module"></script>
<script src="/fishslot/scripts/main.js" type="module"></script>
<script src="/fishslot/scripts/register-sw.js" type="module"></script>

<!-- ── Fluxer currency logic ── -->
<script>
(function(){
  const DISCORD_TOKEN = "${safeToken}";
  let bal     = ${safeBal};
  let spinning = false;

  const balNum  = document.getElementById("fbBalNum");
  const betInput= document.getElementById("fbBet");
  const spinBtn = document.getElementById("fbSpinBtn");
  const banner  = document.getElementById("fbBanner");

  function setBal(n) {
    bal = Math.max(0, Math.floor(Number(n)||0));
    balNum.textContent = bal.toLocaleString();
  }
  function getBet() { return Math.max(1, Math.floor(Number(betInput.value)||1)); }
  function setSpin(s) {
    spinning = s;
    spinBtn.disabled = s;
    spinBtn.textContent = s ? "\u23f3 Spinning\u2026" : "\ud83c\udfb0 Spin";
  }
  function showBanner(msg, win) {
    banner.textContent = msg;
    banner.style.borderColor = win ? "#2ecc7188" : "#e74c3c88";
    banner.style.color = win ? "#e2ffe2" : "#ffcccc";
    banner.style.display = "block";
    clearTimeout(banner._t);
    banner._t = setTimeout(()=>{ banner.style.display="none"; }, 5000);
  }

  async function doSpin() {
    if (spinning) return;
    const bet = getBet();
    if (bet < 1)   { showBanner("\u26a0\ufe0f Bet must be at least 1 FC", false); return; }
    if (bet > bal) { showBanner("\u26a0\ufe0f Not enough FC!", false); return; }

    setSpin(true);
    banner.style.display = "none";

    // 1. Deduct bet server-side immediately
    let spinToken;
    try {
      const r = await fetch("/api/fishslot/spin", {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ bet, discordToken: DISCORD_TOKEN }),
      });
      const d = await r.json();
      if (!r.ok || d.error) { showBanner("\u26a0\ufe0f "+(d.error||"Spin failed"), false); setSpin(false); return; }
      spinToken = d.spinToken;
      setBal(d.newBal);
    } catch { showBanner("\u26a0\ufe0f Network error", false); setSpin(false); return; }

    // 2. Wait for C3 animation (~4.5 s)
    await new Promise(r=>setTimeout(r,4500));

    // 3. Resolve payout
    try {
      const r = await fetch("/api/fishslot/resolve", {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ spinToken, discordToken: DISCORD_TOKEN }),
      });
      const d = await r.json();
      if (!r.ok || d.error) {
        showBanner("\u26a0\ufe0f "+(d.error||"Result error"), false);
      } else {
        setBal(d.newBal);
        const delta = Number(d.delta)||0;
        if (delta > 0)       showBanner("\ud83c\udf89 +"+delta.toLocaleString()+" FC \u2014 you won!", true);
        else if (delta === 0) showBanner("\ud83d� Push \u2014 bet returned.", true);
        else                  showBanner("\ud83d\udcb8 "+Math.abs(delta).toLocaleString()+" FC lost.", false);
      }
    } catch { showBanner("\u26a0\ufe0f Could not save result", false); }
    finally { setSpin(false); }
  }

  spinBtn.addEventListener("click", doSpin);
  betInput.addEventListener("keydown", e=>{ if(e.key==="Enter") doSpin(); });

  // Poll balance every 5 s
  setInterval(()=>{
    if (spinning) return;
    fetch("/api/balance").then(r=>r.json()).then(d=>{ if(d.bal!==undefined) setBal(d.bal); }).catch(()=>{});
  }, 5000);

})();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------
const LOBBY_CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{-webkit-font-smoothing:antialiased;scroll-behavior:smooth}
body{background:#060e06;color:#e2ffe2;font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;overflow-x:hidden}
a{color:inherit;text-decoration:none}
button{cursor:pointer;background:none;border:none;color:inherit;font:inherit}
::-webkit-scrollbar{width:6px}::-webkit-scrollbar-track{background:#0a1a0a}::-webkit-scrollbar-thumb{background:#2ecc7155;border-radius:99px}
.nav{position:sticky;top:0;z-index:100;background:rgba(6,14,6,.92);backdrop-filter:blur(12px);border-bottom:1px solid #2ecc7122;display:flex;align-items:center;gap:.8rem;padding:.6rem 1.2rem;min-height:50px}
.nav-logo{font-weight:900;color:#2ecc71;font-size:1rem;white-space:nowrap}
.nav-spacer{flex:1}
.nav-bal{font-size:.78rem;font-weight:700;color:#a8e6a8;white-space:nowrap}
.nav-bal strong{color:#2ecc71}
.nav-logout{font-size:.68rem;color:#3a6b3a;border-bottom:1px solid #2ecc7122}
.nav-logout:hover{color:#2ecc71}
.wrap{padding:1.5rem;max-width:960px;margin:0 auto}
.section-title{font-size:.9rem;font-weight:900;letter-spacing:.08em;text-transform:uppercase;color:#2ecc71;text-shadow:0 0 10px #2ecc7155;margin-bottom:1.2rem}
.games-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:1rem}
.game-card{background:#0a1f0a;border:1px solid #2ecc7122;border-radius:12px;overflow:hidden;cursor:pointer;transition:transform .18s,box-shadow .18s,border-color .18s}
.game-card:hover{transform:translateY(-3px) scale(1.02);box-shadow:0 8px 28px #2ecc7133;border-color:#2ecc7166}
.game-thumb{width:100%;aspect-ratio:4/3;background:linear-gradient(135deg,#071507,#0d2b0d);display:flex;align-items:center;justify-content:center;font-size:3.5rem}
.game-info{padding:.5rem .6rem .6rem}
.game-name{font-size:.75rem;font-weight:700;color:#c8f5c8}
.game-meta{font-size:.62rem;color:#4a9a4a;margin-top:.15rem}
.login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
.login-card{background:linear-gradient(160deg,#0e230e,#071507);border:2px solid #2ecc7133;border-radius:18px;padding:2.5rem 2rem;max-width:380px;width:100%;text-align:center;box-shadow:0 0 50px #2ecc7111}
.login-logo{font-size:3rem;margin-bottom:.4rem}
.login-title{font-size:1.8rem;font-weight:900;color:#2ecc71;text-shadow:0 0 16px #2ecc71bb;margin-bottom:.2rem}
.login-sub{font-size:.7rem;letter-spacing:.22em;text-transform:uppercase;color:#4a9a4a;margin-bottom:1.4rem}
.login-desc{font-size:.87rem;color:#a8d5a8;display:block;margin-bottom:1.4rem;line-height:1.6}
.login-btn{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;background:linear-gradient(135deg,#27ae60,#2ecc71);color:#060e06;font-size:.95rem;font-weight:900;padding:.8rem 1.8rem;border-radius:10px;box-shadow:0 4px 18px #2ecc7144;transition:all .18s;width:100%}
.login-btn:hover{box-shadow:0 6px 26px #2ecc7166;transform:translateY(-1px)}
.login-footer{margin-top:1.2rem;font-size:.67rem;color:#2a4a2a;line-height:1.7}
.err-card{background:#0e230e;border:2px solid #2ecc7133;border-radius:14px;padding:2rem;max-width:400px;width:100%;text-align:center;box-shadow:0 0 36px #2ecc7111;margin:auto}
.err-card h1{color:#2ecc71;font-size:1.4rem;margin-bottom:.8rem}
.err-card p{color:#a8d5a8;margin-bottom:.8rem;line-height:1.6}
.err-btn{display:inline-flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#27ae60,#2ecc71);color:#060e06;font-weight:900;padding:.7rem 1.4rem;border-radius:9px;margin-top:.6rem;cursor:pointer;font-size:.87rem;transition:all .18s}
.err-btn:hover{transform:translateY(-1px);box-shadow:0 4px 18px #2ecc7155}
`;

function lobbyPage(bal, tag) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SirGreen Casino</title><style>${LOBBY_CSS}</style></head><body>
<nav class="nav"><div class="nav-logo">🐟 SirGreen Casino</div><div class="nav-spacer"></div><div class="nav-bal">Balance: <strong id="navBal">${Number(bal).toLocaleString()} FC</strong></div><span style="font-size:.78rem;color:#a8d5a8">${esc(tag)}</span><a href="/logout" class="nav-logout">logout</a></nav>
<div class="wrap">
<div class="section-title">🎮 Game Lobby</div>
<div class="games-grid">
  <div class="game-card" onclick="location.href='/game/fishslot'">
    <div class="game-thumb">🐟</div>
    <div class="game-info"><div class="game-name">🐟 Fish Slot</div><div class="game-meta">vermingov</div></div>
  </div>
</div>
</div>
</body></html>`;
}

function loginPage(authUrl) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SirGreen Casino</title><style>${LOBBY_CSS}</style></head><body><div class="login-wrap"><div class="login-card"><div class="login-logo">🐟</div><div class="login-title">SirGreen Casino</div><div class="login-sub">Powered by FluxCoins</div><span class="login-desc">Login with your <strong style="color:#2ecc71">Fluxer</strong> account to play Fish Slot with your FluxCoin balance.</span><a class="login-btn" href="${esc(authUrl)}">&#128994;&nbsp; Login with Fluxer</a><div class="login-footer">Global FluxCoin economy across all Fluxer servers.<br>Play responsibly.</div></div></div></body></html>`;
}

function errPage(title, msg, href, label) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Error</title><style>${LOBBY_CSS}</style></head><body><div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem"><div class="err-card"><h1>${esc(title)}</h1><p>${esc(msg)}</p><a class="err-btn" href="${esc(href??'/login')}">${esc(label??'Back')}</a></div></div></body></html>`;
}

// ===========================================================================
// WEB SERVER
// ===========================================================================
export class WebServer {
  constructor(db, config) {
    this.db           = db;
    this.config       = config;
    this.port         = config.webPort            ?? 3420;
    this.clientId     = config.fluxerClientId     ?? config.discordClientId     ?? "";
    this.clientSecret = config.fluxerClientSecret ?? config.discordClientSecret ?? "";
    this.baseUrl      = config.webBaseUrl          ?? "https://www.sirgreen.online";
    this.redirectUri  = `${this.baseUrl}/oauth/callback`;
    this._states      = new Map();
  }

  async start() {
    this._server = http.createServer((req, res) =>
      this._handle(req, res).catch(e => {
        console.error("[Web]", e);
        res.writeHead(500); res.end("Internal error");
      })
    );
    this._server.listen(this.port, "0.0.0.0", () =>
      console.log(`[Web] SirGreen Casino on port ${this.port}`));
    setInterval(() => {
      const cut = Date.now() - 15 * 60 * 1000;
      for (const [s, ts] of this._states) if (ts < cut) this._states.delete(s);
    }, 10 * 60 * 1000);
  }

  async _handle(req, res) {
    const u    = new URL(req.url, "http://localhost");
    const path = u.pathname;

    // Root → lobby
    if (path === "/") return this._redirect(res, "/lobby");

    // ===========================================================================
    // /fishslot/* — serve static game assets (scripts, images, media, etc.)
    // BUT redirect bare /fishslot and /fishslot/index.html to our wrapper page
    // so users always go through /game/fishslot
    // ===========================================================================
    if (path === "/fishslot" || path === "/fishslot/") {
      return this._redirect(res, "/game/fishslot");
    }
    if (path === "/fishslot/index.html") {
      return this._redirect(res, "/game/fishslot");
    }
    if (path.startsWith("/fishslot/")) {
      let assetPath = path.slice("/fishslot".length);
      const asset   = getFishslotAsset(assetPath);
      if (!asset) { res.writeHead(404); return res.end("Not found"); }
      res.writeHead(200, {
        "Content-Type":   asset.mime,
        "Cache-Control":  "public, max-age=3600",
        "Content-Length": asset.body.length,
      });
      return res.end(asset.body);
    }

    // ===========================================================================
    // Lobby
    // ===========================================================================
    if (path === "/lobby" && req.method === "GET") {
      const uid = this._uid(req);
      if (!uid) return this._redirect(res, "/login");
      const user    = await this.db.getUser(uid);
      const cookies = parseCookies(req);
      return this._html(res, 200, lobbyPage(
        Number(user?.bal ?? 0),
        decodeURIComponent(cookies.dtag ?? "Player")
      ));
    }

    // ===========================================================================
    // Game page — C3 game + FC overlay in ONE document
    // ===========================================================================
    if (path === "/game/fishslot" && req.method === "GET") {
      const uid = this._uid(req);
      if (!uid) return this._redirect(res, "/login");

      const token = u.searchParams.get("token");
      const user  = await this.db.getUser(uid);
      const bal   = Number(user?.bal ?? 0);
      const cookies = parseCookies(req);

      let initBet = 10;
      if (token && pendingSessions.has(token)) {
        const sess = pendingSessions.get(token);
        if (sess.uid !== uid) {
          return this._html(res, 403, errPage(
            "\u26d4 Wrong Account",
            "This game link belongs to a different Fluxer account.",
            "/login", "Switch account"
          ));
        }
        initBet = sess.bet;
      }

      return this._html(res, 200, gamePage(bal,
        decodeURIComponent(cookies.dtag ?? "Player"),
        initBet, token ?? ""
      ));
    }

    // ===========================================================================
    // API: spin — deducts bet immediately
    // ===========================================================================
    if (path === "/api/fishslot/spin" && req.method === "POST") {
      const uid = this._uid(req);
      if (!uid) return this._json(res, 401, { error: "Not logged in" });

      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return this._json(res, 400, { error: "Bad JSON" }); }

      const bet = Math.max(1, Math.floor(Number(body.bet) || 0));
      if (!bet) return this._json(res, 400, { error: "Invalid bet" });

      const user  = await this.db.getUser(uid);
      const dbBal = Number(user?.bal ?? 0);
      if (dbBal < bet) return this._json(res, 400, { error: "Insufficient balance" });

      await this.db.updateBalance(uid, -bet);

      const spinToken = crypto.randomBytes(24).toString("hex");
      spinSessions.set(spinToken, { uid, bet, ts: Date.now() });

      return this._json(res, 200, { ok: true, spinToken, newBal: dbBal - bet });
    }

    // ===========================================================================
    // API: resolve — applies RNG payout
    // ===========================================================================
    if (path === "/api/fishslot/resolve" && req.method === "POST") {
      const uid = this._uid(req);
      if (!uid) return this._json(res, 401, { error: "Not logged in" });

      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return this._json(res, 400, { error: "Bad JSON" }); }

      const { spinToken } = body;
      if (!spinToken || !spinSessions.has(spinToken))
        return this._json(res, 400, { error: "Unknown or expired spin token" });

      const sess = spinSessions.get(spinToken);
      if (sess.uid !== uid) return this._json(res, 403, { error: "Token mismatch" });
      spinSessions.delete(spinToken);

      const delta = rollPayout(sess.bet);
      if (delta !== 0) await this.db.updateBalance(uid, delta);
      await this.db.recordGame(uid, delta >= 0, sess.bet);

      if (body.discordToken && pendingSessions.has(body.discordToken))
        pendingSessions.delete(body.discordToken);

      const updated = await this.db.getUser(uid);
      return this._json(res, 200, { ok: true, delta, newBal: Number(updated?.bal ?? 0) });
    }

    // ===========================================================================
    // API: balance poll
    // ===========================================================================
    if (path === "/api/balance" && req.method === "GET") {
      const uid = this._uid(req);
      if (!uid) return this._json(res, 401, { error: "Not logged in" });
      const user = await this.db.getUser(uid);
      return this._json(res, 200, { bal: Number(user?.bal ?? 0) });
    }

    // ===========================================================================
    // Login
    // ===========================================================================
    if (path === "/login" && req.method === "GET") {
      if (!this.clientId) {
        return this._html(res, 500, errPage(
          "\u26a0\ufe0f Not Configured",
          "Add fluxerClientId/fluxerClientSecret/webBaseUrl to config.json.",
          "#", "\u2014"
        ));
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

    // ===========================================================================
    // OAuth callback
    // ===========================================================================
    if (path === "/oauth/callback" && req.method === "GET") {
      const code  = u.searchParams.get("code");
      const state = u.searchParams.get("state");
      if (!code || !state || !this._states.has(state))
        return this._html(res, 400, errPage("\u274c Login Failed", "Invalid or expired login state.", "/login", "Try again"));
      this._states.delete(state);

      let tokenData;
      try {
        const raw = await nodeFetch(FLUXER_TOKEN_URL, {
          method:  "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body:    new URLSearchParams({
            client_id:     this.clientId,
            client_secret: this.clientSecret,
            grant_type:    "authorization_code",
            code,
            redirect_uri:  this.redirectUri,
          }).toString(),
        });
        tokenData = JSON.parse(raw);
      } catch (e) {
        console.error("[OAuth] token exchange failed", e);
        return this._html(res, 500, errPage("\u26a0\ufe0f Error", "Could not reach Fluxer.", "/login", "Retry"));
      }
      if (!tokenData.access_token) {
        return this._html(res, 400, errPage(
          "\u274c Login Failed",
          tokenData.error_description ?? tokenData.message ?? "Unknown error",
          "/login", "Try again"
        ));
      }

      let me;
      try {
        me = JSON.parse(await nodeFetch(FLUXER_ME_URL, {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        }));
      } catch {
        return this._html(res, 500, errPage("\u26a0\ufe0f Error", "Could not fetch Fluxer profile.", "/login", "Retry"));
      }

      const userId  = me.id;
      const tag     = me.username ?? me.tag ?? userId;
      const avatar  = me.avatar
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

    // ===========================================================================
    // Logout
    // ===========================================================================
    if (path === "/logout") {
      const uid = this._uid(req);
      if (uid) {
        const c = parseCookies(req);
        if (c.sid) await this.db.revokeSession(uid, c.sid).catch(() => {});
      }
      res.setHeader("Set-Cookie", [
        "sid=; Path=/; Max-Age=0", "uid=; Path=/; Max-Age=0",
        "dtag=; Path=/; Max-Age=0", "dav=; Path=/; Max-Age=0",
      ]);
      return this._redirect(res, "/login");
    }

    res.writeHead(404); res.end("Not found");
  }

  _uid(req) {
    const c = parseCookies(req);
    return (c.sid && c.uid) ? c.uid : null;
  }
  _html(res, s, b) { res.writeHead(s, {"Content-Type":"text/html;charset=utf-8"}); res.end(b); }
  _json(res, s, o) { res.writeHead(s, {"Content-Type":"application/json"}); res.end(JSON.stringify(o)); }
  _redirect(res, l) { res.setHeader("Location", l); res.writeHead(302); res.end(); }
}
