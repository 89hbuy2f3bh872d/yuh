import { HouseEdge } from "../src/HouseEdge.mjs";

const REELS = ["🍒","🍋","🍊","🍇","💎","7️⃣","🔔","⭐"];
const WEIGHTS = [30, 25, 20, 15, 5, 3, 1, 1]; // sum = 100
const PAYOUTS = { "🍒":1.5, "🍋":1.8, "🍊":2.2, "🍇":2.5, "💎":5, "7️⃣":8, "🔔":6, "⭐":4 };

function spin() {
  const total = WEIGHTS.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < REELS.length; i++) {
    r -= WEIGHTS[i];
    if (r <= 0) return REELS[i];
  }
  return REELS[0];
}

export default {
  name: "slots",
  aliases: ["sl", "slot"],
  description: "Spin the slots. `&slots <bet>`",
  async execute({ message, args, db, embed, prefix }) {
    const uid = message.author.id;
    const bet = parseInt(args[0]);
    const user = await db.getUser(uid);

    if (isNaN(bet) || bet <= 0)
      return message.channel.send({ embeds: [embed(0xe74c3c).setDescription(`❌ Usage: \`${prefix}slots <bet>\``)] });
    if (bet > user.balance)
      return message.channel.send({ embeds: [embed(0xe74c3c).setDescription("❌ Insufficient FluxCoins.")] });
    if (bet > 1_000_000)
      return message.channel.send({ embeds: [embed(0xe74c3c).setDescription("❌ Max bet is **1,000,000 FC**.")] });

    const reels = [spin(), spin(), spin()];
    const display = reels.join(" | ");
    const [a, b, c] = reels;

    if (a === b && b === c) {
      const mult = PAYOUTS[a] ?? 2;
      const win = Math.floor(bet * mult * 0.92);
      await db.updateBalance(uid, win);
      await db.recordGame(uid, true, bet + win);
      return message.channel.send({ embeds: [embed(0xf1c40f).setTitle("🎰 JACKPOT!").setDescription(`**[ ${display} ]**\n+**${win.toLocaleString()} FC** (${mult}x)\n${HouseEdge.baitWin()}`)] });
    } else if (a === b || b === c || a === c) {
      const sym = a === b ? a : c;
      const win = Math.floor(bet * 0.5);
      await db.updateBalance(uid, win);
      await db.recordGame(uid, true, bet + win);
      return message.channel.send({ embeds: [embed(0x3498db).setTitle("🎰 Slots — Partial Win").setDescription(`**[ ${display} ]**\n+**${win.toLocaleString()} FC** (pair of ${sym})\n${HouseEdge.baitWin()}`)] });
    } else {
      await db.updateBalance(uid, -bet);
      await db.recordGame(uid, false, bet);
      return message.channel.send({ embeds: [embed(0xe74c3c).setTitle("🎰 Slots — No Match").setDescription(`**[ ${display} ]**\n-**${bet.toLocaleString()} FC**\n${HouseEdge.baitLoss()}`)] });
    }
  },
};
