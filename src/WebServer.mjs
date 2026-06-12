import http from "http";
import https from "https";
import { URL } from "url";
import crypto from "crypto";
import zlib from "zlib";

// ---------------------------------------------------------------------------
// Fluxer OAuth2
// ---------------------------------------------------------------------------
const FLUXER_AUTH_URL  = "https://web.canary.fluxer.app/oauth2/authorize";
const FLUXER_TOKEN_URL = "https://api.fluxer.app/v1/oauth2/token";
const FLUXER_ME_URL    = "https://api.fluxer.app/v1/users/@me";

// ---------------------------------------------------------------------------
// Hacksaw upstream origins
// ---------------------------------------------------------------------------
const HACKSAW_STATIC  = "https://static-live.hacksawgaming.com";
const HACKSAW_RGS     = "https://rgs-demo.hacksawgaming.com";
const HACKSAW_PLAY    = "https://play.hacksawgaming.com";   // ← partnerSettings / authenticate

// Query-string params forwarded to the proxied game root
const GAME_PARAMS =
  "language=en&channel=desktop&gameid=1309&mode=2&token=123131" +
  "&lobbyurl=%2Flobby" +                    // keep lobby link on-origin
  "&currency=EUR&partner=demo" +
  "&env=%2Fproxy-api" +                      // rewrite RGS env to our tunnel
  "&realmoneyenv=%2Fproxy-api";

const GAME_PROXY_ROOT = `/proxy/1309/1.23.2/index.html?${GAME_PARAMS}`;

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

/**
 * Low-level HTTP/HTTPS fetch that returns { statusCode, headers, body:Buffer }.
 * Follows up to `maxRedirects` Location redirects.
 */
function rawFetch(url, opts = {}, maxRedirects = 4) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const mod     = parsed.protocol === "https:" ? https : http;
    const bodyBuf = opts.body ? Buffer.from(opts.body) : Buffer.alloc(0);
    const headers = {
      "User-Agent":      "Mozilla/5.0 (compatible; SirGreenProxy/1.0)",
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
        // Follow redirects
        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
          const next = new URL(res.headers.location, url).toString();
          return resolve(rawFetch(next, opts, maxRedirects - 1));
        }
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          const enc = (res.headers["content-encoding"] ?? "").toLowerCase();
          const decomp = enc === "br"     ? zlib.brotliDecompressSync(raw)
                       : enc === "gzip"   ? zlib.gunzipSync(raw)
                       : enc === "deflate"? zlib.inflateSync(raw)
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

