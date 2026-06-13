import http from "http";
import { URL } from "url";
import crypto from "crypto";
import https from "https";
import zlib from "zlib";
import { pendingSessions } from "../commands/fishslot.mjs";
import { preloadFishslotAssets, getFishslotAsset, mimeOf } from "./FishslotAssets.mjs";

// ---------------------------------------------------------------------------
// Fluxer OAuth2
// ---------------------------------------------------------------------------
const FLUXER_AUTH_URL  = "https://web.canary.fluxer.app/oauth2/authorize";
const FLUXER_TOKEN_URL = "https://api.fluxer.app/v1/oauth2/token";
const FLUXER_ME_URL    = "https://api.fluxer.app/v1/users/@me";

// ---------------------------------------------------------------------------
// Low-level fetch helper
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
        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
          return resolve(rawFetch(new URL(res.headers.location, url).toString(), opts, maxRedirects - 1));
        }
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
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
// Shared CSS
// ---------------------------------------------------------------------------
const SHARED_CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{-webkit-font-smoothing:antialiased;scroll-behavior:smooth}
body{background:#060e06;color:#e2ffe2;font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;overflow-x:hidden}
a{color:inherit;text-decoration:none}
button{cursor:pointer;background:none;border:none;color:inherit;font:inherit}
::-webkit-scrollbar{width:6px}
::-webkit-scrollbar-track{background:#0a1a0a}
::-webkit-scrollbar-thumb{background:#2ecc7155;border-radius:99px}
::-webkit-scrollbar-thumb:hover{background:#2ecc71aa}
.nav{position:sticky;top:0;z-index:100;background:rgba(6,14,6,.92);backdrop-filter:blur(12px);border-bottom:1px solid #2ecc7122;display:flex;align-items:center;gap:1rem;padding:.6rem 1.5rem}
.nav-logo{font-size:1.1rem;font-weight:900;color:#2ecc71;display:flex;align-items:center;gap:.4rem;white-space:nowrap}
.nav-spacer{flex:1}
.nav-bal{font-size:.8rem;font-weight:700;color:#a8e6a8;white-space:nowrap}
.nav-bal strong{color:#2ecc71;font-size:.95rem}
.nav-user{display:flex;align-items:center;gap:.5rem;font-size:.8rem;color:#a8d5a8}
.nav-avatar{width:28px;height:28px;border-radius:50%;border:1px solid #2ecc7144;object-fit:cover}
.nav-logout{font-size:.7rem;color:#3a6b3a;border-bottom:1px solid #2ecc7122;cursor:pointer}
.nav-logout:hover{color:#2ecc71}
.ambient{position:fixed;inset:0;pointer-events:none;z-index:0;background:radial-gradient(ellipse 70% 50% at 50% 0%,#0d3b0d33 0%,transparent 70%)}
.wrap{position:relative;z-index:1;padding:1.5rem 1.5rem 3rem}
.section-title{font-size:1rem;font-weight:900;letter-spacing:.08em;text-transform:uppercase;color:#2ecc71;text-shadow:0 0 10px #2ecc7155;margin-bottom:1.5rem;display:flex;align-items:center;gap:.5rem}
.games-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:1rem;max-width:960px}
.game-card{background:#0a1f0a;border:1px solid #2ecc7122;border-radius:12px;overflow:hidden;cursor:pointer;transition:transform .18s,box-shadow .18s,border-color .18s}
.game-card:hover{transform:translateY(-4px) scale(1.02);box-shadow:0 8px 32px #2ecc7133;border-color:#2ecc7166}
.game-card:active{transform:translateY(-1px) scale(1.01)}
.game-thumb-wrap{width:100%;aspect-ratio:4/3;overflow:hidden;background:#071507;position:relative}
.game-thumb{width:100%;height:100%;object-fit:cover;display:block;transition:transform .3s}
.game-card:hover .game-thumb{transform:scale(1.06)}
.game-play-overlay{position:absolute;inset:0;background:rgba(6,14,6,.6);display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .18s}
.game-card:hover .game-play-overlay{opacity:1}
.game-play-btn{background:#2ecc71;color:#060e06;font-weight:900;font-size:.85rem;padding:.45rem 1.1rem;border-radius:8px;letter-spacing:.04em;box-shadow:0 0 20px #2ecc7188}
.game-info{padding:.6rem .7rem .7rem}
.game-name{font-size:.78rem;font-weight:700;color:#c8f5c8}
.game-meta{font-size:.65rem;color:#4a9a4a;margin-top:.2rem}
.login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem;position:relative;z-index:1}
.login-card{background:linear-gradient(160deg,#0e230e,#071507);border:2px solid #2ecc7133;border-radius:20px;padding:2.5rem 2rem;max-width:400px;width:100%;text-align:center;box-shadow:0 0 60px #2ecc7111,inset 0 1px 0 #2ecc7122}
.login-logo{font-size:3.5rem;margin-bottom:.5rem}
.login-title{font-size:2rem;font-weight:900;color:#2ecc71;text-shadow:0 0 20px #2ecc71cc;margin-bottom:.25rem}
.login-sub{font-size:.75rem;letter-spacing:.25em;text-transform:uppercase;color:#4a9a4a;margin-bottom:1.5rem}
.login-desc{font-size:.9rem;color:#a8d5a8;display:block;margin-bottom:1.5rem;line-height:1.6}
.login-btn{display:inline-flex;align-items:center;justify-content:center;gap:.6rem;background:linear-gradient(135deg,#27ae60,#2ecc71);color:#060e06;font-size:1rem;font-weight:900;padding:.85rem 2rem;border-radius:12px;letter-spacing:.04em;box-shadow:0 4px 20px #2ecc7144;transition:all .18s;width:100%}
.login-btn:hover{background:linear-gradient(135deg,#2ecc71,#39d97a);box-shadow:0 6px 30px #2ecc7166;transform:translateY(-1px)}
.login-footer{margin-top:1.5rem;font-size:.7rem;color:#2a4a2a;line-height:1.7}
.err-card{background:#0e230e;border:2px solid #2ecc7133;border-radius:16px;padding:2rem;max-width:420px;width:100%;text-align:center;box-shadow:0 0 40px #2ecc7111;margin:auto;position:relative;z-index:1}
.err-card h1{color:#2ecc71;font-size:1.5rem;margin-bottom:1rem}
.err-card p{color:#a8d5a8;margin-bottom:1rem;line-height:1.6}
.err-btn{display:inline-flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#27ae60,#2ecc71);color:#060e06;font-weight:900;text-decoration:none;padding:.75rem 1.5rem;border-radius:10px;margin-top:.75rem;border:none;cursor:pointer;font-size:.9rem;transition:all .18s}
.err-btn:hover{transform:translateY(-1px);box-shadow:0 4px 20px #2ecc7155}
.play-layout{display:flex;flex-direction:column;height:100vh;overflow:hidden}
.viewer-header{display:flex;align-items:center;gap:.75rem;padding:.5rem 1rem;background:rgba(6,14,6,.97);border-bottom:1px solid #2ecc7122;flex-wrap:wrap;flex-shrink:0}
.viewer-back{background:#0a1f0a;border:1px solid #2ecc7133;color:#a8e6a8;padding:.35rem .8rem;border-radius:7px;font-size:.78rem;font-weight:700;transition:all .18s}
.viewer-back:hover{border-color:#2ecc71;color:#2ecc71}
.viewer-title{font-size:.9rem;font-weight:900;color:#e2ffe2}
.viewer-provider{font-size:.7rem;color:#4a9a4a}
.play-top{flex:1;position:relative;min-height:0}
.game-frame{width:100%;height:100%;border:none;display:block;background:#040d04}
.frame-loading{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#040d04;gap:1rem;z-index:10;transition:opacity .3s}
.frame-loading.hidden{opacity:0;pointer-events:none}
.frame-spinner{width:48px;height:48px;border:3px solid #2ecc7122;border-top-color:#2ecc71;border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.frame-loading-txt{font-size:.85rem;color:#4a9a4a}
@media(max-width:600px){.nav{padding:.5rem 1rem;gap:.6rem}.wrap{padding:1rem 1rem 2rem}}
`;

// ---------------------------------------------------------------------------
// Page builders
// ---------------------------------------------------------------------------
function shellPage(headExtra, bodyContent) {
  return `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>SirGreen Casino</title>\n<style>${SHARED_CSS}</style>\n${headExtra ?? ""}\n</head>\n<body>\n<div class="ambient"></div>\n${bodyContent}\n</body>\n</html>`;
}

function navBar(tag, avatar, bal) {
  const av = avatar
    ? `<img class="nav-avatar" src="${esc(avatar)}" alt="${esc(tag)}" loading="lazy">`
    : `<span style="font-size:1.3rem">🐟</span>`;
  return `<nav class="nav"><div class="nav-logo"><span>🐟</span> SirGreen Casino</div><div class="nav-spacer"></div><div class="nav-bal" id="navBal">Balance: <strong>${Number(bal).toLocaleString()} FC</strong></div><div class="nav-user">${av}<span>${esc(tag)}</span></div><a href="/logout" class="nav-logout">logout</a></nav>`;
}

function lobbyPage(bal, tag, avatar) {
  const card = `
    <div class="game-card" onclick="window.location.href='/game/fishslot'">
      <div class="game-thumb-wrap">
        <div style="width:100%;height:100%;background:linear-gradient(135deg,#071507,#0d2b0d);display:flex;align-items:center;justify-content:center;font-size:4rem">🐟</div>
        <div class="game-play-overlay"><div class="game-play-btn">&#9654; Play</div></div>
      </div>
      <div class="game-info">
        <div class="game-name">🐟 Fish Slot</div>
        <div class="game-meta">vermingov</div>
      </div>
    </div>`;

  return shellPage("", `
${navBar(tag, avatar, bal)}
<div class="wrap">
  <div class="section-title">🐟 Game Lobby</div>
  <div class="games-grid">${card}</div>
</div>`);
}

// ---------------------------------------------------------------------------
// Fish Slot game page
// The fishslot PWA is hosted on THIS server under /fishslot/
// The iframe src includes balance & bet as URL params so the bridge can init
// even before the postMessage fires (handles slow-loading frames).
// ---------------------------------------------------------------------------
function fishslotPage(bal, tag, avatar, token, bet) {
  const safeToken = esc(token);
  const safeBet   = Number(bet)   || 0;
  const safeBal   = Number(bal)   || 0;

  // The iframe src passes balance + bet so fluxer-bridge.js can read them
  // from URLSearchParams before the parent postMessage arrives.
  const iframeSrc = `/fishslot/?balance=${safeBal}&bet=${safeBet}`;

  return shellPage("", `
<div class="play-layout">
  <div class="viewer-header">
    <button class="viewer-back" onclick="history.back()">&#8592; Lobby</button>
    <div style="flex:1;min-width:0">
      <div class="viewer-title">🐟 Fish Slot</div>
      <div class="viewer-provider">vermingov · Bet: <strong>${safeBet.toLocaleString()} FC</strong></div>
    </div>
    <div class="nav-bal" id="navBal" style="font-size:.8rem">Balance: <strong id="balNum">${safeBal.toLocaleString()}</strong> FC</div>
    <a href="/logout" style="font-size:.7rem;color:#3a6b3a;border-bottom:1px solid #2ecc7122">logout</a>
  </div>
  <div class="play-top">
    <div class="frame-loading" id="frameLoading">
      <div class="frame-spinner"></div>
      <div class="frame-loading-txt">Loading Fish Slot&#8230;</div>
    </div>
    <iframe
      id="gameFrame"
      class="game-frame"
      src="${iframeSrc}"
      allowfullscreen
      allow="autoplay; fullscreen"
    ></iframe>
  </div>
</div>
<div id="resultBanner" style="display:none;position:fixed;bottom:1.5rem;left:50%;transform:translateX(-50%);background:#0e230e;border:2px solid #2ecc7133;border-radius:12px;padding:.75rem 1.5rem;color:#e2ffe2;font-weight:700;font-size:.95rem;z-index:9999;box-shadow:0 4px 24px #2ecc7133"></div>
<script>
(function(){
  const TOKEN = "${safeToken}";
  const BET   = ${safeBet};
  const BAL   = ${safeBal};
  const frame  = document.getElementById("gameFrame");
  const loader = document.getElementById("frameLoading");
  const banner = document.getElementById("resultBanner");
  const balNum = document.getElementById("balNum");
  let settled = false;

  frame.addEventListener("load", function() {
    loader.classList.add("hidden");
    // Also send via postMessage as a belt-and-suspenders approach
    try {
      frame.contentWindow.postMessage(
        { type: "fluxer:init", balance: BAL, bet: BET },
        window.location.origin
      );
    } catch(e) { console.warn("postMessage failed", e); }
  });

  // Safety: hide loader after 12s regardless
  setTimeout(function(){ loader.classList.add("hidden"); }, 12000);

  // Listen for the game to report its final balance after each spin
  // fluxer-bridge.js posts: { type: "fluxer:result", won: <final FC balance>, lost: bet }
  // won = absolute remaining balance in the game, not delta
  // We persist it to the DB as the authoritative final balance.
  window.addEventListener("message", function(e) {
    if (e.source !== frame.contentWindow) return;
    const d = e.data;
    if (!d || d.type !== "fluxer:result") return;
    if (settled) return;
    settled = true;

    // won = the game's final balance (absolute FC), not a payout delta.
    // The result endpoint will compute delta = won - originalBal internally.
    const finalBal = Math.max(0, Math.floor(Number(d.won) || 0));
    const body = JSON.stringify({ token: TOKEN, won: finalBal, bet: BET, originalBal: BAL });
    fetch("/api/fishslot/result", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    })
    .then(r => r.json())
    .then(res => {
      if (res.newBal !== undefined) {
        balNum.textContent = Number(res.newBal).toLocaleString();
      }
      const delta = res.delta ?? 0;
      banner.textContent = delta >= 0
        ? "\u2705 +" + Math.abs(delta).toLocaleString() + " FC saved!"
        : "\u274c -" + Math.abs(delta).toLocaleString() + " FC saved.";
      banner.style.display = "block";
      banner.style.borderColor = delta >= 0 ? "#2ecc7188" : "#e74c3c88";
      setTimeout(() => { banner.style.display = "none"; settled = false; }, 6000);
    })
    .catch(() => {
      banner.textContent = "\u26a0\ufe0f Could not save result \u2014 please contact an admin.";
      banner.style.display = "block";
      setTimeout(() => { banner.style.display = "none"; settled = false; }, 6000);
    });
  });
})();
</script>`);
}

function loginPage(authUrl) {
  return shellPage("", `
<div class="login-wrap">
  <div class="login-card">
    <div class="login-logo">🐟</div>
    <div class="login-title">SirGreen Casino</div>
    <div class="login-sub">Powered by FluxCoins</div>
    <span class="login-desc">Login with your <strong style="color:#2ecc71">Fluxer</strong> account to play Fish Slot with your FluxCoin balance.</span>
    <a class="login-btn" href="${esc(authUrl)}">&#128994;&nbsp; Login with Fluxer</a>
    <div class="login-footer">Global FluxCoin economy across all Fluxer servers.<br>Play responsibly.</div>
  </div>
</div>`);
}

function errPage(title, msg, btnHref, btnLabel) {
  return shellPage("", `
<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem;position:relative;z-index:1">
<div class="err-card"><h1>${esc(title)}</h1><p>${esc(msg)}</p><a class="err-btn" href="${esc(btnHref ?? "/login")}">${esc(btnLabel ?? "Back to login")}</a></div>
</div>`);
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
  }

  async _handle(req, res) {
    const u    = new URL(req.url, "http://localhost");
    const path = u.pathname;

    if (path === "/") return this._redirect(res, "/lobby");

    // ── FISHSLOT STATIC FILES ─────────────────────────────────────────────────
    if (path === "/fishslot" || path.startsWith("/fishslot/")) {
      let assetPath = path.slice("/fishslot".length) || "/";
      if (assetPath === "/" || assetPath === "") assetPath = "/index.html";
      const asset = getFishslotAsset(assetPath);
      if (!asset) {
        res.writeHead(404);
        return res.end("Not found");
      }
      res.writeHead(200, {
        "Content-Type":   asset.mime,
        "Cache-Control":  "public, max-age=3600",
        "Content-Length": asset.body.length,
      });
      return res.end(asset.body);
    }

    // ── LOBBY ────────────────────────────────────────────────────────────────
    if (path === "/lobby" && req.method === "GET") {
      const uid = this._uid(req);
      if (!uid) return this._redirect(res, "/login");
      const user    = await this.db.getUser(uid);
      const cookies = parseCookies(req);
      return this._html(res, 200, lobbyPage(
        Number(user?.bal ?? 0),
        decodeURIComponent(cookies.dtag ?? "Player"),
        decodeURIComponent(cookies.dav  ?? "")
      ));
    }

    // ── GAME VIEWER ──────────────────────────────────────────────────────────
    if (path === "/game/fishslot" && req.method === "GET") {
      const uid = this._uid(req);
      if (!uid) return this._redirect(res, "/login");

      const token = u.searchParams.get("token");
      const bet   = parseInt(u.searchParams.get("bet") ?? "0");
      const user  = await this.db.getUser(uid);
      const bal   = Number(user?.bal ?? 0);
      const cookies = parseCookies(req);
      const tag   = decodeURIComponent(cookies.dtag ?? "Player");
      const avatar = decodeURIComponent(cookies.dav  ?? "");

      if (token && pendingSessions.has(token)) {
        const sess = pendingSessions.get(token);
        if (sess.uid !== uid) {
          return this._html(res, 403, errPage(
            "\u26d4 Wrong Account",
            "This game link belongs to a different Fluxer account. Log out and switch accounts.",
            "/login", "Switch account"
          ));
        }
        return this._html(res, 200, fishslotPage(bal, tag, avatar, token, sess.bet));
      }

      // Direct lobby access — show game without a pending bet session
      return this._html(res, 200, fishslotPage(bal, tag, avatar, "", 0));
    }

    // ── FISHSLOT RESULT CALLBACK ─────────────────────────────────────────────
    // Called by the parent page's JS after each spin round.
    // Body: { token, won: <absolute final balance in game>, bet, originalBal }
    // Strategy:
    //   - The game tracks its internal balance starting from the FC balance we
    //     injected.  After each spin, fluxer-bridge.js reports the final balance.
    //   - delta = won - originalBal (net change from session start)
    //   - We SET the user's DB balance to originalBal + delta = won.
    //   - This is atomic: we always authorise from the DB value, not increment.
    if (path === "/api/fishslot/result" && req.method === "POST") {
      const uid = this._uid(req);
      if (!uid) return this._json(res, 401, { error: "Not logged in" });

      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return this._json(res, 400, { error: "Bad JSON" }); }

      const { token, won, bet, originalBal } = body;

      // Resolve the session (if any)
      let sess = null;
      if (token && pendingSessions.has(token)) {
        sess = pendingSessions.get(token);
        if (sess.uid !== uid) return this._json(res, 403, { error: "Token mismatch" });
        pendingSessions.delete(token);
      }

      // Authoritative original balance
      const user       = await this.db.getUser(uid);
      const dbBal      = Number(user?.bal ?? 0);
      // Use the balance we passed into the game page as the reference point.
      // If originalBal matches dbBal (no concurrent changes), this is exact.
      const ref        = Number(originalBal ?? sess?.bet ? dbBal : dbBal);
      const finalBal   = Math.max(0, Math.floor(Number(won) || 0));

      // Cap winnings — final balance cannot exceed original + (10× session bet)
      // as a basic sanity/anti-cheat guard.
      const sessionBet = Number(bet ?? sess?.bet ?? 0);
      const cap        = dbBal + sessionBet * 10;
      const safeFinal  = Math.min(finalBal, cap);

      // Compute delta relative to what the DB currently holds
      const delta = safeFinal - dbBal;

      // Apply the balance change
      if (delta !== 0) {
        await this.db.updateBalance(uid, delta);
      }

      // Record the game result
      const won_net = safeFinal - dbBal;  // same as delta before update
      await this.db.recordGame(uid, won_net >= 0, sessionBet);

      const updated = await this.db.getUser(uid);
      const newBal  = Number(updated?.bal ?? 0);

      return this._json(res, 200, { ok: true, delta, newBal });
    }

    // ── BALANCE API ───────────────────────────────────────────────────────────
    if (path === "/api/balance" && req.method === "GET") {
      const uid = this._uid(req);
      if (!uid) return this._json(res, 401, { error: "Not logged in" });
      const user = await this.db.getUser(uid);
      return this._json(res, 200, { bal: Number(user?.bal ?? 0) });
    }

    // ── LOGIN ─────────────────────────────────────────────────────────────────
    if (path === "/login" && req.method === "GET") {
      if (!this.clientId) {
        return this._html(res, 500, errPage(
          "\u26a0\ufe0f Not Configured",
          "Add fluxerClientId, fluxerClientSecret, and webBaseUrl to config.json.",
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

    // ── OAUTH CALLBACK ────────────────────────────────────────────────────────
    if (path === "/oauth/callback" && req.method === "GET") {
      const code  = u.searchParams.get("code");
      const state = u.searchParams.get("state");
      if (!code || !state || !this._states.has(state)) {
        return this._html(res, 400, errPage("\u274c Login Failed", "Invalid or expired login state.", "/login", "Try again"));
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
        return this._html(res, 500, errPage("\u26a0\ufe0f Error", "Could not reach Fluxer.", "/login", "Retry"));
      }
      if (!tokenData.access_token) {
        console.error("[OAuth] no access_token:", tokenData);
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
        return this._html(res, 500, errPage("\u26a0\ufe0f Error", "Could not fetch your Fluxer profile.", "/login", "Retry"));
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

    // ── LOGOUT ────────────────────────────────────────────────────────────────
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
