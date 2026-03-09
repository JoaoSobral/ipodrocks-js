/**
 * Copies the current platform's FFmpeg binary from @ffmpeg-installer/ffmpeg
 * to ffmpeg-bin/ for electron-builder extraResources.
 */
const fs = require("fs");
const path = require("path");

const ffmpeg = require("@ffmpeg-installer/ffmpeg");
const src = ffmpeg.path;
const isWin = process.platform === "win32";
const name = isWin ? "ffmpeg.exe" : "ffmpeg";
const outDir = path.join(__dirname, "..", "ffmpeg-bin");
const dest = path.join(outDir, name);

if (!fs.existsSync(src)) {
  console.error("FFmpeg binary not found at", src);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(src, dest);
console.log("Copied FFmpeg to", dest);
