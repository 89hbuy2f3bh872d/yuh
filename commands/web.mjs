import { COLORS } from "../src/theme.mjs";

const GAMES = [
  {
    name: "Cherry Charm",
    desc: "3D slot machine built with Three.js",
    emoji: "🍒",
    path: "/game/cherry-charm",
  },
  {
    name: "JS Slots",
    desc: "JS-themed slot machine PWA",
    emoji: "🎰",
    path: "/game/js-slots",
  },
  {
    name: "Slot Game",
    desc: "Simple slot machine game",
    emoji: "🎡",
    path: "/game/slot-game",
  },
  {
    name: "Blackjack",
    desc: "Chip betting, animated cards",
    emoji: "♠️",
    path: "/game/blackjack",
  },
];

export default {
  name: "web",
  aliases: ["games", "play"],
  description: "Play browser games powered by FluxCoins.",

  async execute({ message, embed, config }) {
    const base = config.webBaseUrl ?? "https://www.sirgreen.online";
    const lines = GAMES.map(
      g => `${g.emoji} **[${g.name}](${base}${g.path})** — ${g.desc}`
    ).join("\n");

    return message.channel.send({
      embeds: [
        embed(COLORS.accent)
          .setTitle("🎮 SirGreen Web Games")
          .setDescription(
            `Play in your browser — sign in once with **Discord**.\n` +
            `Your FluxCoin balance is global across all servers.\n\n` +
            lines
          ),
      ],
    });
  },
};
