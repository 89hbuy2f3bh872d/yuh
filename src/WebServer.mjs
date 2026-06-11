import http from "http";
import { URL } from "url";
import { COLORS } from "./theme.mjs";

const HTML = (body, head = "") => `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">${head}<title>Le Bandit — SirGreen Casino</title><style>
*{box-sizing:border-box;margin:0;padding:0}body{background:#0d1f0d;color:#e8f5e9;font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:1rem}
h1{color:#2ecc71;font-size:2rem;margin-bottom:.5rem}h2{color:#27ae60;margin-bottom:1rem}
.card{background:#1a2e1a;border:1px solid #2ecc7133;border-radius:12px;padding:2rem;max-width:480px;width:100%;text-align:center;box-shadow:0 8px 32px #00000088}
.btn{background:#2ecc71;color:#0d1f0d;border:none;padding:.75rem 2rem;border-radius:8px;font-size:1rem;font-weight:700;cursor:pointer;transition:background .2s;margin:.5rem}
.btn:hover{background:#27ae60}.btn:disabled{background:#1e8449;cursor:not-allowed;opacity:.6}
.bal{font-size:1.5rem;color:#2ecc71;font-weight:700;margin:1rem 0}
.reels{font-size:3.5rem;letter-spacing:.5rem;margin:1.5rem 0;min-height:5rem;display:flex;align-items:center;justify-content:center;gap:.5rem}
.reel{display:inline-block;width:5rem;height:5rem;line-height:5rem;background:#0d2b0d;border-radius:8px;border:2px solid #2ecc7144;transition:transform .3s}
.spinning .reel{animation:spin .15s linear infinite}
@keyframes spin{0%{transform:translateY(-4px)}50%{transform:translateY(4px)}100%{transform:translateY(-4px)}}
.result{font-size:1.1rem;min-height:2rem;margin-bottom:.5rem;font-weight:600}
.win{color:#2ecc71}.loss{color:#e74c3c}.push{color:#f39c12}
input{background:#0d2b0d;border:1px solid #2ecc7144;border-radius:8px;color:#e8f5e9;padding:.6rem 1rem;font-size:1rem;width:100%;margin:.5rem 0}
.footer{margin-top:2rem;color:#4a7a4a;font-size:.8rem}
</style></head><body>${body}</body></html>`;

const REELS = ["🍒","🍋","🍊","🍇","💎","7️⃣","🔔","⭐"];
const WEIGHTS = [30,25,20,15,5,3,1,1];
const PAYOUTS = {"🍒":1.5,"🍋":1.8,"🍊":2.2,"🍇":2.5,"💎":5,"7️⃣":8,"🔔":6,"⭐":4};

function spin() {
  let r = Math.random() * 100;
  for (let i = 0; i < REELS.length; i++) { r -= WEIGHTS[i]; if (r <= 0) return REELS[i]; }
  return REELS[0];
}

function parseBody(req) {
  return new Promise(resolve => {
    let d = "";
    req.on("data", c => d += c);
    req.on("end", () => {
      try { resolve(Object.fromEntries(new URLSearchParams(d))); }
      catch { resolve({}); }
    });
  });
}

export class WebServer {
  constructor(db, config) {
    this.db = db;
    this.port = config.webPort ?? 3420;
    this.host = config.webHost ?? "0.0.0.0";
    // In-memory map: token -> { userId, expiry }
    this._tokens = new Map();
  }

  // Called from &bandit command to pre-register a one-time login token
  async issueToken(userId) {
    const token = Buffer.from(`${userId}:${Date.now()}:${Math.random()}`).toString("base64url").slice(0, 32);
    const expiry = Date.now() + 10 * 60 * 1000; // 10 min
    this._tokens.set(token, { userId, expiry });
    return token;
  }

  async start() {
    this._server = http.createServer((req, res) => this._handle(req, res));
    this._server.listen(this.port, this.host, () =>
      console.log(`[Web] Le Bandit running on port ${this.port}`)
    );
    // Prune expired tokens every 5 min
    setInterval(() => {
      const now = Date.now();
      for (const [t, v] of this._tokens) if (v.expiry < now) this._tokens.delete(t);
    }, 5 * 60 * 1000);
  }

