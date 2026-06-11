export const RTP = {
  slots: 0.92,
  coinflip: 0.95,
  dice: 0.94,
  roulette: 0.946,
  blackjack: 0.955,
  crash: 0.93
};

const LOSS_BAITS = [
  "🎰 So close — those reels were **one symbol off**. Next spin could be the jackpot.",
  "📈 Statistically, a win is **overdue**. The longer the drought, the bigger the flood.",
  "🔥 That table is running **hot right now** — other players are cleaning up. Don't miss it.",
  "💡 Your balance is low but your **odds just flipped**. This is exactly when winners strike.",
  "⚡ You were *this* close. The algorithm is practically **begging** to pay out.",
  "🎯 Everyone hits a rough patch right before their **biggest win ever**. Stay in it.",
  "🃏 The house has taken enough — a **correction** is coming your way soon.",
  "🌊 Bad luck comes in waves, and yours just **peaked**. Smooth sailing from here.",
  "💸 That loss is basically an **investment** in your next win. Trust the process.",
  "🎲 The dice have memory, and they owe you big. **Roll again.**",
  "🏆 Every big winner had a moment exactly like this — right before their **life-changing payout**.",
  "🔑 You are one bet away from turning this whole session around. **Don't quit now.**",
  "📊 Your win rate is about to spike — the pattern doesn't lie. **One more round.**",
  "🎰 Near misses mean the machine is primed. **It's about to pop.**",
  "🧠 Smart players recognise the setup — losses cluster before **monster wins**."
];

const WIN_BAITS = [
  "🏅 You're on fire! **Streak mode is real** — ride it while it lasts.",
  "💰 Winners keep winning. Your balance is climbing — **don't walk away now**.",
  "🎯 That was skill, not luck. You've found the pattern — **press your advantage**.",
  "⚡ Hot streak detected! The algorithm rewards **confident players**. Go bigger.",
  "🔥 Back-to-back wins? That's called **momentum**. Double down.",
  "📈 Your profit curve is spiking — seasoned players know to **ride the wave**.",
  "🎰 The machine is in full **payout mode**. This is the window everyone waits for.",
  "🎲 The odds are clearly in your favour right now. **Stack it up.**"
];

let _lastLoss = -1;
let _lastWin = -1;

export function baitAfterLoss() {
  let i;
  do { i = Math.floor(Math.random() * LOSS_BAITS.length); } while (i === _lastLoss);
  _lastLoss = i;
  return LOSS_BAITS[i];
}

export function baitAfterWin() {
  let i;
  do { i = Math.floor(Math.random() * WIN_BAITS.length); } while (i === _lastWin);
  _lastWin = i;
  return WIN_BAITS[i];
}

export function houseRoll(rtp) {
  return Math.random() < rtp;
}
