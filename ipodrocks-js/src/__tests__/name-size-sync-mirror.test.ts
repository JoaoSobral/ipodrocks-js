/**
 * @vitest-environment node
 *
 * Issue #82 follow-up: when "mirror library folder structure" is enabled, the
 * device-relative path is deterministic from the library folder layout. A device
 * file whose basename matches but whose *folder* differs (e.g. an old sync that
 * dropped the year: "3 Doors Down/track.mp3" vs the mirrored
 * "3 Doors Down (2002)/track.mp3") must be treated as an orphan, and the correct
 * mirrored path must be (re)copied — not silently matched by basename.
 *
 * In tag-based mode (preserveFolderStructure off) the historical folder-agnostic
 * basename fallback is preserved.
 */
import { describe, it, expect } from "vitest";
import { compareLibraries } from "../main/sync/name-size-sync";

const DEVICE_CONTENT = "/Volumes/IPOD/Music";
const LIB_PATH = "/music-library/3 Doors Down/3 Doors Down (2002)/track.mp3";
const MIRRORED_REL = "3 Doors Down/3 Doors Down (2002)/track.mp3";
// Old on-device layout from a previous tag-based sync (year dropped).
const OLD_DEVICE_PATH = `${DEVICE_CONTENT}/3 Doors Down/3 Doors Down/track.mp3`;
const SIZE = 4_000_000;

const libraryDestMap = { [LIB_PATH]: MIRRORED_REL };
const libraryExpectedSizes = { [LIB_PATH]: SIZE };
const deviceFilesMap = { [OLD_DEVICE_PATH]: { file_size: SIZE } };

describe("compareLibraries — mirror mode (preserveFolderStructure)", () => {
  it("treats a wrong-folder basename match as an orphan and re-copies the mirrored path", () => {
    const result = compareLibraries(
      libraryDestMap,
      libraryExpectedSizes,
      DEVICE_CONTENT,
      deviceFilesMap,
      { profileCodecExt: null, preserveFolderStructure: true },
    );

    // The mirrored (year-bearing) path is not on the device → must be copied.
    expect(result.missingTracks.has(LIB_PATH)).toBe(true);
    // The old year-less file is unmatched → flagged as an orphan.
    expect(result.extras).toContain(OLD_DEVICE_PATH);
    expect(result.tracksToSkip).toHaveLength(0);
  });

  it("tag-based mode keeps the historical basename fallback (no orphan, no re-copy)", () => {
    const result = compareLibraries(
      libraryDestMap,
      libraryExpectedSizes,
      DEVICE_CONTENT,
      deviceFilesMap,
      { profileCodecExt: null, preserveFolderStructure: false },
    );

    expect(result.missingTracks.has(LIB_PATH)).toBe(false);
    expect(result.extras).not.toContain(OLD_DEVICE_PATH);
    expect(result.tracksToSkip).toHaveLength(1);
  });
});
