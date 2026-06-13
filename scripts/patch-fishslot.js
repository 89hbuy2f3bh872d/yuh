#!/usr/bin/env node
/**
 * patch-fishslot.js
 *
 * Patches the fishslot PWA (already cloned to disk) so it uses
 * Fluxer FC instead of its own demo balance.
 *
 * What it does:
 *   1. Injects <script src="/fishslot/scripts/fluxer-bridge.js"></script>
 *      into index.html (idempotent).
 *   2. Appends a small shim to scripts/main.js that exposes a global
 *      `window.__fluxerSetBalance` hook which the bridge calls after the
 *      C3 runtime is ready, and a `window.__fluxerGetBalance` getter.
 *
 * The bridge itself lives in scripts/fluxer-bridge.js (copied here too).
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const dest = process.argv[2];
if (!dest) { console.error('Usage: patch-fishslot.js <dest-dir>'); process.exit(1); }

// ── 1. Copy fluxer-bridge.js into the game's scripts folder ─────────────────
const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const bridgeSrc  = path.join(__dirname, 'fluxer-bridge.js');
const bridgeDest = path.join(dest, 'scripts', 'fluxer-bridge.js');
fs.copyFileSync(bridgeSrc, bridgeDest);
console.log('[patch] Copied fluxer-bridge.js →', bridgeDest);

// ── 2. Patch index.html — inject the bridge script tag ──────────────────────
const indexPath = path.join(dest, 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');
const BRIDGE_TAG = '<script src="/fishslot/scripts/fluxer-bridge.js"></script>';
if (!html.includes('fluxer-bridge')) {
  // Inject right before closing </body>
  html = html.replace('</body>', `${BRIDGE_TAG}\n</body>`);
  fs.writeFileSync(indexPath, html);
  console.log('[patch] Injected fluxer-bridge.js tag into index.html');
} else {
  console.log('[patch] index.html already patched — skipping');
}

// ── 3. Patch scripts/main.js — append the C3 balance hook shim ──────────────
const mainPath = path.join(dest, 'scripts', 'main.js');
let main = fs.readFileSync(mainPath, 'utf8');

const SHIM_MARKER = '/* __FLUXER_SHIM__ */';
if (!main.includes(SHIM_MARKER)) {
  const SHIM = `
${SHIM_MARKER}
// ─────────────────────────────────────────────────────────────────────────────
// Fluxer FC currency bridge — injected by scripts/patch-fishslot.js
// Hooks into the Construct 3 runtime to replace the demo balance with real FC.
// ─────────────────────────────────────────────────────────────────────────────
(function installFluxerHooks() {
  'use strict';

  // Wait for the C3 runtime to be available on window
  // c3_runtimeInterface is set in the last block of main.js
  let _rt = null;
  let _hookedBalance = null;   // FC balance injected from parent
  let _hookedBet     = 0;
  let _lastKnownBal  = null;

  // The C3 runtime stores global variables inside the worker or the local
  // runtime.  We can reach them through the undocumented
  // window.c3_runtimeInterface._GetLocalRuntime() path when NOT in worker
  // mode, or by watching the MessageChannel for balance-related text updates.
  //
  // Strategy (works in both worker and non-worker mode):
  //   • Intercept the "update-state" messages that the C3 text plugin sends
  //     to the DOM whenever a Text object changes its content.
  //   • The credittxt object renders the current balance.  We read/write it
  //     by intercepting and re-writing those messages.
  //
  // Additionally we expose:
  //   window.__fluxerSetBalance(fc)  — called by the bridge on fluxer:init
  //   window.__fluxerGetBalance()    — returns last known balance
  //   window.__fluxerReportSpin(won) — called by the bridge to post result

  // ── intercept RuntimeInterface MessageChannel ────────────────────────────
  // We wrap the original RuntimeInterface constructor to tap the message port.
  const OrigRI = window.RuntimeInterface;
  if (!OrigRI) {
    console.warn('[FluxerBridge] RuntimeInterface not found — bridge disabled');
    return;
  }

  window.RuntimeInterface = class PatchedRuntimeInterface extends OrigRI {
    constructor(opts) {
      super(opts);
      // Tap the message port after parent constructor sets it up
      this.__fluxerPatchPort();
    }

    __fluxerPatchPort() {
      // The port is private (_messageChannelPort) — we poll briefly for it
      const patch = () => {
        const port = this._messageChannelPort;
        if (!port) { setTimeout(patch, 50); return; }
        // Save the original onmessage
        const origHandler = (e) => this['_OnMessageFromRuntime'](e.data);
        port.onmessage = (e) => {
          const d = e.data;
          // Intercept text update-state messages for credittxt
          // C3 text plugin sends: { type:'event', component:'runtime', handler:'…' }
          // but balance updates come as canvas draw commands, not DOM messages.
          // So we use the __fluxerSetBalance / requestAnimationFrame approach below.
          origHandler(e);
        };
        // Once port is ready, also expose the set/get hooks via RAF loop
        this.__fluxerStartBalanceLoop();
      };
      setTimeout(patch, 0);
    }

    __fluxerStartBalanceLoop() {
      // Poll via the local runtime when not in worker mode
      // or post a custom message to the worker when in worker mode.
      // We use the simplest approach: expose globals and let fluxer-bridge.js
      // call them at the right time.

      window.__fluxerSetBalance = (fc) => {
        _hookedBalance = Math.max(0, Math.floor(Number(fc) || 0));
        console.log('[FluxerBridge] Set balance:', _hookedBalance);
        this.__fluxerApplyBalance(_hookedBalance);
      };

      window.__fluxerSetBet = (bet) => {
        _hookedBet = Math.max(0, Math.floor(Number(bet) || 0));
      };

      window.__fluxerGetBalance = () => _lastKnownBal;

      window.__fluxerReportSpin = (wonAmount) => {
        // wonAmount = absolute FC amount returned to player after spin
        // (net win is wonAmount - bet, but parent handles that)
        if (window.parent && window.parent !== window) {
          window.parent.postMessage(
            { type: 'fluxer:result', won: Math.max(0, Math.floor(Number(wonAmount) || 0)), lost: _hookedBet },
            '*'
          );
        }
      };

      // Override the C3 runtime's internal balance variable via the local
      // runtime when not in worker mode.  We watch for the runtime to
      // finish initialising and then set the global variable 'Br' (balance).
      const trySetVar = () => {
        if (_hookedBalance === null) return; // not yet initialised
        const lr = this._localRuntime;
        if (!lr) return;
        try {
          // C3 global variables are stored as inst vars on the runtime.
          // Find 'credittxt' by name and force its text.
          const allInsts = lr["_allInstances"] ?? lr["allInstances"];
          if (allInsts) {
            for (const inst of allInsts) {
              const n = inst?._objectType?._name ?? inst?.GetObjectType?.()?.GetName?.();
              if (n === 'credittxt') {
                if (inst._properties) {
                  inst._properties[0] = String(_hookedBalance);
                } else if (inst.SetText) {
                  inst.SetText(String(_hookedBalance));
                } else if (typeof inst["_text"] !== 'undefined') {
                  inst["_text"] = String(_hookedBalance);
                }
                _lastKnownBal = _hookedBalance;
              }
            }
          }
        } catch(e) {
          // Worker mode — cannot access local runtime
        }
      };

      // Run every frame to keep balance in sync initially, then back off
      let frameCount = 0;
      const loop = () => {
        frameCount++;
        trySetVar();
        if (frameCount < 120) requestAnimationFrame(loop); // 2s at 60fps
      };
      requestAnimationFrame(loop);
    }
  };

  // Copy static methods
  Object.setPrototypeOf(window.RuntimeInterface, OrigRI);
  for (const key of Object.getOwnPropertyNames(OrigRI)) {
    if (key !== 'prototype' && key !== 'length' && key !== 'name') {
      try { window.RuntimeInterface[key] = OrigRI[key]; } catch {}
    }
  }
  Object.assign(window.RuntimeInterface, OrigRI);

  console.log('[FluxerBridge] C3 RuntimeInterface patched.');
})();
`;
  main += SHIM;
  fs.writeFileSync(mainPath, main);
  console.log('[patch] Appended Fluxer shim to scripts/main.js');
} else {
  console.log('[patch] scripts/main.js already patched — skipping');
}

console.log('[patch] All done.');
