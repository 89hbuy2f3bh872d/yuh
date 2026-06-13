/**
 * FishslotAssets.mjs
 *
 * Serves the fishslot PWA from disk (public/fishslot/) using Node's fs module.
 *
 * On every bot startup:
 *   - If the directory doesn't exist: clone from GitHub and patch.
 *   - If it does exist: git pull (to pick up game updates) then re-run the
 *     patcher so the FluxerBridge is always current.
 *
 * JS/HTML assets are served with Cache-Control: no-cache so browsers always
 * revalidate — prevents stale c3runtime.js / index.html being served from
 * browser or SW cache after a redeploy.
 */

import fs   from 'fs';
import path from 'path';
import { execSync }      from 'child_process';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const GAME_ROOT  = path.resolve(__dirname, '..', 'public', 'fishslot');
const SETUP_SH   = path.resolve(__dirname, '..', 'scripts', 'setup-fishslot.sh');
const PATCH_JS   = path.resolve(__dirname, '..', 'scripts', 'patch-fishslot.js');

// MIME type map
const MIME = {
  '.html':  'text/html; charset=utf-8',
  '.css':   'text/css; charset=utf-8',
  '.js':    'application/javascript; charset=utf-8',
  '.json':  'application/json; charset=utf-8',
  '.wasm':  'application/wasm',
  '.webp':  'image/webp',
  '.png':   'image/png',
  '.jpg':   'image/jpeg',
  '.jpeg':  'image/jpeg',
  '.webm':  'audio/webm',
  '.ogg':   'audio/ogg',
  '.mp3':   'audio/mpeg',
  '.mp4':   'video/mp4',
  '.ico':   'image/x-icon',
  '.svg':   'image/svg+xml',
};

// Assets that must never be cached by the browser — always revalidate
const NO_CACHE_EXTS = new Set(['.html', '.js', '.json']);

function extOf(p) {
  const i = p.lastIndexOf('.');
  return i === -1 ? '' : p.slice(i).toLowerCase();
}

export function mimeOf(filePath) {
  return MIME[extOf(filePath)] ?? 'application/octet-stream';
}

export function cacheHeaderFor(filePath) {
  return NO_CACHE_EXTS.has(extOf(filePath))
    ? 'no-cache, no-store, must-revalidate'
    : 'public, max-age=86400';   // images/audio/wasm: cache 24h (they never change between redeploys)
}

/**
 * Ensure the fishslot game files are present, up-to-date, and patched.
 *
 * Runs on every bot startup:
 *   1. Clone if missing.
 *   2. git pull if already present (get latest game changes).
 *   3. Always re-run patcher so FluxerBridge is current.
 */
export async function preloadFishslotAssets() {
  const indexPath = path.join(GAME_ROOT, 'index.html');
  const gitDir    = path.join(GAME_ROOT, '.git');

  if (!fs.existsSync(indexPath)) {
    // ── First run: clone ────────────────────────────────────────────────────
    console.log('[Fishslot] Game files not found — running setup-fishslot.sh');
    try {
      execSync(`bash "${SETUP_SH}"`, { stdio: 'inherit' });
    } catch (e) {
      console.error('[Fishslot] setup-fishslot.sh failed:', e.message);
      console.error('[Fishslot] Run:  bash scripts/setup-fishslot.sh  then restart.');
      return;
    }
  } else if (fs.existsSync(gitDir)) {
    // ── Subsequent runs: pull latest ────────────────────────────────────────
    console.log('[Fishslot] Pulling latest game files from GitHub...');
    try {
      const result = execSync(`git -C "${GAME_ROOT}" pull --ff-only 2>&1`).toString().trim();
      console.log('[Fishslot] git pull:', result);
    } catch (e) {
      // Non-fatal — log and continue with existing files
      console.warn('[Fishslot] git pull failed (continuing with existing files):', e.message);
    }
  } else {
    console.warn('[Fishslot] Game dir exists but is not a git repo — skipping pull.');
  }

  // ── Always re-run patcher so bridge is current ──────────────────────────
  console.log('[Fishslot] Running patcher...');
  try {
    execSync(`node "${PATCH_JS}" "${GAME_ROOT}"`, { stdio: 'inherit' });
  } catch (e) {
    console.error('[Fishslot] Patch failed:', e.message);
  }
}

/**
 * Serve a fishslot static asset directly from disk.
 * @param {string} assetPath - path relative to fishslot root, e.g. "/scripts/main.js"
 * @returns {{ body: Buffer, mime: string, cacheControl: string } | null}
 */
export function getFishslotAsset(assetPath) {
  const safe = path.normalize(assetPath).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(GAME_ROOT, safe);

  if (!full.startsWith(GAME_ROOT + path.sep) && full !== GAME_ROOT) return null;

  try {
    const body = fs.readFileSync(full);
    return { body, mime: mimeOf(full), cacheControl: cacheHeaderFor(full) };
  } catch {
    return null;
  }
}
