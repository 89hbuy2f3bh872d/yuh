import { COLORS } from "../src/theme.mjs";

function parseBet(str, bal) {
  if (!str) return NaN;
  const s = str.toLowerCase();
  if (s === "all") return bal;
  if (s === "half") return Math.floor(bal / 2);
  const m = s.match(/^([\d.]+)([km]?)$/);
  if (!m) return NaN;
  let v = parseFloat(m[1]);
  if (m[2] === "k") v *= 1_000;
  if (m[2] === "m") v *= 1_000_000;
  return Math.floor(v);
}

export default {
  name: "pay",
  aliases: ["give", "send"],
  description: "Send FC to another user. `&pay @user <amount>`",

  async execute({ message, args, db, embed }) {
    const uid = message.author.id;

    // Fluxer's message.mentions may be an array, a Collection, or undefined.
    // Resolve the target user defensively.
    let target;
    const mentions = message.mentions;
    if (mentions) {
      if (typeof mentions.first === "function") {
        // Discord.js-style Collection on .users
        target = mentions.users?.first?.() ?? mentions.first();
      } else if (Array.isArray(mentions)) {
        target = mentions[0];
      } else if (mentions.users) {
        const u = mentions.users;
        target = typeof u.first === "function" ? u.first() : (Array.isArray(u) ? u[0] : Object.values(u)[0]);
      }
    }

    // Fallback: parse a raw user id from args[0] (<@id> or <@!id>)
    if (!target) {
      const match = (args[0] ?? "").match(/^<@!?(\d+)>$/);
      if (match) {
        const id = match[1];
        // Build a minimal user-like object so the rest of the command works
        try { target = await message.client.users.fetch(id); } catch { /* ignore */ }
        if (!target) target = { id, tag: `<@${id}>`, bot: false };
      }
    }

    if (!target || target.bot || target.id === uid) {
      return message.channel.send({ embeds: [embed(COLORS.error).setDescription("\u274c Mention a valid user to pay.")] });
    }

    const u = await db.getUser(uid);
    const amount = parseBet(args[1], u.bal);

    if (isNaN(amount) || amount <= 0) {
      return message.channel.send({ embeds: [embed(COLORS.error).setDescription("\u274c Invalid amount. e.g. `&pay @user 500` or `&pay @user all`")] });
    }
    if (amount > u.bal) {
      return message.channel.send({ embeds: [embed(COLORS.error).setDescription("\u274c Insufficient FC.")] });
    }

    await db.transfer(uid, target.id, amount);

    return message.channel.send({ embeds: [
      embed(COLORS.primary)
        .setTitle("\ud83d\udcb8 Transfer Complete")
        .setDescription(`Sent **${amount.toLocaleString()} FC** to **${target.tag ?? target.username ?? target.id}**.`)
    ]});
  },
};
