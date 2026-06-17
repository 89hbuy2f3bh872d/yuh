// SirGreen web service — Bun + Elysia. Replaces the Node http server.
//
// Owns: HTTP routing, static assets, sessions, the realtime WebSocket, and all
// money endpoints (wired to SpacetimeDB). MongoDB still stores profiles, sessions,
// cases and stats (reused via ../src/Database.mjs — Bun runs .mjs directly).
//
// Run:  bun run web/server.ts   (config.json read from repo root)
//
// PORTING STATUS (this file is the realtime/money core):
//   ✅ bootstrap + Bun tuning + static + sessions + page render
//   ✅ WebSocket realtime (balance + notifications, push from STDB subscriptions)
//   ✅ /api/balance /api/transfer /api/notifications(+/read) /api/slots/* /api/house/*
//   ✅ /internal/* bridge for the Node bot (shared-secret)
//   ⏳ OAuth login, case-battle API, admin panel — port from src/WebServer.mjs next
//      (logic is unchanged; only the balance calls swap to STDB — see swapBalance() notes)

import { Elysia } from "elysia";
import { readFileSync, existsSync } from "fs";
import { join, extname } from "path";
import { fileURLToPath } from "url";
import crypto from "node:crypto";
import { Database } from "../src/Database.mjs";
import * as Slots from "../src/SlotEngine.mjs";
import { HouseState, plinko, coinflip, doubleOrNothing, HOUSE_GAMES } from "../src/HouseGames.mjs";
import { Stdb } from "./src/stdb.ts";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const cfg = JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8"));
const PORT = cfg.web?.port ?? cfg.webPort ?? 8080;
const INTERNAL_SECRET = cfg.web?.internalSecret ?? "";
const ASSET_VER = Date.now().toString(36);

// ── data layer ────────────────────────────────────────────────────────────
const db = new Database(cfg.mongodb.uri, cfg.mongodb.database);
await db.connect();
const stdb = new Stdb(cfg.spacetime.uri, cfg.spacetime.module, cfg.spacetime.token);
await stdb.ready();
const house = new HouseState();

