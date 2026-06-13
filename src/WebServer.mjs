import http from "http";
import { URL } from "url";
import crypto from "crypto";
import https from "https";
import zlib from "zlib";
import { pendingSessions } from "../commands/fishslot.mjs";
import { preloadFishslotAssets, getFishslotAsset } from "./FishslotAssets.mjs";

// ---------------------------------------------------------------------------
// Fluxer OAuth2
// ---------------------------------------------------------------------------
const FLUXER_AUTH_URL  = "https://web.canary.fluxer.app/oauth2/authorize";
const FLUXER_TOKEN_URL = "https://api.fluxer.app/v1/oauth2/token";
const FLUXER_ME_URL    = "https://api.fluxer.app/v1/users/@me";

// ---------------------------------------------------------------------------
// In-memory spin sessions
// token -> { uid, bet, dbBalBefore, ts }
// ---------------------------------------------------------------------------
const spinSessions = new Map();

setInterval(() => {
  const cut = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of spinSessions) if (v.ts < cut) spinSessions.delete(k);
}, 5 * 60 * 1000);

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
// Fish Slot wrapper page
//
// Architecture:
//   - The fishslot C3 game runs inside an <iframe> and is NEVER modified.
//     Its internal balance display is irrelevant — we ignore it entirely.
//   - An overlay DIV sits above the iframe and owns the REAL FC balance UI.
//   - The overlay intercepts pointer events that land on the spin button area.
//     It does NOT try to inject anything into the C3 runtime.
//   - Bet controls, balance display, and all FC logic live in the overlay.
//   - Each spin: POST /api/fishslot/spin -> server deducts bet, returns spinToken
//     After spin animation: POST /api/fishslot/resolve -> server applies payout
//   - Balance is polled every 4 s from /api/balance so it always reflects DB truth.
// ---------------------------------------------------------------------------
function fishslotPage(bal, tag, avatar, discordToken, initBet) {
  const safeBal     = Number(bal)   || 0;
  const safeInitBet = Number(initBet) || 10;
  const safeToken   = esc(discordToken ?? "");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fish Slot — SirGreen Casino</title>
<style>
${SHARED_CSS}
html, body { height: 100%; overflow: hidden; }
.fs-layout {
  display: flex;
  flex-direction: column;
  height: 100vh;
}
/* ── top bar ── */
.fs-bar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: .75rem;
  padding: .45rem 1rem;
  background: rgba(6,14,6,.97);
  border-bottom: 1px solid #2ecc7122;
  flex-wrap: wrap;
  z-index: 200;
}
.fs-back {
  background: #0a1f0a;
  border: 1px solid #2ecc7133;
  color: #a8e6a8;
  padding: .3rem .75rem;
  border-radius: 7px;
  font-size: .75rem;
  font-weight: 700;
  transition: all .18s;
}
.fs-back:hover { border-color: #2ecc71; color: #2ecc71; }
.fs-title { font-size: .9rem; font-weight: 900; color: #e2ffe2; flex: 1; min-width: 0; }
.fs-balance-wrap {
  display: flex;
  align-items: center;
  gap: .4rem;
  background: #0a1f0a;
  border: 1px solid #2ecc7133;
  border-radius: 8px;
  padding: .3rem .7rem;
  font-size: .8rem;
  font-weight: 700;
  color: #a8e6a8;
}
.fs-balance-wrap strong { color: #2ecc71; font-size: .95rem; }
.fs-bet-wrap {
  display: flex;
  align-items: center;
  gap: .35rem;
  background: #0a1f0a;
  border: 1px solid #2ecc7133;
  border-radius: 8px;
  padding: .3rem .6rem;
  font-size: .78rem;
  font-weight: 700;
}
.fs-bet-wrap label { color: #4a9a4a; }
.fs-bet-input {
  width: 72px;
  background: #071507;
  border: 1px solid #2ecc7122;
  border-radius: 5px;
  color: #e2ffe2;
  font-size: .8rem;
  font-weight: 700;
  text-align: right;
  padding: .2rem .4rem;
  outline: none;
}
.fs-bet-input:focus { border-color: #2ecc71; }
.fs-spin-btn {
  background: linear-gradient(135deg, #27ae60, #2ecc71);
  color: #060e06;
  font-weight: 900;
  font-size: .82rem;
  padding: .35rem .9rem;
  border-radius: 8px;
  letter-spacing: .04em;
  box-shadow: 0 2px 12px #2ecc7155;
  transition: all .18s;
  white-space: nowrap;
}
.fs-spin-btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 4px 18px #2ecc7188; }
.fs-spin-btn:disabled { opacity: .45; cursor: not-allowed; }
/* ── game area ── */
.fs-game-area {
  flex: 1;
  position: relative;
  min-height: 0;
  background: #040d04;
}
.fs-iframe {
  width: 100%;
  height: 100%;
  border: none;
  display: block;
}
/* ── result banner ── */
.fs-banner {
  display: none;
  position: fixed;
  bottom: 1.4rem;
  left: 50%;
  transform: translateX(-50%);
  background: #0e230e;
  border: 2px solid #2ecc7133;
  border-radius: 12px;
  padding: .7rem 1.4rem;
  font-weight: 700;
  font-size: .95rem;
  z-index: 9999;
  box-shadow: 0 4px 24px #2ecc7133;
  white-space: nowrap;
  pointer-events: none;
  transition: opacity .3s;
}
/* ── spinner overlay (while resolving) ── */
.fs-resolving {
  display: none;
  position: absolute;
  inset: 0;
  background: rgba(4,13,4,.55);
  z-index: 50;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: .75rem;
  pointer-events: all;
}
.fs-resolving.active { display: flex; }
.fs-spinner {
  width: 40px; height: 40px;
  border: 3px solid #2ecc7122;
  border-top-color: #2ecc71;
  border-radius: 50%;
  animation: spin .7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.fs-resolving-txt { font-size: .8rem; color: #4a9a4a; }
/* ── loading overlay ── */
.fs-loading {
  position: absolute;
  inset: 0;
  background: #040d04;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  z-index: 40;
  transition: opacity .4s;
}
.fs-loading.hidden { opacity: 0; pointer-events: none; }
.fs-loading-spinner {
  width: 48px; height: 48px;
  border: 3px solid #2ecc7122;
  border-top-color: #2ecc71;
  border-radius: 50%;
  animation: spin .8s linear infinite;
}
.fs-loading-txt { font-size: .85rem; color: #4a9a4a; }
</style>
</head>
<body>
<div class="fs-layout">

  <!-- ── Top control bar ── -->
  <div class="fs-bar">
    <button class="fs-back" onclick="history.back()">&#8592; Lobby</button>
    <div class="fs-title">🐟 Fish Slot</div>

    <div class="fs-balance-wrap">
      💰 <span id="balLabel">Balance:</span>&nbsp;<strong id="balNum">${safeBal.toLocaleString()}</strong>&nbsp;FC
    </div>

    <div class="fs-bet-wrap">
      <label for="betInput">Bet:</label>
      <input id="betInput" class="fs-bet-input" type="number" min="1" step="1" value="${safeInitBet}">
      <span style="color:#4a9a4a;font-size:.75rem">FC</span>
    </div>

    <button id="spinBtn" class="fs-spin-btn">🎰 Spin</button>

    <a href="/logout" style="font-size:.68rem;color:#3a6b3a;border-bottom:1px solid #2ecc7122;white-space:nowrap">logout</a>
  </div>

  <!-- ── Game canvas area ── -->
  <div class="fs-game-area">
    <!-- Loading overlay -->
    <div class="fs-loading" id="fsLoading">
      <div class="fs-loading-spinner"></div>
      <div class="fs-loading-txt">Loading Fish Slot&#8230;</div>
    </div>

    <!-- Resolving overlay (shown while waiting for spin result) -->
    <div class="fs-resolving" id="fsResolving">
      <div class="fs-spinner"></div>
      <div class="fs-resolving-txt">Saving result&#8230;</div>
    </div>

    <!-- The unmodified C3 game. We do NOT touch its internals. -->
    <iframe
      id="gameFrame"
      class="fs-iframe"
      src="/fishslot/"
      allowfullscreen
      allow="autoplay; fullscreen"
    ></iframe>
  </div>
</div>

<!-- Result banner -->
<div id="fsBanner" class="fs-banner"></div>

<script>
(function () {
  // ── State ──────────────────────────────────────────────────────────────────
  const DISCORD_TOKEN = "${safeToken}";
  let currentBal   = ${safeBal};
  let spinning     = false;    // true while a spin is in-flight
  let pendingSpinToken = null; // set by /api/fishslot/spin, cleared by resolve

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const balNum     = document.getElementById("balNum");
  const betInput   = document.getElementById("betInput");
  const spinBtn    = document.getElementById("spinBtn");
  const fsLoading  = document.getElementById("fsLoading");
  const fsResolving = document.getElementById("fsResolving");
  const fsBanner   = document.getElementById("fsBanner");
  const gameFrame  = document.getElementById("gameFrame");

  // ── Helpers ────────────────────────────────────────────────────────────────
  function setBalance(n) {
    currentBal = Math.max(0, Math.floor(Number(n) || 0));
    balNum.textContent = currentBal.toLocaleString();
  }

  function getBet() {
    return Math.max(1, Math.floor(Number(betInput.value) || 1));
  }

  function setSpinning(s) {
    spinning = s;
    spinBtn.disabled = s;
    spinBtn.textContent = s ? "⏳ Spinning…" : "🎰 Spin";
  }

  function showBanner(msg, win) {
    fsBanner.textContent = msg;
    fsBanner.style.display = "block";
    fsBanner.style.borderColor = win ? "#2ecc7188" : "#e74c3c88";
    fsBanner.style.color = win ? "#e2ffe2" : "#ffcccc";
    clearTimeout(fsBanner._t);
    fsBanner._t = setTimeout(() => { fsBanner.style.display = "none"; }, 5500);
  }

  // ── Hide loading overlay once iframe loads ─────────────────────────────────
  gameFrame.addEventListener("load", () => {
    setTimeout(() => fsLoading.classList.add("hidden"), 800);
  });
  setTimeout(() => fsLoading.classList.add("hidden"), 14000);

  // ── Spin handler ───────────────────────────────────────────────────────────
  // 1. POST /api/fishslot/spin  → server deducts bet from DB immediately,
  //    returns { spinToken, newBal } or { error }.
  // 2. We update the overlay balance and let the C3 game play its animation.
  // 3. After SPIN_WAIT ms (animation duration), POST /api/fishslot/resolve
  //    → server applies RNG payout, returns { delta, newBal }.
  // 4. Update overlay balance and show result banner.
  //
  // The C3 game's internal balance display is completely irrelevant.
  // Players interact with the C3 game visually, but ALL money logic is ours.

  const SPIN_WAIT = 4500; // ms — conservative slot animation duration

  async function doSpin() {
    if (spinning) return;
    const bet = getBet();

    if (bet < 1) { showBanner("⚠️ Bet must be at least 1 FC", false); return; }
    if (bet > currentBal) { showBanner("⚠️ Not enough FC!", false); return; }

    setSpinning(true);
    fsBanner.style.display = "none";

    // Step 1: deduct bet server-side
    let spinToken;
    try {
      const r = await fetch("/api/fishslot/spin", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ bet, discordToken: DISCORD_TOKEN }),
      });
      const d = await r.json();
      if (!r.ok || d.error) {
        showBanner("⚠️ " + (d.error || "Spin failed"), false);
        setSpinning(false);
        return;
      }
      spinToken      = d.spinToken;
      pendingSpinToken = spinToken;
      setBalance(d.newBal); // balance after deduction
    } catch (e) {
      showBanner("⚠️ Network error — spin not placed.", false);
      setSpinning(false);
      return;
    }

    // Step 2: wait for animation
    await new Promise(r => setTimeout(r, SPIN_WAIT));

    // Step 3: resolve payout
    fsResolving.classList.add("active");
    try {
      const r = await fetch("/api/fishslot/resolve", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ spinToken }),
      });
      const d = await r.json();
      if (!r.ok || d.error) {
        showBanner("⚠️ " + (d.error || "Could not save result"), false);
      } else {
        setBalance(d.newBal);
        const delta = Number(d.delta) || 0;
        if (delta > 0) {
          showBanner("🎉 +" + delta.toLocaleString() + " FC — you won!", true);
        } else {
          showBanner("💸 Spin complete · " + Math.abs(delta).toLocaleString() + " FC lost.", false);
        }
      }
    } catch {
      showBanner("⚠️ Could not save result — contact admin.", false);
    } finally {
      pendingSpinToken = null;
      fsResolving.classList.remove("active");
      setSpinning(false);
    }
  }

  spinBtn.addEventListener("click", doSpin);

  // Allow Enter in bet input to trigger spin
  betInput.addEventListener("keydown", e => { if (e.key === "Enter") doSpin(); });

  // ── Periodic balance sync (every 5 s) ─────────────────────────────────────
  // Keeps the overlay in sync with the DB even if the user has another tab open.
  setInterval(() => {
    if (spinning) return; // don't poll mid-spin
    fetch("/api/balance")
      .then(r => r.json())
      .then(d => { if (d.bal !== undefined) setBalance(d.bal); })
      .catch(() => {});
  }, 5000);

})();
</script>
</body>
</html>`;
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
// RNG payout engine (house edge ~3%)
// Returns net delta relative to bet (e.g. bet=100, returns +200 for 3×)
// ===========================================================================
function rollPayout(bet) {
  const r = Math.random();
  // Probability table (cumulative). House edge ≈ 3%.
  // win 5×  → 2%  → r < 0.02
  // win 3×  → 5%  → r < 0.07
  // win 2×  → 10% → r < 0.17
  // win 1×  → 30% → r < 0.47   (push: get bet back, delta=0)
  // lose     → 53%
  if (r < 0.02)  return bet  * 4;   // net delta = +4× bet (returned 5× total)
  if (r < 0.07)  return bet  * 2;   // net delta = +2× bet
  if (r < 0.17)  return bet  * 1;   // net delta = +1× bet
  if (r < 0.47)  return 0;          // push
  return -bet;                       // lose
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
      if (!asset) { res.writeHead(404); return res.end("Not found"); }
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

    // ── GAME PAGE ─────────────────────────────────────────────────────────────
    if (path === "/game/fishslot" && req.method === "GET") {
      const uid = this._uid(req);
      if (!uid) return this._redirect(res, "/login");

      const token = u.searchParams.get("token");
      const user  = await this.db.getUser(uid);
      const bal   = Number(user?.bal ?? 0);
      const cookies = parseCookies(req);
      const tag    = decodeURIComponent(cookies.dtag ?? "Player");
      const avatar = decodeURIComponent(cookies.dav  ?? "");

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
        // Don't delete pendingSessions here — the user can refresh without losing their bet setting
      }

      return this._html(res, 200, fishslotPage(bal, tag, avatar, token ?? "", initBet));
    }

    // ── SPIN ENDPOINT ─────────────────────────────────────────────────────────
    // Deducts the bet from DB immediately and returns a spinToken.
    // This is the authoritative deduction — the game animation is just visual.
    if (path === "/api/fishslot/spin" && req.method === "POST") {
      const uid = this._uid(req);
      if (!uid) return this._json(res, 401, { error: "Not logged in" });

      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return this._json(res, 400, { error: "Bad JSON" }); }

      const bet = Math.max(1, Math.floor(Number(body.bet) || 0));
      if (bet < 1) return this._json(res, 400, { error: "Invalid bet" });

      const user  = await this.db.getUser(uid);
      const dbBal = Number(user?.bal ?? 0);

      if (dbBal < bet) return this._json(res, 400, { error: "Insufficient balance" });

      // Deduct bet
      await this.db.updateBalance(uid, -bet);
      const afterDeduct = dbBal - bet;

      // Store spin session for resolve step
      const spinToken = crypto.randomBytes(24).toString("hex");
      spinSessions.set(spinToken, {
        uid,
        bet,
        dbBalBefore: dbBal,
        ts: Date.now(),
      });

      return this._json(res, 200, { ok: true, spinToken, newBal: afterDeduct });
    }

    // ── RESOLVE ENDPOINT ─────────────────────────────────────────────────────
    // Called after the slot animation completes. Applies RNG payout.
    if (path === "/api/fishslot/resolve" && req.method === "POST") {
      const uid = this._uid(req);
      if (!uid) return this._json(res, 401, { error: "Not logged in" });

      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return this._json(res, 400, { error: "Bad JSON" }); }

      const { spinToken } = body;
      if (!spinToken || !spinSessions.has(spinToken)) {
        return this._json(res, 400, { error: "Unknown or expired spin token" });
      }

      const sess = spinSessions.get(spinToken);
      if (sess.uid !== uid) return this._json(res, 403, { error: "Token mismatch" });
      spinSessions.delete(spinToken);

      // Roll payout
      const delta = rollPayout(sess.bet);

      // Apply payout (delta can be negative, zero, or positive)
      if (delta !== 0) {
        await this.db.updateBalance(uid, delta);
      }

      // Record game result
      await this.db.recordGame(uid, delta >= 0, sess.bet);

      const updated = await this.db.getUser(uid);
      const newBal  = Number(updated?.bal ?? 0);

      // Also close the Discord pending session if one existed
      if (body.discordToken && pendingSessions.has(body.discordToken)) {
        pendingSessions.delete(body.discordToken);
      }

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
