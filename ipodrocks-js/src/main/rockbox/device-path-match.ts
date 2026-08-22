import * as path from "path";

import type Database from "better-sqlite3";

/**
 * Map a path as Rockbox reports it back to a library track.
 *
 * Rockbox stores runtime data against the file's location on the device, so
 * this is the join between its counters and the library. Getting it wrong is
 * worse than getting nothing: a play count or a rating landing on the wrong
 * track is invisible and permanent. Every tier below therefore refuses an
 * ambiguous answer rather than picking one — the previous matcher returned the
 * first row of whatever the filename happened to hit.
 */

/**
 * Normalise a device path for comparison.
 *
 * - drops the volume token Rockbox prefixes (``/<HDD0>``, ``/<microSD0>``)
 * - forward slashes, no leading slash
 * - NFC, because macOS hands back decomposed filenames and the same name in
 *   NFD compares unequal to itself in NFC (see database/nfc-path-migration.ts)
 * - lower case, because the device filesystem is FAT
 */
export function normalizeDevicePath(filePath: string): string {
  return filePath
    .replace(/\\/g, "/")
    .replace(/^\/<[^>]*>\//, "")
    .replace(/^\/+/, "")
    .normalize("NFC")
    .toLowerCase();
}

/**
 * Strip everything up to and including the first ``Music/`` segment, yielding
 * ``Artist/Album/track.ext``. Falls back to dropping the first segment.
 *
 * Rockbox paths look like ``/<HDD0>/Music/Artist/Album/track.ext`` or
 * ``/Music/Artist/Album/track.ext``; the device's content folder is not always
 * called Music, hence the fallback.
 */
export function stripDevicePrefix(filePath: string): string {
  const normalised = filePath.replace(/\\/g, "/");
  const idx = normalised.toLowerCase().indexOf("/music/");
  if (idx >= 0) return normalised.slice(idx + "/music/".length);
  const parts = normalised.replace(/^\//, "").split("/");
  if (parts.length > 1) return parts.slice(1).join("/");
  return parts.join("/");
}

/**
 * Turn an absolute host path on a mounted device into the mount-relative form
 * stored in ``device_synced_tracks.device_path``.
 *
 * Falls back to the input when the path is not under the mount — better a key
 * that fails to match than one that silently matches the wrong track.
 */
export function toMountRelative(absPath: string, mountPath: string): string {
  const rel = path.relative(mountPath, absPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return absPath;
  return rel.split(path.sep).join("/");
}

interface ResolverRow {
  id: number;
  filename: string | null;
  device_path: string | null;
}

/**
 * A prepared, reusable resolver for one device.
 *
 * Built once per import: a device holds thousands of tracks and re-querying per
 * entry would make the join quadratic.
 */
export interface DevicePathResolver {
  /** Track id, or null when there is no confident match. */
  resolve(devicePath: string): number | null;
  /** Tracks the device knows about, for reporting. */
  readonly knownPaths: number;
}

export function buildDevicePathResolver(
  db: Database.Database,
  deviceId: number
): DevicePathResolver {
  // Tier 1: what the device check recorded we actually wrote, which is exact.
  const synced = db
    .prepare(
      `SELECT t.id, t.filename, dst.device_path
         FROM device_synced_tracks dst
         JOIN tracks t ON t.path = dst.library_path
        WHERE dst.device_id = ?`
    )
    .all(deviceId) as ResolverRow[];

  const byDevicePath = new Map<string, number>();
  for (const row of synced) {
    if (!row.device_path) continue;
    const key = normalizeDevicePath(row.device_path);
    // A duplicate key would mean two library tracks claim one file on the
    // device; neither can be trusted, so drop both rather than guess.
    if (byDevicePath.has(key)) byDevicePath.set(key, -1);
    else byDevicePath.set(key, row.id);
  }

  // Tiers 2 and 3 cover rows written before device_path existed, and devices
  // that have never been checked. Both are ambiguity-aware.
  const libraryRows = db
    .prepare(
      `SELECT t.id, t.filename, t.path,
              a.name AS artist, al.title AS album
         FROM tracks t
         LEFT JOIN artists a ON t.artist_id = a.id
         LEFT JOIN albums al ON t.album_id = al.id
        WHERE t.content_type = 'music'`
    )
    .all() as {
    id: number;
    filename: string | null;
    artist: string | null;
    album: string | null;
  }[];

  const byRelative = new Map<string, number>();
  const byBasename = new Map<string, number>();
  const put = (map: Map<string, number>, key: string, id: number): void => {
    if (!key) return;
    if (map.has(key) && map.get(key) !== id) map.set(key, -1);
    else map.set(key, id);
  };

  for (const row of libraryRows) {
    const fname = (row.filename ?? "").normalize("NFC").toLowerCase();
    const artist = (row.artist ?? "").trim().normalize("NFC").toLowerCase();
    const album = (row.album ?? "").trim().normalize("NFC").toLowerCase();
    put(byBasename, fname, row.id);
    if (artist && album && fname) {
      put(byRelative, `${artist}/${album}/${fname}`, row.id);
    }
  }

  const pick = (map: Map<string, number>, key: string): number | null => {
    const id = map.get(key);
    // -1 is the ambiguity marker planted above.
    return id != null && id > 0 ? id : null;
  };

  return {
    knownPaths: byDevicePath.size,
    resolve(devicePath: string): number | null {
      const exact = pick(byDevicePath, normalizeDevicePath(devicePath));
      if (exact != null) return exact;

      const rel = stripDevicePrefix(devicePath).normalize("NFC").toLowerCase();
      const relative = pick(byRelative, rel);
      if (relative != null) return relative;

      return pick(byBasename, rel.split("/").pop() ?? "");
    },
  };
}
