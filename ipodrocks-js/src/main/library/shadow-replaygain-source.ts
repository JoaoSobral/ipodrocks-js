/**
 * Resolve a file inside a shadow library back to the library track it was
 * transcoded from, so a Musepack repair can read the ReplayGain the transcode
 * lost (issue #130) and put it into the stream header (issue #137).
 *
 * Shared by Settings → Maintenance and by the shadow rebuild's verify pass so
 * the two can never disagree about where a shadow file's values come from. It
 * lives here rather than in `tagging/` because it reads the database and shells
 * out through `sync/`, neither of which the tagging tree may depend on.
 */

import { readReplayGainFromFile } from "../sync/sync-conversion";
import { normalizePath } from "../utils/normalize-path";
import type Database from "better-sqlite3";

/**
 * Paths are matched through `normalizePath` because `shadow_tracks.shadow_path`
 * is stored NFC-normalized while a filesystem walk yields whatever the
 * filesystem spells (NFD on macOS) — comparing the raw strings would match
 * nothing on exactly the machines this reporter's library lives on.
 *
 * The returned resolver probes lazily and caches per source track: a probe
 * spawns a subprocess, and the repair only asks for files that might need one.
 */
export function makeShadowSourceResolver(
  db: Database.Database,
  shadowLibraryId: number
): (mpcPath: string) => Record<string, string> | null {
  const rows = db
    .prepare(
      `SELECT st.shadow_path AS shadowPath, t.path AS sourcePath
         FROM shadow_tracks st
         JOIN tracks t ON t.id = st.source_track_id
        WHERE st.shadow_library_id = ?`
    )
    .all(shadowLibraryId) as { shadowPath: string; sourcePath: string }[];

  const sourceByShadow = new Map<string, string>();
  for (const row of rows) {
    if (row.shadowPath && row.sourcePath) {
      sourceByShadow.set(normalizePath(row.shadowPath), row.sourcePath);
    }
  }

  // Never probe one source twice — two shadow rows can point at the same track
  // when a library holds a duplicate.
  const cache = new Map<string, Record<string, string> | null>();
  return (mpcPath) => {
    const source = sourceByShadow.get(normalizePath(mpcPath));
    if (!source) return null;
    if (!cache.has(source)) {
      cache.set(source, readReplayGainFromFile(source) ?? null);
    }
    return cache.get(source) ?? null;
  };
}
