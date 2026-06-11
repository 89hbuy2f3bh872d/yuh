import { HouseEdge } from "../src/HouseEdge.mjs";
import { COLORS } from "../src/theme.mjs";

const REELS = [
  { sym: "🍒", w: 30 },
  { sym: "🍋", w: 25 },
  { sym: "🍊", w: 20 },
  { sym: "🍇", w: 15 },
  { sym: "🔔", w: 7 },
  { sym: "⭐", w: 2 },
  { sym: "💎", w: 1 },
];

const PAYOUTS = {
  "💎": 50, "⭐": 20, "🔔": 10,
  "🍇": 5,  "🍊": 4,  "🍋": 3, "🍒": 2,
};

function spin() {
  const total = REELS.reduce((s, r) => s + r.w, 0);
  let r = Math.random() * total;
  for (const reel of REELS) {
    r -= reel.w;
    if (r <= 0) return reel.sym;
  }
  return REELS[0].sym;
}

export default {
  name: "slots",
  aliases: ["sl", "spin"],
  description: "Spin the slots. `&slots <bet>`",

  async execute({ message, args, db, embed }) {
    const uid = message.author.id;
    const bet = parseInt(args[0]);

    if (isNaN(bet) || bet <= 0) {
      return message.channel.send({ embeds: [embed(COLORS.error).setDescription("❌ e.g. `&slots 500`")] });
    }
    if (bet > 1_000_000) {
      return message.channel.send({ embeds: [embed(COLORS.error).setDescription("❌ Max bet is 1,000,000 FC.")] });
    }

    const u = await db.getUser(uid);
    if (bet > u.bal) {
      return message.channel.send({ embeds: [embed(COLORS.error).setDescription("❌ Insufficient FC.")] });
    }

    // Force loss 8% of the time regardless of spin
    const forceLoss = Math.random() < 0.08;
    const r1 = spin(), r2 = spin(), r3 = spin();
    const line = `${r1} ${r2} ${r3}`;

    const isJackpot = r1 === "💎" && r2 === "💎" && r3 === "💎";
    const isMatch = !forceLoss && r1 === r2 && r2 === r3;
    const isTwoMatch = !forceLoss && !isMatch && (r1 === r2 || r2 === r3 || r1 === r3);

    if (isJackpot) {
      const payout = bet * 50;
      await db.updateBalance(uid, payout);
      await db.recordGame(uid, true, bet + payout);
      return message.channel.send({ embeds: [
        embed(COLORS.gold)
          .setTitle("💎 JACKPOT!! 💎")
          .setDescription(`${line}\n+**${payout.toLocaleString()} FC**\n${HouseEdge.baitWin()}`)
      ]});
    }

    if (isMatch) {
      const mult = PAYOUTS[r1] ?? 2;
      const payout = Math.floor(bet * mult * 0.92); // 8% scalar
      await db.updateBalance(uid, payout);
      await db.recordGame(uid, true, bet + payout);
      return message.channel.send({ embeds: [
        embed(COLORS.primary)
          .setTitle("🎰 MATCH!")
          .setDescription(`${line}\n+**${payout.toLocaleString()} FC** (${mult}×)\n${HouseEdge.baitWin()}`)
      ]});
    }

    if (isTwoMatch) {
      const payout = Math.floor(bet * 0.5);
      await db.updateBalance(uid, payout - bet);
      await db.recordGame(uid, false, bet);
      return message.channel.send({ embeds: [
        embed(COLORS.warn)
          .setTitle("🎰 PARTIAL")
          .setDescription(`${line}\nTwo of a kind — **+${payout.toLocaleString()} FC** back.\n${HouseEdge.baitLoss()}`)
      ]});
    }

    await db.updateBalance(uid, -bet);
    await db.recordGame(uid, false, bet);
    return message.channel.send({ embeds: [
      embed(COLORS.error)
        .setTitle("🎰 NO MATCH")
        .setDescription(`${line}\n-**${bet.toLocaleString()} FC**\n${HouseEdge.baitLoss()}`)
    ]});
  },
};
