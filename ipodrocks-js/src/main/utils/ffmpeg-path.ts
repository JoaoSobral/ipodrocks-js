import * as fs from "fs";
import * as path from "path";
import { isPackaged } from "../host";

let cachedFfmpegPath: string | null = null;

export function getFfmpegPath(): string {
  if (cachedFfmpegPath) return cachedFfmpegPath;
  // The Node host always reports false, so the bundled-resources branch is
  // skipped outside a packaged Electron app — headless servers and
  // ELECTRON_RUN_AS_NODE tooling fall through to the npm-installed binary.
  if (isPackaged() && process.resourcesPath) {
    const name = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
    const candidate = path.join(process.resourcesPath, "ffmpeg", name);
    if (fs.existsSync(candidate)) {
      cachedFfmpegPath = candidate;
      return candidate;
    }
  }
  const ffmpeg = require("@ffmpeg-installer/ffmpeg");
  cachedFfmpegPath = ffmpeg.path;
  return cachedFfmpegPath as string;
}
