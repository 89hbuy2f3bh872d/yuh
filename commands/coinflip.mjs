import { HouseEdge } from "../src/HouseEdge.mjs";
import { COLORS } from "../src/theme.mjs";

export default {
  name: "coinflip",
  aliases: ["cf", "flip"],
  description: "Flip a coin. `&cf <heads|tails> <bet>`",

  async execute({ message, args, db, embed }) {
    const uid = message.author.id;
    const side = args[0]?.toLowerCase();
    const bet = parseInt(args[1]);

    if (!["heads","tails","h","t"].includes(side)) {
      return message.channel.send({ embeds: [embed(COLORS.error).setDescription("❌ Choose `heads` or `tails`. e.g. `&cf heads 500`")] });
    }
    if (isNaN(bet) || bet <= 0) {
      return message.channel.send({ embeds: [embed(COLORS.error).setDescription("❌ Invalid bet amount.")] });
    }
    if (bet > 500_000) {
      return message.channel.send({ embeds: [embed(COLORS.error).setDescription("❌ Max bet is 500,000 FC.")] });
    }

    const u = await db.getUser(uid);
    if (bet > u.bal) {
      return message.channel.send({ embeds: [embed(COLORS.error).setDescription("❌ Insufficient FC.")] });
    }

    // 95% RTP — house wins on 5% of flips regardless
    const houseWins = Math.random() < 0.05;
    const result = Math.random() < 0.5 ? "heads" : "tails";
    const chosen = ["h","heads"].includes(side) ? "heads" : "tails";
    const coin = chosen === "heads" ? "🟡" : "⚪";
    const correct = !houseWins && result === chosen;

    if (correct) {
      await db.updateBalance(uid, bet);
      await db.recordGame(uid, true, bet * 2);
      return message.channel.send({ embeds: [
        embed(COLORS.primary)
          .setTitle(`${coin} WIN!`)
          .setDescription(`Landed **${result}**! +**${bet.toLocaleString()} FC**
${HouseEdge.baitWin()}`)
      ]});
    }

    await db.updateBalance(uid, -bet);
    await db.recordGame(uid, false, bet);
    return message.channel.send({ embeds: [
      embed(COLORS.error)
        .setTitle(`${coin} LOSS`)
        .setDescription(`Landed **${result}**, you picked **${chosen}**. -**${bet.toLocaleString()} FC**
${HouseEdge.baitLoss()}`)
    ]});
  },
};
