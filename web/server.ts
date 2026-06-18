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
import { HouseState, plinko, coinflip, doubleOrNothing, HOUSE_GAMES, PLINKO } from "../src/HouseGames.mjs";
import { CaseBattle } from "../src/CaseBattle.mjs";
import { AdminPanel } from "../src/AdminPanel.mjs";
import { Stdb } from "./src/stdb.ts";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const cfg = JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8"));
const PORT = cfg.web?.port ?? cfg.webPort ?? 80;
const INTERNAL_SECRET = cfg.web?.internalSecret ?? "";
const ASSET_VER = Date.now().toString(36);

// ── data layer ────────────────────────────────────────────────────────────
const db = new Database(cfg.mongodb.uri, cfg.mongodb.database);
// SpacetimeDB: connect in the BACKGROUND with auto-retry. The server must still
// boot + listen even if STDB is briefly unreachable (balances read 0 until synced),
// so a connect failure can never take the whole website down.
const ST = (cfg.spacetime || {}) as any;
const stdb = new Stdb(ST.uri || "ws://127.0.0.1:3000", ST.module || "sirgreen-6ls47", ST.token);
stdb.ready().then(() => console.log("[web] SpacetimeDB connected")).catch((e) => console.error("[web] SpacetimeDB connect failed (retrying in background):", e?.message));
const house = new HouseState();

// Case-battle engine — balances via STDB, tiers/stats via Mongo.
const cb = new CaseBattle({
  bal: {
    deduct: (uid: string, amt: number) => stdb.deduct(uid, amt).then(() => true, () => false),
    credit: (uid: string, amt: number) => stdb.credit(uid, amt).catch(() => {}),
    getBalance: (uid: string) => Promise.resolve(stdb.getBalance(uid)),
  },
  db: {
    getCustomTiers: () => (db as any).getCustomTiers ? (db as any).getCustomTiers() : Promise.resolve([]),
    saveCustomTiers: (t: any) => (db as any).saveCustomTiers ? (db as any).saveCustomTiers(t) : Promise.resolve(),
    recordGame: (u: string, w: boolean, a: number) => db.recordGame ? db.recordGame(u, w, a) : Promise.resolve(),
  },
  getAvatar: async (uid: string) => { const u = await db.getUser(uid).catch(() => null); return u?.av || fluxerAvatarUrl(uid, null); },
});
const admin = new AdminPanel(db, cfg.prefix ?? "&");
// Background init — NO top-level await anywhere in this module, so PM2's bun fork
// (which require()s the entry) can load it. Connect Mongo, then load custom tiers.
db.connect()
  .then(() => cb.loadCustomTiers())
  .then(() => console.log("[web] Mongo connected + custom tiers loaded"))
  .catch((e) => console.error("[web] Mongo init failed:", e?.message));