  async _handle(req, res) {
    const url = new URL(req.url, `http://localhost`);
    const path = url.pathname;

    // ── GET /bandit?t=TOKEN  (entry, validates token → sets session cookie) ──
    if (path === "/bandit" && req.method === "GET") {
      const t = url.searchParams.get("t");
      const entry = t && this._tokens.get(t);
      if (!entry || Date.now() > entry.expiry) {
        return this._html(res, 403, HTML(`<div class="card"><h1>🔒 Access Denied</h1><p>This link is invalid or has expired.<br>Use <b>&bandit</b> in Discord to get a new one.</p><p class="footer">SirGreen Casino</p></div>`));
      }
      this._tokens.delete(t); // single-use
      const session = Buffer.from(`${entry.userId}:${Date.now()}:${Math.random()}`).toString("base64url").slice(0, 48);
      const expiry = Date.now() + 2 * 60 * 60 * 1000; // 2h session
      await this.db.createSession(entry.userId, session, 2 * 60 * 60 * 1000);
      res.setHeader("Set-Cookie", `sid=${session}; uid=${entry.userId}; HttpOnly; Path=/; Max-Age=7200`);
      res.setHeader("Location", "/play");
      res.writeHead(302);
      return res.end();
    }

    // ── GET /play  (main slot machine page) ──
    if (path === "/play" && req.method === "GET") {
      const { userId, valid } = await this._auth(req);
      if (!valid) return this._redirect(res, "/denied");
      const u = await this.db.getUser(userId);
      return this._html(res, 200, this._playPage(u.bal ?? 0));
    }

    // ── POST /spin  (AJAX spin) ──
    if (path === "/spin" && req.method === "POST") {
      const { userId, valid } = await this._auth(req);
      if (!valid) return this._json(res, 401, { error: "Unauthorised" });
      const body = await parseBody(req);
      const bet = parseInt(body.bet);
      const u = await this.db.getUser(userId);
      if (isNaN(bet) || bet < 1) return this._json(res, 400, { error: "Invalid bet" });
      if (bet > u.bal) return this._json(res, 400, { error: "Insufficient FC" });
      if (bet > 1_000_000) return this._json(res, 400, { error: "Max bet 1,000,000 FC" });

      const reels = [spin(), spin(), spin()];
      const [a, b, c] = reels;
      let delta = -bet, msg = "No match", type = "loss";

      if (a === b && b === c) {
        const mult = PAYOUTS[a] ?? 2;
        delta = Math.floor(bet * mult * 0.92);
        msg = `JACKPOT! ${mult}x`; type = "win";
      } else if (a === b || b === c || a === c) {
        delta = Math.floor(bet * 0.5);
        msg = "Partial win — pair!"; type = "win";
      }

      const updated = await this.db.updateBalance(userId, delta);
      await this.db.recordGame(userId, delta > 0, Math.abs(delta));
      return this._json(res, 200, { reels, delta, msg, type, bal: updated.bal ?? updated.value?.bal });
    }

    // ── /denied ──
    if (path === "/denied") {
      return this._html(res, 403, HTML(`<div class="card"><h1>🔒 Session Expired</h1><p>Use <b>&bandit</b> in Discord to get a fresh link.</p><p class="footer">SirGreen Casino</p></div>`));
    }

    res.writeHead(404); res.end("Not found");
  }

  async _auth(req) {
    const cookies = Object.fromEntries(
      (req.headers.cookie ?? "").split(";").map(c => c.trim().split("=").map(decodeURIComponent))
    );
    const session = cookies.sid, userId = cookies.uid;
    if (!session || !userId) return { valid: false };
    const valid = await this.db.validateSession(userId, session);
    return { valid, userId };
  }

  _playPage(bal) {
    return HTML(`
<div class="card">
  <h1>🎰 Le Bandit</h1>
  <h2>SirGreen Casino</h2>
  <div class="bal" id="bal">${bal.toLocaleString()} FC</div>
  <div class="reels" id="reels">
    <span class="reel" id="r0">🍒</span>
    <span class="reel" id="r1">🍒</span>
    <span class="reel" id="r2">🍒</span>
  </div>
  <div class="result" id="result"></div>
  <input type="number" id="bet" placeholder="Bet amount" min="1" max="1000000" value="100">
  <button class="btn" id="spinBtn" onclick="doSpin()">🎰 SPIN</button>
  <p class="footer">FluxCoins · House edge applies · SirGreen Casino</p>
</div>
<script>
async function doSpin(){
  const btn=document.getElementById('spinBtn'),betEl=document.getElementById('bet');
  const bet=parseInt(betEl.value);
  if(isNaN(bet)||bet<1)return;
  btn.disabled=true;
  const reelEls=[document.getElementById('r0'),document.getElementById('r1'),document.getElementById('r2')];
  document.getElementById('reels').classList.add('spinning');
  document.getElementById('result').textContent='';
  await new Promise(r=>setTimeout(r,600));
  const res=await fetch('/spin',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'bet='+bet});
  const data=await res.json();
  document.getElementById('reels').classList.remove('spinning');
  if(data.error){document.getElementById('result').textContent='❌ '+data.error;document.getElementById('result').className='result loss';btn.disabled=false;return;}
  data.reels.forEach((s,i)=>reelEls[i].textContent=s);
  document.getElementById('bal').textContent=data.bal.toLocaleString()+' FC';
  const r=document.getElementById('result');
  r.textContent=(data.delta>0?'✅ +':'')+data.delta.toLocaleString()+' FC — '+data.msg;
  r.className='result '+(data.type==='win'?'win':'loss');
  btn.disabled=false;
}
</script>`);
  }

  _html(res, status, body) {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
    res.end(body);
  }
  _json(res, status, obj) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  }
  _redirect(res, loc) {
    res.setHeader("Location", loc); res.writeHead(302); res.end();
  }
}
