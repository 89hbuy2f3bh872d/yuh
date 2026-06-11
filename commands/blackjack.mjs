import { HouseEdge } from "../src/HouseEdge.mjs";

const SUITS = ["♠","♥","♦","♣"];
const VALUES = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];

function newDeck() {
  const d = [];
  for (const s of SUITS) for (const v of VALUES) d.push({ s, v });
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function cardValue(card) {
  if (["J","Q","K"].includes(card.v)) return 10;
  if (card.v === "A") return 11;
  return parseInt(card.v);
}

function handTotal(hand) {
  let t = hand.reduce((s, c) => s + cardValue(c), 0);
  let aces = hand.filter(c => c.v === "A").length;
  while (t > 21 && aces > 0) { t -= 10; aces--; }
  return t;
}

function fmt(hand) { return hand.map(c => `${c.v}${c.s}`).join(" "); }

const sessions = new Map();

export default {
  name: "blackjack",
  aliases: ["bj"],
  description: "Play blackjack. !bj <bet> | !bj hit | !bj stand | !bj double",
  async execute({ message, args, db, embed }) {
    const uid = message.author.id;
    const sub = args[0]?.toLowerCase();

    // Start new game
    if (!sessions.has(uid) || !["hit","stand","double","h","s","d"].includes(sub)) {
      const bet = parseInt(sub);
      const user = await db.getUser(uid);
      if (isNaN(bet) || bet <= 0) return message.channel.send({ embeds: [embed(0xe74c3c).setDescription("❌ Provide a valid bet, e.g. `!bj 500`.")] });
      if (bet > user.balance)     return message.channel.send({ embeds: [embed(0xe74c3c).setDescription("❌ Insufficient balance.")] });
      if (bet > 500_000)          return message.channel.send({ embeds: [embed(0xe74c3c).setDescription("❌ Max bet is **500,000 Flux**.")] });

      const deck = newDeck();
      const player = [deck.pop(), deck.pop()];
      const dealer = [deck.pop(), deck.pop()];
      sessions.set(uid, { deck, player, dealer, bet, doubled: false });

      if (handTotal(player) === 21) {
        sessions.delete(uid);
        const payout = Math.floor(bet * 1.5);
        await db.updateBalance(uid, payout);
        await db.recordGame(uid, true, bet + payout);
        return message.channel.send({ embeds: [
          embed(0xf1c40f).setTitle("🃏 Blackjack — NATURAL 21! 🎉")
            .setDescription(`Your hand: **${fmt(player)}** (21)\n+**${payout.toLocaleString()} Flux**\n${HouseEdge.baitWin()}`)
        ]});
      }

      return message.channel.send({ embeds: [
        embed(0x3498db).setTitle("🃏 Blackjack")
          .setDescription(
            `Your hand: **${fmt(player)}** (${handTotal(player)})\n` +
            `Dealer shows: **${fmt([dealer[0]])}**\n\n` +
            `Type \`!bj hit\`, \`!bj stand\`, or \`!bj double\``
          )
      ]});
    }

    // In-game actions
    const sess = sessions.get(uid);
    const { deck, player, dealer, bet } = sess;

    if (["hit","h"].includes(sub) || (["double","d"].includes(sub))) {
      if (["double","d"].includes(sub)) {
        const user = await db.getUser(uid);
        if (user.balance < bet) return message.channel.send({ embeds: [embed(0xe74c3c).setDescription("❌ Not enough Flux to double.")] });
        sess.bet = bet * 2;
        sess.doubled = true;
      }
      player.push(deck.pop());
      const ptotal = handTotal(player);

      if (ptotal > 21) {
        sessions.delete(uid);
        await db.updateBalance(uid, -sess.bet);
        await db.recordGame(uid, false, sess.bet);
        return message.channel.send({ embeds: [
          embed(0xe74c3c).setTitle("🃏 Blackjack — BUST")
            .setDescription(`Your hand: **${fmt(player)}** (${ptotal}) — bust!\n-**${sess.bet.toLocaleString()} Flux**\n${HouseEdge.baitLoss()}`)
        ]});
      }

      if (sess.doubled) {
        // Auto-stand after double
        sub === "d" && (args[0] = "stand");
      } else {
        return message.channel.send({ embeds: [
          embed(0x3498db).setTitle("🃏 Blackjack")
            .setDescription(
              `Your hand: **${fmt(player)}** (${ptotal})\n` +
              `Dealer shows: **${fmt([dealer[0]])}**\n\n` +
              `Type \`!bj hit\` or \`!bj stand\``
            )
        ]});
      }
    }

    if (["stand","s"].includes(sub) || sess.doubled) {
      sessions.delete(uid);
      // Dealer draws to soft 17
      while (handTotal(dealer) < 17) dealer.push(deck.pop());

      const ptotal = handTotal(player);
      const dtotal = handTotal(dealer);
      const won = ptotal > dtotal || dtotal > 21;
      const push = ptotal === dtotal;

      if (push) {
        return message.channel.send({ embeds: [
          embed(0x95a5a6).setTitle("🃏 Blackjack — PUSH")
            .setDescription(`You: **${fmt(player)}** (${ptotal}) | Dealer: **${fmt(dealer)}** (${dtotal})\nBet returned.`)
        ]});
      }

      if (won) {
        await db.updateBalance(uid, sess.bet);
        await db.recordGame(uid, true, sess.bet * 2);
        message.channel.send({ embeds: [
          embed(0x2ecc71).setTitle("🃏 Blackjack — WIN!")
            .setDescription(`You: **${fmt(player)}** (${ptotal}) | Dealer: **${fmt(dealer)}** (${dtotal})\n+**${sess.bet.toLocaleString()} Flux**\n${HouseEdge.baitWin()}`)
        ]});
      } else {
        await db.updateBalance(uid, -sess.bet);
        await db.recordGame(uid, false, sess.bet);
        message.channel.send({ embeds: [
          embed(0xe74c3c).setTitle("🃏 Blackjack — LOSS")
            .setDescription(`You: **${fmt(player)}** (${ptotal}) | Dealer: **${fmt(dealer)}** (${dtotal})\n-**${sess.bet.toLocaleString()} Flux**\n${HouseEdge.baitLoss()}`)
        ]});
      }
    }
  },
};
