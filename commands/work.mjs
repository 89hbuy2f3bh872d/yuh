import { COLORS } from "../src/theme.mjs";

const COOLDOWN_MS = 30 * 60 * 1000; // 30 min cooldown between work claims
const MIN_EARN    = 80;
const MAX_EARN    = 220;
const FL_LIST_URL = "https://fluxerlist.com/api/v1";
const VOTE_TTL_MS = 5 * 60 * 1000;  // cache FluxerList vote check for 5 min

// In-memory vote cache: uid -> { voted: bool, cachedAt: ms }
const _voteCache = new Map();

// In-flight guards — coalesce concurrent calls for the same user
const _inflight = new Map();

/**
 * Check whether a Discord userId has voted for the bot on FluxerList.
 * Results are cached per-UID for VOTE_TTL_MS to avoid hammering the API.
 */
async function hasVoted(serverId, userId, apiKey) {
  const now    = Date.now();
  const cached = _voteCache.get(userId);

  if (cached && now - cached.cachedAt < VOTE_TTL_MS) return cached.voted;

  try {
    const url = `${FL_LIST_URL}/servers/${botId}/voters`;
    const { default: fetch } = await import("undici").catch(() => ({ default: globalThis.fetch }));
    const fn = typeof fetch === "function" ? fetch : (u, o) => import("undici").then(m => m.default(u, o));
    const r = await fn(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`FluxerList ${r.status}`);
    const data = await r.json();

    // The API returns { voters: [...], page, total }.
    // Each voter object typically has `id` or `userId`.
    const voters = Array.isArray(data?.voters) ? data.voters : [];
    const voted  = voters.some(v => String(v?.id ?? v?.userId ?? v) === String(userId));

    _voteCache.set(userId, { voted, cachedAt: now });
    return voted;
  } catch (e) {
    console.error("[FluxerList] vote check failed:", e?.message);
    // Fail open: if the API is unreachable, don't block legitimate voters
    // who have a cached entry from a previous successful call.
    if (cached) return cached.voted;
    return false;
  }
}

// Prune stale cache entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [uid, entry] of _voteCache) {
    if (now - entry.cachedAt > VOTE_TTL_MS) _voteCache.delete(uid);
  }
}, 10 * 60 * 1000);

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

export default {
  name: "work",
  aliases: ["earn", "grind"],
  description: "Earn FC by working a shift. Requires voting for the bot on FluxerList.",

  async execute({ message, db, embed, config }) {
    const uid    = message.author.id;
    const apiKey = config?.fluxerListApiKey;
    const serverId = config?.fluxerListServerId;

    // ── FluxerList voter gate ─────────────────────────────────────────────────
    if (apiKey && serverId) {
      const voted = await hasVoted(serverId, uid, apiKey);
      if (!voted) {
        return message.channel.send({ embeds: [
          embed(COLORS.warn)
            .setDescription(
              "🗳️  **Vote to unlock work!**\n" +
              "Vote for the server on [FluxerList](https://fluxerlist.com/servers/fabrikken) to earn FC.\n" +
              "Then come back and run `&work` again."
            )
        ]});
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Coalesce concurrent requests from the same user
    if (_inflight.has(uid)) {
      await _inflight.get(uid);
    }

    let release;
    const p = new Promise(resolve => { release = resolve; });
    _inflight.set(uid, p);

    try {
      const u    = await db.getUser(uid);
      const now  = Date.now();
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
      const job    = JOBS[Math.floor(Math.random() * JOBS.length)];

      // Atomically credit earnings and persist cooldown timestamp
      await db.updateBalance(uid, amount);
      await db.setLastWork(uid, now); // fixed: use public DB method instead of _users

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
