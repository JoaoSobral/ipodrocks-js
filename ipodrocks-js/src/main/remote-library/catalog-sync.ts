import type Database from "better-sqlite3";
import { PeerClient, PeerError } from "./peer-client";
import {
  getRemoteLibraryRow,
  MAX_CATALOG_ITEMS,
  replaceCatalog,
  sanitizeCatalogItem,
  setRemoteStatus,
  targetFor,
  type CleanCatalogItem,
} from "./store";
import { purgeRemoteCache } from "./cache";

/**
 * Pulls a remote library's catalogue into `remote_tracks`.
 *
 * Paged, bounded, and atomic: the whole catalogue is fetched and cleaned
 * before one transaction replaces the old one, so a refresh that dies on page
 * forty leaves yesterday's catalogue intact rather than half of today's.
 *
 * The share's own answers drive state:
 * - **revoked** (410, countersigned) → the cache is purged and the catalogue
 *   emptied. The sharer cannot reach into this server to delete anything, so
 *   honouring the revocation is this code's job;
 * - **downloads turned off** → the cache is purged too, for the same reason;
 * - **rejected / unverified** → `error`, with the message, and nothing from
 *   that host is used;
 * - **unreachable / busy** → `offline`; the catalogue stays and cached
 *   copies keep playing.
 */

const PAGE = 1000;
export const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

const inFlight = new Map<number, Promise<RefreshResult>>();

export type RefreshResult = { ok: true; trackCount: number } | { error: string };

interface InfoBody {
  allowDownload?: unknown;
  trackCount?: unknown;
  totalBytes?: unknown;
}

interface CatalogPage {
  total?: unknown;
  items?: unknown;
  nextOffset?: unknown;
}

export function refreshRemoteLibrary(
  db: Database.Database,
  id: number,
  signal?: AbortSignal
): Promise<RefreshResult> {
  const running = inFlight.get(id);
  if (running) return running;
  const job = doRefresh(db, id, signal).finally(() => inFlight.delete(id));
  inFlight.set(id, job);
  return job;
}

async function doRefresh(db: Database.Database, id: number, signal?: AbortSignal): Promise<RefreshResult> {
  const row = getRemoteLibraryRow(db, id);
  if (!row) return { error: "Remote library not found." };
  if (row.status === "revoked") return { error: "The owner of this library has stopped sharing it." };

  const client = new PeerClient(targetFor(row));
  try {
    const info = await client.getJson<InfoBody>("/api/federation/info", signal);
    const allowDownload = info.allowDownload !== false;
    if (allowDownload !== (row.allow_download === 1)) {
      db.prepare("UPDATE remote_libraries SET allow_download = ? WHERE id = ?").run(allowDownload ? 1 : 0, id);
    }
    if (!allowDownload) await purgeRemoteCache(db, id);

    const items: CleanCatalogItem[] = [];
    let offset = 0;
    let total = 0;
    let dropped = 0;
    for (;;) {
      const page = await client.getJson<CatalogPage>(
        `/api/federation/catalog?offset=${offset}&limit=${PAGE}`,
        signal
      );
      if (!Array.isArray(page.items)) throw new PeerError("The catalogue was malformed.", "invalid");
      total = typeof page.total === "number" && Number.isFinite(page.total) ? page.total : total;
      for (const raw of page.items) {
        const clean = sanitizeCatalogItem(raw, id);
        if (clean) items.push(clean);
        else dropped++;
        if (items.length > MAX_CATALOG_ITEMS) {
          throw new PeerError(`The catalogue is larger than ${MAX_CATALOG_ITEMS} tracks.`, "invalid");
        }
      }
      const next = page.nextOffset;
      if (next === null || next === undefined) break;
      // The offset only ever moves forward, so a hostile peer cannot loop us.
      if (typeof next !== "number" || !Number.isSafeInteger(next) || next <= offset) {
        throw new PeerError("The catalogue's paging was malformed.", "invalid");
      }
      offset = next;
    }
    const totalBytes = items.reduce((n, i) => n + (i.fileSize ?? 0), 0);
    replaceCatalog(db, id, items, { trackCount: items.length, totalBytes });
    if (dropped > 0) {
      console.warn(`[remote-library] ${row.name}: skipped ${dropped} catalogue entries that failed validation`);
    }
    return { ok: true, trackCount: items.length };
  } catch (err) {
    return handlePeerFailure(db, id, err);
  }
}

/** Records what a failed call means for the library. Shared with the cache. */
export async function handlePeerFailure(db: Database.Database, id: number, err: unknown): Promise<{ error: string }> {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof PeerError) {
    if (err.kind === "revoked") {
      await purgeRemoteCache(db, id);
      db.prepare("DELETE FROM remote_tracks WHERE remote_library_id = ?").run(id);
      db.prepare("UPDATE remote_libraries SET track_count = 0, total_bytes = 0 WHERE id = ?").run(id);
      setRemoteStatus(db, id, "revoked", message);
    } else if (err.kind === "rejected" || err.kind === "unverified" || err.kind === "invalid") {
      setRemoteStatus(db, id, "error", message);
    } else {
      setRemoteStatus(db, id, "offline", message);
    }
  } else {
    setRemoteStatus(db, id, "offline", message);
  }
  return { error: message };
}

let timer: NodeJS.Timeout | null = null;

/** Refreshes every live remote library every six hours. Started with the web server. */
export function startRemoteLibraryScheduler(getDb: () => Database.Database): () => void {
  stopRemoteLibraryScheduler();
  timer = setInterval(() => {
    let db: Database.Database;
    try {
      db = getDb();
    } catch {
      return;
    }
    const ids = db
      .prepare("SELECT id FROM remote_libraries WHERE status != 'revoked'")
      .all() as { id: number }[];
    void (async () => {
      for (const { id } of ids) {
        await refreshRemoteLibrary(db, id).catch(() => undefined);
      }
    })();
  }, REFRESH_INTERVAL_MS);
  timer.unref?.();
  return stopRemoteLibraryScheduler;
}

export function stopRemoteLibraryScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
