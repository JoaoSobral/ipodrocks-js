/**
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import {
  compareLibraries,
  SIZE_TOLERANCE,
  MTIME_TOLERANCE_MS,
} from "../main/sync/name-size-sync";

describe("name-size-sync", () => {
  describe("compareLibraries", () => {
    it("reports missing when library has track not on device", () => {
      const libraryDestMap = { "/lib/track.mp3": "Artist/Album/track.mp3" };
      const libraryExpectedSizes = { "/lib/track.mp3": 5000000 };
      const deviceContentPath = "/mnt/device/Music";
      const deviceFilesMap: Record<string, { file_size: number }> = {};

      const result = compareLibraries(
        libraryDestMap,
        libraryExpectedSizes,
        deviceContentPath,
        deviceFilesMap
      );

      expect(result.missingTracks.size).toBe(1);
      expect(result.missingTracks.has("/lib/track.mp3")).toBe(true);
      expect(result.tracksToSkip).toHaveLength(0);
      expect(result.extras).toHaveLength(0);
    });

    it("reports track to skip when device has matching file with same size", () => {
      const libraryDestMap = { "/lib/track.mp3": "Artist/Album/track.mp3" };
      const libraryExpectedSizes = { "/lib/track.mp3": 5000000 };
      const deviceContentPath = "/mnt/device/Music";
      const deviceFilesMap: Record<string, { file_size: number }> = {
        "/mnt/device/Music/Artist/Album/track.mp3": { file_size: 5000000 },
      };

      const result = compareLibraries(
        libraryDestMap,
        libraryExpectedSizes,
        deviceContentPath,
        deviceFilesMap
      );

      expect(result.missingTracks.size).toBe(0);
      expect(result.tracksToSkip).toHaveLength(1);
      expect(result.tracksToSkip[0].reason).toBe("name_size_match");
    });

    it("respects SIZE_TOLERANCE for size comparison", () => {
      const libraryDestMap = { "/lib/track.mp3": "Artist/Album/track.mp3" };
      const libraryExpectedSizes = { "/lib/track.mp3": 5000000 };
      const deviceContentPath = "/mnt/device/Music";
      const deviceFilesMap: Record<string, { file_size: number }> = {
        "/mnt/device/Music/Artist/Album/track.mp3": {
          file_size: 5000000 + SIZE_TOLERANCE,
        },
      };

      const result = compareLibraries(
        libraryDestMap,
        libraryExpectedSizes,
        deviceContentPath,
        deviceFilesMap
      );

      expect(result.tracksToSkip).toHaveLength(1);
    });

    it("reports extras when device has file not in library", () => {
      const libraryDestMap: Record<string, string> = {};
      const libraryExpectedSizes: Record<string, number> = {};
      const deviceContentPath = "/mnt/device/Music";
      const deviceFilesMap: Record<string, { file_size: number }> = {
        "/mnt/device/Music/Orphan/orphan.mp3": { file_size: 1000000 },
      };

      const result = compareLibraries(
        libraryDestMap,
        libraryExpectedSizes,
        deviceContentPath,
        deviceFilesMap
      );

      expect(result.extras).toHaveLength(1);
      expect(result.extras[0]).toContain("orphan.mp3");
    });

    it("treats lossy converted track as up to date when device mtime is newer", () => {
      const libraryDestMap = {
        "/lib/track.alac": "Artist/Album/track.mpc",
      };
      // expectedSize === 0 models lossy conversions where size is ignored
      const libraryExpectedSizes = { "/lib/track.alac": 0 };
      const deviceContentPath = "/mnt/device/Music";
      const now = Date.now();
      const libraryExpectedMtimes = {
        "/lib/track.alac": now - 60_000,
      };
      const deviceFilesMap: Record<string, { file_size: number; mtime: number }> = {
        "/mnt/device/Music/Artist/Album/track.mpc": {
          file_size: 3_000_000,
          mtime: now,
        },
      };

      const result = compareLibraries(
        libraryDestMap,
        libraryExpectedSizes,
        deviceContentPath,
        deviceFilesMap,
        { libraryExpectedMtimes }
      );

      expect(result.missingTracks.size).toBe(0);
      expect(result.tracksToSkip).toHaveLength(1);
      expect(result.tracksToSkip[0].reason).toBe("name_size_match");
    });

    it("marks lossy converted track as missing when library mtime is newer than device", () => {
      const libraryDestMap = {
        "/lib/track.alac": "Artist/Album/track.mpc",
      };
      const libraryExpectedSizes = { "/lib/track.alac": 0 };
      const deviceContentPath = "/mnt/device/Music";
      const baseTime = Date.now();
      const libraryExpectedMtimes = {
        "/lib/track.alac": baseTime + MTIME_TOLERANCE_MS + 10_000,
      };
      const deviceFilesMap: Record<string, { file_size: number; mtime: number }> = {
        "/mnt/device/Music/Artist/Album/track.mpc": {
          file_size: 3_000_000,
          mtime: baseTime,
        },
      };

      const result = compareLibraries(
        libraryDestMap,
        libraryExpectedSizes,
        deviceContentPath,
        deviceFilesMap,
        { libraryExpectedMtimes }
      );

      expect(result.missingTracks.size).toBe(1);
      expect(result.missingTracks.has("/lib/track.alac")).toBe(true);
      expect(result.tracksToSkip).toHaveLength(0);
    });
  });
});
