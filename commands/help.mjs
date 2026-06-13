import { COLORS } from "../src/theme.mjs";

export default {
  name: "help",
  aliases: ["h", "commands"],
  description: "Show all commands.",

  async execute({ message, embed, prefix }) {
    const p = prefix;

    return message.channel.send({ embeds: [
      embed(COLORS.accent)
        .setTitle("🐟 SirGreen Casino — Commands")
        .addFields(
          {
            name: "🎰  Games",
            value: [
              `\`${p}fishslot <bet>\` — Play Fish Slot (browser game, bet settled automatically)`,
              `\`${p}web\` — Open the Casino lobby in your browser`,
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
        .setFooter({ text: "Aliases: &fish, &fs  |  &games to open the web lobby" })
    ]});
  },
};
