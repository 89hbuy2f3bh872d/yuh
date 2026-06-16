import { COLORS } from "../src/theme.mjs";
import { HouseEdge } from "../src/HouseEdge.mjs";

// Mines — pick tiles on a 5x5 grid avoiding hidden mines.
// RTP ~90%: mines count defaults to 5 (out of 25), but each safe pick
// gives a multiplier that's 90% of the fair payout.
// Usage: &mines <bet> [mines=5]  → then &mines pick <1-25>  → &mines cashout

const MIN_BET  = 20;
const GRID_SIZE = 25;
const GAME_TTL_MS = 15 * 60 * 1000; // 15-minute game expiry

// Active games: uid -> { bet, mines: Set<index>, revealed: Set<index>, multiplier, mineCt, startedAt }
const _active = new Map();

// Prune stale games every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - GAME_TTL_MS;
  for (const [uid, g] of _active) {
    if (g.startedAt < cutoff) _active.delete(uid);
  }
}, 5 * 60 * 1000);

function fairMultiplier(revealed, mineCount) {
  // Probability of surviving `revealed` picks with `mineCount` mines on 25 tiles
  let prob = 1;
  for (let i = 0; i < revealed; i++) {
    const safe  = GRID_SIZE - mineCount - i;
    const total = GRID_SIZE - i;
    prob *= safe / total;
  }
  return (1 / prob) * 0.90; // 90% RTP factor
}

function plantMines(count) {
  const positions = new Set();
  while (positions.size < count) positions.add(Math.floor(Math.random() * GRID_SIZE));
  return positions;
}

