import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import type Database from "better-sqlite3";
import { ensureEpisodeDir, getEpisodePath, getPodcastsRoot } from "./podcast-storage";
import { DOWNLOAD_HEADERS } from "../utils/download-headers";

interface EpisodeRow {
  id: number;
  subscription_id: number;
  enclosure_url: string;
  file_size: number | null;
  local_path: string | null;
  download_state: string;
}

type DownloadResult = { localPath: string } | { error: string };

/**
 * Episodes currently being downloaded, keyed by episode id. Overlapping
 * triggers (a manual "Download now" racing the auto-refresh scheduler) used to
 * download the same episode twice into the same temp file; one attempt would
 * win the rename and the other would fail with ENOENT and clobber the already
 * 'ready' row back to 'failed'. De-duping concurrent calls makes the second
 * caller await the first instead of starting a competing download.
 */
const inFlight = new Map<number, Promise<DownloadResult>>();

function extFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const ext = path.extname(u.pathname);
    return ext || ".mp3";
  } catch {
    return ".mp3";
  }
}

export function downloadEpisode(
  db: Database.Database,
  episodeId: number,
  feedId: number
): Promise<DownloadResult> {
  const existing = inFlight.get(episodeId);
  if (existing) return existing;

  const p = runDownload(db, episodeId, feedId).finally(() => {
    inFlight.delete(episodeId);
  });
  inFlight.set(episodeId, p);
  return p;
}

async function runDownload(
  db: Database.Database,
  episodeId: number,
  feedId: number
): Promise<DownloadResult> {
  const row = db
    .prepare("SELECT id, subscription_id, enclosure_url, file_size, local_path, download_state FROM podcast_episodes WHERE id = ?")
    .get(episodeId) as EpisodeRow | undefined;

  if (!row) return { error: "Episode not found" };

  // Already downloaded, file exists, and is in the current download root
  const currentRoot = getPodcastsRoot();
  if (row.local_path && row.local_path.startsWith(currentRoot) && fs.existsSync(row.local_path)) {
    db.prepare("UPDATE podcast_episodes SET download_state = 'ready' WHERE id = ?").run(episodeId);
    return { localPath: row.local_path };
  }

  const ext = extFromUrl(row.enclosure_url);
  const localPath = getEpisodePath(feedId, episodeId, ext);

  db.prepare("UPDATE podcast_episodes SET download_state = 'downloading', local_path = ? WHERE id = ?").run(localPath, episodeId);

  try {
    ensureEpisodeDir(feedId);

    const res = await fetch(row.enclosure_url, {
      headers: DOWNLOAD_HEADERS,
    });

    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    // Unique temp name so a concurrent attempt can't rename our file out from
    // under us (which surfaced as ENOENT on rename). renameSync onto the final
    // path is atomic, so the last writer wins and the row ends up 'ready'.
    const tmpPath = `${localPath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      const dest = fs.createWriteStream(tmpPath);
      await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), dest);
      fs.renameSync(tmpPath, localPath);
    } finally {
      try { fs.unlinkSync(tmpPath); } catch { /* already renamed or never created */ }
    }

    const stat = fs.statSync(localPath);
    db.prepare(
      "UPDATE podcast_episodes SET download_state = 'ready', local_path = ?, file_size = ?, download_error = NULL WHERE id = ?"
    ).run(localPath, stat.size, episodeId);

    return { localPath };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    db.prepare(
      "UPDATE podcast_episodes SET download_state = 'failed', download_error = ? WHERE id = ?"
    ).run(msg, episodeId);
    return { error: msg };
  }
}
