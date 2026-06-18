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
                `**\`${prefix}shop\`** — Buy server roles with FC\n` +
                `**\`${prefix}invest\`** — Trade NFTs & the FC-T index\n` +
                `**\`${prefix}leaderboard\`** — Top FC holders`,
            },
            {
              name: "🃏 Casino Games",
              value:
                `**\`${prefix}blackjack <bet>\`** — Classic Blackjack\n` +
                `**\`${prefix}slots <bet>\`** — Pull the slot machine\n` +
                `**\`${prefix}roulette <bet> <color/number>\`** — Spin the wheel\n` +
                `**\`${prefix}dice <bet> <over/under> <number>\`** — Roll the dice\n` +
                `**\`${prefix}coinflip <bet> <heads/tails>\`** — Flip a coin\n` +
                `**\`${prefix}crash <bet>\`** — Ride the multiplier & cash out\n` +
                `**\`${prefix}mines <bet> <mines>\`** — Navigate the minefield\n` +
                `**\`${prefix}wildwest @user <bet>\`** — 1v1 duel (fastest draw wins)`,
            },
            {
              name: "🐾 Pets",
              value:
                `**\`${prefix}pet\`** — View your pet\n` +
                `**\`${prefix}pet shop\`** / **\`${prefix}pet buy <id>\`** — Adopt a pet\n` +
                `**\`${prefix}pet name <name>\`** — Rename your pet\n` +
                `**\`${prefix}pet gift @user\`** — Trade/gift your pet\n` +
                `Chat in the server to level your pet up!`,
            },
            {
              name: "🌐 Web Casino",
              value:
                `**\`${prefix}web\`** — Get the website link (sent to your DMs)\n` +
                `Link: **https://sirgreen.online**\n` +
                `Case Battles · Slots (Candy Cascade, Thunder Gods, Wild Bandit) · ` +
                `House Games (Plinko, Mines, Coinflip, HiLo, Double or Nothing)`
            }
          )
          .setFooter({ text: `Use ${prefix}help to see this again` }),
      ],
    });
  },
};
