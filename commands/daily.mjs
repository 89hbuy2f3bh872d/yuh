import { COLORS } from "../src/theme.mjs";

const DAILY_AMOUNT = 1_000;
const COOLDOWN_MS = 86_400_000; // 24h

// In-flight claim guards: prevent multiple simultaneous claims for the same user.
// Key = userId, value = promise of the in-flight claim operation.
const _inflight = new Map();

export default {
  name: "daily",
  aliases: ["claim"],
  description: "Claim your daily 1,000 FC.",

  async execute({ message, db, embed }) {
    const uid = message.author.id;

    // Coalesce concurrent requests from the same user
    if (_inflight.has(uid)) {
      // Wait for the in-flight operation to finish, then check the result
      await _inflight.get(uid);
    }

    let release;
    const p = new Promise(resolve => { release = resolve; });
    _inflight.set(uid, p);

    try {
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

      // Atomically credit the daily reward and update lastDaily in one operation.
      // This prevents double-claim race conditions where two rapid calls could
      // both pass the cooldown check before either writes ld.
      await db.updateBalance(uid, DAILY_AMOUNT);
      await db.setLastDaily(uid, now);

      return message.channel.send({ embeds: [
        embed(COLORS.primary)
          .setTitle("🎁 Daily Claimed")
          .setDescription(`+**${DAILY_AMOUNT.toLocaleString()} FC** added to your balance!`)
      ]});
    } finally {
      _inflight.delete(uid);
      release();
    }
  },
};
