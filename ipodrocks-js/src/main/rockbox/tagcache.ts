import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * Rockbox stores ratings (0–10) in its internal tagcache database.
 * We interact via database_changelog.txt which Rockbox exports/imports through
 * "Database → Export/Import Modifications".
 *
 * Changelog format (tab-separated, one entry per line):
 *   <relative-path-from-device-root>\t<field>=<value>
 * Example:
 *   /Music/artist/track.mp3\trating=7
 *
 * After we write the changelog, the user must run "Database → Initialize Now"
 * on the device for the ratings to be applied.
 */

const CHANGELOG_FILENAME = "database_changelog.txt";

/** Resolve the path to the Rockbox changelog file. */
function changelogPath(mountPath: string): string {
  return path.join(mountPath, ".rockbox", CHANGELOG_FILENAME);
}

export interface RockboxRatingEntry {
  /** Device-relative file path (e.g. /Music/artist/track.mp3) */
  filePath: string;
  /** Rating 0–10 */
  rating: number;
}

/**
 * Read ratings from the Rockbox database_changelog.txt.
 * Returns a map keyed by device-relative file path → rating (0–10).
 *
 * Returns empty map if the file doesn't exist (user hasn't exported yet).
 */
export function readRockboxRatings(mountPath: string): Map<string, number> {
  const result = new Map<string, number>();
  const filePath = changelogPath(mountPath);

  if (!fs.existsSync(filePath)) return result;

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    console.error("[tagcache] Failed to read changelog:", err);
    return result;
  }

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const tabIdx = trimmed.indexOf("\t");
    if (tabIdx === -1) continue;

    const devicePath = trimmed.slice(0, tabIdx).trim();
    const fields = trimmed.slice(tabIdx + 1);

    for (const field of fields.split("\t")) {
      const eqIdx = field.indexOf("=");
      if (eqIdx === -1) continue;
      const key = field.slice(0, eqIdx).trim().toLowerCase();
      const val = field.slice(eqIdx + 1).trim();
      if (key === "rating") {
        const rating = parseInt(val, 10);
        if (!Number.isNaN(rating) && rating >= 0 && rating <= 10) {
          result.set(devicePath, rating);
        }
      }
    }
  }

  return result;
}

/**
 * Write a rating propagation changelog to the device.
 * Uses atomic write (temp file + rename) to avoid partial writes.
 *
 * entries: array of { filePath (device-relative), rating (0–10) }
 *
 * After this call, the user must trigger "Database → Initialize Now" on
 * the Rockbox device to apply the changes.
 */
export function writeRockboxRatingsChangelog(
  mountPath: string,
  entries: RockboxRatingEntry[]
): void {
  if (entries.length === 0) return;

  const outPath = changelogPath(mountPath);
  const rockboxDir = path.dirname(outPath);

  if (!fs.existsSync(rockboxDir)) {
    throw new Error(
      `Rockbox directory not found at ${rockboxDir}. Is the device mounted correctly?`
    );
  }

  const lines: string[] = [
    "# ipodrocks rating export",
    `# Generated: ${new Date().toISOString()}`,
    `# ${entries.length} track(s)`,
    "",
  ];

  for (const entry of entries) {
    lines.push(`${entry.filePath}\trating=${entry.rating}`);
  }

  const content = lines.join("\n") + "\n";

  // Atomic write via temp file in same dir to keep rename on same filesystem
  const tmpPath = path.join(rockboxDir, `.ipodrocks_ratings_tmp_${process.pid}`);
  try {
    fs.writeFileSync(tmpPath, content, "utf-8");
    fs.renameSync(tmpPath, outPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
}

/**
 * Resolve a device-relative path (from the changelog) to the library path
 * by checking which device_synced_tracks entry matches.
 *
 * Returns null if no match found.
 */
export function resolveDevicePathToTrackId(
  db: import("better-sqlite3").Database,
  deviceId: number,
  deviceRelativePath: string,
  mountPath: string
): number | null {
  // device_synced_tracks stores the library path; the device path is derived.
  // We need to reverse-map: find tracks synced to this device and check if
  // the device-relative path corresponds to a library track.
  //
  // The mapping: deviceRelativePath e.g. "/Music/Artist - Album/track.opus"
  // The device_synced_tracks.library_path is the source path.
  //
  // We resolve by matching the filename component first, then doing a
  // full match on the track's filename in the device path.
  const filename = path.basename(deviceRelativePath);

  const rows = db
    .prepare(`
      SELECT t.id
      FROM tracks t
      JOIN device_synced_tracks dst ON dst.library_path = t.path
      WHERE dst.device_id = ?
        AND t.filename = ?
    `)
    .all(deviceId, filename) as { id: number }[];

  if (rows.length === 1) return rows[0].id;
  if (rows.length === 0) return null;

  // Multiple candidates with same filename — try to disambiguate by mount-relative path
  // by checking if the device path ends with the library filename portion
  for (const row of rows) {
    const track = db
      .prepare("SELECT path FROM tracks WHERE id = ?")
      .get(row.id) as { path: string } | undefined;
    if (!track) continue;
    const libBasename = path.basename(track.path, path.extname(track.path));
    const devBasename = path.basename(deviceRelativePath, path.extname(deviceRelativePath));
    if (libBasename.toLowerCase() === devBasename.toLowerCase()) {
      return row.id;
    }
  }

  return rows[0].id; // fallback: first match
}

/** Check if the device has a Rockbox changelog available to read. */
export function hasRockboxChangelog(mountPath: string): boolean {
  return fs.existsSync(changelogPath(mountPath));
}

/**
 * Build device-relative path for a track given the device's music folder.
 * Used when writing the changelog: we need to produce the path Rockbox expects.
 */
export function buildDeviceRelativePath(
  deviceMusicFolder: string,
  deviceFilename: string
): string {
  // Normalize to forward slashes as Rockbox uses Unix paths
  const normalized = path
    .join("/", deviceMusicFolder, deviceFilename)
    .replace(/\\/g, "/");
  return normalized;
}

/** Synthesize the temp dir path for OS-level temp files. */
export function getTempDir(): string {
  return os.tmpdir();
}
