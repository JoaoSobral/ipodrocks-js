/**
 * @vitest-environment node
 *
 * Trash folders inside a scanned library must not be indexed — a deleted copy
 * of a track would otherwise reappear as a real library track. Matching is by
 * exact directory name so legitimate folders like "Trash Talk" keep scanning.
 */
import { describe, it, expect } from "vitest";

import { isTrashDirectory } from "../main/utils/audio-extensions";

describe("isTrashDirectory", () => {
  it("matches macOS and Linux trash folders", () => {
    for (const name of [".Trash", ".Trashes", ".Trash-1000", ".trash-0"]) {
      expect(isTrashDirectory(name)).toBe(true);
    }
  });

  it("matches the dotless freedesktop.org trash folder", () => {
    // ~/.local/share/Trash/files/… — the spec location has no leading dot.
    expect(isTrashDirectory("Trash")).toBe(true);
    expect(isTrashDirectory("trash")).toBe(true);
    expect(isTrashDirectory("Trash-1000")).toBe(true);
  });

  it("matches Windows and NAS recycle bins", () => {
    for (const name of [
      "$RECYCLE.BIN",
      "$Recycle.Bin",
      "RECYCLER",
      "Recycled",
      "#recycle",
      "@Recycle",
    ]) {
      expect(isTrashDirectory(name)).toBe(true);
    }
  });

  it("does not match legitimate folders that merely contain the word", () => {
    for (const name of [
      "Trash Talk",
      "Trashcan Sinatras",
      "White Trash",
      "Recycled Air",
      "trashy",
    ]) {
      expect(isTrashDirectory(name)).toBe(false);
    }
  });
});
