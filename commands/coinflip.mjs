import { COLORS } from "../src/theme.mjs";
import { HouseEdge } from "../src/HouseEdge.mjs";

// RTP ~90%: heads wins with 45% probability (not 50%).
// Player calls heads or tails — if they call correctly AND the biased coin
// agrees, they win 1.8x. The long-run house edge is ~10%.

const MIN_BET = 10;
// True win probability regardless of call: 0.45
const WIN_PROB = 0.45;

export default {
  name: "coinflip",
  aliases: ["cf", "flip"],
  description: "Flip a coin. `&coinflip <heads|tails> <bet>`",

  async execute({ message, args, db, embed }) {
    const uid = message.author.id;

    const side  = args[0]?.toLowerCase();
    const betAmt = parseInt(args[1], 10);

    if (!side || !["heads","tails","h","t"].includes(side) || !betAmt || betAmt < MIN_BET) {
      return message.channel.send({ embeds: [
        embed(COLORS.warn)
          .setTitle("🪙 Coin Flip")
          .setDescription(`**Usage:** \`&coinflip <heads|tails> <amount>\`\nMin bet: **${MIN_BET} FC**`)
      ]});
    }

    const user = await db.getUser(uid);
    if ((user.bal ?? 0) < betAmt) {
      return message.channel.send({ embeds: [
        embed(COLORS.error).setDescription("❌ Not enough FC. Try `&work` to earn some.")
      ]});
    }

    const playerPickedHeads = side === "heads" || side === "h";
    const won = Math.random() < WIN_PROB; // house-biased
    // Actual coin result to display: if won, show player's pick; else show the other side
    const landedHeads = won ? playerPickedHeads : !playerPickedHeads;
    const landedStr   = landedHeads ? "Heads" : "Tails";
    const coinEmoji   = landedHeads ? "🪙" : "🔵";

    const delta = won ? Math.floor(betAmt * 1.8) : -betAmt;
    await db.updateBalance(uid, delta);
    await db.recordGame(uid, won, Math.abs(delta));
    const u2 = await db.getUser(uid);

    return message.channel.send({ embeds: [
      embed(won ? COLORS.primary : COLORS.error)
        .setTitle(`${coinEmoji} Coin Flip — **${landedStr}**`)
        .setDescription(
          `You called **${playerPickedHeads ? "Heads" : "Tails"}** for **${betAmt.toLocaleString()} FC**\n\n` +
          (won
            ? `✅ Correct! **+${Math.floor(betAmt * 1.8).toLocaleString()} FC** (1.8x)\n${HouseEdge.baitWin()}`
            : `❌ Wrong side! Lost **${betAmt.toLocaleString()} FC**\n${HouseEdge.baitLoss()}`) +
          `\n\n💰 Balance: **${Math.floor(u2.bal).toLocaleString()} FC**`
        )
    ]});
  },
};
