import http from "http";
import https from "https";
import { URL } from "url";
import crypto from "crypto";

// ---------------------------------------------------------------------------
// Fluxer OAuth2  —  https://api.fluxer.app/v1
// Authorize : https://fluxer.app/oauth2/authorize
// Token     : https://api.fluxer.app/v1/oauth2/token
// Me        : https://api.fluxer.app/v1/users/@me
// Scope     : identify
// ---------------------------------------------------------------------------

const FLUXER_AUTH_URL  = "https://fluxer.app/oauth2/authorize";
const FLUXER_TOKEN_URL = "https://api.fluxer.app/v1/oauth2/token";
const FLUXER_ME_URL    = "https://api.fluxer.app/v1/users/@me";

const PAGE = (body) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Le Bandit — SirGreen Casino</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a1a0a;color:#e8f5e9;font-family:'Segoe UI',system-ui,sans-serif;
     min-height:100vh;display:flex;flex-direction:column;align-items:center;
     justify-content:center;padding:1rem}
h1{color:#2ecc71;font-size:2rem;margin-bottom:.5rem}
h2{color:#27ae60;margin-bottom:1rem;font-size:1.05rem;font-weight:400}
.card{background:#122012;border:1px solid #2ecc7128;border-radius:14px;
      padding:2rem 2.5rem;max-width:500px;width:100%;text-align:center;
      box-shadow:0 8px 40px #00000099}
.btn{background:#2ecc71;color:#0a1a0a;border:none;padding:.75rem 2rem;
     border-radius:8px;font-size:1rem;font-weight:700;cursor:pointer;
     transition:background .18s,transform .1s;margin:.4rem;display:inline-flex;
     align-items:center;justify-content:center;gap:.5rem;text-decoration:none}
.btn:hover{background:#27ae60}.btn:active{transform:scale(.97)}
.btn:disabled{opacity:.5;cursor:not-allowed}
.bal{font-size:1.6rem;color:#2ecc71;font-weight:700;margin:1rem 0}
.reels{font-size:3.5rem;letter-spacing:.4rem;margin:1.5rem 0;
        display:flex;align-items:center;justify-content:center;gap:.5rem}
.reel{display:inline-block;width:5rem;height:5rem;line-height:5rem;
      background:#0d2b0d;border-radius:8px;border:2px solid #2ecc7128}
.spinning .reel{animation:bob .15s linear infinite}
@keyframes bob{0%{transform:translateY(-4px)}50%{transform:translateY(4px)}100%{transform:translateY(-4px)}}
.result{font-size:1.1rem;min-height:2rem;margin:.5rem 0;font-weight:600}
.win{color:#2ecc71}.loss{color:#e74c3c}
input[type=number]{background:#0d2b0d;border:1px solid #2ecc7128;
  border-radius:8px;color:#e8f5e9;padding:.6rem 1rem;font-size:1rem;
  width:100%;margin:.5rem 0}
input[type=number]:focus{outline:2px solid #2ecc71;border-color:transparent}
.footer{margin-top:1.5rem;color:#3a6b3a;font-size:.78rem;line-height:1.6}
.avatar{width:52px;height:52px;border-radius:50%;border:2px solid #2ecc71;margin-bottom:.6rem}
.tag{color:#a8d5a8;font-size:.9rem;margin-bottom:.8rem}
.logo{font-size:2.5rem;margin-bottom:.5rem}
.err{color:#e74c3c;margin-top:.8rem;font-size:.9rem}
</style>
</head>
<body>${body}</body>
</html>`;

const SYMS    = ["🍒","🍋","🍊","🍇","🔔","⭐","💎"];
const WEIGHTS = [30,   25,   20,   15,    7,   2,    1 ];
const PAYOUTS = {"🍒":1.5,"🍋":1.8,"🍊":2.2,"🍇":2.5,"🔔":3,"⭐":6,"💎":10};
const TOTAL_W = WEIGHTS.reduce((a, b) => a + b, 0);

function spinReel() {
  let r = Math.random() * TOTAL_W;
  for (let i = 0; i < SYMS.length; i++) { r -= WEIGHTS[i]; if (r <= 0) return SYMS[i]; }
  return SYMS[0];
}

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
    const idx = part.indexOf("=");
    if (idx < 0) continue;
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
      { hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: opts.method ?? "GET", headers },
      res => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(d)); }
    );
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

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
      console.log(`[Web] Le Bandit running on port ${this.port}`));
    setInterval(() => {
      const cut = Date.now() - 15 * 60 * 1000;
      for (const [s, ts] of this._states) if (ts < cut) this._states.delete(s);
    }, 10 * 60 * 1000);
  }

  async _handle(req, res) {
    const u    = new URL(req.url, "http://localhost");
    const path = u.pathname;

    if (path === "/") return this._redirect(res, "/play");

    // ── Slot machine ──
    if (path === "/play" && req.method === "GET") {
      const uid = this._uid(req);
      if (!uid) return this._redirect(res, "/login");
      const user    = await this.db.getUser(uid);
      const cookies = parseCookies(req);
      return this._html(res, 200, PAGE(this._gamePage(
        Number(user?.bal ?? 0),
        decodeURIComponent(cookies.dtag ?? "Player"),
        decodeURIComponent(cookies.dav  ?? "")
      )));
    }

    // ── Login page ──
    if (path === "/login" && req.method === "GET") {
      if (!this.clientId) {
        return this._html(res, 500, PAGE(`
          <div class="card">
            <div class="logo">🎰</div>
            <h1>Not Configured</h1>
            <p style="margin-top:1rem;color:#a8d5a8">
              Add <code>fluxerClientId</code>, <code>fluxerClientSecret</code>,
              and <code>webBaseUrl</code> to <code>config.json</code>.
            </p>
          </div>`));
      }
      const state = crypto.randomBytes(16).toString("hex");
      this._states.set(state, Date.now());
      const authUrl = new URL(FLUXER_AUTH_URL);
      authUrl.searchParams.set("client_id",     this.clientId);
      authUrl.searchParams.set("redirect_uri",  this.redirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope",         "identify");
      authUrl.searchParams.set("state",          state);
      return this._html(res, 200, PAGE(`
        <div class="card">
          <div class="logo">🎰</div>
          <h1>Le Bandit</h1>
          <h2>SirGreen Casino</h2>
          <p style="margin-bottom:1.5rem;color:#a8d5a8">
            Login with your <strong>Fluxer</strong> account to access your FluxCoin balance.
          </p>
          <a class="btn" href="${authUrl}">
            🟢&nbsp; Login with Fluxer
          </a>
          <p class="footer">Your balance is global across all Fluxer servers.</p>
        </div>`));
    }

    // ── OAuth callback ──
    if (path === "/oauth/callback" && req.method === "GET") {
      const code  = u.searchParams.get("code");
      const state = u.searchParams.get("state");

      if (!code || !state || !this._states.has(state)) {
        return this._html(res, 400, PAGE(`
          <div class="card"><h1>❌ Login Failed</h1>
          <p style="margin-top:1rem">Invalid or expired login state. <a class="btn" style="margin-top:1rem" href="/login">Try again</a></p></div>`));
      }
      this._states.delete(state);

      // Exchange code for access token via Fluxer API
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
        return this._html(res, 500, PAGE(`<div class="card"><h1>⚠️ Error</h1><p>Could not reach Fluxer. Try again.</p><a class="btn" style="margin-top:1rem" href="/login">Retry</a></div>`));
      }

      if (!tokenData.access_token) {
        console.error("[OAuth] no access_token in response:", tokenData);
        return this._html(res, 400, PAGE(`<div class="card"><h1>❌ Login Failed</h1><p>${tokenData.error_description ?? tokenData.message ?? "Unknown error"}</p><a class="btn" style="margin-top:1rem" href="/login">Try again</a></div>`));
      }

      // Fetch user identity from Fluxer API
      let me;
      try {
        me = JSON.parse(await nodeFetch(FLUXER_ME_URL, {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        }));
      } catch {
        return this._html(res, 500, PAGE(`<div class="card"><h1>⚠️ Error</h1><p>Could not fetch your Fluxer profile.</p></div>`));
      }

      const userId = me.id;
      const tag    = me.username ?? me.tag ?? userId;
      // Fluxer avatar CDN mirrors Discord's structure
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

    // ── Logout ──
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

    // ── Spin ──
    if (path === "/spin" && req.method === "POST") {
      const uid = this._uid(req);
      if (!uid) return this._json(res, 401, { error: "Not logged in" });
      const body = await parseBody(req);
      const bet  = parseInt(body.bet);
      const user = await this.db.getUser(uid);
      const bal  = Number(user?.bal ?? 0);
      if (isNaN(bet) || bet < 1)  return this._json(res, 400, { error: "Invalid bet" });
      if (bet > bal)              return this._json(res, 400, { error: "Insufficient FC" });
      if (bet > 1_000_000)        return this._json(res, 400, { error: "Max bet: 1,000,000 FC" });

      const reels = [spinReel(), spinReel(), spinReel()];
      const [a, b, c] = reels;
      let delta = -bet, msg = "No match", type = "loss";

      if (a === b && b === c && Math.random() > 0.08) {
        const mult = PAYOUTS[a] ?? 2;
        delta = Math.floor(bet * mult * 0.92);
        msg   = `MATCH! ${mult}×`;
        type  = "win";
      } else if (a === b || b === c || a === c) {
        delta = Math.floor(bet * 0.4) - bet;
        msg   = "Pair — partial return";
      }

      const upd    = await this.db.updateBalance(uid, delta);
      await this.db.recordGame(uid, delta > 0, Math.abs(delta));
      const newBal = Number(upd?.bal ?? (bal + delta));
      return this._json(res, 200, { reels, delta, msg, type, bal: newBal });
    }

    res.writeHead(404); res.end("Not found");
  }

  _uid(req) {
    const c = parseCookies(req);
    return (c.sid && c.uid) ? c.uid : null;
  }

  _gamePage(bal, tag, avatar) {
    const av = avatar ? `<img class="avatar" src="${avatar}" alt="">` : "";
    return `
<div class="card">
  <h1>🎰 Le Bandit</h1>
  ${av}
  <div class="tag">${tag}</div>
  <div class="bal" id="bal">${Number(bal).toLocaleString()} FC</div>
  <div class="reels" id="reels">
    <span class="reel" id="r0">🍒</span>
    <span class="reel" id="r1">🍒</span>
    <span class="reel" id="r2">🍒</span>
  </div>
  <div class="result" id="result"> </div>
  <input type="number" id="bet" placeholder="Bet amount" min="1" max="1000000" value="100">
  <button class="btn" id="spinBtn" onclick="doSpin()">🎰 SPIN</button>
  <a class="btn" style="background:#1a3a1a;color:#4a9a4a;font-size:.85rem;padding:.5rem 1.2rem;margin-top:.8rem" href="/logout">Logout</a>
  <p class="footer">FluxCoins · Global balance · House edge applies · SirGreen Casino</p>
</div>
<script>
async function doSpin() {
  const btn = document.getElementById('spinBtn');
  const bet = parseInt(document.getElementById('bet').value);
  if (isNaN(bet) || bet < 1) return;
  btn.disabled = true;
  const rs = ['r0','r1','r2'].map(id => document.getElementById(id));
  document.getElementById('reels').classList.add('spinning');
  document.getElementById('result').textContent = '';
  await new Promise(r => setTimeout(r, 700));
  const res = await fetch('/spin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'bet=' + bet
  });
  const d = await res.json();
  document.getElementById('reels').classList.remove('spinning');
  if (d.error) {
    document.getElementById('result').textContent = '❌ ' + d.error;
    document.getElementById('result').className = 'result loss';
    btn.disabled = false; return;
  }
  d.reels.forEach((s, i) => rs[i].textContent = s);
  document.getElementById('bal').textContent = d.bal.toLocaleString() + ' FC';
  const r = document.getElementById('result');
  r.textContent = (d.delta >= 0 ? '✅ +' : '❌ ') + d.delta.toLocaleString() + ' FC — ' + d.msg;
  r.className = 'result ' + (d.type === 'win' ? 'win' : 'loss');
  btn.disabled = false;
}
</script>`;
  }

  _html(res, s, b) { res.writeHead(s, { "Content-Type": "text/html;charset=utf-8" }); res.end(b); }
  _json(res, s, o) { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); }
  _redirect(res, l) { res.setHeader("Location", l); res.writeHead(302); res.end(); }
}
