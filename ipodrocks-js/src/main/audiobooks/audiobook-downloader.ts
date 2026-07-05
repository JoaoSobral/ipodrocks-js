import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import type Database from "better-sqlite3";
import { ensureChapterDir, getChapterPath } from "./audiobook-storage";
import { DOWNLOAD_HEADERS } from "../utils/download-headers";
import { byteCapTransform } from "../utils/capped-stream";

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

function extFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const ext = path.extname(u.pathname);
    return ext || ".mp3";
  } catch {
    return ".mp3";
  }
}

export function downloadChapter(
  db: Database.Database,
  chapterId: number
): Promise<DownloadResult> {
  const existing = inFlight.get(chapterId);
  if (existing) return existing;

  const p = runDownload(db, chapterId).finally(() => {
    inFlight.delete(chapterId);
  });
  inFlight.set(chapterId, p);
  return p;
}

async function runDownload(
  db: Database.Database,
  chapterId: number
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
    return { localPath: row.local_path };
  }

  const ext = extFromUrl(row.enclosure_url);
  const localPath = getChapterPath(row.librivox_id, chapterId, ext);

  db.prepare("UPDATE audiobook_chapters SET download_state = 'downloading', local_path = ? WHERE id = ?").run(
    localPath,
    chapterId
  );

  try {
    ensureChapterDir(row.librivox_id);

    const res = await fetch(row.enclosure_url, {
      headers: DOWNLOAD_HEADERS,
    });

    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    const tmpPath = `${localPath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      const dest = fs.createWriteStream(tmpPath);
      await pipeline(
        Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
        byteCapTransform(),
        dest
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
    const msg = err instanceof Error ? err.message : String(err);
    db.prepare(
      "UPDATE audiobook_chapters SET download_state = 'failed', download_error = ? WHERE id = ?"
    ).run(msg, chapterId);
    return { error: msg };
  }
}
