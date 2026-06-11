import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getOrCreate, addBalance, recordResult, fmt } from "../src/Database.mjs";
import { parseBet } from "../src/Utils.mjs";
import { RTP, baitAfterLoss, baitAfterWin } from "../src/HouseEdge.mjs";

export const command = new CommandBuilder()
  .setName("coinflip")
  .addAliases("cf", "flip")
  .setDescription("Flip a coin! Pick heads or tails. Win 1.9x your bet on correct guess.")
  .addChoiceOption(o => o.setName("side").setDescription("heads or tails").addChoices("heads","tails").setRequired(true))
  .addStringOption(o => o.setName("bet").setDescription("Amount to bet").setRequired(true))
  .setCategory("casino");

export async function run(msg, data) {
  const userId = msg.message.author.id;
  const username = msg.message.author.username ?? userId;
  const user = await getOrCreate(userId, username);
  const side = data.get("side")?.value;
  const bet = parseBet(data.get("bet")?.value, user.balance);

  if (!bet || bet < 1) return msg.reply("❌ Invalid bet amount.");
  if (bet > user.balance) return msg.reply(`❌ You only have **${fmt(user.balance)} Flux**.`);

  await addBalance(userId, -bet);
  const won = Math.random() < RTP.coinflip;
  const result = won ? side : (side === "heads" ? "tails" : "heads");
  const payout = won ? Math.floor(bet * 1.9) : 0;
  const icon = result === "heads" ? "🪙" : "🔴";

  if (won) {
    await addBalance(userId, payout);
    await recordResult(userId, payout, 0);
    const embed = new EmbedBuilder()
      .setColor(0xf5c518)
      .setTitle("🪙 Coinflip")
      .setDescription(`${icon} It landed **${result}**!\nYou won **+${fmt(payout)} Flux**!\n\n${baitAfterWin()}`);
    return msg.reply({ embeds: [embed] });
  }

  await recordResult(userId, 0, bet);
  const embed = new EmbedBuilder()
    .setColor(0xff4444)
    .setTitle("🪙 Coinflip")
    .setDescription(`${icon} It landed **${result}**!\nYou called ${side} and lost **${fmt(bet)} Flux**.\n\n${baitAfterLoss()}`);
  msg.reply({ embeds: [embed] });
}
