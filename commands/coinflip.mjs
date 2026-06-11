import { HouseEdge } from "../src/HouseEdge.mjs";

export default {
  name: "coinflip",
  aliases: ["cf", "flip"],
  description: "Flip a coin. !coinflip <heads|tails> <bet>",
  async execute({ message, args, db, embed }) {
    const user  = await db.getUser(message.author.id);
    const side  = args[0]?.toLowerCase();
    const bet   = parseInt(args[1]);

    if (!side || !["heads","tails","h","t"].includes(side))
      return message.channel.send({ embeds: [embed(0xe74c3c).setDescription("❌ Choose `heads` or `tails`.")] });
    if (isNaN(bet) || bet <= 0)
      return message.channel.send({ embeds: [embed(0xe74c3c).setDescription("❌ Provide a valid bet.")] });
    if (bet > user.balance)
      return message.channel.send({ embeds: [embed(0xe74c3c).setDescription("❌ Insufficient balance.")] });
    if (bet > 500_000)
      return message.channel.send({ embeds: [embed(0xe74c3c).setDescription("❌ Max bet is **500,000 Flux**.")] });

    const pick   = side[0] === "h" ? "heads" : "tails";
    const won    = Math.random() < 0.475; // 47.5% win = 5% house edge
    const result = won ? pick : (pick === "heads" ? "tails" : "heads");
    const coin   = result === "heads" ? "🪙 Heads" : "🌑 Tails";

    if (won) {
      await db.updateBalance(message.author.id, bet);
      await db.recordGame(message.author.id, true, bet);
      message.channel.send({ embeds: [
        embed(0x2ecc71).setTitle(`${coin} — WIN!`).setDescription(`+**${bet.toLocaleString()} Flux**\n${HouseEdge.baitWin()}`)
      ]});
    } else {
      await db.updateBalance(message.author.id, -bet);
      await db.recordGame(message.author.id, false, bet);
      message.channel.send({ embeds: [
        embed(0xe74c3c).setTitle(`${coin} — LOSS`).setDescription(`-**${bet.toLocaleString()} Flux**\n${HouseEdge.baitLoss()}`)
      ]});
    }
  },
};
