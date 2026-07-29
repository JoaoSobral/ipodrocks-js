/**
 * @vitest-environment node
 *
 * Duplicate detection is shared by the post-scan warnings and Rocksy's
 * `library_find_duplicates` tool, so it is tested directly against a real
 * in-memory database.
 *
 * The separator matters: paths are recovered from a GROUP_CONCAT, and POSIX
 * filenames may legally contain newlines — hence the ASCII Unit Separator.
 */
import { describe, it, expect, beforeEach } from "vitest";

import { canRunDbTests, createTestDb, type TestDb } from "./harness/db";
import {
  findDuplicateFileGroups,
  formatDuplicateWarnings,
} from "../main/library/duplicate-files";

describe.skipIf(!canRunDbTests)("findDuplicateFileGroups", () => {
  let db: TestDb;

  beforeEach(() => {
    db = createTestDb();
  });

  function addTrack(trackPath: string, fileHash: string | null): void {
    db.prepare(
      "INSERT INTO tracks (path, filename, content_type, file_hash) VALUES (?, ?, 'music', ?)"
    ).run(trackPath, trackPath.split("/").pop(), fileHash);
  }

  it("groups tracks that share a content hash", () => {
    addTrack("/music/a/original.mp3", "hash-aaa");
    addTrack("/music/b/copy.mp3", "hash-aaa");
    addTrack("/music/c/unique.mp3", "hash-bbb");

    const groups = findDuplicateFileGroups(db);
    expect(groups).toHaveLength(1);
    expect(groups[0].fileHash).toBe("hash-aaa");
    expect(groups[0].paths.sort()).toEqual([
      "/music/a/original.mp3",
      "/music/b/copy.mp3",
    ]);
  });

  it("ignores tracks with no computed hash", () => {
    addTrack("/music/x.mp3", null);
    addTrack("/music/y.mp3", null);
    addTrack("/music/z.mp3", "");

    expect(findDuplicateFileGroups(db)).toEqual([]);
  });

  it("restricts results to the given folder prefix", () => {
    addTrack("/music/rock/a.mp3", "hash-aaa");
    addTrack("/music/rock/b.mp3", "hash-aaa");
    addTrack("/other/jazz/a.mp3", "hash-ccc");
    addTrack("/other/jazz/b.mp3", "hash-ccc");

    expect(findDuplicateFileGroups(db, "/music/rock")).toHaveLength(1);
    expect(findDuplicateFileGroups(db, "/other/jazz")).toHaveLength(1);
    expect(findDuplicateFileGroups(db)).toHaveLength(2);
  });

  it("treats LIKE metacharacters in the folder prefix literally", () => {
    addTrack("/music/100%_live/a.mp3", "hash-aaa");
    addTrack("/music/100%_live/b.mp3", "hash-aaa");
    addTrack("/music/1000-live/a.mp3", "hash-ddd");
    addTrack("/music/1000-live/b.mp3", "hash-ddd");

    const groups = findDuplicateFileGroups(db, "/music/100%_live");
    expect(groups).toHaveLength(1);
    expect(groups[0].fileHash).toBe("hash-aaa");
  });

  it("recovers paths containing newlines intact", () => {
    addTrack("/music/weird\nname.mp3", "hash-eee");
    addTrack("/music/plain.mp3", "hash-eee");

    const groups = findDuplicateFileGroups(db);
    expect(groups).toHaveLength(1);
    expect(groups[0].paths.sort()).toEqual([
      "/music/plain.mp3",
      "/music/weird\nname.mp3",
    ]);
  });

  it("reports the real copy count in the warning text", () => {
    addTrack("/music/a.mp3", "hash-fff");
    addTrack("/music/b.mp3", "hash-fff");
    addTrack("/music/c.mp3", "hash-fff");

    const warnings = formatDuplicateWarnings(findDuplicateFileGroups(db));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("3 copies");
    expect(warnings[0]).toContain("/music/a.mp3");
  });
});
