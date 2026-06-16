import { EmbedBuilder } from "@fluxerjs/core";
import fs from "fs";
import path from "path";
import { COLORS } from "./theme.mjs";

export class CommandHandler {
  constructor(client, db, config) {
    this.client = client;
    this.db = db;
    this.config = config;
    this.prefix = config.prefix ?? "&";
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
    if (!cmdName) return;

    const cmd = this.commands.get(cmdName);
    if (!cmd) {
      message.channel?.send?.({
        embeds: [
          makeEmbed(COLORS.error)
            .setDescription(`\u274c Unknown command \`${this.prefix}${cmdName}\`. Use \`${this.prefix}help\` to see all commands.`)
        ]
      }).catch(() => {});
      return;
    }

    // ── Track command usage + guild presence ──────────────────────────────────
    const guildId   = message.guild?.id ?? message.guildId ?? null;
    const guildName = message.guild?.name ?? null;
    if (this.db) {
      this.db.recordCommand(cmd.name).catch(() => {});
      if (guildId) {
        this.db.upsertGuild(guildId, {
          name:        guildName,
          memberCount: message.guild?.memberCount ?? null,
          icon:        message.guild?.icon ?? null,
        }).catch(() => {});
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    try {
      await cmd.execute({
        message,
        args,
        db: this.db,
        config: this.config,
        embed: makeEmbed,
        prefix: this.prefix,
        commands: this.commands,
        webHost: this.config.webHost ?? "localhost",
        webPort: this.config.webPort ?? 3420,
      });
    } catch (e) {
      console.error(`[Command:${cmdName}]`, e);
      message.channel?.send?.({ content: "\u26a0\ufe0f Something went wrong." }).catch(() => {});
    }
  }
}

export function makeEmbed(color) {
  return new EmbedBuilder().setColor(color ?? COLORS.accent);
}
