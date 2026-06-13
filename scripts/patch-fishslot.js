#!/usr/bin/env node
/**
 * patch-fishslot.js
 *
 * Patches the fishslot PWA so it uses Fluxer FC instead of its own balance.
 *
 * What it does:
 *   1. Copies fluxer-bridge.js into scripts/
 *   2. Injects <script src="/fishslot/scripts/fluxer-bridge.js"></script>
 *      into index.html right before </body> (idempotent)
 *
 * The bridge reads window.__fluxerBalance / window.__fluxerBet (set by a
 * message listener in index.html that you've already added), then calls
 * the FluxerBridge hook that the c3runtime.js patch exposes on the global
 * variable object once the C3 worker is ready.
 *
 * We do NOT touch main.js or c3runtime.js here — those are patched once
 * inside the fishslot repo itself (index.html + c3runtime.js + data.json).
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const dest = process.argv[2];
if (!dest) { console.error('Usage: patch-fishslot.js <dest-dir>'); process.exit(1); }

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const bridgeSrc  = path.join(__dirname, 'fluxer-bridge.js');
const scriptsDir = path.join(dest, 'scripts');
const bridgeDest = path.join(scriptsDir, 'fluxer-bridge.js');

// ── 1. Copy fluxer-bridge.js ─────────────────────────────────────────────────
if (!fs.existsSync(scriptsDir)) fs.mkdirSync(scriptsDir, { recursive: true });
fs.copyFileSync(bridgeSrc, bridgeDest);
console.log('[patch] Copied fluxer-bridge.js →', bridgeDest);

// ── 2. Patch index.html — inject bridge script tag before </body> ─────────────
const indexPath = path.join(dest, 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');

// Also inject window.__fluxerBalance listener before C3 scripts if not already there
const INIT_TAG = `<script>
window.__fluxerBalance = null;
window.__fluxerBet = null;
window.addEventListener("message", function(e) {
  if (!e.data) return;
  if (e.data.type === "fluxer:init") {
    window.__fluxerBalance = Math.max(0, Math.floor(Number(e.data.balance) || 0));
    window.__fluxerBet = Math.max(0, Math.floor(Number(e.data.bet) || 0));
  }
  if (e.data.type === "fluxer:sync") {
    window.__fluxerBalance = Math.max(0, Math.floor(Number(e.data.balance) || 0));
  }
});
</script>`;

const BRIDGE_TAG = '<script src="/fishslot/scripts/fluxer-bridge.js"></script>';

let changed = false;

if (!html.includes('__fluxerBalance')) {
  // Inject init listener right before the first <script src= that loads C3
  html = html.replace(/(<script\s)/i, `${INIT_TAG}\n$1`);
  changed = true;
  console.log('[patch] Injected fluxer:init message listener into index.html');
}

if (!html.includes('fluxer-bridge')) {
  html = html.replace('</body>', `${BRIDGE_TAG}\n</body>`);
  changed = true;
  console.log('[patch] Injected fluxer-bridge.js tag into index.html');
}

if (changed) {
  fs.writeFileSync(indexPath, html);
} else {
  console.log('[patch] index.html already patched — skipping');
}

console.log('[patch] All done.');
