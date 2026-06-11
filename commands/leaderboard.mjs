export default {
  name: "leaderboard",
  aliases: ["lb", "top"],
  description: "Global leaderboard. !lb [rich|winners]",
  async execute({ message, args, db, embed }) {
    const mode = (args[0] ?? "rich").toLowerCase();
    const field = mode === "winners" ? "totalWon" : "balance";
    const title = mode === "winners" ? "🏆 Top Earners" : "💰 Richest Players";

    const rows = await db.getLeaderboard(field, 10);
    if (!rows.length) return message.channel.send({ embeds: [embed(0x95a5a6).setDescription("No data yet.")] });

    const lines = rows.map((u, i) =>
      `**${i + 1}.** <@${u.userId}> — **${u[field].toLocaleString()} Flux**`
    );

    message.channel.send({ embeds: [
      embed(0xf1c40f).setTitle(title).setDescription(lines.join("\n"))
    ]});
  },
};
