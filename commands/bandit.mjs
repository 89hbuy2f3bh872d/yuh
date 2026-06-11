import { COLORS } from "../src/theme.mjs";
import crypto from "crypto";

export default {
  name: "bandit",
  aliases: ["slot", "web"],
  description: "Get a link to play Le Bandit in your browser.",

  async execute({ message, db, embed, webHost, webPort }) {
    const uid = message.author.id;
    const token = crypto.randomBytes(24).toString("hex");

    // store token with 10-minute TTL
    await db.createSession(uid, token, 10 * 60 * 1000);

    const url = `http://${webHost}:${webPort}/play?t=${token}&u=${uid}`;

    try {
      await message.author.send({ embeds: [
        embed(COLORS.accent)
          .setTitle("🎰 Le Bandit")
          .setDescription(`[Click here to play](${url})\n\n⏳ Link expires in **10 minutes**.\nLogin is automatic via your Discord identity.`)
      ]});
      return message.channel.send({ embeds: [
        embed(COLORS.primary).setDescription("✅ Check your DMs for your Le Bandit link!")
      ]});
    } catch {
      return message.channel.send({ embeds: [
        embed(COLORS.error).setDescription("❌ Couldn't DM you. Enable DMs from server members.")
      ]});
    }
  },
};
