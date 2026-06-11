import { COLORS } from "../src/theme.mjs";

const DAILY_AMOUNT = 1_000;
const COOLDOWN_MS = 86_400_000; // 24h

export default {
  name: "daily",
  aliases: ["claim"],
  description: "Claim your daily 1,000 FC.",

  async execute({ message, db, embed }) {
    const uid = message.author.id;
    const u = await db.getUser(uid);
    const now = Date.now();
    const last = u.ld || 0;
    const diff = now - last;

    if (diff < COOLDOWN_MS) {
      const remaining = COOLDOWN_MS - diff;
      const h = Math.floor(remaining / 3_600_000);
      const m = Math.floor((remaining % 3_600_000) / 60_000);
      return message.channel.send({ embeds: [
        embed(COLORS.warn)
          .setDescription(`⏳ Come back in **${h}h ${m}m**.`)
      ]});
    }

    await db.updateBalance(uid, DAILY_AMOUNT);
    await db.setLastDaily(uid, now);

    return message.channel.send({ embeds: [
      embed(COLORS.primary)
        .setTitle("🎁 Daily Claimed")
        .setDescription(`+**${DAILY_AMOUNT.toLocaleString()} FC** added to your balance!`)
    ]});
  },
};
