/**
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import {
  compareLibraries,
  SIZE_TOLERANCE,
  MTIME_TOLERANCE_MS,
} from "../main/sync/name-size-sync";
import {
  sanitizeDevicePathComponent,
  computeDeviceRelativePath,
  getProfileCodecExt,
} from "../main/sync/sync-core";

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

    it("handles multiple missing, skipped, and extra files together", () => {
      const libraryDestMap: Record<string, string> = {
        "/lib/a.mp3": "Artist/Album/a.mp3",
        "/lib/b.mp3": "Artist/Album/b.mp3",
      };
      const libraryExpectedSizes: Record<string, number> = {
        "/lib/a.mp3": 5000000,
        "/lib/b.mp3": 3000000,
      };
      const deviceContentPath = "/mnt/device/Music";
      const deviceFilesMap: Record<string, { file_size: number }> = {
        "/mnt/device/Music/Artist/Album/a.mp3": { file_size: 5000000 },
        "/mnt/device/Music/Old/orphan.mp3": { file_size: 999 },
      };

      const result = compareLibraries(
        libraryDestMap,
        libraryExpectedSizes,
        deviceContentPath,
        deviceFilesMap
      );

      expect(result.missingTracks.size).toBe(1);
      expect(result.missingTracks.has("/lib/b.mp3")).toBe(true);
      expect(result.tracksToSkip).toHaveLength(1);
      expect(result.extras).toHaveLength(1);
    });
  });
});

describe("sync-core utilities", () => {
  describe("sanitizeDevicePathComponent", () => {
    it("replaces FAT32 invalid characters with underscores", () => {
      expect(sanitizeDevicePathComponent('file:name*"test')).toBe("file_name__test");
    });

    it("strips leading/trailing dots and spaces", () => {
      expect(sanitizeDevicePathComponent("...name...")).toBe("name");
      expect(sanitizeDevicePathComponent("  name  ")).toBe("name");
    });

    it("returns underscore for empty input", () => {
      expect(sanitizeDevicePathComponent("")).toBe("_");
    });

    it("returns underscore when all chars are invalid", () => {
      expect(sanitizeDevicePathComponent("...")).toBe("_");
    });

    it("truncates to maxLen", () => {
      const long = "a".repeat(300);
      expect(sanitizeDevicePathComponent(long, 10)).toBe("a".repeat(10));
    });

    it("preserves valid characters", () => {
      expect(sanitizeDevicePathComponent("The Who - It's Hard")).toBe(
        "The Who - It's Hard"
      );
    });

    it("replaces backslashes and forward slashes", () => {
      expect(sanitizeDevicePathComponent("AC/DC")).toBe("AC_DC");
      expect(sanitizeDevicePathComponent("path\\to")).toBe("path_to");
    });

    it("replaces pipe, angle brackets, and question mark", () => {
      expect(sanitizeDevicePathComponent("a|b<c>d?e")).toBe("a_b_c_d_e");
    });
  });

  describe("computeDeviceRelativePath", () => {
    it("uses Artist/Album/filename when metadata is present", () => {
      const result = computeDeviceRelativePath(
        "/media/music/Pink Floyd/DSOTM/01 - Speak to Me.flac",
        { artist: "Pink Floyd", album: "DSOTM" },
        "music"
      );
      expect(result).toBe("Pink Floyd/DSOTM/01 - Speak to Me.flac");
    });

    it("falls back to filename when artist is Unknown Artist", () => {
      const result = computeDeviceRelativePath(
        "/media/music/track.mp3",
        { artist: "Unknown Artist", album: "Unknown Album" },
        "music"
      );
      expect(result).toBe("track.mp3");
    });

    it("falls back to filename when metadata is empty", () => {
      const result = computeDeviceRelativePath(
        "/media/music/song.mp3",
        { artist: "", album: "" },
        "music"
      );
      expect(result).toBe("song.mp3");
    });

    it("sanitizes FAT32 invalid chars in artist/album/filename", () => {
      const result = computeDeviceRelativePath(
        "/media/music/AC:DC/Back*In/01 - Thunder.mp3",
        { artist: "AC/DC", album: 'Back "In" Black' },
        "music"
      );
      expect(result).toBe("AC_DC/Back _In_ Black/01 - Thunder.mp3");
    });

    it("falls back to just filename when no metadata and no folder mapping", () => {
      const result = computeDeviceRelativePath(
        "/media/music/SomeDir/track.mp3",
        { artist: "", album: "" },
        "music"
      );
      expect(result).toBe("track.mp3");
    });

    it("strips content-type prefix folder from relative path", () => {
      const folderPaths = new Map([[1, "/media"]]);
      const result = computeDeviceRelativePath(
        "/media/Music/Artist/Album/track.mp3",
        { artist: "", album: "", libraryFolderId: 1 },
        "music",
        folderPaths
      );
      expect(result).toBe("Artist/Album/track.mp3");
    });
  });

  describe("getProfileCodecExt", () => {
    it("returns null for DIRECT COPY", () => {
      expect(getProfileCodecExt("DIRECT COPY")).toBeNull();
    });

    it("returns null for COPY", () => {
      expect(getProfileCodecExt("COPY")).toBeNull();
    });

    it("returns null for NONE", () => {
      expect(getProfileCodecExt("NONE")).toBeNull();
    });

    it("returns .mp3 for mp3 codec", () => {
      expect(getProfileCodecExt("mp3")).toBe(".mp3");
    });

    it("returns .mpc for mpc codec", () => {
      expect(getProfileCodecExt("mpc")).toBe(".mpc");
    });

    it("returns .opus for opus codec", () => {
      expect(getProfileCodecExt("opus")).toBe(".opus");
    });

    it("is case-insensitive for non-copy codecs", () => {
      expect(getProfileCodecExt("MP3")).toBe(".mp3");
      expect(getProfileCodecExt("MPC")).toBe(".mpc");
    });
  });
});
