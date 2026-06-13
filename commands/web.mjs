import { COLORS } from "../src/theme.mjs";

export default {
  name: "web",
  aliases: ["games", "casino", "lobby"],
  description: "Open the SirGreen Casino web lobby.",

  async execute({ message, embed, config }) {
    const base = config.webBaseUrl ?? "https://www.sirgreen.online";

    const row = {
      type: 1,
      components: [{
        type: 2,
        style: 5,
        label: "🐟 Open Casino Lobby",
        url: `${base}/lobby`,
      }],
    };

    return message.channel.send({
      embeds: [
        embed(COLORS.accent)
          .setTitle("🐟 SirGreen Casino — Web Lobby")
          .setDescription(
            `Play **Fish Slot** in your browser, check your FC balance, and more.\n\n` +
            `Login with your Fluxer account — your FluxCoin balance syncs automatically.`
          ),
      ],
      components: [row],
    });
  },
};