// ── tiny helpers ────────────────────────────────────────────────────────────
const GAMES_DIR = join(ROOT, "games");
const MIME: Record<string, string> = { ".css": "text/css", ".js": "text/javascript", ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2", ".json": "application/json", ".mp3": "audio/mpeg" };

function parseCookieStr(h: string): Record<string, string> {
  const o: Record<string, string> = {};
  for (const part of (h || "").split(";")) { const i = part.indexOf("="); if (i > 0) o[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return o;
}
function parseCookies(req: Request): Record<string, string> { return parseCookieStr(req.headers.get("cookie") || ""); }
// Explicit 302 — set.redirect isn't honored in this Elysia build, so set status + Location.
function redir(set: any, url: string): string { set.status = 302; set.headers["Location"] = url; return ""; }
// 302 + multiple Set-Cookie via a real Response (set.headers array isn't reliably
// emitted as separate cookies by this Elysia build).
function redirectWithCookies(url: string, cookies: string[]): Response {
  const h = new Headers(); h.set("Location", url);
  for (const c of cookies) h.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers: h });
}
// Session/display cookies. `Secure` is set only when the request actually arrived over
// HTTPS (Cloudflare's x-forwarded-proto), so direct-HTTP access can't silently fail login.
const isHttps = (request: Request): boolean => (request.headers.get("x-forwarded-proto") || "").split(",")[0].trim() === "https";
function ckOpts(secure: boolean, httpOnly: boolean) { return { httpOnly, path: "/", maxAge: 7200, sameSite: "lax" as const, secure }; }
function setAuthCookies(cookie: any, secure: boolean, v: { sid: string; uid: string; tag?: string; avatar?: string; srv?: string }) {
  cookie.sid.set({ value: v.sid, ...ckOpts(secure, true) });
  cookie.uid.set({ value: v.uid, ...ckOpts(secure, true) });
  if (v.tag != null) cookie.dtag.set({ value: v.tag, ...ckOpts(secure, false) });
  if (v.avatar != null) cookie.dav.set({ value: v.avatar, ...ckOpts(secure, false) });
  if (v.srv != null) cookie.srv.set({ value: v.srv, ...ckOpts(secure, false) });
}
// Ask the Node bot (which holds the Fluxer client) to DM a user — used for ticket transcripts.
const BOT_DM_URL = "http://127.0.0.1:" + (cfg.web?.botPort ?? 8091);
async function sendDM(uid: string, text: string, title?: string) {
  try { await fetch(BOT_DM_URL + "/dm", { method: "POST", headers: { "Content-Type": "application/json", "x-internal": INTERNAL_SECRET }, body: JSON.stringify({ uid, text, title }) }); } catch {}
}
// Verify the session server-side (sid must exist + be unexpired in Mongo), 30s cache.
const sessCache = new Map<string, { uid: string; until: number }>();
async function resolveSessionCookie(cookieHeader: string): Promise<string | null> {
  const c = parseCookieStr(cookieHeader || "");
  if (!c.sid || !c.uid) return null;
  const hit = sessCache.get(c.sid);
  if (hit && hit.uid === c.uid && hit.until > Date.now()) return c.uid;
  const v = await db.validateSession(c.uid, c.sid).catch(() => null);
  if (!v) { sessCache.delete(c.sid); return null; }
  sessCache.set(c.sid, { uid: c.uid, until: Date.now() + 30_000 });
  return c.uid;
}
async function resolveSession(req: Request): Promise<string | null> {
  return resolveSessionCookie(req.headers.get("cookie") || "");
}

// ── OAuth + page rendering (ported from src/WebServer.mjs) ───────────────────
const FLUXER_AUTH_URL = "https://web.canary.fluxer.app/oauth2/authorize";
const FLUXER_TOKEN_URL = "https://api.fluxer.app/v1/oauth2/token";
const FLUXER_ME_URL = "https://api.fluxer.app/v1/users/@me";
const FLUXER_CDN = "https://fluxerusercontent.com";
const FLUXER_STATIC_CDN = "https://fluxerstatic.com";
const CLIENT_ID = cfg.fluxerClientId ?? "";
const CLIENT_SECRET = cfg.fluxerClientSecret ?? "";
const BASE_URL = (cfg.webBaseUrl ?? "").replace(/\/$/, "");
const REDIRECT_URI = `${BASE_URL}/oauth/callback`;
const OWNERS: string[] = Array.isArray(cfg.owners) ? cfg.owners.map(String) : [];
const oauthStates = new Map<string, number>(); // state → expiry
const SIDEBAR_TPL = (() => { try { return readFileSync(join(GAMES_DIR, "partials", "sidebar.html"), "utf8"); } catch { return ""; } })();
const PAGE_IDS = ["lobby", "case-battle", "slots", "house", "leaderboard", "settings", "misc", "notifications"];

function esc(s: any): string { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)); }
function fluxerAvatarUrl(userId: string, hash: string | null, size = 64): string {
  if (!hash) { let i = 0; try { i = Number(BigInt(userId) % 6n); } catch {} return `${FLUXER_STATIC_CDN}/avatars/${i}.png`; }
  const ext = String(hash).startsWith("a_") ? "gif" : "png";
  return `${FLUXER_CDN}/avatars/${userId}/${hash}.${ext}?size=${size}`;
}
function buildSidebar(a: { active: string; tag: string; avatar: string; bal: number; showAdmin: boolean; showServers: boolean }): string {
  let s = SIDEBAR_TPL;
  for (const p of PAGE_IDS) s = s.replace(`__ACTIVE_${p}__`, p === a.active ? "active" : "");
  const serversNav = a.showServers
    ? `<a href="/servers" class="sb-item ${a.active === "servers" ? "active" : ""}"><svg class="icon" viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg><span>Servers</span></a>`
    : "";
  const adminNav = a.showAdmin
    ? `<a href="/admin" class="sb-item admin ${a.active === "admin" ? "active" : ""}"><svg class="icon" viewBox="0 0 24 24"><path d="M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z"/><path d="M9 12l2 2 4-4"/></svg><span>Admin</span></a>`
    : "";
  return s.replace("__SERVERS_NAV__", serversNav).replace("__ADMIN_NAV__", adminNav).replace(/__TAG__/g, esc(a.tag)).replace(/__AVATAR__/g, esc(a.avatar)).replace(/__BALANCE__/g, Number(a.bal).toLocaleString());
}
// Does this user own at least one bot-guild? (gates the Servers dashboard.)
const ownsCache = new Map<string, { owns: boolean; until: number }>();
async function ownsAnyServer(uid: string, gids: string[]): Promise<boolean> {
  const hit = ownsCache.get(uid);
  if (hit && hit.until > Date.now()) return hit.owns;
  let owns = false;
  if (gids.length) { const gs = await db.getGuildsByIds(gids).catch(() => []); owns = gs.some((g: any) => g.ownerId === uid); }
  ownsCache.set(uid, { owns, until: Date.now() + 60_000 });
  return owns;
}
// Holds the "servers" permission → may view + edit EVERY server (bank/tax/shop). Owner always true.
const canManageServers = (uid: string): Promise<boolean> => admin.can(uid, "servers").catch(() => false);
// Tax exemption (no 15% floor, no vote to raise): the "tax" or "servers" permission.
const isTaxExempt = async (uid: string): Promise<boolean> => (await admin.can(uid, "tax").catch(() => false)) || (await canManageServers(uid));
async function renderPage(request: Request, set: any, file: string, active: string, extra: Record<string, string> = {}) {
  const uid = await resolveSession(request);
  if (!uid) { return redir(set, "/login"); }
  const fp = join(GAMES_DIR, file);
  if (!existsSync(fp)) { set.status = 503; return "Page not available"; }
  const c = parseCookies(request);
  const user = await db.getUser(uid).catch(() => null);
  const bal = stdb.getBalance(uid);
  const tag = c.dtag || user?.tag || "Player";
  let avatar = c.dav || user?.av || ""; if (!avatar) avatar = fluxerAvatarUrl(uid, null);
  const showAdmin = await admin.canSeePanel(uid).catch(() => OWNERS.includes(uid)); // owner OR a perm with a panel tab
  let showServers = await ownsAnyServer(uid, Array.isArray(user?.gids) ? user!.gids : []).catch(() => false);
  if (!showServers) showServers = await canManageServers(uid); // server-managers see it too
  let html = readFileSync(fp, "utf8")
    .replace("__SIDEBAR__", buildSidebar({ active, tag, avatar, bal, showAdmin, showServers }))
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
const rlShop = new Map<string, number>(); // throttle shop buy/remove per user+server (anti-cycling)

// ── per-server tax (winnings cut → server bank) ──────────────────────────────
// Tax is charged on PROFIT only (winnings above the stake), default 15%, capped
// 50%. The selected server (`srv` cookie) decides the rate + receives the cut.
const DEFAULT_TAX_BPS = 1500, MAX_TAX_BPS = 5000, MIN_TAX_BPS = 1500; // 15% floor for normal owners; the bot owner is exempt
const taxCache = new Map<string, { bps: number; until: number }>();
async function guildTax(gid: string): Promise<number> {
  if (!gid) return 0;
  const hit = taxCache.get(gid);
  if (hit && hit.until > Date.now()) return hit.bps;
  // Effective tax = 0 during a bought Tax Holiday, else the server's set rate.
  const econ: any = await (db as any).getGuildEconomy(gid).catch(() => null);
  const holiday = econ?.shop?.taxHolidayUntil && econ.shop.taxHolidayUntil > Date.now();
  const bps = holiday ? 0 : (Number.isFinite(econ?.taxBps) ? econ.taxBps : DEFAULT_TAX_BPS);
  taxCache.set(gid, { bps, until: Date.now() + 60_000 }); // holiday end may lag ≤60s
  return bps;
}
function taxOnProfit(profit: number, bps: number): number {
  if (!(profit > 0) || !(bps > 0)) return 0;
  return Math.min(profit, Math.floor(profit * bps / 10000));
}
// A bought Tax Holiday forces the EFFECTIVE tax to 0 while active.
const holidayActive = (shop: any, now = Date.now()): boolean => (Number(shop?.taxHolidayUntil) || 0) > now;
const effectiveTaxBps = (taxBps: number, shop: any, now = Date.now()): number => holidayActive(shop, now) ? 0 : taxBps;
// Resolve + require the gambling server for this request. Returns null when no
// server is selected (the "must pick a server to gamble" gate).
async function requireServer(request: Request, uid: string): Promise<{ gid: string; taxBps: number } | null> {
  const gid = parseCookies(request).srv || "";
  if (!gid) return null;
  // The `srv` cookie is client-controlled — verify the guild is real AND that the
  // user actually belongs to it, so tax/stats can't be routed to an arbitrary bank.
  const g = await db.getGuild(gid).catch(() => null);
  if (!g) return null;
  const user = await db.getUser(uid).catch(() => null);
  const gids: string[] = Array.isArray(user?.gids) ? user.gids : [];
  if (gids.length && !gids.includes(gid)) return null; // not a member of the selected server
  return { gid, taxBps: await guildTax(gid) };
}

// ── FluxerList vote check (gates owner tax changes) ──────────────────────────
const FL_LIST_URL = "https://fluxerlist.com/api/v1";
const FL_SERVER_ID = String(cfg.fluxerListServerId ?? "");
const FL_API_KEY = String(cfg.fluxerListApiKey ?? "");
const voteCache = new Map<string, { voted: boolean; until: number }>();
async function hasVoted(userId: string): Promise<boolean> {
  if (!FL_SERVER_ID || !FL_API_KEY) return false;
  const hit = voteCache.get(userId);
  if (hit && hit.until > Date.now()) return hit.voted;
  let voted = false;
  try {
    const r = await fetch(`${FL_LIST_URL}/servers/${FL_SERVER_ID}/voters`, {
      headers: { Authorization: `Bearer ${FL_API_KEY}`, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      const data: any = await r.json();
      const voters = Array.isArray(data?.voters) ? data.voters : [];
      voted = voters.some((v: any) => String(v?.fluxerId ?? v?.id ?? v) === String(userId));
    }
  } catch (e: any) { console.error("[FluxerList] vote check failed:", e?.message); }
  voteCache.set(userId, { voted, until: Date.now() + 5 * 60_000 });
  return voted;
}

// ── server Shop — owners spend their server bank on perks ────────────────────
// `kind`: "duration" perks extend a `<field>Until` timestamp; "accent" sets a color.
const DAY = 86_400_000, HOUR = 3_600_000;
const SHOP_ITEMS = [
  { id: "featured", label: "Featured Spotlight", icon: "star", kind: "duration", field: "featuredUntil", durationMs: 7 * DAY, price: 50_000,
    desc: "Pin your server to the top of the global leaderboard with a ✨ badge for 7 days." },
  { id: "tax_holiday", label: "Tax Holiday", icon: "calendar", kind: "duration", field: "taxHolidayUntil", durationMs: 48 * HOUR, price: 25_000,
    desc: "Waive your server's winnings tax for 48 hours to pull a crowd. (No tax = no bank income during the holiday.)" },
  { id: "accent", label: "Custom Accent", icon: "palette", kind: "accent", field: "accent", price: 15_000,
    desc: "Set a custom accent color shown on your leaderboard entry and Servers dashboard." },
] as const;
const shopCatalog = () => SHOP_ITEMS.map(i => ({ id: i.id, label: i.label, icon: i.icon, kind: i.kind, price: i.price, desc: i.desc, durationMs: (i as any).durationMs ?? 0 }));
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const safeHex = (v: any, fallback: string): string => { const s = String(v ?? ""); return HEX_RE.test(s) ? s : fallback; };
// Server join invites must be fluxer.gg links. Normalize paste variants → canonical
// https URL; return "" to clear, null if it's not a valid fluxer.gg link.
function normalizeFluxerInvite(raw: any): string | null {
  let s = String(raw ?? "").trim();
  if (!s) return "";
  s = s.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  if (!/^fluxer\.gg\/[A-Za-z0-9._~%\-\/?=&#]{1,200}$/i.test(s)) return null;
  return "https://" + s;
}

// ── realtime WebSocket hub ───────────────────────────────────────────────────
// One socket per browser tab. On open we auth via the session cookie, subscribe the
// user to STDB balance + notification pushes, and stream them down. No polling.
type WSData = { uid: string | null; offBal?: () => void; offNotif?: () => void; offBanks?: Array<() => void> };

// Live sockets, for in-process broadcast (tickets). Single web instance assumed; a
// scale-out would route this through STDB/redis pub-sub instead.
const wsClients = new Set<any>();
function broadcastTicket(ownerUid: string, payload: any) {
  const msg = JSON.stringify(payload);
  for (const ws of wsClients) {
    const d = ws.data as any;
    if (d.uid && (d.uid === ownerUid || d.isAdmin)) { try { ws.send(msg); } catch {} }
  }
}
// Push a live stat delta for a server to every socket watching it (owners + managers).
// Keeps the Servers dashboard's stat tiles updating in real time without polling.
function broadcastServerPlay(gid: string, patch: Record<string, number | boolean>) {
  if (!gid) return;
  const msg = JSON.stringify({ type: "server-play", gid, ...patch });
  for (const ws of wsClients) {
    const d = ws.data as any;
    if (d.watchGids && d.watchGids.has(gid)) { try { ws.send(msg); } catch {} }
  }
}
// Push a server's tax + shop state (incl. effective tax during a holiday) to EVERY
// socket, so the selected-server tax note and every dashboard update in real time.
// Low-frequency (only on tax/shop edits) so a global fan-out is fine.
async function broadcastServerEcon(gid: string) {
  if (!gid) return;
  const econ: any = await (db as any).getGuildEconomy(gid).catch(() => null);
  if (!econ) return;
  const now = Date.now(), shop = econ.shop || {};
  const msg = JSON.stringify({
    type: "server-econ", gid,
    taxBps: econ.taxBps, effTax: effectiveTaxBps(econ.taxBps, shop, now),
    shop: { featuredUntil: shop.featuredUntil || 0, taxHolidayUntil: shop.taxHolidayUntil || 0,
            accent: HEX_RE.test(shop.accent || "") ? shop.accent : null,
            featured: (shop.featuredUntil || 0) > now, taxHoliday: (shop.taxHolidayUntil || 0) > now },
  });
  for (const ws of wsClients) { try { ws.send(msg); } catch {} }
}
// Push a guild rename/icon change (from the bot) to every socket — names update live.
function broadcastGuild(gid: string, name: any, icon: any, members: any) {
  if (!gid) return;
  const msg = JSON.stringify({ type: "guild", gid, name: name ?? null, icon: icon ?? null, members: members ?? null });
  for (const ws of wsClients) { try { ws.send(msg); } catch {} }
}

// Global per-IP rate limit — blocks extreme spam (real client IP via Cloudflare header).
const ipHits = new Map<string, number[]>();
setInterval(() => { const cut = Date.now() - 15000; for (const [ip, arr] of ipHits) { while (arr.length && arr[0] < cut) arr.shift(); if (!arr.length) ipHits.delete(ip); } }, 30000);
function rateLimited(request: Request): boolean {
  const ip = request.headers.get("cf-connecting-ip") || (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "?";
  const now = Date.now(), WIN = 10000, MAX = 150; // 150 req / 10s per IP
  let arr = ipHits.get(ip); if (!arr) { arr = []; ipHits.set(ip, arr); }
  while (arr.length && arr[0] < now - WIN) arr.shift();
  if (arr.length >= MAX) return true;
  arr.push(now); return false;
}

const app = new Elysia()
  .onRequest(({ request, set }) => { if (rateLimited(request)) { set.status = 429; return "Too many requests"; } })
  // make the upgrade request's cookie available inside the ws context (ws.data)
  .derive(({ request }) => ({ cookieHeader: request.headers.get("cookie") || "" }))
  .ws("/ws", {
    async open(ws) {
      const cookie = (ws.data as any)?.cookieHeader || (ws.data as any)?.headers?.cookie || "";
      const uid = await resolveSessionCookie(cookie);
      (ws.data as any).uid = uid;
      if (!uid) { ws.send(JSON.stringify({ type: "auth", ok: false })); return; }
      await stdb.ensureAccount(uid).catch(() => {});
      await stdb.subscribeNotifs(uid).catch(() => {});
      const snap = await stdb.getNotifications(uid).catch(() => ({ items: [], unread: 0 }));
      ws.send(JSON.stringify({ type: "init", bal: stdb.getBalance(uid), items: snap.items, unread: snap.unread }));
      (ws.data as any).offBal = stdb.onBalance(uid, (bal) => ws.send(JSON.stringify({ type: "balance", bal })));
      (ws.data as any).offNotif = stdb.onNotification(uid, (n) =>
        ws.send(JSON.stringify({ type: "notification", item: { t: n.kind, m: n.msg, a: Number(n.amount), f: n.fromTag, ts: Number(n.ts) } })));
      (ws.data as any).isAdmin = await admin.isAdmin(uid).catch(() => false);
      // Live server-bank pushes for the Servers dashboard: servers this user owns,
      // or ALL servers for a manager (the "servers" permission).
      try {
        let watch: string[] = [];
        if (await canManageServers(uid)) {
          watch = (await db.getGuilds().catch(() => [])).map((g: any) => g._id);
        } else {
          const u = await db.getUser(uid).catch(() => null);
          const gids: string[] = Array.isArray(u?.gids) ? u.gids : [];
          if (gids.length) watch = (await db.getGuildsByIds(gids).catch(() => [])).filter((g: any) => g.ownerId === uid).map((g: any) => g._id);
        }
        if (watch.length) {
          (ws.data as any).watchGids = new Set(watch);          // for live server-play stat pushes
          const offs: Array<() => void> = [];
          for (const gid of watch) {
            ws.send(JSON.stringify({ type: "bank", gid, bal: stdb.getServerBank(gid) }));
            offs.push(stdb.onBank(gid, (b) => ws.send(JSON.stringify({ type: "bank", gid, bal: b }))));
          }
          (ws.data as any).offBanks = offs;
        }
      } catch {}
      wsClients.add(ws);
    },
    close(ws) {
      const d = ws.data as any;
      d.offBal?.(); d.offNotif?.();
      if (Array.isArray(d.offBanks)) for (const off of d.offBanks) try { off(); } catch {}
      if (d.uid) stdb.unsubscribeNotifs(d.uid);
      wsClients.delete(ws);
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
    const srv = await requireServer(request, uid);
    if (!srv) { set.status = 400; return { error: "Select a server to play on", needServer: true }; }
    const b = body as any;
    const game = Slots.getGame(String(b?.game ?? "")); if (!game) return { error: "Unknown game" };
    const bet = Math.floor(Number(b?.bet) || 0);
    if (!(bet >= 1) || bet > 1_000_000) return { error: "Invalid bet" };
    const buy = b?.buy === "super" ? "super" : (b?.buy === "regular" ? "regular" : false);
    const cost = buy ? bet * Slots.buyCost(game.id, buy) : bet;
    if (cost > 50_000_000) return { error: "Bet too large for a buy" };
    let result;
    try { result = Slots.spin(game.id, bet, buy); } catch { set.status = 500; return { error: "Spin failed" }; }
    // one atomic settle: take cost, pay winnings minus the server's tax on profit
    const tax = taxOnProfit(result.totalWin - cost, srv.taxBps);
    try { await stdb.settleWin(uid, cost, result.totalWin, srv.gid, tax); }
    catch (e: any) { return { error: e?.message === "insufficient" ? "Insufficient balance" : "Settle failed" }; }
    db.recordGame?.(uid, result.totalWin >= cost, cost).catch(() => {});
    (db as any).recordServerWager?.(srv.gid, cost, uid).catch(() => {});
    (db as any).recordServerPayout?.(srv.gid, result.totalWin, tax).catch(() => {});
    broadcastServerPlay(srv.gid, { dGames: 1, dWager: cost, dPayout: result.totalWin, dTax: tax, big: result.totalWin });
    return { game: game.id, bet, cost, buy, spins: result.spins, totalWin: result.totalWin, tax, freeTriggered: result.freeTriggered, freeAwarded: result.freeAwarded, mode: result.mode, superMult: result.superMult, superPre: result.superPre, balance: stdb.getBalance(uid) };
  })

  // ── house games (Plinko / Coinflip / Double = stateless; Mines / HiLo = stateful)
  .post("/api/house/*", async ({ request, params, body, set }) => {
    const uid = await resolveSession(request); if (!uid) { set.status = 401; return { error: "Not logged in" }; }
    const sub = (params as any)["*"] as string;
    // Plinko is multi-ball (up to 10 rapid drops, client-capped) — exempt it from the
    // per-op throttle; everything else stays rate-limited.
    // Per-user throttle: plinko is multi-ball so it gets a lenient 50ms (vs 120ms) but
    // is NOT fully exempt anymore — prevents unbounded ledger hammering.
    if (rl(rlMoney, uid, sub === "plinko" ? 50 : 120)) { set.status = 429; return { error: "Slow down a moment" }; }
    const srv = await requireServer(request, uid);
    if (!srv) { set.status = 400; return { error: "Select a server to play on", needServer: true }; }
    const d = body as any;
    const bet = Math.floor(Number(d?.bet) || 0);
    const goodBet = bet >= 1 && bet <= 1_000_000;
    const bal = () => stdb.getBalance(uid);
    const wager = (amt: number) => { (db as any).recordServerWager?.(srv.gid, amt, uid).catch(() => {}); broadcastServerPlay(srv.gid, { dGames: 1, dWager: amt }); };
    // Credit a payout, routing the server's tax on profit (payout − stake) to its bank.
    const payWin = (payout: number, stake: number) => {
      const tax = payout > 0 ? taxOnProfit(payout - stake, srv.taxBps) : 0;
      (db as any).recordServerPayout?.(srv.gid, payout, tax).catch(() => {});
      if (payout > 0) broadcastServerPlay(srv.gid, { dPayout: payout, dTax: tax, big: payout });
      if (!(payout > 0)) return Promise.resolve();
      return stdb.creditWin(uid, payout, srv.gid, tax).catch(() => {});
    };

    if (sub === "plinko") {
      if (!goodBet) return { error: "Invalid bet" };
      try { await stdb.deduct(uid, bet); } catch { return { error: "Insufficient balance" }; }
      wager(bet);
      const r = plinko(bet, d?.risk); await payWin(r.payout, bet); db.recordGame?.(uid, r.payout >= bet, bet).catch(() => {});
      return Object.assign(r, { balance: bal() });
    }
    if (sub === "coinflip") {
      if (!goodBet) return { error: "Invalid bet" };
      try { await stdb.deduct(uid, bet); } catch { return { error: "Insufficient balance" }; }
      wager(bet);
      const r = coinflip(bet, d?.side); await payWin(r.payout, bet); db.recordGame?.(uid, r.win, bet).catch(() => {});
      return Object.assign(r, { balance: bal() });
    }
    if (sub === "double") {
      if (!goodBet) return { error: "Invalid bet" };
      try { await stdb.deduct(uid, bet); } catch { return { error: "Insufficient balance" }; }
      wager(bet);
      const r = doubleOrNothing(bet); await payWin(r.payout, bet); db.recordGame?.(uid, r.win, bet).catch(() => {});
      return Object.assign(r, { balance: bal() });
    }
    if (sub === "mines/start") {
      if (!goodBet) return { error: "Invalid bet" };
      try { await stdb.deduct(uid, bet); } catch { return { error: "Insufficient balance" }; } // charge BEFORE clearing the old game
      house.clearMines(uid);
      wager(bet);
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
      await payWin((r as any).payout, (r as any).bet ?? 0); return Object.assign(r, { balance: bal() });
    }
    if (sub === "hilo/start") {
      if (!goodBet) return { error: "Invalid bet" };
      try { await stdb.deduct(uid, bet); } catch { return { error: "Insufficient balance" }; } // charge BEFORE clearing the old game
      house.clearHilo(uid);
      wager(bet);
      return Object.assign(house.startHilo(uid, bet), { ok: true, balance: bal() });
    }
    if (sub === "hilo/guess") { return house.hiloGuess(uid, d?.dir); }
    if (sub === "hilo/cashout") {
      const r = house.hiloCashout(uid);
      if ((r as any).error) return r;
      await payWin((r as any).payout, (r as any).bet ?? 0); return Object.assign(r, { balance: bal() });
    }
    set.status = 404; return { error: "Unknown game" };
  })
  .get("/api/house/games", async ({ request, set }) => {
    const uid = await resolveSession(request); if (!uid) { set.status = 401; return { error: "Not logged in" }; }
    return { games: HOUSE_GAMES, plinko: PLINKO }; // board needs the bucket tables
  })

  // ── internal bridge for the Node bot (shared-secret + loopback only) ────────
  .group("/internal", (g) => g
    .onBeforeHandle(({ request, set, server }) => {
      // Only the local bot may use these (balance mint, broadcasts). Require the shared
      // secret AND that the connection originates from loopback — so even if the secret
      // leaks, the mint-capable endpoints aren't reachable from the internet.
      if (!INTERNAL_SECRET || request.headers.get("x-internal") !== INTERNAL_SECRET) { set.status = 403; return { error: "forbidden" }; }
      const ip = (server as any)?.requestIP?.(request)?.address || "";
      if (ip && ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") { set.status = 403; return { error: "forbidden" }; }
      // Reject if the request also carries Cloudflare/proxy hop headers (came from outside).
      if (request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")) { set.status = 403; return { error: "forbidden" }; }
    })
    .get("/balance/:uid", ({ params }) => ({ bal: stdb.getBalance(params.uid) }))
    .post("/credit", async ({ body }) => { const b = body as any; try { await stdb.credit(b.uid, Math.floor(b.amount)); return { ok: true, bal: stdb.getBalance(b.uid) }; } catch (e: any) { return { ok: false, error: e?.message }; } })
    .post("/deduct", async ({ body }) => { const b = body as any; try { await stdb.deduct(b.uid, Math.floor(b.amount)); return { ok: true, bal: stdb.getBalance(b.uid) }; } catch (e: any) { return { ok: false, error: e?.message }; } })
    .post("/settle", async ({ body }) => { const b = body as any; try { await stdb.settle(b.uid, Math.floor(b.bet), Math.floor(b.payout)); return { ok: true, bal: stdb.getBalance(b.uid) }; } catch (e: any) { return { ok: false, error: e?.message }; } })
    .post("/transfer", async ({ body }) => { const b = body as any; try { await stdb.transfer(b.from, b.to, Math.floor(b.amount), b.fromTag || ""); return { ok: true }; } catch (e: any) { return { ok: false, error: e?.message }; } })
    .post("/notify", async ({ body }) => { const b = body as any; try { await stdb.addNotification(b.uid, b.kind || "info", Math.floor(b.amount || 0), b.fromTag || "", b.msg || ""); return { ok: true }; } catch (e: any) { return { ok: false, error: e?.message }; } })
    .post("/set", async ({ body }) => { const b = body as any; try { await stdb.setExact(b.uid, Math.floor(b.balance)); return { ok: true }; } catch (e: any) { return { ok: false, error: e?.message }; } })
    .post("/guild", ({ body }) => { const b = body as any; broadcastGuild(String(b?.gid || ""), b?.name, b?.icon, b?.members); return { ok: true }; })
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
  if (!existsSync(fp)) { return redir(set, authUrl); }
  set.headers["content-type"] = "text/html; charset=utf-8";
  return readFileSync(fp, "utf8").replace("__AUTH_URL__", esc(authUrl));
});

app.get("/oauth/callback", async ({ query, set, request, cookie }) => {
  const code = (query as any).code, state = (query as any).state;
  const exp = state ? oauthStates.get(state) : undefined;
  if (!code || !state || !exp) { console.error("[oauth] bad state"); return redir(set, "/login"); }
  oauthStates.delete(state);
  if (Date.now() > exp) { console.error("[oauth] state expired"); return redir(set, "/login"); }
  let token: any;
  try {
    const r = await fetch(FLUXER_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI }).toString() });
    token = await r.json();
  } catch (e: any) { console.error("[oauth] token fetch", e?.message); return redir(set, "/login"); }
  if (!token?.access_token) { console.error("[oauth] no access_token:", token?.error || token?.message || JSON.stringify(token).slice(0, 200)); return redir(set, "/login"); }
  let me: any;
  try { me = await (await fetch(FLUXER_ME_URL, { headers: { Authorization: `Bearer ${token.access_token}` } })).json(); } catch (e: any) { console.error("[oauth] /me", e?.message); return redir(set, "/login"); }
  const uid = me?.id; if (!uid) { console.error("[oauth] no uid in /me:", JSON.stringify(me).slice(0, 200)); return redir(set, "/login"); }
  const tag = me.global_name ?? me.displayName ?? me.username ?? me.tag ?? uid;
  const avatar = fluxerAvatarUrl(uid, me.avatar);
  await db.setProfile(uid, { tag, avatar }).catch(() => {});
  await stdb.ensureAccount(uid).catch(() => {});
  // cache the user's guild ids (scope=guilds) so the server-selector can list their servers
  try {
    const gl = await (await fetch("https://api.fluxer.app/v1/users/@me/guilds", { headers: { Authorization: `Bearer ${token.access_token}` } })).json();
    if (Array.isArray(gl)) await db.setUserGuilds(uid, gl.map((g: any) => String(g.id)).filter(Boolean)).catch(() => {});
  } catch {}
  const ip = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || null;
  const old = parseCookies(request).sid;
  const sid = crypto.randomBytes(32).toString("hex");
  // ALWAYS create the new session (createSession upserts) and revoke the old one
  // separately — never let a stale `sid` cookie block a fresh login (caused a loop).
  await db.createSession(uid, sid, 2 * 60 * 60 * 1000, ip).catch((e: any) => console.error("[oauth] createSession failed:", e?.message));
  if (old && old !== sid) db.revokeSession(uid, old).catch(() => {});
  setAuthCookies(cookie, isHttps(request), { sid, uid, tag, avatar });
  console.log("[oauth] login ok:", uid);
  return redir(set, "/lobby");
});

app.get("/logout", async ({ request, set, cookie }) => {
  const c = parseCookies(request);
  if (c.uid && c.sid) await db.revokeSession(c.uid, c.sid).catch(() => {});
  if (c.sid) sessCache.delete(c.sid);
  for (const k of ["sid", "uid", "dtag", "dav", "srv"]) { try { cookie[k].remove(); } catch {} }
  return redir(set, "/login");
});

// Server-scoped login link from &web — logs in + selects that server's pool.
app.get("/s/:token", async ({ params, set, cookie, request }) => {
  const r = await db.consumeLoginToken((params as any).token).catch(() => null);
  if (!r?.uid) return redir(set, "/login");
  const uid = r.uid;
  await stdb.ensureAccount(uid).catch(() => {});
  const old = parseCookies(request).sid;
  const sid = crypto.randomBytes(32).toString("hex");
  await db.createSession(uid, sid, 2 * 60 * 60 * 1000, null).catch((e: any) => console.error("[s] createSession failed:", e?.message));
  if (old && old !== sid) db.revokeSession(uid, old).catch(() => {});
  const user = await db.getUser(uid).catch(() => null);
  const tag = user?.tag || uid, avatar = user?.av || fluxerAvatarUrl(uid, null);
  setAuthCookies(cookie, isHttps(request), { sid, uid, tag, avatar, srv: r.gid || undefined });
  console.log("[s] server login ok:", uid, "→ server", r.gid);
  return redir(set, "/lobby");
});

// ── authed pages (sidebar + tokens injected; ?v= cache-bust) ─────────────────
const PAGES: [string, string, string][] = [
  ["/", "lobby.html", "lobby"], ["/lobby", "lobby.html", "lobby"],
  ["/slots", "slots.html", "slots"], ["/house", "house.html", "house"],
  ["/leaderboard", "leaderboard.html", "leaderboard"],
  ["/settings", "settings.html", "settings"], ["/misc", "misc.html", "misc"],
  ["/notifications", "notifications.html", "notifications"],
];
for (const [p, f, a] of PAGES) app.get(p, ({ request, set }) => renderPage(request, set, f, a));
app.get("/case-battle", ({ request, set }) => renderPage(request, set, "case-battle.html", "case-battle", { "__BATTLE_ID__": "" }));
app.get("/case-battle/:id", ({ request, set, params }) => renderPage(request, set, "case-battle.html", "case-battle", { "__BATTLE_ID__": esc((params as any).id) }));
// Admin as a seamless in-app tab (embeds /admin/panel in an iframe — CSS-isolated)
app.get("/admin", async ({ request, set }) => {
  const uid = await resolveSession(request); if (!uid) return redir(set, "/login");
  if (!(await admin.canSeePanel(uid))) return redir(set, "/lobby");
  return renderPage(request, set, "admin.html", "admin");
});
// Servers dashboard — server owners, plus admins with the "servers" permission.
app.get("/servers", async ({ request, set }) => {
  const uid = await resolveSession(request); if (!uid) return redir(set, "/login");
  const user = await db.getUser(uid).catch(() => null);
  const ok = (await ownsAnyServer(uid, Array.isArray(user?.gids) ? user!.gids : [])) || (await canManageServers(uid));
  if (!ok) return redir(set, "/lobby");
  return renderPage(request, set, "servers.html", "servers");
});

// ── Case Battle API (engine: ../src/CaseBattle.mjs; balances via STDB) ───────
const authed = async (request: Request, set: any) => { const uid = await resolveSession(request); if (!uid) { set.status = 401; } return uid; };
app.get("/api/case-battle/tiers", async ({ request, set }) => { if (!(await authed(request, set))) return { error: "Not logged in" }; return cb.getTiers(); });
app.get("/api/case-battle/list", async ({ request }) => { await resolveSession(request); return cb.list(); });
app.post("/api/case-battle/create", async ({ request, body, set }) => { const uid = await authed(request, set); if (!uid) return { error: "Not logged in" }; if (!(await requireServer(request, uid))) { set.status = 400; return { error: "Select a server to play on", needServer: true }; } const c = parseCookies(request); return cb.create(uid, c.dtag || uid, c.dav || "", body); });
app.post("/api/case-battle/:id/join", async ({ request, params, set }) => { const uid = await authed(request, set); if (!uid) return { error: "Not logged in" }; if (!(await requireServer(request, uid))) { set.status = 400; return { error: "Select a server to play on", needServer: true }; } const c = parseCookies(request); return cb.join(uid, c.dtag || uid, c.dav || "", (params as any).id); });
app.post("/api/case-battle/:id/bot", async ({ request, params, set }) => { const uid = await authed(request, set); if (!uid) return { error: "Not logged in" }; return cb.addBot(uid, (params as any).id); });
app.post("/api/case-battle/:id/recreate", async ({ request, params, set }) => { const uid = await authed(request, set); if (!uid) return { error: "Not logged in" }; return cb.recreate(uid, (params as any).id); });
app.post("/api/case-battle/:id/watch", async ({ request, params, set }) => { const uid = await authed(request, set); if (!uid) return { error: "Not logged in" }; return cb.watch(uid, (params as any).id); });
app.get("/api/case-battle/:id", async ({ request, params, set }) => { const uid = await authed(request, set); if (!uid) return { error: "Not logged in" }; return cb.state(uid, (params as any).id, (u: string) => fluxerAvatarUrl(u, null)); });

// ── Admin panel (owner/perm gated; balances via STDB) ────────────────────────
app.get("/admin/panel", async ({ request, set }) => {
  set.headers["content-type"] = "text/html; charset=utf-8";
  const uid = await resolveSession(request);
  if (!uid) return admin.loginRequired("/login");
  if (!(await admin.isAdmin(uid))) { set.status = 403; return admin.accessDenied(uid); }
  return admin.render(uid);
});
const adminApi = async (request: Request, set: any, fn: (uid: string) => Promise<any>) => {
  const uid = await resolveSession(request);
  if (!uid || !(await admin.isAdmin(uid))) { set.status = 403; return { error: "Forbidden" }; }
  return fn(uid);
};
const withBal = (rows: any[]) => rows.map(r => ({ id: r._id, tag: r.tag || null, avatar: r.av || fluxerAvatarUrl(r._id, null), bal: stdb.getBalance(r._id), perms: Array.isArray(r.perms) ? r.perms : [] }));

app.get("/api/admin/users", ({ request, query, set }) => adminApi(request, set, async (uid) => {
  if (!(await admin.can(uid, "balances")) && !(await admin.can(uid, "users"))) { set.status = 403; return { error: "Missing permission" }; }
  return { users: withBal(await db.searchUsersAdmin((query as any).search || "", 30)) };
}));
app.get("/api/admin/admins", ({ request, set }) => adminApi(request, set, async (uid) => {
  if (!(await admin.can(uid, "balances")) && !(await admin.can(uid, "users"))) { set.status = 403; return { error: "Missing permission" }; }
  const list = withBal(await db.listAdmins());
  const owner = (AdminPanel as any).OWNER_ID;
  if (owner && !list.some(x => x.id === owner)) { const o = await db.getUser(owner).catch(() => null); list.unshift({ id: owner, tag: o?.tag || "Owner", avatar: o?.av || fluxerAvatarUrl(owner, null), bal: stdb.getBalance(owner), perms: [] }); }
  return { users: list };
}));
app.post("/api/admin/users/:id/perms", ({ request, params, body, set }) => adminApi(request, set, async (uid) => {
  if (!(await admin.can(uid, "users"))) { set.status = 403; return { error: "Missing permission" }; }
  const target = (params as any).id; if (target === (AdminPanel as any).OWNER_ID) return { error: "Owner permissions can't be changed" };
  const perm = String((body as any).perm ?? ""); if (!(AdminPanel as any).PERM_IDS.includes(perm)) return { error: "Unknown permission" };
  let next = (await db.getPerms(target)).filter((x: string) => (AdminPanel as any).PERM_IDS.includes(x));
  if ((body as any).grant) { if (!next.includes(perm)) next.push(perm); } else next = next.filter((x: string) => x !== perm);
  await db.setPerms(target, next); return { ok: true, perms: next };
}));
app.post("/api/admin/users/:id/balance", ({ request, params, body, set }) => adminApi(request, set, async (uid) => {
  if (!(await admin.can(uid, "balances"))) { set.status = 403; return { error: "Missing permission" }; }
  const target = (params as any).id, b = body as any;
  let changed = false;
  if (typeof b.set === "number") { await stdb.setExact(target, Math.floor(b.set)).catch(() => {}); changed = true; }
  else if (typeof b.delta === "number") { const d = Math.floor(b.delta); await (d >= 0 ? stdb.credit(target, d) : stdb.deduct(target, -d)).catch(() => {}); changed = true; }
  else return { error: "Provide delta or set" };
  const bal = stdb.getBalance(target);
  // notify the user their balance changed (live, with the new value)
  stdb.addNotification(target, "balance", bal, "Admin", `An admin set your balance to ${bal.toLocaleString()} FC`).catch(() => {});
  return { bal };
}));
app.get("/api/admin/cases", ({ request, set }) => adminApi(request, set, async (uid) => { if (!(await admin.can(uid, "cases"))) { set.status = 403; return { error: "Missing permission" }; } return { tiers: cb.allTiers() }; }));
app.post("/api/admin/cases", ({ request, body, set }) => adminApi(request, set, async (uid) => {
  if (!(await admin.can(uid, "cases"))) { set.status = 403; return { error: "Missing permission" }; }
  const d = body as any; if (!d.id || !d.label || !d.entry || !Array.isArray(d.items) || !d.items.length) return { error: "id, label, entry, items[] required" };
  return cb.addTier({ id: String(d.id), label: String(d.label), entry: Number(d.entry), color: safeHex(d.color, "#2ecc71"), bg: safeHex(d.bg, "#0a1f0a"), builtIn: false, items: d.items.map((i: any) => ({ s: String(i.s), n: String(i.n), v: Number(i.v), w: Number(i.w) })) });
}));
app.put("/api/admin/cases/:id", ({ request, params, body, set }) => adminApi(request, set, async (uid) => {
  if (!(await admin.can(uid, "cases"))) { set.status = 403; return { error: "Missing permission" }; }
  const d = body as any; if (!d.label || !d.entry || !Array.isArray(d.items) || !d.items.length) return { error: "label, entry, items[] required" };
  return cb.editTier(decodeURIComponent((params as any).id), { label: String(d.label), entry: Number(d.entry), color: safeHex(d.color, "#2ecc71"), bg: safeHex(d.bg, "#0a1f0a"), items: d.items.map((i: any) => ({ s: String(i.s), n: String(i.n), v: Number(i.v), w: Number(i.w) })) });
}));
app.delete("/api/admin/cases/:id", ({ request, params, set }) => adminApi(request, set, async (uid) => { if (!(await admin.can(uid, "cases"))) { set.status = 403; return { error: "Missing permission" }; } return cb.deleteTier(decodeURIComponent((params as any).id)); }));
app.get("/api/admin/battles", ({ request, set }) => adminApi(request, set, async (uid) => {
  if (!(await admin.can(uid, "battles"))) { set.status = 403; return { error: "Missing permission" }; }
  return { battles: [...cb.active.values()].map((b: any) => ({ id: b.id, mode: b.mode, phase: b.phase, cost: b.cost, pot: b.pot, maxPlayers: b.maxPlayers, speed: b.speed, jackpot: b.jackpot, crazy: b.crazy, players: b.players.map((p: any) => ({ uid: p.uid, tag: p.tag })), createdAt: b.createdAt, winnerUid: b.winnerUid })) };
}));
app.delete("/api/admin/battles/:id", ({ request, params, set }) => adminApi(request, set, async (uid) => {
  if (!(await admin.can(uid, "battles"))) { set.status = 403; return { error: "Missing permission" }; }
  const b: any = cb.active.get((params as any).id); if (!b) { set.status = 404; return { error: "Battle not found" }; }
  for (const p of b.players) { if (!p.bot) await stdb.credit(p.uid, p.cost).catch(() => {}); cb.userBattle.delete(p.uid); }
  cb.active.delete((params as any).id); return { ok: true };
}));
app.get("/api/admin/tickets", ({ request, set }) => adminApi(request, set, async () => ({ tickets: await db.listTickets({}).catch(() => []) })));
app.post("/api/admin/tickets/:id/reply", ({ request, params, body, set }) => adminApi(request, set, async (uid) => {
  const id = (params as any).id;
  const msg = String((body as any).body || "").trim().slice(0, 2000); if (!msg) return { error: "Message required" };
  const t = await db.getTicket(id).catch(() => null);
  await db.addTicketMessage(id, { from: "admin", uid, body: msg, at: Date.now() }).catch(() => {});
  if (t?.uid) stdb.addNotification(t.uid, "ticket", 0, "Support", `Support replied to your ticket: ${t.subject || ""}`.trim()).catch(() => {}); // realtime ping
  const upd = await db.getTicket(id).catch(() => null);
  if (t?.uid) broadcastTicket(t.uid, { type: "ticket", action: "reply", ticket: upd || t }); // live thread update
  return { ok: true };
}));
app.post("/api/admin/tickets/:id/:action", ({ request, params, set }) => adminApi(request, set, async () => {
  const a = (params as any).action, id = (params as any).id; if (a !== "close" && a !== "open") { set.status = 404; return { error: "?" }; }
  await db.setTicketStatus(id, a === "close" ? "closed" : "open").catch(() => {});
  const upd = await db.getTicket(id).catch(() => null);
  if (upd?.uid) broadcastTicket(upd.uid, { type: "ticket", action: "status", ticket: upd });
  if (a === "close" && upd?.uid) {
    const lines = (upd.messages || []).map((m: any) => `**${m.from === "admin" ? "Support" : "You"}:** ${m.body}`).join("\n");
    sendDM(upd.uid, lines || "(no messages)", `🎫 Ticket closed — ${upd.subject}`); // Fluxer DM (embed) via the bot
    stdb.addNotification(upd.uid, "ticket", 0, "Support", `Ticket closed: ${upd.subject}`).catch(() => {});
  }
  return { ok: true };
}));
app.delete("/api/admin/tickets/:id", ({ request, params, set }) => adminApi(request, set, async () => {
  const id = (params as any).id; const t = await db.getTicket(id).catch(() => null);
  await db.deleteTicket(id).catch(() => {});
  if (t?.uid) broadcastTicket(t.uid, { type: "ticket", action: "delete", id });
  return { ok: true };
}));
app.post("/api/admin/wipe", ({ request, body, set }) => adminApi(request, set, async (uid) => {
  if (uid !== (AdminPanel as any).OWNER_ID) { set.status = 403; return { error: "Owner only" }; }
  const d = body as any;
  if (d.confirm !== "WIPE EVERYTHING") return { error: "Confirmation phrase incorrect" };
  if (String(d.ownerId) !== String((AdminPanel as any).OWNER_ID)) return { error: "Owner ID mismatch" };
  if (d.ack !== true) return { error: "Acknowledgement required" };
  const ok = await db.wipeAll().catch(() => false); return { ok };
}));

// ── support tickets (Mongo storage; realtime pings via STDB notifications) ───
const rlTicket = new Map<string, number>();
app.get("/api/tickets", async ({ request, set }) => {
  const uid = await resolveSession(request); if (!uid) { set.status = 401; return { error: "Not logged in" }; }
  return { tickets: await db.listTickets({ uid }).catch(() => []) };
});
app.post("/api/tickets", async ({ request, body, set }) => {
  const uid = await resolveSession(request); if (!uid) { set.status = 401; return { error: "Not logged in" }; }
  if (rl(rlTicket, uid, 8000)) { set.status = 429; return { error: "Please wait before opening another ticket" }; }
  const tag = parseCookies(request).dtag || uid, b = body as any;
  const subject = String(b?.subject || "").trim().slice(0, 120);
  const msg = String(b?.body || "").trim().slice(0, 2000);
  if (!subject || !msg) return { error: "Subject and message required" };
  const now = Date.now();
  const t = { _id: crypto.randomBytes(8).toString("hex"), uid, tag, subject, status: "open", createdAt: now, updatedAt: now, messages: [{ from: "user", uid, body: msg, at: now }] };
  await db.createTicket(t).catch(() => {});
  for (const o of OWNERS) stdb.addNotification(o, "ticket", 0, tag, `New ticket: ${subject}`).catch(() => {});
  broadcastTicket(uid, { type: "ticket", action: "new", ticket: t }); // live to owner + admins
  return { ticket: t };
});
app.post("/api/tickets/:id/reply", async ({ request, params, body, set }) => {
  const uid = await resolveSession(request); if (!uid) { set.status = 401; return { error: "Not logged in" }; }
  const id = (params as any).id;
  const t = await db.getTicket(id).catch(() => null);
  if (!t || t.uid !== uid) { set.status = 404; return { error: "Not found" }; }
  const msg = String((body as any)?.body || "").trim().slice(0, 2000);
  if (!msg) return { error: "Message required" };
  await db.addTicketMessage(id, { from: "user", uid, body: msg, at: Date.now() }).catch(() => {});
  for (const o of OWNERS) stdb.addNotification(o, "ticket", 0, t.tag || uid, `Reply on: ${t.subject || ""}`.trim()).catch(() => {});
  const upd = await db.getTicket(id).catch(() => null);
  broadcastTicket(uid, { type: "ticket", action: "reply", ticket: upd || t });
  return { ok: true };
});
app.delete("/api/tickets/:id", async ({ request, params, set }) => {
  const uid = await resolveSession(request); if (!uid) { set.status = 401; return { error: "Not logged in" }; }
  const id = (params as any).id; const t = await db.getTicket(id).catch(() => null);
  if (!t || t.uid !== uid) { set.status = 404; return { error: "Not found" }; }
  await db.deleteTicket(id).catch(() => {});
  broadcastTicket(uid, { type: "ticket", action: "delete", id });
  return { ok: true };
});

// ── servers (the user's bot-guilds, for the server selector) ─────────────────
app.get("/api/servers", async ({ request, set }) => {
  const uid = await resolveSession(request); if (!uid) { set.status = 401; return { error: "Not logged in" }; }
  const sel = parseCookies(request).srv || "";
  const user = await db.getUser(uid).catch(() => null);
  const gids: string[] = Array.isArray(user?.gids) ? user.gids : [];
  const ids = sel && !gids.includes(sel) ? gids.concat(sel) : gids;
  const guilds = await db.getGuildsByIds(ids).catch(() => []);
  const servers = guilds.map((g: any) => ({
    id: g._id, name: g.name || "Server", icon: g.icon || null,
    owner: g.ownerId === uid,
    tax: Number.isFinite(g.taxBps) ? g.taxBps : DEFAULT_TAX_BPS,
    holidayUntil: g.shop?.taxHolidayUntil || 0, // selector shows 0% while a holiday is active
    bank: stdb.getServerBank(g._id),
  }));
  return { servers, selected: sel || (servers[0]?.id ?? null), pinned: !!sel };
});
app.post("/api/select-server", async ({ request, body, set, cookie }) => {
  const uid = await resolveSession(request); if (!uid) { set.status = 401; return { error: "Not logged in" }; }
  const gid = String((body as any)?.guildId || "");
  const g = await db.getGuild(gid).catch(() => null);
  if (!g) return { error: "Unknown server" };
  const user = await db.getUser(uid).catch(() => null);
  const gids: string[] = Array.isArray(user?.gids) ? user.gids : [];
  if (gids.length && !gids.includes(gid)) return { error: "You're not in that server" };
  cookie.srv.set({ value: gid, path: "/", maxAge: 7200, sameSite: "lax" });
  return { ok: true, selected: gid };
});

// ── per-server winnings tax (owner-set, gated behind a FluxerList vote) ───────
// The default 15% cut on profit is changeable by the server OWNER, but only while
// they have an active vote for the bot on FluxerList.
app.get("/api/server/tax", async ({ request, query, set }) => {
  const uid = await resolveSession(request); if (!uid) { set.status = 401; return { error: "Not logged in" }; }
  const gid = String((query as any)?.gid || parseCookies(request).srv || "");
  const g = await db.getGuild(gid).catch(() => null);
  if (!g) { set.status = 404; return { error: "Unknown server" }; }
  const manageAll = await canManageServers(uid);              // "servers" perm → edit any server
  const owner = g.ownerId === uid;
  const manage = owner || manageAll;
  const exempt = await isTaxExempt(uid);                       // "tax"/"servers" perm → no floor, no vote
  const voted = manage ? await hasVoted(uid) : false;
  return {
    gid, owner, manage, exempt, voted,
    taxBps: Number.isFinite(g.taxBps) ? g.taxBps : DEFAULT_TAX_BPS,
    minBps: exempt ? 0 : MIN_TAX_BPS, maxBps: MAX_TAX_BPS, defaultBps: DEFAULT_TAX_BPS,
    bank: stdb.getServerBank(gid),
    canChange: manage,                                         // lowering always ok; raising needs a vote (unless exempt)
    needVoteToRaise: manage && !exempt && !voted,
    voteUrl: "https://fluxerlist.com/servers/fabrikken",
  };
});
app.post("/api/server/tax", async ({ request, body, set }) => {
  const uid = await resolveSession(request); if (!uid) { set.status = 401; return { error: "Not logged in" }; }
  const b = body as any;
  const gid = String(b?.gid || parseCookies(request).srv || "");
  const g = await db.getGuild(gid).catch(() => null);
  if (!g) { set.status = 404; return { error: "Unknown server" }; }
  const manageAll = await canManageServers(uid);
  if (g.ownerId !== uid && !manageAll) { set.status = 403; return { error: "Only the server owner can change the tax" }; }
  const exempt = await isTaxExempt(uid);                       // "tax"/"servers" perm bypasses floor + vote
  const minBps = exempt ? 0 : MIN_TAX_BPS;                     // 15% floor otherwise
  const currentBps = Number.isFinite(g.taxBps) ? g.taxBps : DEFAULT_TAX_BPS;
  const pct = Number(b?.percent), bpsRaw = Number(b?.taxBps);
  const bps = Number.isFinite(bpsRaw) ? bpsRaw : Number.isFinite(pct) ? Math.round(pct * 100) : NaN;
  if (!Number.isFinite(bps) || bps < minBps || bps > MAX_TAX_BPS) { set.status = 400; return { error: `Tax must be between ${minBps / 100}% and ${MAX_TAX_BPS / 100}%` }; }
  // Lowering the tax is always allowed; raising it requires an active FluxerList vote (unless exempt).
  if (!exempt && bps > currentBps && !(await hasVoted(uid))) {
    set.status = 403; return { error: "Vote for the bot on FluxerList to raise your server's tax", needVote: true, voteUrl: "https://fluxerlist.com/servers/fabrikken" };
  }
  const saved = await (db as any).setGuildTax(gid, bps).catch(() => null);
  if (saved == null) { set.status = 500; return { error: "Failed to save" }; }
  taxCache.set(gid, { bps: saved, until: Date.now() + 60_000 }); // refresh hot cache immediately
  broadcastServerEcon(gid); // push the new rate to everyone live
  return { ok: true, taxBps: saved };
});

// ── Servers dashboard data (owner-only): each owned server's tax, bank + stats ─
app.get("/api/my-servers", async ({ request, set }) => {
  const uid = await resolveSession(request); if (!uid) { set.status = 401; return { error: "Not logged in" }; }
  const manageAll = await canManageServers(uid);              // "servers" perm → every server
  const exempt = await isTaxExempt(uid);
  const base = { maxBps: MAX_TAX_BPS, defaultBps: DEFAULT_TAX_BPS, voteUrl: "https://fluxerlist.com/servers/fabrikken", shopItems: shopCatalog(), manageAll, exempt };
  let guilds: any[];
  if (manageAll) {
    guilds = await db.getGuilds().catch(() => []);             // admins manage all known servers
  } else {
    const user = await db.getUser(uid).catch(() => null);
    const gids: string[] = Array.isArray(user?.gids) ? user.gids : [];
    if (!gids.length) return { servers: [], voted: false, ...base };
    guilds = (await db.getGuildsByIds(gids).catch(() => [])).filter((g: any) => g.ownerId === uid);
  }
  if (!guilds.length) return { servers: [], voted: manageAll ? true : false, ...base };
  const stats: any[] = await (db as any).getServerStatsMany(guilds.map((g: any) => g._id)).catch(() => []);
  const statMap = new Map(stats.map((s: any) => [s._id, s]));
  const voted = manageAll ? true : await hasVoted(uid);       // managers are exempt; vote banner irrelevant
  const now = Date.now();
  const servers = guilds.map((g: any) => {
    const s: any = statMap.get(g._id) || {}; const shop: any = g.shop || {};
    return {
      id: g._id, name: g.name || "Server", icon: g.icon || null,
      members: g.memberCount ?? null,
      owner: g.ownerId === uid, manage: manageAll || g.ownerId === uid,
      invite: typeof g.invite === "string" ? g.invite : null,
      tax: Number.isFinite(g.taxBps) ? g.taxBps : DEFAULT_TAX_BPS,
      bank: stdb.getServerBank(g._id),
      stats: { games: s.gp || 0, wagered: s.wagered || 0, payout: s.payout || 0, taxed: s.taxed || 0, big: s.big || 0, players: Array.isArray(s.players) ? s.players.length : 0, lastPlay: s.lastPlay || 0 },
      shop: { featuredUntil: shop.featuredUntil || 0, taxHolidayUntil: shop.taxHolidayUntil || 0, accent: HEX_RE.test(shop.accent || "") ? shop.accent : null,
              featured: (shop.featuredUntil || 0) > now, taxHoliday: (shop.taxHolidayUntil || 0) > now },
    };
  });
  return { servers, voted, ...base };
});

// Admin: set/adjust a server bank directly (needs the "servers" permission).
app.post("/api/server/bank", async ({ request, body, set }) => {
  const uid = await resolveSession(request); if (!uid) { set.status = 401; return { error: "Not logged in" }; }
  if (!(await canManageServers(uid))) { set.status = 403; return { error: "Forbidden" }; }
  const b = body as any;
  const gid = String(b?.gid || "");
  const g = await db.getGuild(gid).catch(() => null);
  if (!g) { set.status = 404; return { error: "Unknown server" }; }
  const current = stdb.getServerBank(gid);
  let target: number;
  if (typeof b.set === "number" && Number.isFinite(b.set)) target = Math.max(0, Math.floor(b.set));
  else if (typeof b.delta === "number" && Number.isFinite(b.delta)) target = Math.max(0, current + Math.floor(b.delta));
  else { set.status = 400; return { error: "Provide set or delta" }; }
  const diff = target - current;
  if (diff === 0) return { ok: true, bank: target };
  if (Math.abs(diff) > 1_000_000_000) { set.status = 400; return { error: "Adjustment too large — max 1,000,000,000 at once" }; }
  // Use the already-deployed Phase-2 reducers so bank editing needs no republish:
  //  • add: credit_win to the admin with gross=tax=diff → admin nets 0, bank += diff
  //  • remove: bank_spend
  try {
    if (diff > 0) await stdb.creditWin(uid, diff, gid, diff);
    else await stdb.bankSpend(gid, -diff);
  } catch (e: any) {
    const m = e?.message || String(e); console.error("[bank/set]", gid, "→", m);
    set.status = 400; return { error: `Failed to set bank: ${m}` };
  }
  console.log(`[audit] bank-edit by ${uid} on ${gid}: ${current} → ${target} (Δ${diff})`); // trail for manual adjustments
  return { ok: true, bank: target };
});

// ── server Shop: buy a perk with the server bank (owner only) ─────────────────
app.post("/api/server/shop/buy", async ({ request, body, set }) => {
  const uid = await resolveSession(request); if (!uid) { set.status = 401; return { error: "Not logged in" }; }
  const b = body as any;
  const gid = String(b?.gid || "");
  const g = await db.getGuild(gid).catch(() => null);
  if (!g) { set.status = 404; return { error: "Unknown server" }; }
  if (g.ownerId !== uid && !(await canManageServers(uid))) { set.status = 403; return { error: "Only the server owner can use the shop" }; }
  if (rl(rlShop, uid + ":" + gid, 4000)) { set.status = 429; return { error: "Slow down — wait a moment between shop actions" }; }
  const item = SHOP_ITEMS.find(i => i.id === String(b?.itemId));
  if (!item) { set.status = 400; return { error: "Unknown item" }; }
  // Build the perk patch before spending so a bad request never charges the bank.
  const econ: any = await (db as any).getGuildEconomy(gid).catch(() => ({ shop: {} }));
  const shop: any = econ?.shop || {};
  const now = Date.now();
  const patch: any = {};
  let charge = item.price;
  if (item.kind === "duration") {
    // Already-active perks can't be re-bought (no spamming the same purchase).
    if ((Number(shop[item.field]) || 0) > now) { set.status = 400; return { error: `${item.label} is already active.` }; }
    patch[item.field] = now + (item as any).durationMs;
  } else if (item.kind === "accent") {
    const color = String(b?.color || "");
    if (!HEX_RE.test(color)) { set.status = 400; return { error: "Provide a hex color like #2ecc71" }; }
    patch.accent = color;
    if (HEX_RE.test(shop.accent || "")) charge = 0; // perk already owned → recolor is free
  }
  // Spend first (authoritative); only apply the perk once the bank is actually charged.
  if (charge > 0) {
    try { await stdb.bankSpend(gid, charge); }
    catch (e: any) { const m = e?.message || ""; set.status = 400; return { error: m === "insufficient" ? "Not enough in the server bank" : m === "no bank" ? "Server bank is empty" : "Purchase failed" }; }
  }
  await (db as any).mergeGuildShop(gid, patch).catch(() => {});
  if (item.id === "tax_holiday") taxCache.delete(gid); // holiday must take effect immediately
  broadcastServerEcon(gid); // live tax/perk update for everyone
  return { ok: true, bank: stdb.getServerBank(gid),
    shop: { featuredUntil: patch.featuredUntil ?? shop.featuredUntil ?? 0, taxHolidayUntil: patch.taxHolidayUntil ?? shop.taxHolidayUntil ?? 0,
            accent: HEX_RE.test(patch.accent ?? shop.accent ?? "") ? (patch.accent ?? shop.accent) : null,
            featured: (patch.featuredUntil ?? shop.featuredUntil ?? 0) > now, taxHoliday: (patch.taxHolidayUntil ?? shop.taxHolidayUntil ?? 0) > now } };
});

// Cancel an active duration perk early and refund 50% of its price to the server bank.
app.post("/api/server/shop/remove", async ({ request, body, set }) => {
  const uid = await resolveSession(request); if (!uid) { set.status = 401; return { error: "Not logged in" }; }
  const b = body as any;
  const gid = String(b?.gid || "");
  const g = await db.getGuild(gid).catch(() => null);
  if (!g) { set.status = 404; return { error: "Unknown server" }; }
  if (g.ownerId !== uid && !(await canManageServers(uid))) { set.status = 403; return { error: "Only the server owner can use the shop" }; }
  if (rl(rlShop, uid + ":" + gid, 4000)) { set.status = 429; return { error: "Slow down — wait a moment between shop actions" }; }
  const item = SHOP_ITEMS.find(i => i.id === String(b?.itemId));
  if (!item || item.kind !== "duration") { set.status = 400; return { error: "That perk can't be removed" }; }
  const econ: any = await (db as any).getGuildEconomy(gid).catch(() => ({ shop: {} }));
  const shop: any = econ?.shop || {};
  const now = Date.now();
  if (!((Number(shop[item.field]) || 0) > now)) { set.status = 400; return { error: `${item.label} isn't active` }; }
  const refund = Math.floor(item.price * 0.5);
  await (db as any).mergeGuildShop(gid, { [item.field]: 0 }).catch(() => {}); // cancel it
  if (item.id === "tax_holiday") taxCache.delete(gid);
  try { if (refund > 0) await stdb.creditWin(uid, refund, gid, refund); } // 50% back into the bank
  catch (e: any) { console.error("[shop/remove refund]", e?.message); }
  broadcastServerEcon(gid);
  return { ok: true, refund, bank: stdb.getServerBank(gid),
    shop: { featuredUntil: item.id === "featured" ? 0 : (shop.featuredUntil || 0), taxHolidayUntil: item.id === "tax_holiday" ? 0 : (shop.taxHolidayUntil || 0),
            accent: HEX_RE.test(shop.accent || "") ? shop.accent : null,
            featured: item.id !== "featured" && (shop.featuredUntil || 0) > now, taxHoliday: item.id !== "tax_holiday" && (shop.taxHolidayUntil || 0) > now } };
});

// Owner/manager: set the server's fluxer.gg join invite (shown on the leaderboard).
app.post("/api/server/invite", async ({ request, body, set }) => {
  const uid = await resolveSession(request); if (!uid) { set.status = 401; return { error: "Not logged in" }; }
  const b = body as any;
  const gid = String(b?.gid || "");
  const g = await db.getGuild(gid).catch(() => null);
  if (!g) { set.status = 404; return { error: "Unknown server" }; }
  if (g.ownerId !== uid && !(await canManageServers(uid))) { set.status = 403; return { error: "Only the server owner can set the invite" }; }
  const invite = normalizeFluxerInvite(b?.invite);
  if (invite === null) { set.status = 400; return { error: "Invite must be a https://fluxer.gg/ link" }; }
  await (db as any).setGuildInvite(gid, invite).catch(() => {});
  return { ok: true, invite: invite || null };
});

// ── global server leaderboard (any logged-in user) ───────────────────────────
app.get("/api/leaderboard", async ({ request, query, set }) => {
  const uid = await resolveSession(request); if (!uid) { set.status = 401; return { error: "Not logged in" }; }
  const sort = String((query as any)?.sort || "wagered");
  const byBank = sort === "bank";
  // Mongo can sort by stat fields; for bank we pull a wider pool and sort in-process.
  const rows: any[] = await (db as any).getTopServerStats(byBank ? "wagered" : sort, byBank ? 100 : 50).catch(() => []);
  const guilds = await db.getGuildsByIds(rows.map(r => r._id)).catch(() => []);
  const gmap = new Map(guilds.map((g: any) => [g._id, g]));
  const me = await db.getUser(uid).catch(() => null);
  const myGids = new Set(Array.isArray(me?.gids) ? me.gids : []);
  const now = Date.now();
  let entries = rows.map(r => {
    const g: any = gmap.get(r._id) || {}; const shop: any = g.shop || {};
    const taxBps = Number.isFinite(g.taxBps) ? g.taxBps : DEFAULT_TAX_BPS;
    const holiday = (shop.taxHolidayUntil || 0) > now;
    return { id: r._id, name: g.name || "Server", members: g.memberCount ?? null,
      bank: stdb.getServerBank(r._id), wagered: r.wagered || 0, taxed: r.taxed || 0, games: r.gp || 0, payout: r.payout || 0,
      players: Array.isArray(r.players) ? r.players.length : 0,
      tax: holiday ? 0 : taxBps, taxHoliday: holiday, member: myGids.has(r._id),
      invite: typeof g.invite === "string" ? g.invite : null,
      featured: (shop.featuredUntil || 0) > now, accent: HEX_RE.test(shop.accent || "") ? shop.accent : null };
  });
  const metric = byBank ? "bank" : (sort === "taxed" ? "taxed" : sort === "games" ? "games" : "wagered");
  // Featured servers float to the top; then by the chosen metric.
  entries.sort((a: any, b: any) => (Number(b.featured) - Number(a.featured)) || (b[metric] - a[metric]));
  entries = entries.slice(0, 50);
  return { servers: entries, sort: metric };
});

// ── user search (send-money picker) ─────────────────────────────────────────
app.get("/api/users/search", async ({ request, query, set }) => {
  const uid = await resolveSession(request); if (!uid) { set.status = 401; return { error: "Not logged in" }; }
  let rows: any[] = [];
  try { rows = await db.searchUsers((query as any).q || "", 25, uid); } catch (e) { console.error("[users/search]", e); }
  return { users: rows.map((r: any) => ({ id: r._id, tag: r.tag || null, avatar: r.av || fluxerAvatarUrl(r._id, null) })) };
});

// ── Bun server tuning for a cheap VPS (high concurrency, low memory) ──────────
app.listen({ port: PORT, reusePort: true, hostname: "0.0.0.0" });
console.log(`[web] Elysia on :${PORT} · STDB ${ST.module} · realtime WS at /ws`);

export type App = typeof app;
