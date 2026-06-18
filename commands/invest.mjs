import { COLORS } from "../src/theme.mjs";

// Investing — same market + data as the website's Invest tab (the web service runs the
// price engine; this command trades through it over the internal bridge).

const fmt = (n) => Number(n || 0).toLocaleString();
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
function findAsset(assets, arg) {
  if (!arg) return null;
  const a = String(arg).trim().toLowerCase();
  return assets.find(x => x.id.toLowerCase() === a)
    || assets.find(x => x.name.toLowerCase() === a)
    || assets.find(x => x.name.toLowerCase().includes(a)) || null;
}

export default {
  name: "invest",
  aliases: ["market", "stocks", "nft", "portfolio"],
  description: "Invest in NFTs + the FluxCoin index. `&invest buy <asset> <amount>`",

  async execute({ message, args, db, embed }) {
    const uid = message.author.id;
    const send = (color, desc, title) => { const e = embed(color).setDescription(desc); if (title) e.setTitle(title); return message.channel.send({ embeds: [e] }); };

    const data = await db.investMe(uid).catch(() => null);
    const assets = data?.assets;
    if (!assets || !assets.length) return send(COLORS.error, "📉 The market is unavailable right now — try again shortly.");
    const sub = (args[0] || "").toLowerCase();

    // ── buy / sell ─────────────────────────────────────────────────────────
    if (sub === "buy" || sub === "sell") {
      const a = findAsset(assets, args[1]);
      if (!a) return send(COLORS.error, "❌ Unknown asset. Run `&invest` to see the list.");
      let amount;
      if (sub === "buy") {
        amount = parseAmount(args[2]);
        if (!(amount >= 10)) return send(COLORS.warn, `Usage: \`&invest buy ${a.id} <amount>\` (min 10 FC)`);
      } else {
        amount = (args[2] || "").toLowerCase() === "all" ? "all" : parseAmount(args[2]);
        if (amount !== "all" && !(amount > 0)) return send(COLORS.warn, `Usage: \`&invest sell ${a.id} <units|all>\``);
      }
      const r = await db.investTrade(sub, uid, a.id, amount).catch(() => ({ error: "Trade failed" }));
      if (r?.error) return send(COLORS.error, `❌ ${r.error === "insufficient" ? "Not enough FC." : r.error}`);
      if (sub === "buy") {
        return send(COLORS.primary, `Bought **${Number(r.units).toFixed(4)} ${a.emoji} ${a.name}** at **${fmt(a.price)} FC**.\nSpent ${fmt(r.spent)} FC (incl. ${fmt(r.fee)} fee).\nBalance: **${fmt(r.bal)} FC**`, "📈 Bought");
      }
      const pnl = Number(r.pnl || 0);
      return send(COLORS.primary, `Sold **${Number(r.units).toFixed(4)} ${a.emoji} ${a.name}** for **${fmt(r.payout)} FC**.\nP&L: **${pnl >= 0 ? "+" : ""}${fmt(pnl)} FC**\nBalance: **${fmt(r.bal)} FC**`, "📉 Sold");
    }

    // ── portfolio ──────────────────────────────────────────────────────────
    if (sub === "portfolio" || sub === "me" || sub === "bag") {
      const pf = data.portfolio || { positions: [], value: 0, pnl: 0 };
      if (!pf.positions.length) return send(COLORS.accent, "You don't hold any assets yet.\nBuy with `&invest buy <asset> <amount>`.", "💼 Portfolio");
      const lines = pf.positions.map(p => { const a = assets.find(x => x.id === p.id) || { emoji: "", name: p.id }; const pnl = Number(p.pnl); return `${a.emoji} **${a.name}** — ${Number(p.units).toFixed(4)} units · **${fmt(p.value)} FC** (${pnl >= 0 ? "+" : ""}${fmt(pnl)})`; }).join("\n");
      return send(COLORS.dark, `${lines}\n\n**Total: ${fmt(pf.value)} FC** · P&L ${pf.pnl >= 0 ? "+" : ""}${fmt(pf.pnl)} FC`, "💼 Portfolio");
    }

    // ── default: market list + portfolio summary ───────────────────────────
    const lines = assets.map(a => { const ch = Number(a.change || 0) * 100; return `${a.emoji} **${a.name}** \`${a.id}\` — **${fmt(a.price)} FC** ${ch >= 0 ? "📈" : "📉"} ${ch >= 0 ? "+" : ""}${ch.toFixed(1)}%`; }).join("\n");
    const pf = data.portfolio || { value: 0, pnl: 0 };
    const e = embed(COLORS.dark)
      .setTitle("🪙 Invest — live market")
      .setDescription(`${lines}\n\n💼 Your holdings: **${fmt(pf.value)} FC** · P&L ${pf.pnl >= 0 ? "+" : ""}${fmt(pf.pnl)} FC\nBuy \`&invest buy <asset> <amount>\` · Sell \`&invest sell <asset> all\` · Full chart on the website`)
      .setFooter({ text: "Prices move on demand + the market. 2% trade fee." });
    return message.channel.send({ embeds: [e] });
  },
};
