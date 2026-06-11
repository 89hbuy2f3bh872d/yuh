import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import * as fs from "node:fs";
import { Client, Events } from "@fluxerjs/core";
import { MessageHandler, CommandHandler, PrefixManager } from "./src/CommandHandler.mjs";
import { SettingsManager } from "./src/Settings.mjs";
import { connectDb } from "./src/Database.mjs";

const config = JSON.parse(readFileSync("./config.json", "utf8"));

async function main() {
  const mongoUri = config.mongodb?.uri ?? "mongodb://localhost:27017";
  const mongoDb = config.mongodb?.database ?? "fluxer_casino";
  console.log("[Casino] Connecting to MongoDB...");
  await connectDb(mongoUri, mongoDb);
  console.log("[Casino] MongoDB connected.");

  const client = new Client({ token: config.token, ...config["fluxer.js"] });
  const settings = new SettingsManager();
  const handler = new MessageHandler(client);
  const commands = new CommandHandler(handler, config.prefix ?? "!");
  commands.setPrefixManager(new PrefixManager(settings, config.prefix ?? "!"));
  commands.owners = config.owners ?? [];

  const cmdDir = path.join(path.dirname(pathToFileURL(import.meta.url).pathname), "commands");
  for (const file of fs.readdirSync(cmdDir).filter(f => f.endsWith(".mjs"))) {
    const mod = await import(pathToFileURL(path.join(cmdDir, file)).href);
    if (!mod.command || !mod.run) continue;
    mod.command.run = mod.run;
    commands.addCommand(mod.command);
    console.log(`[Casino] Loaded command: ${mod.command.name}`);
  }

  const presences = config.presenceContents ?? [];
  if (presences.length) {
    let pi = 0;
    const setPresence = () => {
      const p = presences[pi++ % presences.length];
      client.user?.setPresence(p);
    };
    client.on(Events.Ready, () => {
      console.log(`[Casino] Logged in as ${client.user?.tag}`);
      setPresence();
      if (config.presenceInterval) setInterval(setPresence, config.presenceInterval);
    });
  }

  await client.login();
}

main().catch(err => {
  console.error("[Casino] Fatal:", err);
  process.exit(1);
});
