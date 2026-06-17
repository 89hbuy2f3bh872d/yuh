import { COLORS } from "../src/theme.mjs";

// Pet shop — buy one, name it, level it up by chatting in the server.
const SHOP = [
  { id: "cat",     emoji: "🐱", name: "Cat",     price: 500 },
  { id: "dog",     emoji: "🐶", name: "Dog",     price: 500 },
  { id: "fox",     emoji: "🦊", name: "Fox",     price: 1200 },
  { id: "panda",   emoji: "🐼", name: "Panda",   price: 2000 },
  { id: "dragon",  emoji: "🐉", name: "Dragon",  price: 8000 },
  { id: "unicorn", emoji: "🦄", name: "Unicorn", price: 12000 },
  { id: "phoenix", emoji: "🔥", name: "Phoenix", price: 25000 },
];
const need = (lv) => (lv || 1) * 100;
function bar(xp, lv) {
  const n = need(lv), p = Math.max(0, Math.min(1, xp / n));
  const f = Math.round(p * 12);
  return "▰".repeat(f) + "▱".repeat(12 - f) + ` ${xp}/${n}`;
}

export default {
  name: "pet",
  aliases: ["pets"],
  description: "Buy, name, trade and level up a pet by chatting.",

  async execute({ message, args, db, embed, prefix }) {
    const uid = message.author.id;
    const sub = (args[0] || "").toLowerCase();
    const send = (e) => message.channel.send({ embeds: [e] });

    if (sub === "shop") {
      const lines = SHOP.map(s => `${s.emoji} **${s.name}** — \`${s.price.toLocaleString()} FC\` · \`${prefix}pet buy ${s.id}\``).join("\n");
      return send(embed(COLORS.accent).setTitle("🛒 Pet Shop").setDescription(lines + `\n\nLevel up your pet just by chatting!`));
    }

    if (sub === "buy") {
      const existing = await db.getPet(uid);
      if (existing) return send(embed(COLORS.error).setDescription(`❌ You already own ${existing.emoji} **${existing.name}**. \`${prefix}pet release\` first.`));
      const s = SHOP.find(x => x.id === (args[1] || "").toLowerCase());
      if (!s) return send(embed(COLORS.error).setDescription(`❌ Unknown pet. See \`${prefix}pet shop\`.`));
      const ok = await db.atomicDeduct(uid, -s.price);
      if (!ok) return send(embed(COLORS.error).setDescription(`❌ Not enough FC. Need \`${s.price.toLocaleString()} FC\`.`));
      const pet = { species: s.id, emoji: s.emoji, name: s.name, level: 1, xp: 0, boughtAt: Date.now() };
      await db.savePet(uid, pet);
      return send(embed(COLORS.accent).setTitle("🎉 New pet!").setDescription(`You adopted ${s.emoji} **${s.name}**!\nName it with \`${prefix}pet name <name>\` and chat to level it up.`));
    }

    if (sub === "name" || sub === "rename") {
      const pet = await db.getPet(uid);
      if (!pet) return send(embed(COLORS.error).setDescription(`❌ You don't own a pet. \`${prefix}pet shop\``));
      const nm = args.slice(1).join(" ").trim().slice(0, 24);
      if (!nm) return send(embed(COLORS.error).setDescription(`❌ Usage: \`${prefix}pet name <name>\``));
      pet.name = nm; await db.savePet(uid, pet);
      return send(embed(COLORS.accent).setDescription(`✅ Renamed your pet to ${pet.emoji} **${nm}**.`));
    }

    if (sub === "gift" || sub === "trade" || sub === "give") {
      const target = message.mentions?.users?.first();
      if (!target) return send(embed(COLORS.error).setDescription(`❌ Usage: \`${prefix}pet gift @user\``));
      if (target.id === uid) return send(embed(COLORS.error).setDescription("❌ You can't gift to yourself."));
      if (target.bot) return send(embed(COLORS.error).setDescription("❌ Can't gift to a bot."));
      const pet = await db.getPet(uid);
      if (!pet) return send(embed(COLORS.error).setDescription("❌ You don't own a pet."));
      const theirs = await db.getPet(target.id);
      if (theirs) return send(embed(COLORS.error).setDescription(`❌ ${target.tag ?? "They"} already own a pet.`));
      await db.savePet(target.id, pet);
      await db.savePet(uid, null);
      return send(embed(COLORS.accent).setTitle("🤝 Pet traded").setDescription(`You gave ${pet.emoji} **${pet.name}** (Lv ${pet.level}) to <@${target.id}>.`));
    }

    if (sub === "release") {
      const pet = await db.getPet(uid);
      if (!pet) return send(embed(COLORS.error).setDescription("❌ You don't own a pet."));
      await db.savePet(uid, null);
      return send(embed(COLORS.warning ?? COLORS.accent).setDescription(`👋 You released ${pet.emoji} **${pet.name}**.`));
    }

    // default: status
    const pet = await db.getPet(uid);
    if (!pet) return send(embed(COLORS.accent).setTitle("🐾 Pets").setDescription(`You don't own a pet yet.\nBrowse \`${prefix}pet shop\` and \`${prefix}pet buy <id>\`.\n\nChat in the server to level your pet up!`));
    const e = embed(COLORS.accent)
      .setTitle(`${pet.emoji} ${pet.name}`)
      .setDescription(`**Level ${pet.level}**\n${bar(pet.xp || 0, pet.level)}\n\nKeep chatting to level up · \`${prefix}pet shop\``)
      .addFields(
        { name: "Species", value: pet.species, inline: true },
        { name: "Level", value: String(pet.level), inline: true },
      );
    return send(e);
  },
};
