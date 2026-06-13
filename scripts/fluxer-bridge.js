/**
 * fluxer-bridge.js
 *
 * Injected into the fishslot game's index.html.
 * Runs in the game's browsing context (same origin as the iframe).
 *
 * Responsibilities:
 *   1. Listen for { type: 'fluxer:init', balance, bet } from the casino parent.
 *   2. Wait for the C3 shim hooks to be ready, then call window.__fluxerSetBalance(balance).
 *   3. Watch for balance changes (credit display) and report spin results back
 *      to the parent via { type: 'fluxer:result', won, lost }.
 *
 * The C3 game renders its balance in a Text object named 'credittxt'.
 * We watch for DOM canvas text changes via a ResizeObserver+RAF polling approach,
 * and also hook into the game's spin button click to detect round boundaries.
 */
(function () {
  'use strict';

  let fluxerBalance  = null;   // FC balance injected from parent
  let fluxerBet      = 0;
  let balanceApplied = false;
  let lastReportedBal = null;
  let spinActive     = false;
  let balAtSpinStart = null;

  // ── 1. Receive init message from casino parent ────────────────────────────
  window.addEventListener('message', function (e) {
    const d = e.data;
    if (!d) return;

    if (d.type === 'fluxer:init') {
      fluxerBalance = Math.max(0, Math.floor(Number(d.balance) || 0));
      fluxerBet     = Math.max(0, Math.floor(Number(d.bet)     || 0));
      console.log('[FluxerBridge] Init — balance:', fluxerBalance, 'bet:', fluxerBet);
      applyBalanceWhenReady();
    }
  });

  // ── 2. Apply balance once C3 hooks are available ──────────────────────────
  function applyBalanceWhenReady() {
    if (fluxerBalance === null) return;
    if (balanceApplied) return;

    const tryApply = () => {
      if (typeof window.__fluxerSetBalance === 'function') {
        window.__fluxerSetBalance(fluxerBalance);
        if (typeof window.__fluxerSetBet === 'function') {
          window.__fluxerSetBet(fluxerBet);
        }
        balanceApplied = true;
        lastReportedBal = fluxerBalance;
        console.log('[FluxerBridge] Applied FC balance to C3 runtime.');
        startSpinWatcher();
      } else {
        setTimeout(tryApply, 100);
      }
    };
    tryApply();
  }

  // ── 3. If parent never sends fluxer:init (direct load), try URL params ────
  (function checkUrlParams() {
    const sp = new URLSearchParams(window.location.search);
    const b  = sp.get('balance');
    const bet = sp.get('bet');
    if (b !== null) {
      fluxerBalance = Math.max(0, Math.floor(Number(b) || 0));
      fluxerBet     = Math.max(0, Math.floor(Number(bet) || 0));
      console.log('[FluxerBridge] Balance from URL params:', fluxerBalance);
      applyBalanceWhenReady();
    }
  })();

  // ── 4. Spin watcher — detect round start/end via canvas ──────────────────
  // C3 renders to a <canvas> element.  We can't read the text directly from
  // canvas pixels, but we CAN watch the C3 runtime's own credit variable by
  // polling window.__fluxerGetBalance() which the shim exposes.
  //
  // Round detection:
  //   - When the spin button (spinbtn in C3) is clicked, the balance decreases
  //     by the bet amount immediately.  We watch for that drop.
  //   - When the reels stop, the balance may increase if there's a win.
  //   - We detect "spin ended" by watching for the balance to stabilise
  //     after a change, then report the final value.

  function startSpinWatcher() {
    let prevBal = fluxerBalance;
    let stableFrames = 0;
    let pendingReport = false;

    const STABLE_THRESHOLD = 90; // ~1.5s at 60fps — wait for animations

    function tick() {
      const cur = window.__fluxerGetBalance?.();
      if (cur === null || cur === undefined) {
        requestAnimationFrame(tick);
        return;
      }

      if (cur !== prevBal) {
        // Balance changed — a spin is in progress or just ended
        if (!spinActive && cur < prevBal) {
          // Bet was deducted — spin started
          spinActive     = true;
          balAtSpinStart = prevBal;
          stableFrames   = 0;
          pendingReport  = true;
          console.log('[FluxerBridge] Spin started, bet deducted. Bal:', cur);
        }
        prevBal      = cur;
        stableFrames = 0;
      } else if (pendingReport) {
        stableFrames++;
        if (stableFrames >= STABLE_THRESHOLD) {
          // Balance stable — spin round is over
          spinActive    = false;
          pendingReport = false;
          stableFrames  = 0;
          reportResult(cur);
        }
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  // ── 5. Report result to parent ────────────────────────────────────────────
  function reportResult(finalBal) {
    if (lastReportedBal === finalBal) return; // nothing changed
    lastReportedBal = finalBal;
    console.log('[FluxerBridge] Reporting result. Final FC balance:', finalBal);
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(
        { type: 'fluxer:result', won: Math.max(0, finalBal), lost: fluxerBet },
        '*'
      );
    }
  }

  // ── 6. Report on page unload (safety net) ────────────────────────────────
  window.addEventListener('beforeunload', function () {
    const cur = window.__fluxerGetBalance?.() ?? fluxerBalance;
    if (cur !== null && cur !== lastReportedBal) {
      reportResult(cur);
    }
  });

  console.log('[FluxerBridge] Loaded.');
})();
