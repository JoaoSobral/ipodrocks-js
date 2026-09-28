import * as fs from "fs";
import * as path from "path";
import { safeFetch } from "../utils/safe-fetch";
import * as crypto from "crypto";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import type Database from "better-sqlite3";
import { ensureChapterDir, getAudiobooksRoot, getChapterPath } from "./audiobook-storage";
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

interface ChapterRow {
  id: number;
  subscription_id: number;
  librivox_id: number;
  enclosure_url: string;
  file_size: number | null;
  local_path: string | null;
  download_state: string;
}

type DownloadResult = { localPath: string } | { error: string };

/** Chapters currently downloading, keyed by id — see podcast-downloader for the
 * race this prevents (concurrent attempts clobbering each other's temp file). */
const inFlight = new Map<number, Promise<DownloadResult>>();

/** See `isUsableEpisodeFile` in podcast-downloader — the same rule for chapters. */
function isUsableChapterFile(localPath: string): boolean {
  if (!isAllowedEnclosureExtension(path.extname(localPath))) return false;
  try {
    return sniffAudioFile(localPath) !== null;
  } catch {
    return false;
  }
}

/**
 * Downloads one chapter. `signal` — the device sync's cancel, when a sync is
 * downloading on demand — is combined with the download's own time bounds: it
 * can end a download early, never lift a bound. A caller that joins a chapter
 * already in flight shares that download, and with it the first caller's
 * signal.
 */
export function downloadChapter(
  db: Database.Database,
  chapterId: number,
  signal?: AbortSignal
): Promise<DownloadResult> {
  const existing = inFlight.get(chapterId);
  if (existing) return existing;

  const p = runDownload(db, chapterId, signal).finally(() => {
    inFlight.delete(chapterId);
  });
  inFlight.set(chapterId, p);
  return p;
}

async function runDownload(
  db: Database.Database,
  chapterId: number,
  callerSignal?: AbortSignal
): Promise<DownloadResult> {
  const row = db
    .prepare(
      `SELECT ac.id, ac.subscription_id, ac.enclosure_url, ac.file_size, ac.local_path, ac.download_state,
              asub.librivox_id
       FROM audiobook_chapters ac
       JOIN audiobook_subscriptions asub ON asub.id = ac.subscription_id
       WHERE ac.id = ?`
    )
    .get(chapterId) as ChapterRow | undefined;

  if (!row) return { error: "Chapter not found" };

  if (row.local_path && fs.existsSync(row.local_path) && row.download_state === "ready") {
    if (isUsableChapterFile(row.local_path)) return { localPath: row.local_path };
    // Written before enclosures were sniffed, and not audio: never hand it on.
    // Deleted only when it is ours — under the audiobooks root.
    if (path.resolve(row.local_path).startsWith(path.resolve(getAudiobooksRoot()) + path.sep)) {
      try { fs.unlinkSync(row.local_path); } catch { /* re-download regardless */ }
    }
  }

  // A placeholder until the bytes are in; see audio-sniff.ts for why the URL
  // does not get to choose the extension.
  let localPath = getChapterPath(row.librivox_id, chapterId, provisionalEnclosureExtension(row.enclosure_url));

  db.prepare("UPDATE audiobook_chapters SET download_state = 'downloading', local_path = ? WHERE id = ?").run(
    localPath,
    chapterId
  );

  const watchdog = downloadWatchdog(callerSignal);
  try {
    ensureChapterDir(row.librivox_id);

    // enclosure_url comes from a feed the caller chose, so it is no more
    // trusted than the feed URL itself — its address, its timing and its bytes.
    const res = await safeFetch(row.enclosure_url, {
      headers: DOWNLOAD_HEADERS,
      signal: watchdog.signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    const tmpPath = `${localPath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      const dest = fs.createWriteStream(tmpPath);
      await pipeline(
        Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
        watchdog.meter,
        byteCapTransform(),
        dest
      );
      // Judge the bytes before anything else can open them.
      const container = sniffAudioFile(tmpPath);
      if (!container) throw new NotAudioError();
      localPath = getChapterPath(
        row.librivox_id,
        chapterId,
        enclosureExtension(row.enclosure_url, container)
      );
      fs.renameSync(tmpPath, localPath);
    } finally {
      try { fs.unlinkSync(tmpPath); } catch { /* already renamed or never created */ }
    }

    const stat = fs.statSync(localPath);
    db.prepare(
      "UPDATE audiobook_chapters SET download_state = 'ready', local_path = ?, file_size = ?, download_error = NULL WHERE id = ?"
    ).run(localPath, stat.size, chapterId);

    return { localPath };
  } catch (err) {
    const msg = downloadErrorMessage(err, watchdog.signal);
    db.prepare(
      "UPDATE audiobook_chapters SET download_state = 'failed', download_error = ? WHERE id = ?"
    ).run(msg, chapterId);
    return { error: msg };
  } finally {
    watchdog.dispose();
  }
}
