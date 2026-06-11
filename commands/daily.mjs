import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getOrCreate, claimDaily, fmt } from "../src/Database.mjs";
import { baitAfterLoss } from "../src/HouseEdge.mjs";

export const command = new CommandBuilder()
  .setName("daily")
  .setDescription("Claim your daily Flux reward (500–1000 Flux, once per 24 hours).")
  .setCategory("casino");

export async function run(msg) {
  const userId = msg.message.author.id;
  const username = msg.message.author.username ?? userId;
  await getOrCreate(userId, username);
  const result = await claimDaily(userId);
  if (result.ok) {
    const embed = new EmbedBuilder()
      .setColor(0x00cc66)
      .setTitle("🎁 Daily Reward Claimed!")
      .setDescription(`You received **${fmt(result.reward)} Flux** 🪙\n\n${baitAfterLoss()}`);
    return msg.reply({ embeds: [embed] });
  }
  const ms = result.next - Date.now();
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const embed = new EmbedBuilder()
    .setColor(0xff4444)
    .setTitle("⏳ Already Claimed")
    .setDescription(`Come back in **${h}h ${m}m** for your next reward.`);
  msg.reply({ embeds: [embed] });
}
