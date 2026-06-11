export default {
  name: "balance",
  aliases: ["bal", "coins"],
  description: "Check your Flux balance.",
  async execute({ message, db, embed }) {
    const user = await db.getUser(message.author.id);
    const e = embed(0x2ecc71)
      .setTitle("💰 Balance")
      .setDescription(`**${message.author.username}** has **${user.balance.toLocaleString()} Flux**`)
      .addFields(
        { name: "Total Won",   value: user.totalWon.toLocaleString(),   inline: true },
        { name: "Total Lost",  value: user.totalLost.toLocaleString(),  inline: true },
        { name: "Games Played",value: user.gamesPlayed.toLocaleString(),inline: true }
      );
    message.channel.send({ embeds: [e] });
  },
};
