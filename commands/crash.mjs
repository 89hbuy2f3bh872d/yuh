import { HouseEdge } from "../src/HouseEdge.mjs";

// Crash multiplier: house crashes 7% of the time instantly, rest lognormal
function generateCrash() {
  if (Math.random() < 0.07) return 1.0; // instant house win
  const r = Math.random();
  return Math.max(1.0, parseFloat((1 / (1 - r * 0.93)).toFixed(2)));
}

const pending = new Map();

export default {
  name: "crash",
  description: "Crash game. !crash <bet> <cashout_multiplier>",
  async execute({ message, args, db, embed }) {
    const user = await db.getUser(message.author.id);
    const bet  = parseInt(args[0]);
    const cashout = parseFloat(args[1]);

    if (isNaN(bet) || bet <= 0)        return message.channel.send({ embeds: [embed(0xe74c3c).setDescription("❌ Provide a valid bet.")] });
    if (bet > user.balance)            return message.channel.send({ embeds: [embed(0xe74c3c).setDescription("❌ Insufficient balance.")] });
    if (bet > 2_000_000)               return message.channel.send({ embeds: [embed(0xe74c3c).setDescription("❌ Max bet is **2,000,000 Flux**.")] });
    if (isNaN(cashout) || cashout < 1.01) return message.channel.send({ embeds: [embed(0xe74c3c).setDescription("❌ Cashout must be ≥ 1.01.")] });

    const crash = generateCrash();
    const won   = cashout <= crash;

    if (won) {
      const profit = Math.floor(bet * cashout) - bet;
      await db.updateBalance(message.author.id, profit);
      await db.recordGame(message.author.id, true, bet + profit);
      message.channel.send({ embeds: [
        embed(0x2ecc71).setTitle("🚀 Crash — CASHED OUT!")
          .setDescription(
            `Crashed at **${crash}x** | Your cashout: **${cashout}x**\n` +
            `+**${profit.toLocaleString()} Flux**\n${HouseEdge.baitWin()}`
          )
      ]});
    } else {
      await db.updateBalance(message.author.id, -bet);
      await db.recordGame(message.author.id, false, bet);
      message.channel.send({ embeds: [
        embed(0xe74c3c).setTitle("💥 Crash — CRASHED!")
          .setDescription(
            `Crashed at **${crash}x** before your **${cashout}x** cashout\n` +
            `-**${bet.toLocaleString()} Flux**\n${HouseEdge.baitLoss()}`
          )
      ]});
    }
  },
};
