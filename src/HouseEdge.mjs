const LOSS_BAITS = [
  "💀 So close! The wheel nearly landed on yours — try again?",
  "🔥 You're burning hot right now, the big win is one spin away.",
  "🎯 That was literally one symbol off. One more round, easy.",
  "📊 Statistically you're *overdue* a win. Don't walk away now.",
  "💡 Cold streaks always break. This is just the setup.",
  "🃏 The house can't keep this up forever. Your turn is coming.",
  "⚡ The table feels electric. Lucky players always push through dips.",
  "🌀 Bad luck runs in 3s — you've had your 3. Next is clean.",
  "🦋 That near-miss means the RNG is *favouring* you right now.",
  "🧲 You can feel the momentum shifting, can't you?",
  "👀 A player just left the table. Their luck is still here.",
  "🎰 Casino tip: Winners never quit right before a streak.",
];

const WIN_BAITS = [
  "🔥 You're on fire! Ride the streak — bet bigger!",
  "💰 That momentum is real. Double down while it's yours.",
  "⚡ Hot table alert. Don't leave it now.",
  "🎯 When you're this hot, the house doesn't stand a chance.",
  "📈 Your balance is climbing. Press the advantage!",
];

let _lastLoss = -1;
let _lastWin = -1;

export const HouseEdge = {
  baitLoss() {
    let i;
    do { i = Math.floor(Math.random() * LOSS_BAITS.length); } while (i === _lastLoss);
    _lastLoss = i;
    return LOSS_BAITS[i];
  },
  baitWin() {
    let i;
    do { i = Math.floor(Math.random() * WIN_BAITS.length); } while (i === _lastWin);
    _lastWin = i;
    return WIN_BAITS[i];
  },
};
