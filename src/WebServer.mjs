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
// SlotsLaunch — token + origin read from env vars or config
// SL_TOKEN:  your API token from slotslaunch.com/account/api-token
// SL_ORIGIN: the EXACT domain you registered for that token (e.g. "www.example.com")
// ---------------------------------------------------------------------------
const SL_API_BASE    = "https://slotslaunch.com/api";
const SL_TOKEN       = process.env.SL_TOKEN       ?? "";
const SL_ORIGIN_HOST = process.env.SL_ORIGIN      ?? "";
const SL_EMBED       = (id) => `https://slotslaunch.com/iframe/${id}?token=${SL_TOKEN}`;

// In-memory game cache — refreshed once per day
let _gameCache   = [];
let _cacheExpiry = 0;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchAllGames() {
  const now = Date.now();
  if (_gameCache.length && now < _cacheExpiry) return _gameCache;
  if (!SL_TOKEN) {
    console.warn("[SlotsLaunch] SL_TOKEN is not set — skipping game fetch.");
    return [];
  }
  if (!SL_ORIGIN_HOST) {
    console.warn("[SlotsLaunch] SL_ORIGIN is not set — API auth will fail. Set it to the domain registered for your token.");
  }
  console.log("[SlotsLaunch] Refreshing game catalogue…");
  const all = [];
  let page = 1;
  while (true) {
    try {
      const raw = await nodeFetch(
        `${SL_API_BASE}/games?token=${SL_TOKEN}&per_page=150&page=${page}&published=1&order_by=name&order=asc`,
        { headers: {
            "Accept":     "application/json",
            "Origin":     SL_ORIGIN_HOST,
            "User-Agent": "Mozilla/5.0 (compatible; FluxerCasinoBot/1.0)",
        } }
      );
      if (page === 1) {
        console.log("[SlotsLaunch] API response (page 1):", raw.slice(0, 300));
      }
      let json;
      try {
        json = JSON.parse(raw);
      } catch {
        console.error("[SlotsLaunch] Invalid JSON:", raw.slice(0, 300));
        break;
      }
      if (!json.data?.length) {
        console.log("[SlotsLaunch] Empty data:", JSON.stringify(json).slice(0, 300));
        break;
      }
      all.push(...json.data);
      if (!json.links?.next) break;
      page++;
      await sleep(500); // respect 2 r/s rate limit
    } catch (e) {
      console.error("[SlotsLaunch] fetch error:", e.message);
      break;
    }
  }
  if (all.length) {
    _gameCache   = all;
    _cacheExpiry = Date.now() + 24 * 60 * 60 * 1000;
    console.log(`[SlotsLaunch] Cached ${all.length} games.`);
  } else {
    console.warn("[SlotsLaunch] No games cached — check SL_TOKEN and SL_ORIGIN are valid.");
  }
  return _gameCache;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parseBody(req) {
  return new Promise(resolve => {
    let d = "";
    req.on("data", c => d += c);
    req.on("end", () => { try { resolve(Object.fromEntries(new URLSearchParams(d))); } catch { resolve({}); } });
  });
}

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

/* scrollbar */
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:#0a1a0a}
::-webkit-scrollbar-thumb{background:#2ecc7155;border-radius:99px}
::-webkit-scrollbar-thumb:hover{background:#2ecc71aa}

/* NAV */
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
.nav-bal{
  font-size:.8rem;font-weight:700;
  color:#a8e6a8;white-space:nowrap;
}
.nav-bal strong{color:#2ecc71;font-size:.95rem}
.nav-user{
  display:flex;align-items:center;gap:.5rem;
  font-size:.8rem;color:#a8d5a8;
}
.nav-avatar{
  width:28px;height:28px;border-radius:50%;
  border:1px solid #2ecc7144;object-fit:cover;
}
.nav-logout{
  font-size:.7rem;color:#3a6b3a;
  border-bottom:1px solid #2ecc7122;
  cursor:pointer;background:none;border-color:transparent;
  border-bottom:1px solid #2ecc7122;
  padding:0;
}
.nav-logout:hover{color:#2ecc71}

/* AMBIENT */
.ambient{
  position:fixed;inset:0;pointer-events:none;z-index:0;
  background:
    radial-gradient(ellipse 70% 50% at 50% 0%,#0d3b0d33 0%,transparent 70%),
    radial-gradient(ellipse 50% 40% at 10% 90%,#0b2b0b22 0%,transparent 60%);
}

/* WRAPPER */
.wrap{position:relative;z-index:1;padding:1.5rem 1.5rem 3rem}

/* SECTION TITLE */
.section-title{
  font-size:1rem;font-weight:900;letter-spacing:.08em;text-transform:uppercase;
  color:#2ecc71;text-shadow:0 0 10px #2ecc7155;
  margin-bottom:1rem;display:flex;align-items:center;gap:.5rem;
}

/* FILTERS */
.filters{
  display:flex;flex-wrap:wrap;gap:.5rem;
  margin-bottom:1.5rem;align-items:center;
}
.filter-input{
  background:#0a1f0a;border:1px solid #2ecc7133;border-radius:8px;
  color:#e2ffe2;padding:.4rem .75rem;font-size:.85rem;
  transition:border-color .2s,box-shadow .2s;
  min-width:180px;
}
.filter-input:focus{outline:none;border-color:#2ecc71;box-shadow:0 0 0 3px #2ecc7122}
.filter-select{
  background:#0a1f0a;border:1px solid #2ecc7133;border-radius:8px;
  color:#e2ffe2;padding:.4rem .75rem;font-size:.85rem;
  cursor:pointer;
  transition:border-color .2s;
}
.filter-select:focus{outline:none;border-color:#2ecc71}
.filter-count{font-size:.75rem;color:#4a9a4a;margin-left:.25rem}

/* GAME GRID */
.game-grid{
  display:grid;
  grid-template-columns:repeat(auto-fill,minmax(160px,1fr));
  gap:1rem;
}
.game-card{
  background:#0a1f0a;
  border:1px solid #2ecc7122;
  border-radius:12px;
  overflow:hidden;
  cursor:pointer;
  transition:transform .18s,box-shadow .18s,border-color .18s;
  position:relative;
}
.game-card:hover{
  transform:translateY(-4px) scale(1.02);
  box-shadow:0 8px 32px #2ecc7133;
  border-color:#2ecc7166;
}
.game-card:active{transform:translateY(-1px) scale(1.01)}
.game-thumb-wrap{
  width:100%;aspect-ratio:4/3;
  overflow:hidden;background:#071507;
  position:relative;
}
.game-thumb{
  width:100%;height:100%;object-fit:cover;
  display:block;
  transition:transform .3s;
}
.game-card:hover .game-thumb{transform:scale(1.06)}
.game-thumb-placeholder{
  width:100%;height:100%;
  display:flex;align-items:center;justify-content:center;
  font-size:2.5rem;color:#2ecc7133;
}
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
.game-name{
  font-size:.78rem;font-weight:700;
  color:#c8f5c8;line-height:1.3;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.game-meta{
  font-size:.65rem;color:#4a9a4a;margin-top:.2rem;
  display:flex;gap:.4rem;flex-wrap:wrap;align-items:center;
}
.game-tag{
  background:#0d2b0d;border:1px solid #2ecc7122;
  border-radius:4px;padding:.1rem .3rem;
  font-size:.6rem;color:#5aaa5a;
}
.game-rtp{color:#8ad58a}

/* EMPTY */
.empty{
  grid-column:1/-1;
  text-align:center;padding:4rem 1rem;
  color:#3a6b3a;
}
.empty-icon{font-size:3rem;margin-bottom:.75rem}
.empty-txt{font-size:.9rem}

/* LOAD MORE */
.load-more-wrap{text-align:center;margin-top:1.5rem}
.load-more-btn{
  background:#0a1f0a;border:1px solid #2ecc7133;
  color:#4a9a4a;padding:.6rem 2rem;border-radius:8px;
  font-size:.85rem;font-weight:700;
  transition:all .18s;
}
.load-more-btn:hover{border-color:#2ecc71;color:#2ecc71;box-shadow:0 0 12px #2ecc7122}

/* GAME VIEWER */
.viewer-header{
  display:flex;align-items:center;gap:1rem;
  padding:.75rem 1.5rem;
  background:rgba(6,14,6,.95);
  border-bottom:1px solid #2ecc7122;
  flex-wrap:wrap;
  position:sticky;top:0;z-index:50;
}
.viewer-back{
  background:#0a1f0a;border:1px solid #2ecc7133;
  color:#a8e6a8;padding:.4rem .9rem;border-radius:8px;
  font-size:.8rem;font-weight:700;
  transition:all .18s;display:flex;align-items:center;gap:.4rem;
}
.viewer-back:hover{border-color:#2ecc71;color:#2ecc71}
.viewer-title{
  font-size:.95rem;font-weight:900;color:#e2ffe2;
  flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.viewer-provider{font-size:.75rem;color:#4a9a4a}
.viewer-wallet{
  display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;
}
.wallet-label{font-size:.7rem;color:#4a9a4a;text-transform:uppercase;letter-spacing:.1em}
.wallet-val{
  font-size:1rem;font-weight:900;color:#2ecc71;
  text-shadow:0 0 10px #2ecc7155;
}
.wallet-note{font-size:.65rem;color:#3a6b3a;max-width:200px;line-height:1.4}

.game-frame-wrap{
  width:100%;height:calc(100vh - 110px);
  background:#040d04;
  position:relative;
}
.game-frame{
  width:100%;height:100%;
  border:none;display:block;
  background:#040d04;
}
.frame-loading{
  position:absolute;inset:0;
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  background:#040d04;gap:1rem;
  pointer-events:none;
  transition:opacity .3s;
}
.frame-loading.hidden{opacity:0}
.frame-spinner{
  width:48px;height:48px;
  border:3px solid #2ecc7122;
  border-top-color:#2ecc71;
  border-radius:50%;
  animation:spin .8s linear infinite;
}
@keyframes spin{to{transform:rotate(360deg)}}
.frame-loading-txt{font-size:.85rem;color:#4a9a4a}

/* LOGIN */
.login-wrap{
  min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem;
  position:relative;z-index:1;
}
.login-card{
  background:linear-gradient(160deg,#0e230e,#071507);
  border:2px solid #2ecc7133;border-radius:20px;
  padding:2.5rem 2rem;max-width:400px;width:100%;
  text-align:center;
  box-shadow:0 0 60px #2ecc7111,inset 0 1px 0 #2ecc7122;
}
.login-logo{font-size:3.5rem;margin-bottom:.5rem}
.login-title{
  font-size:2rem;font-weight:900;color:#2ecc71;
  text-shadow:0 0 20px #2ecc71cc;margin-bottom:.25rem;
}
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

/* ERROR CARD */
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
  .game-grid{grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:.65rem}
  .viewer-header{padding:.5rem 1rem}
  .game-frame-wrap{height:calc(100vh - 130px)}
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
    : `<span style="font-size:1.3rem">🎰</span>`;
  return `<nav class="nav">
  <div class="nav-logo"><span>🎰</span> SirGreen Casino</div>
  <div class="nav-spacer"></div>
  <div class="nav-bal">Balance: <strong>${Number(bal).toLocaleString()} FC</strong></div>
  <div class="nav-user">${av}<span>${esc(tag)}</span></div>
  <a href="/logout" class="nav-logout">logout</a>
</nav>`;
}

// ---------------------------------------------------------------------------
// LOBBY PAGE
// ---------------------------------------------------------------------------
function lobbyPage(bal, tag, avatar, games) {
  const types     = [...new Map(games.map(g => [g.type_id, g.type])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));
  const providers = [...new Map(games.map(g => [g.provider_id, g.provider])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));

  const typeOpts = types.map(([id, name]) =>
    `<option value="${id}">${esc(name)}</option>`).join("");
  const provOpts = providers.map(([id, name]) =>
    `<option value="${id}">${esc(name)}</option>`).join("");

  const gamesJson = JSON.stringify(games.map(g => ({
    id:       g.id,
    name:     g.name,
    thumb:    g.thumb ?? "",
    provider: g.provider ?? "",
    prov_id:  g.provider_id,
    type:     g.type ?? "",
    type_id:  g.type_id,
    rtp:      g.rtp ?? null,
    megaways: g.megaways ?? false,
    bonus:    g.bonus_buy ?? false,
    prog:     g.progressive ?? false,
    vol:      g.volatility ?? "",
  })));

  return shellPage("", `
${navBar(tag, avatar, bal)}
<div class="wrap">
  <div class="section-title">🎮 Game Library <span class="filter-count" id="countBadge">${games.length} games</span></div>

  <div class="filters">
    <input class="filter-input" id="searchInput" type="search" placeholder="🔍  Search games…" autocomplete="off">
    <select class="filter-select" id="typeSelect">
      <option value="">All Types</option>
      ${typeOpts}
    </select>
    <select class="filter-select" id="provSelect">
      <option value="">All Providers</option>
      ${provOpts}
    </select>
    <select class="filter-select" id="volSelect">
      <option value="">Any Volatility</option>
      <option value="low">Low</option>
      <option value="medium">Medium</option>
      <option value="high">High</option>
    </select>
    <select class="filter-select" id="featSelect">
      <option value="">All Features</option>
      <option value="megaways">Megaways</option>
      <option value="bonus">Bonus Buy</option>
      <option value="progressive">Progressive</option>
    </select>
  </div>

  <div class="game-grid" id="gameGrid"></div>
  <div class="load-more-wrap" id="loadMoreWrap" style="display:none">
    <button class="load-more-btn" id="loadMoreBtn" onclick="loadMore()">Load More</button>
  </div>
</div>

<script>
const ALL_GAMES = ${gamesJson};
const PAGE_SIZE = 60;
let filtered = ALL_GAMES;
let shown    = 0;

function buildCard(g) {
  const thumb = g.thumb
    ? \`<img class="game-thumb" src="\${g.thumb}" alt="\${g.name}" loading="lazy" onerror="this.parentNode.innerHTML='<div class=game-thumb-placeholder>🎰</div>'">\`
    : '<div class="game-thumb-placeholder">🎰</div>';
  const tags = [];
  if (g.megaways) tags.push('Megaways');
  if (g.bonus)    tags.push('Bonus Buy');
  if (g.prog)     tags.push('Progressive');
  const tagHtml = tags.map(t => \`<span class="game-tag">\${t}</span>\`).join('');
  const rtpHtml = g.rtp ? \`<span class="game-rtp">RTP \${g.rtp}%</span>\` : '';
  const volHtml = g.vol ? \`<span class="game-tag">\${g.vol}</span>\` : '';
  return \`<div class="game-card" onclick="openGame(\${g.id},'\${encodeURIComponent(g.name)}','\${encodeURIComponent(g.provider)}')">
  <div class="game-thumb-wrap">
    \${thumb}
    <div class="game-play-overlay"><div class="game-play-btn">▶ Play</div></div>
  </div>
  <div class="game-info">
    <div class="game-name">\${g.name}</div>
    <div class="game-meta">
      <span>\${g.provider}</span>
      \${rtpHtml}\${volHtml}\${tagHtml}
    </div>
  </div>
</div>\`;
}

function applyFilters() {
  const q    = document.getElementById('searchInput').value.toLowerCase().trim();
  const type = document.getElementById('typeSelect').value;
  const prov = document.getElementById('provSelect').value;
  const vol  = document.getElementById('volSelect').value;
  const feat = document.getElementById('featSelect').value;

  filtered = ALL_GAMES.filter(g => {
    if (q && !g.name.toLowerCase().includes(q) && !g.provider.toLowerCase().includes(q)) return false;
    if (type && String(g.type_id) !== type) return false;
    if (prov && String(g.prov_id) !== prov) return false;
    if (vol  && g.vol !== vol) return false;
    if (feat === 'megaways'    && !g.megaways) return false;
    if (feat === 'bonus'       && !g.bonus)    return false;
    if (feat === 'progressive' && !g.prog)     return false;
    return true;
  });
  shown = 0;
  document.getElementById('gameGrid').innerHTML = '';
  document.getElementById('countBadge').textContent = filtered.length + ' games';
  loadMore();
}

function loadMore() {
  const grid  = document.getElementById('gameGrid');
  const slice = filtered.slice(shown, shown + PAGE_SIZE);
  if (!slice.length) {
    if (!shown) {
      grid.innerHTML = '<div class="empty"><div class="empty-icon">🔍</div><div class="empty-txt">No games found</div></div>';
    }
    document.getElementById('loadMoreWrap').style.display = 'none';
    return;
  }
  grid.insertAdjacentHTML('beforeend', slice.map(buildCard).join(''));
  shown += slice.length;
  const hasMore = shown < filtered.length;
  document.getElementById('loadMoreWrap').style.display = hasMore ? 'block' : 'none';
  if (hasMore) document.getElementById('loadMoreBtn').textContent =
    'Load More (' + (filtered.length - shown) + ' remaining)';
}

function openGame(id, nameEnc, provEnc) {
  window.location.href = '/play?game=' + id + '&name=' + nameEnc + '&provider=' + provEnc;
}

let debounce;
['searchInput','typeSelect','provSelect','volSelect','featSelect'].forEach(id => {
  document.getElementById(id).addEventListener('input', () => {
    clearTimeout(debounce); debounce = setTimeout(applyFilters, 180);
  });
});

loadMore();
</script>
`);
}

// ---------------------------------------------------------------------------
// GAME VIEWER PAGE
// ---------------------------------------------------------------------------
function gamePage(bal, tag, avatar, gameId, gameName, gameProvider) {
  const embedUrl = SL_EMBED(gameId);
  return shellPage("", `
<div style="display:flex;flex-direction:column;height:100vh">
  <div class="viewer-header">
    <button class="viewer-back" onclick="history.back()">← Back</button>
    <div style="flex:1;min-width:0">
      <div class="viewer-title">${esc(gameName)}</div>
      <div class="viewer-provider">${esc(gameProvider)}</div>
    </div>
    <div class="viewer-wallet">
      <div>
        <div class="wallet-label">FluxCoins Balance</div>
        <div class="wallet-val" id="walBal">${Number(bal).toLocaleString()} FC</div>
      </div>
      <div class="wallet-note">Balance shown for reference. Real-money play not enabled.</div>
    </div>
    <a href="/logout" style="font-size:.7rem;color:#3a6b3a;border-bottom:1px solid #2ecc7122">logout</a>
  </div>

  <div class="game-frame-wrap">
    <div class="frame-loading" id="frameLoading">
      <div class="frame-spinner"></div>
      <div class="frame-loading-txt">Loading ${esc(gameName)}…</div>
    </div>
    <iframe
      class="game-frame"
      id="gameFrame"
      src="${esc(embedUrl)}"
      allowfullscreen
      allow="autoplay; fullscreen"
      onload="document.getElementById('frameLoading').classList.add('hidden')"
    ></iframe>
  </div>
</div>

<script>
setTimeout(function(){
  var fl = document.getElementById('frameLoading');
  if (fl) fl.classList.add('hidden');
}, 8000);
</script>
`);
}

// ---------------------------------------------------------------------------
// LOGIN PAGE
// ---------------------------------------------------------------------------
function loginPage(authUrl) {
  return shellPage("", `
<div class="ambient"></div>
<div class="login-wrap">
  <div class="login-card">
    <div class="login-logo">🎰</div>
    <div class="login-title">SirGreen Casino</div>
    <div class="login-sub">Powered by FluxCoins</div>
    <span class="login-desc">Login with your <strong style="color:#2ecc71">Fluxer</strong> account to access thousands of games with your FluxCoin balance.</span>
    <a class="login-btn" href="${esc(authUrl)}">🟢&nbsp; Login with Fluxer</a>
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
    fetchAllGames().catch(() => {});

    this._server = http.createServer((req, res) =>
      this._handle(req, res).catch(e => {
        console.error("[Web]", e);
        res.writeHead(500);
        res.end("Internal error");
      })
    );
    this._server.listen(this.port, "0.0.0.0", () =>
      console.log(`[Web] SirGreen Casino running on port ${this.port}`));

    setInterval(() => fetchAllGames().catch(() => {}), 24 * 60 * 60 * 1000);

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

    if (path === "/lobby" && req.method === "GET") {
      const uid = this._uid(req);
      if (!uid) return this._redirect(res, "/login");
      const [user, games] = await Promise.all([
        this.db.getUser(uid),
        fetchAllGames(),
      ]);
      const cookies = parseCookies(req);
      const bal     = Number(user?.bal ?? 0);
      const tag     = decodeURIComponent(cookies.dtag ?? "Player");
      const avatar  = decodeURIComponent(cookies.dav  ?? "");
      return this._html(res, 200, lobbyPage(bal, tag, avatar, games));
    }

    if (path === "/play" && req.method === "GET" && !u.searchParams.get("game")) {
      return this._redirect(res, "/lobby");
    }

    if (path === "/play" && req.method === "GET") {
      const uid = this._uid(req);
      if (!uid) return this._redirect(res, "/login");
      const gameId   = parseInt(u.searchParams.get("game") ?? "");
      const gameName = decodeURIComponent(u.searchParams.get("name") ?? "Game");
      const gameProv = decodeURIComponent(u.searchParams.get("provider") ?? "");
      if (!gameId) return this._redirect(res, "/lobby");
      const user = await this.db.getUser(uid);
      const bal  = Number(user?.bal ?? 0);
      const cookies = parseCookies(req);
      const tag     = decodeURIComponent(cookies.dtag ?? "Player");
      const avatar  = decodeURIComponent(cookies.dav  ?? "");
      return this._html(res, 200, gamePage(bal, tag, avatar, gameId, gameName, gameProv));
    }

    if (path === "/api/balance" && req.method === "GET") {
      const uid = this._uid(req);
      if (!uid) return this._json(res, 401, { error: "Not logged in" });
      const user = await this.db.getUser(uid);
      return this._json(res, 200, { bal: Number(user?.bal ?? 0) });
    }

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
