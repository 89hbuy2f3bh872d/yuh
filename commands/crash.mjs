import { HouseEdge } from "../src/HouseEdge.mjs";

export default {
  name: "crash",
  aliases: ["cr"],
  description: "Crash game. `&crash <bet> <cashout_multiplier>`",
  async execute({ message, args, db, embed, prefix }) {
    const uid = message.author.id;
    const bet = parseInt(args[0]);
    const target = parseFloat(args[1]);
    const user = await db.getUser(uid);

    if (isNaN(bet) || bet <= 0 || isNaN(target) || target < 1.01)
      return message.channel.send({ embeds: [embed(0xe74c3c).setDescription(`❌ Usage: \`${prefix}crash <bet> <cashout e.g. 2.5>\``)] });
    if (bet > user.balance)
      return message.channel.send({ embeds: [embed(0xe74c3c).setDescription("❌ Insufficient FluxCoins.")] });
    if (bet > 2_000_000)
      return message.channel.send({ embeds: [embed(0xe74c3c).setDescription("❌ Max bet is **2,000,000 FC**.")] });

    // 7% instant crash probability, then exponential curve
    const crashAt = Math.random() < 0.07 ? 1.0 : Math.max(1.0, 0.99 / Math.random());
    const roundedCrash = Math.floor(crashAt * 100) / 100;

    if (target <= roundedCrash) {
      const win = Math.floor(bet * target) - bet;
      await db.updateBalance(uid, win);
      await db.recordGame(uid, true, bet + win);
      return message.channel.send({ embeds: [
        embed(0x2ecc71).setTitle("📈 Crash — CASHED OUT!")
          .setDescription(`Cashed at **${target}x** before crash at **${roundedCrash}x**\n+**${win.toLocaleString()} FC**\n${HouseEdge.baitWin()}`)
      ]});
    } else {
      await db.updateBalance(uid, -bet);
      await db.recordGame(uid, false, bet);
      return message.channel.send({ embeds: [
        embed(0xe74c3c).setTitle("📉 Crash — BUSTED")
          .setDescription(`Crashed at **${roundedCrash}x** before your **${target}x** cashout.\n-**${bet.toLocaleString()} FC**\n${HouseEdge.baitLoss()}`)
      ]});
    }
  },
};
