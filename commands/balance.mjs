import { COLORS } from "../src/theme.mjs";
export default {
  name: "balance",
  aliases: ["bal", "wallet"],
  description: "Check your FluxCoins balance.",
  async execute({ message, db, embed }) {
    const u = await db.getUser(message.author.id);
    return message.channel.send({ embeds: [
      embed(COLORS.dark)
        .setTitle("💰 FluxCoins Balance")
        .setDescription(`**${message.author.username}** — **${u.bal.toLocaleString()} FC**`)
        .addFields(
          { name: "🎮 Games",   value: String(u.gp),                   inline: true },
          { name: "📈 Won",     value: `${u.tw.toLocaleString()} FC`,  inline: true },
          { name: "📉 Lost",    value: `${u.tl.toLocaleString()} FC`,  inline: true }
        )
    ]});
  },
};
