import * as fs from "fs";
import * as path from "path";
import type Database from "better-sqlite3";
import { getUserDataPath } from "../host";
import { sanitizeDevicePathComponent } from "../utils/device-path";
import { AUDIO_EXTENSIONS } from "../utils/audio-extensions";
import { getServerDb } from "../../server/db";
import { keyFingerprint } from "../../server/federation/signing";
import type { CfAccessCredentials, PeerTarget } from "./peer-client";

/**
 * Remote libraries as stored on the recipient.
 *
 * The catalogue lives in `remote_tracks` and is *not* part of `tracks`: too
 * much code assumes `tracks.path` is a local file. A track becomes an ordinary
 * library track only once it is kept offline — downloaded under
 * `remoteCacheRoot(id)`, which is a managed library folder the scanner indexes
 * like any other, so sync, shadow libraries, ratings and the Rockbox matcher
 * see a normal file and need no remote-awareness at all.
 *
 * Everything in a catalogue row is the peer's word and is cleaned here, once,
 * on the way in (`sanitizeCatalogItem`): text bounded and stripped of control
 * characters, numbers finite, the relative path rebuilt component by component
 * through `sanitizeDevicePathComponent` and contained under the cache root.
 */

export type RemoteStatus = "active" | "offline" | "revoked" | "error";

export interface RemoteLibraryRow {
  id: number;
  name: string;
  peer_origin: string;
  share_id: string;
  sharer_public_key: string;
  lan: number;
  allow_download: number;
  status: RemoteStatus;
  last_error: string | null;
  track_count: number;
  total_bytes: number;
  cache_folder_id: number | null;
  last_synced_at: number | null;
  created_at: number;
}

export interface RemoteLibrary {
  id: number;
  name: string;
  peerOrigin: string;
  lan: boolean;
  allowDownload: boolean;
  status: RemoteStatus;
  lastError: string | null;
  trackCount: number;
  totalBytes: number;
  cachedCount: number;
  sharerFingerprint: string;
  lastSyncedAt: number | null;
  createdAt: number;
}

export const MAX_CATALOG_ITEMS = 200_000;
const MAX_TEXT = 512;
const MAX_PATH_DEPTH = 12;

/** `<userData>/remote-cache` — every remote library's cache lives below it. */
export function remoteCacheBase(): string {
  // Realpath'd, because the scanner stores real paths and a cached copy is
  // found by `tracks.path = remote_tracks.cache_path`. On macOS a data dir
  // under /var is really /private/var, and the join would never match.
  let base = getUserDataPath();
  try {
    base = fs.realpathSync(base);
  } catch {
    /* not created yet; the host creates it before anything is cached */
  }
  return path.join(base, "remote-cache");
}

export function remoteCacheRoot(remoteLibraryId: number): string {
  if (!Number.isSafeInteger(remoteLibraryId) || remoteLibraryId <= 0) {
    throw new Error("Invalid remote library id");
  }
  return path.join(remoteCacheBase(), String(remoteLibraryId));
}

/** True when `p` is the cache base or anything under it. Lexical; callers that
 *  got `p` from a client realpath it first. */
