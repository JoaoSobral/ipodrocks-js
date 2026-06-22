import * as fs from "fs";
import * as path from "path";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import type Database from "better-sqlite3";
import { ensureChapterDir, getCoverPath } from "./audiobook-storage";
import { resolveCoverUrl } from "./cover-client";

interface SubRow {
  id: number;
  librivox_id: number;
  title: string;
  author: string | null;
}

function extFromContentType(ct: string): string {
  if (ct.includes("png")) return ".png";
  if (ct.includes("gif")) return ".gif";
  if (ct.includes("webp")) return ".webp";
  return ".jpg";
}

function extFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const ext = path.extname(u.pathname).split("?")[0];
    return ext || ".jpg";
  } catch {
    return ".jpg";
  }
}

/** Downloads a cover image to disk and updates image_url in the DB. Returns local path or null. */
export async function downloadCover(
  db: Database.Database,
  subId: number
): Promise<string | null> {
  const row = db
    .prepare("SELECT id, librivox_id, title, author FROM audiobook_subscriptions WHERE id = ?")
    .get(subId) as SubRow | undefined;
  if (!row) return null;

  const remoteUrl = await resolveCoverUrl(row.title, row.author);
  if (!remoteUrl) return null;

  try {
    const res = await fetch(remoteUrl, {
      headers: { "User-Agent": "iPodRocks/1.0" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok || !res.body) return null;

    const ct = res.headers.get("content-type") ?? "";
    const ext = ct ? extFromContentType(ct) : extFromUrl(remoteUrl);
    const localPath = getCoverPath(row.librivox_id, ext);

    ensureChapterDir(row.librivox_id);
    const tmpPath = localPath + ".tmp";
    const dest = fs.createWriteStream(tmpPath);
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), dest);
    fs.renameSync(tmpPath, localPath);

    db.prepare("UPDATE audiobook_subscriptions SET image_url = ? WHERE id = ?").run(localPath, subId);
    return localPath;
  } catch {
    return null;
  }
}

/** Downloads a cover from a specific URL chosen by the user and stores it. Returns local path or null. */
export async function downloadCoverFromUrl(
  db: Database.Database,
  subId: number,
  remoteUrl: string
): Promise<string | null> {
  const row = db
    .prepare("SELECT id, librivox_id FROM audiobook_subscriptions WHERE id = ?")
    .get(subId) as { id: number; librivox_id: number } | undefined;
  if (!row) return null;

  try {
    const res = await fetch(remoteUrl, {
      headers: { "User-Agent": "iPodRocks/1.0" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok || !res.body) return null;

    const ct = res.headers.get("content-type") ?? "";
    const ext = ct ? extFromContentType(ct) : extFromUrl(remoteUrl);
    const localPath = getCoverPath(row.librivox_id, ext);

    ensureChapterDir(row.librivox_id);
    const tmpPath = localPath + ".tmp";
    const dest = fs.createWriteStream(tmpPath);
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), dest);
    fs.renameSync(tmpPath, localPath);

    db.prepare("UPDATE audiobook_subscriptions SET image_url = ? WHERE id = ?").run(localPath, subId);
    return localPath;
  } catch {
    return null;
  }
}

/** Fetch covers for all subscriptions that don't have one yet. Runs sequentially, swallows errors. */
export async function backfillMissingCovers(db: Database.Database): Promise<void> {
  const rows = db
    .prepare("SELECT id FROM audiobook_subscriptions WHERE image_url IS NULL ORDER BY id ASC")
    .all() as { id: number }[];
  for (const { id } of rows) {
    try {
      await downloadCover(db, id);
    } catch {
      // best-effort
    }
  }
}
