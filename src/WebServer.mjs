import http from "http";
import https from "https";
import { URL } from "url";
import crypto from "crypto";

// ---------------------------------------------------------------------------
// Fluxer OAuth2
// ---------------------------------------------------------------------------
const FLUXER_AUTH_URL  = "https://web.canary.fluxer.app/oauth2/authorize";
const FLUXER_TOKEN_URL = "https://api.fluxer.app/v1/oauth2/token";
const FLUXER_ME_URL    = "https://api.fluxer.app/v1/users/@me";

// ---------------------------------------------------------------------------
// SlotsLaunch
// SL_TOKEN  = your API token
// SL_ORIGIN = your server's public IP / hostname (passed as origin to SL)
// Le Bandit is hardcoded — no catalogue fetch needed.
// ---------------------------------------------------------------------------
const SL_TOKEN  = process.env.SL_TOKEN  ?? "";
const SL_ORIGIN = process.env.SL_ORIGIN ?? "";

const LE_BANDIT = {
  id:       16485,
  name:     "Le Bandit",
  provider: "Hacksaw Gaming",
  // Verified CDN path from slotslaunch.com/launch-pad/games/16485--le-bandit
  thumb:    "https://assets.slotslaunch.com/uploads/games/le-bandit.jpg",
  // Fallback: fetch from their public thumb endpoint
  thumbAlt: `https://slotslaunch.com/storage/games/16485/thumb.jpg`,
};

