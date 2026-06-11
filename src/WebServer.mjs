import http from "http";
import https from "https";
import { URL } from "url";
import crypto from "crypto";

// ---------------------------------------------------------------------------
// Fluxer OAuth2  —  https://api.fluxer.app/v1
// Authorize : https://web.canary.fluxer.app/oauth2/authorize
// Token     : https://api.fluxer.app/v1/oauth2/token
// Me        : https://api.fluxer.app/v1/users/@me
// Scope     : identify guilds
// ---------------------------------------------------------------------------

const FLUXER_AUTH_URL  = "https://web.canary.fluxer.app/oauth2/authorize";
const FLUXER_TOKEN_URL = "https://api.fluxer.app/v1/oauth2/token";
const FLUXER_ME_URL    = "https://api.fluxer.app/v1/users/@me";

// ---- Server-side RNG (house edge kept here) --------------------------------
const SYMS    = ["\uD83C\uDF52","\uD83C\uDF4B","\uD83C\uDF4A","\uD83C\uDF47","\uD83D\uDD14","\u2B50","\uD83D\uDC8E","\uD83C\uDF1F"];
const WEIGHTS = [28, 22, 18, 13, 9, 5, 3, 2];
const PAYOUTS = {
  "\uD83C\uDF52": 1.5,  // cherry
  "\uD83C\uDF4B": 1.8,  // lemon
  "\uD83C\uDF4A": 2.2,  // orange
  "\uD83C\uDF47": 2.8,  // grape
  "\uD83D\uDD14": 3.5,  // bell
  "\u2B50":       6,    // star
  "\uD83D\uDC8E": 12,   // gem
  "\uD83C\uDF1F": 25,   // glowing star (jackpot)
};
const SCATTER = "\uD83D\uDD14"; // bell triggers bonus
const WILD    = "\u2B50";       // star is wild
const TOTAL_W = WEIGHTS.reduce((a,b)=>a+b,0);

function spinReel() {
  let r = Math.random() * TOTAL_W;
  for (let i=0; i<SYMS.length; i++) { r-=WEIGHTS[i]; if (r<=0) return SYMS[i]; }
  return SYMS[0];
}

function parseBody(req) {
  return new Promise(resolve=>{
    let d="";
    req.on("data",c=>d+=c);
    req.on("end",()=>{ try{resolve(Object.fromEntries(new URLSearchParams(d)));}catch{resolve({});} });
  });
}

function parseCookies(req) {
  const out={};
  for (const part of (req.headers.cookie??"").split(";")) {
    const idx=part.indexOf("="); if(idx<0)continue;
    out[decodeURIComponent(part.slice(0,idx).trim())]=decodeURIComponent(part.slice(idx+1).trim());
  }
  return out;
}

function nodeFetch(url,opts={}) {
  return new Promise((resolve,reject)=>{
    const parsed=new URL(url);
    const mod=parsed.protocol==="https:"?https:http;
    const body=opts.body??"";
    const headers={...(opts.headers??{}),"Content-Length":Buffer.byteLength(body)};
    const r=mod.request(
      {hostname:parsed.hostname,port:parsed.port||(parsed.protocol==="https:"?443:80),
       path:parsed.pathname+parsed.search,method:opts.method??"GET",headers},
      res=>{let d="";res.on("data",c=>d+=c);res.on("end",()=>resolve(d));}
    );
    r.on("error",reject); if(body)r.write(body); r.end();
  });
}

