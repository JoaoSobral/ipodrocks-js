import { describe, it, expect } from "vitest";
import {
  compareLibraries,
  SIZE_TOLERANCE,
  type DeviceFileStats,
} from "../main/sync/name-size-sync";

const DEVICE_ROOT = "/mnt/ipod/Music";

function devicePath(rel: string): string {
  return `${DEVICE_ROOT}/${rel}`;
}

function buildDeviceMap(
  entries: [string, number][]
): Record<string, DeviceFileStats> {
  const map: Record<string, DeviceFileStats> = {};
  for (const [rel, size] of entries) {
    map[devicePath(rel)] = { file_size: size };
  }
  return map;
}

describe("NameSizeSync", () => {
  describe("path normalization", () => {
    it("matches case-insensitively", () => {
      const libDest: Record<string, string> = { "/lib/Song.flac": "Artist/Song.flac" };
      const libSizes: Record<string, number> = { "/lib/Song.flac": 1000 };
      const deviceFiles = buildDeviceMap([["artist/song.flac", 1000]]);

      const result = compareLibraries(libDest, libSizes, DEVICE_ROOT, deviceFiles);
      expect(result.missingTracks.size).toBe(0);
      expect(result.tracksToSkip).toHaveLength(1);
    });

    it("strips trailing dots and spaces from path segments (FAT32 safe)", () => {
      const libDest: Record<string, string> = {
        "/lib/track.flac": "Artist. ../song.flac",
      };
      const libSizes: Record<string, number> = { "/lib/track.flac": 500 };
      const deviceFiles = buildDeviceMap([["Artist/song.flac", 500]]);

      const result = compareLibraries(libDest, libSizes, DEVICE_ROOT, deviceFiles);
      expect(result.missingTracks.size).toBe(0);
      expect(result.tracksToSkip).toHaveLength(1);
    });
  });

  describe("compareLibraries", () => {
    it("detects missing tracks", () => {
      const libDest: Record<string, string> = {
        "/lib/a.flac": "Artist/a.flac",
        "/lib/b.flac": "Artist/b.flac",
      };
      const libSizes: Record<string, number> = {
        "/lib/a.flac": 1000,
        "/lib/b.flac": 2000,
      };
      const deviceFiles = buildDeviceMap([["Artist/a.flac", 1000]]);

      const result = compareLibraries(libDest, libSizes, DEVICE_ROOT, deviceFiles);
      expect(result.missingTracks.has("/lib/b.flac")).toBe(true);
      expect(result.missingTracks.size).toBe(1);
    });

    it("skips matching tracks within SIZE_TOLERANCE", () => {
      const libDest: Record<string, string> = {
        "/lib/a.flac": "Artist/a.flac",
      };
      const libSizes: Record<string, number> = { "/lib/a.flac": 1000 };
      const deviceFiles = buildDeviceMap([
        ["Artist/a.flac", 1000 + SIZE_TOLERANCE],
      ]);

      const result = compareLibraries(libDest, libSizes, DEVICE_ROOT, deviceFiles);
      expect(result.missingTracks.size).toBe(0);
      expect(result.tracksToSkip).toHaveLength(1);
      expect(result.tracksToSkip[0].reason).toBe("name_size_match");
    });

    it("marks as missing when size exceeds tolerance", () => {
      const libDest: Record<string, string> = {
        "/lib/a.flac": "Artist/a.flac",
      };
      const libSizes: Record<string, number> = { "/lib/a.flac": 1000 };
      const deviceFiles = buildDeviceMap([
        ["Artist/a.flac", 1000 + SIZE_TOLERANCE + 1],
      ]);

      const result = compareLibraries(libDest, libSizes, DEVICE_ROOT, deviceFiles);
      expect(result.missingTracks.has("/lib/a.flac")).toBe(true);
    });

    it("detects extras on device", () => {
      const libDest: Record<string, string> = {
        "/lib/a.flac": "Artist/a.flac",
      };
      const libSizes: Record<string, number> = { "/lib/a.flac": 1000 };
      const deviceFiles = buildDeviceMap([
        ["Artist/a.flac", 1000],
        ["Artist/orphan.flac", 3000],
      ]);

      const result = compareLibraries(libDest, libSizes, DEVICE_ROOT, deviceFiles);
      expect(result.extras).toHaveLength(1);
      expect(result.extras[0]).toContain("orphan.flac");
    });

    it("detects codec mismatch (same stem, different extension)", () => {
      const libDest: Record<string, string> = {
        "/lib/song.opus": "Artist/song.opus",
      };
      const libSizes: Record<string, number> = { "/lib/song.opus": 800 };
      const deviceFiles = buildDeviceMap([["Artist/song.mp3", 1200]]);

      const result = compareLibraries(
        libDest,
        libSizes,
        DEVICE_ROOT,
        deviceFiles,
        { profileCodecExt: ".opus" }
      );

      expect(result.missingTracks.has("/lib/song.opus")).toBe(true);
      expect(result.codecMismatchPaths).toHaveLength(1);
      expect(result.codecMismatchPaths[0]).toContain("song.mp3");
    });
  });
});
