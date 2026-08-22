/**
 * @vitest-environment node
 *
 * Issue #112: "Mirror library folder structure" silently did nothing when the
 * library root was a filesystem/drive root (e.g. Windows `M:\`, POSIX `/`).
 *
 * `folderRelativePath` used to test `resolved.startsWith(baseResolved + sep)`.
 * For a drive root, `path.resolve("M:\\")` is already `"M:\\"`, so the test
 * compared against the doubled separator `"M:\\\\"`, never matched, returned
 * null, and every caller fell back to a tag-based path — exactly the reported
 * symptom (the reporter's workaround was to nest the library under `M:\temp`).
 *
 * The drive-root case cannot be reproduced with native POSIX `path`, so these
 * tests inject `path.win32` as the path flavor.
 */
import { describe, it, expect } from "vitest";
import * as path from "path";
import { folderRelativePath } from "../../main/sync/sync-core";

const DRIVE_ROOT = "M:\\";
const winFolders = new Map<number, string>([[1, DRIVE_ROOT]]);

describe("folderRelativePath — library root is a drive root (issue #112)", () => {
  it("mirrors the source layout from a Windows drive root", () => {
    const track = "M:\\Avicii\\Levels (2011)\\01 - Levels.flac";
    expect(
      folderRelativePath(track, "music", winFolders, 1, path.win32)
    ).toBe("Avicii/Levels (2011)/01 - Levels.flac");
  });

  it("does not drop the first character of the relative path", () => {
    // The old manual `slice(baseResolved.length + 1)` produced "vicii\\...".
    const track = "M:\\Avicii\\Levels (2011)\\01 - Levels.flac";
    const rel = folderRelativePath(track, "music", winFolders, 1, path.win32);
    expect(rel?.startsWith("vicii")).toBe(false);
    expect(rel?.startsWith("Avicii/")).toBe(true);
  });

  it("injects no '_' segment for the drive root's empty basename", () => {
    // Two-part path hits the basename-prepend branch; basename("M:\\") is "".
    const track = "M:\\Avicii\\01 - Levels.flac";
    const rel = folderRelativePath(track, "music", winFolders, 1, path.win32);
    expect(rel).toBe("Avicii/01 - Levels.flac");
    expect(rel?.split("/")).not.toContain("_");
  });

  it("still strips a leading content folder from a drive root", () => {
    const track = "M:\\Music\\Avicii\\Levels (2011)\\01 - Levels.flac";
    expect(
      folderRelativePath(track, "music", winFolders, 1, path.win32)
    ).toBe("Avicii/Levels (2011)/01 - Levels.flac");
  });

  it("returns null for a track outside the library root", () => {
    const track = "N:\\Elsewhere\\track.flac";
    expect(
      folderRelativePath(track, "music", winFolders, 1, path.win32)
    ).toBeNull();
  });

  it("mirrors from a POSIX filesystem root", () => {
    const posixFolders = new Map<number, string>([[1, "/"]]);
    expect(
      folderRelativePath(
        "/Avicii/Levels (2011)/01 - Levels.flac",
        "music",
        posixFolders,
        1,
        path.posix
      )
    ).toBe("Avicii/Levels (2011)/01 - Levels.flac");
  });
});

describe("folderRelativePath — nested roots keep their existing behaviour", () => {
  const nested = new Map<number, string>([[1, "M:\\temp"]]);

  it("mirrors a three-level layout unchanged", () => {
    expect(
      folderRelativePath(
        "M:\\temp\\Avicii\\Levels (2011)\\01 - Levels.flac",
        "music",
        nested,
        1,
        path.win32
      )
    ).toBe("Avicii/Levels (2011)/01 - Levels.flac");
  });

  it("still prepends the library folder name for a shallow layout", () => {
    expect(
      folderRelativePath(
        "M:\\temp\\Avicii\\01 - Levels.flac",
        "music",
        nested,
        1,
        path.win32
      )
    ).toBe("temp/Avicii/01 - Levels.flac");
  });
});
