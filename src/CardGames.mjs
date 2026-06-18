// CardGames — server-authoritative card games (Blackjack, Baccarat). Like HouseGames:
// all randomness + resolution live here, the client only renders. Shoes are shuffled
// with crypto.randomInt so outcomes are unpredictable. Balances move in the route layer.
//
// RTP targets (standard rules): Blackjack ≈ 99.5% (dealer stands on all 17, BJ pays 3:2,
// double on any first two). Baccarat: Banker ≈ 98.94% (5% commission), Player ≈ 98.76%,
// Tie pays 8:1 (≈ 85.6%, by design a sucker bet).

import crypto from "node:crypto";

const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUITS = ["S", "H", "D", "C"];
const rint = (n) => crypto.randomInt(n);
function freshShoe(decks) { const c = []; for (let d = 0; d < decks; d++) for (const s of SUITS) for (const r of RANKS) c.push({ r, s }); return c; }
function draw(shoe) { return shoe.splice(rint(shoe.length), 1)[0]; }

// Blackjack helpers
function bjVal(r) { if (r === "A") return 11; if (r === "K" || r === "Q" || r === "J" || r === "10") return 10; return +r; }
function bjTotal(cards) { let v = 0, a = 0; for (const c of cards) { v += bjVal(c.r); if (c.r === "A") a++; } while (v > 21 && a) { v -= 10; a--; } return v; }
function bjSoft(cards) { let v = 0, a = 0; for (const c of cards) { v += bjVal(c.r); if (c.r === "A") a++; } return v <= 21 && a > 0; }
function isBJ(cards) { return cards.length === 2 && bjTotal(cards) === 21; }

// Video-poker hand evaluator (5 cards) → paytable multiplier (total return; a high
// pair returns the stake = push). Jacks-or-Better "9/6"-style table, ≈ 98–99% with
// optimal holds.
const POKER_ORDER = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
function evalPoker(cards) {
  const ranks = cards.map((c) => c.r), suits = cards.map((c) => c.s);
  const counts = {}; for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  const cv = Object.values(counts).sort((a, b) => b - a);
  const flush = suits.every((s) => s === suits[0]);
  const vals = [...new Set(ranks.map((r) => POKER_ORDER.indexOf(r)))].sort((a, b) => a - b);
  let straight = false, high = -1;
  if (vals.length === 5) {
    if (vals[4] - vals[0] === 4) { straight = true; high = vals[4]; }
    else if (vals.join() === "0,1,2,3,12") { straight = true; high = 3; } // A-2-3-4-5 wheel (5-high)
  }
  const pairR = Object.keys(counts).find((r) => counts[r] === 2);
  const highPair = pairR && ["J", "Q", "K", "A"].includes(pairR);
  if (straight && flush && high === 12) return { key: "royal", name: "Royal Flush", mult: 250 };
  if (straight && flush) return { key: "sf", name: "Straight Flush", mult: 50 };
  if (cv[0] === 4) return { key: "quads", name: "Four of a Kind", mult: 25 };
  if (cv[0] === 3 && cv[1] === 2) return { key: "fh", name: "Full House", mult: 9 };
  if (flush) return { key: "flush", name: "Flush", mult: 6 };
  if (straight) return { key: "straight", name: "Straight", mult: 4 };
  if (cv[0] === 3) return { key: "trips", name: "Three of a Kind", mult: 3 };
  if (cv[0] === 2 && cv[1] === 2) return { key: "twopair", name: "Two Pair", mult: 2 };
  if (cv[0] === 2 && highPair) return { key: "jacks", name: "Jacks or Better", mult: 1 };
  return { key: "none", name: "No win", mult: 0 };
}
export const POKER_PAYTABLE = [
  ["Royal Flush", 250], ["Straight Flush", 50], ["Four of a Kind", 25], ["Full House", 9],
  ["Flush", 6], ["Straight", 4], ["Three of a Kind", 3], ["Two Pair", 2], ["Jacks or Better", 1],
];

export const CARD_GAMES = [
  { id: "blackjack", name: "Blackjack", emoji: "♠", rtp: 99.5, blurb: "Beat the dealer to 21 without busting. Blackjack pays 3:2." },
  { id: "poker", name: "Video Poker", emoji: "♣", rtp: 98.4, blurb: "Jacks or Better — hold the cards you want, draw the rest." },
  { id: "baccarat", name: "Baccarat", emoji: "♦", rtp: 98.9, blurb: "Bet on Player, Banker (−5%) or Tie (8:1)." },
];

export class CardGames {
  constructor() { this.bj = new Map(); this.vp = new Map(); } // uid → blackjack / video-poker hand

  bjActive(uid) { return this.bj.has(uid); }
  clearBj(uid) { this.bj.delete(uid); }

