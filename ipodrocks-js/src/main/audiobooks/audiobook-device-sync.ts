import * as fs from "fs";
import * as path from "path";
import type Database from "better-sqlite3";
import { listSubscriptions, subLabel } from "./audiobook-subscriptions";
import { downloadChapter } from "./audiobook-downloader";
import { sanitizeDevicePathComponent } from "../sync/sync-core";
import { copyFileToDevice } from "../sync/sync-executor";
import type { SyncProgressPayload } from "../sync/sync-core";
import { isDeviceMountPathOnline } from "../devices/device-online";

type ProgressCallback = (event: SyncProgressPayload) => void;

interface DeviceRow {
  id: number;
  mount_path: string;
  audiobook_folder: string;
  dev_mode: number;
}

interface ChapterToSync {
  chapterId: number;
  chapterNumber: number | null;
  title: string;
  enclosureUrl: string;
  localPath: string | null;
  downloadState: string;
  destRelative: string;
  destAbsolute: string;
}

export interface AutoAudiobookSyncSelection {
  syncType: "full" | "custom";
  includeAudiobooks: boolean;
  selectedLabels: string[];
  mode: "include" | "exclude";
}

export async function syncAutoAudiobooksToDevice(
  db: Database.Database,
  deviceId: number,
  selection: AutoAudiobookSyncSelection,
  progressCallback?: ProgressCallback
): Promise<{ synced: number; errors: number }> {
  const device = db
    .prepare("SELECT id, mount_path, audiobook_folder, dev_mode FROM devices WHERE id = ?")
    .get(deviceId) as DeviceRow | undefined;

  if (!device || !device.mount_path) return { synced: 0, errors: 0 };

  const online = !!device.dev_mode || isDeviceMountPathOnline(device.mount_path);
  if (!online) return { synced: 0, errors: 0 };

  const allSubs = listSubscriptions(db);
  if (allSubs.length === 0) return { synced: 0, errors: 0 };

  // Determine which subs are in scope based on sync selection
  const selectedSet = new Set(selection.selectedLabels);
  const inScope = allSubs.filter((sub) => {
    const label = subLabel(sub);
    if (selection.syncType === "full") {
      return selection.includeAudiobooks;
    }
    // custom mode
    const matches = selectedSet.has(label) || selectedSet.has(sub.title);
    return selection.mode === "include" ? matches : !matches;
  });

  if (inScope.length === 0) return { synced: 0, errors: 0 };

  const audiobookFolder = device.audiobook_folder || "Audiobooks";
  const toSync: ChapterToSync[] = [];

  interface CoverEntry {
    localPath: string;
    destAbsolute: string;
  }
  const coversToSync: CoverEntry[] = [];

  for (const sub of inScope) {
    const chapters = (db
      .prepare(
        `SELECT id, chapter_number, title, enclosure_url, local_path, download_state
         FROM audiobook_chapters WHERE subscription_id = ?
         ORDER BY chapter_number ASC, id ASC`
      )
      .all(sub.id) as Array<{
        id: number;
        chapter_number: number | null;
        title: string;
        enclosure_url: string;
        local_path: string | null;
        download_state: string;
      }>);

    const bookDir = sanitizeDevicePathComponent(
      sub.author ? `${sub.author} - ${sub.title}` : sub.title
    );

    for (const ch of chapters) {
      if (ch.download_state === "skipped") continue;

      const ext = ch.local_path ? path.extname(ch.local_path) || ".mp3" : ".mp3";
      const numStr = ch.chapter_number != null ? String(ch.chapter_number).padStart(2, "0") + " " : "";
      const filename = `${numStr}${sanitizeDevicePathComponent(ch.title)}${ext}`;
      const destRelative = path.join(audiobookFolder, bookDir, filename);
      const destAbsolute = path.join(device.mount_path, destRelative);

      toSync.push({
        chapterId: ch.id,
        chapterNumber: ch.chapter_number,
        title: ch.title,
        enclosureUrl: ch.enclosure_url,
        localPath: ch.local_path,
        downloadState: ch.download_state,
        destRelative,
        destAbsolute,
      });
    }

    // Queue cover image for this book (raw local path, not the media:// URL)
    const subRow = db
      .prepare("SELECT image_url FROM audiobook_subscriptions WHERE id = ?")
      .get(sub.id) as { image_url: string | null } | undefined;
    if (subRow?.image_url && fs.existsSync(subRow.image_url)) {
      const coverExt = path.extname(subRow.image_url) || ".jpg";
      coversToSync.push({
        localPath: subRow.image_url,
        destAbsolute: path.join(device.mount_path, audiobookFolder, bookDir, `cover${coverExt}`),
      });
    }
  }

  if (toSync.length === 0) {
    // Still copy covers even if chapters are already synced
    for (const cover of coversToSync) {
      try {
        if (!fs.existsSync(cover.destAbsolute)) {
          fs.mkdirSync(path.dirname(cover.destAbsolute), { recursive: true });
          fs.copyFileSync(cover.localPath, cover.destAbsolute);
        }
      } catch { /* best-effort */ }
    }
    return { synced: 0, errors: 0 };
  }

  progressCallback?.({ event: "total_add", path: String(toSync.length) });
  progressCallback?.({ event: "log", message: `Extra Audiobooks: syncing ${toSync.length} chapter(s)...` });

  let synced = 0;
  let errors = 0;

  for (const ch of toSync) {
    try {
      // Check already-synced idempotency
      const syncedRow = db
        .prepare("SELECT device_relative_path FROM device_audiobook_synced WHERE device_id = ? AND chapter_id = ?")
        .get(deviceId, ch.chapterId) as { device_relative_path: string } | undefined;

      if (syncedRow) {
        const storedAbsolute = path.join(device.mount_path, syncedRow.device_relative_path);
        if (syncedRow.device_relative_path === ch.destRelative && fs.existsSync(storedAbsolute)) {
          continue;
        }
        db.prepare("DELETE FROM device_audiobook_synced WHERE device_id = ? AND chapter_id = ?").run(deviceId, ch.chapterId);
        if (syncedRow.device_relative_path !== ch.destRelative && fs.existsSync(storedAbsolute)) {
          try { fs.unlinkSync(storedAbsolute); } catch { /* ignore */ }
        }
      }

      // Download-on-sync: fetch if not ready
      let localPath = ch.localPath;
      if (!localPath || !fs.existsSync(localPath) || ch.downloadState !== "ready") {
        const dlResult = await downloadChapter(db, ch.chapterId);
        if ("error" in dlResult) {
          throw new Error(dlResult.error);
        }
        localPath = dlResult.localPath;
      }

      await copyFileToDevice(localPath, ch.destAbsolute);
      db.prepare(
        `INSERT OR IGNORE INTO device_audiobook_synced (device_id, chapter_id, device_relative_path)
         VALUES (?, ?, ?)`
      ).run(deviceId, ch.chapterId, ch.destRelative);

      synced++;
      progressCallback?.({
        event: "copy",
        path: path.basename(ch.destAbsolute),
        destination: ch.destAbsolute,
        status: "copied",
        contentType: "audiobook",
      });
    } catch (err) {
      console.error(`[audiobooks] sync failed chapter ${ch.chapterId} → device ${deviceId}:`, err);
      errors++;
      progressCallback?.({
        event: "copy",
        path: ch.title,
        destination: ch.destAbsolute,
        status: "error",
        contentType: "audiobook",
      });
    }
  }

  // Copy cover images after chapters (best-effort, skip if already present)
  for (const cover of coversToSync) {
    try {
      if (!fs.existsSync(cover.destAbsolute)) {
        fs.mkdirSync(path.dirname(cover.destAbsolute), { recursive: true });
        fs.copyFileSync(cover.localPath, cover.destAbsolute);
      }
    } catch { /* best-effort */ }
  }

  return { synced, errors };
}
