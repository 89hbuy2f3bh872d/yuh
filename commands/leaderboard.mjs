import { COLORS } from "../src/theme.mjs";
export default {
  name: "leaderboard",
  aliases: ["lb", "top"],
  description: "Global richest players. `&lb wins` for top earners.",
  async execute({ message, args, db, embed, prefix }) {
    const mode = args[0]?.toLowerCase();
    const field = mode === "wins" ? "tw" : "bal";
    const title = mode === "wins" ? "🏆 Top Earners" : "🏆 Richest Players";
    const rows = await db.getLeaderboard(field, 10);
    if (!rows.length) return message.channel.send({ embeds: [embed(COLORS.error).setDescription("No data yet.")] });
    const lines = rows.map((u, i) => {
      const medal = ["🥇","🥈","🥉"][i] ?? `**${i + 1}.**`;
      return `${medal} <@${u._id}> — **${(u[field] ?? 0).toLocaleString()} FC**`;
    });
    return message.channel.send({ embeds: [
      embed(COLORS.gold)
        .setTitle(title)
        .setDescription(lines.join("\n"))
        .setFooter({ text: `Global · ${prefix}lb wins for top earners` })
    ]});
  },
};
