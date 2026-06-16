import { COLORS } from "../src/theme.mjs";

const COOLDOWN_MS = 30 * 60 * 1000; // 30 min
const MIN_EARN = 80;
const MAX_EARN = 220;
const WORK_FIELD = "lw"; // stored in user document alongside ld (lastDaily)

const JOBS = [
  { emoji: "🧹", text: "swept the casino floor" },
  { emoji: "🃏", text: "shuffled cards for the dealers" },
  { emoji: "🍹", text: "served drinks at the bar" },
  { emoji: "🔧", text: "fixed a jammed slot machine" },
  { emoji: "🎰", text: "restocked the chip trays" },
  { emoji: "📋", text: "checked IDs at the door" },
  { emoji: "💡", text: "replaced burnt-out neon lights" },
  { emoji: "🚗", text: "parked cars in the valet lot" },
  { emoji: "🧼", text: "cleaned the high-roller lounge" },
  { emoji: "📦", text: "unloaded a shipment of dice" },
];

// In-flight guards: same pattern as daily.mjs
const _inflight = new Map();

export default {
  name: "work",
  aliases: ["earn", "grind"],
  description: "Earn some FC by working a shift (30 min cooldown).",

  async execute({ message, db, embed }) {
    const uid = message.author.id;

    if (_inflight.has(uid)) {
      await _inflight.get(uid);
    }

    let release;
    const p = new Promise(resolve => { release = resolve; });
    _inflight.set(uid, p);

    try {
      // Read the lw field for persistent cooldown (persists across bot restarts)
      const u = await db.getUser(uid);
      const now = Date.now();
      const last = u.lw ?? 0;
      const diff = now - last;

      if (diff < COOLDOWN_MS) {
        const remaining = COOLDOWN_MS - diff;
        const m = Math.floor(remaining / 60_000);
        const s = Math.floor((remaining % 60_000) / 1000);
        return message.channel.send({ embeds: [
          embed(COLORS.warn)
            .setDescription(`⏳ You're still on your break. Come back in **${m}m ${s}s**.`)
        ]});
      }

      const amount = Math.floor(Math.random() * (MAX_EARN - MIN_EARN + 1)) + MIN_EARN;
      const job = JOBS[Math.floor(Math.random() * JOBS.length)];

      // Atomically credit earnings and persist cooldown timestamp
      await db.updateBalance(uid, amount);
      await db._users.updateOne(
        { _id: uid },
        { $set: { [WORK_FIELD]: now } },
        { upsert: true }
      );

      const user = await db.getUser(uid);

      return message.channel.send({ embeds: [
        embed(COLORS.primary)
          .setTitle(`${job.emoji} Shift Complete`)
          .setDescription(
            `You **${job.text}** and earned **+${amount.toLocaleString()} FC**!\n` +
            `💰 Balance: **${Math.floor(user.bal).toLocaleString()} FC**`
          )
          .setFooter({ text: "Next shift available in 30 minutes." })
      ]});
    } finally {
      _inflight.delete(uid);
      release();
    }
  },
};
