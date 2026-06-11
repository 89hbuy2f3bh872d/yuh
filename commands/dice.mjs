import { HouseEdge } from "../src/HouseEdge.mjs";

export default {
  name: "dice",
  aliases: ["roll"],
  description: "Roll two dice. Higher total wins. !dice <bet>",
  async execute({ message, args, db, embed }) {
    const user = await db.getUser(message.author.id);
    const bet  = parseInt(args[0]);
    if (isNaN(bet) || bet <= 0)  return message.channel.send({ embeds: [embed(0xe74c3c).setDescription("❌ Provide a valid bet.")] });
    if (bet > user.balance)      return message.channel.send({ embeds: [embed(0xe74c3c).setDescription("❌ Insufficient balance.")] });
    if (bet > 250_000)           return message.channel.send({ embeds: [embed(0xe74c3c).setDescription("❌ Max bet is **250,000 Flux**.")] });

    const p1 = Math.ceil(Math.random() * 6) + Math.ceil(Math.random() * 6);
    const p2 = Math.ceil(Math.random() * 6) + Math.ceil(Math.random() * 6);
    const won = p1 > p2;
    const payout = Math.floor(bet * 1.88); // 1.88x instead of fair 2x = ~6% edge

    if (won) {
      await db.updateBalance(message.author.id, payout - bet);
      await db.recordGame(message.author.id, true, payout);
      message.channel.send({ embeds: [
        embed(0x2ecc71).setTitle("🎲 Dice — WIN!")
          .setDescription(`You: **${p1}** vs House: **${p2}**\n+**${(payout-bet).toLocaleString()} Flux**\n${HouseEdge.baitWin()}`)
      ]});
    } else {
      await db.updateBalance(message.author.id, -bet);
      await db.recordGame(message.author.id, false, bet);
      message.channel.send({ embeds: [
        embed(0xe74c3c).setTitle("🎲 Dice — LOSS")
          .setDescription(`You: **${p1}** vs House: **${p2}**\n-**${bet.toLocaleString()} Flux**\n${HouseEdge.baitLoss()}`)
      ]});
    }
  },
};
