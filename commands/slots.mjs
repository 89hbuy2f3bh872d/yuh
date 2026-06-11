import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getOrCreate, addBalance, recordResult, fmt } from "../src/Database.mjs";
import { parseBet } from "../src/Utils.mjs";
import { RTP, baitAfterLoss, baitAfterWin } from "../src/HouseEdge.mjs";

const REEL = ["🍒","🍒","🍒","🍋","🍋","🍋","🍇","🍇","🍉","🍉","⭐","⭐","💎","🔔","🎰"];
const MULT = { "🎰":50,"💎":20,"🔔":10,"⭐":5,"🍉":3,"🍇":2,"🍋":1.5,"🍒":1.2 };

function spin() { return REEL[Math.floor(Math.random() * REEL.length)]; }

function evaluate(reels) {
  const [a,b,c] = reels;
  if (a === b && b === c) return { mult: MULT[a] * RTP.slots, label: `**JACKPOT** ${a}${b}${c}!` };
  if (a === b || b === c || a === c) return { mult: 0.5 * RTP.slots, label: `**Pair!** ${a}${b}${c}` };
  return { mult: 0, label: `${a}${b}${c}` };
}

export const command = new CommandBuilder()
  .setName("slots")
  .addAlias("slot")
  .setDescription("Spin the slot machine! Usage: !slots <bet>. Supports all/half/1k/2m.")
  .addStringOption(o => o.setName("bet").setDescription("Amount to bet").setRequired(true))
  .setCategory("casino");

export async function run(msg, data) {
  const userId = msg.message.author.id;
  const username = msg.message.author.username ?? userId;
  const user = await getOrCreate(userId, username);
  const bet = parseBet(data.get("bet")?.value, user.balance);

  if (!bet || bet < 1) return msg.reply("❌ Invalid bet amount.");
  if (bet > user.balance) return msg.reply(`❌ You only have **${fmt(user.balance)} Flux**.`);

  await addBalance(userId, -bet);
  const reels = [spin(), spin(), spin()];
  const result = evaluate(reels);
  const payout = result.mult > 0 ? Math.floor(bet * result.mult) : 0;

  if (payout > 0) {
    await addBalance(userId, payout);
    await recordResult(userId, payout, 0);
    const embed = new EmbedBuilder()
      .setColor(0xf5c518)
      .setTitle("🎰 Slots")
      .setDescription(`[ ${reels.join(" | ")} ]\n\n${result.label}\nYou won **+${fmt(payout)} Flux**!\n\n${baitAfterWin()}`);
    return msg.reply({ embeds: [embed] });
  }

  await recordResult(userId, 0, bet);
  const embed = new EmbedBuilder()
    .setColor(0xff4444)
    .setTitle("🎰 Slots")
    .setDescription(`[ ${reels.join(" | ")} ]\n\nNo match. You lost **${fmt(bet)} Flux**.\n\n${baitAfterLoss()}`);
  msg.reply({ embeds: [embed] });
}
