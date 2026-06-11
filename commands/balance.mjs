import { COLORS } from "../src/theme.mjs";

export default {
  name: "balance",
  aliases: ["bal", "coins"],
  description: "Check your FC balance.",

  async execute({ message, args, db, embed }) {
    const uid = args[0]
      ? (message.mentions?.users?.first()?.id ?? args[0])
      : message.author.id;

    const tag = args[0]
      ? (message.mentions?.users?.first()?.tag ?? uid)
      : (message.author.tag ?? message.author.username ?? uid);

    const u = await db.getUser(uid);

    // Defensive defaults — guard against any driver version returning sparse doc
    const bal    = Number(u?.bal  ?? 0);
    const won    = Number(u?.tw   ?? 0);
    const lost   = Number(u?.tl   ?? 0);
    const games  = Number(u?.gp   ?? 0);

    return message.channel.send({ embeds: [
      embed(COLORS.accent)
        .setTitle("💰 Balance")
        .setDescription(`**${tag}**\n\`${bal.toLocaleString()} FC\``)
        .addFields(
          { name: "Won",   value: won.toLocaleString(),   inline: true },
          { name: "Lost",  value: lost.toLocaleString(),  inline: true },
          { name: "Games", value: games.toString(),       inline: true }
        )
    ]});
  },
};
