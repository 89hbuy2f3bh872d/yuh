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
    this._petXpCd = new Map(); // uid -> last chat-XP timestamp
    this._guildMeta = new Map(); // gid -> "name|icon" (to push realtime renames only on change)
    this._userGuildSeen = new Set(); // "uid:gid" already associated this process (dedup)
  }

  // Award pet XP for ordinary chatting (rate-limited; only if the user owns a pet).
  async _awardPetXp(message) {
    const uid = message.author?.id;
    if (!uid || !this.db?.getPet) return;
    const now = Date.now(), last = this._petXpCd.get(uid) || 0;
    if (now - last < 25000) return;
    this._petXpCd.set(uid, now);
    const pet = await this.db.getPet(uid).catch(() => null);
    if (!pet) return;
    pet.xp = (pet.xp || 0) + 5 + Math.floor(Math.random() * 11);
    let leveled = false, need = (pet.level || 1) * 100;
    while (pet.xp >= need) { pet.xp -= need; pet.level = (pet.level || 1) + 1; leveled = true; need = pet.level * 100; }
    await this.db.savePet(uid, pet).catch(() => {});
    if (leveled) {
      try { message.channel?.send?.({ embeds: [makeEmbed(COLORS.accent).setDescription(`⭐ <@${uid}> your **${pet.name}** grew to **Lv ${pet.level}**!`)] }); } catch (e) {}
    }
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
    this._awardPetXp(message).catch(() => {});
    // Associate the user with this guild (so the web server-selector picks up servers
    // they joined after login) on ANY message — not just &web. Deduped + live-pushed.
    const _gid = message.guild?.id ?? message.guildId ?? null;
    if (_gid && this.db?.addUserGuild) {
      const key = message.author.id + ":" + _gid;
      if (!this._userGuildSeen.has(key)) {
        this._userGuildSeen.add(key);
        if (this._userGuildSeen.size > 8000) this._userGuildSeen.clear();
        // Make sure the guild is in the directory so the selector can resolve it, even
        // if no command has ever run here (idempotent upsert).
        this.db.upsertGuild?.(_gid, {
          name: message.guild?.name ?? null,
          memberCount: message.guild?.memberCount ?? null,
          icon: message.guild?.icon ?? null,
          ownerId: message.guild?.ownerId ?? message.guild?.owner_id ?? null,
        }).catch(() => {});
        this.db.addUserGuild(message.author.id, _gid)
          .then((added) => { if (added) this.db.notifyUserGuilds?.(message.author.id); })
          .catch(() => {});
      }
    }
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
        const icon = message.guild?.icon ?? null;
        this.db.upsertGuild(guildId, {
          name:        guildName,
          memberCount: message.guild?.memberCount ?? null,
          icon,
          ownerId:     message.guild?.ownerId ?? message.guild?.owner_id ?? null,
        }).catch(() => {});
        // Realtime: only ping the web when the visible identity (name/icon) actually changed.
        const meta = `${guildName ?? ""}|${icon ?? ""}`;
        if (this._guildMeta.get(guildId) !== meta) {
          this._guildMeta.set(guildId, meta);
          this.db.notifyGuild?.(guildId, { name: guildName ?? null, icon, members: message.guild?.memberCount ?? null }).catch(() => {});
        }
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
