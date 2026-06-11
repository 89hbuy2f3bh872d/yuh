import { HouseEdge } from "../src/HouseEdge.mjs";

export default {
  name: "coinflip",
  aliases: ["cf", "flip"],
  description: "Flip a coin. `&cf <bet> <heads|tails>`",
  async execute({ message, args, db, embed, prefix }) {
    const uid = message.author.id;
    const bet = parseInt(args[0]);
    const side = args[1]?.toLowerCase();
    const user = await db.getUser(uid);

    if (isNaN(bet) || bet <= 0 || !["heads","tails","h","t"].includes(side))
      return message.channel.send({ embeds: [embed(0xe74c3c).setDescription(`❌ Usage: \`${prefix}cf <bet> <heads|tails>\``)] });
    if (bet > user.balance)
      return message.channel.send({ embeds: [embed(0xe74c3c).setDescription("❌ Insufficient FluxCoins.")] });
    if (bet > 500_000)
      return message.channel.send({ embeds: [embed(0xe74c3c).setDescription("❌ Max bet is **500,000 FC**.")] });

    const win = Math.random() < 0.475;
    const result = win === (["heads","h"].includes(side)) ? "heads" : "tails";
    const correct = (["heads","h"].includes(side) && result === "heads") || (["tails","t"].includes(side) && result === "tails");
    const coin = result === "heads" ? "🪙" : "🌑";

    if (correct) {
      await db.updateBalance(uid, bet);
      await db.recordGame(uid, true, bet * 2);
      return message.channel.send({ embeds: [embed(0x2ecc71).setTitle(`${coin} Coin Flip — WIN!`).setDescription(`Landed **${result}**! +**${bet.toLocaleString()} FC**\n${HouseEdge.baitWin()}`)] });
    } else {
      await db.updateBalance(uid, -bet);
      await db.recordGame(uid, false, bet);
      return message.channel.send({ embeds: [embed(0xe74c3c).setTitle(`${coin} Coin Flip — LOSS`).setDescription(`Landed **${result}**. -**${bet.toLocaleString()} FC**\n${HouseEdge.baitLoss()}`)] });
    }
  },
};
