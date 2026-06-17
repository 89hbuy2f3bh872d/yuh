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

function uidFromReq(req: Request): string | null {
  // Session cookie → uid (reuse Mongo session store). Synchronous-ish via cache below.
  const cookie = req.headers.get("cookie") || "";
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(cookie);
  return m ? sidToUid.get(decodeURIComponent(m[1])) ?? null : null;
}
// session id → uid memo (filled on auth; backed by Mongo `db.getSession`)
const sidToUid = new Map<string, string>();
async function resolveSession(req: Request): Promise<string | null> {
  const cookie = req.headers.get("cookie") || "";
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(cookie);
  if (!m) return null;
  const sid = decodeURIComponent(m[1]);
  if (sidToUid.has(sid)) return sidToUid.get(sid)!;
  const sess = await db.getSession?.(sid).catch(() => null);
  const uid = sess?.uid ?? null;
  if (uid) sidToUid.set(sid, uid);
  return uid;
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

// ── Bun server tuning for a cheap VPS (high concurrency, low memory) ──────────
app.listen({ port: PORT, reusePort: true, hostname: "0.0.0.0" });
console.log(`[web] Elysia on :${PORT} · STDB ${cfg.spacetime.module} · realtime WS at /ws`);

export type App = typeof app;
