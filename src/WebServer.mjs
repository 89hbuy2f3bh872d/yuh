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
// Le Bandit — direct Hacksaw Gaming demo embed (no API key required)
// Real FluxCoin economy is handled by /api/spin below.
// The iframe runs Hacksaw's own demo client at static-live.hacksawgaming.com.
// ---------------------------------------------------------------------------
const LE_BANDIT_EMBED =
  "https://static-live.hacksawgaming.com/1309/1.23.2/index.html" +
  "?language=en&channel=desktop&gameid=1309&mode=2&token=123131" +
  "&lobbyurl=https%3A%2F%2Fwww.hacksawgaming.com" +
  "&currency=EUR&partner=demo" +
  "&env=https://rgs-demo.hacksawgaming.com/api" +
  "&realmoneyenv=https://rgs-demo.hacksawgaming.com/api";

// ---------------------------------------------------------------------------
// Server-side spin engine — house-edge RNG, real FluxCoin deduction/credit
// ---------------------------------------------------------------------------
const SYMBOLS = ["\uD83C\uDF4B","\uD83C\uDF4A","\uD83C\uDF47","\uD83D\uDD14","\uD83D\uDC8E","7\uFE0F\u20E3","\u2B50","\uD83C\uDCCF"];
const WEIGHTS  = [  28,  22,  18,  14,  10,   5,   2,   1];
const TOTAL_W  = WEIGHTS.reduce((a,b) => a+b, 0);
const PAYOUTS  = { "\uD83C\uDF4B":2,"\uD83C\uDF4A":3,"\uD83C\uDF47":4,"\uD83D\uDD14":6,"\uD83D\uDC8E":12,"7\uFE0F\u20E3":20,"\u2B50":40,"\uD83C\uDCCF":100 };
const SCATTER     = "\uD83C\uDCCF";
const SCATTER_PAY = 50;
const HOUSE_EDGE  = 0.96;

