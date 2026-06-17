import http   from "http";
import { URL } from "url";
import crypto  from "crypto";
import https   from "https";
import zlib    from "zlib";
import fs      from "fs";
import path    from "path";
import { fileURLToPath } from "url";
import { AdminPanel }    from "./AdminPanel.mjs";
import * as Slots        from "./SlotEngine.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const GAMES_ASSETS_DIR = path.resolve(__dirname, "../games/assets");
const GAMES_HTML_DIR   = path.resolve(__dirname, "../games");
const FAVICON_PATH     = path.resolve(GAMES_ASSETS_DIR, "favicon.ico");
// Cache-bust assets per server start: assets are sent with a 24h max-age, so a
// stable build tag (changes every restart/deploy) forces browsers to refetch
// updated CSS/JS while still allowing long caching within a single run.
const ASSET_VER = Date.now().toString(36);

const FLUXER_AUTH_URL  = "https://web.canary.fluxer.app/oauth2/authorize";
const FLUXER_TOKEN_URL = "https://api.fluxer.app/v1/oauth2/token";
const FLUXER_ME_URL    = "https://api.fluxer.app/v1/users/@me";

// Fluxer CDN (matches @fluxerjs/core cdn util).
const FLUXER_CDN        = "https://fluxerusercontent.com";
const FLUXER_STATIC_CDN = "https://fluxerstatic.com";

/** Build a usable avatar URL for a Fluxer user. Animated hashes (a_) → gif.
 *  Falls back to the default static avatar when the user has no custom one. */
function fluxerAvatarUrl(userId, avatarHash, size = 64) {
  if (!avatarHash) {
    let idx = 0;
    try { idx = Number(BigInt(userId) % 6n); } catch { idx = 0; }
    return `${FLUXER_STATIC_CDN}/avatars/${idx}.png`;
  }
  const ext = String(avatarHash).startsWith("a_") ? "gif" : "png";
  return `${FLUXER_CDN}/avatars/${userId}/${avatarHash}.${ext}?size=${size}`;
}

const MIME = {
  ".html":"text/html; charset=utf-8",".js":"application/javascript; charset=utf-8",
  ".mjs":"application/javascript; charset=utf-8",".css":"text/css; charset=utf-8",
  ".json":"application/json; charset=utf-8",".png":"image/png",".jpg":"image/jpeg",
  ".jpeg":"image/jpeg",".gif":"image/gif",".webp":"image/webp",".svg":"image/svg+xml",
  ".ico":"image/x-icon",".mp3":"audio/mpeg",".ogg":"audio/ogg",".wav":"audio/wav",
  ".mp4":"video/mp4",".webm":"video/webm",".woff":"font/woff",".woff2":"font/woff2",
  ".ttf":"font/ttf",".txt":"text/plain; charset=utf-8",
};
function getMime(fp) { return MIME[path.extname(fp).toLowerCase()] ?? "application/octet-stream"; }

const _assetCache = new Map();

function normalizeAssetUrlPath(p) {
  const clean = String(p||"").split("?")[0].split("#")[0].replace(/\\/g,"/");
  const norm  = path.posix.normalize(clean);
  return norm.startsWith("/") ? norm : `/${norm}`;
}
function assetUrlToDiskPath(urlPath) {
  const n = normalizeAssetUrlPath(urlPath);
  if (!n.startsWith("/assets/")) return null;
  const rel = n.slice("/assets/".length);
  if (rel.includes("\0")||rel.startsWith("/")||rel.includes("../")||rel==="..") return null;
  const disk = path.resolve(GAMES_ASSETS_DIR, rel);
  const chk  = path.relative(GAMES_ASSETS_DIR, disk).replace(/\\/g, "/");
  if (chk.startsWith("..")||path.isAbsolute(chk)) return null;
  return disk;
}
function _preloadAssets() {
  _assetCache.clear();
  if (!fs.existsSync(GAMES_ASSETS_DIR)) { console.warn(`[Web] Assets dir missing: ${GAMES_ASSETS_DIR}`); return; }
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.isFile()) continue;
      try {
        const buf = fs.readFileSync(full);
        const rel = path.relative(GAMES_ASSETS_DIR, full).replace(/\\/g, "/");
        _assetCache.set(normalizeAssetUrlPath(`/assets/${rel}`), { buf, mime: getMime(full) });
      } catch(e) { console.error("[Web] Asset preload:", e); }
    }
  };
  walk(GAMES_ASSETS_DIR);
  console.log(`[Web] Preloaded ${_assetCache.size} game asset(s).`);
}

function rawFetch(url, opts = {}, maxRedirects = 4) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const mod     = parsed.protocol === "https:" ? https : http;
    const bodyBuf = opts.body ? Buffer.from(opts.body) : Buffer.alloc(0);
    const headers = {
      "User-Agent": "Mozilla/5.0 (compatible; SirGreenCasino/3.0)",
      Accept: "*/*",
      "Accept-Encoding": "gzip, deflate, br",
      ...(opts.headers ?? {}),
      "Content-Length": bodyBuf.length,
    };
    const r = mod.request({
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   opts.method ?? "GET",
      headers,
    }, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location && maxRedirects > 0)
        return resolve(rawFetch(new URL(res.headers.location, url).toString(), opts, maxRedirects - 1));
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const raw  = Buffer.concat(chunks);
        const enc  = (res.headers["content-encoding"] ?? "").toLowerCase();
        const decomp = enc === "br" ? zlib.brotliDecompressSync(raw)
                     : enc === "gzip" ? zlib.gunzipSync(raw)
                     : enc === "deflate" ? zlib.inflateSync(raw)
                     : raw;
        resolve({ statusCode: res.statusCode, headers: res.headers, body: decomp });
      });
    });
    r.on("error", reject);
    if (bodyBuf.length) r.write(bodyBuf);
    r.end();
  });
}
async function nodeFetch(url, opts = {}) {
  return (await rawFetch(url, opts)).body.toString("utf8");
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
function esc(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function serveBufferWithRanges(req, res, buf, mime, cc = "public, max-age=86400") {
  const total = buf.length, rh = req.headers.range;
  if (rh) {
    const m = /bytes=(\d*)-(\d*)/.exec(rh);
    const start = m && m[1] ? parseInt(m[1], 10) : 0;
    const end   = m && m[2] ? parseInt(m[2], 10) : total - 1;
    const safe  = Math.min(end, total - 1);
    if (start >= total || start > safe) { res.writeHead(416, { "Content-Range": `bytes */${total}` }); return res.end(); }
    res.writeHead(206, { "Content-Range": `bytes ${start}-${safe}/${total}`, "Accept-Length": safe - start + 1, "Content-Type": mime, "Cache-Control": cc });
    return res.end(buf.slice(start, safe + 1));
  }
  res.writeHead(200, { "Content-Type": mime, "Content-Length": total, "Accept-Ranges": "bytes", "Cache-Control": cc });
  res.end(buf);
}
function serveFileWithRanges(req, res, fp, mime = getMime(fp), cc = "public, max-age=86400") {
  fs.stat(fp, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404, { "Cache-Control": "no-store" }); return res.end("Not found"); }
    const total = stat.size, rh = req.headers.range;
    if (!rh) { res.writeHead(200, { "Content-Type": mime, "Content-Length": total, "Accept-Ranges": "bytes", "Cache-Control": cc }); return fs.createReadStream(fp).pipe(res); }
    const m     = /bytes=(\d*)-(\d*)/.exec(rh);
    const start = m && m[1] ? parseInt(m[1], 10) : 0;
    const end   = m && m[2] ? parseInt(m[2], 10) : total - 1;
    const safe  = Math.min(end, total - 1);
    if (start >= total || start > safe) { res.writeHead(416, { "Content-Range": `bytes */${total}` }); return res.end(); }
    res.writeHead(206, { "Content-Range": `bytes ${start}-${safe}/${total}`, "Accept-Ranges": "bytes", "Content-Length": safe - start + 1, "Content-Type": mime, "Cache-Control": cc });
    fs.createReadStream(fp, { start, end: safe }).pipe(res);
  });
}

// ─── HTML templates ───────────────────────────────────────────────────────────
// All page CSS/HTML lives in games/ (static files under /assets/css + partials).
// Pages are served by renderPage() with __TOKEN__ replacement. Only the tiny
// error page is generated inline.

const ADMIN_ID = "1512241609448620032";

