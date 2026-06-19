// One-time MongoDB → SpacetimeDB migration.
//
// Reads every Mongo collection and pushes the rows into STDB through the web service's
// loopback /internal/migrate endpoint (which calls the import_* reducers). Balances are
// NOT migrated — the STDB ledger already owns them (Mongo's `bal` was a stale starter).
//
// RUN ONCE, ON THE VPS, AFTER deploying the new module + web:
//   cd spacetimedb && spacetime publish -s local sirgreen-6ls47
//   spacetime generate --lang typescript --module-path . --out-dir ../web/src/module_bindings
//   pm2 restart sirgreen-web         # new reducers + /internal/migrate now live
//   node scripts/migrate-to-stdb.mjs # then this
//
// Idempotent: the import_* reducers upsert, so re-running overwrites (no duplicates).

import { readFileSync } from "fs";
import { MongoClient } from "mongodb";

const cfg = JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8"));
const MONGO_URI = cfg.mongodb?.uri;
const DB_NAME = cfg.mongodb?.database || dbNameFromUri(MONGO_URI);
const SECRET = cfg.web?.internalSecret;
const WEB = "http://127.0.0.1:" + (cfg.web?.port ?? cfg.webPort ?? 80);

if (!MONGO_URI) { console.error("FATAL: config.mongodb.uri missing"); process.exit(1); }
if (!SECRET) { console.error("FATAL: config.web.internalSecret missing"); process.exit(1); }

function dbNameFromUri(uri, fb = "casino") {
  try { const u = new URL(String(uri).replace(/^mongodb(\+srv)?:\/\//, "https://")); return u.pathname.replace(/^\//, "").split("?")[0] || fb; } catch { return fb; }
}
const SESSION_TOKEN_RE = /^[a-f0-9]{24,128}$/i;
const now = Date.now();

// POST a batch of rows for one logical table to the web migration sink (chunked).
async function push(table, rows) {
  let imported = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const r = await fetch(WEB + "/internal/migrate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal": SECRET },
      body: JSON.stringify({ table, rows: chunk }),
    }).then(x => x.json()).catch(e => ({ ok: false, error: String(e?.message || e) }));
    if (!r.ok) { console.error(`  ! ${table} chunk @${i} failed:`, r.error); }
    imported += Number(r.imported || 0);
  }
  console.log(`  → ${table}: ${imported}/${rows.length} imported`);
  return imported;
}