function weightedRandom() {
  let r = Math.random() * TOTAL_W;
  for (let i = 0; i < SYMBOLS.length; i++) { r -= WEIGHTS[i]; if (r <= 0) return SYMBOLS[i]; }
  return SYMBOLS[SYMBOLS.length - 1];
}
function spinReels() {
  return Array.from({ length: 3 }, () => Array.from({ length: 3 }, weightedRandom));
}
function evalSpin(reels, bet) {
  const row = [reels[0][1], reels[1][1], reels[2][1]];
  let mult = 0, winLine = null;
  if (row[0] === row[1] && row[1] === row[2]) { mult = PAYOUTS[row[0]] ?? 1; winLine = "centre"; }
  const scatters = reels.flat().filter(s => s === SCATTER).length;
  if (scatters >= 3) { const sm = SCATTER_PAY * scatters; if (sm > mult) { mult = sm; winLine = "scatter"; } }
  const gross = Math.floor(bet * mult * HOUSE_EDGE);
  return { row, mult, winLine, gross, net: gross - bet };
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
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

const LE_BANDIT = {
  name:     "Le Bandit",
  provider: "Hacksaw Gaming",
  thumb:    "https://assets.slotslaunch.com/16132/conversions/le-bandit-game115.jpg",
  thumbAlt: "https://assets.slotslaunch.com/uploads/games/le-bandit.jpg",
};

// ---------------------------------------------------------------------------
// SHARED CSS
// ---------------------------------------------------------------------------
const SHARED_CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{-webkit-font-smoothing:antialiased;scroll-behavior:smooth}
body{background:#060e06;color:#e2ffe2;font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;overflow-x:hidden}
a{color:inherit;text-decoration:none}
button{cursor:pointer;background:none;border:none;color:inherit;font:inherit}
input,select{font:inherit;color:inherit}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:#0a1a0a}
::-webkit-scrollbar-thumb{background:#2ecc7155;border-radius:99px}
::-webkit-scrollbar-thumb:hover{background:#2ecc71aa}
.nav{position:sticky;top:0;z-index:100;background:rgba(6,14,6,.92);backdrop-filter:blur(12px);border-bottom:1px solid #2ecc7122;display:flex;align-items:center;gap:1rem;padding:.6rem 1.5rem}
.nav-logo{font-size:1.1rem;font-weight:900;color:#2ecc71;text-shadow:0 0 14px #2ecc7188;display:flex;align-items:center;gap:.4rem;white-space:nowrap}
.nav-logo span{font-size:1.3rem}
.nav-spacer{flex:1}
.nav-bal{font-size:.8rem;font-weight:700;color:#a8e6a8;white-space:nowrap}
.nav-bal strong{color:#2ecc71;font-size:.95rem}
.nav-user{display:flex;align-items:center;gap:.5rem;font-size:.8rem;color:#a8d5a8}
.nav-avatar{width:28px;height:28px;border-radius:50%;border:1px solid #2ecc7144;object-fit:cover}
.nav-logout{font-size:.7rem;color:#3a6b3a;border-bottom:1px solid #2ecc7122;cursor:pointer}
.nav-logout:hover{color:#2ecc71}
.ambient{position:fixed;inset:0;pointer-events:none;z-index:0;background:radial-gradient(ellipse 70% 50% at 50% 0%,#0d3b0d33 0%,transparent 70%),radial-gradient(ellipse 50% 40% at 10% 90%,#0b2b0b22 0%,transparent 60%)}
.wrap{position:relative;z-index:1;padding:1.5rem 1.5rem 3rem}
.section-title{font-size:1rem;font-weight:900;letter-spacing:.08em;text-transform:uppercase;color:#2ecc71;text-shadow:0 0 10px #2ecc7155;margin-bottom:1.5rem;display:flex;align-items:center;gap:.5rem}
.game-card{background:#0a1f0a;border:1px solid #2ecc7122;border-radius:12px;overflow:hidden;cursor:pointer;transition:transform .18s,box-shadow .18s,border-color .18s;position:relative;max-width:280px}
.game-card:hover{transform:translateY(-4px) scale(1.02);box-shadow:0 8px 32px #2ecc7133;border-color:#2ecc7166}
.game-card:active{transform:translateY(-1px) scale(1.01)}
.game-thumb-wrap{width:100%;aspect-ratio:4/3;overflow:hidden;background:#071507;position:relative}
.game-thumb{width:100%;height:100%;object-fit:cover;display:block;transition:transform .3s}
.game-card:hover .game-thumb{transform:scale(1.06)}
.game-play-overlay{position:absolute;inset:0;background:rgba(6,14,6,.6);display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .18s}
.game-card:hover .game-play-overlay{opacity:1}
.game-play-btn{background:#2ecc71;color:#060e06;font-weight:900;font-size:.85rem;padding:.45rem 1.1rem;border-radius:8px;letter-spacing:.04em;box-shadow:0 0 20px #2ecc7188}
.game-info{padding:.6rem .7rem .7rem}
.game-name{font-size:.78rem;font-weight:700;color:#c8f5c8;line-height:1.3}
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

const LE_BANDIT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 280 210" width="280" height="210"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#071f07"/><stop offset="100%" stop-color="#0e2e0e"/></linearGradient><linearGradient id="gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#f5d020"/><stop offset="100%" stop-color="#c8a400"/></linearGradient></defs><rect width="280" height="210" fill="url(#bg)"/><rect x="60" y="70" width="40" height="60" rx="6" fill="#0a2a0a" stroke="#2ecc7133" stroke-width="1"/><rect x="120" y="70" width="40" height="60" rx="6" fill="#0a2a0a" stroke="#2ecc7133" stroke-width="1"/><rect x="180" y="70" width="40" height="60" rx="6" fill="#0a2a0a" stroke="#2ecc7133" stroke-width="1"/><text x="80" y="113" font-size="32" font-family="serif" font-weight="900" fill="url(#gold)" text-anchor="middle">7</text><text x="140" y="113" font-size="32" font-family="serif" font-weight="900" fill="url(#gold)" text-anchor="middle">7</text><text x="200" y="113" font-size="32" font-family="serif" font-weight="900" fill="url(#gold)" text-anchor="middle">7</text><text x="140" y="165" font-size="13" font-family="'Segoe UI',sans-serif" font-weight="900" fill="#2ecc71" text-anchor="middle" letter-spacing="2">LE BANDIT</text><text x="140" y="180" font-size="8" font-family="'Segoe UI',sans-serif" fill="#2ecc7177" text-anchor="middle" letter-spacing="1">HACKSAW GAMING</text></svg>`;

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
  <div class="nav-bal" id="navBal">Balance: <strong>${Number(bal).toLocaleString()} FC</strong></div>
  <div class="nav-user">${av}<span>${esc(tag)}</span></div>
  <a href="/logout" class="nav-logout">logout</a>
</nav>`;
}

function lobbyPage(bal, tag, avatar) {
  const g = LE_BANDIT;
  const thumbHtml = `<img class="game-thumb" src="${esc(g.thumb)}" alt="${esc(g.name)}" loading="lazy"
    onerror="if(!this.dataset.fb){this.dataset.fb='1';this.src='${esc(g.thumbAlt)}';}else{this.style.display='none';}">` ;
  return shellPage("", `
${navBar(tag, avatar, bal)}
<div class="wrap">
  <div class="section-title">&#127918; Game Lobby</div>
  <div class="game-card" onclick="window.location.href='/play'">
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
// Game page: Hacksaw demo iframe + FluxCoin bet overlay
//
// The iframe loads the real Le Bandit game directly from Hacksaw's static CDN
// — no API key, no SlotsLaunch. The bet overlay beneath it handles all real
// FluxCoin economy: balance check, server-side RNG, MongoDB write, live update.
// ---------------------------------------------------------------------------
function gamePage(bal, tag, avatar) {
  return shellPage(`
<style>
.play-layout{display:flex;flex-direction:column;height:100vh;overflow:hidden}
.play-top{flex:1;position:relative;min-height:0}
.game-frame{width:100%;height:100%;border:none;display:block;background:#040d04}
.frame-loading{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#040d04;gap:1rem;pointer-events:none;transition:opacity .3s}
.frame-loading.hidden{opacity:0;pointer-events:none}
.frame-spinner{width:48px;height:48px;border:3px solid #2ecc7122;border-top-color:#2ecc71;border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.frame-loading-txt{font-size:.85rem;color:#4a9a4a}
.bet-panel{background:rgba(6,14,6,.97);border-top:1px solid #2ecc7133;padding:.6rem 1rem .7rem;display:flex;flex-direction:column;gap:.45rem;flex-shrink:0;box-shadow:0 -4px 24px #2ecc7111}
.bet-panel-row{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap}
.bet-label{font-size:.68rem;color:#4a9a4a;text-transform:uppercase;letter-spacing:.1em;white-space:nowrap}
.bet-presets{display:flex;gap:.3rem;flex-wrap:wrap}
.bet-preset{padding:.3rem .55rem;background:#0a1f0a;border:1px solid #2ecc7122;border-radius:7px;font-size:.7rem;font-weight:700;color:#a8e6a8;transition:all .15s;cursor:pointer}
.bet-preset:hover{border-color:#2ecc7155;color:#2ecc71}
.bet-preset.active{background:#132a13;border-color:#2ecc71;color:#2ecc71;box-shadow:0 0 8px #2ecc7133}
.bet-input{width:80px;padding:.3rem .45rem;background:#040d04;border:1px solid #2ecc7133;border-radius:7px;font-size:.82rem;color:#e2ffe2;text-align:center;outline:none;transition:border-color .15s}
.bet-input:focus{border-color:#2ecc71}
.spin-btn{padding:.55rem 1.4rem;background:linear-gradient(135deg,#27ae60,#2ecc71);color:#060e06;font-size:.9rem;font-weight:900;border-radius:10px;letter-spacing:.04em;box-shadow:0 3px 14px #2ecc7133;transition:all .18s;display:flex;align-items:center;gap:.4rem;white-space:nowrap}
.spin-btn:hover:not(:disabled){background:linear-gradient(135deg,#2ecc71,#39d97a);box-shadow:0 5px 22px #2ecc7155;transform:translateY(-1px)}
.spin-btn:disabled{opacity:.5;cursor:not-allowed;transform:none}
.result-line{font-size:.78rem;font-weight:700;color:#4a9a4a;min-height:1.2em;text-align:center;transition:all .2s}
.result-line.win{color:#2ecc71;text-shadow:0 0 8px #2ecc7166}
.result-line.lose{color:#c0392b}
.result-line.bigwin{color:#f1c40f;text-shadow:0 0 12px #f1c40faa;animation:bigwinPop .4s ease}
@keyframes bigwinPop{0%{transform:scale(.85)}60%{transform:scale(1.08)}100%{transform:scale(1)}}
.panel-stats{display:flex;gap:1rem;flex-wrap:wrap;justify-content:center;font-size:.65rem;color:#3a6b3a}
.panel-stats strong{color:#a8e6a8}
.viewer-header{display:flex;align-items:center;gap:.75rem;padding:.5rem 1rem;background:rgba(6,14,6,.97);border-bottom:1px solid #2ecc7122;flex-wrap:wrap;flex-shrink:0}
.viewer-back{background:#0a1f0a;border:1px solid #2ecc7133;color:#a8e6a8;padding:.35rem .8rem;border-radius:7px;font-size:.78rem;font-weight:700;transition:all .18s;display:flex;align-items:center;gap:.35rem}
.viewer-back:hover{border-color:#2ecc71;color:#2ecc71}
.viewer-title{font-size:.9rem;font-weight:900;color:#e2ffe2;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.viewer-provider{font-size:.7rem;color:#4a9a4a}
.nav-bal-viewer{font-size:.8rem;font-weight:700;color:#a8e6a8;white-space:nowrap}
.nav-bal-viewer strong{color:#2ecc71;font-size:.9rem}
@media(max-width:600px){.bet-panel{padding:.5rem .75rem .6rem}.spin-btn{padding:.5rem 1rem;font-size:.82rem}}
</style>
`, `
<div class="play-layout">
  <div class="viewer-header">
    <button class="viewer-back" onclick="history.back()">&#8592; Lobby</button>
    <div style="flex:1;min-width:0">
      <div class="viewer-title">Le Bandit</div>
      <div class="viewer-provider">Hacksaw Gaming</div>
    </div>
    <div class="nav-bal-viewer" id="navBal">Balance: <strong>${Number(bal).toLocaleString()} FC</strong></div>
    <a href="/logout" style="font-size:.7rem;color:#3a6b3a;border-bottom:1px solid #2ecc7122">logout</a>
  </div>

  <div class="play-top">
    <div class="frame-loading" id="frameLoading">
      <div class="frame-spinner"></div>
      <div class="frame-loading-txt">Loading Le Bandit&#8230;</div>
    </div>
    <iframe
      class="game-frame"
      src="${LE_BANDIT_EMBED}"
      allowfullscreen
      allow="autoplay; fullscreen"
      onload="document.getElementById('frameLoading').classList.add('hidden')"
    ></iframe>
  </div>

  <div class="bet-panel">
    <div class="bet-panel-row">
      <span class="bet-label">Bet (FC)</span>
      <div class="bet-presets" id="presets">
        <button class="bet-preset active" data-val="10">10</button>
        <button class="bet-preset" data-val="25">25</button>
        <button class="bet-preset" data-val="50">50</button>
        <button class="bet-preset" data-val="100">100</button>
        <button class="bet-preset" data-val="250">250</button>
      </div>
      <input class="bet-input" id="betInput" type="number" min="1" max="10000" value="10">
      <button class="spin-btn" id="spinBtn">&#9654; SPIN</button>
    </div>
    <div class="result-line" id="result">Place your FluxCoin bet and hit SPIN!</div>
    <div class="panel-stats">
      Spins: <strong id="sSpins">0</strong>&nbsp;&nbsp;
      Won: <strong id="sWon">0</strong> FC&nbsp;&nbsp;
      Lost: <strong id="sLost">0</strong> FC&nbsp;&nbsp;
      Net: <strong id="sNet">0</strong> FC
    </div>
  </div>
</div>

<script>
let bal = ${Number(bal)};
let spinning = false, currentBet = 10, sSpins = 0, sWon = 0, sLost = 0;
setTimeout(function(){ var f=document.getElementById('frameLoading'); if(f) f.classList.add('hidden'); }, 9000);
document.getElementById('presets').addEventListener('click', e => {
  const btn = e.target.closest('.bet-preset'); if (!btn) return;
  document.querySelectorAll('.bet-preset').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentBet = Number(btn.dataset.val);
  document.getElementById('betInput').value = currentBet;
});
document.getElementById('betInput').addEventListener('input', () => {
  currentBet = Math.max(1, Number(document.getElementById('betInput').value) || 1);
  document.querySelectorAll('.bet-preset').forEach(b => b.classList.remove('active'));
});
function updateUI(newBal, net) {
  bal = newBal;
  document.getElementById('navBal').innerHTML = 'Balance: <strong>' + bal.toLocaleString() + ' FC</strong>';
  sSpins++;
  if (net > 0) sWon += net; else sLost += Math.abs(net);
  document.getElementById('sSpins').textContent = sSpins;
  document.getElementById('sWon').textContent   = sWon.toLocaleString();
  document.getElementById('sLost').textContent  = sLost.toLocaleString();
  const netTotal = sWon - sLost;
  const netEl = document.getElementById('sNet');
  netEl.textContent = (netTotal >= 0 ? '+' : '') + netTotal.toLocaleString() + ' FC';
  netEl.style.color = netTotal >= 0 ? '#2ecc71' : '#c0392b';
}
document.getElementById('spinBtn').addEventListener('click', async () => {
  if (spinning) return;
  const bet = Math.max(1, parseInt(document.getElementById('betInput').value) || currentBet);
  const resultEl = document.getElementById('result');
  if (bet > bal) { resultEl.className = 'result-line lose'; resultEl.textContent = '\u2717 Not enough FluxCoins!'; return; }
  spinning = true;
  document.getElementById('spinBtn').disabled = true;
  resultEl.className = 'result-line';
  resultEl.textContent = 'Spinning\u2026';
  let data;
  try {
    const r = await fetch('/api/spin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bet }) });
    data = await r.json();
    if (!r.ok) throw new Error(data.error ?? 'spin failed');
  } catch(err) {
    resultEl.className = 'result-line lose';
    resultEl.textContent = '\u26a0 ' + err.message;
    spinning = false;
    document.getElementById('spinBtn').disabled = false;
    return;
  }
  updateUI(data.newBal, data.net);
  if (data.mult === 0) {
    resultEl.className = 'result-line lose';
    resultEl.textContent = '\u2717 No win \u2014 lost ' + bet.toLocaleString() + ' FC';
  } else if (data.gross >= bet * 10) {
    resultEl.className = 'result-line bigwin';
    resultEl.textContent = '\uD83C\uDF89 BIG WIN! \xd7' + data.mult + ' \u2014 +' + data.gross.toLocaleString() + ' FC!';
  } else {
    resultEl.className = 'result-line win';
    resultEl.textContent = '\u2714 \xd7' + data.mult + ' \u2014 +' + data.gross.toLocaleString() + ' FC';
  }
  spinning = false;
  document.getElementById('spinBtn').disabled = false;
});
</script>
`);
}

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
<div class="err-card"><h1>${esc(title)}</h1><p>${esc(msg)}</p><a class="err-btn" href="${esc(btnHref ?? "/login")}">${esc(btnLabel ?? "Back to login")}</a></div>
</div>
`);
}

// ===========================================================================
// WEB SERVER
// ===========================================================================
export class WebServer {
  constructor(db, config) {
    this.db           = db;
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

    // ── GAME (Le Bandit) ─────────────────────────────────────────────────────
    if (path === "/play" && req.method === "GET") {
      const uid = this._uid(req);
      if (!uid) return this._redirect(res, "/login");
      const user    = await this.db.getUser(uid);
      const cookies = parseCookies(req);
      return this._html(res, 200, gamePage(
        Number(user?.bal ?? 0),
        decodeURIComponent(cookies.dtag ?? "Player"),
        decodeURIComponent(cookies.dav  ?? "")
      ));
    }

    // ── SPIN API — real FluxCoin deduction + house-edge RNG ──────────────────
    if (path === "/api/spin" && req.method === "POST") {
      const uid = this._uid(req);
      if (!uid) return this._json(res, 401, { error: "Not logged in" });
      let body = "";
      await new Promise(r => { req.on("data", c => body += c); req.on("end", r); });
      let bet;
      try { bet = Math.max(1, parseInt(JSON.parse(body).bet) || 1); }
      catch { return this._json(res, 400, { error: "Invalid bet" }); }
      const MAX_BET = 10_000;
      if (bet > MAX_BET) return this._json(res, 400, { error: `Max bet is ${MAX_BET} FC` });
      const user = await this.db.getUser(uid);
      const bal  = Number(user?.bal ?? 0);
      if (bal < bet) return this._json(res, 400, { error: "Insufficient balance" });
      const reels  = spinReels();
      const result = evalSpin(reels, bet);
      const delta  = result.gross - bet;
      const updated = await this.db.updateBalance(uid, delta);
      await this.db.recordGame(uid, result.gross > 0, bet);
      return this._json(res, 200, {
        reels, row: result.row, mult: result.mult, winLine: result.winLine,
        gross: result.gross, net: result.net,
        newBal: Number(updated?.bal ?? bal + delta),
      });
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
