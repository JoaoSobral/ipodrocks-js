/**
 * Byte-identical duplicate detection over the tracks table.
 *
 * Two tracks are duplicates when they share a content hash — that is the file
 * itself, not its metadata (metadata-based matching used to collapse genuinely
 * different songs on multi-disc albums). Purely diagnostic: nothing here
 * deletes or rewrites rows; both the post-scan warnings and Rocksy's
 * `library_find_duplicates` tool report what they find and leave the decision
 * to the user.
 */
import Database from "better-sqlite3";

import { escapeLike } from "../utils/sql-like";

export interface DuplicateGroup {
  /** Shared content hash of every path in the group. */
  fileHash: string;
  /** Two or more paths whose file contents are identical. */
  paths: string[];
}

/**
 * GROUP_CONCAT separator. ASCII Unit Separator rather than "\n" because POSIX
 * filenames may legally contain newlines, which would make the split ambiguous.
 */
const PATH_SEPARATOR = "\x1f";

/**
 * Find groups of tracks sharing a content hash, optionally restricted to paths
 * under `folderPrefix`. Tracks with no computed hash are ignored — an empty
 * hash would otherwise group every unhashed file together.
 */
export function findDuplicateFileGroups(
  db: Database.Database,
  folderPrefix?: string
): DuplicateGroup[] {
  const where =
    folderPrefix != null ? "AND path LIKE ? ESCAPE '\\'" : "";
  const params = folderPrefix != null ? [escapeLike(folderPrefix) + "%"] : [];

  const rows = db
    .prepare(
      `SELECT file_hash, GROUP_CONCAT(path, CHAR(31)) AS paths, COUNT(*) AS n
         FROM tracks
        WHERE file_hash IS NOT NULL AND file_hash != ''
          ${where}
        GROUP BY file_hash
       HAVING n > 1`
    )
    .all(...params) as { file_hash: string; paths: string; n: number }[];

  return rows.map((r) => ({
    fileHash: r.file_hash,
    paths: r.paths.split(PATH_SEPARATOR),
  }));
}

/** Render duplicate groups as the human-readable warnings a scan reports. */
export function formatDuplicateWarnings(groups: DuplicateGroup[]): string[] {
  return groups.map(
    (g) =>
      `Duplicate file content (${g.paths.length} copies): ${g.paths.join(" | ")}`
  );
}
