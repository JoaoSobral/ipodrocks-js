import * as fs from "fs";
import * as path from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import type Database from "better-sqlite3";
import { downloadWatchdog } from "../utils/capped-stream";
import { sniffAudioFile } from "../utils/audio-sniff";
import { getLibrary } from "../ipc/common";
import { PeerClient, PeerError } from "./peer-client";
import {
  containedCachePath,
  getRemoteLibraryRow,
  remoteCacheRoot,
  removeCacheDir,
  remoteTrackRows,
  targetFor,
  type RemoteLibraryRow,
  type RemoteTrackRow,
} from "./store";

/**
 * "Keep offline": copies of remote tracks, as ordinary library tracks.
 *
 * Each remote library gets one managed library folder,
 * `<userData>/remote-cache/<id>`, registered in `library_folders` and pointed
 * at by `remote_libraries.cache_folder_id`. A kept track is downloaded there
 * and the folder is scanned, after which it *is* a library track — the sync,
 * shadow libraries, ratings and the Rockbox matcher handle it without knowing
 * it came from anywhere. Taking a track back off is deleting the file and
 * rescanning; removing or losing the library removes the folder through
 * `removeLibraryFolder()`, the library's own cleanup.
 *
 * Downloads are chunked with `Range` so no single response outlives a
 * tunnel's request limit (Cloudflare cuts at ~100 s), metered by
 * `downloadWatchdog`, bounded to the bytes asked for, and checked by content
 * (`sniffAudioFile`) before they replace anything: a peer's word on what a
 * file is counts for nothing.
 */

export const DOWNLOAD_CHUNK_BYTES = 32 * 1024 * 1024;
export const MAX_KEEP_PER_CALL = 2000;
const PARALLEL_DOWNLOADS = 2;

let scanRunner: ((folderPath: string, name: string) => Promise<unknown>) | null = null;

/**
 * Injected by `ipc/remote-library.ts` with `runLibraryScan`, so this module
 * does not import the IPC layer that imports it.
 */
export function setCacheScanRunner(runner: typeof scanRunner): void {
  scanRunner = runner;
}

function cacheFolderName(row: RemoteLibraryRow): string {
  return `Remote · ${row.name}`.slice(0, 120);
}

/** The managed folder's id, creating the folder and its row on first use. */
function ensureCacheFolder(db: Database.Database, row: RemoteLibraryRow): string {
  const root = remoteCacheRoot(row.id);
  fs.mkdirSync(root, { recursive: true });
  const existing =
    row.cache_folder_id !== null
      ? (db.prepare("SELECT id FROM library_folders WHERE id = ?").get(row.cache_folder_id) as
          | { id: number }
          | undefined)
      : undefined;
  if (!existing) {
    const byPath = db.prepare("SELECT id FROM library_folders WHERE path = ?").get(root) as
      | { id: number }
      | undefined;
    const folderId = byPath?.id ?? getLibrary().addLibraryFolder(cacheFolderName(row), root, "music");
    db.prepare("UPDATE remote_libraries SET cache_folder_id = ? WHERE id = ?").run(folderId, row.id);
  }
  return root;
}

async function rescan(row: RemoteLibraryRow): Promise<string | null> {
  if (!scanRunner) return "The library scanner is not available.";
  // One scan slot for the whole app; wait for another scan rather than skip.
  for (let attempt = 0; attempt < 120; attempt++) {
    const result = (await scanRunner(remoteCacheRoot(row.id), cacheFolderName(row))) as
      | { error?: string }
      | undefined;
    if (!result?.error) return null;
    if (!/already running/.test(result.error)) return result.error;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return "Another library scan kept running; the downloaded files will be picked up by the next scan.";
}

/** Bounds a body to `expected` bytes: one byte more is a protocol violation. */
function byteLimit(expected: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (seen > expected) cb(new Error("The sharing server sent more bytes than asked for."));
      else cb(null, chunk);
    },
  });
}

