import { COLORS } from "../src/theme.mjs";

const WEB_URL = "https://sirgreen.online";

export default {
  name: "web",
  aliases: ["games", "casino", "lobby", "website"],
  description: "Get the SirGreen Casino website link in your DMs.",

  async execute({ message, embed }) {
    // Send the link privately so it's tied to the user's session/device.
    let delivered = false;
    try {
      const dm = await message.author.createDM?.().catch(() =>
        // Fluxer may expose a fetch-based DM opener instead of createDM
        message.author.send ? null : null
      );
      const target = dm ?? message.author;
      await target.send({
        embeds: [
          embed(COLORS.accent)
            .setTitle("🎰 SirGreen Casino")
            .setDescription(`Here's the website link:\n\n**${WEB_URL}**`)
            .setFooter({ text: "SirGreen Casino" }),
        ],
      });
      delivered = true;
    } catch (e) {
      console.error("[web] DM failed:", e?.message ?? e);
    }

    // Confirm in-channel either way, so the user isn't left guessing.
    return message.channel.send({
      embeds: [
        delivered
          ? embed(COLORS.primary).setDescription("✅ Sent you the website link in DMs — check your messages.")
          : embed(COLORS.error).setDescription(`I couldn't DM you (DMs may be closed). Here's the link directly: **${WEB_URL}**`),
      ],
    });
  },
};