/** Minimal standalone error page (links shared app.css). */
function errPage(title, msg, href, label) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SirGreen Casino</title><link rel="stylesheet" href="/assets/css/app.css"><style>.errw{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.5rem;background:radial-gradient(ellipse at 50% 0%,#0a1f0a 0%,var(--bg) 60%)}.errc{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-md);padding:2rem;max-width:400px;width:100%;text-align:center}.errc h1{color:var(--accent);font-size:1.2rem;font-weight:800;margin-bottom:.6rem}.errc p{color:var(--text2);margin-bottom:1rem;line-height:1.5;font-size:.85rem}</style></head><body><div class="errw"><div class="errc"><h1>${esc(title)}</h1><p>${esc(msg)}</p><a class="btn btn-primary" href="${esc(href ?? "/login")}">${esc(label ?? "Back")}</a></div></div></body></html>`;
}

// Cache the sidebar partial once (re-read if missing).
let _sidebarTpl = null;
function loadSidebar() {
  if (_sidebarTpl != null) return _sidebarTpl;
  try { _sidebarTpl = fs.readFileSync(path.join(GAMES_HTML_DIR, "partials", "sidebar.html"), "utf8"); }
  catch { _sidebarTpl = ""; }
  return _sidebarTpl;
}

/**
 * Build the sidebar markup for a page: marks the active item, gates the admin
 * item to ADMIN_ID, fills user/balance/avatar tokens.
 */
function buildSidebar({ active, uid, tag, avatar, bal, showAdmin }) {
  let s = loadSidebar();
  const pages = ["lobby", "case-battle", "slots", "misc"];
  for (const p of pages) s = s.replace(`__ACTIVE_${p}__`, p === active ? "active" : "");
  const adminNav = showAdmin
    ? `<a href="/admin/panel" class="sb-item admin ${active === "admin" ? "active" : ""}"><svg class="icon" viewBox="0 0 24 24"><path d="M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z"/><path d="M9 12l2 2 4-4"/></svg><span>Admin</span></a>`
    : "";
  s = s.replace("__ADMIN_NAV__", adminNav);
  s = s.replace(/__TAG__/g, esc(tag ?? "Player"));
  s = s.replace(/__AVATAR__/g, esc(avatar ?? ""));
  s = s.replace(/__BALANCE__/g, Number(bal ?? 0).toLocaleString());
  return s;
}

// ─── WebServer class ──────────────────────────────────────────────────────────

export class WebServer {
  constructor(db, config) {
    this.db           = db;
    this.config       = config;
    this.port         = config.webPort ?? 80;
    this.clientId     = config.fluxerClientId ?? config.discordClientId ?? "";
    this.clientSecret = config.fluxerClientSecret ?? config.discordClientSecret ?? "";
    this.baseUrl      = config.webBaseUrl ?? "https://www.sirgreen.online";
    this.redirectUri  = `${this.baseUrl}/oauth/callback`;
    // Optional: bind sessions to the IP address they were created from.
    // Reduces token-theft window but may log out users behind aggressive NAT/CGNAT.
    this._sessionIpBinding  = Boolean(config.sessionIpBinding);
    this._sessionIpTolerance = Number(config.sessionIpToleranceMs ?? 0); // grace period for flaky IPs
    this._states      = new Map();
    this._admin       = new AdminPanel(db, config.prefix ?? "&");

    // ── Case Battle state ─────────────────────────────────────────────────────
    // battleId -> battle state
    this._cbActive  = new Map();
    // uid -> battleId  (prevents joining twice)
    this._cbUserBattle = new Map();
    // uid -> tag (fetched lazily, cached)
    this._cbTagCache = new Map();
    // Prune stale battles every 90 s
    setInterval(() => {
      const cut = Date.now() - 90 * 1000;
      for (const [id, b] of this._cbActive) {
        if (b.phase === "done" && b.resolvedAt < cut) this._cbActive.delete(id);
        else if (b.phase === "pending" && b.createdAt < cut) this._cbActive.delete(id);
      }
    }, 90_000);
  }

  // ─── Case Battle helpers ─────────────────────────────────────────────────

  /** Case tier definitions — built-in tiers. Custom tiers can be added via
   *  the admin panel and are loaded from MongoDB on connect (see loadCustomTiers). */
  static CB_BUILTIN_TIERS = [
    {
      id: "bronze", label: "Bronze", entry: 100,
      color: "#CD7F32", bg: "#1a0e06", builtIn: true,
      items: [
        { s: "🪙", n: "Copper Coin",   v: 15,  w: 35 },
        { s: "🪙", n: "Silver Coin",   v: 30,  w: 25 },
        { s: "🔵", n: "Steel Ball",    v: 50,  w: 20 },
        { s: "🟡", n: "Gold Flake",    v: 75,  w: 12 },
        { s: "💎", n: "Ruby Shard",    v: 120, w: 5  },
        { s: "👑", n: "Bronze Crown",  v: 200, w: 2  },
        { s: "🔮", n: "Mystery Box",   v: 350, w: 1  },
      ],
    },
    {
      id: "iron", label: "Iron", entry: 250,
      color: "#A8A8B0", bg: "#0e0e1a", builtIn: true,
      items: [
        { s: "⚙️", n: "Iron Gear",    v: 40,  w: 32 },
        { s: "🪨", n: "Iron Ore",     v: 80,  w: 25 },
        { s: "🔩", n: "Steel Bolt",   v: 130, w: 18 },
        { s: "🛠️", n: "Tool Kit",     v: 200, w: 12 },
        { s: "⚔️", n: "Iron Sword",   v: 300, w: 8  },
        { s: "🛡️", n: "Iron Shield",  v: 500, w: 3  },
        { s: "👑", n: "Iron Helm",    v: 800, w: 2  },
      ],
    },
    {
      id: "silver", label: "Silver", entry: 500,
      color: "#C0C0C0", bg: "#0e0e1a", builtIn: true,
      items: [
        { s: "🥈", n: "Silver Bar",    v: 75,   w: 30 },
        { s: "🪙", n: "Gold Coin",      v: 150,  w: 25 },
        { s: "🔵", n: "Sapphire",       v: 250,  w: 18 },
        { s: "🟡", n: "Gold Nugget",   v: 400,  w: 12 },
        { s: "💎", n: "Diamond Chip",  v: 700,  w: 8  },
        { s: "👑", n: "Silver Crown",  v: 1200, w: 4  },
        { s: "🏆", n: "Grand Trophy",  v: 2000, w: 2  },
        { s: "🔮", n: "Void Crystal",  v: 3500, w: 1  },
      ],
    },
    {
      id: "platinum", label: "Platinum", entry: 1000,
      color: "#E5E4E2", bg: "#0a0a14", builtIn: true,
      items: [
        { s: "⬜", n: "Platinum Bar",   v: 180,  w: 28 },
        { s: "💠", n: "Platinum Chip",  v: 400,  w: 24 },
        { s: "🟣", n: "Amethyst",       v: 700,  w: 18 },
        { s: "🔵", n: "Platinum Ring",  v: 1100, w: 12 },
        { s: "🟡", n: "Gold Chain",     v: 1800, w: 10 },
        { s: "👑", n: "Platinum Crown", v: 3000, w: 5  },
        { s: "🔮", n: "Ethereal Pearl", v: 5500, w: 2  },
        { s: "✨", n: "Mythic Token",   v: 9000, w: 1  },
      ],
    },
    {
      id: "emerald", label: "Emerald", entry: 1500,
      color: "#50C878", bg: "#02180a", builtIn: true,
      items: [
        { s: "🟢", n: "Emerald Chip",  v: 250,  w: 28 },
        { s: "💚", n: "Heart Emerald", v: 500,  w: 22 },
        { s: "🟩", n: "Emerald Bar",   v: 900,  w: 18 },
        { s: "🟢", n: "Emerald Ring",  v: 1500, w: 12 },
        { s: "🌿", n: "Forest Crown",  v: 2500, w: 10 },
        { s: "🏺", n: "Ancient Vase",  v: 4500, w: 6  },
        { s: "🦚", n: "Phoenix Feather",v:8000, w: 3  },
        { s: "🌳", n: "World Tree Sap",v: 15000,w: 1  },
      ],
    },
    {
      id: "gold", label: "Gold", entry: 2500,
      color: "#FFD700", bg: "#1a1400", builtIn: true,
      items: [
        { s: "🥇", n: "Gold Coin",        v: 400,   w: 28 },
        { s: "💎", n: "Emerald",          v: 800,   w: 22 },
        { s: "🟡", n: "Gold Bar",         v: 1500,  w: 18 },
        { s: "🔵", n: "Sapphire Large",   v: 2500,  w: 12 },
        { s: "👑", n: "Gold Crown",       v: 4000,  w: 10 },
        { s: "🏆", n: "Champion Trophy",  v: 7000,  w: 5  },
        { s: "🔮", n: "Astral Orb",        v: 12000, w: 3  },
        { s: "🌟", n: "Celestial Crown",   v: 22000, w: 2  },
      ],
    },
    {
      id: "ruby", label: "Ruby", entry: 5000,
      color: "#E0115F", bg: "#1a0010", builtIn: true,
      items: [
        { s: "❤️", n: "Ruby Heart",      v: 700,   w: 26 },
        { s: "🔴", n: "Ruby Bar",        v: 1500,  w: 22 },
        { s: "💖", n: "Love Gem",        v: 2800,  w: 18 },
        { s: "🌹", n: "Eternal Rose",    v: 4500,  w: 12 },
        { s: "👑", n: "Ruby Crown",      v: 7500,  w: 10 },
        { s: "💝", n: "Royal Heart",     v: 13000, w: 6  },
        { s: "🌺", n: "Crimson Bloom",   v: 22000, w: 4  },
        { s: "❤️‍🔥", n: "Heart of Fire", v: 40000, w: 2  },
      ],
    },
    {
      id: "diamond", label: "Diamond", entry: 10000,
      color: "#00D4FF", bg: "#00081a", builtIn: true,
      items: [
        { s: "💎", n: "Diamond",         v: 2000,  w: 28 },
        { s: "🌟", n: "Star Shard",        v: 5000,  w: 22 },
        { s: "👑", n: "Royal Crown",      v: 10000, w: 18 },
        { s: "🏆", n: "Legend Trophy",   v: 18000, w: 12 },
        { s: "🔮", n: "Void Gem",         v: 30000, w: 8  },
        { s: "⚡", n: "Thunder Orb",      v: 50000, w: 5  },
        { s: "🌌", n: "Galaxy Core",      v: 90000, w: 4  },
        { s: "💠", n: "Infinity Crown",   v: 180000,w: 3  },
      ],
    },
    {
      id: "obsidian", label: "Obsidian", entry: 25000,
      color: "#1B1B3A", bg: "#000005", builtIn: true,
      items: [
        { s: "🖤", n: "Obsidian Shard",   v: 4000,  w: 26 },
        { s: "🟣", n: "Void Pearl",       v: 9000,  w: 22 },
        { s: "⚫", n: "Dark Matter",      v: 18000, w: 18 },
        { s: "🌑", n: "Eclipse Stone",    v: 30000, w: 12 },
        { s: "👁️", n: "All-Seeing Eye",  v: 50000, w: 10 },
        { s: "🦇", n: "Shadow Wings",     v: 85000, w: 6  },
        { s: "🌚", n: "Black Hole",       v: 150000,w: 4  },
        { s: "👹", n: "Demon Heart",      v: 280000,w: 2  },
      ],
    },
    {
      id: "mythic", label: "Mythic", entry: 100000,
      color: "#FF6B9D", bg: "#1a0010", builtIn: true,
      items: [
        { s: "🌸", n: "Sakura Bloom",     v: 20000, w: 24 },
        { s: "🎴", n: "Legend Card",      v: 45000, w: 22 },
        { s: "🏯", n: "Castle Tower",     v: 80000, w: 18 },
        { s: "🐉", n: "Dragon Scale",     v: 130000,w: 14 },
        { s: "🦄", n: "Unicorn Horn",     v: 220000,w: 10 },
        { s: "👑", n: "Divine Crown",     v: 380000,w: 6  },
        { s: "🌌", n: "Universe Shard",   v: 600000,w: 4  },
        { s: "✨", n: "God Slayer",       v: 1000000,w: 2  },
      ],
    },
  ];

  // Custom tiers loaded from DB (see loadCustomTiers).
  _cbCustomTiers = [];

  async loadCustomTiers() {
    if (!this.db || !this.db._users) return;
    try {
      // Custom tiers stored as a singleton document in a dedicated collection
      this._cbCustomTiers = (await this.db.getCustomTiers?.()) || [];
    } catch (e) { /* collection may not exist yet */ }
  }

  /** Combined tier list (built-in + custom) */
  _cbAllTiers() {
    return [...WebServer.CB_BUILTIN_TIERS, ...this._cbCustomTiers];
  }

  _cbTierById(id) {
    return this._cbAllTiers().find(t => t.id === id) ?? null;
  }

  _cbPickItem(tier) {
    const total = tier.items.reduce((s, i) => s + i.w, 0);
    let r = Math.random() * total;
    for (const item of tier.items) { r -= item.w; if (r <= 0) return item; }
    return tier.items[tier.items.length - 1];
  }

  _cbMakeBot(cost) {
    const names = ["Frosty", "NSGDX", "Viper", "Echo", "Rogue", "Blitz", "Nova", "Karma", "Specter", "Jinx", "Onyx", "Dash"];
    const name = names[Math.floor(Math.random() * names.length)];
    const id = "BOT:" + crypto.randomBytes(4).toString("hex");
    return { uid: id, tag: "BOT " + name, bot: true, avatar: "", cost, rewards: [], totalValue: 0, netWin: 0 };
  }

  _cbOpenCases(cases) {
    // cases: [{tier, cost}]
    return cases.map(c => {
      const tier = this._cbTierById(c.tier);
      if (!tier) return { tier: c.tier, cost: c.cost, reward: null, value: 0 };
      const item = this._cbPickItem(tier);
      return { tier: c.tier, cost: c.cost, reward: item, value: item.v };
    });
  }

  _cbResolve(battle) {
    if (battle.phase === "done") return;
    const { cases } = battle;
    const players = battle.players;
    // Mode precedence: jackpot > crazy > shared > regular.
    const mode = battle.jackpot ? "jackpot" : (battle.crazy ? "crazy" : battle.mode);

    // Each player opens all cases.
    players.forEach(p => {
      const opened = this._cbOpenCases(cases);
      p.rewards = opened.map(o => o.reward);
      p.totalValue = opened.reduce((s, o) => s + (o.value || 0), 0);
      p.cost = cases.reduce((s, c) => s + (c.cost || 0), 0);
    });

    // Credit only real players (bots are house-funded; their balance never moves).
    const credit = (p, amt) => { if (!p.bot && amt) this.db.updateBalance(p.uid, amt).catch(() => {}); };
    const record = (p) => { if (!p.bot) this.db.recordGame(p.uid, p.netWin > 0, p.cost).catch(() => {}); };

    if (mode === "jackpot") {
      // Weighted wheel: P(win) ∝ total opened value. Bigger pull → higher odds.
      const weights = players.map(p => Math.max(1, p.totalValue));
      const total = weights.reduce((s, w) => s + w, 0);
      players.forEach((p, i) => { p.winChance = weights[i] / total; });
      let r = Math.random() * total, widx = 0;
      for (let i = 0; i < players.length; i++) { r -= weights[i]; if (r <= 0) { widx = i; break; } }
      const winner = players[widx];
      battle.winnerUid = winner.uid;
      battle.jackpotWinnerIdx = widx;
      const payout = battle.pot; // jackpot: no rake, winner takes all
      players.forEach(p => {
        p.netWin = (p === winner) ? payout - p.cost : -p.cost;
        if (p === winner) credit(p, payout);
        record(p);
      });
    } else if (mode === "shared") {
      battle.winnerUid = "shared";
      const rake = Math.floor(battle.pot * 0.05);
      const share = Math.floor((battle.pot - rake) / players.length);
      players.forEach(p => { p.netWin = share - p.cost; credit(p, share); record(p); });
    } else {
      // regular = highest total wins; crazy = lowest total wins.
      const vals = players.map(p => p.totalValue);
      const target = mode === "crazy" ? Math.min(...vals) : Math.max(...vals);
      const winners = players.filter(p => p.totalValue === target);
      const rake = Math.floor(battle.pot * 0.05);
      if (winners.length === 1) {
        battle.winnerUid = winners[0].uid;
        const payout = battle.pot - rake;
        players.forEach(p => {
          p.netWin = (p === winners[0]) ? payout - p.cost : -p.cost;
          if (p === winners[0]) credit(p, payout);
          record(p);
        });
      } else {
        battle.winnerUid = "tie";
        const share = Math.floor((battle.pot - rake) / winners.length);
        players.forEach(p => {
          const win = winners.includes(p);
          p.netWin = win ? share - p.cost : -p.cost;
          if (win) credit(p, share);
          record(p);
        });
      }
    }

    battle.phase = "done";
    battle.resolvedAt = Date.now();
    // Auto-cleanup: remove from active battles after 90s
    setTimeout(() => {
      const b = this._cbActive.get(battle.id);
      if (b && b.phase === "done" && Date.now() - b.resolvedAt > 80000) {
        this._cbActive.delete(battle.id);
        for (const p of b.players) {
          if (this._cbUserBattle.get(p.uid) === battle.id) this._cbUserBattle.delete(p.uid);
        }
      }
    }, 90_000);
  }

  _cbStartBattle(battle) {
    const isFast = battle.speed === "fast";
    const countdownMs = isFast ? 1500 : 3000;
    const caseCount = battle.cases.length;
    // Each case: spin (fixed) then a stagger gap before the next starts.
    // Normal is slower for a more satisfying reveal; fast stays snappy.
    const spinMs = isFast ? 800 : 2000;
    // Sequential reveal: next case only starts after the previous one's spin
    // is fully done (stagger >= spin + a short pause).
    const gapMs = isFast ? 130 : 250;
    const staggerMs = spinMs + gapMs;
    battle.jackpotWheelMs = battle.jackpot ? 2800 : 0;

    battle.phase = "countdown";
    battle.startsAt = Date.now() + countdownMs;
    battle.caseStaggerMs = staggerMs;
    battle.caseSpinMs = spinMs;

    // Last case lands at (n-1)*stagger + spin; +550 tail for the reveal pop.
    const openMs = (caseCount > 0 ? (caseCount - 1) * staggerMs + spinMs : 0) + 550;
    const resolveAfter = countdownMs + 50 + openMs;
    setTimeout(() => {
      const b = this._cbActive.get(battle.id);
      if (!b) return;
      b.phase = "opening";
      b.openedAt = Date.now();
      b.caseStaggerMs = staggerMs;
      b.caseSpinMs = spinMs;
      // Resolve rewards — _cbResolve sets phase to "done", then we override back to "opening"
      // so the frontend sees rewards available during the opening animation.
      this._cbResolve(b);
      b.phase = "opening";
      b._resolvedButAnimating = true;
      // Cases finish, then phase=done. Jackpot wheel is a client-side cosmetic
      // that plays after done (winner already chosen server-side).
      const animRemaining = openMs;
      setTimeout(() => {
        const b2 = this._cbActive.get(battle.id);
        if (b2 && b2._resolvedButAnimating) {
          b2.phase = "done";
          b2.resolvedAt = Date.now();
        }
      }, animRemaining);
    }, countdownMs + 50);
  }

  // ─── Admin route helpers ──────────────────────────────────────────────────

  _buildAdminLoginUrl() {
    const state  = crypto.randomBytes(16).toString("hex");
    const expiry = Date.now() + 10 * 60 * 1000; // CSRF state valid for 10 min
    this._states.set(state, { createdAt: Date.now(), expiry });
    return `${FLUXER_AUTH_URL}?client_id=${encodeURIComponent(this.clientId)}&scope=identify+guilds&redirect_uri=${encodeURIComponent(this.redirectUri)}&response_type=code&state=${encodeURIComponent(state)}`;
  }

  async _handleAdminPanel(req, res) {
    const uid = this._uid(req);
    // Not logged in at all — show login page
    if (!uid) {
      const loginUrl = this._buildAdminLoginUrl();
      return this._html(res, 200, this._admin.loginRequired(loginUrl));
    }
    // Logged in but not an admin (no perms)
    if (!(await this._admin.isAdmin(uid))) {
      console.warn(`[Admin] Unauthorised access attempt from uid=${uid}`);
      return this._html(res, 403, this._admin.accessDenied(uid));
    }
    // Authorised — render dashboard scoped to this user's permissions
    try {
      const html = await this._admin.render(uid);
      // No-cache so every reload is fresh
      res.writeHead(200, { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store, no-cache" });
      res.end(html);
    } catch(e) {
      console.error("[Admin] render error:", e);
      this._html(res, 500, errPage("⚠️ Admin Error", e.message ?? "Internal error", "/admin/panel", "Retry"));
    }
  }

  // ─── Server lifecycle ─────────────────────────────────────────────────────

  async start() {
    _preloadAssets();
    // Load custom case tiers from DB
    await this.loadCustomTiers().catch(e => console.error("[CB] Custom tiers load:", e));
    this._server = http.createServer((req, res) =>
      this._handle(req, res).catch(e => {
        console.error("[Web]", e);
        if (!res.headersSent) { res.writeHead(500); res.end("Internal error"); }
      })
    );
    this._server.listen(this.port, "0.0.0.0", () => console.log(`[Web] SirGreen Casino on port ${this.port}`));
    setInterval(() => {
      const now = Date.now();
      for (const [s, entry] of this._states) {
        const cutoff = entry.expiry ?? (Number(entry) + 15 * 60 * 1000);
        if (now > cutoff) this._states.delete(s);
      }
    }, 5 * 60 * 1000);
  }

  // ─── Main request handler ─────────────────────────────────────────────────

  async _handle(req, res) {
    const u = new URL(req.url, "http://localhost");
    const p = normalizeAssetUrlPath(u.pathname);

    if (p === "/") return this._redirect(res, "/lobby");

    if (p === "/favicon.ico") {
      if (fs.existsSync(FAVICON_PATH)) return serveFileWithRanges(req, res, FAVICON_PATH, "image/x-icon");
      res.writeHead(204); return res.end();
    }

    // ── Admin API (gated by per-user permissions) ────────────────────────────
    if (p.startsWith("/api/admin/")) {
      const uid = this._uid(req);
      if (!uid || !(await this._admin.isAdmin(uid))) {
        res.writeHead(403, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        return res.end(JSON.stringify({ error: "Forbidden" }));
      }
      const body = req.method === "POST" || req.method === "PUT" || req.method === "PATCH" || req.method === "DELETE"
        ? await readBody(req).catch(() => "{}") : "{}";
      let data;
      try { data = JSON.parse(body); } catch { data = {}; }
      const deny = () => { res.writeHead(403, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify({ error: "Missing permission" })); };

      // GET /api/admin/users?search= — user list (admin-only fields)
      if (p === "/api/admin/users" && req.method === "GET") {
        if (!(await this._admin.can(uid, "balances")) && !(await this._admin.can(uid, "users"))) return deny();
        const u2 = new URL(req.url, "http://localhost");
        const search = u2.searchParams.get("search") || "";
        const rows = await this.db.searchUsersAdmin(search, 30);
        return this._json(res, 200, { users: rows.map(r => ({
          id: r._id, tag: r.tag || null, avatar: r.av || fluxerAvatarUrl(r._id, null),
          bal: r.bal ?? 0, perms: Array.isArray(r.perms) ? r.perms : [],
        })) });
      }

      // GET /api/admin/admins — users that hold any permission
      if (p === "/api/admin/admins" && req.method === "GET") {
        if (!(await this._admin.can(uid, "balances")) && !(await this._admin.can(uid, "users"))) return deny();
        const rows = await this.db.listAdmins();
        // Always surface the owner first.
        const ownerRow = await this.db.getUser(ADMIN_ID).catch(() => null);
        const list = rows.map(r => ({ id: r._id, tag: r.tag || null, avatar: r.av || fluxerAvatarUrl(r._id, null), bal: r.bal ?? 0, perms: r.perms || [] }));
        if (!list.some(x => x.id === ADMIN_ID)) {
          list.unshift({ id: ADMIN_ID, tag: ownerRow?.tag || "Owner", avatar: ownerRow?.av || fluxerAvatarUrl(ADMIN_ID, null), bal: ownerRow?.bal ?? 0, perms: [] });
        }
        return this._json(res, 200, { users: list });
      }

      // POST /api/admin/users/:id/perms — grant/revoke one permission
      const permMatch = p.match(/^\/api\/admin\/users\/(\d{17,20})\/perms$/);
      if (permMatch && req.method === "POST") {
        if (!(await this._admin.can(uid, "users"))) return deny();
        const targetUid = permMatch[1];
        if (targetUid === ADMIN_ID) return this._json(res, 200, { error: "Owner permissions can't be changed" });
        const perm = String(data.perm ?? "");
        if (!AdminPanel.PERM_IDS.includes(perm)) return this._json(res, 400, { error: "Unknown permission" });
        const cur = await this.db.getPerms(targetUid);
        let next = cur.filter(x => AdminPanel.PERM_IDS.includes(x));
        if (data.grant) { if (!next.includes(perm)) next.push(perm); }
        else next = next.filter(x => x !== perm);
        await this.db.setPerms(targetUid, next);
        return this._json(res, 200, { ok: true, perms: next });
      }

      // POST /api/admin/users/:id/balance — set or adjust a user's balance
      const balMatch = p.match(/^\/api\/admin\/users\/(\d+)\/balance$/);
      if (balMatch && (req.method === "POST" || req.method === "PATCH")) {
        if (!(await this._admin.can(uid, "balances"))) return deny();
        const targetUid = balMatch[1];
        const { delta, set } = data;
        if (typeof set === "number") {
          const user = await this.db.getUser(targetUid);
          const current = Number(user?.bal ?? 0);
          await this.db.updateBalance(targetUid, set - current);
          const updated = await this.db.getUser(targetUid);
          return this._json(res, 200, { bal: Number(updated?.bal ?? 0) });
        } else if (typeof delta === "number") {
          await this.db.updateBalance(targetUid, delta);
          const updated = await this.db.getUser(targetUid);
          return this._json(res, 200, { bal: Number(updated?.bal ?? 0) });
        }
        return this._json(res, 400, { error: "Provide delta or set" });
      }

      // GET /api/admin/cases — list all tiers (built-in + custom)
      if (p === "/api/admin/cases" && req.method === "GET") {
        if (!(await this._admin.can(uid, "cases"))) return deny();
        return this._json(res, 200, { tiers: this._cbAllTiers() });
      }

      // POST /api/admin/cases — add a custom tier
      if (p === "/api/admin/cases" && req.method === "POST") {
        if (!(await this._admin.can(uid, "cases"))) return deny();
        const { id, label, entry, color, bg, items } = data;
        if (!id || !label || !entry || !Array.isArray(items) || items.length === 0)
          return this._json(res, 400, { error: "id, label, entry, items[] required" });
        if (this._cbTierById(id))
          return this._json(res, 400, { error: "Tier ID already exists" });
        const tier = {
          id: String(id), label: String(label), entry: Number(entry),
          color: String(color || "#2ecc71"), bg: String(bg || "#0a1f0a"),
          builtIn: false,
          items: items.map(i => ({ s: String(i.s), n: String(i.n), v: Number(i.v), w: Number(i.w) })),
        };
        this._cbCustomTiers.push(tier);
        await this.db.saveCustomTiers(this._cbCustomTiers).catch(() => {});
        return this._json(res, 200, { tier });
      }

      // PUT /api/admin/cases/:id — overwrite an existing custom tier (built-in not editable)
      const putCaseMatch = p.match(/^\/api\/admin\/cases\/(.+)$/);
      if (putCaseMatch && req.method === "PUT") {
        if (!(await this._admin.can(uid, "cases"))) return deny();
        const cid = decodeURIComponent(putCaseMatch[1]);
        const idx = this._cbCustomTiers.findIndex(t => t.id === cid);
        if (idx < 0) return this._json(res, 404, { error: "Not found (built-in tiers can't be edited)" });
        const { label, entry, color, bg, items } = data;
        if (!label || !entry || !Array.isArray(items) || items.length === 0)
          return this._json(res, 400, { error: "label, entry, items[] required" });
        this._cbCustomTiers[idx] = {
          id: cid, label: String(label), entry: Number(entry),
          color: String(color || "#2ecc71"), bg: String(bg || "#0a1f0a"),
          builtIn: false,
          items: items.map(i => ({ s: String(i.s), n: String(i.n), v: Number(i.v), w: Number(i.w) })),
        };
        await this.db.saveCustomTiers(this._cbCustomTiers).catch(() => {});
        return this._json(res, 200, { tier: this._cbCustomTiers[idx] });
      }

      // DELETE /api/admin/cases/:id — remove a custom tier
      const delCaseMatch = p.match(/^\/api\/admin\/cases\/(.+)$/);
      if (delCaseMatch && req.method === "DELETE") {
        if (!(await this._admin.can(uid, "cases"))) return deny();
        const delId = delCaseMatch[1];
        const idx = this._cbCustomTiers.findIndex(t => t.id === delId);
        if (idx < 0) return this._json(res, 404, { error: "Not found or built-in" });
        this._cbCustomTiers.splice(idx, 1);
        await this.db.saveCustomTiers(this._cbCustomTiers).catch(() => {});
        return this._json(res, 200, { ok: true });
      }

      // GET /api/admin/battles — list active battles
      if (p === "/api/admin/battles" && req.method === "GET") {
        if (!(await this._admin.can(uid, "battles"))) return deny();
        const battles = [...this._cbActive.values()].map(b => ({
          id: b.id, mode: b.mode, phase: b.phase, cost: b.cost, pot: b.pot,
          maxPlayers: b.maxPlayers, speed: b.speed, jackpot: b.jackpot, crazy: b.crazy,
          players: b.players.map(p => ({ uid: p.uid, tag: p.tag })),
          createdAt: b.createdAt, winnerUid: b.winnerUid,
        }));
        return this._json(res, 200, { battles });
      }

      // DELETE /api/admin/battles/:id — force-cancel a battle (refund all)
      const delBattleMatch = p.match(/^\/api\/admin\/battles\/([a-f0-9]+)$/);
      if (delBattleMatch && req.method === "DELETE") {
        if (!(await this._admin.can(uid, "battles"))) return deny();
        const bId = delBattleMatch[1];
        const b = this._cbActive.get(bId);
        if (!b) return this._json(res, 404, { error: "Battle not found" });
        // Refund all players
        for (const p of b.players) {
          await this.db.updateBalance(p.uid, p.cost).catch(() => {});
          this._cbUserBattle.delete(p.uid);
        }
        this._cbActive.delete(bId);
        return this._json(res, 200, { ok: true });
      }

      return this._json(res, 404, { error: "Not found" });
    }

    // ── Admin panel ───────────────────────────────────────────────────────────
    if (p === "/admin/panel" || p === "/admin/panel/") {
      return this._handleAdminPanel(req, res);
    }
    // Block all other /admin/* sub-paths to avoid accidental exposure
    if (p.startsWith("/admin/")) {
      res.writeHead(404, { "Cache-Control": "no-store" }); return res.end("Not found");
    }

    if (p.startsWith("/assets/")) {
      const cached = _assetCache.get(p);
      if (cached) return serveBufferWithRanges(req, res, cached.buf, cached.mime);
      const disk = assetUrlToDiskPath(p);
      if (disk && fs.existsSync(disk)) return serveFileWithRanges(req, res, disk, getMime(disk));
      res.writeHead(404, { "Cache-Control": "no-store" }); return res.end("Not found");
    }

    if (p === "/lobby" && req.method === "GET")
      return this._renderPage(req, res, "lobby.html", "lobby");
    if (p === "/slots" && req.method === "GET")
      return this._renderPage(req, res, "slots.html", "slots");
    if (p === "/misc" && req.method === "GET")
      return this._renderPage(req, res, "misc.html", "misc");

    // ── Case Battle page ─────────────────────────────────────────────────────
    if ((p === "/case-battle" || p.startsWith("/case-battle/")) && req.method === "GET") {
      const uid = this._uid(req);
      if (!uid) return this._redirect(res, "/login");
      const battleId = p.startsWith("/case-battle/") ? p.slice("/case-battle/".length) : null;
      return this._renderPage(req, res, "case-battle.html", "case-battle", {
        "__UID__": uid,
        "__BATTLE_ID__": battleId ? esc(battleId) : "",
      });
    }

    if (p === "/api/balance" && req.method === "GET") {
      const uid = this._uid(req);
      if (!uid) return this._json(res, 401, { error: "Not logged in" });
      const user = await this.db.getUser(uid);
      return this._json(res, 200, { bal: Number(user?.bal ?? 0) });
    }

    // ── Slots ─────────────────────────────────────────────────────────────────
    if (p === "/api/slots/games" && req.method === "GET") {
      const uid = this._uid(req);
      if (!uid) return this._json(res, 401, { error: "Not logged in" });
      return this._json(res, 200, { games: Slots.listGames() });
    }

    // POST /api/slots/spin { game, bet, buy } — resolve a whole round server-side
    if (p === "/api/slots/spin" && req.method === "POST") {
      const uid = this._uid(req);
      if (!uid) return this._json(res, 401, { error: "Not logged in" });
      let data;
      try { data = JSON.parse(await readBody(req)); } catch { return this._json(res, 400, { error: "Invalid JSON" }); }
      const cfg = Slots.getGame(String(data.game || ""));
      if (!cfg) return this._json(res, 400, { error: "Unknown game" });
      const bet = Math.floor(Number(data.bet) || 0);
      if (!(bet >= 1) || bet > 1_000_000) return this._json(res, 400, { error: "Invalid bet" });
      const buy = !!data.buy;
      const cost = buy ? bet * cfg.buyX : bet;

      // Deduct stake atomically, resolve round, credit winnings.
      const ok = await this.db.atomicDeduct(uid, -cost);
      if (!ok) return this._json(res, 200, { error: "Insufficient balance" });
      let result;
      try {
        result = Slots.spin(cfg.id, bet, buy);
      } catch (e) {
        await this.db.updateBalance(uid, cost).catch(() => {}); // refund on engine error
        return this._json(res, 500, { error: "Spin failed" });
      }
      if (result.totalWin > 0) await this.db.updateBalance(uid, result.totalWin).catch(() => {});
      this.db.recordGame(uid, result.totalWin >= cost, cost).catch(() => {});
      const user = await this.db.getUser(uid).catch(() => null);
      return this._json(res, 200, {
        game: cfg.id, bet, cost, buy,
        spins: result.spins,
        totalWin: result.totalWin,
        freeTriggered: result.freeTriggered,
        freeAwarded: result.freeAwarded,
        balance: Number(user?.bal ?? 0),
      });
    }

    // ── Send-money picker: search users (no balance leak) ─────────────────────
    if (p === "/api/users/search" && req.method === "GET") {
      const uid = this._uid(req);
      if (!uid) return this._json(res, 401, { error: "Not logged in" });
      const q = u.searchParams.get("q") || "";
      let rows = [];
      try { rows = await this.db.searchUsers(q, 25, uid); } catch (e) { console.error("[users/search]", e); }
      const users = rows.map(r => ({ id: r._id, tag: r.tag || null, avatar: r.av || fluxerAvatarUrl(r._id, null) }));
      return this._json(res, 200, { users });
    }

    // ── Send money: atomic transfer ───────────────────────────────────────────
    if (p === "/api/transfer" && req.method === "POST") {
      const uid = this._uid(req);
      if (!uid) return this._json(res, 401, { error: "Not logged in" });
      let data;
      try { data = JSON.parse(await readBody(req)); } catch { return this._json(res, 400, { error: "Invalid JSON" }); }
      const toId = String(data.toId ?? "").trim();
      const amount = Math.floor(Number(data.amount));
      if (!/^\d{17,20}$/.test(toId)) return this._json(res, 200, { error: "Invalid recipient" });
      if (toId === uid) return this._json(res, 200, { error: "Can't send to yourself" });
      if (!Number.isFinite(amount) || amount <= 0) return this._json(res, 200, { error: "Invalid amount" });
      let ok = false;
      try { ok = await this.db.transfer(uid, toId, amount); } catch (e) { console.error("[transfer]", e); }
      if (!ok) return this._json(res, 200, { error: "Insufficient balance" });
      const me = await this.db.getUser(uid);
      return this._json(res, 200, { ok: true, newBal: Number(me?.bal ?? 0) });
    }

    // ── Case Battle API ──────────────────────────────────────────────────────

    // GET /api/case-battle/tiers — all case tier definitions
    if (p === "/api/case-battle/tiers" && req.method === "GET") {
      const tiers = this._cbAllTiers().map(t => ({
        id: t.id, label: t.label, entry: t.entry,
        color: t.color, bg: t.bg, builtIn: !!t.builtIn,
        rtp: Math.round(t.items.reduce((s, i) => s + i.v * i.w, 0) /
                        t.items.reduce((s, i) => s + i.w, 0) / t.entry * 100),
        items: t.items.map(i => ({ s: i.s, n: i.n, v: i.v })),
      }));
      return this._json(res, 200, { tiers });
    }

    // GET /api/case-battle/list — open and in-progress battles
    if (p === "/api/case-battle/list" && req.method === "GET") {
      const uid = this._uid(req);
      const battles = [...this._cbActive.values()]
        .filter(b => b.phase !== "done")
        .map(b => {
          const players = b.players.map(p => ({
            uid: p.uid,
            tag: p.tag || p.uid,
            isCreator: p.uid === b.creatorUid,
          }));
          return {
            id: b.id,
            mode: b.mode,
            cases: b.cases,
            cost: b.cost,
            pot: b.pot,
            maxPlayers: b.maxPlayers,
            speed: b.speed || "normal",
            jackpot: !!b.jackpot,
            crazy: !!b.crazy,
            players,
            creatorUid: b.creatorUid,
            phase: b.phase,
            createdAt: b.createdAt,
            watcherCount: b.watchers ? b.watchers.size : 0,
          };
        })
        .sort((a, b) => a.createdAt - b.createdAt);
      return this._json(res, 200, { battles });
    }

    // POST /api/case-battle/create — create a new battle
    if (p === "/api/case-battle/create" && req.method === "POST") {
      const uid = this._uid(req);
      if (!uid) return this._json(res, 401, { error: "Not logged in" });
      const cookies = parseCookies(req);
      const tag = decodeURIComponent(cookies.dtag || uid);
      let data;
      try { data = JSON.parse(await readBody(req)); } catch { return this._json(res, 400, { error: "Invalid JSON" }); }
      const { cases, mode, maxPlayers, speed, jackpot, crazy, hidden } = data;

      if (!Array.isArray(cases) || cases.length === 0)
        return this._json(res, 400, { error: "At least one case is required" });
      if (!["regular", "shared"].includes(mode))
        return this._json(res, 400, { error: "Invalid mode" });
      const mp = Math.max(2, Math.min(8, Number(maxPlayers) || 2));
      // speed: "normal" | "fast" (faster reveal)
      const sp = speed === "fast" ? "fast" : "normal";
      const jp = !!jackpot;
      const cr = !!crazy;
      // Hidden mode: opponents' pulls + odds masked until the battle resolves.
      const hd = !!hidden;

      // Validate cases and compute entry cost
      const validatedCases = [];
      let entryCost = 0;
      for (const c of cases) {
        const tier = this._cbTierById(c.tier);
        if (!tier) return this._json(res, 400, { error: `Invalid tier: ${c.tier}` });
        const qty = Math.max(1, Math.min(20, Number(c.qty) || 1));
        for (let i = 0; i < qty; i++) {
          validatedCases.push({ tier: tier.id, cost: tier.entry });
          entryCost += tier.entry;
        }
      }

      // Deduct entry cost atomically
      const deducted = await this.db.atomicDeduct(uid, -entryCost);
      if (!deducted) return this._json(res, 200, { error: "Insufficient balance" });

      const user = await this.db.getUser(uid).catch(() => null);
      const avatar = user?.av || fluxerAvatarUrl(uid, null);

      const battleId = crypto.randomBytes(8).toString("hex");
      const battle = {
        id: battleId,
        creatorUid: uid,
        mode,
        maxPlayers: mp,
        cases: validatedCases,
        cost: entryCost,
        pot: entryCost * mp,
        speed: sp,
        jackpot: jp,
        crazy: cr,
        hidden: hd,
        phase: "pending",
        players: [{ uid, tag, avatar, cost: entryCost, rewards: [], totalValue: 0, netWin: 0 }],
        createdAt: Date.now(),
        resolvedAt: 0,
        winnerUid: null,
        watchers: new Set(),
        recreateAccepts: new Set(),
        recreateBattleId: null,
      };
      this._cbActive.set(battleId, battle);
      this._cbUserBattle.set(uid, battleId);
      return this._json(res, 200, { battleId });
    }

    // POST /api/case-battle/:id/join — join an existing battle
    if (p.startsWith("/api/case-battle/") && p.endsWith("/join") && req.method === "POST") {
      const uid = this._uid(req);
      if (!uid) return this._json(res, 401, { error: "Not logged in" });
      const cookies = parseCookies(req);
      const tag = decodeURIComponent(cookies.dtag || uid);
      const battleId = p.slice("/api/case-battle/".length, -"/join".length);
      const battle = this._cbActive.get(battleId);
      if (!battle) return this._json(res, 200, { error: "Battle not found" });
      if (battle.phase !== "pending")
        return this._json(res, 200, { error: "Battle has already started" });
      if (battle.players.some(p => p.uid === uid))
        return this._json(res, 200, { error: "Already in this battle" });
      if (battle.players.length >= battle.maxPlayers)
        return this._json(res, 200, { error: "Battle is full" });

      const deducted = await this.db.atomicDeduct(uid, -battle.cost);
      if (!deducted) return this._json(res, 200, { error: "Insufficient balance" });

      const ju = await this.db.getUser(uid).catch(() => null);
      const javatar = ju?.av || fluxerAvatarUrl(uid, null);
      battle.players.push({ uid, tag, avatar: javatar, cost: battle.cost, rewards: [], totalValue: 0, netWin: 0 });
      this._cbUserBattle.set(uid, battleId);

      // If now full, start the battle
      if (battle.players.length >= battle.maxPlayers) {
        this._cbStartBattle(battle);
      }

      return this._json(res, 200, { battleId });
    }

    // POST /api/case-battle/:id/bot — creator adds one bot to a free slot (house-funded)
    if (p.startsWith("/api/case-battle/") && p.endsWith("/bot") && req.method === "POST") {
      const uid = this._uid(req);
      if (!uid) return this._json(res, 401, { error: "Not logged in" });
      const battleId = p.slice("/api/case-battle/".length, -"/bot".length);
      const battle = this._cbActive.get(battleId);
      if (!battle) return this._json(res, 200, { error: "Battle not found" });
      if (battle.creatorUid !== uid) return this._json(res, 200, { error: "Only the creator can add bots" });
      if (battle.phase !== "pending") return this._json(res, 200, { error: "Battle already started" });
      if (battle.players.length >= battle.maxPlayers) return this._json(res, 200, { error: "Battle is full" });

      const bot = this._cbMakeBot(battle.cost);
      battle.players.push(bot);
      if (battle.players.length >= battle.maxPlayers) this._cbStartBattle(battle);
      return this._json(res, 200, { battleId });
    }

    // POST /api/case-battle/:id/recreate — real player accepts a rematch
    if (p.startsWith("/api/case-battle/") && p.endsWith("/recreate") && req.method === "POST") {
      const uid = this._uid(req);
      if (!uid) return this._json(res, 401, { error: "Not logged in" });
      const battleId = p.slice("/api/case-battle/".length, -"/recreate".length);
      const battle = this._cbActive.get(battleId);
      if (!battle) return this._json(res, 200, { error: "Battle not found" });
      if (battle.phase !== "done") return this._json(res, 200, { error: "Battle not finished" });
      const realPlayers = battle.players.filter(pl => !pl.bot);
      if (!realPlayers.some(pl => pl.uid === uid)) return this._json(res, 200, { error: "You weren't in this battle" });
      // If already recreated, just point the caller there.
      if (battle.recreateBattleId) return this._json(res, 200, { battleId: battle.recreateBattleId });

      // Must afford to accept.
      const me = await this.db.getUser(uid).catch(() => null);
      if ((me?.bal ?? 0) < battle.cost) return this._json(res, 200, { error: "Insufficient balance" });
      if (!battle.recreateAccepts) battle.recreateAccepts = new Set();
      battle.recreateAccepts.add(uid);

      // All real players accepted? Verify each can afford, then build the rematch.
      const allAccepted = realPlayers.every(pl => battle.recreateAccepts.has(pl.uid));
      if (!allAccepted) return this._json(res, 200, { accepted: battle.recreateAccepts.size, needed: realPlayers.length });

      // Only ONE request may build the rematch (avoid double-charge / double-create
      // when both players accept near-simultaneously). Others wait for the id.
      if (battle._recreating) {
        return this._json(res, 200, { accepted: battle.recreateAccepts.size, needed: realPlayers.length, pending: true });
      }
      battle._recreating = true;
      try {
        if (battle.recreateBattleId) return this._json(res, 200, { battleId: battle.recreateBattleId });

        // Re-check affordability + deduct for every real player.
        const charged = [];
        for (const pl of realPlayers) {
          const d = await this.db.atomicDeduct(pl.uid, -battle.cost);
          if (!d) { // refund any already charged, abort
            for (const c of charged) await this.db.updateBalance(c, battle.cost).catch(() => {});
            battle.recreateAccepts.delete(pl.uid);
            return this._json(res, 200, { error: `${pl.tag || pl.uid} can no longer afford it` });
          }
          charged.push(pl.uid);
        }

        const newId = crypto.randomBytes(8).toString("hex");
        const players = [];
        for (const pl of realPlayers) {
          const u2 = await this.db.getUser(pl.uid).catch(() => null);
          players.push({ uid: pl.uid, tag: pl.tag, avatar: u2?.av || fluxerAvatarUrl(pl.uid, null), cost: battle.cost, rewards: [], totalValue: 0, netWin: 0 });
          this._cbUserBattle.set(pl.uid, newId);
        }
        const botCount = battle.players.filter(pl => pl.bot).length;
        for (let i = 0; i < botCount; i++) players.push(this._cbMakeBot(battle.cost));

        const nb = {
          id: newId, creatorUid: battle.creatorUid, mode: battle.mode, maxPlayers: battle.maxPlayers,
          cases: battle.cases.map(c => ({ ...c })), cost: battle.cost, pot: battle.cost * battle.maxPlayers,
          speed: battle.speed, jackpot: battle.jackpot, crazy: battle.crazy, hidden: battle.hidden,
          phase: "pending", players, createdAt: Date.now(), resolvedAt: 0, winnerUid: null,
          watchers: new Set(), recreateAccepts: new Set(), recreateBattleId: null,
        };
        this._cbActive.set(newId, nb);
        battle.recreateBattleId = newId;
        if (nb.players.length >= nb.maxPlayers) this._cbStartBattle(nb);
        return this._json(res, 200, { battleId: newId });
      } finally {
        battle._recreating = false;
      }
    }

    // POST /api/case-battle/:id/watch — register as a watcher
    if (p.startsWith("/api/case-battle/") && p.endsWith("/watch") && req.method === "POST") {
      const uid = this._uid(req);
      if (!uid) return this._json(res, 401, { error: "Not logged in" });
      const battleId = p.slice("/api/case-battle/".length, -"/watch".length);
      const battle = this._cbActive.get(battleId);
      if (!battle) return this._json(res, 200, { error: "Battle not found" });
      // Don't let players in the battle register as watchers
      if (!battle.players.some(p => p.uid === uid)) {
        if (!battle.watchers) battle.watchers = new Set();
        battle.watchers.add(uid);
      }
      return this._json(res, 200, { battleId });
    }

    // GET /api/case-battle/:id — get battle state (also used for watching)
    if (p.startsWith("/api/case-battle/") && !p.includes("/join") && !p.includes("/create") && !p.includes("/watch") && !p.includes("/bot") && !p.includes("/recreate") && req.method === "GET") {
      const uid = this._uid(req);
      if (!uid) return this._json(res, 401, { error: "Not logged in" });
      const battleId = p.slice("/api/case-battle/".length);
      const battle = this._cbActive.get(battleId);
      if (!battle) return this._json(res, 200, { notFound: true });
      const isPlayer = battle.players.some(p => p.uid === uid);
      const realPlayers = battle.players.filter(pl => !pl.bot);
      // Hidden mode: while the battle is unresolved, mask everyone except the
      // viewer (and only for players — watchers spectate fully). Reveal on done.
      const reveal = battle.phase === "done";
      const maskOf = (pl) => !!battle.hidden && !reveal && isPlayer && pl.uid !== uid;

      return this._json(res, 200, {
        id: battle.id,
        mode: battle.mode,
        cases: battle.cases,
        cost: battle.cost,
        pot: battle.pot,
        maxPlayers: battle.maxPlayers,
        speed: battle.speed || "normal",
        jackpot: !!battle.jackpot,
        crazy: !!battle.crazy,
        hidden: !!battle.hidden,
        creatorUid: battle.creatorUid,
        phase: battle.phase,
        startsAt: battle.startsAt || null,
        openedAt: battle.openedAt || null,
        now: Date.now(),
        caseStaggerMs: battle.caseStaggerMs || 600,
        caseSpinMs: battle.caseSpinMs || 400,
        jackpotWheelMs: battle.jackpotWheelMs || 0,
        jackpotWinnerIdx: typeof battle.jackpotWinnerIdx === "number" ? battle.jackpotWinnerIdx : null,
        winnerUid: battle.winnerUid,
        resolvedAt: battle.resolvedAt || null,
        isPlayer,
        recreate: {
          accepted: battle.recreateAccepts ? [...battle.recreateAccepts] : [],
          needed: realPlayers.length,
          newBattleId: battle.recreateBattleId || null,
        },
        players: battle.players.map(p => {
          const m = maskOf(p);
          return {
            uid: p.uid,
            tag: p.tag || p.uid,
            avatar: p.avatar || (p.bot ? "" : fluxerAvatarUrl(p.uid, null)),
            bot: !!p.bot,
            cost: p.cost,
            rewards: m ? [] : (p.rewards || []),
            totalValue: m ? 0 : (p.totalValue || 0),
            netWin: m ? 0 : (p.netWin || 0),
            winChance: battle.hidden ? null : (typeof p.winChance === "number" ? p.winChance : null),
            hiddenMasked: m,
          };
        }),
      });
    }

    if (p === "/login" && req.method === "GET") {
      if (!this.clientId) return this._html(res, 500, errPage("⚠️ Not Configured", "Add fluxerClientId, fluxerClientSecret, and webBaseUrl to config.json.", "#", "—"));
      const state  = crypto.randomBytes(16).toString("hex");
      const expiry = Date.now() + 10 * 60 * 1000;
      this._states.set(state, { createdAt: Date.now(), expiry });
      const authUrl = `${FLUXER_AUTH_URL}?client_id=${encodeURIComponent(this.clientId)}&scope=identify+guilds&redirect_uri=${encodeURIComponent(this.redirectUri)}&response_type=code&state=${encodeURIComponent(state)}`;
      const loginPath = path.join(GAMES_HTML_DIR, "login.html");
      if (!fs.existsSync(loginPath)) return this._html(res, 500, errPage("⚠️ Error", "Login page missing.", "#", "—"));
      const html = fs.readFileSync(loginPath, "utf8").replace("__AUTH_URL__", esc(authUrl));
      return this._html(res, 200, html);
    }

    if (p === "/oauth/callback" && req.method === "GET") {
      const code  = u.searchParams.get("code");
      const state = u.searchParams.get("state");
      const stored = this._states.get(state);
      if (!code || !state || !stored) return this._html(res, 400, errPage("❌ Login Failed", "Invalid or expired login state.", "/login", "Try again"));
      // Reject stale or expired CSRF states
      if (Date.now() > (stored.expiry ?? 0)) {
        this._states.delete(state);
        return this._html(res, 400, errPage("❌ Login Failed", "Login state expired. Please try again.", "/login", "Try again"));
      }
      this._states.delete(state);
      let tokenData;
      try {
        const raw = await nodeFetch(FLUXER_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, grant_type: "authorization_code", code, redirect_uri: this.redirectUri }).toString(),
        });
        tokenData = JSON.parse(raw);
      } catch(e) { console.error("[OAuth]", e); return this._html(res, 500, errPage("⚠️ Error", "Could not reach Fluxer.", "/login", "Retry")); }
      if (!tokenData.access_token) return this._html(res, 400, errPage("❌ Login Failed", tokenData.error_description ?? tokenData.message ?? "Unknown error", "/login", "Try again"));
      let me;
      try { me = JSON.parse(await nodeFetch(FLUXER_ME_URL, { headers: { Authorization: `Bearer ${tokenData.access_token}` } })); }
      catch { return this._html(res, 500, errPage("⚠️ Error", "Could not fetch Fluxer profile.", "/login", "Retry")); }
      const userId    = me.id;
      const tag       = me.global_name ?? me.displayName ?? me.username ?? me.tag ?? userId;
      const avatar    = fluxerAvatarUrl(userId, me.avatar);
      // Cache Fluxer identity so the misc send-money picker shows real names.
      await this.db.setProfile(userId, { tag, avatar }).catch(() => {});
      const ip        = (req.headers["x-forwarded-for"] ?? req.headers["x-real-ip"] ?? "").split(",")[0].trim() || null;
      const oldSid    = parseCookies(req).sid; // revoke old session to prevent fixation
      const newSid    = crypto.randomBytes(32).toString("hex");
      if (oldSid) {
        await this.db.rotateSession(userId, oldSid, newSid, 2 * 60 * 60 * 1000, ip).catch(() => {});
      } else {
        await this.db.createSession(userId, newSid, 2 * 60 * 60 * 1000, ip);
      }
      const base = "HttpOnly; Path=/; Max-Age=7200; SameSite=Lax";
      res.setHeader("Set-Cookie", [
        `sid=${newSid}; ${base}`,
        `uid=${userId}; ${base}`,
        `dtag=${encodeURIComponent(tag)}; Path=/; Max-Age=7200; SameSite=Lax`,
        `dav=${encodeURIComponent(avatar)}; Path=/; Max-Age=7200; SameSite=Lax`,
      ]);
      // Redirect admins straight to the panel after login
      const adm = await this._admin.isAdmin(userId).catch(() => false);
      return this._redirect(res, adm ? "/admin/panel" : "/lobby");
    }

    if (p === "/logout") {
      const uid = this._uid(req);
      if (uid) { const c = parseCookies(req); if (c.sid) await this.db.revokeSession(uid, c.sid).catch(() => {}); }
      res.setHeader("Set-Cookie", ["sid=; Path=/; Max-Age=0", "uid=; Path=/; Max-Age=0", "dtag=; Path=/; Max-Age=0", "dav=; Path=/; Max-Age=0"]);
      return this._redirect(res, "/login");
    }

    res.writeHead(404); res.end("Not found");
  }

  _uid(req)  {
    const c = parseCookies(req);
    if (!c.sid || !c.uid) return null;
    // Optional IP-binding: reject sessions if the connecting IP changed.
    if (this._sessionIpBinding) {
      const ip = (req.headers["x-forwarded-for"] ?? req.headers["x-real-ip"] ?? "").split(",")[0].trim() || null;
      const cached = this._ipCache?.get(`${c.uid}:${c.sid}`);
      if (cached !== undefined && cached !== ip) {
        // Grace period: allow a brief window for legitimate IP shifts (e.g. mobile networks).
        const now = Date.now();
        const entry = this._ipGrace?.get(`${c.uid}:${c.sid}`);
        if (!entry || now - entry > this._sessionIpTolerance) {
          console.warn(`[Session] IP mismatch for uid=${c.uid}: cached=${cached} got=${ip}`);
          return null;
        }
      }
      if (!this._ipCache) this._ipCache = new Map();
      this._ipCache.set(`${c.uid}:${c.sid}`, ip);
    }
    return c.uid;
  }
  /**
   * Serve an authed page from games/<file>, injecting the shared sidebar
   * (active tab + admin gating) and standard tokens. `extra` adds page-specific
   * replacements. Redirects to /login if no session.
   */
  async _renderPage(req, res, file, active, extra = {}) {
    const uid = this._uid(req);
    if (!uid) return this._redirect(res, "/login");
    const fp = path.join(GAMES_HTML_DIR, file);
    if (!fs.existsSync(fp)) return this._html(res, 503, errPage("Not Ready", "This page is not available yet.", "/lobby", "Back"));
    const cookies = parseCookies(req);
    const user = await this.db.getUser(uid);
    const bal = Number(user?.bal ?? 0);
    const tag = decodeURIComponent(cookies.dtag ?? user?.tag ?? "Player");
    let avatar = decodeURIComponent(cookies.dav ?? user?.av ?? "");
    if (!avatar) avatar = fluxerAvatarUrl(uid, null); // default static avatar
    const showAdmin = await this._admin.isAdmin(uid).catch(() => false);
    const sidebar = buildSidebar({ active, uid, tag, avatar, bal, showAdmin });
    let html = fs.readFileSync(fp, "utf8")
      .replace("__SIDEBAR__", sidebar)
      .replace(/__BALANCE__/g, String(bal))
      .replace(/__TAG__/g, esc(tag))
      .replace(/__AVATAR__/g, esc(avatar));
    for (const [k, v] of Object.entries(extra)) html = html.split(k).join(v);
    // Cache-bust local CSS/JS so deployed changes load immediately.
    html = html.replace(/(\/assets\/[^"'?\s]+\.(?:css|js))(["'])/g, `$1?v=${ASSET_VER}$2`);
    return this._html(res, 200, html);
  }

  _html(res, s, b) { res.writeHead(s, { "Content-Type": "text/html;charset=utf-8" }); res.end(b); }
  _json(res, s, o) { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); }
  _redirect(res, l) { res.setHeader("Location", l); res.writeHead(302); res.end(); }
}
