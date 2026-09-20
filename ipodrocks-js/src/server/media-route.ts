import * as fs from "fs";
import * as path from "path";
import type { Request, Response } from "express";
import { isServableMediaPath } from "../main/player/media-path";
import { verifyMediaToken } from "./media-token";

/**
 * `GET /api/media/:token` — the web-mode equivalent of the `media://` scheme.
 *
 * Two independent gates, and both must stay. The token proves the server itself
 * minted this URL for this session; `isServableMediaPath()` — the same function
 * the Electron protocol handler calls — proves the path is one this app is
 * willing to serve at all. The token alone would be enough only for as long as
 * nobody ever mints one from a path that came in over IPC.
 */

const MIME_BY_EXT: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".m4b": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".aiff": "audio/aiff",
  ".aif": "audio/aiff",
  ".wma": "audio/x-ms-wma",
  ".mpc": "audio/x-musepack",
  ".wv": "audio/x-wavpack",
  ".ape": "audio/x-ape",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function contentTypeFor(filePath: string): string {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Parses a single-range `Range: bytes=…` header.
 *
 * Multi-range requests are answered with the whole file rather than a
 * `multipart/byteranges` body: no browser media element asks for one, and a
 * half-implemented multipart encoder is worse than not advertising support.
 */
export function parseRange(
  header: string | undefined,
  size: number
): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, startRaw, endRaw] = match;
  if (startRaw === "" && endRaw === "") return null;

  let start: number;
  let end: number;
  if (startRaw === "") {
    // `bytes=-N` — the last N bytes.
    const suffix = Number.parseInt(endRaw, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number.parseInt(startRaw, 10);
    end = endRaw === "" ? size - 1 : Number.parseInt(endRaw, 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    end = Math.min(end, size - 1);
  }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

export function handleMediaRequest(req: Request, res: Response): void {
  const token = String(req.params.token ?? "");
  const sessionId = req.sessionID ?? null;

  const filePath = verifyMediaToken(token, sessionId);
  if (!filePath) {
    res.status(403).type("text/plain").send("Forbidden");
    return;
  }

  const resolved = path.resolve(filePath);
  if (!isServableMediaPath(resolved)) {
    res.status(403).type("text/plain").send("Forbidden");
    return;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
    if (!stat.isFile()) throw new Error("not a file");
  } catch {
    res.status(404).type("text/plain").send("Not found");
    return;
  }

  res.setHeader("Content-Type", contentTypeFor(resolved));
  res.setHeader("Accept-Ranges", "bytes");
  // The token already expires; a shared cache holding the body would outlive
  // it and is not something a media URL needs.
  res.setHeader("Cache-Control", "private, max-age=0, no-store");

  const range = parseRange(req.headers.range, stat.size);
  if (range === "unsatisfiable") {
    res.setHeader("Content-Range", `bytes */${stat.size}`);
    res.status(416).end();
    return;
  }

  if (req.method === "HEAD") {
    res.setHeader("Content-Length", String(stat.size));
    res.status(200).end();
    return;
  }

  if (range) {
    const length = range.end - range.start + 1;
    res.status(206);
    res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${stat.size}`);
    res.setHeader("Content-Length", String(length));
    const stream = fs.createReadStream(resolved, { start: range.start, end: range.end });
    stream.on("error", () => res.destroy());
    stream.pipe(res);
    return;
  }

  res.status(200);
  res.setHeader("Content-Length", String(stat.size));
  const stream = fs.createReadStream(resolved);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}