// SlotsLaunch launch API — returns { url: "https://..." } with the real game URL.
// Docs: https://slotslaunch.com/documentation  →  GET /api/game/launch
async function fetchLaunchUrl(gameId) {
  const endpoint = `https://slotslaunch.com/api/game/launch?token=${encodeURIComponent(SL_TOKEN)}&game_id=${gameId}&origin=${encodeURIComponent(SL_ORIGIN)}`;
  try {
    const raw  = await nodeFetch(endpoint);
    const json = JSON.parse(raw);
    // Response shape: { url: "...", ... }  or  { data: { url: "..." } }
    return json?.url ?? json?.data?.url ?? json?.launch_url ?? null;
  } catch (e) {
    console.error("[SlotsLaunch] launch fetch failed:", e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const idx = part.indexOf("="); if (idx < 0) continue;
    out[decodeURIComponent(part.slice(0, idx).trim())] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function nodeFetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const mod     = parsed.protocol === "https:" ? https : http;
    const body    = opts.body ?? "";
    const headers = { ...(opts.headers ?? {}), "Content-Length": Buffer.byteLength(body) };
    const r = mod.request(
      { hostname: parsed.hostname, port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search, method: opts.method ?? "GET", headers },
      res => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(d)); }
    );
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// SHARED CSS
// ---------------------------------------------------------------------------
const SHARED_CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{-webkit-font-smoothing:antialiased;scroll-behavior:smooth}
body{
  background:#060e06;color:#e2ffe2;
  font-family:'Segoe UI',system-ui,sans-serif;
  min-height:100vh;overflow-x:hidden;
}
a{color:inherit;text-decoration:none}
button{cursor:pointer;background:none;border:none;color:inherit;font:inherit}
input,select{font:inherit;color:inherit}

::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:#0a1a0a}
::-webkit-scrollbar-thumb{background:#2ecc7155;border-radius:99px}
::-webkit-scrollbar-thumb:hover{background:#2ecc71aa}

.nav{
  position:sticky;top:0;z-index:100;
  background:rgba(6,14,6,.92);
  backdrop-filter:blur(12px);
  border-bottom:1px solid #2ecc7122;
  display:flex;align-items:center;gap:1rem;
  padding:.6rem 1.5rem;
}
.nav-logo{
  font-size:1.1rem;font-weight:900;color:#2ecc71;
  text-shadow:0 0 14px #2ecc7188;
  display:flex;align-items:center;gap:.4rem;
  white-space:nowrap;
}
.nav-logo span{font-size:1.3rem}
.nav-spacer{flex:1}
.nav-bal{font-size:.8rem;font-weight:700;color:#a8e6a8;white-space:nowrap}
.nav-bal strong{color:#2ecc71;font-size:.95rem}
.nav-user{display:flex;align-items:center;gap:.5rem;font-size:.8rem;color:#a8d5a8}
.nav-avatar{width:28px;height:28px;border-radius:50%;border:1px solid #2ecc7144;object-fit:cover}
.nav-logout{font-size:.7rem;color:#3a6b3a;border-bottom:1px solid #2ecc7122;cursor:pointer}
.nav-logout:hover{color:#2ecc71}

.ambient{
  position:fixed;inset:0;pointer-events:none;z-index:0;
  background:
    radial-gradient(ellipse 70% 50% at 50% 0%,#0d3b0d33 0%,transparent 70%),
    radial-gradient(ellipse 50% 40% at 10% 90%,#0b2b0b22 0%,transparent 60%);
}

.wrap{position:relative;z-index:1;padding:1.5rem 1.5rem 3rem}

.section-title{
  font-size:1rem;font-weight:900;letter-spacing:.08em;text-transform:uppercase;
  color:#2ecc71;text-shadow:0 0 10px #2ecc7155;
  margin-bottom:1.5rem;display:flex;align-items:center;gap:.5rem;
}

.game-card{
  background:#0a1f0a;
  border:1px solid #2ecc7122;
  border-radius:12px;
  overflow:hidden;
  cursor:pointer;
  transition:transform .18s,box-shadow .18s,border-color .18s;
  position:relative;
  max-width:280px;
}
.game-card:hover{
  transform:translateY(-4px) scale(1.02);
  box-shadow:0 8px 32px #2ecc7133;
  border-color:#2ecc7166;
}
.game-card:active{transform:translateY(-1px) scale(1.01)}
.game-thumb-wrap{width:100%;aspect-ratio:4/3;overflow:hidden;background:#071507;position:relative}
.game-thumb{width:100%;height:100%;object-fit:cover;display:block;transition:transform .3s}
.game-card:hover .game-thumb{transform:scale(1.06)}
.game-thumb-placeholder{
  width:100%;height:100%;
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:.5rem;background:linear-gradient(135deg,#071f07,#0e2e0e);
}
.game-thumb-placeholder svg{opacity:.4}
.game-thumb-placeholder span{font-size:.7rem;color:#2ecc7166;font-weight:700;letter-spacing:.1em;text-transform:uppercase}
.game-play-overlay{
  position:absolute;inset:0;
  background:rgba(6,14,6,.6);
  display:flex;align-items:center;justify-content:center;
  opacity:0;transition:opacity .18s;
}
.game-card:hover .game-play-overlay{opacity:1}
.game-play-btn{
  background:#2ecc71;color:#060e06;
  font-weight:900;font-size:.85rem;
  padding:.45rem 1.1rem;border-radius:8px;
  letter-spacing:.04em;
  box-shadow:0 0 20px #2ecc7188;
}
.game-info{padding:.6rem .7rem .7rem}
.game-name{font-size:.78rem;font-weight:700;color:#c8f5c8;line-height:1.3}
.game-meta{font-size:.65rem;color:#4a9a4a;margin-top:.2rem}

.launch-wrap{
  min-height:60vh;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:1rem;position:relative;z-index:1;
}
.launch-spinner{
  width:52px;height:52px;
  border:3px solid #2ecc7122;
  border-top-color:#2ecc71;
  border-radius:50%;
  animation:spin .8s linear infinite;
}
@keyframes spin{to{transform:rotate(360deg)}}
.launch-txt{font-size:.9rem;color:#4a9a4a}

.login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem;position:relative;z-index:1}
.login-card{
  background:linear-gradient(160deg,#0e230e,#071507);
  border:2px solid #2ecc7133;border-radius:20px;
  padding:2.5rem 2rem;max-width:400px;width:100%;
  text-align:center;
  box-shadow:0 0 60px #2ecc7111,inset 0 1px 0 #2ecc7122;
}
.login-logo{font-size:3.5rem;margin-bottom:.5rem}
.login-title{font-size:2rem;font-weight:900;color:#2ecc71;text-shadow:0 0 20px #2ecc71cc;margin-bottom:.25rem}
.login-sub{font-size:.75rem;letter-spacing:.25em;text-transform:uppercase;color:#4a9a4a;margin-bottom:1.5rem}
.login-desc{font-size:.9rem;color:#a8d5a8;display:block;margin-bottom:1.5rem;line-height:1.6}
.login-btn{
  display:inline-flex;align-items:center;justify-content:center;gap:.6rem;
  background:linear-gradient(135deg,#27ae60,#2ecc71);
  color:#060e06;font-size:1rem;font-weight:900;
  padding:.85rem 2rem;border-radius:12px;letter-spacing:.04em;
  box-shadow:0 4px 20px #2ecc7144;transition:all .18s;width:100%;
}
.login-btn:hover{background:linear-gradient(135deg,#2ecc71,#39d97a);box-shadow:0 6px 30px #2ecc7166;transform:translateY(-1px)}
.login-footer{margin-top:1.5rem;font-size:.7rem;color:#2a4a2a;line-height:1.7}

.err-card{
  background:#0e230e;border:2px solid #2ecc7133;border-radius:16px;
  padding:2rem;max-width:420px;width:100%;text-align:center;
  box-shadow:0 0 40px #2ecc7111;margin:auto;position:relative;z-index:1;
}
.err-card h1{color:#2ecc71;font-size:1.5rem;margin-bottom:1rem}
.err-card p{color:#a8d5a8;margin-bottom:1rem;line-height:1.6}
.err-btn{
  display:inline-flex;align-items:center;justify-content:center;
  background:linear-gradient(135deg,#27ae60,#2ecc71);color:#060e06;
  font-weight:900;text-decoration:none;padding:.75rem 1.5rem;
  border-radius:10px;margin-top:.75rem;border:none;cursor:pointer;
  font-size:.9rem;transition:all .18s;
}
.err-btn:hover{transform:translateY(-1px);box-shadow:0 4px 20px #2ecc7155}

@media(max-width:600px){
  .nav{padding:.5rem 1rem;gap:.6rem}
  .wrap{padding:1rem 1rem 2rem}
}
`;

// Le Bandit SVG banner fallback (shown when thumbnail fails to load)
const LE_BANDIT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 280 210" width="280" height="210">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#071f07"/>
      <stop offset="100%" stop-color="#0e2e0e"/>
    </linearGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#f5d020"/>
      <stop offset="100%" stop-color="#c8a400"/>
    </linearGradient>
  </defs>
  <rect width="280" height="210" fill="url(#bg)"/>
  <!-- decorative dots -->
  <circle cx="30" cy="30" r="2" fill="#2ecc7122"/>
  <circle cx="250" cy="30" r="2" fill="#2ecc7122"/>
  <circle cx="30" cy="180" r="2" fill="#2ecc7122"/>
  <circle cx="250" cy="180" r="2" fill="#2ecc7122"/>
  <!-- slot reels -->
  <rect x="60" y="70" width="40" height="60" rx="6" fill="#0a2a0a" stroke="#2ecc7133" stroke-width="1"/>
  <rect x="120" y="70" width="40" height="60" rx="6" fill="#0a2a0a" stroke="#2ecc7133" stroke-width="1"/>
  <rect x="180" y="70" width="40" height="60" rx="6" fill="#0a2a0a" stroke="#2ecc7133" stroke-width="1"/>
  <!-- 7s -->
  <text x="80" y="113" font-size="32" font-family="serif" font-weight="900" fill="url(#gold)" text-anchor="middle">7</text>
  <text x="140" y="113" font-size="32" font-family="serif" font-weight="900" fill="url(#gold)" text-anchor="middle">7</text>
  <text x="200" y="113" font-size="32" font-family="serif" font-weight="900" fill="url(#gold)" text-anchor="middle">7</text>
  <!-- title -->
  <text x="140" y="165" font-size="13" font-family="'Segoe UI',sans-serif" font-weight="900" fill="#2ecc71" text-anchor="middle" letter-spacing="2">LE BANDIT</text>
  <text x="140" y="180" font-size="8" font-family="'Segoe UI',sans-serif" fill="#2ecc7177" text-anchor="middle" letter-spacing="1">HACKSAW GAMING</text>
</svg>`;

// ---------------------------------------------------------------------------
// PAGE SHELLS
// ---------------------------------------------------------------------------
function shellPage(headExtra, bodyContent) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SirGreen Casino</title>
<style>${SHARED_CSS}</style>
${headExtra ?? ""}
</head>
<body>
<div class="ambient"></div>
${bodyContent}
</body>
</html>`;
}

function navBar(tag, avatar, bal) {
  const av = avatar
    ? `<img class="nav-avatar" src="${esc(avatar)}" alt="${esc(tag)}" loading="lazy">`
    : `<span style="font-size:1.3rem">&#127918;</span>`;
  return `<nav class="nav">
  <div class="nav-logo"><span>&#127918;</span> SirGreen Casino</div>
  <div class="nav-spacer"></div>
  <div class="nav-bal">Balance: <strong>${Number(bal).toLocaleString()} FC</strong></div>
  <div class="nav-user">${av}<span>${esc(tag)}</span></div>
  <a href="/logout" class="nav-logout">logout</a>
</nav>`;
}

// ---------------------------------------------------------------------------
// LOBBY PAGE
// ---------------------------------------------------------------------------
function lobbyPage(bal, tag, avatar) {
  const g = LE_BANDIT;
  // Multi-source thumbnail: try CDN path, then alternate, then inline SVG
  const thumbHtml = `
    <img
      class="game-thumb" id="gameThumb"
      src="${esc(g.thumb)}"
      alt="${esc(g.name)}"
      loading="lazy"
      onerror="
        if(this.dataset.tried!='alt'){
          this.dataset.tried='alt';
          this.src='${esc(g.thumbAlt)}';
        } else {
          this.style.display='none';
          this.parentNode.insertAdjacentHTML('afterbegin',document.getElementById('lbSvg').innerHTML);
        }
      "
    >
    <template id="lbSvg">${LE_BANDIT_SVG.replace(/`/g, "&#96;")}</template>`;

  return shellPage("", `
${navBar(tag, avatar, bal)}
<div class="wrap">
  <div class="section-title">&#127918; Game Lobby</div>
  <div class="game-card" onclick="window.location.href='/launch?game=${g.id}'">
    <div class="game-thumb-wrap">
      ${thumbHtml}
      <div class="game-play-overlay"><div class="game-play-btn">&#9654; Play</div></div>
    </div>
    <div class="game-info">
      <div class="game-name">${esc(g.name)}</div>
      <div class="game-meta">${esc(g.provider)}</div>
    </div>
  </div>
</div>
`);
}

// ---------------------------------------------------------------------------
// LAUNCH PAGE — server-side fetches SL launch URL, redirects browser there
// ---------------------------------------------------------------------------
function launchingPage(gameName) {
  return shellPage("", `
<div class="launch-wrap">
  <div class="launch-spinner"></div>
  <div class="launch-txt">Launching ${esc(gameName)}&#8230;</div>
</div>
`);
}

// ---------------------------------------------------------------------------
// LOGIN PAGE
// ---------------------------------------------------------------------------
function loginPage(authUrl) {
  return shellPage("", `
<div class="login-wrap">
  <div class="login-card">
    <div class="login-logo">&#127918;</div>
    <div class="login-title">SirGreen Casino</div>
    <div class="login-sub">Powered by FluxCoins</div>
    <span class="login-desc">Login with your <strong style="color:#2ecc71">Fluxer</strong> account to play with your FluxCoin balance.</span>
    <a class="login-btn" href="${esc(authUrl)}">&#128994;&nbsp; Login with Fluxer</a>
    <div class="login-footer">Global FluxCoin economy across all Fluxer servers.<br>Play responsibly.</div>
  </div>
</div>
`);
}

function errPage(title, msg, btnHref, btnLabel) {
  return shellPage("", `
<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem;position:relative;z-index:1">
<div class="err-card">
  <h1>${esc(title)}</h1>
  <p>${esc(msg)}</p>
  <a class="err-btn" href="${esc(btnHref ?? "/login")}">${esc(btnLabel ?? "Back to login")}</a>
</div>
</div>
`);
}

// ===========================================================================
// WEB SERVER
// ===========================================================================
export class WebServer {
  constructor(db, config) {
    this.db           = db;
    this.port         = config.webPort             ?? 3420;
    this.clientId     = config.fluxerClientId      ?? config.discordClientId     ?? "";
    this.clientSecret = config.fluxerClientSecret  ?? config.discordClientSecret ?? "";
    const host        = config.webHost && config.webHost !== "0.0.0.0" ? config.webHost : "localhost";
    this.baseUrl      = config.webBaseUrl ?? `http://${host}:${this.port}`;
    this.redirectUri  = `${this.baseUrl}/oauth/callback`;
    this._states      = new Map();
  }

  async start() {
    this._server = http.createServer((req, res) =>
      this._handle(req, res).catch(e => {
        console.error("[Web]", e);
        res.writeHead(500);
        res.end("Internal error");
      })
    );
    this._server.listen(this.port, "0.0.0.0", () =>
      console.log(`[Web] SirGreen Casino running on port ${this.port}`));

    setInterval(() => {
      const cut = Date.now() - 15 * 60 * 1000;
      for (const [s, ts] of this._states) if (ts < cut) this._states.delete(s);
    }, 10 * 60 * 1000);
    setInterval(() => this.db.pruneExpiredSessions?.().catch(() => {}), 60 * 60 * 1000);
  }

  async _handle(req, res) {
    const u    = new URL(req.url, "http://localhost");
    const path = u.pathname;

    if (path === "/") return this._redirect(res, "/lobby");

    // ── LOBBY ──────────────────────────────────────────────────────────────
    if (path === "/lobby" && req.method === "GET") {
      const uid = this._uid(req);
      if (!uid) return this._redirect(res, "/login");
      const user    = await this.db.getUser(uid);
      const cookies = parseCookies(req);
      const bal     = Number(user?.bal ?? 0);
      const tag     = decodeURIComponent(cookies.dtag ?? "Player");
      const avatar  = decodeURIComponent(cookies.dav  ?? "");
      return this._html(res, 200, lobbyPage(bal, tag, avatar));
    }

    // ── LAUNCH — fetches SL launch URL server-side, redirects browser ──────
    if (path === "/launch" && req.method === "GET") {
      const uid = this._uid(req);
      if (!uid) return this._redirect(res, "/login");
      const gameId = parseInt(u.searchParams.get("game") ?? "");
      if (!gameId) return this._redirect(res, "/lobby");

      // Show spinner page while we fetch the launch URL
      const gameInfo = gameId === LE_BANDIT.id ? LE_BANDIT : { name: "Game" };

      if (!SL_TOKEN) {
        return this._html(res, 500, errPage(
          "⚠️ Not Configured",
          "Set the SL_TOKEN environment variable to your SlotsLaunch API token.",
          "/lobby", "← Back"
        ));
      }

      const launchUrl = await fetchLaunchUrl(gameId);
      if (!launchUrl) {
        return this._html(res, 502, errPage(
          "⚠️ Launch Failed",
          "Could not retrieve the game launch URL from SlotsLaunch. Check your SL_TOKEN and SL_ORIGIN.",
          "/lobby", "← Back"
        ));
      }

      // Redirect the browser directly to the real game URL (no iframe needed)
      return this._redirect(res, launchUrl);
    }

    // ── BALANCE API ────────────────────────────────────────────────────────
    if (path === "/api/balance" && req.method === "GET") {
      const uid = this._uid(req);
      if (!uid) return this._json(res, 401, { error: "Not logged in" });
      const user = await this.db.getUser(uid);
      return this._json(res, 200, { bal: Number(user?.bal ?? 0) });
    }

    // ── LOGIN ──────────────────────────────────────────────────────────────
    if (path === "/login" && req.method === "GET") {
      if (!this.clientId) {
        return this._html(res, 500, errPage(
          "⚠️ Not Configured",
          "Add fluxerClientId, fluxerClientSecret, and webBaseUrl to config.json.",
          "#", "—"
        ));
      }
      const state = crypto.randomBytes(16).toString("hex");
      this._states.set(state, Date.now());
      const authUrl = new URL(FLUXER_AUTH_URL);
      authUrl.searchParams.set("client_id",     this.clientId);
      authUrl.searchParams.set("redirect_uri",  this.redirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope",         "identify guilds");
      authUrl.searchParams.set("state",         state);
      return this._html(res, 200, loginPage(authUrl.toString()));
    }

    // ── OAUTH CALLBACK ─────────────────────────────────────────────────────
    if (path === "/oauth/callback" && req.method === "GET") {
      const code  = u.searchParams.get("code");
      const state = u.searchParams.get("state");
      if (!code || !state || !this._states.has(state)) {
        return this._html(res, 400, errPage("❌ Login Failed", "Invalid or expired login state.", "/login", "Try again"));
      }
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
        return this._html(res, 500, errPage("⚠️ Error", "Could not reach Fluxer.", "/login", "Retry"));
      }
      if (!tokenData.access_token) {
        console.error("[OAuth] no access_token:", tokenData);
        return this._html(res, 400, errPage(
          "❌ Login Failed",
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
        return this._html(res, 500, errPage("⚠️ Error", "Could not fetch your Fluxer profile.", "/login", "Retry"));
      }
      const userId = me.id;
      const tag    = me.username ?? me.tag ?? userId;
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

    // ── LOGOUT ─────────────────────────────────────────────────────────────
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

    res.writeHead(404);
    res.end("Not found");
  }

  _uid(req) {
    const c = parseCookies(req);
    return (c.sid && c.uid) ? c.uid : null;
  }

  _html(res, s, b) { res.writeHead(s, { "Content-Type": "text/html;charset=utf-8" }); res.end(b); }
  _json(res, s, o) { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); }
  _redirect(res, l) { res.setHeader("Location", l); res.writeHead(302); res.end(); }
}
