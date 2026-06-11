import { COLORS } from "../src/theme.mjs";

const CATEGORIES = [
  { label: "🎰  Games",    names: ["slots","blackjack","coinflip","crash","dice","roulette"] },
  { label: "💰  Economy",  names: ["balance","daily","pay","leaderboard"] },
  { label: "🌐  Web",      names: ["bandit"] },
  { label: "ℹ️   Info",    names: ["help"] },
];

export default {
  name: "help",
  aliases: ["commands", "cmds"],
  description: "Show all commands.",
  async execute({ message, embed, prefix, commands }) {
    const byName = new Map();
    for (const cmd of new Set(commands.values())) byName.set(cmd.name, cmd);

    const fields = [];
    for (const cat of CATEGORIES) {
      const lines = [];
      for (const name of cat.names) {
        const cmd = byName.get(name);
        if (!cmd) continue;
        const aliases = cmd.aliases?.length
          ? " " + cmd.aliases.map(a => `\`${prefix}${a}\``).join(" ")
          : "";
        lines.push(`\`${prefix}${cmd.name}\`${aliases}\n┗ ${cmd.description ?? "No description."}`);
      }
      if (lines.length) fields.push({ name: cat.label, value: lines.join("\n"), inline: false });
    }

    // Fallback: anything not in a category
    const categorised = CATEGORIES.flatMap(c => c.names);
    const extras = [];
    for (const cmd of byName.values()) {
      if (!categorised.includes(cmd.name)) {
        extras.push(`\`${prefix}${cmd.name}\` — ${cmd.description ?? "No description."}`);
      }
    }
    if (extras.length) fields.push({ name: "📦  Other", value: extras.join("\n"), inline: false });

    await message.channel.send({
      embeds: [
        embed(COLORS.dark)
          .setTitle("🟢  SirGreen Casino — Commands")
          .addFields(fields)
          .setFooter({ text: `FluxCoins (FC)  ·  Prefix: ${prefix}  ·  &bandit to open the slot machine` })
      ]
    });
  },
};
