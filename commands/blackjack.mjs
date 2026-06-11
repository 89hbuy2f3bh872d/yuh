import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getOrCreate, addBalance, recordResult, fmt } from "../src/Database.mjs";
import { parseBet } from "../src/Utils.mjs";
import { RTP, baitAfterLoss, baitAfterWin } from "../src/HouseEdge.mjs";

const SUITS = ["♠","♥","♦","♣"];
const RANKS = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
const DECK = SUITS.flatMap(s => RANKS.map(r => `${r}${s}`));
function shuffle(arr) { return [...arr].sort(() => Math.random() - 0.5); }
function value(card) {
  const r = card.slice(0, -1);
  if (["J","Q","K"].includes(r)) return 10;
  if (r === "A") return 11;
  return parseInt(r);
}
function handValue(hand) {
  let total = hand.reduce((s, c) => s + value(c), 0);
  let aces = hand.filter(c => c.startsWith("A")).length;
  while (total > 21 && aces-- > 0) total -= 10;
  return total;
}
const games = new Map();

export const command = new CommandBuilder()
  .setName("blackjack")
  .addAliases("bj", "21")
  .setDescription("Play Blackjack vs the dealer. After deal: !bj hit | stand | double.")
  .addStringOption(o => o.setName("action").setDescription("bet amount, hit, stand, or double").setRequired(true))
  .setCategory("casino");

export async function run(msg, data) {
  const userId = msg.message.author.id;
  const username = msg.message.author.username ?? userId;
  const action = data.get("action")?.value?.toLowerCase();
  const user = await getOrCreate(userId, username);

  if (games.has(userId)) {
    const g = games.get(userId);
    if (action === "hit") {
      g.player.push(g.deck.pop());
      const pv = handValue(g.player);
      if (pv > 21) {
        games.delete(userId);
        await recordResult(userId, 0, g.bet);
        const embed = new EmbedBuilder().setColor(0xff4444).setTitle("🃏 Blackjack — Bust!")
          .setDescription(`Your hand: ${g.player.join(" ")} (${pv})\nBust! You lost **${fmt(g.bet)} Flux**.\n\n${baitAfterLoss()}`);
        return msg.reply({ embeds: [embed] });
      }
      const embed = new EmbedBuilder().setColor(0x3399ff).setTitle("🃏 Blackjack — Hit")
        .setDescription(`Your hand: ${g.player.join(" ")} (**${pv}**)\nDealer shows: ${g.dealer[0]}\n\nType \`!bj hit\`, \`!bj stand\`, or \`!bj double\`.`);
      return msg.reply({ embeds: [embed] });
    }

    if (action === "double") {
      if (user.balance < g.bet) return msg.reply("❌ Not enough Flux to double.");
      await addBalance(userId, -g.bet);
      g.bet *= 2;
      g.player.push(g.deck.pop());
    }

    if (action === "stand" || action === "double") {
      while (handValue(g.dealer) < 17 || (handValue(g.dealer) === 17 && g.dealer.some(c => c.startsWith("A")))) g.dealer.push(g.deck.pop());
      const pv = handValue(g.player);
      const dv = handValue(g.dealer);
      games.delete(userId);
      let outcome, payout, color;
      const didWin = pv <= 21 && (dv > 21 || pv > dv);
      const push = pv === dv && pv <= 21;
      if (push) {
        await addBalance(userId, g.bet);
        outcome = "Push — bet returned."; payout = 0; color = 0xffaa00;
      } else if (didWin) {
        const mult = pv === 21 && g.player.length === 2 ? 2.4 : 2.0;
        payout = Math.floor(g.bet * mult * RTP.blackjack);
        await addBalance(userId, payout);
        await recordResult(userId, payout - g.bet, 0);
        outcome = `You won **+${fmt(payout - g.bet)} Flux**! ${baitAfterWin()}`;
        color = 0xf5c518;
      } else {
        payout = 0;
        await recordResult(userId, 0, g.bet);
        outcome = `You lost **${fmt(g.bet)} Flux**. ${baitAfterLoss()}`;
        color = 0xff4444;
      }
      const embed = new EmbedBuilder().setColor(color).setTitle("🃏 Blackjack — Result")
        .setDescription(`Your hand: ${g.player.join(" ")} (**${pv}**)\nDealer hand: ${g.dealer.join(" ")} (**${dv}**)\n\n${outcome}`);
      return msg.reply({ embeds: [embed] });
    }

    return msg.reply("❌ You have an active game. Use `!bj hit`, `!bj stand`, or `!bj double`.");
  }

  const bet = parseBet(action, user.balance);
  if (!bet || bet < 1) return msg.reply("❌ No active game. Start one: `!bj <amount>`.");
  if (bet > user.balance) return msg.reply(`❌ You only have **${fmt(user.balance)} Flux**.`);

  await addBalance(userId, -bet);
  const deck = shuffle(DECK);
  const player = [deck.pop(), deck.pop()];
  const dealer = [deck.pop(), deck.pop()];
  games.set(userId, { deck, player, dealer, bet });

  const pv = handValue(player);
  if (pv === 21) {
    const dv = handValue(dealer);
    games.delete(userId);
    if (dv === 21) {
      await addBalance(userId, bet);
      const embed = new EmbedBuilder().setColor(0xffaa00).setTitle("🃏 Blackjack — Push!")
        .setDescription(`Both hit Blackjack! Bet returned.\nYour: ${player.join(" ")} | Dealer: ${dealer.join(" ")}`);
      return msg.reply({ embeds: [embed] });
    }
    const payout = Math.floor(bet * 2.4 * RTP.blackjack);
    await addBalance(userId, payout);
    await recordResult(userId, payout - bet, 0);
    const embed = new EmbedBuilder().setColor(0xf5c518).setTitle("🃏 Blackjack — Natural!")
      .setDescription(`${player.join(" ")} (**21**) — Natural Blackjack!\nYou won **+${fmt(payout - bet)} Flux**!\n\n${baitAfterWin()}`);
    return msg.reply({ embeds: [embed] });
  }

  const embed = new EmbedBuilder().setColor(0x3399ff).setTitle("🃏 Blackjack — New Game")
    .setDescription(`Your hand: ${player.join(" ")} (**${pv}**)\nDealer shows: ${dealer[0]}\n\nType \`!bj hit\`, \`!bj stand\`, or \`!bj double\`.`);
  msg.reply({ embeds: [embed] });
}
