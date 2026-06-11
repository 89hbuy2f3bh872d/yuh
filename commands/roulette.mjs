import { HouseEdge } from "../src/HouseEdge.mjs";
import { COLORS } from "../src/theme.mjs";

const REDS = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];

function color(n) {
  if (n === 0) return "green";
  return REDS.includes(n) ? "red" : "black";
}

export default {
  name: "roulette",
  aliases: ["rl"],
  description: "Roulette. `&rl <red|black|green|0-36> <bet>`",

  async execute({ message, args, db, embed }) {
    const uid = message.author.id;
    const pick = args[0]?.toLowerCase();
    const bet = parseInt(args[1]);

    if (!pick) {
      return message.channel.send({ embeds: [embed(COLORS.error).setDescription("❌ e.g. `&rl red 500` or `&rl 17 500`")] });
    }
    if (isNaN(bet) || bet <= 0) {
      return message.channel.send({ embeds: [embed(COLORS.error).setDescription("❌ Invalid bet.")] });
    }
    if (bet > 750_000) {
      return message.channel.send({ embeds: [embed(COLORS.error).setDescription("❌ Max bet is 750,000 FC.")] });
    }

    const u = await db.getUser(uid);
    if (bet > u.bal) {
      return message.channel.send({ embeds: [embed(COLORS.error).setDescription("❌ Insufficient FC.")] });
    }

    const spin = Math.floor(Math.random() * 37); // 0–36
    const spinColor = color(spin);
    const spinEmoji = spinColor === "red" ? "🔴" : spinColor === "black" ? "⚫" : "🟢";

    const numPick = parseInt(pick);
    let won = false;
    let mult = 1;

    if (!isNaN(numPick) && numPick >= 0 && numPick <= 36) {
      won = spin === numPick;
      mult = 35;
    } else if (["red","black","green"].includes(pick)) {
      won = spinColor === pick;
      mult = pick === "green" ? 35 : 1;
    } else {
      return message.channel.send({ embeds: [embed(COLORS.error).setDescription("❌ Pick red, black, green, or a number 0–36.")] });
    }

    if (won) {
      const payout = Math.floor(bet * mult);
      await db.updateBalance(uid, payout);
      await db.recordGame(uid, true, bet + payout);
      return message.channel.send({ embeds: [
        embed(COLORS.primary)
          .setTitle(`${spinEmoji} WIN! — ${spin}`)
          .setDescription(`+**${payout.toLocaleString()} FC** (${mult}×)\n${HouseEdge.baitWin()}`)
      ]});
    }

    await db.updateBalance(uid, -bet);
    await db.recordGame(uid, false, bet);
    return message.channel.send({ embeds: [
      embed(COLORS.error)
        .setTitle(`${spinEmoji} LOSS — ${spin}`)
        .setDescription(`-**${bet.toLocaleString()} FC**\n${HouseEdge.baitLoss()}`)
    ]});
  },
};
