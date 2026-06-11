import { HouseEdge } from "../src/HouseEdge.mjs";
import { COLORS } from "../src/theme.mjs";

function genMultiplier() {
  // 7% instant crash, otherwise exponential distribution favouring house
  if (Math.random() < 0.07) return 0;
  const r = Math.random();
  return Math.max(1.01, +(1 / (1 - r * 0.93)).toFixed(2));
}

export default {
  name: "crash",
  aliases: ["c"],
  description: "Crash game. `&crash <bet> <cashout_at>`",

  async execute({ message, args, db, embed }) {
    const uid = message.author.id;
    const bet = parseInt(args[0]);
    const target = parseFloat(args[1]);

    if (isNaN(bet) || bet <= 0) {
      return message.channel.send({ embeds: [embed(COLORS.error).setDescription("❌ e.g. `&crash 1000 2.5`")] });
    }
    if (isNaN(target) || target < 1.01) {
      return message.channel.send({ embeds: [embed(COLORS.error).setDescription("❌ Cashout must be ≥ 1.01×.")] });
    }
    if (bet > 2_000_000) {
      return message.channel.send({ embeds: [embed(COLORS.error).setDescription("❌ Max bet is 2,000,000 FC.")] });
    }

    const u = await db.getUser(uid);
    if (bet > u.bal) {
      return message.channel.send({ embeds: [embed(COLORS.error).setDescription("❌ Insufficient FC.")] });
    }

    const mult = genMultiplier();
    const crashed = mult === 0 || mult < target;

    if (crashed) {
      await db.updateBalance(uid, -bet);
      await db.recordGame(uid, false, bet);
      return message.channel.send({ embeds: [
        embed(COLORS.error)
          .setTitle("💥 CRASH")
          .setDescription(`Crashed at **${mult === 0 ? "0.00" : mult}×** (target ${target}×).
-**${bet.toLocaleString()} FC**
${HouseEdge.baitLoss()}`)
      ]});
    }

    const payout = Math.floor(bet * target - bet);
    await db.updateBalance(uid, payout);
    await db.recordGame(uid, true, bet + payout);
    return message.channel.send({ embeds: [
      embed(COLORS.primary)
        .setTitle("🚀 CASHED OUT")
        .setDescription(`Reached **${mult}×**, cashed at **${target}×**.
+**${payout.toLocaleString()} FC**
${HouseEdge.baitWin()}`)
    ]});
  },
};
