import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getOrCreate, transfer, fmt } from "../src/Database.mjs";
import { parseBet } from "../src/Utils.mjs";

export const command = new CommandBuilder()
  .setName("pay")
  .addAliases("send", "give")
  .setDescription("Send Flux to another user. Supports: all, half, 1k, 2.5m.")
  .addUserOption(o => o.setName("user").setDescription("User to pay").setRequired(true))
  .addStringOption(o => o.setName("amount").setDescription("Amount to send").setRequired(true))
  .setCategory("casino");

export async function run(msg, data) {
  const fromId = msg.message.author.id;
  const fromName = msg.message.author.username ?? fromId;
  const toId = data.get("user")?.value;
  const rawAmt = data.get("amount")?.value;

  if (!toId || toId === fromId) {
    return msg.reply("❌ Please mention a valid user to pay (can't pay yourself).");
  }

  const from = await getOrCreate(fromId, fromName);
  const amt = parseBet(rawAmt, from.balance);

  if (!amt || amt < 1) return msg.reply("❌ Invalid amount.");
  if (from.balance < amt) return msg.reply(`❌ You only have **${fmt(from.balance)} Flux**.`);

  await getOrCreate(toId, toId);
  await transfer(fromId, toId, amt);

  const embed = new EmbedBuilder()
    .setColor(0x00aaff)
    .setTitle("💸 Transfer Successful")
    .setDescription(`<@${fromId}> sent **${fmt(amt)} Flux** to <@${toId}> 🪙`);
  msg.reply({ embeds: [embed] });
}