function nodeFetch(url, opts = {}) {
  return rawFetch(url, opts).then(r => r.body.toString("utf8"));
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
// Reverse-proxy URL rewriting
//
// All absolute URLs pointing at HACKSAW_STATIC  become /proxy/<path>
// All absolute URLs pointing at HACKSAW_RGS     become /proxy-api/<path>
// All absolute URLs pointing at HACKSAW_PLAY    become /proxy-api/play/<path>
// Relative URLs inside HTML/JS/CSS stay relative (the proxy path provides base).
// ---------------------------------------------------------------------------
function rewriteUrl(url, base) {
  if (!url) return url;
  let full;
  try { full = new URL(url, base).toString(); } catch { return url; }
  if (full.startsWith(HACKSAW_STATIC)) return "/proxy"     + full.slice(HACKSAW_STATIC.length);
  if (full.startsWith(HACKSAW_RGS))   return "/proxy-api"  + full.slice(HACKSAW_RGS.length);
  if (full.startsWith(HACKSAW_PLAY))  return "/proxy-api"  + full.slice(HACKSAW_PLAY.length);
  return url; // leave external links (CDN fonts etc.) untouched
}

/** Rewrite HTML: src, href, action, url() in inline styles, import()  */
function rewriteHtml(html, base) {
  // src / href / action / data-src / srcset attributes
  html = html.replace(
    /(\s(?:src|href|action|data-src)\s*=\s*)([\"'])([^\"']+)\2/gi,
    (_, attr, q, url) => `${attr}${q}${rewriteUrl(url, base)}${q}`
  );
  // url() in inline style / <style> blocks
  html = html.replace(
    /url\((['\"]?)([^)'\"]+)\1\)/gi,
    (_, q, url) => `url(${q}${rewriteUrl(url, base)}${q})`
  );
  // JS string literals pointing at upstreams (catches bundled fetch calls)
  html = html.replace(
    new RegExp(`[\"']${escapeRegex(HACKSAW_STATIC)}([^\"']*)`, "g"),
    (_, p) => `"/proxy${p}"`
  );
  html = html.replace(
    new RegExp(`[\"']${escapeRegex(HACKSAW_RGS)}([^\"']*)`, "g"),
    (_, p) => `"/proxy-api${p}"`
  );
  html = html.replace(
    new RegExp(`[\"']${escapeRegex(HACKSAW_PLAY)}([^\"']*)`, "g"),
    (_, p) => `"/proxy-api${p}"`
  );
  return html;
}

/** Rewrite CSS text */
function rewriteCss(css, base) {
  return css.replace(
    /url\((['\"]?)([^)'\"]+)\1\)/gi,
    (_, q, url) => `url(${q}${rewriteUrl(url, base)}${q})`
  );
}

/** Rewrite JS text: string literals pointing at upstreams */
function rewriteJs(js) {
  js = js.replace(
    new RegExp(`([\"'])${escapeRegex(HACKSAW_STATIC)}([^\"']*)\\1`, "g"),
    (_, q, p) => `${q}/proxy${p}${q}`
  );
  js = js.replace(
    new RegExp(`([\"'])${escapeRegex(HACKSAW_RGS)}([^\"']*)\\1`, "g"),
    (_, q, p) => `${q}/proxy-api${p}${q}`
  );
  js = js.replace(
    new RegExp(`([\"'])${escapeRegex(HACKSAW_PLAY)}([^\"']*)\\1`, "g"),
    (_, q, p) => `${q}/proxy-api${p}${q}`
  );
  return js;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Bridge script injected into the game HTML (same-origin, full DOM access)
//
// Waits for the Hacksaw React app to mount (MutationObserver + retries),
// then:
//  1. Overwrites #BalanceValue / #BalanceLabel with real FC values
//  2. Overwrites #BetAmountValue / #BetAmountLabel
//  3. Hooks #PlaceBetBtn click → calls /api/spin → updates DOM + win display
//  4. Hooks #BetAmountIncrease / #BetAmountDecrease → adjusts FC bet
//  5. Disables #StopBtn  (AutoSpin)
//  6. Disables #SuperTurboToggle
//  7. Updates #WinAmountValue after each spin
//  8. Feature buy buttons (+Bonus Buy amount controls) post to /api/spin
//     with the multiplied bet amount derived from the displayed price text.
// ---------------------------------------------------------------------------
function buildBridgeScript(initialBal, initialBet) {
  return `
<script data-fc-bridge>
(function(){
  var FC_BAL  = ${Number(initialBal)};
  var FC_BET  = ${Number(initialBet)};
  var FC_BUSY = false;
  var FC_PRESETS = [10,25,50,100,250,500,1000,2500,5000];

  /* ── Toast ──────────────────────────────────────────────────────── */
  var _toast, _toastTO;
  function getToast(){
    if(_toast) return _toast;
    _toast = document.createElement('div');
    _toast.id = 'fc-bridge-toast';
    Object.assign(_toast.style, {
      position:'fixed', top:'8%', left:'50%', transform:'translateX(-50%)',
      background:'rgba(6,14,6,.93)', border:'1px solid #2ecc7133',
      borderRadius:'10px', padding:'.4rem .9rem', fontSize:'.82rem',
      fontWeight:'900', color:'#2ecc71', zIndex:'999999',
      pointerEvents:'none', opacity:'0', transition:'opacity .25s',
      whiteSpace:'nowrap', fontFamily:'system-ui,sans-serif'
    });
    document.body.appendChild(_toast);
    return _toast;
  }
  function showToast(msg, cls){
    var t = getToast();
    clearTimeout(_toastTO);
    t.textContent = msg;
    t.style.color = cls === 'lose' ? '#c0392b' : cls === 'bigwin' ? '#f1c40f' : '#2ecc71';
    t.style.borderColor = cls === 'lose' ? '#c0392b33' : cls === 'bigwin' ? '#f1c40f44' : '#2ecc7133';
    t.style.opacity = '1';
    _toastTO = setTimeout(function(){ t.style.opacity='0'; }, 2800);
  }

  /* ── Format FC ──────────────────────────────────────────────────── */
  function fmtFC(n){ return Number(n).toLocaleString('en-US') + ' FC'; }

  /* ── Wait for element ────────────────────────────────────────────── */
  function waitFor(sel, cb, tries){
    tries = tries || 60;
    var el = document.querySelector(sel);
    if(el){ cb(el); return; }
    if(tries <= 0){ console.warn('[FC Bridge] element not found:', sel); return; }
    setTimeout(function(){ waitFor(sel, cb, tries-1); }, 300);
  }

  /* ── Observe for element appearance ─────────────────────────────── */
  function onAppear(sel, cb){
    var existing = document.querySelector(sel);
    if(existing){ cb(existing); return; }
    var obs = new MutationObserver(function(){
      var el = document.querySelector(sel);
      if(el){ obs.disconnect(); cb(el); }
    });
    obs.observe(document.body, { childList:true, subtree:true });
  }

  /* ── Force React controlled input value ─────────────────────────── */
  function forceValue(el, val){
    var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    if(nativeSetter && nativeSetter.set) nativeSetter.set.call(el, val);
    el.value = val;
    el.dispatchEvent(new Event('input',  { bubbles:true }));
    el.dispatchEvent(new Event('change', { bubbles:true }));
  }

  /* ── Click a React-managed button safely ────────────────────────── */
  function reactClick(el){
    if(!el || el.disabled) return;
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles:true }));
    el.dispatchEvent(new MouseEvent('mouseup',   { bubbles:true }));
    el.dispatchEvent(new MouseEvent('click',     { bubbles:true }));
  }

  /* ── Sync balance display ────────────────────────────────────────── */
  function syncBalance(){
    var el = document.getElementById('BalanceValue');
    if(el) el.textContent = fmtFC(FC_BAL);
    var lbl = document.getElementById('BalanceLabel');
    if(lbl && lbl.textContent.trim().toLowerCase() !== 'balance') lbl.textContent = 'Balance';
    /* also patch any WinAmountValue to 0 on fresh mount */
    var wv = document.getElementById('WinAmountValue');
    if(wv && wv.textContent.trim() === '' ) wv.textContent = '0 FC';
  }

  /* ── Sync bet display ────────────────────────────────────────────── */
  function syncBet(){
    var el = document.getElementById('BetAmountValue');
    if(el) el.textContent = fmtFC(FC_BET);
    var lbl = document.getElementById('BetAmountLabel');
    if(lbl && lbl.textContent.trim().toLowerCase() !== 'bet') lbl.textContent = 'Bet';
  }

  /* ── Handle a spin result ────────────────────────────────────────── */
  function applyResult(data){
    FC_BAL = data.newBal;
    syncBalance();
    var wv = document.getElementById('WinAmountValue');
    if(wv){
      if(data.gross > 0){
        wv.textContent = '+' + fmtFC(data.gross);
        wv.style.color = data.gross >= FC_BET * 10 ? '#f1c40f' : '#2ecc71';
      } else {
        wv.textContent = '0 FC';
        wv.style.color = '';
      }
    }
    if(data.mult === 0){
      showToast('\u2717 No win — lost ' + fmtFC(FC_BET), 'lose');
    } else if(data.gross >= FC_BET * 10){
      showToast('\uD83C\uDF89 BIG WIN! \xd7' + data.mult + ' — +' + fmtFC(data.gross), 'bigwin');
    } else {
      showToast('\u2714 \xd7' + data.mult + ' — +' + fmtFC(data.gross));
    }
  }

  /* ── POST /api/spin ─────────────────────────────────────────────── */
  async function doSpin(bet){
    if(FC_BUSY) return;
    bet = bet || FC_BET;
    if(bet > FC_BAL){ showToast('\u2717 Insufficient FluxCoins!','lose'); return; }
    FC_BUSY = true;
    showToast('Spinning\u2026');
    try{
      var r = await fetch('/api/spin', {
        method:'POST', credentials:'same-origin',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ bet })
      });
      var data = await r.json();
      if(!r.ok) throw new Error(data.error || 'spin failed');
      applyResult(data);
    } catch(e){
      showToast('\u26a0 ' + e.message, 'lose');
    } finally {
      FC_BUSY = false;
    }
  }

  /* ── Hook PlaceBetBtn ────────────────────────────────────────────── */
  function hookSpinBtn(btn){
    /* We intercept at capture phase so we run BEFORE Hacksaw's listener */
    btn.addEventListener('click', function(e){
      e.stopImmediatePropagation();
      e.preventDefault();
      doSpin();
    }, true);
    console.log('[FC Bridge] hooked #PlaceBetBtn');
  }

  /* ── Hook BetAmountIncrease / Decrease ──────────────────────────── */
  function hookBetChangers(){
    var inc = document.getElementById('BetAmountIncrease');
    var dec = document.getElementById('BetAmountDecrease');
    if(inc){
      inc.addEventListener('click', function(e){
        e.stopImmediatePropagation(); e.preventDefault();
        var idx = FC_PRESETS.indexOf(FC_BET);
        FC_BET = idx >= 0 && idx < FC_PRESETS.length-1 ? FC_PRESETS[idx+1] : Math.min(FC_BAL, FC_BET+10);
        syncBet();
      }, true);
    }
    if(dec){
      dec.addEventListener('click', function(e){
        e.stopImmediatePropagation(); e.preventDefault();
        var idx = FC_PRESETS.indexOf(FC_BET);
        FC_BET = idx > 0 ? FC_PRESETS[idx-1] : Math.max(1, FC_BET-10);
        syncBet();
      }, true);
    }
  }

  /* ── Disable StopBtn (AutoSpin) ─────────────────────────────────── */
  function disableAutoSpin(btn){
    btn.disabled = true;
    btn.setAttribute('aria-disabled','true');
    btn.style.opacity = '0.3';
    btn.style.pointerEvents = 'none';
    /* Re-assert on any attribute changes (game tries to re-enable) */
    var obs = new MutationObserver(function(){
      btn.disabled = true;
      btn.style.opacity = '0.3';
      btn.style.pointerEvents = 'none';
    });
    obs.observe(btn, { attributes:true });
    console.log('[FC Bridge] disabled #StopBtn');
  }

  /* ── Disable SuperTurboToggle ────────────────────────────────────── */
  function disableSuperTurbo(el){
    el.style.pointerEvents = 'none';
    el.style.opacity = '0.3';
    el.setAttribute('aria-disabled','true');
    el.classList.add('super-turbo-off');
    el.classList.remove('super-turbo-on');
    var obs = new MutationObserver(function(){
      el.style.pointerEvents = 'none';
      el.classList.remove('super-turbo-on');
      el.classList.add('super-turbo-off');
    });
    obs.observe(el, { attributes:true, attributeFilter:['class'] });
    console.log('[FC Bridge] disabled #SuperTurboToggle');
  }

  /* ── Hook Feature Buy buttons ────────────────────────────────────── */
  /*   Items appear inside a modal; observe for it opening             */
  function hookFeatureBuy(){
    onAppear('#FeatureBuyWindow', function(){
      /* hook each buy button — price text tells us the multiplier */
      document.querySelectorAll('.FeatureBuyGridCard__button').forEach(function(btn,i){
        btn.addEventListener('click', function(e){
          e.stopImmediatePropagation(); e.preventDefault();
          /* Try to read price from sibling element */
          var card = btn.closest('.FeatureBuyGridCard');
          var priceEl = card && card.querySelector('.FeatureBuyGridCard__price, .FeatureBuyGridCard__amount, [class*="price"], [class*="amount"]');
          var mult = 100; /* safe default if we can't parse */
          if(priceEl){
            var m = priceEl.textContent.replace(/[^0-9.]/g,'');
            if(m) mult = Math.round(parseFloat(m));
          }
          var betAmt = FC_BET * mult;
          if(betAmt > FC_BAL){ showToast('\u2717 Not enough FluxCoins for Feature Buy!','lose'); return; }
          doSpin(betAmt);
        }, true);
      });
      /* Bonus Buy amount changers */
      var fbInc = document.getElementById('FeatureBuyAmountIncrease');
      var fbDec = document.getElementById('FeatureBuyAmountDecrease');
      if(fbInc) fbInc.addEventListener('click', function(e){
        e.stopImmediatePropagation(); e.preventDefault();
        var idx = FC_PRESETS.indexOf(FC_BET);
        FC_BET = idx >= 0 && idx < FC_PRESETS.length-1 ? FC_PRESETS[idx+1] : FC_BET+10;
        syncBet();
      }, true);
      if(fbDec) fbDec.addEventListener('click', function(e){
        e.stopImmediatePropagation(); e.preventDefault();
        var idx = FC_PRESETS.indexOf(FC_BET);
        FC_BET = idx > 0 ? FC_PRESETS[idx-1] : Math.max(1, FC_BET-10);
        syncBet();
      }, true);
    });
  }

  /* ── Poll /api/balance every 30s ────────────────────────────────── */
  setInterval(async function(){
    if(FC_BUSY) return;
    try{
      var r = await fetch('/api/balance', { credentials:'same-origin' });
      var d = await r.json();
      if(typeof d.bal === 'number'){ FC_BAL = d.bal; syncBalance(); }
    }catch(e){}
  }, 30000);

  /* ── MutationObserver to catch React re-renders resetting values ── */
  var _syncTO;
  function scheduleSync(){
    clearTimeout(_syncTO);
    _syncTO = setTimeout(function(){ syncBalance(); syncBet(); }, 80);
  }

  /* ── Main init — wait for game shell to mount ────────────────────── */
  function init(){
    /* Balance */
    waitFor('#BalanceValue', function(el){
      syncBalance();
      new MutationObserver(function(muts){
        muts.forEach(function(m){ if(m.target !== el) return;
          /* If game reset it to demo value, override back */
          if(!el.textContent.endsWith('FC')) scheduleSync();
        });
      }).observe(el, { characterData:true, childList:true });
    });
    /* Bet display */
    waitFor('#BetAmountValue', function(){ syncBet(); });
    /* Spin button */
    waitFor('#PlaceBetBtn', hookSpinBtn);
    /* Bet changers */
    waitFor('#BetAmountIncrease', function(){ hookBetChangers(); });
    /* AutoSpin stop */
    onAppear('#StopBtn', disableAutoSpin);
    /* SuperTurbo */
    onAppear('#SuperTurboToggle', disableSuperTurbo);
    /* Feature buy */
    hookFeatureBuy();
    /* Keep balance label sane across game state changes */
    setInterval(function(){ syncBalance(); syncBet(); }, 5000);
    console.log('[FC Bridge] initialised — balance:', FC_BAL, 'bet:', FC_BET);
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    /* DOM already loaded; game might still be mounting */
    setTimeout(init, 500);
  }
})();
</script>
`;
}

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
    onerror="if(!this.dataset.fb){this.dataset.fb='1';this.src='${esc(g.thumbAlt)}';}else{this.style.display='none';}">`;
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
// Game page
//
// The game now loads from /proxy/... (same origin) inside a full-page iframe.
// The bridge script is injected server-side into the proxied HTML,
// so it runs inside the game's own document with full DOM access.
// We still show a thin header (balance, back button) outside the iframe.
// ---------------------------------------------------------------------------
function gamePage(bal, tag, avatar) {
  const initBet = 10;
  return shellPage(`
<style>
.play-layout{display:flex;flex-direction:column;height:100vh;overflow:hidden}
.viewer-header{display:flex;align-items:center;gap:.75rem;padding:.5rem 1rem;background:rgba(6,14,6,.97);border-bottom:1px solid #2ecc7122;flex-wrap:wrap;flex-shrink:0}
.viewer-back{background:#0a1f0a;border:1px solid #2ecc7133;color:#a8e6a8;padding:.35rem .8rem;border-radius:7px;font-size:.78rem;font-weight:700;transition:all .18s;display:flex;align-items:center;gap:.35rem}
.viewer-back:hover{border-color:#2ecc71;color:#2ecc71}
.viewer-title{font-size:.9rem;font-weight:900;color:#e2ffe2;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.viewer-provider{font-size:.7rem;color:#4a9a4a}
.nav-bal-viewer{font-size:.8rem;font-weight:700;color:#a8e6a8;white-space:nowrap}
.nav-bal-viewer strong{color:#2ecc71;font-size:.9rem}
.play-top{flex:1;position:relative;min-height:0}
.game-frame{width:100%;height:100%;border:none;display:block;background:#040d04}
.frame-loading{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#040d04;gap:1rem;pointer-events:none;z-index:10;transition:opacity .3s}
.frame-loading.hidden{opacity:0;pointer-events:none}
.frame-spinner{width:48px;height:48px;border:3px solid #2ecc7122;border-top-color:#2ecc71;border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.frame-loading-txt{font-size:.85rem;color:#4a9a4a}
</style>
`, `
<div class="play-layout">
  <div class="viewer-header">
    <button class="viewer-back" onclick="history.back()">&#8592; Lobby</button>
    <div style="flex:1;min-width:0">
      <div class="viewer-title">Le Bandit</div>
      <div class="viewer-provider">Hacksaw Gaming (proxied)</div>
    </div>
    <div class="nav-bal-viewer">Balance: <strong id="outerBal">${Number(bal).toLocaleString()} FC</strong></div>
    <a href="/logout" style="font-size:.7rem;color:#3a6b3a;border-bottom:1px solid #2ecc7122">logout</a>
  </div>
  <div class="play-top">
    <div class="frame-loading" id="frameLoading">
      <div class="frame-spinner"></div>
      <div class="frame-loading-txt">Loading Le Bandit&#8230;</div>
    </div>
    <!-- same-origin src: bridge script was injected server-side -->
    <iframe
      class="game-frame"
      id="gameFrame"
      src="/proxy/1309/1.23.2/index.html?${GAME_PARAMS}"
      allowfullscreen
      allow="autoplay; fullscreen"
      onload="document.getElementById('frameLoading').classList.add('hidden')"
    ></iframe>
  </div>
</div>
<script>
/* Sync outer header balance from postMessage bridge */
window.addEventListener('message', function(e){
  if(e.data && e.data.type === 'FC_BAL_UPDATE'){
    var el = document.getElementById('outerBal');
    if(el) el.textContent = Number(e.data.bal).toLocaleString() + ' FC';
  }
});
/* Fallback hide loading */
setTimeout(function(){ var f=document.getElementById('frameLoading'); if(f) f.classList.add('hidden'); }, 12000);
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
// Reverse proxy handlers
// ===========================================================================

/**
 * Proxy a Hacksaw static asset.
 * HTML: decompress, rewrite URLs, inject bridge script before </head>
 * JS / CSS: rewrite URL literals
 * Binary (images, fonts, wasm): stream as-is
 */
async function proxyStatic(upstreamPath, req, res, bridgeHtml) {
  const targetUrl = HACKSAW_STATIC + upstreamPath;
  let upstream;
  try {
    upstream = await rawFetch(targetUrl, {
      method:  req.method,
      headers: {
        "Referer": HACKSAW_STATIC + "/",
      },
    });
  } catch (e) {
    res.writeHead(502);
    return res.end("Proxy fetch error: " + e.message);
  }

  const ct     = (upstream.headers["content-type"] ?? "").toLowerCase();
  const isHtml = ct.includes("html");
  const isJs   = ct.includes("javascript") || upstreamPath.endsWith(".js");
  const isCss  = ct.includes("css") || upstreamPath.endsWith(".css");

  // Strip headers that would block framing or scripts
  const safeHeaders = { "Content-Type": upstream.headers["content-type"] ?? "application/octet-stream" };
  // Deliberately omit: X-Frame-Options, Content-Security-Policy,
  // Strict-Transport-Security, X-Content-Type-Options (would break our rewrites)

  if (!isHtml && !isJs && !isCss) {
    // Binary pass-through (images, wasm, fonts, audio)
    safeHeaders["Cache-Control"] = "public, max-age=3600";
    res.writeHead(upstream.statusCode, safeHeaders);
    return res.end(upstream.body);
  }

  let text = upstream.body.toString("utf8");
  const base = targetUrl;

  if (isHtml) {
    text = rewriteHtml(text, base);
    if (bridgeHtml) {
      text = text.replace(/<\/head>/i, bridgeHtml + "</head>");
    }
    // Also post balance to parent frame on change
    const parentSync = `
<script data-fc-parent-sync>
(function(){
  var lastBal;
  setInterval(function(){
    var el = document.getElementById('BalanceValue');
    if(el && el.textContent !== lastBal){
      lastBal = el.textContent;
      try{ window.parent.postMessage({ type:'FC_BAL_UPDATE', bal: el.textContent.replace(/[^0-9]/g,'') }, '*'); }catch(e){}
    }
  }, 1000);
})();
</script>`;
    text = text.replace(/<\/body>/i, parentSync + "</body>");
  } else if (isJs) {
    text = rewriteJs(text);
  } else if (isCss) {
    text = rewriteCss(text, base);
  }

  res.writeHead(upstream.statusCode, safeHeaders);
  res.end(text);
}

/**
 * Tunnel a request to the Hacksaw RGS API (XHR/fetch from the game).
 * We pass through method, body, and relevant headers.
 */
async function proxyRgs(rgsPath, req, res) {
  let body = "";
  await new Promise(r => { req.on("data", c => body += c); req.on("end", r); });
  const targetUrl = HACKSAW_RGS + rgsPath;
  let upstream;
  try {
    upstream = await rawFetch(targetUrl, {
      method:  req.method,
      headers: {
        "Content-Type":  req.headers["content-type"] ?? "application/json",
        "Accept":        req.headers["accept"] ?? "application/json",
        "Authorization": req.headers["authorization"] ?? "",
        "Referer":       HACKSAW_STATIC + "/",
      },
      body,
    });
  } catch (e) {
    res.writeHead(502);
    return res.end("RGS proxy error: " + e.message);
  }
  const ct = upstream.headers["content-type"] ?? "application/json";
  res.writeHead(upstream.statusCode, {
    "Content-Type":                ct,
    "Access-Control-Allow-Origin": "*",
  });
  res.end(upstream.body);
}

/**
 * Tunnel a request to the Hacksaw Play API (partnerSettings, authenticate, etc.)
 * These live at https://play.hacksawgaming.com — a separate upstream from rgs-demo.
 */
async function proxyPlay(playPath, req, res) {
  let body = "";
  await new Promise(r => { req.on("data", c => body += c); req.on("end", r); });
  const targetUrl = HACKSAW_PLAY + playPath;
  let upstream;
  try {
    upstream = await rawFetch(targetUrl, {
      method:  req.method,
      headers: {
        "Content-Type":  req.headers["content-type"] ?? "application/json",
        "Accept":        req.headers["accept"] ?? "application/json",
        "Authorization": req.headers["authorization"] ?? "",
        "Origin":        HACKSAW_PLAY,
        "Referer":       HACKSAW_STATIC + "/",
      },
      body,
    });
  } catch (e) {
    res.writeHead(502);
    return res.end("Play proxy error: " + e.message);
  }
  const ct = upstream.headers["content-type"] ?? "application/json";
  res.writeHead(upstream.statusCode, {
    "Content-Type":                ct,
    "Access-Control-Allow-Origin": "*",
  });
  res.end(upstream.body);
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

    // ── HACKSAW STATIC PROXY ─────────────────────────────────────────────────
    // /proxy/<rest> → https://static-live.hacksawgaming.com/<rest>
    if (path.startsWith("/proxy/")) {
      const uid = this._uid(req);
      if (!uid) return this._redirect(res, "/login");
      const upstreamPath = path.slice("/proxy".length) + u.search;
      // Inject bridge only into the game's root HTML
      const isRoot = path.match(/\/proxy\/1309\/.*\/index\.html/);
      let bridgeHtml = null;
      if (isRoot) {
        const user = await this.db.getUser(uid);
        const bal  = Number(user?.bal ?? 0);
        bridgeHtml = buildBridgeScript(bal, 10);
      }
      return proxyStatic(upstreamPath, req, res, bridgeHtml);
    }

    // ── HACKSAW PLAY API TUNNEL ──────────────────────────────────────────────
    // /proxy-api/play/<rest> → https://play.hacksawgaming.com/play/<rest>
    // Must be checked BEFORE the generic /proxy-api/ catch-all below.
    if (path.startsWith("/proxy-api/play/")) {
      const uid = this._uid(req);
      if (!uid) return this._json(res, 401, { error: "Not logged in" });
      // Strip /proxy-api prefix; keep /play/... intact so upstream path is correct
      const playPath = path.slice("/proxy-api".length) + u.search;
      return proxyPlay(playPath, req, res);
    }

    // ── HACKSAW RGS TUNNEL ───────────────────────────────────────────────────
    // /proxy-api/<rest> → https://rgs-demo.hacksawgaming.com/<rest>
    if (path.startsWith("/proxy-api/")) {
      const uid = this._uid(req);
      if (!uid) return this._json(res, 401, { error: "Not logged in" });
      const rgsPath = path.slice("/proxy-api".length) + u.search;
      return proxyRgs(rgsPath, req, res);
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
