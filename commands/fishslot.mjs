import crypto from "crypto";
import { COLORS } from "../src/theme.mjs";
import { HouseEdge } from "../src/HouseEdge.mjs";

const MAX_BET     = 1_000_000;
const SESSION_TTL = 10 * 60 * 1000; // 10 min to play

// Pending sessions: token → { uid, bet, channelId, ts }
export const pendingSessions = new Map();

// Sweep expired sessions every 5 min (called by index.mjs after load)
export function sweepSessions() {
  const cut = Date.now() - SESSION_TTL;
  for (const [t, s] of pendingSessions)
    if (s.ts < cut) pendingSessions.delete(t);
}

export default {
  name: "fishslot",
  aliases: ["fish", "fs"],
  description: "Play Fish Slot. `&fishslot <bet>`",

  async execute({ message, args, db, embed, config }) {
    const uid = message.author.id;
    const bet = parseInt(args[0]);

    if (isNaN(bet) || bet <= 0)
      return message.channel.send({ embeds: [embed(COLORS.error).setDescription("❌ Usage: `&fishslot <bet>`")] });

    if (bet > MAX_BET)
      return message.channel.send({ embeds: [embed(COLORS.error).setDescription(`❌ Max bet is ${MAX_BET.toLocaleString()} FC.`)] });

    const u = await db.getUser(uid);
    if (bet > u.bal)
      return message.channel.send({ embeds: [embed(COLORS.error).setDescription("❌ Not enough FC.")] });

    // Deduct bet upfront — refunded on result if needed
    await db.updateBalance(uid, -bet);

    // Generate HMAC-signed session token
    const secret = config.fishslotSecret ?? config.jwtSecret ?? "fluxer-fishslot-secret";
    const token  = crypto.randomBytes(24).toString("hex");
    const sig    = crypto.createHmac("sha256", secret).update(token).digest("hex");

    pendingSessions.set(token, {
      uid,
      bet,
      channelId: message.channel.id,
      sig,
      ts: Date.now(),
    });

    const base    = config.webBaseUrl ?? "https://www.sirgreen.online";
    const gameUrl = `${base}/fishslot/?token=${token}&bet=${bet}`;

    const row = {
      type: 1,
      components: [{
        type: 2,
        style: 5,          // LINK
        label: "🐟 Open Fish Slot",
        url: gameUrl,
      }],
    };

    // baitPlay is a nice-to-have — don't crash if HouseEdge failed to load
    const bait = typeof HouseEdge?.baitPlay === "function" ? HouseEdge.baitPlay() : "";

    await message.channel.send({
      embeds: [
        embed(COLORS.primary)
          .setTitle("🎰 Fish Slot — Bet Placed")
          .setDescription(
            `**Bet:** ${bet.toLocaleString()} FC deducted.\n` +
            `Click below to play. Your result is saved automatically when you finish.\n\n` +
            `*Session expires in 10 minutes.*` +
            (bait ? `\n\n${bait}` : "")
          )
          .setFooter({ text: `Token: ${token.slice(0, 8)}…` }),
      ],
      components: [row],
    });
  },
};
