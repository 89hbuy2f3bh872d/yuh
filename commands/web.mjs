import { COLORS } from "../src/theme.mjs";
import crypto from "crypto";

const WEB_URL = "https://sirgreen.online";

export default {
  name: "web",
  aliases: ["games", "casino", "lobby", "website"],
  description: "Get a casino login link in your DMs (scoped to this server).",

  async execute({ message, embed, db }) {
    const uid = message.author.id;
    const guildId = message.guild?.id ?? message.guildId ?? null;

    // In a server → mint a one-time, server-scoped login link (logs in + selects this
    // server's pool). In DMs → just the plain site link.
    let link = WEB_URL, scoped = false;
    if (guildId && db?.createLoginToken) {
      const token = crypto.randomBytes(24).toString("hex");
      await db.createLoginToken(token, uid, guildId, 10 * 60 * 1000).catch(() => {});
      link = `${WEB_URL}/s/${token}`;
      scoped = true;
    }

    let delivered = false;
    try {
      const dm = await message.author.createDM?.().catch(() => null);
      const target = dm ?? message.author;
      await target.send({
        embeds: [
          embed(COLORS.accent)
            .setTitle("🎰 SirGreen Casino")
            .setDescription(scoped
              ? `Tap to open the casino for **${message.guild?.name ?? "this server"}** — you'll be logged in and playing on this server's pool:\n\n**${link}**\n\n_Link expires in 10 minutes._`
              : `Here's the website link:\n\n**${link}**`)
            .setFooter({ text: "SirGreen Casino" }),
        ],
      });
      delivered = true;
    } catch (e) { console.error("[web] DM failed:", e?.message ?? e); }

    return message.channel.send({
      embeds: [
        delivered
          ? embed(COLORS.primary).setDescription("✅ Sent your casino link in DMs — check your messages.")
          : embed(COLORS.error).setDescription(`I couldn't DM you (DMs may be closed). Open the casino here: **${link}**`),
      ],
    });
  },
};
