import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getOrCreate, addBalance, recordResult, fmt } from "../src/Database.mjs";
import { parseBet } from "../src/Utils.mjs";
import { RTP, baitAfterLoss, baitAfterWin } from "../src/HouseEdge.mjs";

const REDS = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
function spin() { return Math.floor(Math.random() * 37); }
function evaluate(bet, num) {
  if (/^\d+$/.test(bet)) {
    const n = parseInt(bet);
    if (n < 0 || n > 36) return { ok: false };
    return { win: num === n, mult: 35 };
  }
  switch (bet.toLowerCase()) {
    case "red": return { win: REDS.has(num), mult: 1 };
    case "black": return { win: num > 0 && !REDS.has(num), mult: 1 };
    case "even": return { win: num > 0 && num % 2 === 0, mult: 1 };
    case "odd": return { win: num > 0 && num % 2 !== 0, mult: 1 };
    case "low": return { win: num >= 1 && num <= 18, mult: 1 };
    case "high": return { win: num >= 19 && num <= 36, mult: 1 };
    case "dozen1": return { win: num >= 1 && num <= 12, mult: 2 };
    case "dozen2": return { win: num >= 13 && num <= 24, mult: 2 };
    case "dozen3": return { win: num >= 25 && num <= 36, mult: 2 };
    default: return { ok: false };
  }
}
const VALID = ["red","black","even","odd","low","high","dozen1","dozen2","dozen3","0–36"];

export const command = new CommandBuilder()
  .setName("roulette")
  .addAlias("rl")
  .setDescription("European roulette. Bet types: red/black/even/odd/low/high/dozen1-3 or a number 0–36.")
  .addStringOption(o => o.setName("bet_type").setDescription("Bet type (red, black, 0–36, etc.)").setRequired(true))
  .addStringOption(o => o.setName("amount").setDescription("Amount to bet").setRequired(true))
  .setCategory("casino");

export async function run(msg, data) {
  const userId = msg.message.author.id;
  const username = msg.message.author.username ?? userId;
  const user = await getOrCreate(userId, username);
  const betType = data.get("bet_type")?.value;
  const amount = parseBet(data.get("amount")?.value, user.balance);

  if (!amount || amount < 1) return msg.reply("❌ Invalid amount.");
  if (amount > user.balance) return msg.reply(`❌ You only have **${fmt(user.balance)} Flux**.`);

  const ev = evaluate(betType, 0);
  if (ev.ok === false && !/^\d+$/.test(betType)) return msg.reply(`❌ Unknown bet type. Valid: ${VALID.join(", ")}.`);

  await addBalance(userId, -amount);
  const num = spin();
  const color = num === 0 ? "🟢" : REDS.has(num) ? "🔴" : "⚫";
  const res = evaluate(betType, num);
  const payout = res.win ? Math.floor(amount * res.mult * RTP.roulette) + amount : 0;

  if (res.win && payout > 0) {
    await addBalance(userId, payout);
    await recordResult(userId, payout - amount, 0);
    const embed = new EmbedBuilder()
      .setColor(0xf5c518)
      .setTitle("🎡 Roulette")
      .setDescription(`${color} Ball landed on **${num}**!\nYou bet **${betType}** and won **+${fmt(payout - amount)} Flux**!\n\n${baitAfterWin()}`);
    return msg.reply({ embeds: [embed] });
  }

  await recordResult(userId, 0, amount);
  const embed = new EmbedBuilder()
    .setColor(0xff4444)
    .setTitle("🎡 Roulette")
    .setDescription(`${color} Ball landed on **${num}**.\nYou bet **${betType}** and lost **${fmt(amount)} Flux**.\n\n${baitAfterLoss()}`);
  msg.reply({ embeds: [embed] });
}
