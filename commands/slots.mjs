import { COLORS } from "../src/theme.mjs";
import { HouseEdge } from "../src/HouseEdge.mjs";

// RTP ~90%: Weighted reel — most common symbols pay nothing, rare symbols pay big.
// Net RTP across all combinations is ~0.90.

const MIN_BET = 10;

// [symbol, weight, payout multiplier for 3-of-a-kind]
const REELS = [
  { s: "🍋", w: 30, p: 1.5  },
  { s: "🍊", w: 28, p: 1.5  },
  { s: "🍒", w: 22, p: 2.0  },
  { s: "🔔", w: 10, p: 4.0  },
  { s: "💎", w: 6,  p: 10.0 },
  { s: "🎰", w: 3,  p: 25.0 },
  { s: "👑", w: 1,  p: 75.0 },
];

const TOTAL_WEIGHT = REELS.reduce((s, r) => s + r.w, 0);

function spinReel() {
  let r = Math.random() * TOTAL_WEIGHT;
  for (const reel of REELS) {
    r -= reel.w;
    if (r <= 0) return reel;
  }
  return REELS[0];
}

export default {
  name: "slots",
  aliases: ["slot", "s"],
  description: "Pull the slot machine. `&slots <bet>`",

  async execute({ message, args, db, embed }) {
    const uid = message.author.id;
    const betAmt = parseInt(args[0], 10);

    if (!betAmt || betAmt < MIN_BET) {
      return message.channel.send({ embeds: [
        embed(COLORS.warn).setDescription(`⚠️ Usage: \`&slots <bet>\` (min ${MIN_BET} FC).`)
      ]});
    }

    // Atomically deduct the bet upfront
    const deducted = await db.atomicDeduct(uid, -betAmt);
    if (!deducted) {
      return message.channel.send({ embeds: [
        embed(COLORS.error).setDescription("❌ Not enough FC. Try `&work` to earn some.")
      ]});
    }

    const r1 = spinReel(), r2 = spinReel(), r3 = spinReel();
    const display = `${r1.s} ${r2.s} ${r3.s}`;

    let multiplier = 0;
    let resultText = "";

    if (r1.s === r2.s && r2.s === r3.s) {
      // Three of a kind
      multiplier = r1.p;
      resultText = `🎉 **THREE ${r1.s}!** — ${multiplier}x`;
    } else if (r1.s === r2.s || r2.s === r3.s || r1.s === r3.s) {
      // Two of a kind — pays 0.5x the symbol's multiplier
      const paired = r1.s === r2.s ? r1 : (r2.s === r3.s ? r2 : r1);
      multiplier = paired.p * 0.4;
      if (multiplier < 0.5) multiplier = 0; // tiny pairs pay nothing
      resultText = multiplier > 0 ? `Two ${paired.s} — ${multiplier.toFixed(1)}x` : `Two ${paired.s} — no payout`;
    } else {
      resultText = "No match";
    }

    const winAmt = multiplier > 0 ? Math.floor(betAmt * multiplier) : 0;
    // atomicDeduct already took the bet; net change = winAmt
    if (winAmt > 0) await db.updateBalance(uid, winAmt);
    const won = winAmt > 0;
    await db.recordGame(uid, won, betAmt);
    const u2 = await db.getUser(uid);

    return message.channel.send({ embeds: [
      embed(won ? COLORS.primary : COLORS.error)
        .setTitle(`🎰 Slots — ${display}`)
        .setDescription(
          `Bet: **${betAmt.toLocaleString()} FC**\n${resultText}\n\n` +
          (won
            ? `✅ Won **+${winAmt.toLocaleString()} FC**!\n${HouseEdge.baitWin()}`
            : `❌ Lost **${betAmt.toLocaleString()} FC**\n${HouseEdge.baitLoss()}`) +
          `\n\n💰 Balance: **${Math.floor(u2.bal).toLocaleString()} FC**`
        )
    ]});
  },
};
