import * as fs from "fs";
import * as path from "path";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import type Database from "better-sqlite3";
import { ensureEpisodeDir, getEpisodePath, getPodcastsRoot } from "./podcast-storage";

interface EpisodeRow {
  id: number;
  subscription_id: number;
  enclosure_url: string;
  file_size: number | null;
  local_path: string | null;
  download_state: string;
}

function extFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const ext = path.extname(u.pathname);
    return ext || ".mp3";
  } catch {
    return ".mp3";
  }
}

export async function downloadEpisode(
  db: Database.Database,
  episodeId: number,
  feedId: number
): Promise<{ localPath: string } | { error: string }> {
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
      headers: { "User-Agent": "iPodRocks/1.0" },
    });

    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    const tmpPath = localPath + ".tmp";
    const dest = fs.createWriteStream(tmpPath);
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), dest);
    fs.renameSync(tmpPath, localPath);

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
    // Clean up partial file
    try { fs.unlinkSync(localPath + ".tmp"); } catch { /* ignore */ }
    return { error: msg };
  }
}
