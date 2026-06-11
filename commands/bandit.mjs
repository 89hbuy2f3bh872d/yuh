import { COLORS } from "../src/theme.mjs";
export default {
  name: "bandit",
  aliases: ["lebandit", "machine"],
  description: "Get a private Le Bandit slot machine link (sent via DM).",
  async execute({ message, embed, config, client }) {
    // Access webServer through client since we attach it there
    const web = message.client?._web ?? globalThis.__web;
    const port = config.webPort ?? 3420;
    const host = config.webHost ?? "localhost";
    const token = await web?.issueToken(message.author.id);
    if (!token) return message.channel.send({ embeds: [embed(COLORS.error).setDescription("❌ Web server not running.")] });
    const url = `http://${host}:${port}/bandit?t=${token}`;
    try {
      await message.author.send({ embeds: [
        embed(COLORS.dark)
          .setTitle("🎰 Le Bandit — Your Private Link")
          .setDescription(`**[Click here to open Le Bandit](${url})**\n\nThis link expires in **10 minutes** and works only once.\nDo not share it — it's linked to your account.`)
          .setFooter({ text: "Authenticated via Fluxer · SirGreen Casino" })
      ]});
      return message.channel.send({ embeds: [embed(COLORS.accent).setDescription("🔒 Your Le Bandit link has been DMed to you!")] });
    } catch {
      return message.channel.send({ embeds: [embed(COLORS.error).setDescription("❌ I can't DM you. Enable DMs from server members and try again.") ] });
    }
  },
};
