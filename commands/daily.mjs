const DAILY = 500;
const COOLDOWN_MS = 86_400_000;
const cooldowns = new Map();

export default {
  name: "daily",
  description: "Claim your daily 500 Flux.",
  async execute({ message, db, embed }) {
    const now = Date.now();
    const last = cooldowns.get(message.author.id) ?? 0;
    const diff = now - last;
    if (diff < COOLDOWN_MS) {
      const remaining = Math.ceil((COOLDOWN_MS - diff) / 3_600_000);
      return message.channel.send({ embeds: [
        embed(0xe74c3c).setDescription(`⏰ Come back in **${remaining}h** for your next daily.`)
      ]});
    }
    cooldowns.set(message.author.id, now);
    const user = await db.updateBalance(message.author.id, DAILY);
    message.channel.send({ embeds: [
      embed(0x2ecc71)
        .setTitle("🎁 Daily Claimed!")
        .setDescription(`+**${DAILY} Flux** added! New balance: **${user.balance?.toLocaleString() ?? "?"}**`)
    ]});
  },
};