export function isInsideRemoteCache(p: string): boolean {
  const rel = path.relative(remoteCacheBase(), path.resolve(p));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The one containment check for a path we are about to write or delete. */
export function containedCachePath(remoteLibraryId: number, p: string): string | null {
  const root = remoteCacheRoot(remoteLibraryId);
  const resolved = path.resolve(p);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return resolved;
}

function rowToLibrary(row: RemoteLibraryRow & { cached_count?: number }): RemoteLibrary {
  return {
    id: row.id,
    name: row.name,
    peerOrigin: row.peer_origin,
    lan: row.lan === 1,
    allowDownload: row.allow_download === 1,
    status: row.status,
    lastError: row.last_error,
    trackCount: row.track_count,
    totalBytes: row.total_bytes,
    cachedCount: row.cached_count ?? 0,
    sharerFingerprint: keyFingerprint(row.sharer_public_key),
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
  };
}

export function listRemoteLibraries(db: Database.Database): RemoteLibrary[] {
  const rows = db
    .prepare(
      `SELECT rl.*,
              (SELECT COUNT(*) FROM remote_tracks rt JOIN tracks t ON t.path = rt.cache_path
                WHERE rt.remote_library_id = rl.id) AS cached_count
         FROM remote_libraries rl ORDER BY rl.name COLLATE NOCASE`
    )
    .all() as (RemoteLibraryRow & { cached_count: number })[];
  return rows.map(rowToLibrary);
}

export function getRemoteLibraryRow(db: Database.Database, id: unknown): RemoteLibraryRow | null {
  if (typeof id !== "number" || !Number.isSafeInteger(id)) return null;
  return (db.prepare("SELECT * FROM remote_libraries WHERE id = ?").get(id) as RemoteLibraryRow) ?? null;
}

export function insertRemoteLibrary(
  db: Database.Database,
  input: { name: string; target: PeerTarget; allowDownload: boolean },
  now = Date.now()
): number | { error: string } {
  const exists = db
    .prepare("SELECT id FROM remote_libraries WHERE peer_origin = ? AND share_id = ?")
    .get(input.target.origin, input.target.shareId);
  if (exists) return { error: "This library has already been added." };
  const info = db
    .prepare(
      `INSERT INTO remote_libraries
         (name, peer_origin, share_id, sharer_public_key, lan, allow_download, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`
    )
    .run(
      input.name,
      input.target.origin,
      input.target.shareId,
      input.target.sharerPublicKey,
      input.target.lan ? 1 : 0,
      input.allowDownload ? 1 : 0,
      now
    );
  return Number(info.lastInsertRowid);
}

export function setRemoteStatus(
  db: Database.Database,
  id: number,
  status: RemoteStatus,
  lastError: string | null
): void {
  db.prepare("UPDATE remote_libraries SET status = ?, last_error = ? WHERE id = ?").run(
    status,
    lastError ? lastError.slice(0, 500) : null,
    id
  );
}

export function deleteRemoteLibraryRow(db: Database.Database, id: number): void {
  db.prepare("DELETE FROM remote_tracks WHERE remote_library_id = ?").run(id);
  db.prepare("DELETE FROM remote_libraries WHERE id = ?").run(id);
  deletePeerSecrets(id);
}

// ---------------------------------------------------------------------------
// Secrets (server DB, 0600)
// ---------------------------------------------------------------------------

export function setPeerSecrets(id: number, cf: CfAccessCredentials | null): void {
  if (!cf) {
    deletePeerSecrets(id);
    return;
  }
  getServerDb()
    .prepare(
      `INSERT INTO federation_peer_secrets (remote_library_id, cf_client_id, cf_client_secret)
       VALUES (?, ?, ?)
       ON CONFLICT(remote_library_id) DO UPDATE SET
         cf_client_id = excluded.cf_client_id, cf_client_secret = excluded.cf_client_secret`
    )
    .run(id, cf.clientId, cf.clientSecret);
}

export function getPeerSecrets(id: number): CfAccessCredentials | null {
  const row = getServerDb()
    .prepare("SELECT cf_client_id, cf_client_secret FROM federation_peer_secrets WHERE remote_library_id = ?")
    .get(id) as { cf_client_id: string | null; cf_client_secret: string | null } | undefined;
  if (!row?.cf_client_id || !row.cf_client_secret) return null;
  return { clientId: row.cf_client_id, clientSecret: row.cf_client_secret };
}

export function deletePeerSecrets(id: number): void {
  getServerDb().prepare("DELETE FROM federation_peer_secrets WHERE remote_library_id = ?").run(id);
}

/** Only well-formed Cloudflare Access service-token values are stored. */
export function cleanCfCredentials(clientId: unknown, clientSecret: unknown): CfAccessCredentials | null | { error: string } {
  const id = typeof clientId === "string" ? clientId.trim() : "";
  const secret = typeof clientSecret === "string" ? clientSecret.trim() : "";
  if (!id && !secret) return null;
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(id) || !/^[A-Za-z0-9._-]{8,256}$/.test(secret)) {
    return { error: "That does not look like a Cloudflare Access service token." };
  }
  return { clientId: id, clientSecret: secret };
}

export function targetFor(row: RemoteLibraryRow): PeerTarget {
  return {
    origin: row.peer_origin,
    shareId: row.share_id,
    sharerPublicKey: row.sharer_public_key,
    lan: row.lan === 1,
    cf: getPeerSecrets(row.id),
  };
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export interface CleanCatalogItem {
  ref: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  albumArtist: string | null;
  genre: string | null;
  trackNumber: number | null;
  discNumber: number | null;
  year: number | null;
  duration: number | null;
  bitrate: number | null;
  fileSize: number | null;
  contentType: "music" | "podcast" | "audiobook";
  codec: string | null;
  hash: string | null;
  relPath: string;
  cachePath: string;
}

function text(v: unknown, max = MAX_TEXT): string | null {
  if (typeof v !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
  return s || null;
}

function int(v: unknown, min: number, max: number): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const n = Math.floor(v);
  return n >= min && n <= max ? n : null;
}

function real(v: unknown, min: number, max: number): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return v >= min && v <= max ? v : null;
}

