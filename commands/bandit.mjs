import { COLORS } from "../src/theme.mjs";

export default {
  name: "bandit",
  aliases: ["slot", "web"],
  description: "Play Le Bandit slots in your browser.",

  async execute({ message, embed, webHost, webPort }) {
    const url = `http://${webHost}:${webPort}/play`;
    return message.channel.send({ embeds: [
      embed(COLORS.accent)
        .setTitle("🎰 Le Bandit")
        .setDescription(
          `[Click here to play Le Bandit](${url})\n\n` +
          `Sign in with **Discord** directly in the browser.\n` +
          `Your FluxCoin balance is global across all servers.`
        )
    ]});
  },
};
