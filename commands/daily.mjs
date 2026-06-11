import { COLORS } from "../src/theme.mjs";
const DAILY_AMOUNT = 500;
const COOLDOWN_MS = 20 * 60 * 60 * 1000;
export default {
  name: "daily",
  aliases: ["claim"],
  description: "Claim your daily 500 FC reward (20h cooldown).",
  async execute({ message, db, embed }) {
    const uid = message.author.id;
    const u = await db.getUser(uid);
    const remaining = COOLDOWN_MS - (Date.now() - (u.ld ?? 0));
    if (remaining > 0) {
      const h = Math.floor(remaining / 3600000);
      const m = Math.floor((remaining % 3600000) / 60000);
      return message.channel.send({ embeds: [embed(COLORS.error).setDescription(`⏳ Come back in **${h}h ${m}m** for your next reward.`)] });
    }
    await db.setLastDaily(uid, Date.now());
    await db.updateBalance(uid, DAILY_AMOUNT);
    const updated = await db.getUser(uid);
    return message.channel.send({ embeds: [
      embed(COLORS.gold)
        .setTitle("🎁 Daily Reward")
        .setDescription(`Claimed **${DAILY_AMOUNT} FC**! New balance: **${updated.bal.toLocaleString()} FC**`)
    ]});
  },
};
