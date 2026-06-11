import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Client, Events, EmbedBuilder } from "@fluxerjs/core";
import { CommandHandler } from "./src/CommandHandler.mjs";
import { Database } from "./src/Database.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let config;
try {
  config = JSON.parse(fs.readFileSync("config.json", "utf8"));
} catch (e) {
  console.error("[Startup] FATAL: config.json not found or malformed. Copy config_example.json → config.json.");
  process.exit(1);
}

for (const key of ["token", "mongodb"]) {
  if (!config[key]) {
    console.error(`[Startup] FATAL: config.json missing required key "${key}".`);
    process.exit(1);
  }
}

const db = new Database(config.mongodb.uri, config.mongodb.database);
await db.connect();
console.log("[DB] MongoDB connected.");

const client = new Client({
  intents: 0,
  suppressIntentWarning: true,
  ...config["fluxer.js"],
});

const handler = new CommandHandler(client, db, config);
await handler.loadCommands(path.join(__dirname, "commands"));

client.on(Events.Ready, () => {
  console.log(`[Ready] Logged in as ${client.user?.username ?? "bot"}`);
});

client.on(Events.MessageCreate, (message) => handler.handleMessage(message));

client.login(config.token).catch((e) => {
  console.error("[Startup] Login failed:", e.message);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[Error] Unhandled rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[Error] Uncaught exception:", err);
  process.exit(1);
});
