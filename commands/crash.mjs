import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getOrCreate, addBalance, recordResult, fmt } from "../src/Database.mjs";
import { parseBet } from "../src/Utils.mjs";
import { RTP, baitAfterLoss, baitAfterWin } from "../src/HouseEdge.mjs";

function crashPoint() {
  if (Math.random() < (1 - RTP.crash)) return 1.0;
  const r = Math.random();
  return Math.max(1.01, parseFloat((1 / (1 - r * 0.85)).toFixed(2)));
}

export const command = new CommandBuilder()
  .setName("crash")
  .addAlias("rocket")
  .setDescription("Bet on a rising multiplier — cash out before it crashes! Optional auto-cashout.")
  .addStringOption(o => o.setName("bet").setDescription("Amount to bet").setRequired(true))
  .addNumberOption(o => o.setName("auto_cashout").setDescription("Auto cashout multiplier (e.g. 2.0). Optional."))
  .setCategory("casino");

export async function run(msg, data) {
  const userId = msg.message.author.id;
  const username = msg.message.author.username ?? userId;
  const user = await getOrCreate(userId, username);
  const bet = parseBet(data.get("bet")?.value, user.balance);
  const auto = data.get("auto_cashout")?.value ?? null;

  if (!bet || bet < 1) return msg.reply("❌ Invalid bet amount.");
  if (bet > user.balance) return msg.reply(`❌ You only have **${fmt(user.balance)} Flux**.`);

  await addBalance(userId, -bet);
  const crash = crashPoint();
  const cashedAt = auto && parseFloat(auto) < crash ? parseFloat(auto) : null;

  if (crash <= 1.0) {
    await recordResult(userId, 0, bet);
    const embed = new EmbedBuilder().setColor(0xff4444).setTitle("🚀 Crash — CRASHED AT 1.00x!")
      .setDescription(`💥 Instant crash!\nYou lost **${fmt(bet)} Flux** before you could blink.\n\n${baitAfterLoss()}`);
    return msg.reply({ embeds: [embed] });
  }

  if (cashedAt) {
    const payout = Math.floor(bet * cashedAt * RTP.crash);
    await addBalance(userId, payout);
    await recordResult(userId, payout - bet, 0);
    const embed = new EmbedBuilder().setColor(0xf5c518).setTitle(`🚀 Crash — Auto cashed at ${cashedAt}x`)
      .setDescription(`📈 Multiplier reached **${cashedAt}x** (crashed at **${crash}x**)\nYou won **+${fmt(payout - bet)} Flux**!\n\n${baitAfterWin()}`);
    return msg.reply({ embeds: [embed] });
  }

  await recordResult(userId, 0, bet);
  const embed = new EmbedBuilder().setColor(0xff4444).setTitle(`🚀 Crash — CRASHED AT ${crash}x`)
    .setDescription(`💥 The rocket crashed at **${crash}x** before you cashed out.\nYou lost **${fmt(bet)} Flux**.\n\nTip: use \`!crash <bet> <auto_cashout>\` next time!\n\n${baitAfterLoss()}`);
  msg.reply({ embeds: [embed] });
}
