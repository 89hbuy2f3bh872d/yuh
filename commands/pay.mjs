function parseAmount(str, balance) {
  if (str === "all")  return balance;
  if (str === "half") return Math.floor(balance / 2);
  const m = str.match(/^([\d.]+)([km]?)$/i);
  if (!m) return NaN;
  let n = parseFloat(m[1]);
  if (m[2].toLowerCase() === "k") n *= 1_000;
  if (m[2].toLowerCase() === "m") n *= 1_000_000;
  return Math.floor(n);
}

export default {
  name: "pay",
  aliases: ["give", "transfer"],
  description: "Send Flux to another user. Usage: !pay @user <amount|all|half|1k>",
  async execute({ message, args, db, embed }) {
    const target = message.mentions?.users?.first?.() ?? message.mentions?.[0];
    if (!target) return message.channel.send({ embeds: [embed(0xe74c3c).setDescription("❌ Mention a user to pay.")] });
    if (target.id === message.author.id) return message.channel.send({ embeds: [embed(0xe74c3c).setDescription("❌ You can't pay yourself.")] });

    const sender = await db.getUser(message.author.id);
    const rawAmt = args[1] ?? args[0];
    const amount = parseAmount(rawAmt, sender.balance);

    if (!rawAmt || isNaN(amount) || amount <= 0)
      return message.channel.send({ embeds: [embed(0xe74c3c).setDescription("❌ Provide a valid amount (e.g. `500`, `1k`, `all`, `half`).")] });
    if (amount > sender.balance)
      return message.channel.send({ embeds: [embed(0xe74c3c).setDescription(`❌ You only have **${sender.balance.toLocaleString()} Flux**.`)] });

    const ok = await db.transfer(message.author.id, target.id, amount);
    if (!ok) return message.channel.send({ embeds: [embed(0xe74c3c).setDescription("❌ Transfer failed.")] });

    message.channel.send({ embeds: [
      embed(0x3498db)
        .setTitle("💸 Transfer Complete")
        .setDescription(`**${message.author.username}** → **${target.username}**: **${amount.toLocaleString()} Flux**`)
    ]});
  },
};
