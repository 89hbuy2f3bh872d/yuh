import { COLORS } from "../src/theme.mjs";

export default {
  name: "balance",
  aliases: ["bal", "coins"],
  description: "Check your FC balance.",

  async execute({ message, args, db, embed }) {
    const uid = args[0]
      ? (message.mentions.users.first()?.id ?? args[0])
      : message.author.id;

    const u = await db.getUser(uid);
    const tag = args[0]
      ? (message.mentions.users.first()?.tag ?? uid)
      : message.author.tag;

    return message.channel.send({ embeds: [
      embed(COLORS.accent)
        .setTitle("💰 Balance")
        .setDescription(`**${tag}**\n\`${u.bal.toLocaleString()} FC\``)
        .addFields(
          { name: "Won",   value: u.tw.toLocaleString(), inline: true },
          { name: "Lost",  value: u.tl.toLocaleString(), inline: true },
          { name: "Games", value: u.gp.toString(),       inline: true }
        )
    ]});
  },
};
