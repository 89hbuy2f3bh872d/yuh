import { COLORS } from "../src/theme.mjs";

export default {
  name: "leaderboard",
  aliases: ["lb", "top"],
  description: "Global FC leaderboard. `&lb [rich|earners]`",

  async execute({ message, args, db, embed }) {
    const mode = args[0]?.toLowerCase();
    const byEarners = mode === "earners";

    const rows = await db.getLeaderboard(byEarners ? "tw" : "bal", 10);

    if (!rows.length) {
      return message.channel.send({ embeds: [embed(COLORS.warn).setDescription("No data yet.")] });
    }

    const medals = ["🥇","🥈","🥉"];
    const lines = rows.map((r, i) => {
      const medal = medals[i] ?? `**${i + 1}.**`;
      const val = byEarners ? r.tw : r.bal;
      return `${medal} <@${r._id}> — \`${val.toLocaleString()} FC\``;
    });

    return message.channel.send({ embeds: [
      embed(COLORS.gold)
        .setTitle(byEarners ? "🏆 Top Earners" : "🏆 Richest Players")
        .setDescription(lines.join("\n"))
        .setFooter({ text: `&lb rich  ·  &lb earners` })
    ]});
  },
};