// ===========================================================================
// FULL GAME PAGE HTML
// ===========================================================================
const GAME_PAGE = (bal, tag, avatar) => {
  const av = avatar ? `<img class="avatar" src="${avatar}" alt="${tag}" loading="lazy">` : `<div class="avatar-placeholder">\uD83C\uDFB0</div>`;
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Le Bandit \u2014 SirGreen Casino</title>
<style>
/* ===== RESET ===== */
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{-webkit-font-smoothing:antialiased;scroll-behavior:smooth}
body{
  background:#060e06;
  color:#e2ffe2;
  font-family:'Segoe UI',system-ui,sans-serif;
  min-height:100vh;
  overflow-x:hidden;
  position:relative;
}

/* ===== AMBIENT BG ===== */
.ambient{
  position:fixed;inset:0;pointer-events:none;z-index:0;
  background:radial-gradient(ellipse 80% 60% at 50% 0%,#0d3b0d44 0%,transparent 70%),
             radial-gradient(ellipse 60% 40% at 20% 80%,#1a4a1a22 0%,transparent 60%),
             radial-gradient(ellipse 60% 40% at 80% 80%,#0b3b1a22 0%,transparent 60%);
}
.stars-bg{
  position:fixed;inset:0;pointer-events:none;z-index:0;
  background-image:
    radial-gradient(1px 1px at 10% 20%,#2ecc7144 0%,transparent 100%),
    radial-gradient(1px 1px at 30% 50%,#2ecc7133 0%,transparent 100%),
    radial-gradient(1px 1px at 60% 15%,#2ecc7155 0%,transparent 100%),
    radial-gradient(1px 1px at 80% 70%,#2ecc7144 0%,transparent 100%),
    radial-gradient(1px 1px at 50% 85%,#2ecc7133 0%,transparent 100%),
    radial-gradient(1px 1px at 90% 40%,#2ecc7122 0%,transparent 100%);
  animation:twinkle 4s ease-in-out infinite alternate;
}
@keyframes twinkle{0%{opacity:.4}100%{opacity:1}}

/* ===== LAYOUT ===== */
.wrap{
  position:relative;z-index:1;
  min-height:100vh;
  display:flex;
  flex-direction:column;
  align-items:center;
  justify-content:center;
  padding:1.5rem 1rem;
  gap:1rem;
}

/* ===== MARQUEE HEADER ===== */
.marquee-wrap{
  width:100%;overflow:hidden;
  background:linear-gradient(90deg,#0a1f0a,#122b12,#0a1f0a);
  border-top:2px solid #2ecc71;
  border-bottom:2px solid #2ecc71;
  padding:.35rem 0;
  box-shadow:0 0 20px #2ecc7144;
}
.marquee-inner{
  display:flex;gap:3rem;
  animation:marquee 18s linear infinite;
  white-space:nowrap;
  width:max-content;
}
@keyframes marquee{0%{transform:translateX(0)}100%{transform:translateX(-50%)}}
.marquee-item{
  font-size:.8rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;
  color:#2ecc71;text-shadow:0 0 10px #2ecc71aa;
}

/* ===== MACHINE CABINET ===== */
.machine{
  background:linear-gradient(160deg,#0e230e 0%,#071507 50%,#0e230e 100%);
  border:2px solid #2ecc7133;
  border-radius:24px;
  padding:1.5rem;
  width:100%;max-width:520px;
  box-shadow:
    0 0 0 1px #2ecc7111,
    0 0 40px #0a1f0a,
    inset 0 1px 0 #2ecc7122;
  position:relative;
  overflow:hidden;
}
.machine::before{
  content:'';
  position:absolute;top:0;left:0;right:0;height:1px;
  background:linear-gradient(90deg,transparent,#2ecc7188,transparent);
}

/* ===== HEADER PANEL ===== */
.panel-header{
  display:flex;align-items:center;justify-content:space-between;
  margin-bottom:1rem;
  gap:.75rem;
}
.user-info{
  display:flex;align-items:center;gap:.6rem;
  flex-shrink:0;
}
.avatar,
.avatar-placeholder{
  width:40px;height:40px;border-radius:50%;
  border:2px solid #2ecc71;
  box-shadow:0 0 10px #2ecc7155;
  object-fit:cover;
  font-size:1.4rem;
  display:flex;align-items:center;justify-content:center;
  background:#0d2b0d;
}
.username{font-size:.85rem;font-weight:700;color:#a8e6a8;max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.machine-title{
  text-align:center;flex:1;
}
.machine-title h1{
  font-size:1.5rem;font-weight:900;letter-spacing:.05em;
  color:#2ecc71;
  text-shadow:0 0 20px #2ecc71cc,0 0 40px #2ecc7166;
  line-height:1;
}
.machine-title .sub{
  font-size:.65rem;letter-spacing:.25em;text-transform:uppercase;
  color:#4a9a4a;margin-top:.15rem;
}
.header-right{
  display:flex;flex-direction:column;align-items:flex-end;gap:.3rem;flex-shrink:0;
}
.mute-btn{
  background:none;border:1px solid #2ecc7133;border-radius:6px;
  color:#4a9a4a;font-size:.85rem;padding:.25rem .5rem;
  cursor:pointer;transition:all .2s;
  white-space:nowrap;
}
.mute-btn:hover{border-color:#2ecc71;color:#2ecc71;box-shadow:0 0 8px #2ecc7133}
.logout-link{
  font-size:.7rem;color:#3a6b3a;text-decoration:none;
  border-bottom:1px solid #2ecc7122;
}
.logout-link:hover{color:#2ecc71}

/* ===== BALANCE DISPLAY ===== */
.balance-panel{
  background:#0a1f0a;
  border:1px solid #2ecc7122;
  border-radius:12px;
  padding:.6rem 1rem;
  margin-bottom:1rem;
  display:flex;align-items:center;justify-content:space-between;
  gap:1rem;
}
.bal-block{text-align:center}
.bal-label{
  font-size:.6rem;letter-spacing:.15em;text-transform:uppercase;
  color:#4a9a4a;margin-bottom:.1rem;
}
.bal-val{
  font-size:1.3rem;font-weight:900;
  color:#2ecc71;
  text-shadow:0 0 12px #2ecc7188;
  font-variant-numeric:tabular-nums;
  transition:transform .15s;
}
.bal-val.bump{animation:balBump .3s ease-out}
@keyframes balBump{0%{transform:scale(1)}50%{transform:scale(1.18)}100%{transform:scale(1)}}
.divider-v{width:1px;height:40px;background:#2ecc7122}

/* ===== BONUS BADGE ===== */
.bonus-badge{
  display:none;position:absolute;top:.5rem;right:.5rem;
  background:linear-gradient(135deg,#f39c12,#e74c3c);
  color:#fff;font-size:.65rem;font-weight:900;
  letter-spacing:.1em;text-transform:uppercase;
  padding:.25rem .6rem;border-radius:20px;
  box-shadow:0 0 15px #f39c1299;
  animation:pulseBadge 1s ease-in-out infinite;
}
.bonus-badge.show{display:block}
@keyframes pulseBadge{0%,100%{box-shadow:0 0 10px #f39c1299}50%{box-shadow:0 0 25px #f39c12cc}}

/* ===== REEL WINDOW ===== */
.reel-window{
  background:#040d04;
  border:2px solid #2ecc7133;
  border-radius:16px;
  padding:.75rem;
  margin-bottom:1rem;
  position:relative;
  box-shadow:inset 0 4px 20px #000a,0 0 30px #2ecc7111;
}
.reel-window::before,.reel-window::after{
  content:'';
  position:absolute;left:0;right:0;height:35%;
  pointer-events:none;z-index:2;
}
.reel-window::before{top:0;background:linear-gradient(to bottom,#040d04ee,transparent)}
.reel-window::after{bottom:0;background:linear-gradient(to top,#040d04ee,transparent)}

.reels-row{
  display:flex;gap:.6rem;justify-content:center;align-items:center;
  height:130px;overflow:hidden;position:relative;z-index:1;
}

.reel{
  flex:1;max-width:120px;
  height:130px;
  position:relative;
  overflow:hidden;
  border-radius:10px;
  background:#050e05;
  border:1px solid #2ecc7122;
  box-shadow:inset 0 0 15px #0008;
}
.reel-strip{
  display:flex;
  flex-direction:column;
  position:absolute;
  top:0;left:0;right:0;
  transition:transform cubic-bezier(.17,.67,.12,1) 0ms;
}
.reel-sym{
  height:130px;
  display:flex;align-items:center;justify-content:center;
  font-size:3.2rem;
  user-select:none;
  flex-shrink:0;
}
.reel-sym.highlight{
  animation:symGlow .4s ease-out forwards;
}
@keyframes symGlow{
  0%{text-shadow:none;transform:scale(1)}
  50%{text-shadow:0 0 30px #2ecc71cc,0 0 60px #2ecc7166;transform:scale(1.15)}
  100%{text-shadow:0 0 15px #2ecc7188;transform:scale(1.08)}
}

/* payline flash */
.payline{
  position:absolute;top:50%;left:0;right:0;height:3px;
  transform:translateY(-50%);
  background:linear-gradient(90deg,transparent,#2ecc71,transparent);
  opacity:0;z-index:3;
  pointer-events:none;
}
.payline.flash{animation:payFlash .6s ease-out forwards}
@keyframes payFlash{
  0%{opacity:0;height:3px}
  20%{opacity:1;height:5px}
  80%{opacity:1;height:5px}
  100%{opacity:0;height:3px}
}
.payline.jackpot{background:linear-gradient(90deg,transparent,#f1c40f,transparent)}

/* ===== WIN OVERLAY ===== */
.win-overlay{
  position:absolute;inset:0;border-radius:14px;
  display:flex;flex-direction:column;
  align-items:center;justify-content:center;
  pointer-events:none;opacity:0;z-index:10;
  background:radial-gradient(ellipse at center,#2ecc7122 0%,transparent 70%);
  transition:opacity .3s;
}
.win-overlay.show{opacity:1}
.win-overlay-text{
  font-size:2.2rem;font-weight:900;
  color:#2ecc71;
  text-shadow:0 0 30px #2ecc71,0 0 60px #2ecc7188;
  animation:winTextPop .5s cubic-bezier(.17,.67,.12,1.5);
}
.win-overlay-text.jackpot-text{color:#f1c40f;text-shadow:0 0 30px #f1c40f,0 0 60px #f1c40f88}
@keyframes winTextPop{0%{transform:scale(.5);opacity:0}100%{transform:scale(1);opacity:1}}
.win-delta{
  font-size:1.2rem;font-weight:700;color:#a8e6a8;margin-top:.3rem;
  animation:fadeUp .4s .1s ease-out both;
}
@keyframes fadeUp{0%{transform:translateY(10px);opacity:0}100%{transform:translateY(0);opacity:1}}

/* ===== MULTIPLIER BANNER ===== */
.mult-banner{
  display:none;text-align:center;
  font-size:.9rem;font-weight:700;
  color:#f39c12;
  text-shadow:0 0 10px #f39c12;
  margin-bottom:.5rem;
  animation:multPop .4s cubic-bezier(.17,.67,.12,1.5);
}
.mult-banner.show{display:block}
@keyframes multPop{0%{transform:scale(0);opacity:0}100%{transform:scale(1);opacity:1}}

/* ===== RESULT LINE ===== */
.result-line{
  text-align:center;font-size:.95rem;font-weight:600;
  min-height:1.5rem;margin-bottom:.75rem;
  transition:all .2s;
}
.result-line.win{color:#2ecc71;text-shadow:0 0 10px #2ecc7166}
.result-line.loss{color:#e74c3c}
.result-line.bonus{color:#f39c12;text-shadow:0 0 10px #f39c1266}
.result-line.jackpot{color:#f1c40f;text-shadow:0 0 15px #f1c40faa;animation:jackpotFlash 1s ease-in-out infinite}
@keyframes jackpotFlash{0%,100%{opacity:1}50%{opacity:.6}}

/* ===== BET CONTROLS ===== */
.bet-row{
  display:flex;gap:.5rem;align-items:center;margin-bottom:.75rem;
}
.bet-label{
  font-size:.65rem;letter-spacing:.15em;text-transform:uppercase;
  color:#4a9a4a;white-space:nowrap;
}
.bet-input-wrap{
  position:relative;flex:1;
}
babel.bet-input-wrap input{padding-right:3rem}
input[type=number]{
  width:100%;
  background:#0a1f0a;
  border:1px solid #2ecc7133;
  border-radius:8px;
  color:#e2ffe2;
  padding:.55rem .75rem;
  font-size:1rem;font-weight:700;
  text-align:center;
  -moz-appearance:textfield;
  transition:border-color .2s,box-shadow .2s;
}
input[type=number]::-webkit-outer-spin-button,
input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none}
input[type=number]:focus{outline:none;border-color:#2ecc71;box-shadow:0 0 0 3px #2ecc7122}
.bet-presets{
  display:flex;gap:.35rem;margin-bottom:.75rem;flex-wrap:wrap;justify-content:center;
}
.preset-btn{
  background:#0a1f0a;border:1px solid #2ecc7133;
  color:#4a9a4a;font-size:.72rem;font-weight:700;
  padding:.3rem .55rem;border-radius:6px;
  cursor:pointer;transition:all .15s;
  letter-spacing:.03em;
}
.preset-btn:hover{background:#122b12;border-color:#2ecc71;color:#2ecc71;box-shadow:0 0 8px #2ecc7122}
.preset-btn:active{transform:scale(.95)}

/* ===== SPIN BUTTON ===== */
.spin-btn{
  width:100%;padding:.85rem;
  background:linear-gradient(135deg,#27ae60,#2ecc71);
  color:#060e06;
  border:none;border-radius:12px;
  font-size:1.15rem;font-weight:900;
  letter-spacing:.05em;text-transform:uppercase;
  cursor:pointer;
  box-shadow:0 4px 20px #2ecc7144,inset 0 1px 0 #2ecc71aa;
  transition:all .15s;
  position:relative;overflow:hidden;
}
.spin-btn::before{
  content:'';
  position:absolute;top:-50%;left:-60%;width:40%;height:200%;
  background:linear-gradient(100deg,transparent,#ffffff22,transparent);
  transform:skewX(-15deg);
  animation:btnShine 3s ease-in-out infinite;
}
@keyframes btnShine{0%,100%{left:-60%}50%{left:120%}}
.spin-btn:hover:not(:disabled){background:linear-gradient(135deg,#2ecc71,#39d97a);box-shadow:0 6px 28px #2ecc7166;transform:translateY(-1px)}
.spin-btn:active:not(:disabled){transform:translateY(1px);box-shadow:0 2px 12px #2ecc7133}
.spin-btn:disabled{opacity:.5;cursor:not-allowed;animation:none}
.spin-btn:disabled::before{display:none}

/* ===== BONUS SPINS PANEL ===== */
.bonus-panel{
  display:none;
  background:linear-gradient(135deg,#1a0a00,#2a1200);
  border:2px solid #f39c12;
  border-radius:12px;
  padding:.75rem;
  margin-bottom:.75rem;
  text-align:center;
  box-shadow:0 0 20px #f39c1233;
  animation:bonusPanelIn .4s cubic-bezier(.17,.67,.12,1.5);
}
.bonus-panel.show{display:block}
@keyframes bonusPanelIn{0%{transform:scaleY(0);opacity:0}100%{transform:scaleY(1);opacity:1}}
.bonus-title{
  font-size:.75rem;font-weight:900;letter-spacing:.2em;text-transform:uppercase;
  color:#f39c12;text-shadow:0 0 10px #f39c12;margin-bottom:.3rem;
}
.bonus-count{
  font-size:2rem;font-weight:900;color:#fff;
  text-shadow:0 0 20px #f39c12;
}
.bonus-sub{font-size:.7rem;color:#c0813a;margin-top:.2rem}

/* ===== PAYTABLE ===== */
.paytable-toggle{
  background:none;border:1px solid #2ecc7122;
  color:#3a6b3a;font-size:.7rem;padding:.3rem .7rem;
  border-radius:6px;cursor:pointer;width:100%;margin-top:.5rem;
  transition:all .2s;
}
.paytable-toggle:hover{border-color:#2ecc7144;color:#4a9a4a}
.paytable{
  display:none;
  background:#040d04;
  border:1px solid #2ecc7122;
  border-radius:10px;
  padding:.75rem;
  margin-top:.5rem;
  font-size:.75rem;
}
.paytable.open{display:block}
.paytable-row{
  display:flex;justify-content:space-between;align-items:center;
  padding:.25rem 0;
  border-bottom:1px solid #2ecc7111;
}
.paytable-row:last-child{border-bottom:none}
.pt-sym{font-size:1.1rem}
.pt-mult{color:#2ecc71;font-weight:700}
.pt-note{color:#4a9a4a;font-size:.65rem}

/* ===== FOOTER ===== */
.game-footer{
  font-size:.65rem;color:#2a4a2a;text-align:center;
  line-height:1.7;margin-top:.5rem;
}

/* ===== CONFETTI ===== */
.confetti-container{
  position:fixed;inset:0;pointer-events:none;z-index:100;overflow:hidden;
}
.confetti-piece{
  position:absolute;
  width:8px;height:8px;
  border-radius:1px;
  opacity:0;
  animation:confettiFall var(--dur,2s) var(--delay,0s) ease-in forwards;
}
@keyframes confettiFall{
  0%{transform:translateY(-20px) rotate(0deg);opacity:1}
  100%{transform:translateY(110vh) rotate(720deg);opacity:0}
}

/* ===== WIN FLASH ===== */
@keyframes flashScreen{
  0%,100%{background:#060e06}
  25%{background:#0f2b0f}
  50%{background:#060e06}
  75%{background:#0f2b0f}
}
.flash-win{animation:flashScreen .4s ease-in-out}

/* ===== RESPONSIVE ===== */
@media(max-width:400px){
  .reel-sym{font-size:2.4rem}
  .reels-row{height:100px}
  .reel{height:100px}
  .reel-sym{height:100px}
  .machine{padding:1rem}
  .machine-title h1{font-size:1.25rem}
}
</style>
</head>
<body>
<div class="ambient"></div>
<div class="stars-bg"></div>

<!-- MARQUEE -->
<div class="marquee-wrap">
  <div class="marquee-inner" id="marqueeInner">
    <!-- filled by JS -->
  </div>
</div>

<div class="wrap">
<div class="machine" id="machine">
  <div class="bonus-badge" id="bonusBadge">\uD83C\uDF1F BONUS ACTIVE</div>

  <!-- HEADER -->
  <div class="panel-header">
    <div class="user-info">
      ${av}
      <span class="username">${tag}</span>
    </div>
    <div class="machine-title">
      <h1>\u2665 Le Bandit</h1>
      <div class="sub">SirGreen Casino</div>
    </div>
    <div class="header-right">
      <button class="mute-btn" id="muteBtn" onclick="toggleMute()">\uD83D\uDD0A SFX</button>
      <a class="logout-link" href="/logout">logout</a>
    </div>
  </div>

  <!-- BALANCE -->
  <div class="balance-panel">
    <div class="bal-block">
      <div class="bal-label">Balance</div>
      <div class="bal-val" id="bal">${Number(bal).toLocaleString()} FC</div>
    </div>
    <div class="divider-v"></div>
    <div class="bal-block">
      <div class="bal-label">Last Win</div>
      <div class="bal-val" id="lastWin" style="color:#4a9a4a">\u2014</div>
    </div>
    <div class="divider-v"></div>
    <div class="bal-block">
      <div class="bal-label">Streak</div>
      <div class="bal-val" id="streak" style="color:#4a9a4a">0</div>
    </div>
  </div>

  <!-- BONUS SPINS -->
  <div class="bonus-panel" id="bonusPanel">
    <div class="bonus-title">\uD83C\uDF1F Bonus Spins</div>
    <div class="bonus-count" id="bonusCount">0</div>
    <div class="bonus-sub">Free spins with 2x multiplier!</div>
  </div>

  <!-- MULTIPLIER BANNER -->
  <div class="mult-banner" id="multBanner"></div>

  <!-- REELS -->
  <div class="reel-window">
    <div class="reels-row">
      <div class="reel" id="reel0"><div class="reel-strip" id="strip0"></div></div>
      <div class="reel" id="reel1"><div class="reel-strip" id="strip1"></div></div>
      <div class="reel" id="reel2"><div class="reel-strip" id="strip2"></div></div>
    </div>
    <div class="payline" id="payline"></div>
    <div class="win-overlay" id="winOverlay">
      <div class="win-overlay-text" id="winText"></div>
      <div class="win-delta" id="winDelta"></div>
    </div>
  </div>

  <!-- RESULT -->
  <div class="result-line" id="result"></div>

  <!-- BET -->
  <div class="bet-row">
    <span class="bet-label">Bet</span>
    <input type="number" id="bet" min="1" max="1000000" value="100">
  </div>
  <div class="bet-presets">
    <button class="preset-btn" onclick="setBet(50)">50</button>
    <button class="preset-btn" onclick="setBet(100)">100</button>
    <button class="preset-btn" onclick="setBet(500)">500</button>
    <button class="preset-btn" onclick="setBet(1000)">1K</button>
    <button class="preset-btn" onclick="setBet(5000)">5K</button>
    <button class="preset-btn" onclick="setBet(10000)">10K</button>
    <button class="preset-btn" onclick="betMax()">MAX</button>
  </div>

  <!-- SPIN -->
  <button class="spin-btn" id="spinBtn" onclick="doSpin()">
    \uD83C\uDFB0 &nbsp;SPIN
  </button>

  <!-- PAYTABLE -->
  <button class="paytable-toggle" onclick="togglePaytable()">\u25BC Paytable</button>
  <div class="paytable" id="paytable">
    <div class="paytable-row"><span class="pt-sym">\uD83C\uDF1F\uD83C\uDF1F\uD83C\uDF1F</span><span class="pt-mult">25x</span><span class="pt-note">JACKPOT!</span></div>
    <div class="paytable-row"><span class="pt-sym">\uD83D\uDC8E\uD83D\uDC8E\uD83D\uDC8E</span><span class="pt-mult">12x</span><span class="pt-note"></span></div>
    <div class="paytable-row"><span class="pt-sym">\u2B50\u2B50\u2B50</span><span class="pt-mult">6x</span><span class="pt-note">Wild</span></div>
    <div class="paytable-row"><span class="pt-sym">\uD83D\uDD14\uD83D\uDD14\uD83D\uDD14</span><span class="pt-mult">3.5x</span><span class="pt-note">+Bonus Spins</span></div>
    <div class="paytable-row"><span class="pt-sym">\uD83C\uDF47\uD83C\uDF47\uD83C\uDF47</span><span class="pt-mult">2.8x</span><span class="pt-note"></span></div>
    <div class="paytable-row"><span class="pt-sym">\uD83C\uDF4A\uD83C\uDF4A\uD83C\uDF4A</span><span class="pt-mult">2.2x</span><span class="pt-note"></span></div>
    <div class="paytable-row"><span class="pt-sym">\uD83C\uDF4B\uD83C\uDF4B\uD83C\uDF4B</span><span class="pt-mult">1.8x</span><span class="pt-note"></span></div>
    <div class="paytable-row"><span class="pt-sym">\uD83C\uDF52\uD83C\uDF52\uD83C\uDF52</span><span class="pt-mult">1.5x</span><span class="pt-note"></span></div>
    <div class="paytable-row"><span class="pt-sym">Any pair</span><span class="pt-mult">-60%</span><span class="pt-note">partial</span></div>
    <div class="paytable-row"><span class="pt-sym">\u2B50 Wild</span><span class="pt-mult"></span><span class="pt-note">Substitutes any</span></div>
    <div class="paytable-row"><span class="pt-sym">3x \uD83D\uDD14 Scatter</span><span class="pt-mult"></span><span class="pt-note">Triggers 7 bonus spins</span></div>
  </div>

  <div class="game-footer">
    FluxCoins &middot; Global economy &middot; House edge applies &middot; SirGreen Casino
  </div>
</div>
</div>

<!-- CONFETTI -->
<div class="confetti-container" id="confettiContainer"></div>

<script>
// ===== AUDIO ENGINE (Web Audio API) =====
let audioCtx = null;
let muted = false;

function getCtx() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e){}
  }
  return audioCtx;
}

function playTone(freq, type, dur, vol=0.18, attack=0.01, decay=0.05) {
  if (muted) return;
  const ctx = getCtx(); if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain); gain.connect(ctx.destination);
  osc.type = type;
  osc.frequency.setValueAtTime(freq, ctx.currentTime);
  gain.gain.setValueAtTime(0, ctx.currentTime);
  gain.gain.linearRampToValueAtTime(vol, ctx.currentTime + attack);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + dur);
}

function playClickSound() {
  playTone(440,'square',.06,.1);
}

function playReelTickSound(i) {
  const freqs = [180, 200, 220];
  playTone(freqs[i],'sawtooth',.04,.06);
}

function playReelStopSound(i) {
  const freqs = [300,350,400];
  playTone(freqs[i],'square',.12,.12);
}

function playWinSound(type) {
  if (muted) return;
  const ctx = getCtx(); if (!ctx) return;
  if (type === 'jackpot') {
    const notes = [523,659,784,1047];
    notes.forEach((f,i)=>{
      setTimeout(()=>playTone(f,'square',.3,.2),i*120);
    });
  } else if (type === 'big') {
    const notes = [440,554,659];
    notes.forEach((f,i)=>{
      setTimeout(()=>playTone(f,'triangle',.25,.18),i*100);
    });
  } else {
    playTone(523,'triangle',.18,.15);
    setTimeout(()=>playTone(659,'triangle',.18,.15),80);
  }
}

function playLossSound() {
  playTone(180,'sawtooth',.2,.08);
  setTimeout(()=>playTone(140,'sawtooth',.2,.08),100);
}

function playBonusSound() {
  if (muted) return;
  const ctx = getCtx(); if (!ctx) return;
  [330,440,550,660,770].forEach((f,i)=>{
    setTimeout(()=>playTone(f,'sine',.2,.15),i*80);
  });
}

function toggleMute() {
  muted = !muted;
  document.getElementById('muteBtn').textContent = muted ? '\uD83D\uDD07 SFX' : '\uD83D\uDD0A SFX';
}

document.addEventListener('click', ()=>{ const c=getCtx(); if(c&&c.state==='suspended')c.resume(); }, {once:true});

// ===== MARQUEE =====
const MARQUEE_ITEMS = [
  '\uD83C\uDF1F Jackpot: 25x', '\uD83D\uDC8E Gem: 12x', '\u2B50 Wild Star', '\uD83D\uDD14 3x Bells = Bonus',
  '\uD83C\uDFB0 Le Bandit', 'SirGreen Casino', 'FluxCoins Economy',
  '\uD83C\uDF1F Jackpot: 25x', '\uD83D\uDC8E Gem: 12x', '\u2B50 Wild Star', '\uD83D\uDD14 3x Bells = Bonus',
  '\uD83C\uDFB0 Le Bandit', 'SirGreen Casino', 'FluxCoins Economy',
];
document.getElementById('marqueeInner').innerHTML =
  MARQUEE_ITEMS.map(function(t){ return '<span class="marquee-item">'+t+'</span>'; }).join('');

// ===== REEL SYMBOLS (shown in strips) =====
const SYMS = ['\uD83C\uDF52','\uD83C\uDF4B','\uD83C\uDF4A','\uD83C\uDF47','\uD83D\uDD14','\u2B50','\uD83D\uDC8E','\uD83C\uDF1F'];
const SYM_STRIP_COUNT = 30;

function buildStrips() {
  for (let i=0;i<3;i++) {
    const strip = document.getElementById('strip'+i);
    strip.innerHTML = '';
    for (let j=0;j<SYM_STRIP_COUNT;j++) {
      const sym = SYMS[Math.floor(Math.random()*SYMS.length)];
      const el = document.createElement('div');
      el.className = 'reel-sym';
      el.textContent = sym;
      strip.appendChild(el);
    }
  }
}
buildStrips();

// ===== REEL ANIMATION =====
const REEL_H = 130;
let reelAnimations = [null,null,null];

function animateReel(reelIdx, finalSym, delay, onDone) {
  const strip = document.getElementById('strip'+reelIdx);
  const syms = strip.querySelectorAll('.reel-sym');
  const totalH = (syms.length-1) * REEL_H;

  syms[0].textContent = finalSym;

  const spinDur = 600 + delay * 300;
  const ticks = Math.floor(spinDur / 60);
  let tick = 0;
  let offset = -(ticks * REEL_H * 0.8 % totalH);

  strip.style.transition = 'none';
  strip.style.transform = 'translateY('+(-totalH/2)+'px)';

  let tickInterval;
  setTimeout(function(){
    tickInterval = setInterval(function(){
      tick++;
      offset += REEL_H * 0.9;
      if (offset > 0) offset -= totalH;
      strip.style.transition = 'none';
      strip.style.transform = 'translateY('+offset+'px)';
      playReelTickSound(reelIdx);
      if (tick >= ticks) {
        clearInterval(tickInterval);
        strip.style.transition = 'transform 180ms cubic-bezier(.17,.67,.12,1)';
        strip.style.transform = 'translateY(0px)';
        setTimeout(function(){
          playReelStopSound(reelIdx);
          if (onDone) onDone();
        }, 200);
      }
    }, 60);
  }, delay);
}

// ===== STATE =====
let bonusSpins = 0;
let streak = 0;
let multiplier = 1;

// ===== HELPERS =====
function setBet(v){
  document.getElementById('bet').value = v;
  playClickSound();
}
function betMax(){
  const b = parseInt(document.getElementById('bal').textContent.replace(/[^\d]/g,'')) || 0;
  document.getElementById('bet').value = Math.min(b, 1000000);
  playClickSound();
}
function togglePaytable(){
  const pt = document.getElementById('paytable');
  const btn = document.querySelector('.paytable-toggle');
  pt.classList.toggle('open');
  btn.textContent = pt.classList.contains('open') ? '\u25B2 Paytable' : '\u25BC Paytable';
}

// ===== CONFETTI =====
const CONFETTI_COLORS = ['#2ecc71','#f1c40f','#e74c3c','#3498db','#9b59b6','#1abc9c','#f39c12'];
function launchConfetti(count) {
  count = count || 60;
  const container = document.getElementById('confettiContainer');
  container.innerHTML = '';
  for (let i=0;i<count;i++) {
    const el = document.createElement('div');
    el.className = 'confetti-piece';
    el.style.cssText = [
      'left:'+Math.random()*100+'vw',
      'background:'+CONFETTI_COLORS[Math.floor(Math.random()*CONFETTI_COLORS.length)],
      '--dur:'+(1.5+Math.random()*2)+'s',
      '--delay:'+(Math.random()*.8)+'s',
      'width:'+(6+Math.random()*8)+'px',
      'height:'+(6+Math.random()*8)+'px',
      'border-radius:'+(Math.random()>0.5?'50%':'2px'),
      'transform:rotate('+(Math.random()*360)+'deg)',
    ].join(';');
    container.appendChild(el);
  }
  setTimeout(function(){container.innerHTML='';},3500);
}

// ===== WIN OVERLAY =====
function showWinOverlay(text, delta, isJackpot) {
  const ov = document.getElementById('winOverlay');
  const wt = document.getElementById('winText');
  const wd = document.getElementById('winDelta');
  wt.className = 'win-overlay-text' + (isJackpot ? ' jackpot-text' : '');
  wt.textContent = text;
  wd.textContent = '+' + delta.toLocaleString() + ' FC';
  ov.classList.add('show');
  setTimeout(function(){ov.classList.remove('show');}, 2500);
}

// ===== PAYLINE FLASH =====
function flashPayline(isJackpot) {
  const pl = document.getElementById('payline');
  pl.className = 'payline ' + (isJackpot ? 'jackpot' : '') + ' flash';
  setTimeout(function(){pl.className='payline';}, 700);
}

// ===== BALANCE BUMP =====
function bumpBal(newBal) {
  const el = document.getElementById('bal');
  const start = parseInt(el.textContent.replace(/[^\d]/g,'')) || 0;
  const diff = newBal - start;
  const dur = 800;
  const step = 16;
  const steps = dur/step;
  let i=0;
  const interval = setInterval(function(){
    i++;
    const cur = Math.round(start + diff*(i/steps));
    el.textContent = cur.toLocaleString() + ' FC';
    if(i>=steps){clearInterval(interval);el.textContent=newBal.toLocaleString()+' FC';}
  },step);
  el.classList.add('bump');
  setTimeout(function(){el.classList.remove('bump');},400);
}

// ===== STREAK =====
function updateStreak(won) {
  if (won) streak++; else streak=0;
  const el = document.getElementById('streak');
  el.textContent = streak;
  el.style.color = streak>=3 ? '#f1c40f' : streak>0 ? '#2ecc71' : '#4a9a4a';
}

// ===== MULTIPLIER =====
function getMultiplier() {
  if (bonusSpins > 0) return 2;
  if (streak >= 5) return 1.5;
  if (streak >= 3) return 1.25;
  return 1;
}
function showMultiplier(mult) {
  if (mult <= 1) { document.getElementById('multBanner').classList.remove('show'); return; }
  const b = document.getElementById('multBanner');
  b.textContent = '\u2605 '+mult+'x Multiplier Active!';
  b.classList.add('show');
  setTimeout(function(){b.classList.remove('show');}, 3000);
}

// ===== BONUS PANEL =====
function updateBonusPanel() {
  const panel = document.getElementById('bonusPanel');
  const badge = document.getElementById('bonusBadge');
  const count = document.getElementById('bonusCount');
  if (bonusSpins > 0) {
    panel.classList.add('show');
    badge.classList.add('show');
    count.textContent = bonusSpins;
  } else {
    panel.classList.remove('show');
    badge.classList.remove('show');
  }
}

// ===== MAIN SPIN =====
let spinning = false;

async function doSpin() {
  if (spinning) return;
  const btn = document.getElementById('spinBtn');
  const betEl = document.getElementById('bet');
  const bet = parseInt(betEl.value);
  if (isNaN(bet) || bet < 1) { shakeInput(); return; }
  playClickSound();

  const isBonusSpin = bonusSpins > 0;

  spinning = true;
  btn.disabled = true;
  btn.textContent = '\u231B Spinning...';
  document.getElementById('result').textContent = '';
  document.getElementById('result').className = 'result-line';

  const mult = getMultiplier();
  showMultiplier(mult);

  const fetchBody = isBonusSpin
    ? 'bet='+bet+'&bonus=1'
    : 'bet='+bet;

  let d;
  try {
    const res = await fetch('/spin', {
      method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body: fetchBody,
    });
    d = await res.json();
  } catch(e) {
    showError('Network error. Try again.');
    spinning=false; btn.disabled=false; btn.textContent='\uD83C\uDFB0 SPIN'; return;
  }

  if (d.error) {
    showError(d.error);
    spinning=false; btn.disabled=false; btn.textContent='\uD83C\uDFB0 SPIN'; return;
  }

  let doneCount = 0;
  d.reels.forEach(function(sym, i) {
    animateReel(i, sym, i * 280, function() {
      doneCount++;
      if (doneCount === 3) finishSpin(d, isBonusSpin, mult);
    });
  });
}

function finishSpin(d, isBonusSpin, mult) {
  const isWin    = d.delta > 0;
  const isJackpot = d.jackpot;
  const isBonus  = d.bonus_triggered;
  const resultEl = document.getElementById('result');

  if (isBonusSpin) {
    bonusSpins = Math.max(0, bonusSpins - 1);
    updateBonusPanel();
  }

  if (isBonus) {
    bonusSpins += 7;
    updateBonusPanel();
    playBonusSound();
    setTimeout(function(){
      resultEl.className='result-line bonus';
      resultEl.textContent='\uD83D\uDD14 BONUS ACTIVATED! 7 Free Spins with 2x multiplier!';
    }, 400);
    launchConfetti(40);
  }

  if (isWin) {
    flashPayline(isJackpot);
    const displayDelta = Math.round(d.delta * mult);
    updateStreak(true);

    if (isJackpot) {
      document.getElementById('machine').classList.add('flash-win');
      setTimeout(function(){document.getElementById('machine').classList.remove('flash-win');},500);
      showWinOverlay('JACKPOT!', displayDelta, true);
      playWinSound('jackpot');
      launchConfetti(120);
      resultEl.className='result-line jackpot';
      resultEl.textContent='\uD83C\uDF1F JACKPOT! '+displayDelta.toLocaleString()+' FC  '+d.msg;
    } else {
      showWinOverlay('WIN!', displayDelta, false);
      playWinSound(displayDelta > 500 ? 'big' : 'small');
      if (displayDelta > 1000) launchConfetti(60);
      resultEl.className='result-line win';
      resultEl.textContent='\u2705 +'+displayDelta.toLocaleString()+' FC \u2014 '+d.msg;
    }
    document.getElementById('lastWin').textContent = displayDelta.toLocaleString()+' FC';
    document.getElementById('lastWin').style.color = '#2ecc71';
  } else {
    playLossSound();
    updateStreak(false);
    resultEl.className='result-line loss';
    resultEl.textContent = d.delta < 0
      ? '\u274C \u2212'+Math.abs(d.delta).toLocaleString()+' FC \u2014 '+d.msg
      : d.msg;
  }

  bumpBal(d.bal);

  const btn = document.getElementById('spinBtn');
  const label = bonusSpins > 0 ? '\uD83C\uDF1F BONUS SPIN!' : '\uD83C\uDFB0 SPIN';
  btn.textContent = label;
  btn.disabled = false;
  spinning = false;
}

function showError(msg) {
  const r = document.getElementById('result');
  r.className='result-line loss';
  r.textContent = '\u274C '+msg;
  document.getElementById('spinBtn').textContent='\uD83C\uDFB0 SPIN';
}

function shakeInput() {
  const el = document.getElementById('bet');
  el.style.animation='none';
  el.offsetHeight;
  el.style.animation='shake .3s ease-in-out';
}

document.addEventListener('keydown',function(e){
  if (e.code==='Space' && document.activeElement.tagName!=='INPUT') {
    e.preventDefault(); doSpin();
  }
});

(function initReels(){
  for(let i=0;i<3;i++){
    const strip=document.getElementById('strip'+i);
    if(strip.children[0]) strip.children[0].textContent=SYMS[0];
    strip.style.transform='translateY(0)';
  }
})();
</script>
</body>
</html>`;
};

// ===========================================================================
// LOGIN PAGE
// ===========================================================================
const LOGIN_PAGE = (authUrl) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Le Bandit \u2014 Login</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{
  background:#060e06;
  color:#e2ffe2;
  font-family:'Segoe UI',system-ui,sans-serif;
  min-height:100vh;
  display:flex;flex-direction:column;
  align-items:center;justify-content:center;
  padding:1rem;
}
.bg{position:fixed;inset:0;pointer-events:none;
  background:radial-gradient(ellipse 80% 60% at 50% 30%,#0d3b0d44 0%,transparent 70%);}
.card{
  position:relative;z-index:1;
  background:linear-gradient(160deg,#0e230e,#071507);
  border:2px solid #2ecc7133;
  border-radius:20px;
  padding:2.5rem 2rem;
  max-width:400px;width:100%;
  text-align:center;
  box-shadow:0 0 60px #2ecc7111,inset 0 1px 0 #2ecc7122;
}
.logo{font-size:3.5rem;margin-bottom:.5rem;text-shadow:0 0 30px #2ecc7188;}
h1{
  font-size:2rem;font-weight:900;color:#2ecc71;
  text-shadow:0 0 20px #2ecc71cc,0 0 40px #2ecc7166;
  margin-bottom:.25rem;
}
.sub{font-size:.75rem;letter-spacing:.25em;text-transform:uppercase;color:#4a9a4a;margin-bottom:1.5rem;}
desc{font-size:.9rem;color:#a8d5a8;display:block;margin-bottom:1.5rem;line-height:1.6}
.btn{
  display:inline-flex;align-items:center;justify-content:center;gap:.6rem;
  background:linear-gradient(135deg,#27ae60,#2ecc71);
  color:#060e06;font-size:1rem;font-weight:900;
  text-decoration:none;padding:.85rem 2rem;
  border-radius:12px;letter-spacing:.04em;
  box-shadow:0 4px 20px #2ecc7144;
  transition:all .18s;
  width:100%;
}
.btn:hover{background:linear-gradient(135deg,#2ecc71,#39d97a);box-shadow:0 6px 30px #2ecc7166;transform:translateY(-1px);}
.footer{margin-top:1.5rem;font-size:.7rem;color:#2a4a2a;line-height:1.7}
</style>
</head>
<body>
<div class="bg"></div>
<div class="card">
  <div class="logo">\uD83C\uDFB0</div>
  <h1>Le Bandit</h1>
  <div class="sub">SirGreen Casino</div>
  <desc>Login with your <strong style="color:#2ecc71">Fluxer</strong> account to access your FluxCoin balance.</desc>
  <a class="btn" href="${authUrl}">\uD83D\uDFE2&nbsp; Login with Fluxer</a>
  <div class="footer">Your balance is global across all Fluxer servers.<br>House edge applies. Spin responsibly.</div>
</div>
</body>
</html>`;

// ===========================================================================
// SIMPLE WRAPPER PAGE (errors etc)
// ===========================================================================
const PAGE = (body) => `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Le Bandit</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#060e06;color:#e2ffe2;font-family:'Segoe UI',system-ui,sans-serif;
min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
.card{background:#0e230e;border:2px solid #2ecc7133;border-radius:16px;
padding:2rem;max-width:420px;width:100%;text-align:center;
box-shadow:0 0 40px #2ecc7111}
h1{color:#2ecc71;font-size:1.5rem;margin-bottom:1rem}
p{color:#a8d5a8;margin-bottom:1rem;line-height:1.6}
.btn{display:inline-flex;align-items:center;justify-content:center;
background:linear-gradient(135deg,#27ae60,#2ecc71);color:#060e06;
font-weight:900;text-decoration:none;padding:.75rem 1.5rem;
border-radius:10px;margin-top:.75rem;border:none;cursor:pointer;
font-size:.9rem;transition:all .18s}
.btn:hover{transform:translateY(-1px);box-shadow:0 4px 20px #2ecc7155}
</style>
</head><body>${body}</body></html>`;

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
        res.writeHead(500); res.end("Internal error");
      })
    );
    this._server.listen(this.port, "0.0.0.0", () =>
      console.log(`[Web] Le Bandit \u2665 running on port ${this.port}`));
    setInterval(() => {
      const cut = Date.now() - 15 * 60 * 1000;
      for (const [s, ts] of this._states) if (ts < cut) this._states.delete(s);
    }, 10 * 60 * 1000);
  }

  async _handle(req, res) {
    const u    = new URL(req.url, "http://localhost");
    const path = u.pathname;

    if (path === "/") return this._redirect(res, "/play");

    // \u2500\u2500 Slot machine \u2500\u2500
    if (path === "/play" && req.method === "GET") {
      const uid = this._uid(req);
      if (!uid) return this._redirect(res, "/login");
      const user    = await this.db.getUser(uid);
      const cookies = parseCookies(req);
      const bal     = Number(user?.bal ?? 0);
      const tag     = decodeURIComponent(cookies.dtag ?? "Player");
      const avatar  = decodeURIComponent(cookies.dav  ?? "");
      res.writeHead(200, { "Content-Type": "text/html;charset=utf-8" });
      res.end(GAME_PAGE(bal, tag, avatar));
      return;
    }

    // \u2500\u2500 Login page \u2500\u2500
    if (path === "/login" && req.method === "GET") {
      if (!this.clientId) {
        return this._html(res, 500, PAGE(`
          <div class="card">
            <h1>\u26A0\uFE0F Not Configured</h1>
            <p>Add <code>fluxerClientId</code>, <code>fluxerClientSecret</code>, and <code>webBaseUrl</code> to <code>config.json</code>.</p>
          </div>`));
      }
      const state = crypto.randomBytes(16).toString("hex");
      this._states.set(state, Date.now());
      const authUrl = new URL(FLUXER_AUTH_URL);
      authUrl.searchParams.set("client_id",     this.clientId);
      authUrl.searchParams.set("redirect_uri",  this.redirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope",         "identify guilds");
      authUrl.searchParams.set("state",          state);
      res.writeHead(200, { "Content-Type": "text/html;charset=utf-8" });
      res.end(LOGIN_PAGE(authUrl.toString()));
      return;
    }

    // \u2500\u2500 OAuth callback \u2500\u2500
    if (path === "/oauth/callback" && req.method === "GET") {
      const code  = u.searchParams.get("code");
      const state = u.searchParams.get("state");
      if (!code || !state || !this._states.has(state)) {
        return this._html(res, 400, PAGE(`
          <div class="card"><h1>\u274C Login Failed</h1>
          <p>Invalid or expired login state.</p>
          <a class="btn" href="/login">Try again</a></div>`));
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
        return this._html(res, 500, PAGE(`<div class="card"><h1>\u26A0\uFE0F Error</h1><p>Could not reach Fluxer.</p><a class="btn" href="/login">Retry</a></div>`));
      }
      if (!tokenData.access_token) {
        console.error("[OAuth] no access_token:", tokenData);
        return this._html(res, 400, PAGE(`<div class="card"><h1>\u274C Login Failed</h1><p>${tokenData.error_description ?? tokenData.message ?? "Unknown error"}</p><a class="btn" href="/login">Try again</a></div>`));
      }
      let me;
      try {
        me = JSON.parse(await nodeFetch(FLUXER_ME_URL, {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        }));
      } catch {
        return this._html(res, 500, PAGE(`<div class="card"><h1>\u26A0\uFE0F Error</h1><p>Could not fetch your Fluxer profile.</p></div>`));
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
      return this._redirect(res, "/play");
    }

    // \u2500\u2500 Logout \u2500\u2500
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

    // \u2500\u2500 Spin \u2500\u2500
    if (path === "/spin" && req.method === "POST") {
      const uid  = this._uid(req);
      if (!uid) return this._json(res, 401, { error: "Not logged in" });
      const body = await parseBody(req);
      const bet  = parseInt(body.bet);
      const user = await this.db.getUser(uid);
      const bal  = Number(user?.bal ?? 0);
      if (isNaN(bet) || bet < 1)  return this._json(res, 400, { error: "Invalid bet" });
      if (bet > bal)              return this._json(res, 400, { error: "Insufficient FC" });
      if (bet > 1_000_000)        return this._json(res, 400, { error: "Max bet: 1,000,000 FC" });

      let reels = [spinReel(), spinReel(), spinReel()];
      reels = applyWild(reels);

      const [a, b, c] = reels;
      let delta = -bet, msg = "No match", type = "loss";
      let bonusTriggered = false;
      let jackpot = false;

      const bells = reels.filter(r => r === SCATTER).length;
      if (bells >= 3) {
        bonusTriggered = true;
        msg = "3x Bell Scatter \u2014 Bonus Spins!";
      }

      const isJackpotStar = "\uD83C\uDF1F";
      if (a === isJackpotStar && b === isJackpotStar && c === isJackpotStar) {
        const mult = PAYOUTS[isJackpotStar] ?? 25;
        delta = Math.floor(bet * mult * 0.92);
        msg = `JACKPOT! ${mult}\u00D7`;
        type = "win";
        jackpot = true;
      } else if (a === b && b === c) {
        const mult = PAYOUTS[a] ?? 2;
        delta = Math.floor(bet * mult * 0.92);
        msg = `MATCH! ${mult}\u00D7`;
        type = "win";
      } else if (a === b || b === c || a === c) {
        delta = Math.floor(bet * 0.4) - bet;
        msg = "Pair \u2014 partial return";
        type = "partial";
      }

      const upd    = await this.db.updateBalance(uid, delta);
      await this.db.recordGame(uid, delta > 0, Math.abs(delta));
      const newBal = Number(upd?.bal ?? (bal + delta));
      return this._json(res, 200, { reels, delta, msg, type, bal: newBal, bonus_triggered: bonusTriggered, jackpot });
    }

    res.writeHead(404); res.end("Not found");
  }

  _uid(req) {
    const c = parseCookies(req);
    return (c.sid && c.uid) ? c.uid : null;
  }

  _html(res, s, b) { res.writeHead(s, { "Content-Type": "text/html;charset=utf-8" }); res.end(b); }
  _json(res, s, o) { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); }
  _redirect(res, l) { res.setHeader("Location", l); res.writeHead(302); res.end(); }
}

// wild substitution helper (server-side)
function applyWild(reels) {
  const [a, b, c] = reels;
  if (a === WILD && b === c) return [b, b, c];
  if (b === WILD && a === c) return [a, a, c];
  if (c === WILD && a === b) return [a, b, a];
  if (a === WILD && b === WILD) return [c, c, c];
  if (a === WILD && c === WILD) return [b, b, b];
  if (b === WILD && c === WILD) return [a, a, a];
  return reels;
}
