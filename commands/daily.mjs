const DAILY_AMOUNT = 500;
const COOLDOWN_MS = 20 * 60 * 60 * 1000; // 20 hours

export default {
  name: "daily",
  aliases: ["claim"],
  description: "Claim your daily FluxCoins reward.",
  async execute({ message, db, embed }) {
    const uid = message.author.id;
    const user = await db.getUser(uid);
    const last = user.lastDaily ?? 0;
    const now = Date.now();
    const remaining = COOLDOWN_MS - (now - last);

    if (remaining > 0) {
      const h = Math.floor(remaining / 3600000);
      const m = Math.floor((remaining % 3600000) / 60000);
      return message.channel.send({ embeds: [embed(0xe74c3c).setDescription(`⏳ Come back in **${h}h ${m}m** to claim your daily reward.`)] });
    }

    await db.setLastDaily(uid, now);
    await db.updateBalance(uid, DAILY_AMOUNT);
    const updated = await db.getUser(uid);
    return message.channel.send({ embeds: [
      embed(0xf1c40f)
        .setTitle("🎁 Daily Reward")
        .setDescription(`You claimed **${DAILY_AMOUNT} FC**!\nNew balance: **${updated.balance.toLocaleString()} FC**`)
    ]});
  },
};
