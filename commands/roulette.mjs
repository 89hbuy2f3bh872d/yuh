import { COLORS } from "../src/theme.mjs";
import { HouseEdge } from "../src/HouseEdge.mjs";

// RTP ~90%: achieved by adding two house numbers (00 and 000) for 38 total
// pockets, making even-money bets pay 1:1 against a 3/38 house edge (~92% RTP).
// Number bets pay 34:1 instead of standard 35:1.

const REDS = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);

function spin() { return Math.floor(Math.random() * 38); } // 0-35 = numbers, 36 = 00, 37 = 000

function display(n) {
  if (n === 36) return "00";
  if (n === 37) return "000";
  return String(n);
}

function colour(n) {
  if (n >= 36) return "green";
  if (n === 0) return "green";
  return REDS.has(n) ? "red" : "black";
}

const MIN_BET = 10;

export default {
  name: "roulette",
  aliases: ["rl", "spin"],
  description: "Spin the roulette. `&roulette <red|black|green|even|odd|number> <bet>`",

  async execute({ message, args, db, embed }) {
    const uid = message.author.id;
    if (args.length < 2) {
      return message.channel.send({ embeds: [
        embed(COLORS.warn)
          .setTitle("🎡 Roulette")
          .setDescription(
            "**Usage:** `&roulette <bet_type> <amount>`\n\n" +
            "**Bet types:**\n" +
            "• `red` / `black` — 1:1 payout\n" +
            "• `green` — 5:1 payout (covers 0, 00, 000)\n" +
            "• `even` / `odd` — 1:1 payout\n" +
            "• `0`-`35` (specific number) — 34:1 payout\n"
          )
      ]});
    }

    const betType = args[0].toLowerCase();
    const betAmt  = parseInt(args[1], 10);

    if (!betAmt || betAmt < MIN_BET) {
      return message.channel.send({ embeds: [
        embed(COLORS.warn).setDescription(`⚠️ Minimum bet is ${MIN_BET} FC.`)
      ]});
    }

    const validTypes = ["red","black","green","even","odd"];
    const numBet = parseInt(betType, 10);
    const isNumBet = !isNaN(numBet) && numBet >= 0 && numBet <= 35;

    if (!validTypes.includes(betType) && !isNumBet) {
      return message.channel.send({ embeds: [
        embed(COLORS.warn).setDescription("⚠️ Invalid bet type. Use: red, black, green, even, odd, or a number 0-35.")
      ]});
    }

    // Atomically deduct the bet upfront
    const deducted = await db.atomicDeduct(uid, -betAmt);
    if (!deducted) {
      return message.channel.send({ embeds: [
        embed(COLORS.error).setDescription("❌ Not enough FC. Try `&work` to earn some.")
      ]});
    }

    const result = spin();
    const resDisplay = display(result);
    const resColor   = colour(result);
    const colorEmoji = resColor === "red" ? "🔴" : resColor === "black" ? "⚫" : "🟢";

    let won = false, multiplier = 0;
    if (betType === "red")   { won = resColor === "red";   multiplier = 1; }
    if (betType === "black") { won = resColor === "black"; multiplier = 1; }
    if (betType === "green") { won = resColor === "green"; multiplier = 5; }
    if (betType === "even")  { won = result > 0 && result <= 35 && result % 2 === 0; multiplier = 1; }
    if (betType === "odd")   { won = result > 0 && result <= 35 && result % 2 !== 0; multiplier = 1; }
    if (isNumBet)            { won = result === numBet; multiplier = 34; }

    const winAmt = won ? betAmt * multiplier : 0;
    if (winAmt > 0) await db.updateBalance(uid, winAmt);
    await db.recordGame(uid, won, betAmt);
    const u2 = await db.getUser(uid);

    return message.channel.send({ embeds: [
      embed(won ? COLORS.primary : COLORS.error)
        .setTitle(`${colorEmoji} Roulette — **${resDisplay}** (${resColor})`)
        .setDescription(
          `You bet **${betType}** for **${betAmt.toLocaleString()} FC**\n\n` +
          (won
            ? `✅ Winner! **+${(betAmt * multiplier).toLocaleString()} FC**\n${HouseEdge.baitWin()}`
            : `❌ You lost **${betAmt.toLocaleString()} FC**\n${HouseEdge.baitLoss()}`) +
          `\n\n💰 Balance: **${Math.floor(u2.bal).toLocaleString()} FC**`
        )
    ]});
  },
};
