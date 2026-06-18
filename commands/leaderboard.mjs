import { COLORS } from "../src/theme.mjs";

export default {
  name: "leaderboard",
  aliases: ["lb", "top"],
  description: "Global FC leaderboard. `&lb [rich|earners]`",

  async execute({ message, args, db, embed }) {
    const mode = args[0]?.toLowerCase();
    const byEarners = mode === "earners";

    // "rich" = balances, which live in STDB (Mongo's bal is a stale starter). "earners"
    // = total wagered, which IS stored in Mongo. Use the right source per mode.
    let rows;
    if (byEarners) {
      rows = await db.getLeaderboard("tw", 10);
      if (!rows.length) return message.channel.send({ embeds: [embed(COLORS.warn).setDescription("No data yet.")] });
      const medals = ["🥇","🥈","🥉"];
      const lines = rows.map((r, i) => `${medals[i] ?? `**${i + 1}.**`} <@${r._id}> — \`${Number(r.tw || 0).toLocaleString()} FC wagered\``);
      return message.channel.send({ embeds: [ embed(COLORS.gold).setTitle("🏆 Top Earners").setDescription(lines.join("\n")).setFooter({ text: `&lb rich  ·  &lb earners` }) ] });
    }

    // rich — live STDB balances via the bridge
    const limit = 10;
    let stRows = [];
    if (db._bridge && db._bridge.leaderboard) {
      stRows = await db._bridge.leaderboard(limit);
    }
    if (!stRows.length) {
      // fallback to Mongo if the bridge isn't attached (shouldn't happen in prod)
      rows = await db.getLeaderboard("bal", limit);
      stRows = rows.map(r => ({ owner: r._id, balance: Number(r.bal || 0) }));
    }
    if (!stRows.length) return message.channel.send({ embeds: [embed(COLORS.warn).setDescription("No data yet.")] });

    const medals = ["🥇","🥈","🥉"];
    const lines = stRows.map((r, i) => `${medals[i] ?? `**${i + 1}.**`} <@${r.owner}> — \`${Number(r.balance || 0).toLocaleString()} FC\``);
    return message.channel.send({ embeds: [
      embed(COLORS.gold)
        .setTitle("🏆 Richest Players")
        .setDescription(lines.join("\n"))
        .setFooter({ text: `&lb rich  ·  &lb earners` })
    ]});
  },
};
