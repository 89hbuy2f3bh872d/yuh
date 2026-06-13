import http from "http";
import { URL } from "url";
import crypto from "crypto";
import https from "https";
import zlib from "zlib";
import { pendingSessions } from "../commands/fishslot.mjs";
import { preloadFishslotAssets, getFishslotAsset } from "./FishslotAssets.mjs";

const FLUXER_AUTH_URL  = "https://web.canary.fluxer.app/oauth2/authorize";
const FLUXER_TOKEN_URL = "https://api.fluxer.app/v1/oauth2/token";
const FLUXER_ME_URL    = "https://api.fluxer.app/v1/users/@me";

// ---------------------------------------------------------------------------
// Spin sessions  token -> { uid, bet, ts }
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

function rollPayout(bet) {
  const r = Math.random();
  if (r < 0.02) return bet * 4;
  if (r < 0.07) return bet * 2;
  if (r < 0.17) return bet * 1;
  if (r < 0.47) return 0;
  return -bet;
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
  return shell("", `
<nav class="nav">
  <div class="nav-logo">🐟 SirGreen Casino</div>
  <div class="nav-spacer"></div>
  <div class="nav-bal">Balance: <strong>${Number(bal).toLocaleString()} FC</strong></div>
  <span style="font-size:.75rem;color:#a8d5a8">${esc(tag)}</span>
  <a href="/logout" class="nav-logout">logout</a>
</nav>
<div class="wrap">
  <div class="section-title">🎮 Game Lobby</div>
  <div class="games-grid">
    <div class="game-card" onclick="location.href='/fishslot/'">
      <div class="game-thumb">🐟</div>
      <div class="game-info"><div class="game-name">🐟 Fish Slot</div><div class="game-meta">vermingov</div></div>
    </div>
  </div>
</div>`);
}

function loginPage(authUrl) {
  return shell("", `<div class="login-wrap"><div class="login-card"><div class="login-logo">🐟</div><div class="login-title">SirGreen Casino</div><div class="login-sub">Powered by FluxCoins</div><span class="login-desc">Login with your <strong style="color:#2ecc71">Fluxer</strong> account to play Fish Slot with your FluxCoin balance.</span><a class="login-btn" href="${esc(authUrl)}">&#128994;&nbsp; Login with Fluxer</a><div class="login-footer">Global FluxCoin economy across all Fluxer servers.<br>Play responsibly.</div></div></div>`);
}

function errPage(title, msg, href, label) {
  return shell("", `<div class="err-wrap"><div class="err-card"><h1>${esc(title)}</h1><p>${esc(msg)}</p><a class="err-btn" href="${esc(href??'/login')}">${esc(label??'Back')}</a></div></div>`);
}

