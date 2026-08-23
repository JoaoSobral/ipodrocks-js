import * as path from "path";

import type Database from "better-sqlite3";

import {
  folderRelativePath,
  sanitizeDevicePathComponent,
} from "../utils/device-path";

/**
 * Map a path as Rockbox reports it back to a library track.
 *
 * Rockbox stores runtime data against the file's location on the device, so
 * this is the join between its counters and the library. Getting it wrong is
 * worse than getting nothing: a play count or a rating landing on the wrong
 * track is invisible and permanent. Every tier below therefore refuses an
 * ambiguous answer rather than picking one — the previous matcher returned the
 * first row of whatever the filename happened to hit.
 *
 * Issue #117 — three reasons the match used to fail wholesale, all of them
 * "the key we built is not the key the sync layer wrote":
 *
 *  1. **Extension.** The device holds whatever the codec profile produced
 *     (``.mpc``, ``.ogg``, ``.mp3``, …); the library holds the source
 *     (``.flac``). Matching on the full filename therefore fails for every
 *     device that transcodes, which is the normal configuration rather than an
 *     edge case. Every inexact tier now compares the filename *stem*.
 *  2. **Sanitization.** Device paths go through
 *     {@link sanitizeDevicePathComponent}; the library-side keys did not. An
 *     artist called ``AC/DC`` lands in a folder called ``AC_DC`` — and, worse,
 *     the raw slash split the key into an extra segment, so it could not match
 *     even in principle. Both sides are now sanitized with the same function.
 *  3. **Shadow libraries.** ``device_synced_tracks.library_path`` holds the
 *     *shadow* path for a device fed by a shadow library, which joins no
 *     ``tracks.path``. The exact tier collapsed to nothing on exactly the
 *     configuration where the inexact tiers also failed. It now resolves
 *     through ``shadow_tracks`` as well.
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
 * Drop a filename's extension, so a transcoded file matches its source.
 *
 * The device copy of a track is whatever the codec profile produced, so the
 * extension is the one part of the name guaranteed *not* to survive the trip.
 * A leading dot is kept (``.hidden`` is a name, not an extension) and a name
 * with no dot is returned unchanged.
 */
export function stripExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
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
 * The codec-independent form of a device-relative path: lower-cased, NFC, with
 * the final segment's extension removed.
 *
 * Both sides of every inexact tier are built through here, so the two can only
 * ever disagree about something that is genuinely part of the name.
 */
export function codecAgnosticKey(relPath: string): string {
  const parts = relPath.replace(/\\/g, "/").split("/");
  const last = parts.length - 1;
  parts[last] = stripExtension(parts[last]);
  return parts.join("/").normalize("NFC").toLowerCase();
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
  device_path: string | null;
}

interface LibraryRow {
  id: number;
  filename: string | null;
  path: string;
  library_folder_id: number | null;
  artist: string | null;
  album_artist: string | null;
  album: string | null;
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
  const byDevicePath = new Map<string, number>();
  const byDeviceStem = new Map<string, number>();
  const byTagPath = new Map<string, number>();
  const byMirrorPath = new Map<string, number>();
  const byBasename = new Map<string, number>();

  const put = (map: Map<string, number>, key: string, id: number): void => {
    if (!key) return;
    // A duplicate key would mean two library tracks claim one file on the
    // device; neither can be trusted, so drop both rather than guess.
    if (map.has(key) && map.get(key) !== id) map.set(key, -1);
    else map.set(key, id);
  };

  const pick = (map: Map<string, number>, key: string): number | null => {
    const id = map.get(key);
    // -1 is the ambiguity marker planted above.
    return id != null && id > 0 ? id : null;
  };

  // Tier 1: what the device check recorded we actually wrote, which is exact.
  //
  // library_path is the file the sync copied from, which for a shadow-backed
  // device is the transcode under the shadow library rather than the library
  // track itself — hence the second join. COALESCE, not two queries: a row can
  // only ever be one of the two.
  const synced = db
    .prepare(
      `SELECT COALESCE(t.id, src.id) AS id, dst.device_path
         FROM device_synced_tracks dst
         LEFT JOIN tracks t ON t.path = dst.library_path
         LEFT JOIN shadow_tracks st ON st.shadow_path = dst.library_path
         LEFT JOIN tracks src ON src.id = st.source_track_id
        WHERE dst.device_id = ?
          AND COALESCE(t.id, src.id) IS NOT NULL`
    )
    .all(deviceId) as ResolverRow[];

  for (const row of synced) {
    if (!row.device_path) continue;
    const key = normalizeDevicePath(row.device_path);
    put(byDevicePath, key, row.id);
    // The same record, extension removed: covers a device whose codec profile
    // changed since the last check, where the recorded name is right but the
    // extension no longer is.
    put(byDeviceStem, codecAgnosticKey(key), row.id);
  }

  // The remaining tiers cover rows written before device_path existed, devices
  // that have never been checked, and files Rockbox knows about that the check
  // did not record. All are ambiguity-aware.
  const libraryRows = db
    .prepare(
      `SELECT t.id, t.filename, t.path, t.library_folder_id,
              a.name AS artist,
              COALESCE(aa.name, a.name) AS album_artist,
              al.title AS album
         FROM tracks t
         LEFT JOIN artists a ON t.artist_id = a.id
         LEFT JOIN albums al ON t.album_id = al.id
         LEFT JOIN artists aa ON al.artist_id = aa.id
        WHERE t.content_type = 'music'`
    )
    .all() as LibraryRow[];

  const libraryFolderPaths = new Map<number, string>(
    (
      db
        .prepare("SELECT id, path FROM library_folders")
        .all() as { id: number; path: string }[]
    ).map((f) => [f.id, f.path])
  );

  for (const row of libraryRows) {
    const filename = row.filename ?? path.basename(row.path);
    const safeName = sanitizeDevicePathComponent(filename);
    put(byBasename, codecAgnosticKey(safeName), row.id);

    // Tag layout, as computeDeviceRelativePath builds it. albumGrouping is a
    // per-device setting we do not have here, so register both spellings: they
    // differ only on a compilation, and the ambiguity guard covers a clash.
    const album = (row.album ?? "").trim();
    if (album && album !== "Unknown Album") {
      const safeAlbum = sanitizeDevicePathComponent(album);
      for (const name of new Set([row.album_artist, row.artist])) {
        const artist = (name ?? "").trim();
        if (!artist || artist === "Unknown Artist") continue;
        const safeArtist = sanitizeDevicePathComponent(artist);
        put(
          byTagPath,
          codecAgnosticKey(`${safeArtist}/${safeAlbum}/${safeName}`),
          row.id
        );
      }
    }

    // Mirrored layout, for devices sync'd with preserveFolderStructure.
    const mirrored = folderRelativePath(
      row.path,
      "music",
      libraryFolderPaths,
      row.library_folder_id ?? undefined
    );
    if (mirrored) put(byMirrorPath, codecAgnosticKey(mirrored), row.id);
  }

  return {
    knownPaths: byDevicePath.size,
    resolve(devicePath: string): number | null {
      const normalised = normalizeDevicePath(devicePath);
      const exact = pick(byDevicePath, normalised);
      if (exact != null) return exact;

      const stem = pick(byDeviceStem, codecAgnosticKey(normalised));
      if (stem != null) return stem;

      const rel = codecAgnosticKey(stripDevicePrefix(devicePath));
      const tagged = pick(byTagPath, rel);
      if (tagged != null) return tagged;

      const mirrored = pick(byMirrorPath, rel);
      if (mirrored != null) return mirrored;

      return pick(byBasename, rel.split("/").pop() ?? "");
    },
  };
}
