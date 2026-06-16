import { COLORS } from "../src/theme.mjs";

// Wild West 1v1 duel — both players must type &draw within the reaction window.
// The faster one wins the pot. House takes a 10% rake from the winner.
// If neither fires in time, both get their bet back minus a 5% "holster fee".

const MIN_BET = 50;
const DRAW_WINDOW_MS = 8000; // 8 second window after DRAW signal
const PREP_MS_MIN = 3000;
const PREP_MS_MAX = 7000;

// Active duels: channelId -> duel state
const _duels = new Map();

export default {
  name: "wildwest",
  aliases: ["duel", "ww"],
  description: "Challenge someone to a 1v1 duel! `&wildwest @user <bet>`",

  async execute({ message, args, db, embed, prefix }) {
    const uid = message.author.id;
    const channelId = message.channel.id;

    // --- DRAW command ---
    if (args[0]?.toLowerCase() === "draw" || args[0]?.toLowerCase() === "shoot") {
      const duel = _duels.get(channelId);
      if (!duel || !duel.ready) {
        return message.channel.send({ embeds: [
          embed(COLORS.warn).setDescription("🤠 No active duel in this channel, or it's not time to draw yet — **false start!**")
        ]});
      }
      if (uid !== duel.challenger && uid !== duel.opponent) {
        return message.channel.send({ embeds: [
          embed(COLORS.warn).setDescription("⚠️ You're not in this duel.")
        ]});
      }
      if (duel.fired.has(uid)) {
        return message.channel.send({ embeds: [
          embed(COLORS.warn).setDescription("🔫 You already fired!")
        ]});
      }

      duel.fired.set(uid, Date.now());

      // First shot wins immediately
      if (duel.fired.size === 1) {
        return; // wait for second or timeout
      }

      // Both fired — compare times
      clearTimeout(duel.timeout);
      _duels.delete(channelId);
      await resolveDuel(duel, null, db, embed, message.channel);
      return;
    }

    // --- Start duel ---
    if (_duels.has(channelId)) {
      return message.channel.send({ embeds: [
        embed(COLORS.warn).setDescription("⚠️ A duel is already happening in this channel!")
      ]});
    }

    const target = message.mentions?.users?.first?.();
    if (!target || target.bot || target.id === uid) {
      return message.channel.send({ embeds: [
        embed(COLORS.warn).setDescription(`⚠️ Usage: \`${prefix}wildwest @user <bet>\`\nMention a real user to challenge.`)
      ]});
    }

    const betAmt = parseInt(args[1] ?? args[args.length - 1], 10);
    if (!betAmt || betAmt < MIN_BET) {
      return message.channel.send({ embeds: [
        embed(COLORS.warn).setDescription(`⚠️ Minimum duel bet is **${MIN_BET} FC**.`)
      ]});
    }

    const challenger = await db.getUser(uid);
    if ((challenger.bal ?? 0) < betAmt) {
      return message.channel.send({ embeds: [
        embed(COLORS.error).setDescription("❌ You don't have enough FC for that bet.")
      ]});
    }

    // Challenge message — opponent must accept with &wildwest accept
    _duels.set(channelId, {
      challenger: uid,
      challengerTag: message.author.username,
      opponent: target.id,
      opponentTag: target.username,
      bet: betAmt,
      ready: false,
      fired: new Map(),
      accepted: false,
      timeout: setTimeout(() => {
        if (_duels.has(channelId) && !_duels.get(channelId).accepted) {
          _duels.delete(channelId);
          message.channel.send({ embeds: [
            embed(COLORS.warn).setDescription("🤠 The challenge expired — **no duel**!")
          ]}).catch(() => {});
        }
      }, 45_000),
    });

    return message.channel.send({ embeds: [
      embed(COLORS.primary)
        .setTitle("🤠 Wild West Duel!")
        .setDescription(
          `**${message.author.username}** challenges **${target.username}** to a duel!\n` +
          `Bet: **${betAmt.toLocaleString()} FC** each\n\n` +
          `<@${target.id}> — type \`${prefix}wildwest accept\` to accept! (45s)"`
        )
    ]});
  },
};

