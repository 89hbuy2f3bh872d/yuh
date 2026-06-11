export default {
  name: "balance",
  aliases: ["bal", "wallet"],
  description: "Check your FluxCoins balance.",
  async execute({ message, db, embed }) {
    const uid = message.author.id;
    const user = await db.getUser(uid);
    return message.channel.send({ embeds: [
      embed(0x5865f2)
        .setTitle("💰 FluxCoins Balance")
        .setDescription(`**${message.author.username}** has **${user.balance.toLocaleString()} FC**`)
        .setFooter({ text: `Games played: ${user.gamesPlayed} · Won: ${user.totalWon.toLocaleString()} FC · Lost: ${user.totalLost.toLocaleString()} FC` })
    ]});
  },
};
