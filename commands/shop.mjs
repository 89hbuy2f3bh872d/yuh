import { COLORS } from "../src/theme.mjs";

// Server role shop. Owners curate roles for sale (`&shop add @role <price>`); members
// buy them with FC (`&shop buy <#|name>`). 75% of the price goes to the server bank,
// the other 25% is a sink (removed from circulation). Role assignment uses the bot's
// Manage Roles permission; the bot's top role must sit above any sellable role.

function parseAmount(str) {
  if (!str) return NaN;
  const s = String(str).toLowerCase().replace(/,/g, "");
  const m = s.match(/^([\d.]+)([km]?)$/);
  if (!m) return NaN;
  let v = parseFloat(m[1]);
  if (m[2] === "k") v *= 1e3;
  if (m[2] === "m") v *= 1e6;
  return Math.floor(v);
}

// Resolve a buy/remove target: 1–2 digit number = list index; role mention/17–20-digit
// id = role id; otherwise match by stored name (case-insensitive).
function findItem(shop, arg) {
  if (!arg) return null;
  arg = arg.trim();
  if (/^\d{1,2}$/.test(arg)) { const n = parseInt(arg, 10); if (n >= 1 && n <= shop.length) return shop[n - 1]; }
  const id = (arg.match(/^<@&(\d+)>$/)?.[1]) || (/^\d{17,20}$/.test(arg) ? arg : null);
  if (id) return shop.find(r => r.roleId === id) || null;
  return shop.find(r => String(r.name || "").toLowerCase() === arg.toLowerCase()) || null;
}

export default {
  name: "shop",
  aliases: ["roleshop", "rs"],
  description: "Server role shop — buy roles with FC. Owners: `&shop add @role <price>`.",

  async execute({ message, args, db, config, embed }) {
    const gid = message.guild?.id ?? message.guildId ?? null;
    const send = (color, desc, title) => {
      const e = embed(color).setDescription(desc);
      if (title) e.setTitle(title);
      return message.channel.send({ embeds: [e] });
    };
    if (!gid) return send(COLORS.error, "❌ Use this in a server.");
    const uid = message.author.id;
    const isOwner = (message.guild?.ownerId === uid) || (Array.isArray(config?.owners) && config.owners.includes(uid));
    const sub = (args[0] || "").toLowerCase();

    // ── owner: add a role ──────────────────────────────────────────────────
    if (sub === "add") {
      if (!isOwner) return send(COLORS.error, "❌ Only the server owner can manage the shop.");
      const roleArg = args[1], price = parseAmount(args[2]);
      if (!roleArg || !(price > 0)) return send(COLORS.warn, "Usage: `&shop add @role <price>` (e.g. `&shop add @VIP 50k`)");
      if (price > 1_000_000_000) return send(COLORS.error, "❌ Price too high.");
      let roleId = null;
      try { roleId = await message.guild.roles.resolveRoleId(roleArg); } catch { roleId = null; }
      if (!roleId) return send(COLORS.error, "❌ Couldn't find that role. Mention it or give its exact name/id.");
      if (roleId === gid) return send(COLORS.error, "❌ You can't sell the @everyone role.");
      let role = message.guild.roles?.get?.(roleId);
      if (!role) { try { role = await message.guild.roles.fetchRole(roleId); } catch { /* keep null */ } }
      const name = role?.name || "Role";
      const shop = await db.getRoleShop(gid);
      if (shop.some(r => r.roleId === roleId)) return send(COLORS.warn, `ℹ️ **${name}** is already in the shop.`);
      if (shop.length >= 25) return send(COLORS.error, "❌ The shop is full (25 roles max).");
      shop.push({ roleId, name, price });
      await db.setRoleShop(gid, shop);
      return send(COLORS.primary, `✅ Added **${name}** to the shop for **${price.toLocaleString()} FC**.`, "Role added");
    }

    // ── owner: remove a role ───────────────────────────────────────────────
    if (sub === "remove" || sub === "delete") {
      if (!isOwner) return send(COLORS.error, "❌ Only the server owner can manage the shop.");
      const shop = await db.getRoleShop(gid);
      const item = findItem(shop, args.slice(1).join(" "));
      if (!item) return send(COLORS.error, "❌ Couldn't find that role in the shop. Use `&shop` to see the list.");
      await db.setRoleShop(gid, shop.filter(r => r.roleId !== item.roleId));
      return send(COLORS.primary, `✅ Removed **${item.name}** from the shop.`);
    }

    // ── buy a role ─────────────────────────────────────────────────────────
    if (sub === "buy" || sub === "purchase" || sub === "b") {
      const shop = await db.getRoleShop(gid);
      const item = findItem(shop, args.slice(1).join(" "));
      if (!item) return send(COLORS.error, "❌ That role isn't in the shop. Use `&shop` to see what's available.");
      const member = message.member || await message.guild.members?.fetch?.(uid).catch(() => null);
      if (!member?.roles?.add) return send(COLORS.error, "❌ Couldn't resolve your membership — try again.");
      if (member.roles.has?.(item.roleId)) return send(COLORS.warn, `ℹ️ You already own **${item.name}**.`);
      // Assign first (cheap to undo), then charge — so a failed charge just removes the role.
      try { await member.roles.add(item.roleId); }
      catch { return send(COLORS.error, "❌ I couldn't assign that role. Make sure my role is **above** it and I have **Manage Roles**."); }
      let r;
      try { r = await db.rolePurchase(uid, gid, item.price); } catch { r = { ok: false }; }
      if (!r?.ok) {
        try { await member.roles.remove(item.roleId); } catch { /* best-effort undo */ }
        return send(COLORS.error, r?.error === "insufficient" ? `❌ You need **${item.price.toLocaleString()} FC** for that role.` : "❌ Purchase failed — nothing was charged.");
      }
      return message.channel.send({ embeds: [
        embed(COLORS.primary)
          .setTitle("🛒 Purchase complete")
          .setDescription(`You bought <@&${item.roleId}> for **${item.price.toLocaleString()} FC**.\n**${Number(r.banked || 0).toLocaleString()} FC** went to the server bank.`)
          .setFooter({ text: `Balance: ${Number(r.bal || 0).toLocaleString()} FC` }),
      ] });
    }

    // ── default: list the shop ─────────────────────────────────────────────
    const shop = await db.getRoleShop(gid);
    if (!shop.length) {
      return send(COLORS.accent, isOwner
        ? "This server has no shop roles yet.\nAdd one: `&shop add @role <price>`"
        : "This server's shop is empty.", "🛒 Server Shop");
    }
    const lines = shop.map((r, i) => `**${i + 1}.** <@&${r.roleId}> — **${r.price.toLocaleString()} FC**`).join("\n");
    const e = embed(COLORS.dark)
      .setTitle("🛒 Server Shop")
      .setDescription(lines + "\n\nBuy with `&shop buy <number>` (75% goes to the server bank)." + (isOwner ? "\nManage: `&shop add @role <price>` · `&shop remove <number>`" : ""));
    return message.channel.send({ embeds: [e] });
  },
};
