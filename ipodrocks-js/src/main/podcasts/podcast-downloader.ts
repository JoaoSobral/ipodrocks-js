import * as fs from "fs";
import * as path from "path";
import { safeFetch } from "../utils/safe-fetch";
import * as crypto from "crypto";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import type Database from "better-sqlite3";
import { ensureEpisodeDir, getEpisodePath, getPodcastsRoot } from "./podcast-storage";
import { DOWNLOAD_HEADERS } from "../utils/download-headers";
import {
  byteCapTransform,
  downloadErrorMessage,
  downloadWatchdog,
} from "../utils/capped-stream";
import {
  NotAudioError,
  enclosureExtension,
  isAllowedEnclosureExtension,
  provisionalEnclosureExtension,
  sniffAudioFile,
} from "../utils/audio-sniff";

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

/**
 * True when a file we already hold may be handed out as the episode: an
 * allowlisted extension *and* audio bytes. Files written before the enclosure
 * was sniffed can be anything the feed served, under any extension it chose.
 */
function isUsableEpisodeFile(localPath: string): boolean {
  if (!isAllowedEnclosureExtension(path.extname(localPath))) return false;
  try {
    return sniffAudioFile(localPath) !== null;
  } catch {
    return false;
  }
}

/**
 * Downloads one episode. `signal` (a device sync's cancel, say) is combined
 * with the download's own time bounds — it can end a download early, never
 * lift a bound. A caller that joins an episode already in flight shares that
 * download, and with it the first caller's signal.
 */
export function downloadEpisode(
  db: Database.Database,
  episodeId: number,
  feedId: number,
  signal?: AbortSignal
): Promise<DownloadResult> {
  const existing = inFlight.get(episodeId);
  if (existing) return existing;

  const p = runDownload(db, episodeId, feedId, signal).finally(() => {
    inFlight.delete(episodeId);
  });
  inFlight.set(episodeId, p);
  return p;
}

async function runDownload(
  db: Database.Database,
  episodeId: number,
  feedId: number,
  callerSignal?: AbortSignal
): Promise<DownloadResult> {
  const row = db
    .prepare("SELECT id, subscription_id, enclosure_url, file_size, local_path, download_state FROM podcast_episodes WHERE id = ?")
    .get(episodeId) as EpisodeRow | undefined;

  if (!row) return { error: "Episode not found" };

  // Already downloaded, file exists, and is in the current download root
  const currentRoot = getPodcastsRoot();
  if (row.local_path && row.local_path.startsWith(currentRoot) && fs.existsSync(row.local_path)) {
    if (isUsableEpisodeFile(row.local_path)) {
      db.prepare("UPDATE podcast_episodes SET download_state = 'ready' WHERE id = ?").run(episodeId);
      return { localPath: row.local_path };
    }
    // Ours (it is under the podcasts root) and not audio: never hand it on.
    try { fs.unlinkSync(row.local_path); } catch { /* re-download regardless */ }
  }

  // A placeholder until the bytes are in; see audio-sniff.ts for why the URL
  // does not get to choose the extension.
  let localPath = getEpisodePath(feedId, episodeId, provisionalEnclosureExtension(row.enclosure_url));

  db.prepare("UPDATE podcast_episodes SET download_state = 'downloading', local_path = ? WHERE id = ?").run(localPath, episodeId);

  const watchdog = downloadWatchdog(callerSignal);
  try {
    ensureEpisodeDir(feedId);

    // enclosure_url comes from a feed the caller chose, so it is no more
    // trusted than the feed URL itself — its address, its timing and its bytes.
    const res = await safeFetch(row.enclosure_url, {
      headers: DOWNLOAD_HEADERS,
      signal: watchdog.signal,
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
      await pipeline(
        Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
        watchdog.meter,
        byteCapTransform(),
        dest
      );
      // Judge the bytes before anything else can open them — the scanner,
      // music-metadata and ffmpeg all read this file next.
      const container = sniffAudioFile(tmpPath);
      if (!container) throw new NotAudioError();
      localPath = getEpisodePath(feedId, episodeId, enclosureExtension(row.enclosure_url, container));
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
    const msg = downloadErrorMessage(err, watchdog.signal);
    db.prepare(
      "UPDATE podcast_episodes SET download_state = 'failed', download_error = ? WHERE id = ?"
    ).run(msg, episodeId);
    return { error: msg };
  } finally {
    watchdog.dispose();
  }
}
