import { HouseEdge } from "../src/HouseEdge.mjs";

export default {
  name: "dice",
  aliases: ["roll"],
  description: "Roll dice. `&dice <bet> <1-6>` — guess the number.",
  async execute({ message, args, db, embed, prefix }) {
    const uid = message.author.id;
    const bet = parseInt(args[0]);
    const guess = parseInt(args[1]);
    const user = await db.getUser(uid);

    if (isNaN(bet) || bet <= 0 || isNaN(guess) || guess < 1 || guess > 6)
      return message.channel.send({ embeds: [embed(0xe74c3c).setDescription(`❌ Usage: \`${prefix}dice <bet> <1-6>\``)] });
    if (bet > user.balance)
      return message.channel.send({ embeds: [embed(0xe74c3c).setDescription("❌ Insufficient FluxCoins.")] });
    if (bet > 250_000)
      return message.channel.send({ embeds: [embed(0xe74c3c).setDescription("❌ Max bet is **250,000 FC**.")] });

    const roll = Math.ceil(Math.random() * 6);
    if (roll === guess) {
      const win = Math.floor(bet * 1.88);
      await db.updateBalance(uid, win);
      await db.recordGame(uid, true, bet + win);
      return message.channel.send({ embeds: [embed(0x2ecc71).setTitle("🎲 Dice — WIN!").setDescription(`Rolled **${roll}** — you guessed it!\n+**${win.toLocaleString()} FC**\n${HouseEdge.baitWin()}`)] });
    } else {
      await db.updateBalance(uid, -bet);
      await db.recordGame(uid, false, bet);
      return message.channel.send({ embeds: [embed(0xe74c3c).setTitle("🎲 Dice — MISS").setDescription(`Rolled **${roll}**, you guessed **${guess}**.\n-**${bet.toLocaleString()} FC**\n${HouseEdge.baitLoss()}`)] });
    }
  },
};