async function resolveDuel(duel, forfeiter, db, embed, channel) {
  const [[aId, aTime], [bId, bTime]] = [...duel.fired.entries()];
  const winnerId = aTime < bTime ? aId : bId;
  const loserId  = winnerId === aId ? bId : aId;
  const winnerTag = winnerId === duel.challenger ? duel.challengerTag : duel.opponentTag;
  const loserTag  = loserId  === duel.challenger ? duel.challengerTag : duel.opponentTag;

  const pot    = duel.bet * 2;
  const rake   = Math.floor(pot * 0.10); // 10% house rake
  const payout = pot - rake;
  const diff   = Math.abs(aTime - bTime);

  await db.updateBalance(loserId,  -duel.bet);
  await db.updateBalance(winnerId,  duel.bet - rake); // net gain = bet - rake
  await db.recordGame(winnerId, true,  payout);
  await db.recordGame(loserId,  false, duel.bet);

  const winnerUser = await db.getUser(winnerId);

  channel.send({ embeds: [
    embed(COLORS.primary)
      .setTitle("🔫 BANG! Duel Over!")
      .setDescription(
        `**${winnerTag}** drew faster by **${diff}ms** and wins!\n\n` +
        `💰 **+${(duel.bet - rake).toLocaleString()} FC** (after 10% rake)\n` +
        `**${loserTag}** loses **${duel.bet.toLocaleString()} FC**\n\n` +
        `${winnerTag}'s balance: **${Math.floor(winnerUser.bal).toLocaleString()} FC**`
      )
  ]}).catch(() => {});
}

// Patch: handle &wildwest accept
const _origExecute = exports?.default?.execute;
Object.assign(exports?.default ?? {}, {
  // We extend execute inline above — accept logic lives here as an augment
});