  // ── Blackjack (stateful) ─────────────────────────────────────────────────
  bjStart(uid, bet) {
    this.bj.delete(uid);
    const shoe = freshShoe(6);
    const player = [draw(shoe), draw(shoe)];
    const dealer = [draw(shoe), draw(shoe)];
    const g = { shoe, dealer, player, bet, staked: bet, over: false, payout: 0, outcome: "" };
    this.bj.set(uid, g);
    if (isBJ(player) || isBJ(dealer)) return this.#resolve(uid, g);
    return this.#view(g, false);
  }
  bjHit(uid) {
    const g = this.bj.get(uid); if (!g || g.over) return { error: "No active hand" };
    g.player.push(draw(g.shoe));
    if (bjTotal(g.player) >= 21) return this.#resolve(uid, g);
    return this.#view(g, false);
  }
  bjStand(uid) {
    const g = this.bj.get(uid); if (!g || g.over) return { error: "No active hand" };
    return this.#resolve(uid, g);
  }
  bjDouble(uid) {
    const g = this.bj.get(uid); if (!g || g.over) return { error: "No active hand" };
    if (g.player.length !== 2) return { error: "Can only double on the first two cards" };
    g.bet *= 2; g.staked = g.bet;          // the extra stake is taken by the route
    g.player.push(draw(g.shoe));
    return this.#resolve(uid, g);
  }
  bjView(uid) { const g = this.bj.get(uid); if (!g) return { error: "No active hand" }; return this.#view(g, g.over); }

  #resolve(uid, g) {
    while (bjTotal(g.dealer) < 17) g.dealer.push(draw(g.shoe)); // dealer stands on all 17
    const pt = bjTotal(g.player), dt = bjTotal(g.dealer);
    const pbj = isBJ(g.player), dbj = isBJ(g.dealer);
    let payout = 0, outcome;
    if (pbj && dbj) { outcome = "push"; payout = g.bet; }
    else if (pbj) { outcome = "blackjack"; payout = Math.floor(g.bet * 2.5); }   // 3:2
    else if (dbj || pt > 21) { outcome = pt > 21 ? "bust" : "lose"; payout = 0; }
    else if (dt > 21 || pt > dt) { outcome = "win"; payout = g.bet * 2; }
    else if (pt < dt) { outcome = "lose"; payout = 0; }
    else { outcome = "push"; payout = g.bet; }
    g.over = true; g.payout = payout; g.outcome = outcome;
    this.bj.delete(uid);
    return this.#view(g, true);
  }
  #view(g, reveal) {
    return {
      game: "blackjack", over: g.over,
      player: g.player, playerTotal: bjTotal(g.player), soft: bjSoft(g.player),
      dealer: reveal ? g.dealer : [g.dealer[0], { hidden: true }],
      dealerTotal: reveal ? bjTotal(g.dealer) : null, dealerUp: bjVal(g.dealer[0].r),
      canHit: !g.over, canStand: !g.over, canDouble: !g.over && g.player.length === 2,
      bet: g.bet, staked: g.staked, payout: g.payout, outcome: g.outcome,
    };
  }

  // ── Video Poker — Jacks or Better (stateful: deal → hold → draw) ─────────
  vpDeal(uid, bet) {
    this.vp.delete(uid);
    const deck = freshShoe(1);
    const cards = [draw(deck), draw(deck), draw(deck), draw(deck), draw(deck)];
    this.vp.set(uid, { deck, cards, bet, over: false });
    return { game: "poker", cards, over: false, bet, staked: bet, paytable: POKER_PAYTABLE };
  }
  vpActive(uid) { return this.vp.has(uid); }
  vpDraw(uid, holds) {
    const g = this.vp.get(uid); if (!g || g.over) return { error: "No active hand" };
    const keep = new Set((Array.isArray(holds) ? holds : []).map(Number).filter((i) => i >= 0 && i < 5));
    for (let i = 0; i < 5; i++) if (!keep.has(i)) g.cards[i] = draw(g.deck);
    const ev = evalPoker(g.cards);
    const payout = g.bet * ev.mult;                          // total return; pair = push
    this.vp.delete(uid);
    return { game: "poker", cards: g.cards, over: true, rank: ev.key, rankName: ev.name, mult: ev.mult, payout, staked: g.bet };
  }

  // ── Baccarat (stateless, full third-card rules) ──────────────────────────
  baccarat(bet, side) {
    side = ["player", "banker", "tie"].includes(side) ? side : "player";
    const shoe = freshShoe(8);
    const bv = (r) => (r === "A" ? 1 : (r === "10" || r === "J" || r === "Q" || r === "K") ? 0 : +r);
    const tot = (cs) => cs.reduce((s, c) => s + bv(c.r), 0) % 10;
    const p = [draw(shoe), draw(shoe)], b = [draw(shoe), draw(shoe)];
    let pv = tot(p), bvv = tot(b);
    if (pv < 8 && bvv < 8) {                                  // no natural → draw rules
      let p3 = null;
      if (pv <= 5) { p3 = draw(shoe); p.push(p3); pv = tot(p); }
      let bDraw;
      if (p3 === null) bDraw = bvv <= 5;                      // player stood → banker draws on ≤5
      else {
        const t = bv(p3.r);
        if (bvv <= 2) bDraw = true;
        else if (bvv === 3) bDraw = t !== 8;
        else if (bvv === 4) bDraw = t >= 2 && t <= 7;
        else if (bvv === 5) bDraw = t >= 4 && t <= 7;
        else if (bvv === 6) bDraw = t >= 6 && t <= 7;
        else bDraw = false;
      }
      if (bDraw) { b.push(draw(shoe)); bvv = tot(b); }
    }
    const outcome = pv > bvv ? "player" : bvv > pv ? "banker" : "tie";
    let payout = 0;
    if (side === outcome) payout = side === "player" ? bet * 2 : side === "banker" ? Math.floor(bet * 1.95) : bet * 9;
    else if (outcome === "tie") payout = bet;                 // player/banker bets push on a tie
    return { game: "baccarat", side, outcome, player: p, banker: b, pv, bv: bvv, payout, staked: bet };
  }
}
