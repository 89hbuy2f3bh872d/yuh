/**
 * FishslotAssets.mjs
 *
 * Downloads every static file from vermingov/fishslot on GitHub at startup
 * and caches them in memory so the Express-like WebServer can serve them
 * without any GitHub Pages dependency.
 *
 * Files are fetched once, lazily on first request, then cached.
 */

import https from "https";
import zlib from "zlib";

const RAW_BASE = "https://raw.githubusercontent.com/vermingov/fishslot/main";

// All paths in the fishslot repo (relative to root)
const FISHSLOT_FILES = [
  "index.html",
  "style.css",
  "data.json",
  "sw.js",
  "workermain.js",
  "offline.json",
  "appmanifest.json",
  "scripts/main.js",
  "scripts/c3runtime.js",
  "scripts/dispatchworker.js",
  "scripts/jobworker.js",
  "scripts/offlineclient.js",
  "scripts/opus.wasm.js",
  "scripts/opus.wasm.wasm",
  "scripts/register-sw.js",
  "scripts/supportcheck.js",
];

// MIME type map
const MIME = {
  ".html":  "text/html; charset=utf-8",
  ".css":   "text/css; charset=utf-8",
  ".js":    "application/javascript; charset=utf-8",
  ".json":  "application/json; charset=utf-8",
  ".wasm":  "application/wasm",
  ".png":   "image/png",
  ".jpg":   "image/jpeg",
  ".jpeg":  "image/jpeg",
  ".webp":  "image/webp",
  ".ogg":   "audio/ogg",
  ".webm":  "audio/webm",
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

// In-memory cache: path → Buffer
const _cache = new Map();
let _allLoaded = false;

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
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
  });
}

/**
 * Eagerly download all known fishslot files into memory.
 * Call this once during bot startup.
 */
export async function preloadFishslotAssets() {
  if (_allLoaded) return;
  console.log("[Fishslot] Pre-loading game assets from GitHub…");
  const results = await Promise.allSettled(
    FISHSLOT_FILES.map(async (file) => {
      const url = `${RAW_BASE}/${file}`;
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
    console.warn(`[Fishslot] ${failed.length} asset(s) failed to load:`, failed.map(f => f.reason));
  }
  _allLoaded = true;
  console.log(`[Fishslot] ${_cache.size} assets loaded.`);
}

/**
 * Serve a fishslot static asset.
 * @param {string} assetPath - path relative to fishslot root, e.g. "/scripts/main.js"
 * @returns {{ body: Buffer, mime: string } | null}
 */
export function getFishslotAsset(assetPath) {
  // Normalise: /fishslot/ → /index.html, /fishslot/scripts/main.js → /scripts/main.js
  const buf = _cache.get(assetPath);
  if (!buf) return null;
  return { body: buf, mime: mimeOf(assetPath) };
}