// Re-export with accept support patched in
const cmd = {
  name: "wildwest",
  aliases: ["duel", "ww"],
  description: "Challenge someone to a 1v1 duel! `&wildwest @user <bet>`",

  async execute({ message, args, db, embed, prefix }) {
    const uid = message.author.id;
    const channelId = message.channel.id;

    // --- Accept ---
    if (args[0]?.toLowerCase() === "accept") {
      const duel = _duels.get(channelId);
      if (!duel || duel.opponent !== uid) {
        return message.channel.send({ embeds: [
          embed(COLORS.warn).setDescription("⚠️ No pending duel for you in this channel.")
        ]});
      }
      if (duel.accepted) return;

      const opp = await db.getUser(uid);
      if ((opp.bal ?? 0) < duel.bet) {
        _duels.delete(channelId);
        return message.channel.send({ embeds: [
          embed(COLORS.error).setDescription("❌ You don't have enough FC — duel cancelled.")
        ]});
      }

      clearTimeout(duel.timeout);
      duel.accepted = true;
      duel.ready    = false;

      await message.channel.send({ embeds: [
        embed(COLORS.warn)
          .setTitle("🤠 Duel Accepted!")
          .setDescription(`Both players ready. **Get your hands on your holsters...** \n\nThe signal drops in a few seconds — type \`${prefix}wildwest draw\` the moment you see 🔫!`)
      ]});

      const delay = PREP_MS_MIN + Math.floor(Math.random() * (PREP_MS_MAX - PREP_MS_MIN));

      duel.timeout = setTimeout(async () => {
        if (!_duels.has(channelId)) return;
        duel.ready = true;

        await message.channel.send({ embeds: [
          embed(0xFF0000)
            .setTitle("🔫 DRAW!!!")
            .setDescription(`<@${duel.challenger}> <@${duel.opponent}> — **TYPE \`${prefix}wildwest draw\` NOW!!!**`)
        ]}).catch(() => {});

        // Auto-resolve timeout
        duel.timeout = setTimeout(async () => {
          const d = _duels.get(channelId);
          if (!d) return;
          _duels.delete(channelId);

          if (d.fired.size === 0) {
            // Nobody drew — everybody gets back minus holster fee
            message.channel.send({ embeds: [
              embed(COLORS.warn).setDescription("🤠 Both cowboys froze! No winner — bets returned minus 5% holster fee.")
            ]}).catch(() => {});
            return;
          }

          // Only one person drew — they win
          const [[winnerId]] = [...d.fired.entries()];
          const loserId      = winnerId === d.challenger ? d.opponent : d.challenger;
          const winnerTag    = winnerId === d.challenger ? d.challengerTag : d.opponentTag;
          const loserTag     = loserId  === d.challenger ? d.challengerTag : d.opponentTag;
          const rake         = Math.floor(d.bet * 0.10);

          await db.updateBalance(loserId,  -d.bet);
          await db.updateBalance(winnerId,  d.bet - rake);
          await db.recordGame(winnerId, true,  d.bet * 2 - rake);
          await db.recordGame(loserId,  false, d.bet);

          const wu = await db.getUser(winnerId);
          message.channel.send({ embeds: [
            embed(COLORS.primary)
              .setTitle("🔫 Duel Over — One Cowboy Drew!")
              .setDescription(
                `**${winnerTag}** was the only one who drew and wins!\n` +
                `**${loserTag}** was too slow (or froze).\n\n` +
                `💰 **${winnerTag}** nets **+${(d.bet - rake).toLocaleString()} FC**\n` +
                `Balance: **${Math.floor(wu.bal).toLocaleString()} FC**`
              )
          ]}).catch(() => {});
        }, DRAW_WINDOW_MS);

      }, delay);
      return;
    }

    // --- DRAW command ---
    if (args[0]?.toLowerCase() === "draw" || args[0]?.toLowerCase() === "shoot") {
      const duel = _duels.get(channelId);
      if (!duel || !duel.ready) {
        return message.channel.send({ embeds: [
          embed(COLORS.warn).setDescription("🤠 No active duel ready to draw! **False start!**")
        ]});
      }
      if (uid !== duel.challenger && uid !== duel.opponent) {
        return message.channel.send({ embeds: [
          embed(COLORS.warn).setDescription("⚠️ You're not in this duel.")
        ]});
      }
      if (duel.fired.has(uid)) {
        return message.channel.send({ embeds: [
          embed(COLORS.warn).setDescription("🔫 You already fired!")
        ]});
      }

      duel.fired.set(uid, Date.now());

      if (duel.fired.size >= 2) {
        clearTimeout(duel.timeout);
        _duels.delete(channelId);
        await resolveDuel(duel, null, db, embed, message.channel);
      }
      return;
    }

    // --- Challenge ---
    if (_duels.has(channelId)) {
      return message.channel.send({ embeds: [
        embed(COLORS.warn).setDescription("⚠️ A duel is already happening here!")
      ]});
    }

    const target = message.mentions?.users?.first?.();
    if (!target || target.bot || target.id === uid) {
      return message.channel.send({ embeds: [
        embed(COLORS.warn).setDescription(`⚠️ Usage: \`${prefix}wildwest @user <bet>\``)
      ]});
    }

    const betAmt = parseInt(args[args.length - 1], 10);
    if (!betAmt || betAmt < MIN_BET) {
      return message.channel.send({ embeds: [
        embed(COLORS.warn).setDescription(`⚠️ Minimum bet is **${MIN_BET} FC**.`)
      ]});
    }

    const challenger = await db.getUser(uid);
    if ((challenger.bal ?? 0) < betAmt) {
      return message.channel.send({ embeds: [
        embed(COLORS.error).setDescription("❌ Not enough FC for that bet.")
      ]});
    }

    const t = setTimeout(() => {
      if (_duels.has(channelId) && !_duels.get(channelId).accepted) {
        _duels.delete(channelId);
        message.channel.send({ embeds: [
          embed(COLORS.warn).setDescription("🤠 Challenge expired — no duel.")
        ]}).catch(() => {});
      }
    }, 45_000);

    _duels.set(channelId, {
      challenger: uid, challengerTag: message.author.username,
      opponent: target.id, opponentTag: target.username,
      bet: betAmt, ready: false, fired: new Map(), accepted: false, timeout: t,
    });

    return message.channel.send({ embeds: [
      embed(COLORS.primary)
        .setTitle("🤠 Wild West Duel!")
        .setDescription(
          `**${message.author.username}** challenges **${target.username}**!\n` +
          `Bet: **${betAmt.toLocaleString()} FC** each — winner takes pot minus 10% rake.\n\n` +
          `<@${target.id}> — type \`${prefix}wildwest accept\` to accept! *(45s)*`
        )
    ]});
  },
};

export default cmd;