// ── tiny helpers ────────────────────────────────────────────────────────────
const GAMES_DIR = join(ROOT, "games");
const MIME: Record<string, string> = { ".css": "text/css", ".js": "text/javascript", ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2", ".json": "application/json", ".mp3": "audio/mpeg" };

function parseCookies(req: Request): Record<string, string> {
  const h = req.headers.get("cookie") || "", o: Record<string, string> = {};
  for (const part of h.split(";")) { const i = part.indexOf("="); if (i > 0) o[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return o;
}
// Verify the session server-side (sid must exist + be unexpired in Mongo), 30s cache.
const sessCache = new Map<string, { uid: string; until: number }>();
async function resolveSession(req: Request): Promise<string | null> {
  const c = parseCookies(req);
  if (!c.sid || !c.uid) return null;
  const hit = sessCache.get(c.sid);
  if (hit && hit.uid === c.uid && hit.until > Date.now()) return c.uid;
  const v = await db.validateSession(c.uid, c.sid).catch(() => null);
  if (!v) { sessCache.delete(c.sid); return null; }
  sessCache.set(c.sid, { uid: c.uid, until: Date.now() + 30_000 });
  return c.uid;
}

// ── OAuth + page rendering (ported from src/WebServer.mjs) ───────────────────
const FLUXER_AUTH_URL = "https://web.canary.fluxer.app/oauth2/authorize";
const FLUXER_TOKEN_URL = "https://api.fluxer.app/v1/oauth2/token";
const FLUXER_ME_URL = "https://api.fluxer.app/v1/users/@me";
const FLUXER_CDN = "https://cdn.fluxer.app";
const FLUXER_STATIC_CDN = "https://web.fluxer.app/static";
const CLIENT_ID = cfg.fluxerClientId ?? "";
const CLIENT_SECRET = cfg.fluxerClientSecret ?? "";
const BASE_URL = (cfg.webBaseUrl ?? "").replace(/\/$/, "");
const REDIRECT_URI = `${BASE_URL}/oauth/callback`;
const OWNERS: string[] = Array.isArray(cfg.owners) ? cfg.owners.map(String) : [];
const oauthStates = new Map<string, number>(); // state → expiry
const SIDEBAR_TPL = (() => { try { return readFileSync(join(GAMES_DIR, "partials", "sidebar.html"), "utf8"); } catch { return ""; } })();
const PAGE_IDS = ["lobby", "case-battle", "slots", "house", "settings", "misc", "notifications"];

function esc(s: any): string { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)); }
function fluxerAvatarUrl(userId: string, hash: string | null, size = 64): string {
  if (!hash) { let i = 0; try { i = Number(BigInt(userId) % 6n); } catch {} return `${FLUXER_STATIC_CDN}/avatars/${i}.png`; }
  const ext = String(hash).startsWith("a_") ? "gif" : "png";
  return `${FLUXER_CDN}/avatars/${userId}/${hash}.${ext}?size=${size}`;
}
function buildSidebar(a: { active: string; tag: string; avatar: string; bal: number; showAdmin: boolean }): string {
  let s = SIDEBAR_TPL;
  for (const p of PAGE_IDS) s = s.replace(`__ACTIVE_${p}__`, p === a.active ? "active" : "");
  const adminNav = a.showAdmin
    ? `<a href="/admin/panel" class="sb-item admin ${a.active === "admin" ? "active" : ""}"><svg class="icon" viewBox="0 0 24 24"><path d="M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z"/><path d="M9 12l2 2 4-4"/></svg><span>Admin</span></a>`
    : "";
  return s.replace("__ADMIN_NAV__", adminNav).replace(/__TAG__/g, esc(a.tag)).replace(/__AVATAR__/g, esc(a.avatar)).replace(/__BALANCE__/g, Number(a.bal).toLocaleString());
}
async function renderPage(request: Request, set: any, file: string, active: string, extra: Record<string, string> = {}) {
  const uid = await resolveSession(request);
  if (!uid) { set.redirect = "/login"; return; }
  const fp = join(GAMES_DIR, file);
  if (!existsSync(fp)) { set.status = 503; return "Page not available"; }
  const c = parseCookies(request);
  const user = await db.getUser(uid).catch(() => null);
  const bal = stdb.getBalance(uid);
  const tag = c.dtag || user?.tag || "Player";
  let avatar = c.dav || user?.av || ""; if (!avatar) avatar = fluxerAvatarUrl(uid, null);
  let html = readFileSync(fp, "utf8")
    .replace("__SIDEBAR__", buildSidebar({ active, tag, avatar, bal, showAdmin: OWNERS.includes(uid) }))
    .replace(/__BALANCE__/g, String(bal)).replace(/__TAG__/g, esc(tag)).replace(/__AVATAR__/g, esc(avatar)).replace(/__UID__/g, esc(uid));
  for (const [k, v] of Object.entries(extra)) html = html.split(k).join(v);
  html = html.replace(/(\/assets\/[^"'?\s]+\.(?:css|js))(["'])/g, `$1?v=${ASSET_VER}$2`);
  set.headers["content-type"] = "text/html; charset=utf-8";
  return html;
}

function rl(map: Map<string, number>, key: string, ms: number): boolean {
  const now = Date.now(), last = map.get(key) ?? 0;
  if (now - last < ms) return true; map.set(key, now); return false;
}
const rlMoney = new Map<string, number>();

// ── realtime WebSocket hub ───────────────────────────────────────────────────
// One socket per browser tab. On open we auth via the session cookie, subscribe the
// user to STDB balance + notification pushes, and stream them down. No polling.
type WSData = { uid: string | null; offBal?: () => void; offNotif?: () => void };

const app = new Elysia()
  .ws("/ws", {
    async open(ws) {
      const uid = await resolveSession(ws.data.request as Request);
      (ws.data as any).uid = uid;
      if (!uid) { ws.send(JSON.stringify({ type: "auth", ok: false })); return; }
      await stdb.ensureAccount(uid).catch(() => {});
      await stdb.subscribeNotifs(uid).catch(() => {});
      const snap = await stdb.getNotifications(uid).catch(() => ({ items: [], unread: 0 }));
      ws.send(JSON.stringify({ type: "init", bal: stdb.getBalance(uid), items: snap.items, unread: snap.unread }));
      (ws.data as any).offBal = stdb.onBalance(uid, (bal) => ws.send(JSON.stringify({ type: "balance", bal })));
      (ws.data as any).offNotif = stdb.onNotification(uid, (n) =>
        ws.send(JSON.stringify({ type: "notification", item: { t: n.kind, m: n.msg, a: Number(n.amount), f: n.fromTag, ts: Number(n.ts) } })));
    },
    close(ws) {
      const d = ws.data as any;
      d.offBal?.(); d.offNotif?.();
      if (d.uid) stdb.unsubscribeNotifs(d.uid);
    },
    message() { /* server push only */ },
  })

  // ── balance + notifications ──────────────────────────────────────────────
  .get("/api/balance", async ({ request, set }) => {
    const uid = await resolveSession(request); if (!uid) { set.status = 401; return { error: "Not logged in" }; }
    return { bal: stdb.getBalance(uid) };
  })
  .get("/api/notifications", async ({ request, set }) => {
    const uid = await resolveSession(request); if (!uid) { set.status = 401; return { error: "Not logged in" }; }
    const n = await stdb.getNotifications(uid).catch(() => ({ items: [], unread: 0 }));
    return { items: n.items, unread: n.unread, bal: stdb.getBalance(uid) };
  })
  .post("/api/notifications/read", async ({ request, set }) => {
    const uid = await resolveSession(request); if (!uid) { set.status = 401; return { error: "Not logged in" }; }
    await stdb.markRead(uid).catch(() => {});
    return { ok: true };
  })
  .post("/api/transfer", async ({ request, body, set }) => {
    const uid = await resolveSession(request); if (!uid) { set.status = 401; return { error: "Not logged in" }; }
    const b = body as any;
    const toId = String(b?.toId ?? "").trim();
    const amount = Math.floor(Number(b?.amount));
    if (!/^\d{17,20}$/.test(toId)) return { error: "Invalid recipient" };
    if (toId === uid) return { error: "Can't send to yourself" };
    if (!Number.isFinite(amount) || amount <= 0) return { error: "Invalid amount" };
    const me = await db.getUser(uid).catch(() => null);
    try { await stdb.transfer(uid, toId, amount, me?.tag || "Someone"); }
    catch (e: any) { return { error: e?.message === "insufficient" ? "Insufficient balance" : "Transfer failed" }; }
    return { ok: true, newBal: stdb.getBalance(uid) };
  })

  // ── slots (whole round resolved server-side, settled atomically) ───────────
  .get("/api/slots/games", async ({ request, set }) => {
    const uid = await resolveSession(request); if (!uid) { set.status = 401; return { error: "Not logged in" }; }
    return { games: Slots.listGames() };
  })
  .post("/api/slots/spin", async ({ request, body, set }) => {
    const uid = await resolveSession(request); if (!uid) { set.status = 401; return { error: "Not logged in" }; }
    if (rl(rlMoney, uid, 250)) { set.status = 429; return { error: "Slow down a moment" }; }
    const b = body as any;
    const game = Slots.getGame(String(b?.game ?? "")); if (!game) return { error: "Unknown game" };
    const bet = Math.floor(Number(b?.bet) || 0);
    if (!(bet >= 1) || bet > 1_000_000) return { error: "Invalid bet" };
    const buy = b?.buy === "super" ? "super" : (b?.buy === "regular" ? "regular" : false);
    const cost = buy ? bet * Slots.buyCost(game.id, buy) : bet;
    if (cost > 50_000_000) return { error: "Bet too large for a buy" };
    let result;
    try { result = Slots.spin(game.id, bet, buy); } catch { set.status = 500; return { error: "Spin failed" }; }
    // one atomic settle: take cost, pay winnings
    try { await stdb.settle(uid, cost, result.totalWin); }
    catch (e: any) { return { error: e?.message === "insufficient" ? "Insufficient balance" : "Settle failed" }; }
    db.recordGame?.(uid, result.totalWin >= cost, cost).catch(() => {});
    return { game: game.id, bet, cost, buy, spins: result.spins, totalWin: result.totalWin, freeTriggered: result.freeTriggered, freeAwarded: result.freeAwarded, mode: result.mode, superMult: result.superMult, superPre: result.superPre, balance: stdb.getBalance(uid) };
  })

  // ── house games (Plinko / Coinflip / Double = stateless; Mines / HiLo = stateful)
  .post("/api/house/*", async ({ request, params, body, set }) => {
    const uid = await resolveSession(request); if (!uid) { set.status = 401; return { error: "Not logged in" }; }
    if (rl(rlMoney, uid, 120)) { set.status = 429; return { error: "Slow down a moment" }; }
    const sub = (params as any)["*"] as string;
    const d = body as any;
    const bet = Math.floor(Number(d?.bet) || 0);
    const goodBet = bet >= 1 && bet <= 1_000_000;
    const credit = (amt: number) => amt > 0 ? stdb.credit(uid, amt).catch(() => {}) : Promise.resolve();
    const bal = () => stdb.getBalance(uid);

    if (sub === "plinko") {
      if (!goodBet) return { error: "Invalid bet" };
      try { await stdb.deduct(uid, bet); } catch { return { error: "Insufficient balance" }; }
      const r = plinko(bet, d?.risk); await credit(r.payout); db.recordGame?.(uid, r.payout >= bet, bet).catch(() => {});
      return Object.assign(r, { balance: bal() });
    }
    if (sub === "coinflip") {
      if (!goodBet) return { error: "Invalid bet" };
      try { await stdb.deduct(uid, bet); } catch { return { error: "Insufficient balance" }; }
      const r = coinflip(bet, d?.side); await credit(r.payout); db.recordGame?.(uid, r.win, bet).catch(() => {});
      return Object.assign(r, { balance: bal() });
    }
    if (sub === "double") {
      if (!goodBet) return { error: "Invalid bet" };
      try { await stdb.deduct(uid, bet); } catch { return { error: "Insufficient balance" }; }
      const r = doubleOrNothing(bet); await credit(r.payout); db.recordGame?.(uid, r.win, bet).catch(() => {});
      return Object.assign(r, { balance: bal() });
    }
    if (sub === "mines/start") {
      if (!goodBet) return { error: "Invalid bet" };
      house.clearMines(uid);
      try { await stdb.deduct(uid, bet); } catch { return { error: "Insufficient balance" }; }
      return Object.assign(house.startMines(uid, bet, d?.mines), { ok: true, balance: bal() });
    }
    if (sub === "mines/reveal") {
      const r = house.minesReveal(uid, d?.idx);
      if ((r as any).error) return r;
      if ((r as any).hit) { db.recordGame?.(uid, false, 0).catch(() => {}); return Object.assign(r, { balance: bal() }); }
      return r;
    }
    if (sub === "mines/cashout") {
      const r = house.minesCashout(uid);
      if ((r as any).error) return r;
      await credit((r as any).payout); return Object.assign(r, { balance: bal() });
    }
    if (sub === "hilo/start") {
      if (!goodBet) return { error: "Invalid bet" };
      house.clearHilo(uid);
      try { await stdb.deduct(uid, bet); } catch { return { error: "Insufficient balance" }; }
      return Object.assign(house.startHilo(uid, bet), { ok: true, balance: bal() });
    }
    if (sub === "hilo/guess") { return house.hiloGuess(uid, d?.dir); }
    if (sub === "hilo/cashout") {
      const r = house.hiloCashout(uid);
      if ((r as any).error) return r;
      await credit((r as any).payout); return Object.assign(r, { balance: bal() });
    }
    set.status = 404; return { error: "Unknown game" };
  })
  .get("/api/house/games", async ({ request, set }) => {
    const uid = await resolveSession(request); if (!uid) { set.status = 401; return { error: "Not logged in" }; }
    return { games: HOUSE_GAMES };
  })

  // ── internal bridge for the Node bot (shared-secret, localhost only) ────────
  .group("/internal", (g) => g
    .onBeforeHandle(({ request, set }) => {
      if (!INTERNAL_SECRET || request.headers.get("x-internal") !== INTERNAL_SECRET) { set.status = 403; return { error: "forbidden" }; }
    })
    .get("/balance/:uid", ({ params }) => ({ bal: stdb.getBalance(params.uid) }))
    .post("/credit", async ({ body }) => { const b = body as any; try { await stdb.credit(b.uid, Math.floor(b.amount)); return { ok: true, bal: stdb.getBalance(b.uid) }; } catch (e: any) { return { ok: false, error: e?.message }; } })
    .post("/deduct", async ({ body }) => { const b = body as any; try { await stdb.deduct(b.uid, Math.floor(b.amount)); return { ok: true, bal: stdb.getBalance(b.uid) }; } catch (e: any) { return { ok: false, error: e?.message }; } })
    .post("/settle", async ({ body }) => { const b = body as any; try { await stdb.settle(b.uid, Math.floor(b.bet), Math.floor(b.payout)); return { ok: true, bal: stdb.getBalance(b.uid) }; } catch (e: any) { return { ok: false, error: e?.message }; } })
    .post("/transfer", async ({ body }) => { const b = body as any; try { await stdb.transfer(b.from, b.to, Math.floor(b.amount), b.fromTag || ""); return { ok: true }; } catch (e: any) { return { ok: false, error: e?.message }; } })
    .post("/notify", async ({ body }) => { const b = body as any; try { await stdb.addNotification(b.uid, b.kind || "info", Math.floor(b.amount || 0), b.fromTag || "", b.msg || ""); return { ok: true }; } catch (e: any) { return { ok: false, error: e?.message }; } })
    .post("/set", async ({ body }) => { const b = body as any; try { await stdb.setExact(b.uid, Math.floor(b.balance)); return { ok: true }; } catch (e: any) { return { ok: false, error: e?.message }; } })
  )

  // ── static assets ──────────────────────────────────────────────────────────
  .get("/assets/*", ({ params, set, request }) => serveStatic(join(GAMES_DIR, "assets", (params as any)["*"]), set))
  .get("/public/*", ({ params, set }) => serveStatic(join(ROOT, "public", (params as any)["*"]), set));

function serveStatic(path: string, set: any) {
  if (!existsSync(path)) { set.status = 404; return "Not found"; }
  set.headers["content-type"] = MIME[extname(path)] || "application/octet-stream";
  set.headers["cache-control"] = "public, max-age=86400";
  return Bun.file(path);
}

// ── OAuth login / callback / logout ─────────────────────────────────────────
app.get("/login", ({ set }) => {
  if (!CLIENT_ID) { set.status = 500; return "OAuth not configured"; }
  const state = crypto.randomBytes(16).toString("hex");
  oauthStates.set(state, Date.now() + 10 * 60 * 1000);
  const authUrl = `${FLUXER_AUTH_URL}?client_id=${encodeURIComponent(CLIENT_ID)}&scope=identify+guilds&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&state=${encodeURIComponent(state)}`;
  const fp = join(GAMES_DIR, "login.html");
  if (!existsSync(fp)) { set.redirect = authUrl; return; }
  set.headers["content-type"] = "text/html; charset=utf-8";
  return readFileSync(fp, "utf8").replace("__AUTH_URL__", esc(authUrl));
});

app.get("/oauth/callback", async ({ query, set, request }) => {
  const code = (query as any).code, state = (query as any).state;
  const exp = state ? oauthStates.get(state) : undefined;
  if (!code || !state || !exp) { set.redirect = "/login"; return; }
  oauthStates.delete(state);
  if (Date.now() > exp) { set.redirect = "/login"; return; }
  let token: any;
  try {
    const r = await fetch(FLUXER_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI }).toString() });
    token = await r.json();
  } catch { set.redirect = "/login"; return; }
  if (!token?.access_token) { set.redirect = "/login"; return; }
  let me: any;
  try { me = await (await fetch(FLUXER_ME_URL, { headers: { Authorization: `Bearer ${token.access_token}` } })).json(); } catch { set.redirect = "/login"; return; }
  const uid = me?.id; if (!uid) { set.redirect = "/login"; return; }
  const tag = me.global_name ?? me.displayName ?? me.username ?? me.tag ?? uid;
  const avatar = fluxerAvatarUrl(uid, me.avatar);
  await db.setProfile(uid, { tag, avatar }).catch(() => {});
  await stdb.ensureAccount(uid).catch(() => {});
  const ip = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || null;
  const old = parseCookies(request).sid;
  const sid = crypto.randomBytes(32).toString("hex");
  if (old) await db.rotateSession(uid, old, sid, 2 * 60 * 60 * 1000, ip).catch(() => {});
  else await db.createSession(uid, sid, 2 * 60 * 60 * 1000, ip).catch(() => {});
  const base = "HttpOnly; Path=/; Max-Age=7200; SameSite=Lax";
  set.headers["Set-Cookie"] = [
    `sid=${sid}; ${base}`, `uid=${uid}; ${base}`,
    `dtag=${encodeURIComponent(tag)}; Path=/; Max-Age=7200; SameSite=Lax`,
    `dav=${encodeURIComponent(avatar)}; Path=/; Max-Age=7200; SameSite=Lax`,
  ];
  set.redirect = OWNERS.includes(uid) ? "/admin/panel" : "/lobby";
});

app.get("/logout", async ({ request, set }) => {
  const c = parseCookies(request);
  if (c.uid && c.sid) await db.revokeSession(c.uid, c.sid).catch(() => {});
  if (c.sid) sessCache.delete(c.sid);
  set.headers["Set-Cookie"] = ["sid=; Path=/; Max-Age=0", "uid=; Path=/; Max-Age=0", "dtag=; Path=/; Max-Age=0", "dav=; Path=/; Max-Age=0"];
  set.redirect = "/login";
});

// ── authed pages (sidebar + tokens injected; ?v= cache-bust) ─────────────────
const PAGES: [string, string, string][] = [
  ["/", "lobby.html", "lobby"], ["/lobby", "lobby.html", "lobby"],
  ["/slots", "slots.html", "slots"], ["/house", "house.html", "house"],
  ["/settings", "settings.html", "settings"], ["/misc", "misc.html", "misc"],
  ["/notifications", "notifications.html", "notifications"],
];
for (const [p, f, a] of PAGES) app.get(p, ({ request, set }) => renderPage(request, set, f, a));
app.get("/case-battle", ({ request, set }) => renderPage(request, set, "case-battle.html", "case-battle", { "__BATTLE_ID__": "" }));
app.get("/case-battle/:id", ({ request, set, params }) => renderPage(request, set, "case-battle.html", "case-battle", { "__BATTLE_ID__": esc((params as any).id) }));

// ── Bun server tuning for a cheap VPS (high concurrency, low memory) ──────────
app.listen({ port: PORT, reusePort: true, hostname: "0.0.0.0" });
console.log(`[web] Elysia on :${PORT} · STDB ${cfg.spacetime.module} · realtime WS at /ws`);

export type App = typeof app;
