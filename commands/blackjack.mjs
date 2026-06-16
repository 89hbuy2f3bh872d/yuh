import { COLORS } from "../src/theme.mjs";
import { HouseEdge } from "../src/HouseEdge.mjs";

// RTP ~90% — achieved by the dealer hitting on soft 17 and the house
// winning all ties (surrender pays 0 instead of the standard half-back).

const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];

function buildDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ r, s });
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function cardVal(r) {
  if (r === "A") return 11;
  if (["J","Q","K"].includes(r)) return 10;
  return parseInt(r, 10);
}

function handVal(hand) {
  let total = 0, aces = 0;
  for (const c of hand) {
    total += cardVal(c.r);
    if (c.r === "A") aces++;
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

function fmt(hand) { return hand.map(c => `${c.r}${c.s}`).join(" "); }

const _games = new Map(); // uid -> game state
const MIN_BET = 10;

export default {
  name: "blackjack",
  aliases: ["bj"],
  description: "Play Blackjack. `&blackjack <bet>` then `&bj hit/stand`.",

  async execute({ message, args, db, embed }) {
    const uid = message.author.id;

    // --- Ongoing game actions ---
    const action = args[0]?.toLowerCase();
    if (_games.has(uid) && ["hit","h","stand","s","stay"].includes(action)) {
      const g = _games.get(uid);

      if (["hit","h"].includes(action)) {
        g.player.push(g.deck.pop());
        const pv = handVal(g.player);

        if (pv > 21) {
          _games.delete(uid);
          await db.updateBalance(uid, -g.bet);
          await db.recordGame(uid, false, g.bet);
          return message.channel.send({ embeds: [
            embed(COLORS.error)
              .setTitle("💥 Bust!")
              .setDescription(
                `Your hand: ${fmt(g.player)} = **${pv}**\n` +
                `You went over 21 and lost **${g.bet.toLocaleString()} FC**.\n` +
                HouseEdge.baitLoss()
              )
          ]});
        }

        return message.channel.send({ embeds: [
          embed(COLORS.primary)
            .setTitle("🃏 Blackjack")
            .setDescription(
              `Your hand: ${fmt(g.player)} = **${pv}**\n` +
              `Dealer shows: **${fmt([g.dealer[0]])}** + 🂠\n\n` +
              `Type \`&bj hit\` or \`&bj stand\`.`
            )
        ]});
      }

      // Stand — dealer plays
      _games.delete(uid);
      const d = g.deck;
      // Dealer hits on soft 17 (house-favourable rule)
      while (handVal(g.dealer) < 17) g.dealer.push(d.pop());

      const pv = handVal(g.player);
      const dv = handVal(g.dealer);

      let result, delta, titleEmoji;
      if (dv > 21 || pv > dv) {
        // Player wins — pay 1:1
        delta = g.bet;
        result = `🏆 You win **+${delta.toLocaleString()} FC**!\n${HouseEdge.baitWin()}`;
        titleEmoji = "🏆 You Win!";
      } else {
        // Push (tie) → house wins. Bust already handled above.
        delta = -g.bet;
        result = `House wins (**-${g.bet.toLocaleString()} FC**).\n${HouseEdge.baitLoss()}`;
        titleEmoji = pv === dv ? "🤝 Tie — House Wins" : "🏦 Dealer Wins";
      }

      await db.updateBalance(uid, delta);
      await db.recordGame(uid, delta > 0, Math.abs(delta));
      const user = await db.getUser(uid);

      return message.channel.send({ embeds: [
        embed(delta > 0 ? COLORS.primary : COLORS.error)
          .setTitle(titleEmoji)
          .setDescription(
            `Your hand: ${fmt(g.player)} = **${pv}**\n` +
            `Dealer hand: ${fmt(g.dealer)} = **${dv}**\n\n` +
            `${result}\n💰 Balance: **${Math.floor(user.bal).toLocaleString()} FC**`
          )
      ]});
    }

    // --- New game ---
    if (_games.has(uid)) {
      return message.channel.send({ embeds: [
        embed(COLORS.warn).setDescription("⚠️ You already have a game in progress. Type `&bj hit` or `&bj stand`.")
      ]});
    }

    const betArg = parseInt(args[0], 10);
    if (!betArg || betArg < MIN_BET) {
      return message.channel.send({ embeds: [
        embed(COLORS.warn).setDescription(`⚠️ Usage: \`&blackjack <bet>\` (min ${MIN_BET} FC).`)
      ]});
    }

    const user = await db.getUser(uid);
    if ((user.bal ?? 0) < betArg) {
      return message.channel.send({ embeds: [
        embed(COLORS.error).setDescription("❌ Not enough FC. Try `&work` to earn some.")
      ]});
    }

    const deck = buildDeck();
    const player = [deck.pop(), deck.pop()];
    const dealer = [deck.pop(), deck.pop()];

    // Immediate blackjack check — natural 21
    if (handVal(player) === 21) {
      const dv = handVal(dealer);
      const won = dv !== 21;
      const delta = won ? Math.floor(betArg * 1.5) : -betArg; // BJ pays 3:2, tie → lose
      await db.updateBalance(uid, delta);
      await db.recordGame(uid, won, Math.abs(delta));
      const u2 = await db.getUser(uid);
      return message.channel.send({ embeds: [
        embed(won ? COLORS.primary : COLORS.error)
          .setTitle(won ? "🎉 Blackjack!" : "🤝 Both Blackjack — House Wins")
          .setDescription(
            `Your hand: ${fmt(player)} = **21**\n` +
            `Dealer hand: ${fmt(dealer)} = **${dv}**\n\n` +
            (won ? `You win **+${Math.abs(delta).toLocaleString()} FC** (3:2)!` : `House wins **-${betArg.toLocaleString()} FC**.`) +
            `\n💰 Balance: **${Math.floor(u2.bal).toLocaleString()} FC**`
          )
      ]});
    }

    _games.set(uid, { deck, player, dealer, bet: betArg });

    return message.channel.send({ embeds: [
      embed(COLORS.primary)
        .setTitle("🃏 Blackjack")
        .setDescription(
          `Bet: **${betArg.toLocaleString()} FC**\n\n` +
          `Your hand: ${fmt(player)} = **${handVal(player)}**\n` +
          `Dealer shows: **${fmt([dealer[0]])}** + 🂠\n\n` +
          `Type \`&bj hit\` or \`&bj stand\`.`
        )
    ]});
  },
};
