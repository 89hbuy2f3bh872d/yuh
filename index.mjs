import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Client, Events } from "@fluxerjs/core";
import { CommandHandler } from "./src/CommandHandler.mjs";
import { Database } from "./src/Database.mjs";
import { StdbBridge } from "./src/stdbBridge.mjs";

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

client.on(Events.Ready, () => console.log(`[Ready] ${client.user?.username}`));
client.on(Events.MessageCreate, (msg) => handler.handleMessage(msg));

client.login(config.token).catch(e => { console.error("[Login]", e.message); process.exit(1); });
process.on("unhandledRejection", r => console.error("[Error]", r));
process.on("uncaughtException", e => { console.error("[Fatal]", e); process.exit(1); });
