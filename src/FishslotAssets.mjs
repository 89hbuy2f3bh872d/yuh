/**
 * FishslotAssets.mjs
 *
 * Serves the fishslot PWA from disk (public/fishslot/) using Node's fs module.
 * The files are put there by scripts/setup-fishslot.sh (git clone) which the
 * bot runs automatically on startup if the directory is missing.
 */

import fs   from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const GAME_ROOT  = path.resolve(__dirname, "..", "public", "fishslot");
const SETUP_SH   = path.resolve(__dirname, "..", "scripts", "setup-fishslot.sh");

// MIME type map
const MIME = {
  ".html":  "text/html; charset=utf-8",
  ".css":   "text/css; charset=utf-8",
  ".js":    "application/javascript; charset=utf-8",
  ".json":  "application/json; charset=utf-8",
  ".wasm":  "application/wasm",
  ".webp":  "image/webp",
  ".png":   "image/png",
  ".jpg":   "image/jpeg",
  ".jpeg":  "image/jpeg",
  ".webm":  "audio/webm",
  ".ogg":   "audio/ogg",
  ".mp3":   "audio/mpeg",
  ".mp4":   "video/mp4",
  ".ico":   "image/x-icon",
  ".svg":   "image/svg+xml",
};

function extOf(p) {
  const i = p.lastIndexOf(".");
  return i === -1 ? "" : p.slice(i).toLowerCase();
}

export function mimeOf(filePath) {
  return MIME[extOf(filePath)] ?? "application/octet-stream";
}

/**
 * Ensure the fishslot game files are present on disk.
 * Runs scripts/setup-fishslot.sh if public/fishslot/ doesn't exist.
 */
export async function preloadFishslotAssets() {
  const indexPath = path.join(GAME_ROOT, "index.html");
  if (fs.existsSync(indexPath)) {
    console.log("[Fishslot] Game files found at", GAME_ROOT);
    return;
  }
  console.log("[Fishslot] Game files not found — running setup-fishslot.sh");
  try {
    execSync(`bash "${SETUP_SH}"`, { stdio: "inherit" });
    console.log("[Fishslot] Setup complete.");
  } catch (e) {
    console.error("[Fishslot] setup-fishslot.sh failed:", e.message);
    console.error("[Fishslot] Run: bash scripts/setup-fishslot.sh  then restart the bot.");
  }
}

/**
 * Serve a fishslot static asset directly from disk.
 * @param {string} assetPath - path relative to fishslot root, e.g. "/scripts/main.js"
 * @returns {{ body: Buffer, mime: string } | null}
 */
export function getFishslotAsset(assetPath) {
  // Safety: prevent path traversal
  const safe = path.normalize(assetPath).replace(/^(\.\.[/\\])+/, "");
  const full = path.join(GAME_ROOT, safe);

  // Must stay inside GAME_ROOT
  if (!full.startsWith(GAME_ROOT + path.sep) && full !== GAME_ROOT) return null;

  try {
    const body = fs.readFileSync(full);
    return { body, mime: mimeOf(full) };
  } catch {
    return null;
  }
}
