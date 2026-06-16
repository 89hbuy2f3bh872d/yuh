import { COLORS } from "../src/theme.mjs";
import { HouseEdge } from "../src/HouseEdge.mjs";

// RTP ~90%: player wins on strict greater-than (not equal); ties go to house.
// High/low bets pay 1.7:1 instead of standard 2:1.

const MIN_BET = 10;

export default {
  name: "dice",
  aliases: ["roll", "dr"],
  description: "Roll dice. `&dice <high|low|exact <1-6>> <bet>`",

  async execute({ message, args, db, embed }) {
    const uid = message.author.id;
    if (args.length < 2) {
      return message.channel.send({ embeds: [
        embed(COLORS.warn)
          .setTitle("🎲 Dice")
          .setDescription(
            "**Usage:** `&dice <bet_type> <amount>`\n\n" +
            "**Bet types:**\n" +
            "• `high` — roll 4-6 to win (pays 1.7:1)\n" +
            "• `low` — roll 1-3 to win (pays 1.7:1)\n" +
            "• `exact <1-6>` — guess exact roll (pays 5:1)\n"
          )
      ]});
    }

    let betType, exactNum, betAmt;
    if (args[0].toLowerCase() === "exact") {
      betType  = "exact";
      exactNum = parseInt(args[1], 10);
      betAmt   = parseInt(args[2], 10);
      if (isNaN(exactNum) || exactNum < 1 || exactNum > 6) {
        return message.channel.send({ embeds: [
          embed(COLORS.warn).setDescription("⚠️ Exact number must be 1-6. Usage: `&dice exact <number> <bet>`")
        ]});
      }
    } else {
      betType = args[0].toLowerCase();
      betAmt  = parseInt(args[1], 10);
    }

    if (!betAmt || betAmt < MIN_BET) {
      return message.channel.send({ embeds: [
        embed(COLORS.warn).setDescription(`⚠️ Minimum bet is ${MIN_BET} FC.`)
      ]});
    }

    if (betType !== "high" && betType !== "low" && betType !== "exact") {
      return message.channel.send({ embeds: [
        embed(COLORS.warn).setDescription("⚠️ Valid bet types: `high`, `low`, `exact <1-6>`.")
      ]});
    }

    // Atomically deduct the bet
    const deducted = await db.atomicDeduct(uid, -betAmt);
    if (!deducted) {
      return message.channel.send({ embeds: [
        embed(COLORS.error).setDescription("❌ Not enough FC. Try `&work` to earn some.")
      ]});
    }

    const roll = Math.floor(Math.random() * 6) + 1;
    const DICE_EMOJI = ["⚀","⚁","⚂","⚃","⚄","⚅"];

    let won = false, multiplier = 0;
    if (betType === "high")  { won = roll >= 4; multiplier = 1.7; }
    if (betType === "low")   { won = roll <= 3; multiplier = 1.7; }
    if (betType === "exact") { won = roll === exactNum; multiplier = 5; }

    const winAmt = won ? Math.floor(betAmt * multiplier) : 0;
    // atomicDeduct already took the bet; net = winAmt - betAmt
    if (winAmt > 0) await db.updateBalance(uid, winAmt);
    await db.recordGame(uid, won, betAmt);
    const u2 = await db.getUser(uid);

    const betLabel = betType === "exact" ? `exact ${exactNum}` : betType;

    return message.channel.send({ embeds: [
      embed(won ? COLORS.primary : COLORS.error)
        .setTitle(`${DICE_EMOJI[roll - 1]} Dice — Rolled **${roll}**`)
        .setDescription(
          `You bet **${betLabel}** for **${betAmt.toLocaleString()} FC**\n\n` +
          (won
            ? `✅ **+${winAmt.toLocaleString()} FC**!\n${HouseEdge.baitWin()}`
            : `❌ Lost **${betAmt.toLocaleString()} FC**\n${HouseEdge.baitLoss()}`) +
          `\n\n💰 Balance: **${Math.floor(u2.bal).toLocaleString()} FC**`
        )
    ]});
  },
};
