import { COLORS } from "../src/theme.mjs";
import { HouseEdge } from "../src/HouseEdge.mjs";

// RTP ~90%: multiplier distribution is aggressively weighted towards early crashes.
// P(crash at X) = 0.90 / X^2  — median crash is around 1.10x.

const MIN_BET = 10;

// Active games: uid -> { bet, startedAt, crashAt }
const _active = new Map();
const CASHOUT_WORDS = new Set(["cashout", "cash", "out", "stop", "take"]);

function generateMultiplier() {
  // House-weighted crash multiplier: ~55% chance of crashing before 1.5x
  const r = Math.random();
  if (r < 0.35) return (1 + Math.random() * 0.10).toFixed(2); // 1.00–1.10
  if (r < 0.60) return (1.10 + Math.random() * 0.40).toFixed(2); // 1.10–1.50
  if (r < 0.78) return (1.50 + Math.random() * 1.00).toFixed(2); // 1.50–2.50
  if (r < 0.90) return (2.50 + Math.random() * 2.50).toFixed(2); // 2.50–5.00
  if (r < 0.97) return (5.00 + Math.random() * 5.00).toFixed(2); // 5.00–10.00
  return (10 + Math.random() * 40).toFixed(2);                    // 10x–50x (rare)
}

const AUTO_RESOLVE_MS = 30_000;
const GAME_TTL_MS     = 60_000; // 1-minute expiry

export default {
  name: "crash",
  aliases: ["rocket"],
  description: "Bet on a rising multiplier. Cash out before it crashes! `&crash <bet>`",

  async execute({ message, args, db, embed, prefix }) {
    const uid = message.author.id;
    const now = Date.now();

    // --- Cash out ---
    if (_active.has(uid) && CASHOUT_WORDS.has(args[0]?.toLowerCase())) {
      const g = _active.get(uid);

      // Reject stale game
      if (g.startedAt < now - GAME_TTL_MS) {
        _active.delete(uid);
        return message.channel.send({ embeds: [
          embed(COLORS.warn).setDescription("⚠️ Game expired. Start a new one with `&crash <bet>`.")
        ]});
      }

      const elapsed = (now - g.startedAt) / 1000;
      const cashedAt = Math.max(1.01, 1 + elapsed * 0.35);
      const crashAt  = parseFloat(g.crashAt);

      if (cashedAt >= crashAt) {
        // Already crashed
        _active.delete(uid);
        await db.atomicGame(uid, g.bet, 0);
        const u2 = await db.getUser(uid);
        return message.channel.send({ embeds: [
          embed(COLORS.error)
            .setTitle("💥 Too Late! Already Crashed")
            .setDescription(
              `Crashed at **${crashAt}x** — you tried to cash out at **${cashedAt.toFixed(2)}x**\n` +
              `Lost **${g.bet.toLocaleString()} FC**\n${HouseEdge.baitLoss()}` +
              `\n💰 Balance: **${Math.floor(u2.bal).toLocaleString()} FC**`
            )
        ]});
      }

      _active.delete(uid);
      const won = Math.floor(g.bet * cashedAt);
      // Use atomicGame: bet was already deducted on game start, so net change = won
      await db.updateBalance(uid, won);
      await db.recordGame(uid, true, won);
      const u2 = await db.getUser(uid);
      return message.channel.send({ embeds: [
        embed(COLORS.primary)
          .setTitle(`🚀 Cashed Out at ${cashedAt.toFixed(2)}x!`)
          .setDescription(
            `You cashed out **${g.bet.toLocaleString()} FC** at **${cashedAt.toFixed(2)}x** → **${won.toLocaleString()} FC**\n` +
            `Net: **+${(won - g.bet).toLocaleString()} FC** ${HouseEdge.baitWin()}` +
            `\n💰 Balance: **${Math.floor(u2.bal).toLocaleString()} FC**`
          )
      ]});
    }

    // --- Already in game ---
    if (_active.has(uid)) {
      const g = _active.get(uid);
      if (g.startedAt >= now - GAME_TTL_MS) {
        const elapsed = (now - g.startedAt) / 1000;
        const cur = Math.max(1.01, 1 + elapsed * 0.35);
        return message.channel.send({ embeds: [
          embed(COLORS.warn)
            .setDescription(`🚀 Currently at **${cur.toFixed(2)}x** — type \`${prefix}crash cashout\` to cash out!`)
        ]});
      }
      // Expired game — clean up
      _active.delete(uid);
    }

    // --- New game ---
    const betAmt = parseInt(args[0], 10);
    if (!betAmt || betAmt < MIN_BET) {
      return message.channel.send({ embeds: [
        embed(COLORS.warn).setDescription(`⚠️ Usage: \`${prefix}crash <bet>\` (min ${MIN_BET} FC). Cash out with \`${prefix}crash cashout\`.`)
      ]});
    }

    // Atomically deduct the bet upfront
    const deducted = await db.atomicDeduct(uid, -betAmt);
    if (!deducted) {
      return message.channel.send({ embeds: [
        embed(COLORS.error).setDescription("❌ Not enough FC. Try `&work` to earn some.")
      ]});
    }

    const startedAt = now;
    const crashAt  = generateMultiplier();
    _active.set(uid, { bet: betAmt, startedAt, crashAt });

    // Auto-resolve after 30 seconds — use uid stored in closure so the timeout
    // always resolves the correct user even if the same user starts multiple games
    const autoResolveUid = uid;
    const autoResolveBet = betAmt;
    const autoResolveCrash = crashAt;
    const autoResolveStarted = startedAt;
    const autoResolveMsg = message;

    setTimeout(async () => {
      if (!_active.has(autoResolveUid)) return;
      // Only resolve if this is the same game session (same start time)
      const g = _active.get(autoResolveUid);
      if (!g || g.startedAt !== autoResolveStarted) return;
      _active.delete(autoResolveUid);
      // bet was already deducted; record loss
      await db.recordGame(autoResolveUid, false, autoResolveBet).catch(() => {});
      autoResolveMsg.channel.send({ embeds: [
        embed(COLORS.error)
          .setTitle(`💥 Crashed at ${autoResolveCrash}x!`)
          .setDescription(
            `<@${autoResolveUid}> — The rocket crashed at **${autoResolveCrash}x** and you didn't cash out.\n` +
            `Lost **${autoResolveBet.toLocaleString()} FC**\n${HouseEdge.baitLoss()}`
          )
      ]}).catch(() => {});
    }, AUTO_RESOLVE_MS);

    return message.channel.send({ embeds: [
      embed(COLORS.primary)
        .setTitle("🚀 Crash — Rocket Launched!")
        .setDescription(
          `Bet: **${betAmt.toLocaleString()} FC**\n\n` +
          `The multiplier is climbing from **1.00x**...\n` +
          `Type \`${prefix}crash cashout\` to cash out before it crashes!\n\n` +
          `⚠️ Auto-resolves in 30 seconds.`
        )
    ]});
  },
};
