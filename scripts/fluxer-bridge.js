/**
 * fluxer-bridge.js — injected into the fishslot game's index.html
 *
 * Protocol:
 *   Parent  → Game : { type: 'fluxer:init', balance: N, bet: N }
 *   Parent  → Game : { type: 'fluxer:sync', balance: N }   (after each spin)
 *
 * The c3runtime.js FluxerBridge hook exposes:
 *   window.__fluxerApply(balance)   — sets C3 globalVars.balance
 *   window.__fluxerApplyBet(bet)    — sets C3 globalVars.bet (if var exists)
 *
 * This file simply waits for those hooks to appear, then calls them.
 * All economy logic (deduct / payout) lives in the bot's WebServer.mjs.
 */
(function () {
  'use strict';

  console.log('[FluxerBridge] Loaded.');

  // ── Apply balance to C3 runtime ─────────────────────────────────────────
  function applyBalance(balance) {
    if (typeof window.__fluxerApply === 'function') {
      window.__fluxerApply(balance);
      return true;
    }
    return false;
  }

  function applyBet(bet) {
    if (typeof window.__fluxerApplyBet === 'function') {
      window.__fluxerApplyBet(bet);
    }
  }

  // Retry until C3 runtime hook is ready (worker init can take 500-2000ms)
  function applyWhenReady(balance, bet) {
    if (applyBalance(balance)) {
      applyBet(bet);
      console.log('[FluxerBridge] Applied balance:', balance, 'bet:', bet);
      return;
    }
    setTimeout(function () { applyWhenReady(balance, bet); }, 100);
  }

  // ── Message listener ────────────────────────────────────────────────────
  window.addEventListener('message', function (e) {
    const d = e.data;
    if (!d) return;

    if (d.type === 'fluxer:init') {
      const bal = Math.max(0, Math.floor(Number(d.balance) || 0));
      const bet = Math.max(0, Math.floor(Number(d.bet)     || 0));
      console.log('[FluxerBridge] Init — balance:', bal, 'bet:', bet);
      applyWhenReady(bal, bet);
    }

    if (d.type === 'fluxer:sync') {
      const bal = Math.max(0, Math.floor(Number(d.balance) || 0));
      console.log('[FluxerBridge] Sync — balance:', bal);
      applyBalance(bal);
    }
  });

  // ── Fallback: read from window globals set before C3 scripts loaded ──────
  // patch-fishslot.js injects a listener that stores incoming postMessages
  // into window.__fluxerBalance / window.__fluxerBet before the C3 worker
  // boots.  If the parent already sent fluxer:init before this script ran,
  // those values are already sitting there.
  (function checkEarlyInit() {
    const b = window.__fluxerBalance;
    const bet = window.__fluxerBet || 0;
    if (b !== null && b !== undefined) {
      console.log('[FluxerBridge] Early-init balance from window globals:', b);
      applyWhenReady(b, bet);
    }
  })();

})();