/**
 * Rebuilds a peer-supplied relative path into one safe to join under the
 * cache root: POSIX separators only, every component sanitized, no empty,
 * `.` or `..` component, bounded depth, and an audio extension on the file.
 */
export function cleanRelPath(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 1024) return null;
  if (raw.includes("\0") || raw.includes("\\")) return null;
  const parts = raw.split("/");
  if (parts.length > MAX_PATH_DEPTH) return null;
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") return null;
    const clean = sanitizeDevicePathComponent(part);
    if (clean === "." || clean === "..") return null;
    out.push(clean);
  }
  const ext = path.extname(out[out.length - 1]).toLowerCase();
  if (!AUDIO_EXTENSIONS.has(ext)) return null;
  // NFC, as the scanner stores `tracks.path`: the cached copy is matched to
  // its catalogue row by path equality.
  return out.join("/").normalize("NFC");
}

export function sanitizeCatalogItem(raw: unknown, remoteLibraryId: number): CleanCatalogItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.ref !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(r.ref)) return null;
  const relPath = cleanRelPath(r.relPath);
  if (!relPath) return null;
  const cachePath = containedCachePath(
    remoteLibraryId,
    path.join(remoteCacheRoot(remoteLibraryId), ...relPath.split("/"))
  );
  if (!cachePath) return null;
  const ct = r.contentType === "podcast" || r.contentType === "audiobook" ? r.contentType : "music";
  const hash = typeof r.hash === "string" && /^[A-Za-z0-9+/=_-]{8,128}$/.test(r.hash) ? r.hash : null;
  return {
    ref: r.ref,
    title: text(r.title),
    artist: text(r.artist),
    album: text(r.album),
    albumArtist: text(r.albumArtist),
    genre: text(r.genre, 128),
    trackNumber: int(r.trackNumber, 0, 9999),
    discNumber: int(r.discNumber, 0, 999),
    year: int(r.year, 0, 9999),
    duration: real(r.duration, 0, 7 * 24 * 3600),
    bitrate: int(r.bitrate, 0, 100_000_000),
    fileSize: int(r.fileSize, 0, Number.MAX_SAFE_INTEGER),
    contentType: ct,
    codec: text(r.codec, 32),
    hash,
    relPath,
    cachePath,
  };
}

/** Replaces a library's catalogue: upsert by ref, drop refs no longer offered. */
export function replaceCatalog(
  db: Database.Database,
  remoteLibraryId: number,
  items: CleanCatalogItem[],
  totals: { trackCount: number; totalBytes: number },
  now = Date.now()
): void {
  const upsert = db.prepare(
    `INSERT INTO remote_tracks
       (remote_library_id, ref, title, artist, album, album_artist, genre, track_number,
        disc_number, year, duration, bitrate, file_size, content_type, codec, hash,
        rel_path, cache_path)
     VALUES (@lib, @ref, @title, @artist, @album, @albumArtist, @genre, @trackNumber,
        @discNumber, @year, @duration, @bitrate, @fileSize, @contentType, @codec, @hash,
        @relPath, @cachePath)
     ON CONFLICT(remote_library_id, ref) DO UPDATE SET
       title = excluded.title, artist = excluded.artist, album = excluded.album,
       album_artist = excluded.album_artist, genre = excluded.genre,
       track_number = excluded.track_number, disc_number = excluded.disc_number,
       year = excluded.year, duration = excluded.duration, bitrate = excluded.bitrate,
       file_size = excluded.file_size, content_type = excluded.content_type,
       codec = excluded.codec, hash = excluded.hash, rel_path = excluded.rel_path,
       cache_path = excluded.cache_path`
  );
  db.transaction(() => {
    db.exec("CREATE TEMP TABLE IF NOT EXISTS _remote_seen (ref TEXT PRIMARY KEY)");
    db.exec("DELETE FROM _remote_seen");
    const seen = db.prepare("INSERT OR IGNORE INTO _remote_seen (ref) VALUES (?)");
    for (const item of items) {
      upsert.run({ lib: remoteLibraryId, ...item });
      seen.run(item.ref);
    }
    db.prepare(
      "DELETE FROM remote_tracks WHERE remote_library_id = ? AND ref NOT IN (SELECT ref FROM _remote_seen)"
    ).run(remoteLibraryId);
    db.exec("DELETE FROM _remote_seen");
    db.prepare(
      `UPDATE remote_libraries
          SET track_count = ?, total_bytes = ?, last_synced_at = ?, status = 'active', last_error = NULL
        WHERE id = ?`
    ).run(totals.trackCount, totals.totalBytes, now, remoteLibraryId);
  })();
}

