import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Client, Events } from "@fluxerjs/core";
import { CommandHandler } from "./src/CommandHandler.mjs";
import { Database } from "./src/Database.mjs";
import { WebServer } from "./src/WebServer.mjs";

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

const web = new WebServer(db, config);
await web.start();
globalThis.__web = web; // accessible to bandit command

const client = new Client({ intents: 0, suppressIntentWarning: true, ...config["fluxer.js"] });
const handler = new CommandHandler(client, db, config);
await handler.loadCommands(path.join(__dirname, "commands"));

client.on(Events.Ready, () => console.log(`[Ready] ${client.user?.username}`));
client.on(Events.MessageCreate, (msg) => handler.handleMessage(msg));

client.login(config.token).catch(e => { console.error("[Login]", e.message); process.exit(1); });
process.on("unhandledRejection", r => console.error("[Error]", r));
process.on("uncaughtException", e => { console.error("[Fatal]", e); process.exit(1); });
