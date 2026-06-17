import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { Client, Events, EmbedBuilder, GatewayOpcodes } from "@fluxerjs/core";
import { CommandHandler } from "./src/CommandHandler.mjs";
import { Database } from "./src/Database.mjs";
import { StdbBridge } from "./src/stdbBridge.mjs";
import { COLORS } from "./src/theme.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let config;
try {
  config = JSON.parse(fs.readFileSync("config.json", "utf8"));
} catch {
  console.error("[Startup] FATAL: config.json not found.");
  process.exit(1);
}

for (const key of ["token", "mongodb"]) {
  if (!config[key]) { console.error(`[Startup] FATAL: missing config key "${key}".`); process.exit(1); }
}

const db = new Database(config.mongodb.uri, config.mongodb.database);
await db.connect();
setInterval(() => db.pruneExpiredSessions().catch(() => {}), 30 * 60 * 1000);

// The website runs exclusively on the Bun + Elysia service (web/server.ts).
// This Node process is ONLY the Discord/Fluxer bot; for balance ops it routes to
// the Elysia service over localhost (which owns SpacetimeDB).
if (config.spacetime && config.web?.internalSecret) {
  const webUrl = "http://127.0.0.1:" + (config.web.port ?? config.webPort ?? 80);
  db.attachBalanceBridge(new StdbBridge(webUrl, config.web.internalSecret));
  console.log(`[Startup] Balance bridge → ${webUrl}. Web is served by the Elysia service (bun run web/server.ts).`);
} else {
  console.warn("[Startup] config.spacetime / config.web.internalSecret missing — bot will use Mongo balances and won't bridge. Start the Elysia service (web/server.ts) to serve the website.");
}

const client = new Client({ intents: 0, suppressIntentWarning: true, ...config["fluxer.js"] });
const handler = new CommandHandler(client, db, config);
await handler.loadCommands(path.join(__dirname, "commands"));

client.on(Events.Ready, () => {
  console.log(`[Ready] ${client.user?.username}`);
  // Rotating presence — always surfaces the casino website.
  const items = (Array.isArray(config.presenceContents) && config.presenceContents.length)
    ? config.presenceContents
    : [{ text: "🎰 Play at https://sirgreen.online", activity: { name: "sirgreen.online", type: 2 } }];
  let i = 0;
  const PRESENCE_OP = (GatewayOpcodes && GatewayOpcodes.PresenceUpdate != null) ? GatewayOpcodes.PresenceUpdate : 3;
  const tick = () => {
    const e = items[i++ % items.length];
    const presence = {
      status: "online", mobile: false, afk: false,
      custom_status: { text: e.text, emoji_name: e.emoji_name ?? null, emoji_id: e.emoji_id ?? null },
      activities: [e.activity || { name: "sirgreen.online", type: 2 }],
    };
    try { client.ws.send(0, { op: PRESENCE_OP, d: presence }); } catch (err) { console.error("[presence]", err?.message ?? err); }
  };
  tick(); setInterval(tick, 30_000);
});
client.on(Events.MessageCreate, (msg) => handler.handleMessage(msg));

client.login(config.token).catch(e => { console.error("[Login]", e.message); process.exit(1); });

// Internal DM endpoint — the Bun web service posts here (shared secret, localhost) to
// DM users via the Fluxer client (e.g. support-ticket transcripts on close).
if (config.web?.internalSecret) {
  const botPort = config.web.botPort ?? 8091;
  http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/dm" || req.headers["x-internal"] !== config.web.internalSecret) { res.writeHead(403); return res.end("forbidden"); }
    let body = ""; req.on("data", c => { body += c; if (body.length > 100_000) req.destroy(); });
    req.on("end", async () => {
      try {
        const { uid, text, title } = JSON.parse(body || "{}");
        const user = await client.users.fetch(String(uid));
        const dm = await (user.createDM ? user.createDM() : null)?.catch?.(() => null);
        const e = new EmbedBuilder()
          .setColor(COLORS.primary ?? COLORS.accent)
          .setTitle(String(title || "SirGreen Casino").slice(0, 250))
          .setDescription(String(text).slice(0, 4000))
          .setFooter({ text: "SirGreen Casino · Support" });
        await (dm ?? user).send({ embeds: [e] });
        res.writeHead(200); res.end("ok");
      } catch (e) { console.error("[bot/dm]", e?.message ?? e); res.writeHead(500); res.end("err"); }
    });
  }).listen(botPort, "127.0.0.1", () => console.log(`[bot] internal DM endpoint → 127.0.0.1:${botPort}`));
}

process.on("unhandledRejection", r => console.error("[Error]", r));
process.on("uncaughtException", e => { console.error("[Fatal]", e); process.exit(1); });