async function main() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  console.log(`[migrate] Mongo ${DB_NAME} → STDB via ${WEB}/internal/migrate\n`);

  // ── users (u) → profiles + sessions + pending-slot kv ──────────────────────
  const users = await db.collection("u").find({}).toArray();
  const profiles = [], sessions = [], kv = [];
  for (const d of users) {
    const id = String(d._id);
    if (!/^\d{17,20}$/.test(id)) continue;
    profiles.push({
      owner: id, tag: d.tag || "", av: d.av || "", tw: d.tw || 0, tl: d.tl || 0, gp: d.gp || 0,
      ld: d.ld || 0, lw: d.lw || 0, bwdDay: d.bwd?.d || "", bwdTotal: d.bwd?.t || 0,
      perms: JSON.stringify(Array.isArray(d.perms) ? d.perms : []),
      gids: JSON.stringify(Array.isArray(d.gids) ? d.gids : []),
      pet: d.pet ? JSON.stringify(d.pet) : "",
    });
    for (const [tok, exp] of Object.entries(d.st || {})) {
      if (SESSION_TOKEN_RE.test(tok) && Number(exp) > now) sessions.push({ owner: id, token: tok, expiryMs: Number(exp) });
    }
    if (d.psl) kv.push({ key: "psl:" + id, val: JSON.stringify(d.psl) });
  }
  console.log(`Users: ${users.length}`);
  await push("profiles", profiles);
  await push("sessions", sessions);

  // ── guilds ─────────────────────────────────────────────────────────────────
  const guilds = (await db.collection("guilds").find({}).toArray()).map(g => ({
    gid: String(g._id), ownerId: g.ownerId || "", name: g.name || "", icon: g.icon || "",
    memberCount: g.memberCount || 0, invite: g.invite || "", taxBps: Number.isFinite(g.taxBps) ? g.taxBps : 1500,
    rakebackPct: Number.isFinite(g.rakebackPct) ? g.rakebackPct : 5, verified: !!g.verified,
    shop: JSON.stringify(g.shop || {}), roleShop: JSON.stringify(Array.isArray(g.roleShop) ? g.roleShop : []),
    lastSeen: g.lastSeen || now, joinedAt: g.joinedAt || now,
  }));
  console.log(`Guilds: ${guilds.length}`);
  await push("guilds", guilds);

  // ── serverstats (drop unbounded players[] → playerCount) ────────────────────
  const sstats = (await db.collection("serverstats").find({}).toArray()).map(s => ({
    gid: String(s._id), gp: s.gp || 0, wagered: s.wagered || 0, payout: s.payout || 0, taxed: s.taxed || 0,
    big: s.big || 0, playerCount: Array.isArray(s.players) ? s.players.length : (s.playerCount || 0), lastPlay: s.lastPlay || 0,
  }));
  console.log(`ServerStats: ${sstats.length}`);
  await push("serverstats", sstats);

  // ── holdings (relational expansion of the h sub-doc) ────────────────────────
  const holdingDocs = await db.collection("holdings").find({}).toArray();
  const holdings = [];
  for (const d of holdingDocs) {
    const owner = String(d._id);
    for (const [assetId, pos] of Object.entries(d.h || {})) {
      if (pos && Number(pos.u) > 0) holdings.push({ owner, assetId, units: Number(pos.u), cost: Math.round(Number(pos.c) || 0) });
    }
  }
  console.log(`Holdings: ${holdings.length} positions`);
  await push("holdings", holdings);

  // ── investing assets ────────────────────────────────────────────────────────
  const assets = (await db.collection("assets").find({}).toArray()).map(a => ({
    _id: String(a._id), kind: a.kind || "nft", name: a.name || "", emoji: a.emoji || "", color: a.color || "",
    price: Number(a.price) || 0, baseline: Number(a.baseline) || 0, vol: Number(a.vol) || 0, supply: Number(a.supply) || 0,
    prevPrice: Number(a.prevPrice ?? a.price) || 0, bias: Number(a.bias) || 0, hist: JSON.stringify(a.hist || []), updatedAt: a.updatedAt || now,
  }));
  console.log(`Assets: ${assets.length}`);
  await push("assets", assets);

  // ── tickets ──────────────────────────────────────────────────────────────────
  const tickets = (await db.collection("tickets").find({}).toArray()).map(t => ({
    id: String(t._id), uid: String(t.uid), tag: t.tag || "", subject: t.subject || "", status: t.status || "open",
    messages: JSON.stringify(Array.isArray(t.messages) ? t.messages : []), createdAt: t.createdAt || now, updatedAt: t.updatedAt || now,
  })).filter(t => /^\d{17,20}$/.test(t.uid));
  console.log(`Tickets: ${tickets.length}`);
  await push("tickets", tickets);

  // ── rakeback ledger ──────────────────────────────────────────────────────────
  const rakeback = (await db.collection("rakeback").find({}).toArray()).map(r => {
    const [uid, gid] = String(r._id).split("@");
    return { uid: r.uid || uid, gid: r.gid || gid, accrued: r.accrued || 0, wagered: r.wagered || 0, claimed: r.claimed || 0 };
  }).filter(r => /^\d{17,20}$/.test(String(r.uid)) && r.gid);
  console.log(`Rakeback: ${rakeback.length}`);
  await push("rakeback", rakeback);

  // ── login tokens (skip expired) ───────────────────────────────────────────────
  const tokens = (await db.collection("logintokens").find({}).toArray()).map(t => ({
    token: String(t._id), uid: String(t.uid), gid: t.gid ? String(t.gid) : "", expAt: t.expAt ? new Date(t.expAt).getTime() : 0,
  })).filter(t => t.expAt > now);
  console.log(`LoginTokens: ${tokens.length} (unexpired)`);
  await push("logintokens", tokens);

  // ── command stats (cmd:* → counters, daily:* → daily totals) ───────────────────
  const statDocs = await db.collection("stats").find({}).toArray();
  const counters = [], dailies = [];
  for (const s of statDocs) {
    const id = String(s._id);
    if (id.startsWith("cmd:")) counters.push({ key: id.slice(4), count: Number(s.count) || 0 });
    else if (id.startsWith("daily:")) dailies.push({ date: id.slice(6), total: Number(s.total) || 0 });
  }
  console.log(`Stats: ${counters.length} commands, ${dailies.length} days`);
  await push("statcounters", counters);
  await push("dailystats", dailies);

  // ── custom case tiers (cb_tiers singleton → kv) ────────────────────────────────
  const tiersDoc = await db.collection("cb_tiers").findOne({ _id: "custom_tiers" }).catch(() => null);
  if (tiersDoc && Array.isArray(tiersDoc.tiers)) kv.push({ key: "custom_tiers", val: JSON.stringify(tiersDoc.tiers) });
  console.log(`KV singletons: ${kv.length}`);
  await push("kv", kv);

  await client.close();
  console.log("\n[migrate] done. Verify the site, then you can drop the Mongo database.");
  process.exit(0);
}

main().catch(e => { console.error("[migrate] FATAL:", e); process.exit(1); });
