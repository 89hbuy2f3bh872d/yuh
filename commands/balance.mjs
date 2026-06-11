import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getOrCreate, fmt } from "../src/Database.mjs";

export const command = new CommandBuilder()
  .setName("balance")
  .addAliases("bal", "coins", "wallet")
  .setDescription("Check your (or another user's) global Flux balance.")
  .addUserOption(o => o.setName("user").setDescription("User to check (leave blank for yourself)"))
  .setCategory("casino");

export async function run(msg, data) {
  const authorId = msg.message.author.id;
  const authorName = msg.message.author.username ?? authorId;
  const targetId = data.get("user")?.value ?? authorId;
  const user = await getOrCreate(targetId, targetId === authorId ? authorName : targetId);
  const embed = new EmbedBuilder()
    .setColor(0xf5c518)
    .setTitle("💰 Flux Balance")
    .setDescription(
      `<@${targetId}> has **${fmt(user.balance)} Flux** 🪙\n\n` +
      `📊 Won: **${fmt(user.totalWon)}** | Lost: **${fmt(user.totalLost)}** | Games: **${user.gamesPlayed}**`
    );
  msg.reply({ embeds: [embed] });
}