async function downloadOne(
  client: PeerClient,
  track: RemoteTrackRow,
  remoteLibraryId: number,
  signal?: AbortSignal
): Promise<void> {
  const dest = containedCachePath(remoteLibraryId, track.cache_path);
  if (!dest) throw new Error("Refusing a cache path outside the remote cache.");
  if (track.file_size !== null) {
    try {
      if (fs.statSync(dest).size === track.file_size) return;
    } catch {
      /* not there yet */
    }
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.ipodrocks-part`;
  try {
    let offset = 0;
    let size = track.file_size;
    for (;;) {
      const end = offset + DOWNLOAD_CHUNK_BYTES - 1;
      const res = await client.request(`/api/federation/media/${encodeURIComponent(track.ref)}`, {
        headers: { range: `bytes=${offset}-${end}` },
        signal,
      });
      if (res.status !== 200 && res.status !== 206) {
        await res.body?.cancel().catch(() => undefined);
        throw new PeerError(`The sharing server answered ${res.status} for a track.`, "unreachable");
      }
      let chunkLen: number;
      if (res.status === 206) {
        const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get("content-range") ?? "");
        if (!m || Number(m[1]) !== offset) {
          await res.body?.cancel().catch(() => undefined);
          throw new PeerError("The sharing server sent a range nobody asked for.", "invalid");
        }
        chunkLen = Number(m[2]) - Number(m[1]) + 1;
        size = Number(m[3]);
      } else {
        if (offset !== 0) {
          await res.body?.cancel().catch(() => undefined);
          throw new PeerError("The sharing server ignored a range request mid-file.", "invalid");
        }
        chunkLen = Number(res.headers.get("content-length") ?? NaN);
        if (!Number.isFinite(chunkLen)) chunkLen = size ?? Number.MAX_SAFE_INTEGER;
        size = chunkLen;
      }
      if (size !== null && track.file_size !== null && size !== track.file_size) {
        await res.body?.cancel().catch(() => undefined);
        throw new PeerError("The track's size does not match the catalogue.", "invalid");
      }
      const watchdog = downloadWatchdog(signal);
      try {
        await pipeline(
          Readable.fromWeb(res.body as unknown as import("stream/web").ReadableStream),
          watchdog.meter,
          byteLimit(chunkLen),
          fs.createWriteStream(part, { flags: offset === 0 ? "w" : "a" }),
          { signal: watchdog.signal }
        );
      } finally {
        watchdog.dispose();
      }
      offset += chunkLen;
      if (fs.statSync(part).size !== offset) throw new Error("The download ended early.");
      if (size === null || offset >= size) break;
    }
    if (!sniffAudioFile(part)) throw new Error("The downloaded file is not a recognised audio format.");
    fs.renameSync(part, dest);
  } catch (err) {
    fs.rmSync(part, { force: true });
    throw err;
  }
}

export interface KeepOfflineResult {
  downloaded: number;
  failed: number;
  errors: string[];
}

export async function keepOffline(
  db: Database.Database,
  remoteLibraryId: number,
  trackIds: number[],
  signal?: AbortSignal
): Promise<KeepOfflineResult | { error: string }> {
  const row = getRemoteLibraryRow(db, remoteLibraryId);
  if (!row) return { error: "Remote library not found." };
  if (row.status === "revoked") return { error: "The owner of this library has stopped sharing it." };
  if (row.allow_download !== 1) {
    return { error: "The owner of this library has turned off offline copies for this share." };
  }
  const ids = [...new Set(trackIds.filter((n) => Number.isSafeInteger(n) && n > 0))].slice(0, MAX_KEEP_PER_CALL);
  const tracks = remoteTrackRows(db, remoteLibraryId, ids);
  if (tracks.length === 0) return { downloaded: 0, failed: 0, errors: [] };

  ensureCacheFolder(db, row);
  const client = new PeerClient(targetFor(row));
  const result: KeepOfflineResult = { downloaded: 0, failed: 0, errors: [] };
  let fatal: unknown = null;
  const queue = [...tracks];
  await Promise.all(
    Array.from({ length: PARALLEL_DOWNLOADS }, async () => {
      while (queue.length > 0 && !fatal && !signal?.aborted) {
        const track = queue.shift()!;
        try {
          await downloadOne(client, track, remoteLibraryId, signal);
          result.downloaded++;
        } catch (err) {
          result.failed++;
          if (result.errors.length < 20) result.errors.push(err instanceof Error ? err.message : String(err));
          // Revoked, rejected or impersonated: every later track would fail the
          // same way, and the library's state has to change now.
          if (err instanceof PeerError && err.kind !== "busy" && err.kind !== "unreachable") fatal = err;
        }
      }
    })
  );
  if (fatal) {
    const { handlePeerFailure } = await import("./catalog-sync");
    await handlePeerFailure(db, remoteLibraryId, fatal);
    return { ...result, errors: [(fatal as Error).message, ...result.errors] };
  }
  if (result.downloaded > 0) {
    const scanError = await rescan(getRemoteLibraryRow(db, remoteLibraryId)!);
    if (scanError) result.errors.push(scanError);
  }
  return result;
}

/** Deletes offline copies and rescans so their library tracks go with them. */
export async function evictOffline(
  db: Database.Database,
  remoteLibraryId: number,
  trackIds: number[]
): Promise<{ removed: number } | { error: string }> {
  const row = getRemoteLibraryRow(db, remoteLibraryId);
  if (!row) return { error: "Remote library not found." };
  let removed = 0;
  for (const track of remoteTrackRows(db, remoteLibraryId, trackIds.slice(0, MAX_KEEP_PER_CALL))) {
    const dest = containedCachePath(remoteLibraryId, track.cache_path);
    if (dest && fs.existsSync(dest)) {
      fs.rmSync(dest, { force: true });
      removed++;
    }
  }
  if (removed > 0 && row.cache_folder_id !== null) {
    const scanError = await rescan(row);
    if (scanError) return { error: scanError };
  }
  return { removed };
}

/**
 * Removes every offline copy of a library: its managed folder row (and with
 * it the tracks, through the library's own cleanup) and the directory.
 */
export async function purgeRemoteCache(db: Database.Database, remoteLibraryId: number): Promise<void> {
  const row = getRemoteLibraryRow(db, remoteLibraryId);
  if (!row) return;
  if (row.cache_folder_id !== null) {
    try {
      getLibrary().removeLibraryFolder(row.cache_folder_id, true);
    } catch (err) {
      console.warn("[remote-library] could not remove the cache folder row:", err);
    }
    db.prepare("UPDATE remote_libraries SET cache_folder_id = NULL WHERE id = ?").run(remoteLibraryId);
  }
  removeCacheDir(remoteLibraryId);
}
