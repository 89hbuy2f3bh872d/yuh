import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getLeaderboard, fmt } from "../src/Database.mjs";

export const command = new CommandBuilder()
  .setName("leaderboard")
  .addAliases("lb", "top", "richest")
  .setDescription("Global casino leaderboard. Modes: richest (default) or earners.")
  .addChoiceOption(o =>
    o.setName("mode")
     .setDescription("richest = top balances, earners = total winnings")
     .addChoices("richest", "earners")
     .setDefault("richest")
  )
  .setCategory("casino");

const medals = ["🥇","🥈","🥉","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟"];

export async function run(msg, data) {
  const mode = data.get("mode")?.value ?? "richest";
  const users = await getLeaderboard(mode, 10);

  const title = mode === "earners" ? "🏆 Top Earners (All Time)" : "💰 Richest Players";
  const lines = users.map((u, i) => {
    const val = mode === "earners" ? u.totalWon : u.balance;
    const name = u.username && u.username !== "Unknown" ? u.username : `<@${u.userId}>`;
    return `${medals[i] ?? `${i+1}.`} **${name}** — ${fmt(val)} Flux`;
  });

  const embed = new EmbedBuilder()
    .setColor(0xf5c518)
    .setTitle(title)
    .setDescription(lines.length ? lines.join("\n") : "No data yet. Be the first to play!")
    .setFooter({ text: "Global rankings across all servers" });
  msg.reply({ embeds: [embed] });
}
