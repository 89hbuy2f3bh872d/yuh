import { HouseEdge } from "../src/HouseEdge.mjs";

const SYMBOLS = ["🍒", "🍋", "🍊", "🍇", "💎", "7️⃣"];
const WEIGHTS  = [30,   25,   20,   15,   7,   3];
const TOTAL    = WEIGHTS.reduce((a, b) => a + b, 0);

function spin() {
  let r = Math.random() * TOTAL;
  for (let i = 0; i < SYMBOLS.length; i++) {
    r -= WEIGHTS[i];
    if (r <= 0) return SYMBOLS[i];
  }
  return SYMBOLS[0];
}

const PAYOUTS = { "7️⃣": 10, "💎": 7, "🍇": 4, "🍊": 3, "🍋": 2, "🍒": 1.5 };
const RTP = 0.92;

export default {
  name: "slots",
  description: "Spin the slots. !slots <bet>",
  async execute({ message, args, db, embed }) {
    const user = await db.getUser(message.author.id);
    const bet  = parseInt(args[0]);
    if (isNaN(bet) || bet <= 0)  return message.channel.send({ embeds: [embed(0xe74c3c).setDescription("❌ Provide a valid bet.")] });
    if (bet > user.balance)      return message.channel.send({ embeds: [embed(0xe74c3c).setDescription("❌ Insufficient balance.")] });
    if (bet > 1_000_000)         return message.channel.send({ embeds: [embed(0xe74c3c).setDescription("❌ Max bet is **1,000,000 Flux**.")] });

    const reels = [spin(), spin(), spin()];
    const display = reels.join(" | ");

    let won = false;
    let payout = 0;

    if (reels[0] === reels[1] && reels[1] === reels[2]) {
      payout = Math.floor(bet * PAYOUTS[reels[0]] * RTP);
      won = true;
    } else if (reels[0] === reels[1] || reels[1] === reels[2]) {
      payout = Math.floor(bet * 0.5);
      won = true;
    }

    if (won) {
      const delta = payout - bet;
      await db.updateBalance(message.author.id, delta);
      await db.recordGame(message.author.id, true, payout);
      message.channel.send({ embeds: [
        embed(0x2ecc71)
          .setTitle("🎰 Slots — WIN!")
          .setDescription(`${display}\n\n+**${payout.toLocaleString()} Flux**\n${HouseEdge.baitWin()}`)
      ]});
    } else {
      await db.updateBalance(message.author.id, -bet);
      await db.recordGame(message.author.id, false, bet);
      message.channel.send({ embeds: [
        embed(0xe74c3c)
          .setTitle("🎰 Slots — LOSS")
          .setDescription(`${display}\n\n-**${bet.toLocaleString()} Flux**\n${HouseEdge.baitLoss()}`)
      ]});
    }
  },
};