export interface RemoteTrack {
  id: number;
  remoteLibraryId: number;
  ref: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  albumArtist: string | null;
  genre: string | null;
  trackNumber: number | null;
  discNumber: number | null;
  year: number | null;
  duration: number | null;
  fileSize: number | null;
  codec: string | null;
  cached: boolean;
  /** A track with the same content is already in this library. */
  localDuplicate: boolean;
}

export function listRemoteTracks(
  db: Database.Database,
  remoteLibraryId: number,
  opts: { search?: unknown; offset?: unknown; limit?: unknown; hideLocalDuplicates?: unknown } = {}
): { total: number; tracks: RemoteTrack[] } {
  const limit = Math.max(1, Math.min(2000, int(opts.limit, 1, 2000) ?? 500));
  const offset = int(opts.offset, 0, Number.MAX_SAFE_INTEGER) ?? 0;
  const search = typeof opts.search === "string" ? opts.search.trim().slice(0, 200) : "";
  const hideDupes = opts.hideLocalDuplicates !== false;
  const where: string[] = ["rt.remote_library_id = @lib"];
  if (search) {
    where.push("(rt.title LIKE @q OR rt.artist LIKE @q OR rt.album LIKE @q OR rt.album_artist LIKE @q)");
  }
  const dupe = `EXISTS (SELECT 1 FROM tracks t2 WHERE rt.hash IS NOT NULL AND t2.file_hash = rt.hash AND t2.path != rt.cache_path)`;
  if (hideDupes) where.push(`NOT ${dupe}`);
  const params = { lib: remoteLibraryId, q: `%${search.replace(/[%_]/g, (c) => `\\${c}`)}%` };
  const whereSql = where.join(" AND ").replace(/LIKE @q/g, "LIKE @q ESCAPE '\\'");
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM remote_tracks rt WHERE ${whereSql}`).get(params) as { n: number }
  ).n;
  const rows = db
    .prepare(
      `SELECT rt.*, (t.id IS NOT NULL) AS cached, ${dupe} AS dup
         FROM remote_tracks rt
         LEFT JOIN tracks t ON t.path = rt.cache_path
        WHERE ${whereSql}
        ORDER BY COALESCE(rt.album_artist, rt.artist) COLLATE NOCASE, rt.album COLLATE NOCASE,
                 rt.disc_number, rt.track_number, rt.title COLLATE NOCASE
        LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit, offset }) as Record<string, unknown>[];
  return {
    total,
    tracks: rows.map((r) => ({
      id: r.id as number,
      remoteLibraryId: r.remote_library_id as number,
      ref: r.ref as string,
      title: r.title as string | null,
      artist: r.artist as string | null,
      album: r.album as string | null,
      albumArtist: r.album_artist as string | null,
      genre: r.genre as string | null,
      trackNumber: r.track_number as number | null,
      discNumber: r.disc_number as number | null,
      year: r.year as number | null,
      duration: r.duration as number | null,
      fileSize: r.file_size as number | null,
      codec: r.codec as string | null,
      cached: r.cached === 1,
      localDuplicate: r.dup === 1,
    })),
  };
}

export interface RemoteTrackRow {
  id: number;
  remote_library_id: number;
  ref: string;
  file_size: number | null;
  cache_path: string;
}

export function remoteTrackRows(
  db: Database.Database,
  remoteLibraryId: number,
  trackIds: number[]
): RemoteTrackRow[] {
  if (trackIds.length === 0) return [];
  const out: RemoteTrackRow[] = [];
  for (let i = 0; i < trackIds.length; i += 500) {
    const part = trackIds.slice(i, i + 500);
    out.push(
      ...(db
        .prepare(
          `SELECT id, remote_library_id, ref, file_size, cache_path FROM remote_tracks
            WHERE remote_library_id = ? AND id IN (${part.map(() => "?").join(",")})`
        )
        .all(remoteLibraryId, ...part) as RemoteTrackRow[])
    );
  }
  return out;
}

export function remoteTrackById(db: Database.Database, id: number): RemoteTrackRow | null {
  return (
    (db
      .prepare("SELECT id, remote_library_id, ref, file_size, cache_path FROM remote_tracks WHERE id = ?")
      .get(id) as RemoteTrackRow | undefined) ?? null
  );
}

/** Removes the cache directory itself. Only ever under `remoteCacheBase()`. */
export function removeCacheDir(remoteLibraryId: number): void {
  const root = remoteCacheRoot(remoteLibraryId);
  if (!isInsideRemoteCache(root) || root === remoteCacheBase()) return;
  fs.rmSync(root, { recursive: true, force: true });
}
