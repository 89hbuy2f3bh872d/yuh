import { COLORS } from "../src/theme.mjs";

export default {
  name: "help",
  aliases: ["h"],
  description: "Show available commands",

  async execute({ message, embed, prefix }) {
    return message.channel.send({
      embeds: [
        embed(COLORS.primary)
          .setTitle("🎰 SirGreen Casino — Commands")
          .addFields(
            {
              name: "💰 Economy",
              value:
                `**\`${prefix}balance\`** — Check your FC balance\n` +
                `**\`${prefix}daily\`** — Claim your daily FC bonus\n` +
                `**\`${prefix}work\`** — Work a shift for FC\n` +
                `**\`${prefix}pay <@user> <amount>\`** — Send FC to someone\n` +
                `**\`${prefix}leaderboard\`** — Top FC holders`,
            },
            {
              name: "🎮 Casino Games (Web Lobby)",
              value:
                `**\`${prefix}web\`** — Open the casino lobby\n` +
                `*Hundreds of real slots & live games — Pragmatic Play, PG Soft, Jili, CQ9, Habanero & more. Your FC is your wallet.*`,
            },
            {
              name: "🃏 Discord Games",
              value:
                `**\`${prefix}blackjack <bet>\`** — Classic Blackjack\n` +
                `**\`${prefix}slots <bet>\`** — Pull the slot machine\n` +
                `**\`${prefix}roulette <bet> <color/number>\`** — Spin the wheel\n` +
                `**\`${prefix}dice <bet> <over/under> <number>\`** — Roll the dice\n` +
                `**\`${prefix}coinflip <bet> <heads/tails>\`** — Flip a coin\n` +
                `**\`${prefix}crash <bet>\`** — Ride the multiplier & cash out\n` +
                `**\`${prefix}mines <bet> <mines>\`** — Navigate the minefield\n` +
                `**\`${prefix}wildwest @user <bet>\`** — 1v1 duel (fastest draw wins)`,
            }
          )
          .setFooter({ text: `Use ${prefix}help to see this again` }),
      ],
    });
  },
};
