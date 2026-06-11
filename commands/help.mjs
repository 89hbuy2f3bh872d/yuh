export default {
  name: "help",
  aliases: ["commands", "cmds"],
  description: "List all available commands.",
  async execute({ message, embed, prefix, commands }) {
    const seen = new Set();
    const list = [];
    for (const cmd of commands.values()) {
      if (seen.has(cmd.name)) continue;
      seen.add(cmd.name);
      const aliases = cmd.aliases?.length ? ` (${cmd.aliases.map(a => `\`${prefix}${a}\``).join(", ")})` : "";
      list.push(`**\`${prefix}${cmd.name}\`**${aliases} — ${cmd.description ?? "No description."}`);
    }
    list.sort();
    await message.channel.send({
      embeds: [
        embed(0x5865f2)
          .setTitle("🎰 Fluxer Casino — Commands")
          .setDescription(list.join("\n"))
          .setFooter({ text: `All currency is in FluxCoins (FC) · Prefix: ${prefix}` })
      ]
    });
  },
};
