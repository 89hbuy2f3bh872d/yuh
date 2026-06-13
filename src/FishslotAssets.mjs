/**
 * FishslotAssets.mjs
 *
 * Downloads every static file from vermingov/fishslot at startup and caches
 * them in memory. Uses the pinned commit SHA because the repo has no branch.
 */

import https from "https";
import zlib from "zlib";

// Pinned commit — the repo has no named branch, only this SHA
const COMMIT = "d68ccb40c7565e4f4ca00d3e5d84a7d0c60c7bec";
const RAW_BASE = `https://raw.githubusercontent.com/vermingov/fishslot/${COMMIT}`;

// Every file in the repo (root + scripts/ + images/ + media/)
const FISHSLOT_FILES = [
  // Root
  "index.html",
  "style.css",
  "data.json",
  "sw.js",
  "workermain.js",
  "offline.json",
  "appmanifest.json",
  // Scripts
  "scripts/main.js",
  "scripts/c3runtime.js",
  "scripts/dispatchworker.js",
  "scripts/jobworker.js",
  "scripts/offlineclient.js",
  "scripts/opus.wasm.js",
  "scripts/opus.wasm.wasm",
  "scripts/register-sw.js",
  "scripts/supportcheck.js",
  // Images
  "images/lines-sheet0.webp",
  "images/lines-sheet1.webp",
  "images/multif-sheet0.webp",
  "images/paytablesymbol-sheet0.webp",
  "images/posidon-sheet0.webp",
  "images/posidon-sheet1.webp",
  "images/posidon-sheet2.webp",
  "images/shared-0-sheet0.webp",
  "images/shared-0-sheet1.webp",
  "images/shared-0-sheet2.webp",
  "images/sprite3-sheet0.webp",
  "images/symbol-sheet0.webp",
  "images/tiledbackground-sheet0.webp",
  "images/tiledbackground2-sheet0.webp",
  "images/xfre-sheet0.webp",
  "images/xfre-sheet1.webp",
  "images/xfre-sheet2.webp",
  // Media (audio/video)
  "media/Button.webm",
  "media/Epic Sea Battles.webm",
  "media/Fishing.webm",
  "media/Stop1.webm",
  "media/Stop2.webm",
  "media/Stop3.webm",
  "media/Stop4.webm",
  "media/Stop5.webm",
  "media/drop.webm",
  "media/scatter.webm",
];

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
};

function extOf(p) {
  const i = p.lastIndexOf(".");
  return i === -1 ? "" : p.slice(i).toLowerCase();
}

export function mimeOf(path) {
  return MIME[extOf(path)] ?? "application/octet-stream";
}

// In-memory cache: "/relative/path" → Buffer
const _cache = new Map();
let _loaded = false;

function fetchRaw(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "SirGreenCasino/2.0" } }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        return resolve(fetchRaw(res.headers.location));
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks);
        const enc = (res.headers["content-encoding"] ?? "").toLowerCase();
        try {
          const body = enc === "br"      ? zlib.brotliDecompressSync(raw)
                     : enc === "gzip"    ? zlib.gunzipSync(raw)
                     : enc === "deflate" ? zlib.inflateSync(raw)
                     : raw;
          resolve({ statusCode: res.statusCode, body });
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
  });
}

/**
 * Download all fishslot assets into memory. Call once at bot startup.
 */
export async function preloadFishslotAssets() {
  if (_loaded) return;
  console.log("[Fishslot] Pre-loading game assets…");
  const results = await Promise.allSettled(
    FISHSLOT_FILES.map(async (file) => {
      // URL-encode spaces (e.g. "Epic Sea Battles.webm")
      const encoded = file.split("/").map(encodeURIComponent).join("/");
      const url = `${RAW_BASE}/${encoded}`;
      const { statusCode, body } = await fetchRaw(url);
      if (statusCode !== 200) {
        console.warn(`[Fishslot] Warning: ${file} returned HTTP ${statusCode}`);
        return;
      }
      _cache.set("/" + file, body);
    })
  );
  const failed = results.filter(r => r.status === "rejected");
  if (failed.length) {
    console.warn(`[Fishslot] ${failed.length} fetch(es) threw:`, failed.map(f => f.reason?.message ?? f.reason));
  }
  _loaded = true;
  console.log(`[Fishslot] ${_cache.size} / ${FISHSLOT_FILES.length} assets loaded.`);
}

/**
 * Return a cached asset by its path relative to the fishslot root.
 * e.g. "/index.html", "/scripts/main.js", "/images/posidon-sheet0.webp"
 * Returns null if not found.
 */
export function getFishslotAsset(assetPath) {
  const buf = _cache.get(assetPath);
  if (!buf) return null;
  return { body: buf, mime: mimeOf(assetPath) };
}
