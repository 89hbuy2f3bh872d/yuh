import { HouseEdge } from "../src/HouseEdge.mjs";
import { COLORS } from "../src/theme.mjs";

const FACES = ["⚀","⚁","⚂","⚃","⚄","⚅"];

export default {
  name: "dice",
  aliases: ["roll"],
  description: "Roll dice over/under. `&dice <over|under> <1-6> <bet>`",

  async execute({ message, args, db, embed }) {
    const uid = message.author.id;
    const dir = args[0]?.toLowerCase();
    const num = parseInt(args[1]);
    const bet = parseInt(args[2]);

    if (!["over","under","o","u"].includes(dir)) {
      return message.channel.send({ embeds: [embed(COLORS.error).setDescription("❌ Choose `over` or `under`. e.g. `&dice over 3 500`")] });
    }
    if (isNaN(num) || num < 1 || num > 6) {
      return message.channel.send({ embeds: [embed(COLORS.error).setDescription("❌ Number must be 1–6.")] });
    }
    if (isNaN(bet) || bet <= 0) {
      return message.channel.send({ embeds: [embed(COLORS.error).setDescription("❌ Invalid bet.")] });
    }
    if (bet > 250_000) {
      return message.channel.send({ embeds: [embed(COLORS.error).setDescription("❌ Max bet is 250,000 FC.")] });
    }

    const u = await db.getUser(uid);
    if (bet > u.bal) {
      return message.channel.send({ embeds: [embed(COLORS.error).setDescription("❌ Insufficient FC.")] });
    }

    const roll = Math.ceil(Math.random() * 6);
    const isOver = ["over","o"].includes(dir);
    const won = isOver ? roll > num : roll < num;

    if (won) {
      // 1.88x payout (house edge ~6%)
      const payout = Math.floor(bet * 0.88);
      await db.updateBalance(uid, payout);
      await db.recordGame(uid, true, bet + payout);
      return message.channel.send({ embeds: [
        embed(COLORS.primary)
          .setTitle(`${FACES[roll-1]} WIN!`)
          .setDescription(`Rolled **${roll}** (${isOver ? "over" : "under"} ${num}). +**${payout.toLocaleString()} FC**
${HouseEdge.baitWin()}`)
      ]});
    }

    await db.updateBalance(uid, -bet);
    await db.recordGame(uid, false, bet);
    return message.channel.send({ embeds: [
      embed(COLORS.error)
        .setTitle(`${FACES[roll-1]} LOSS`)
        .setDescription(`Rolled **${roll}** (needed ${isOver ? "over" : "under"} ${num}). -**${bet.toLocaleString()} FC**
${HouseEdge.baitLoss()}`)
    ]});
  },
};
