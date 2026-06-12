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
// Le Bandit — slot engine constants
// ---------------------------------------------------------------------------
const SYMBOLS = ["🍋", "🍊", "🍇", "🔔", "💎", "7️⃣", "⭐", "🃏"];
const WEIGHTS  = [  28,   22,   18,   14,   10,    5,    2,    1 ]; // higher = more common
const TOTAL_W  = WEIGHTS.reduce((a, b) => a + b, 0);

// Payouts: multiplier on BET for 3-of-a-kind on centre row
const PAYOUTS = {
  "🍋": 2,
  "🍊": 3,
  "🍇": 4,
  "🔔": 6,
  "💎": 12,
  "7️⃣": 20,
  "⭐": 40,
  "🃏": 100,
};

// Scatter: 3+ 🃏 anywhere pays 50×
const SCATTER = "🃏";
const SCATTER_PAY = 50;

// House edge applied to payout multipliers (mirrors HouseEdge.mjs ~4%)
const HOUSE_EDGE = 0.96;

function weightedRandom() {
  let r = Math.random() * TOTAL_W;
  for (let i = 0; i < SYMBOLS.length; i++) {
    r -= WEIGHTS[i];
    if (r <= 0) return SYMBOLS[i];
  }
  return SYMBOLS[SYMBOLS.length - 1];
}

function spinReels() {
  // 3 reels × 3 rows
  return Array.from({ length: 3 }, () =>
    Array.from({ length: 3 }, weightedRandom)
  );
}

function evalSpin(reels, bet) {
  // Centre row (index 1) for each reel
  const row = [reels[0][1], reels[1][1], reels[2][1]];
  let mult = 0;
  let winLine = null;

  // 3-of-a-kind centre line
  if (row[0] === row[1] && row[1] === row[2]) {
    mult = PAYOUTS[row[0]] ?? 1;
    winLine = "centre";
  }

  // Scatter: count 🃏 across all 9 cells
  const flat = reels.flat();
  const scatters = flat.filter(s => s === SCATTER).length;
  if (scatters >= 3) {
    const scatterMult = SCATTER_PAY * scatters;
    if (scatterMult > mult) {
      mult = scatterMult;
      winLine = "scatter";
    }
  }

  const gross = Math.floor(bet * mult * HOUSE_EDGE);
  const net   = gross - bet; // negative = loss, positive = gain
  return { row, mult, winLine, gross, net };
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
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: opts.method ?? "GET",
        headers,
      },
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
// SHARED CSS (dark green casino theme)
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
  return shellPage("", `
${navBar(tag, avatar, bal)}
<div class="wrap">
  <div class="section-title">&#127918; Game Lobby</div>
  <div class="game-card" onclick="window.location.href='/play'">
    <div class="game-thumb-wrap">
      <img
        class="game-thumb"
        src="https://assets.slotslaunch.com/16132/conversions/le-bandit-game115.jpg"
        alt="Le Bandit"
        loading="lazy"
        onerror="this.src='https://assets.slotslaunch.com/uploads/games/le-bandit.jpg'"
      >
      <div class="game-play-overlay"><div class="game-play-btn">&#9654; Play</div></div>
    </div>
    <div class="game-info">
      <div class="game-name">Le Bandit</div>
      <div class="game-meta">Hacksaw Gaming · FluxCoin Edition</div>
    </div>
  </div>
</div>
`);
}

