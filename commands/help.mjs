import { COLORS } from "../src/theme.mjs";

export default {
  name: "help",
  aliases: ["h", "commands"],
  description: "Show all commands.",

  async execute({ message, embed, prefix }) {
    const p = prefix;

    return message.channel.send({ embeds: [
      embed(COLORS.accent)
        .setTitle("🟢 SirGreen Casino — Commands")
        .addFields(
          {
            name: "🎰  Games",
            value: [
              `\`${p}slots <bet>\` — Spin the slots`,
              `\`${p}bj <bet>\` — Blackjack (hit/stand/double)`,
              `\`${p}cf <h|t> <bet>\` — Coinflip`,
              `\`${p}crash <bet> <×>\` — Crash`,
              `\`${p}dice <o|u> <n> <bet>\` — Dice over/under`,
              `\`${p}rl <colour|n> <bet>\` — Roulette`,
              `\`${p}bandit\` — Le Bandit (web)`,
            ].join("\n"),
            inline: false,
          },
          {
            name: "💰  Economy",
            value: [
              `\`${p}bal [@user]\` — Check balance`,
              `\`${p}daily\` — Claim 1,000 FC`,
              `\`${p}pay @user <amt>\` — Send FC`,
              `\`${p}lb [rich|earners]\` — Leaderboard`,
            ].join("\n"),
            inline: false,
          },
          {
            name: "ℹ️   Info",
            value: `\`${p}help\` — This menu`,
            inline: false,
          }
        )
        .setFooter({ text: "Aliases work too — e.g. &spin, &flip, &roll" })
    ]});
  },
};
