import { HouseEdge } from "../src/HouseEdge.mjs";

const RED   = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
const BLACK = new Set([2,4,6,8,10,11,13,15,17,20,22,24,26,28,29,31,33,35]);

function spin() { return Math.floor(Math.random() * 37); } // 0-36 European

export default {
  name: "roulette",
  aliases: ["rl"],
  description: "Roulette. !roulette <red|black|odd|even|1-36> <bet>",
  async execute({ message, args, db, embed }) {
    const user = await db.getUser(message.author.id);
    const pick = args[0]?.toLowerCase();
    const bet  = parseInt(args[1]);

    if (!pick) return message.channel.send({ embeds: [embed(0xe74c3c).setDescription("❌ Pick: `red`, `black`, `odd`, `even`, or a number 1-36.")] });
    if (isNaN(bet) || bet <= 0) return message.channel.send({ embeds: [embed(0xe74c3c).setDescription("❌ Provide a valid bet.")] });
    if (bet > user.balance)     return message.channel.send({ embeds: [embed(0xe74c3c).setDescription("❌ Insufficient balance.")] });
    if (bet > 750_000)          return message.channel.send({ embeds: [embed(0xe74c3c).setDescription("❌ Max bet is **750,000 Flux**.")] });

    const num = spin();
    const color = num === 0 ? "green" : RED.has(num) ? "red" : "black";
    const icon  = color === "green" ? "🟢" : color === "red" ? "🔴" : "⚫";

    let multiplier = 0;
    const pickNum = parseInt(pick);
    if (!isNaN(pickNum) && pickNum >= 1 && pickNum <= 36) {
      if (num === pickNum) multiplier = 35;
    } else if (pick === "red"   && color === "red")   multiplier = 1;
    else if (pick === "black" && color === "black") multiplier = 1;
    else if (pick === "odd"   && num % 2 !== 0 && num !== 0) multiplier = 1;
    else if (pick === "even"  && num % 2 === 0 && num !== 0) multiplier = 1;

    if (multiplier > 0) {
      const profit = Math.floor(bet * multiplier);
      await db.updateBalance(message.author.id, profit);
      await db.recordGame(message.author.id, true, bet + profit);
      message.channel.send({ embeds: [
        embed(0x2ecc71).setTitle(`🎡 Roulette — WIN! ${icon} ${num}`)
          .setDescription(`+**${profit.toLocaleString()} Flux**\n${HouseEdge.baitWin()}`)
      ]});
    } else {
      await db.updateBalance(message.author.id, -bet);
      await db.recordGame(message.author.id, false, bet);
      message.channel.send({ embeds: [
        embed(0xe74c3c).setTitle(`🎡 Roulette — LOSS ${icon} ${num}`)
          .setDescription(`-**${bet.toLocaleString()} Flux**\n${HouseEdge.baitLoss()}`)
      ]});
    }
  },
};
