import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getOrCreate, addBalance, recordResult, fmt } from "../src/Database.mjs";
import { parseBet } from "../src/Utils.mjs";
import { RTP, baitAfterLoss, baitAfterWin } from "../src/HouseEdge.mjs";

export const command = new CommandBuilder()
  .setName("dice")
  .addAliases("roll", "die")
  .setDescription("Guess the dice roll (1–6). Correct = 5.26x effective payout.")
  .addNumberOption(o => o.setName("guess").setDescription("Your guess: 1–6").setRequired(true))
  .addStringOption(o => o.setName("bet").setDescription("Amount to bet").setRequired(true))
  .setCategory("casino");

export async function run(msg, data) {
  const userId = msg.message.author.id;
  const username = msg.message.author.username ?? userId;
  const user = await getOrCreate(userId, username);
  const guess = Math.round(data.get("guess")?.value);
  const bet = parseBet(data.get("bet")?.value, user.balance);

  if (guess < 1 || guess > 6) return msg.reply("❌ Guess must be between 1 and 6.");
  if (!bet || bet < 1) return msg.reply("❌ Invalid bet amount.");
  if (bet > user.balance) return msg.reply(`❌ You only have **${fmt(user.balance)} Flux**.`);

  await addBalance(userId, -bet);
  const roll = 1 + Math.floor(Math.random() * 6);
  const won = roll === guess;
  const payout = won ? Math.floor(bet * 5.6 * RTP.dice) : 0;
  const FACES = ["","1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣"];

  if (won) {
    await addBalance(userId, payout);
    await recordResult(userId, payout, 0);
    const embed = new EmbedBuilder()
      .setColor(0xf5c518)
      .setTitle("🎲 Dice Roll")
      .setDescription(`Rolled ${FACES[roll]} **${roll}** — You guessed right!\nYou won **+${fmt(payout)} Flux**!\n\n${baitAfterWin()}`);
    return msg.reply({ embeds: [embed] });
  }

  await recordResult(userId, 0, bet);
  const embed = new EmbedBuilder()
    .setColor(0xff4444)
    .setTitle("🎲 Dice Roll")
    .setDescription(`Rolled ${FACES[roll]} **${roll}** — You guessed **${guess}**.\nYou lost **${fmt(bet)} Flux**.\n\n${baitAfterLoss()}`);
  msg.reply({ embeds: [embed] });
}
