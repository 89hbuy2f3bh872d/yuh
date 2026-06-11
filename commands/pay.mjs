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
    const target = message.mentions.users.first();

    if (!target || target.bot || target.id === uid) {
      return message.channel.send({ embeds: [embed(COLORS.error).setDescription("❌ Mention a valid user to pay.")] });
    }

    const u = await db.getUser(uid);
    const amount = parseBet(args[1], u.bal);

    if (isNaN(amount) || amount <= 0) {
      return message.channel.send({ embeds: [embed(COLORS.error).setDescription("❌ Invalid amount. e.g. `&pay @user 500` or `&pay @user all`")] });
    }
    if (amount > u.bal) {
      return message.channel.send({ embeds: [embed(COLORS.error).setDescription("❌ Insufficient FC.")] });
    }

    await db.transfer(uid, target.id, amount);

    return message.channel.send({ embeds: [
      embed(COLORS.primary)
        .setTitle("💸 Transfer Complete")
        .setDescription(`Sent **${amount.toLocaleString()} FC** to **${target.tag}**.`)
    ]});
  },
};