export default {
  name: "mines",
  aliases: ["mine", "minesweeper"],
  description: "Navigate a minefield. `&mines <bet> [mine_count]`, then `&mines pick <1-25>` / `&mines cashout`",

  async execute({ message, args, db, embed, prefix }) {
    const uid = message.author.id;
    const now = Date.now();
    const sub = args[0]?.toLowerCase();

    // --- Pick ---
    if (sub === "pick") {
      const g = _active.get(uid);
      if (!g) return message.channel.send({ embeds: [
        embed(COLORS.warn).setDescription(`⚠️ No active mines game. Start one with \`${prefix}mines <bet>\`.`)
      ]});
      if (g.startedAt < now - GAME_TTL_MS) {
        _active.delete(uid);
        return message.channel.send({ embeds: [
          embed(COLORS.warn).setDescription("⚠️ Game expired. Start a new one with `&mines <bet>`.")
        ]});
      }

      const tile = parseInt(args[1], 10);
      if (isNaN(tile) || tile < 1 || tile > GRID_SIZE) {
        return message.channel.send({ embeds: [
          embed(COLORS.warn).setDescription(`⚠️ Pick a tile between 1 and ${GRID_SIZE}.`)
        ]});
      }
      const idx = tile - 1;
      if (g.revealed.has(idx)) {
        return message.channel.send({ embeds: [
          embed(COLORS.warn).setDescription("⚠️ You already revealed that tile.")
        ]});
      }

      if (g.mines.has(idx)) {
        // Hit a mine — bet already deducted on game start
        _active.delete(uid);
        await db.recordGame(uid, false, g.bet);
        const u2 = await db.getUser(uid);
        const grid = buildGrid(g);
        return message.channel.send({ embeds: [
          embed(COLORS.error)
            .setTitle("💥 BOOM! You hit a mine!")
            .setDescription(
              `Tile **${tile}** was a mine 💣\n` +
              `Lost **${g.bet.toLocaleString()} FC**\n${HouseEdge.baitLoss()}\n\n` +
              `\`\`\`\n${grid}\n\`\`\`` +
              `\n💰 Balance: **${Math.floor(u2.bal).toLocaleString()} FC**`
            )
        ]});
      }

      g.revealed.add(idx);
      g.multiplier = fairMultiplier(g.revealed.size, g.mineCt);
      const currentWin = Math.floor(g.bet * g.multiplier);

      return message.channel.send({ embeds: [
        embed(COLORS.primary)
          .setTitle(`✅ Safe! Tile ${tile} cleared.`)
          .setDescription(
            `Revealed: **${g.revealed.size}** tile(s) safely\n` +
            `Current multiplier: **${g.multiplier.toFixed(2)}x** → **${currentWin.toLocaleString()} FC** if you cash out now\n\n` +
            `Type \`${prefix}mines pick <1-${GRID_SIZE}>\` to continue or \`${prefix}mines cashout\` to take winnings.`
          )
      ]});
    }

    // --- Cashout ---
    if (sub === "cashout" || sub === "cash") {
      const g = _active.get(uid);
      if (!g) return message.channel.send({ embeds: [
        embed(COLORS.warn).setDescription(`⚠️ No active mines game.`)
      ]});
      if (g.startedAt < now - GAME_TTL_MS) {
        _active.delete(uid);
        return message.channel.send({ embeds: [
          embed(COLORS.warn).setDescription("⚠️ Game expired. Start a new one with `&mines <bet>`.")
        ]});
      }

      _active.delete(uid);

      if (g.revealed.size === 0) {
        // No tiles picked — return the bet (bet was deducted on start, so credit it back)
        await db.updateBalance(uid, g.bet);
        return message.channel.send({ embeds: [
          embed(COLORS.warn).setDescription("⚠️ You haven't picked any tiles yet — bet returned.")
        ]});
      }

      const payout = Math.floor(g.bet * g.multiplier);
      const delta  = payout - g.bet;
      // Net change = payout (bet already deducted on start)
      await db.updateBalance(uid, delta);
      await db.recordGame(uid, true, payout);
      const u2 = await db.getUser(uid);

      return message.channel.send({ embeds: [
        embed(COLORS.primary)
          .setTitle(`💰 Cashed out at ${g.multiplier.toFixed(2)}x!`)
          .setDescription(
            `**${g.revealed.size}** safe tiles revealed\n` +
            `**${g.bet.toLocaleString()} FC** → **${payout.toLocaleString()} FC**\n` +
            `Net: **+${delta.toLocaleString()} FC** ${HouseEdge.baitWin()}\n\n` +
            `💰 Balance: **${Math.floor(u2.bal).toLocaleString()} FC**`
          )
      ]});
    }

    // --- New game ---
    if (_active.has(uid)) {
      const g = _active.get(uid);
      if (g.startedAt >= now - GAME_TTL_MS) {
        return message.channel.send({ embeds: [
          embed(COLORS.warn).setDescription(
            `⚠️ You have an active mines game (${g.revealed.size} tiles revealed). ` +
            `Type \`${prefix}mines pick <n>\` or \`${prefix}mines cashout\`.`
          )
        ]});
      }
      // Expired — fall through to allow new game
      _active.delete(uid);
    }

    const betAmt  = parseInt(args[0], 10);
    const mineCt  = Math.min(20, Math.max(1, parseInt(args[1], 10) || 5));

    if (!betAmt || betAmt < MIN_BET) {
      return message.channel.send({ embeds: [
        embed(COLORS.warn)
          .setTitle("💣 Mines")
          .setDescription(
            `**Usage:** \`${prefix}mines <bet> [mine_count]\`\n` +
            `Then: \`${prefix}mines pick <1-25>\` — \`${prefix}mines cashout\`\n\n` +
            `Default: **5 mines** on a 5×5 grid. More mines = higher multipliers.\n` +
            `Min bet: **${MIN_BET} FC**`
          )
      ]});
    }

    // Atomically deduct the bet upfront
    const deducted = await db.atomicDeduct(uid, -betAmt);
    if (!deducted) {
      return message.channel.send({ embeds: [
        embed(COLORS.error).setDescription("❌ Not enough FC. Try `&work` to earn some.")
      ]});
    }

    _active.set(uid, {
      bet: betAmt,
      mines: plantMines(mineCt),
      revealed: new Set(),
      multiplier: 1,
      mineCt,
      startedAt: now,
    });

    return message.channel.send({ embeds: [
      embed(COLORS.primary)
        .setTitle("💣 Mines — Game Started")
        .setDescription(
          `Bet: **${betAmt.toLocaleString()} FC** | Mines: **${mineCt}** hidden in **25** tiles\n\n` +
          `Type \`${prefix}mines pick <1-25>\` to reveal a tile.\n` +
          `Type \`${prefix}mines cashout\` at any time to collect winnings.\n\n` +
          `⚠️ Hit a mine and you lose everything.`
        )
    ]});
  },
};

function buildGrid(g) {
  let out = "";
  for (let i = 0; i < GRID_SIZE; i++) {
    if (g.mines.has(i))    out += "💣 ";
    else if (g.revealed.has(i)) out += "✅ ";
    else out += "⬜ ";
    if ((i + 1) % 5 === 0) out += "\n";
  }
  return out.trim();
}