// ---------------------------------------------------------------------------
// Fish Slot wrapper page
//
// Served at /fishslot/ and /fishslot/index.html
//
// Architecture:
//   - iframe src="/fishslot/game/" loads the REAL C3 index.html
//     All C3 relative paths (scripts/, workermain.js, media/, sw.js) resolve
//     correctly because the iframe document origin is /fishslot/game/
//   - An overlay bar sits ABOVE the iframe (position:fixed, z-index:9999)
//     It owns the FC balance display, bet input, and Spin button.
//   - Spin: POST /api/fishslot/spin  -> deducts bet, returns spinToken + newBal
//   - After 4.5s animation: POST /api/fishslot/resolve -> applies RNG payout
//   - Balance polled every 5s from /api/balance
// ---------------------------------------------------------------------------
function fishslotWrapperPage(bal, tag, initBet, discordToken) {
  const safeBal     = Number(bal)      || 0;
  const safeInitBet = Number(initBet)  || 10;
  const safeToken   = esc(discordToken ?? "");

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

/* ── overlay bar ── */
#fcBar {
  position: fixed;
  top: 0; left: 0; right: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  gap: .55rem;
  flex-wrap: wrap;
  padding: .38rem .75rem;
  background: rgba(4,13,4,.97);
  backdrop-filter: blur(12px);
  border-bottom: 2px solid #2ecc7133;
  font-size: .76rem;
  min-height: 42px;
  user-select: none;
}
.fc-back {
  background: #0a1f0a;
  border: 1px solid #2ecc7133;
  color: #a8e6a8;
  padding: .22rem .6rem;
  border-radius: 6px;
  font-size: .7rem;
  font-weight: 700;
  white-space: nowrap;
  transition: border-color .18s, color .18s;
}
.fc-back:hover { border-color: #2ecc71; color: #2ecc71; }
.fc-title { font-weight: 900; color: #e2ffe2; flex: 1; min-width: 0; font-size: .8rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fc-bal {
  display: flex; align-items: center; gap: .28rem;
  background: #0a1f0a; border: 1px solid #2ecc7133; border-radius: 7px;
  padding: .22rem .55rem; font-weight: 700; white-space: nowrap;
}
.fc-bal strong { color: #2ecc71; font-size: .88rem; }
.fc-bet {
  display: flex; align-items: center; gap: .28rem;
  background: #0a1f0a; border: 1px solid #2ecc7133; border-radius: 7px;
  padding: .22rem .45rem; font-weight: 700;
}
.fc-bet label { color: #4a9a4a; }
.fc-bet input {
  width: 66px; background: #071507; border: 1px solid #2ecc7122; border-radius: 5px;
  color: #e2ffe2; font-size: .78rem; font-weight: 700; text-align: right;
  padding: .14rem .3rem; outline: none; font-family: inherit;
}
.fc-bet input:focus { border-color: #2ecc71; }
.fc-spin {
  background: linear-gradient(135deg, #27ae60, #2ecc71);
  color: #060e06; font-weight: 900; font-size: .76rem;
  padding: .26rem .78rem; border-radius: 7px; letter-spacing: .04em;
  box-shadow: 0 2px 10px #2ecc7144; transition: all .18s; white-space: nowrap;
}
.fc-spin:hover:not(:disabled) { box-shadow: 0 4px 16px #2ecc7177; transform: translateY(-1px); }
.fc-spin:disabled { opacity: .4; cursor: not-allowed; }
.fc-user { font-size: .67rem; color: #4a8a4a; white-space: nowrap; max-width: 120px; overflow: hidden; text-overflow: ellipsis; }
.fc-logout { font-size: .64rem; color: #3a6b3a; border-bottom: 1px solid #2ecc7122; white-space: nowrap; }
.fc-logout:hover { color: #2ecc71; }

/* iframe fills everything below the bar */
#gameFrame {
  position: fixed;
  top: 42px; left: 0; right: 0; bottom: 0;
  width: 100%; height: calc(100% - 42px);
  border: none; display: block; background: #040d04;
}

/* result banner */
#fcBanner {
  display: none;
  position: fixed; bottom: 1rem; left: 50%; transform: translateX(-50%);
  z-index: 99999;
  background: #0e230e; border: 2px solid #2ecc7133; border-radius: 10px;
  padding: .55rem 1.1rem; font-weight: 700; font-size: .88rem;
  box-shadow: 0 4px 20px #2ecc7122; pointer-events: none; white-space: nowrap;
}
</style>
</head>
<body>

<!-- FC overlay bar -->
<div id="fcBar">
  <button class="fc-back" onclick="location.href='/lobby'">&#8592; Lobby</button>
  <span class="fc-title">🐟 Fish Slot</span>
  <div class="fc-bal">💰&nbsp;<strong id="fcBalNum">${safeBal.toLocaleString()}</strong>&nbsp;FC</div>
  <div class="fc-bet">
    <label for="fcBetIn">Bet:</label>
    <input id="fcBetIn" type="number" min="1" step="1" value="${safeInitBet}">
    <span style="color:#4a9a4a;font-size:.72rem">FC</span>
  </div>
  <button id="fcSpinBtn" class="fc-spin">🎰 Spin</button>
  <span class="fc-user">${esc(tag)}</span>
  <a href="/logout" class="fc-logout">logout</a>
</div>

<!-- C3 game in iframe so its relative paths (/fishslot/game/) resolve correctly -->
<iframe
  id="gameFrame"
  src="/fishslot/game/"
  allow="autoplay; fullscreen"
  allowfullscreen
></iframe>

<!-- result banner -->
<div id="fcBanner"></div>

<script>
(function () {
  const DISCORD_TOKEN = "${safeToken}";
  let bal      = ${safeBal};
  let spinning = false;

  const balNum  = document.getElementById("fcBalNum");
  const betIn   = document.getElementById("fcBetIn");
  const spinBtn = document.getElementById("fcSpinBtn");
  const banner  = document.getElementById("fcBanner");

  function setBal(n) { bal = Math.max(0, Math.floor(Number(n) || 0)); balNum.textContent = bal.toLocaleString(); }
  function getBet()  { return Math.max(1, Math.floor(Number(betIn.value) || 1)); }

  function setSpin(s) {
    spinning = s;
    spinBtn.disabled = s;
    spinBtn.textContent = s ? "\u23f3 Spinning\u2026" : "\ud83c\udfb0 Spin";
  }

  function showBanner(msg, win) {
    banner.textContent = msg;
    banner.style.borderColor = win ? "#2ecc7188" : "#e74c3c88";
    banner.style.color = win ? "#e2ffe2" : "#ffaaaa";
    banner.style.display = "block";
    clearTimeout(banner._t);
    banner._t = setTimeout(() => { banner.style.display = "none"; }, 5000);
  }

  async function doSpin() {
    if (spinning) return;
    const bet = getBet();
    if (bet < 1)   { showBanner("\u26a0\ufe0f Bet must be at least 1 FC", false); return; }
    if (bet > bal) { showBanner("\u26a0\ufe0f Not enough FC!", false); return; }

    setSpin(true);
    banner.style.display = "none";

    // Step 1: deduct bet immediately
    let spinToken;
    try {
      const r = await fetch("/api/fishslot/spin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bet, discordToken: DISCORD_TOKEN }),
      });
      const d = await r.json();
      if (!r.ok || d.error) { showBanner("\u26a0\ufe0f " + (d.error || "Spin failed"), false); setSpin(false); return; }
      spinToken = d.spinToken;
      setBal(d.newBal);
    } catch { showBanner("\u26a0\ufe0f Network error", false); setSpin(false); return; }

    // Step 2: wait for animation
    await new Promise(r => setTimeout(r, 4500));

    // Step 3: resolve payout
    try {
      const r = await fetch("/api/fishslot/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spinToken, discordToken: DISCORD_TOKEN }),
      });
      const d = await r.json();
      if (!r.ok || d.error) {
        showBanner("\u26a0\ufe0f " + (d.error || "Result error"), false);
      } else {
        setBal(d.newBal);
        const delta = Number(d.delta) || 0;
        if      (delta > 0)  showBanner("\ud83c\udf89 +" + delta.toLocaleString() + " FC \u2014 you won!", true);
        else if (delta === 0) showBanner("\ud83e\udd37 Push \u2014 bet returned.", true);
        else                  showBanner("\ud83d\udcb8 " + Math.abs(delta).toLocaleString() + " FC lost.", false);
      }
    } catch { showBanner("\u26a0\ufe0f Could not save result", false); }
    finally   { setSpin(false); }
  }

  spinBtn.addEventListener("click", doSpin);
  betIn.addEventListener("keydown", e => { if (e.key === "Enter") doSpin(); });

  // Poll balance every 5s
  setInterval(() => {
    if (spinning) return;
    fetch("/api/balance").then(r => r.json()).then(d => { if (d.bal !== undefined) setBal(d.bal); }).catch(() => {});
  }, 5000);

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
    await preloadFishslotAssets();
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

    if (path === "/") return this._redirect(res, "/lobby");

    // ===========================================================================
    // /fishslot/  and  /fishslot/index.html
    //   -> serve our FC wrapper page (overlay bar + iframe)
    //
    // /fishslot/game/  and  /fishslot/game/index.html
    //   -> serve the REAL C3 index.html so all relative paths resolve correctly
    //
    // /fishslot/*  (everything else: scripts, media, images, wasm, sw.js ...)
    //   -> serve from disk
    // ===========================================================================
    if (path === "/fishslot" || path === "/fishslot/" || path === "/fishslot/index.html") {
      // Require login
      const uid = this._uid(req);
      if (!uid) return this._redirect(res, "/login");

      const token   = u.searchParams.get("token");
      const user    = await this.db.getUser(uid);
      const bal     = Number(user?.bal ?? 0);
      const cookies = parseCookies(req);
      const tag     = decodeURIComponent(cookies.dtag ?? "Player");

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

      return this._html(res, 200, fishslotWrapperPage(bal, tag, initBet, token ?? ""));
    }

    // The iframe loads /fishslot/game/ — serve the real C3 index.html here
    if (path === "/fishslot/game" || path === "/fishslot/game/" || path === "/fishslot/game/index.html") {
      const asset = getFishslotAsset("/index.html");
      if (!asset) { res.writeHead(404); return res.end("Game files not found — restart the bot to re-clone."); }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(asset.body);
    }

    // All other /fishslot/* assets (scripts, media, images, wasm, sw.js, etc.)
    if (path.startsWith("/fishslot/")) {
      // Strip /fishslot prefix, map /fishslot/game/scripts/... -> /scripts/...
      let assetPath = path.slice("/fishslot".length);
      // If request comes from inside the /fishslot/game/ iframe, paths may include /game/
      if (assetPath.startsWith("/game/")) assetPath = assetPath.slice("/game".length);
      const asset = getFishslotAsset(assetPath);
      if (!asset) { res.writeHead(404); return res.end("Not found"); }
      res.writeHead(200, {
        "Content-Type":   asset.mime,
        "Cache-Control":  "public, max-age=3600",
        "Content-Length": asset.body.length,
      });
      return res.end(asset.body);
    }

    // /game/fishslot -> redirect to /fishslot/ for clean Discord links
    if (path === "/game/fishslot" || path === "/game/fishslot/") {
      const uid = this._uid(req);
      const qs  = u.search ?? "";
      return this._redirect(res, uid ? `/fishslot/${qs}` : `/login`);
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
    // API: spin
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
    // API: resolve
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
        console.error("[OAuth]", e);
        return this._html(res, 500, errPage("\u26a0\ufe0f Error", "Could not reach Fluxer.", "/login", "Retry"));
      }
      if (!tokenData.access_token)
        return this._html(res, 400, errPage("\u274c Login Failed",
          tokenData.error_description ?? tokenData.message ?? "Unknown error",
          "/login", "Try again"));
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

    // ===========================================================================
    // Logout
    // ===========================================================================
    if (path === "/logout") {
      const uid = this._uid(req);
      if (uid) { const c = parseCookies(req); if (c.sid) await this.db.revokeSession(uid, c.sid).catch(() => {}); }
      res.setHeader("Set-Cookie", [
        "sid=; Path=/; Max-Age=0", "uid=; Path=/; Max-Age=0",
        "dtag=; Path=/; Max-Age=0", "dav=; Path=/; Max-Age=0",
      ]);
      return this._redirect(res, "/login");
    }

    res.writeHead(404); res.end("Not found");
  }

  _uid(req) { const c = parseCookies(req); return (c.sid && c.uid) ? c.uid : null; }
  _html(res, s, b) { res.writeHead(s, { "Content-Type": "text/html;charset=utf-8" }); res.end(b); }
  _json(res, s, o) { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); }
  _redirect(res, l) { res.setHeader("Location", l); res.writeHead(302); res.end(); }
}