// ---------------------------------------------------------------------------
// Native Le Bandit slot game page
// ---------------------------------------------------------------------------
function gamePage(bal, tag, avatar) {
  const symbolList = JSON.stringify(["🍋","🍊","🍇","🔔","💎","7️⃣","⭐","🃏"]);
  return shellPage(`
<style>
.bandit-wrap{
  position:relative;z-index:1;
  display:flex;flex-direction:column;align-items:center;
  padding:1.5rem 1rem 3rem;gap:1.25rem;
  min-height:calc(100vh - 56px);
}
.bandit-title{
  font-size:1.6rem;font-weight:900;letter-spacing:.1em;
  color:#2ecc71;text-shadow:0 0 20px #2ecc71aa;
  text-transform:uppercase;
}
.bandit-sub{font-size:.7rem;color:#4a9a4a;letter-spacing:.15em;text-transform:uppercase;margin-top:-.5rem}

/* Machine */
.machine{
  background:linear-gradient(160deg,#0b2a0b,#071507);
  border:2px solid #2ecc7144;border-radius:20px;
  padding:1.25rem 1.5rem 1.5rem;
  box-shadow:0 0 60px #2ecc7111,inset 0 1px 0 #2ecc7122;
  width:100%;max-width:420px;
}
.reels{
  display:grid;grid-template-columns:repeat(3,1fr);gap:.5rem;
  background:#040d04;border-radius:12px;
  padding:.75rem .5rem;
  border:1px solid #2ecc7122;
  margin-bottom:1rem;
  position:relative;overflow:hidden;
}
/* win-line overlay */
.reels.win::after{
  content:'';position:absolute;
  top:calc(33.33% + 2px);left:0;right:0;
  height:33.33%;
  background:rgba(46,204,113,.08);
  border-top:2px solid #2ecc7155;
  border-bottom:2px solid #2ecc7155;
  pointer-events:none;
}
.reel{
  display:flex;flex-direction:column;gap:.3rem;
  align-items:center;
}
.cell{
  width:100%;aspect-ratio:1;
  display:flex;align-items:center;justify-content:center;
  font-size:1.6rem;
  border-radius:8px;
  background:#071f07;
  border:1px solid #2ecc7111;
  transition:background .2s;
  user-select:none;
}
.cell.centre{
  background:#0a2a0a;
  border-color:#2ecc7133;
}
.cell.highlight{
  background:#1a4a1a;
  border-color:#2ecc71;
  box-shadow:0 0 12px #2ecc7166;
  animation:pulse .5s ease-in-out infinite alternate;
}
@keyframes pulse{from{box-shadow:0 0 8px #2ecc7166}to{box-shadow:0 0 24px #2ecc71cc}}
.cell.spin-anim{animation:spinCell .08s linear infinite}
@keyframes spinCell{0%{opacity:.4;transform:translateY(-4px)}50%{opacity:1;transform:translateY(0)}100%{opacity:.4;transform:translateY(4px)}}

/* Result banner */
.result-banner{
  min-height:2rem;text-align:center;
  font-size:.85rem;font-weight:700;
  color:#4a9a4a;
  transition:all .2s;
  padding:.25rem 0;
}
.result-banner.win{color:#2ecc71;font-size:1rem;text-shadow:0 0 10px #2ecc7188}
.result-banner.lose{color:#c0392b}
.result-banner.bigwin{color:#f1c40f;font-size:1.1rem;text-shadow:0 0 16px #f1c40faa;animation:bigwinPop .4s ease}
@keyframes bigwinPop{0%{transform:scale(.8)}60%{transform:scale(1.08)}100%{transform:scale(1)}}

/* Bet controls */
.bet-row{display:flex;align-items:center;gap:.5rem;width:100%}
.bet-label{font-size:.7rem;color:#4a9a4a;text-transform:uppercase;letter-spacing:.1em;white-space:nowrap}
.bet-presets{display:flex;gap:.35rem;flex:1;flex-wrap:wrap}
.bet-preset{
  flex:1;min-width:44px;padding:.35rem .5rem;
  background:#0a1f0a;border:1px solid #2ecc7122;
  border-radius:8px;font-size:.72rem;font-weight:700;
  color:#a8e6a8;transition:all .15s;cursor:pointer;
  text-align:center;
}
.bet-preset:hover{border-color:#2ecc7155;color:#2ecc71}
.bet-preset.active{background:#132a13;border-color:#2ecc71;color:#2ecc71;box-shadow:0 0 8px #2ecc7133}
.bet-input{
  width:90px;padding:.35rem .5rem;
  background:#040d04;border:1px solid #2ecc7133;
  border-radius:8px;font-size:.85rem;color:#e2ffe2;
  text-align:center;outline:none;
  transition:border-color .15s;
}
.bet-input:focus{border-color:#2ecc71}

/* Spin button */
.spin-btn{
  width:100%;padding:.85rem;
  background:linear-gradient(135deg,#27ae60,#2ecc71);
  color:#060e06;font-size:1.05rem;font-weight:900;
  border-radius:12px;letter-spacing:.05em;
  box-shadow:0 4px 20px #2ecc7144;
  transition:all .18s;margin-top:.25rem;
  display:flex;align-items:center;justify-content:center;gap:.5rem;
}
.spin-btn:hover:not(:disabled){background:linear-gradient(135deg,#2ecc71,#39d97a);box-shadow:0 6px 30px #2ecc7166;transform:translateY(-1px)}
.spin-btn:disabled{opacity:.5;cursor:not-allowed;transform:none}

/* Pay table */
.paytable-toggle{
  font-size:.72rem;color:#3a6b3a;text-transform:uppercase;letter-spacing:.1em;
  border-bottom:1px dotted #2ecc7133;cursor:pointer;transition:color .15s;background:none;
}
.paytable-toggle:hover{color:#2ecc71}
.paytable{
  display:none;width:100%;max-width:420px;
  background:#0a1f0a;border:1px solid #2ecc7122;border-radius:12px;
  padding:.75rem 1rem;
}
.paytable.open{display:block}
.pt-row{display:flex;align-items:center;justify-content:space-between;padding:.2rem 0;font-size:.78rem;border-bottom:1px solid #2ecc7111}
.pt-row:last-child{border-bottom:none}
.pt-sym{font-size:1rem}
.pt-mult{color:#2ecc71;font-weight:700}
.pt-note{font-size:.65rem;color:#4a9a4a;margin-top:.5rem;line-height:1.5}

/* Stats strip */
.stats{display:flex;gap:1.5rem;flex-wrap:wrap;justify-content:center;font-size:.72rem;color:#4a9a4a}
.stat strong{color:#a8e6a8;font-size:.85rem}
</style>
`, `
${navBar(tag, avatar, bal)}
<div class="bandit-wrap">
  <div class="bandit-title">Le Bandit</div>
  <div class="bandit-sub">FluxCoin Edition · Hacksaw Gaming</div>

  <div class="machine">
    <div class="reels" id="reels">
      <div class="reel" id="r0"><div class="cell">🍋</div><div class="cell centre">🍋</div><div class="cell">🍋</div></div>
      <div class="reel" id="r1"><div class="cell">🍋</div><div class="cell centre">🍋</div><div class="cell">🍋</div></div>
      <div class="reel" id="r2"><div class="cell">🍋</div><div class="cell centre">🍋</div><div class="cell">🍋</div></div>
    </div>
    <div class="result-banner" id="result">Place your bet and spin!</div>

    <div class="bet-row" style="margin-bottom:.6rem">
      <span class="bet-label">Bet</span>
      <div class="bet-presets" id="presets">
        <button class="bet-preset active" data-val="10">10</button>
        <button class="bet-preset" data-val="25">25</button>
        <button class="bet-preset" data-val="50">50</button>
        <button class="bet-preset" data-val="100">100</button>
        <button class="bet-preset" data-val="250">250</button>
      </div>
      <input class="bet-input" id="betInput" type="number" min="1" max="10000" value="10">
    </div>

    <button class="spin-btn" id="spinBtn">&#9654; SPIN</button>
  </div>

  <div class="stats">
    <div>Spins: <strong id="statSpins">0</strong></div>
    <div>Won: <strong id="statWon">0</strong> FC</div>
    <div>Lost: <strong id="statLost">0</strong> FC</div>
    <div>Net: <strong id="statNet">0</strong> FC</div>
  </div>

  <button class="paytable-toggle" id="ptToggle">&#9660; Pay Table</button>
  <div class="paytable" id="paytable">
    <div class="pt-row"><span class="pt-sym">🃏🃏🃏+</span><span class="pt-mult">Scatter: 50× per joker</span></div>
    <div class="pt-row"><span class="pt-sym">⭐⭐⭐</span><span class="pt-mult">40×</span></div>
    <div class="pt-row"><span class="pt-sym">7️⃣7️⃣7️⃣</span><span class="pt-mult">20×</span></div>
    <div class="pt-row"><span class="pt-sym">💎💎💎</span><span class="pt-mult">12×</span></div>
    <div class="pt-row"><span class="pt-sym">🔔🔔🔔</span><span class="pt-mult">6×</span></div>
    <div class="pt-row"><span class="pt-sym">🍇🍇🍇</span><span class="pt-mult">4×</span></div>
    <div class="pt-row"><span class="pt-sym">🍊🍊🍊</span><span class="pt-mult">3×</span></div>
    <div class="pt-row"><span class="pt-sym">🍋🍋🍋</span><span class="pt-mult">2×</span></div>
    <p class="pt-note">Centre row pays. 3+ 🃏 anywhere = scatter win. House edge 4%.</p>
  </div>

  <a href="/lobby" style="font-size:.75rem;color:#3a6b3a;border-bottom:1px dotted #2ecc7122;margin-top:.5rem">← Back to lobby</a>
</div>

<script>
const SYMS = ${symbolList};
let bal       = ${Number(bal)};
let spinning  = false;
let statSpins = 0, statWon = 0, statLost = 0;
let currentBet = 10;

// ── UI refs ──────────────────────────────────────────────────────────────
const reelsEl  = document.getElementById('reels');
const resultEl = document.getElementById('result');
const spinBtn  = document.getElementById('spinBtn');
const betInput = document.getElementById('betInput');
const navBal   = document.getElementById('navBal');

// ── Bet presets ──────────────────────────────────────────────────────────
document.getElementById('presets').addEventListener('click', e => {
  const btn = e.target.closest('.bet-preset');
  if (!btn) return;
  document.querySelectorAll('.bet-preset').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentBet = Number(btn.dataset.val);
  betInput.value = currentBet;
});

betInput.addEventListener('input', () => {
  currentBet = Math.max(1, Number(betInput.value) || 1);
  document.querySelectorAll('.bet-preset').forEach(b => b.classList.remove('active'));
});

// ── Pay table toggle ──────────────────────────────────────────────────────
document.getElementById('ptToggle').addEventListener('click', () => {
  document.getElementById('paytable').classList.toggle('open');
});

// ── Spin animation ────────────────────────────────────────────────────────
function getReelCells(r) {
  return document.getElementById('r' + r).querySelectorAll('.cell');
}

function animateReels(duration) {
  return new Promise(resolve => {
    const cells = [0,1,2].flatMap(r => [...getReelCells(r)]);
    let tick = 0;
    const iv = setInterval(() => {
      cells.forEach(c => { c.textContent = SYMS[Math.floor(Math.random() * SYMS.length)]; });
      tick++;
    }, 80);
    setTimeout(() => { clearInterval(iv); resolve(); }, duration);
  });
}

function displayReels(reelData, winLine, row) {
  // reelData: [[top,mid,bot], [top,mid,bot], [top,mid,bot]]
  for (let r = 0; r < 3; r++) {
    const cells = getReelCells(r);
    reelData[r].forEach((sym, i) => { cells[i].textContent = sym; });
  }
  // Highlight winning cells
  reelsEl.classList.remove('win');
  document.querySelectorAll('.cell').forEach(c => c.classList.remove('highlight'));
  if (winLine === 'centre') {
    reelsEl.classList.add('win');
    for (let r = 0; r < 3; r++) getReelCells(r)[1].classList.add('highlight');
  } else if (winLine === 'scatter') {
    reelsEl.classList.add('win');
    for (let r = 0; r < 3; r++) {
      [...getReelCells(r)].forEach(c => { if (c.textContent === '🃏') c.classList.add('highlight'); });
    }
  }
}

function updateNav() {
  navBal.innerHTML = 'Balance: <strong>' + bal.toLocaleString() + ' FC</strong>';
}

function updateStats(net) {
  statSpins++;
  if (net > 0) statWon += net;
  else statLost += Math.abs(net);
  document.getElementById('statSpins').textContent = statSpins;
  document.getElementById('statWon').textContent   = statWon.toLocaleString();
  document.getElementById('statLost').textContent  = statLost.toLocaleString();
  const netTotal = statWon - statLost;
  const netEl = document.getElementById('statNet');
  netEl.textContent = (netTotal >= 0 ? '+' : '') + netTotal.toLocaleString() + ' FC';
  netEl.style.color = netTotal >= 0 ? '#2ecc71' : '#c0392b';
}

// ── Spin ──────────────────────────────────────────────────────────────────
spinBtn.addEventListener('click', async () => {
  if (spinning) return;
  const bet = Math.max(1, parseInt(betInput.value) || currentBet);
  if (bet > bal) {
    resultEl.className = 'result-banner lose';
    resultEl.textContent = 'Not enough FluxCoins!';
    return;
  }

  spinning = true;
  spinBtn.disabled = true;
  resultEl.className = 'result-banner';
  resultEl.textContent = 'Spinning…';
  reelsEl.classList.remove('win');
  document.querySelectorAll('.cell').forEach(c => c.classList.remove('highlight'));

  // Call server to spin (server-side RNG + DB write)
  let data;
  try {
    const r = await fetch('/api/spin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bet }),
    });
    data = await r.json();
    if (!r.ok) throw new Error(data.error ?? 'spin failed');
  } catch (err) {
    resultEl.className = 'result-banner lose';
    resultEl.textContent = '⚠ ' + err.message;
    spinning = false;
    spinBtn.disabled = false;
    return;
  }

  // Animate, then reveal
  await animateReels(600);
  displayReels(data.reels, data.winLine, data.row);

  bal = data.newBal;
  updateNav();
  updateStats(data.net);

  if (data.mult === 0) {
    resultEl.className = 'result-banner lose';
    resultEl.textContent = '— No win. Lost ' + bet.toLocaleString() + ' FC';
  } else if (data.gross >= bet * 10) {
    resultEl.className = 'result-banner bigwin';
    resultEl.textContent = '🎉 BIG WIN! ×' + data.mult + ' — +'  + data.gross.toLocaleString() + ' FC!';
  } else {
    resultEl.className = 'result-banner win';
    resultEl.textContent = '✔ ×' + data.mult + ' — +' + data.gross.toLocaleString() + ' FC';
  }

  spinning = false;
  spinBtn.disabled = false;
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
    this.baseUrl      = config.webBaseUrl           ?? "https://www.sirgreen.online";
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

    // ── GAME PAGE ───────────────────────────────────────────────────────────
    if (path === "/play" && req.method === "GET") {
      const uid = this._uid(req);
      if (!uid) return this._redirect(res, "/login");
      const user    = await this.db.getUser(uid);
      const bal     = Number(user?.bal ?? 0);
      const cookies = parseCookies(req);
      const tag     = decodeURIComponent(cookies.dtag ?? "Player");
      const avatar  = decodeURIComponent(cookies.dav  ?? "");
      return this._html(res, 200, gamePage(bal, tag, avatar));
    }

    // ── SPIN API ────────────────────────────────────────────────────────────
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

      // Deduct bet first, then credit winnings
      const reels  = spinReels();
      const result = evalSpin(reels, bet);

      // Net balance change: -bet + gross
      const delta = result.gross - bet;
      const updated = await this.db.updateBalance(uid, delta);
      await this.db.recordGame(uid, result.gross > 0, bet);

      return this._json(res, 200, {
        reels,
        row:    result.row,
        mult:   result.mult,
        winLine: result.winLine,
        gross:  result.gross,
        net:    result.net,
        newBal: Number(updated?.bal ?? bal + delta),
      });
    }

    // ── BALANCE API ─────────────────────────────────────────────────────────
    if (path === "/api/balance" && req.method === "GET") {
      const uid = this._uid(req);
      if (!uid) return this._json(res, 401, { error: "Not logged in" });
      const user = await this.db.getUser(uid);
      return this._json(res, 200, { bal: Number(user?.bal ?? 0) });
    }

    // ── LOGIN ───────────────────────────────────────────────────────────────
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
      const authUrl =
        `${FLUXER_AUTH_URL}` +
        `?client_id=${encodeURIComponent(this.clientId)}` +
        `&scope=identify+guilds` +
        `&redirect_uri=${encodeURIComponent(this.redirectUri)}` +
        `&response_type=code` +
        `&state=${encodeURIComponent(state)}`;
      return this._html(res, 200, loginPage(authUrl));
    }

    // ── OAUTH CALLBACK ──────────────────────────────────────────────────────
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

    // ── LOGOUT ──────────────────────────────────────────────────────────────
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
