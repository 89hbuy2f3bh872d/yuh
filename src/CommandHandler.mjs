import { EmbedBuilder } from "@fluxerjs/core";
import fs from "fs";
import path from "path";

export class CommandHandler {
  constructor(client, db, config) {
    this.client = client;
    this.db = db;
    this.config = config;
    this.prefix = config.prefix ?? "!";
    this.commands = new Map();
  }

  async loadCommands(dir) {
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".mjs"));
    for (const file of files) {
      const mod = await import(path.join(dir, file));
      const cmd = mod.default;
      if (!cmd?.name) continue;
      this.commands.set(cmd.name.toLowerCase(), cmd);
      if (cmd.aliases) {
        for (const alias of cmd.aliases) this.commands.set(alias.toLowerCase(), cmd);
      }
    }
    console.log(`[Commands] Loaded: ${[...new Set(this.commands.values())].map(c => c.name).join(", ")}`);
  }

  async handleMessage(message) {
    if (!message?.content || message?.author?.bot) return;
    if (!message.content.startsWith(this.prefix)) return;

    const args = message.content.slice(this.prefix.length).trim().split(/\s+/);
    const cmdName = args.shift().toLowerCase();
    const cmd = this.commands.get(cmdName);
    if (!cmd) return;

    try {
      await cmd.execute({ message, args, db: this.db, config: this.config, embed: makeEmbed });
    } catch (e) {
      console.error(`[Command:${cmdName}]`, e);
      message.channel?.send?.({ content: "⚠️ Something went wrong." }).catch(() => {});
    }
  }
}

export function makeEmbed(color = 0x2b2d31) {
  return new EmbedBuilder().setColor(color);
}
