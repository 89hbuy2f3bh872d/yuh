import { HouseEdge } from "../src/HouseEdge.mjs";

const RED = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];

export default {
  name: "roulette",
  aliases: ["rl"],
  description: "Spin roulette. `&rl <bet> <red|black|even|odd|1-36>`",
  async execute({ message, args, db, embed, prefix }) {
    const uid = message.author.id;
    const bet = parseInt(args[0]);
    const pick = args[1]?.toLowerCase();
    const user = await db.getUser(uid);
    const valid = ["red","black","even","odd"];
    const numPick = parseInt(pick);

    if (isNaN(bet) || bet <= 0 || (!valid.includes(pick) && (isNaN(numPick) || numPick < 1 || numPick > 36)))
      return message.channel.send({ embeds: [embed(0xe74c3c).setDescription(`❌ Usage: \`${prefix}rl <bet> <red|black|even|odd|1-36>\``)] });
    if (bet > user.balance)
      return message.channel.send({ embeds: [embed(0xe74c3c).setDescription("❌ Insufficient FluxCoins.")] });
    if (bet > 750_000)
      return message.channel.send({ embeds: [embed(0xe74c3c).setDescription("❌ Max bet is **750,000 FC**.")] });

    const spin = Math.floor(Math.random() * 37); // 0-36
    const isRed = RED.includes(spin);
    const color = spin === 0 ? "🟢" : isRed ? "🔴" : "⚫";
    let won = false, mult = 2;

    if (!isNaN(numPick)) { won = spin === numPick; mult = 36; }
    else if (pick === "red")   { won = spin !== 0 && isRed; }
    else if (pick === "black") { won = spin !== 0 && !isRed; }
    else if (pick === "even")  { won = spin !== 0 && spin % 2 === 0; }
    else if (pick === "odd")   { won = spin !== 0 && spin % 2 !== 0; }

    const spinStr = `${color} **${spin}**`;
    if (won) {
      const payout = Math.floor(bet * (mult - 1));
      await db.updateBalance(uid, payout);
      await db.recordGame(uid, true, bet + payout);
      return message.channel.send({ embeds: [embed(0x2ecc71).setTitle("🎡 Roulette — WIN!").setDescription(`Spin: ${spinStr}\nYou bet **${pick}** — correct!\n+**${payout.toLocaleString()} FC**\n${HouseEdge.baitWin()}`)] });
    } else {
      await db.updateBalance(uid, -bet);
      await db.recordGame(uid, false, bet);
      return message.channel.send({ embeds: [embed(0xe74c3c).setTitle("🎡 Roulette — LOSS").setDescription(`Spin: ${spinStr}\nYou bet **${pick}**.\n-**${bet.toLocaleString()} FC**\n${HouseEdge.baitLoss()}`)] });
    }
  },
};
