#!/usr/bin/env node
/**
 * Diagnostic script to analyze a music folder and compare with iPodRocks supported formats.
 * Usage: node scripts/analyze-music-folder.mjs [/path/to/music]
 * Default: /media/music/
 */

import fs from "fs";
import path from "path";

const LIBRARY_AUDIO_EXTENSIONS = new Set([
  ".m4a",
  ".mp3",
  ".flac",
  ".wav",
  ".aiff",
  ".aif",
  ".ogg",
  ".opus",
]);

function walk(dir, stats = { totalItems: 0, files: 0, dirs: 0, byExt: {}, unsupported: [] }) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.error(`Cannot read ${dir}:`, err.message);
    return stats;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    stats.totalItems++;
    if (entry.isDirectory()) {
      stats.dirs++;
      walk(full, stats);
    } else if (entry.isFile()) {
      stats.files++;
      const ext = path.extname(entry.name).toLowerCase();
      stats.byExt[ext] = (stats.byExt[ext] || 0) + 1;
      if (!LIBRARY_AUDIO_EXTENSIONS.has(ext) && ext) {
        stats.unsupported.push(full);
      }
    }
  }
  return stats;
}

const folder = process.argv[2] || "/media/music/";
const resolved = path.resolve(folder);

if (!fs.existsSync(resolved)) {
  console.error(`Folder does not exist: ${resolved}`);
  process.exit(1);
}

console.log(`\nAnalyzing: ${resolved}\n`);
const stats = walk(resolved);

const supportedCount = Object.entries(stats.byExt)
  .filter(([ext]) => LIBRARY_AUDIO_EXTENSIONS.has(ext))
  .reduce((sum, [, n]) => sum + n, 0);

const unsupportedCount = stats.unsupported.length;

console.log("=== COUNTS ===");
console.log(`Total items (files + dirs): ${stats.totalItems}`);
console.log(`Directories: ${stats.dirs}`);
console.log(`Files: ${stats.files}`);
console.log(`Supported audio files: ${supportedCount}`);
console.log(`Unsupported (other extensions): ${unsupportedCount}`);
console.log("");

console.log("=== FILES BY EXTENSION (all) ===");
const sorted = Object.entries(stats.byExt).sort((a, b) => b[1] - a[1]);
for (const [ext, count] of sorted) {
  const supported = LIBRARY_AUDIO_EXTENSIONS.has(ext) ? " ✓" : " ✗";
  console.log(`  ${ext || "(no ext)"}: ${count}${supported}`);
}
console.log("");

if (stats.unsupported.length > 0) {
  console.log("=== SAMPLE UNSUPPORTED FILES (first 30) ===");
  stats.unsupported.slice(0, 30).forEach((f) => console.log(`  ${f}`));
  if (stats.unsupported.length > 30) {
    console.log(`  ... and ${stats.unsupported.length - 30} more`);
  }
}

console.log("\n=== SUMMARY ===");
console.log(`Expected in library (supported): ${supportedCount}`);
console.log(`Your iPodRocks shows: 2782`);
if (supportedCount > 2782) {
  console.log(`Gap: ${supportedCount - 2782} files may be skipped (errors, duplicates, or sync filter)`);
} else if (supportedCount < 2782) {
  console.log(`Library has more than folder - possible multiple folders or prior scans`);
}
