export default {
  name: "pay",
  aliases: ["give", "transfer"],
  description: "Send FluxCoins to another user. `&pay @user <amount>`",
  async execute({ message, args, db, embed, prefix }) {
    const target = message.mentions?.users?.first();
    const uid = message.author.id;

    if (!target || target.bot)
      return message.channel.send({ embeds: [embed(0xe74c3c).setDescription(`❌ Usage: \`${prefix}pay @user <amount>\``)] });
    if (target.id === uid)
      return message.channel.send({ embeds: [embed(0xe74c3c).setDescription("❌ You can't pay yourself.")] });

    const rawAmt = args[1]?.toLowerCase();
    const user = await db.getUser(uid);
    let amount;
    if (rawAmt === "all")  amount = user.balance;
    else if (rawAmt === "half") amount = Math.floor(user.balance / 2);
    else {
      const m = rawAmt?.match(/^([\d.]+)(k|m)?$/);
      if (!m) return message.channel.send({ embeds: [embed(0xe74c3c).setDescription(`❌ Usage: \`${prefix}pay @user <amount|half|all>\``)] });
      amount = Math.floor(parseFloat(m[1]) * (m[2] === "m" ? 1_000_000 : m[2] === "k" ? 1_000 : 1));
    }

    if (!amount || amount <= 0)
      return message.channel.send({ embeds: [embed(0xe74c3c).setDescription("❌ Amount must be greater than 0.")] });

    const ok = await db.transfer(uid, target.id, amount);
    if (!ok)
      return message.channel.send({ embeds: [embed(0xe74c3c).setDescription("❌ Insufficient FluxCoins.")] });

    return message.channel.send({ embeds: [
      embed(0x2ecc71)
        .setTitle("💸 Transfer Complete")
        .setDescription(`**${message.author.username}** sent **${amount.toLocaleString()} FC** to **${target.username}**.`)
    ]});
  },
};
