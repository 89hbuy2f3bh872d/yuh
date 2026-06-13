/**
 * FishslotAssets.mjs
 *
 * Serves the fishslot PWA from disk (public/fishslot/) using Node's fs module.
 *
 * On every bot startup:
 *   - If the directory doesn't exist OR index.html is missing: fresh clone.
 *   - If it does exist: git pull --ff-only; if that fails, hard-reset to
 *     origin/main so broken/partial clones are self-healing.
 *   - Always re-run the patcher so FluxerBridge is current.
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
    : 'public, max-age=86400';
}

export async function preloadFishslotAssets() {
  const indexPath = path.join(GAME_ROOT, 'index.html');
  const gitDir    = path.join(GAME_ROOT, '.git');

  if (!fs.existsSync(indexPath)) {
    // ── Fresh clone ─────────────────────────────────────────────────────────
    console.log('[Fishslot] Game files not found — running setup-fishslot.sh');
    // Wipe any partial directory so clone doesn't fail
    if (fs.existsSync(GAME_ROOT)) {
      try { execSync(`rm -rf "${GAME_ROOT}"`, { stdio: 'inherit' }); } catch (_) {}
    }
    try {
      execSync(`bash "${SETUP_SH}"`, { stdio: 'inherit' });
    } catch (e) {
      console.error('[Fishslot] setup-fishslot.sh failed:', e.message);
      return;
    }
  } else if (fs.existsSync(gitDir)) {
    // ── Pull latest, hard-reset if needed ───────────────────────────────────
    console.log('[Fishslot] Pulling latest game files from GitHub...');
    try {
      const result = execSync(
        `git -C "${GAME_ROOT}" pull --ff-only 2>&1`
      ).toString().trim();
      console.log('[Fishslot] git pull:', result);
    } catch (pullErr) {
      console.warn('[Fishslot] git pull --ff-only failed — attempting hard reset...');
      try {
        // Fetch first so origin/main is up to date, then reset local to match
        execSync(`git -C "${GAME_ROOT}" fetch origin 2>&1`, { stdio: 'inherit' });
        execSync(`git -C "${GAME_ROOT}" reset --hard origin/main 2>&1`, { stdio: 'inherit' });
        console.log('[Fishslot] Hard reset to origin/main succeeded.');
      } catch (resetErr) {
        console.error('[Fishslot] Hard reset failed — wiping and re-cloning...');
        try {
          execSync(`rm -rf "${GAME_ROOT}"`, { stdio: 'inherit' });
          execSync(`bash "${SETUP_SH}"`, { stdio: 'inherit' });
        } catch (cloneErr) {
          console.error('[Fishslot] Re-clone failed:', cloneErr.message);
          return;
        }
      }
    }
  } else {
    console.warn('[Fishslot] Game dir exists but is not a git repo — wiping and re-cloning...');
    try {
      execSync(`rm -rf "${GAME_ROOT}"`, { stdio: 'inherit' });
      execSync(`bash "${SETUP_SH}"`, { stdio: 'inherit' });
    } catch (e) {
      console.error('[Fishslot] Re-clone failed:', e.message);
      return;
    }
  }

  // ── Always re-run patcher so bridge is current ──────────────────────────
  console.log('[Fishslot] Running patcher...');
  try {
    execSync(`node "${PATCH_JS}" "${GAME_ROOT}"`, { stdio: 'inherit' });
    console.log('[Fishslot] Game files found and patched at', GAME_ROOT);
  } catch (e) {
    console.error('[Fishslot] Patch failed:', e.message);
  }
}

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
