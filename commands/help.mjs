import { COLORS } from "../src/theme.mjs";

export default {
  name: "help",
  aliases: ["h"],
  description: "Show available commands",

  async execute({ message, embed }) {
    return message.channel.send({
      embeds: [
        embed(COLORS.primary)
          .setTitle("🎰 SirGreen Casino — Commands")
          .setDescription(
            "**`&balance`** — Check your FC balance\n" +
            "**`&daily`** — Claim your daily FC bonus\n" +
            "**`&pay <user> <amount>`** — Send FC to another user\n" +
            "**`&leaderboard`** — Top FC holders\n" +
            "**`&web`** — Open the casino — play Sir Bandit (6×5 slots) and more"
          ),
      ],
    });
  },
};
