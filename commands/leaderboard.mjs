export default {
  name: "leaderboard",
  aliases: ["lb", "top"],
  description: "Global FluxCoins leaderboard.",
  async execute({ message, args, db, embed }) {
    const mode = args[0]?.toLowerCase();
    const field = mode === "wins" ? "totalWon" : "balance";
    const title = mode === "wins" ? "🏆 Top Earners" : "🏆 Richest Players";
    const rows = await db.getLeaderboard(field, 10);

    if (!rows.length)
      return message.channel.send({ embeds: [embed(0xe74c3c).setDescription("No data yet.")] });

    const lines = rows.map((u, i) => {
      const medal = ["🥇","🥈","🥉"][i] ?? `**${i + 1}.**`;
      const val = field === "totalWon" ? u.totalWon : u.balance;
      return `${medal} <@${u.userId}> — **${val.toLocaleString()} FC**`;
    });

    return message.channel.send({ embeds: [
      embed(0xf1c40f)
        .setTitle(title)
        .setDescription(lines.join("\n"))
        .setFooter({ text: "Global · Use &lb wins for top earners" })
    ]});
  },
};
