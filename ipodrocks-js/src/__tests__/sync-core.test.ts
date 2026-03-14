/**
 * @vitest-environment node
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  compareLibraries,
  SIZE_TOLERANCE,
  MTIME_TOLERANCE_MS,
} from "../main/sync/name-size-sync";
import {
  sanitizeDevicePathComponent,
  computeDeviceRelativePath,
  getProfileCodecExt,
  copyAlbumArtworkToDevice,
  runSync,
  cleanEmptyDirectories,
} from "../main/sync/sync-core";
import { Device } from "../main/devices/device";

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

    it("populates codecMismatchMap when device has different codec (stem match)", () => {
      const libraryDestMap = {
        "/lib/track.flac": "3 Doors Down/The Better Life/track.opus",
      };
      const libraryExpectedSizes = { "/lib/track.flac": 0 };
      const deviceContentPath = "/mnt/device/Music";
      const deviceRel = "3 Doors Down/The Better Life/track.mp3";
      const devicePath = `${deviceContentPath}/${deviceRel}`;
      const deviceFilesMap: Record<string, { file_size: number }> = {
        [devicePath]: { file_size: 3_000_000 },
      };

      const result = compareLibraries(
        libraryDestMap,
        libraryExpectedSizes,
        deviceContentPath,
        deviceFilesMap,
        { profileCodecExt: ".opus" }
      );

      expect(result.missingTracks.has("/lib/track.flac")).toBe(true);
      expect(result.codecMismatchPaths).toContain(devicePath);
      expect(result.codecMismatchMap.get("/lib/track.flac")).toBe(deviceRel);
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

  describe("cleanEmptyDirectories", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clean-empty-test-"));
    });

    afterEach(() => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    it("removes empty nested directories", () => {
      const nested = path.join(tmpDir, "a", "b", "c");
      fs.mkdirSync(nested, { recursive: true });

      cleanEmptyDirectories(tmpDir);

      expect(fs.existsSync(tmpDir)).toBe(false);
    });

    it("leaves directories that contain files", () => {
      const dirWithFile = path.join(tmpDir, "keep");
      fs.mkdirSync(dirWithFile, { recursive: true });
      fs.writeFileSync(path.join(dirWithFile, "file.txt"), "x");

      cleanEmptyDirectories(tmpDir);

      expect(fs.existsSync(tmpDir)).toBe(true);
      expect(fs.existsSync(dirWithFile)).toBe(true);
      expect(fs.existsSync(path.join(dirWithFile, "file.txt"))).toBe(true);
    });

    it("removes empty siblings but keeps dirs with files", () => {
      const emptyDir = path.join(tmpDir, "empty");
      const fullDir = path.join(tmpDir, "full");
      fs.mkdirSync(emptyDir, { recursive: true });
      fs.mkdirSync(fullDir, { recursive: true });
      fs.writeFileSync(path.join(fullDir, "f"), "x");

      cleanEmptyDirectories(tmpDir);

      expect(fs.existsSync(emptyDir)).toBe(false);
      expect(fs.existsSync(fullDir)).toBe(true);
    });
  });
});

describe("copyAlbumArtworkToDevice", () => {
  let tmpRoot: string;
  let devicePath: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sync-artwork-test-"));
    devicePath = path.join(tmpRoot, "device");
    fs.mkdirSync(devicePath, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("copies .jpg and .png artwork when destination missing", () => {
    const albumDir = path.join(tmpRoot, "Artist", "Album");
    fs.mkdirSync(albumDir, { recursive: true });
    fs.writeFileSync(path.join(albumDir, "track.mp3"), "audio");
    fs.writeFileSync(path.join(albumDir, "cover.jpg"), "jpeg");
    fs.writeFileSync(path.join(albumDir, "folder.png"), "png");

    const trackPath = path.join(albumDir, "track.mp3");
    const libraryTracks: Record<string, Record<string, unknown>> = {
      [trackPath]: { artist: "Artist", album: "Album" },
    };

    const result = copyAlbumArtworkToDevice(
      devicePath,
      "music",
      libraryTracks,
      undefined,
      undefined,
      undefined
    );

    expect(result.copied).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.totalCandidates).toBe(2);
    expect(fs.existsSync(path.join(devicePath, "Artist", "Album", "cover.jpg")))
      .toBe(true);
    expect(fs.existsSync(path.join(devicePath, "Artist", "Album", "folder.png")))
      .toBe(true);
  });

  it("skips artwork when destination has same size and mtime", () => {
    const albumDir = path.join(tmpRoot, "Artist", "Album");
    fs.mkdirSync(albumDir, { recursive: true });
    fs.writeFileSync(path.join(albumDir, "track.mp3"), "audio");
    const coverPath = path.join(albumDir, "cover.jpg");
    fs.writeFileSync(coverPath, "jpeg");

    const destDir = path.join(devicePath, "Artist", "Album");
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(coverPath, path.join(destDir, "cover.jpg"));

    const trackPath = path.join(albumDir, "track.mp3");
    const libraryTracks: Record<string, Record<string, unknown>> = {
      [trackPath]: { artist: "Artist", album: "Album" },
    };

    const result = copyAlbumArtworkToDevice(
      devicePath,
      "music",
      libraryTracks,
      undefined,
      undefined,
      undefined
    );

    expect(result.copied).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.errors).toBe(0);
    expect(result.totalCandidates).toBe(1);
  });

  it("re-copies artwork when destination differs", () => {
    const albumDir = path.join(tmpRoot, "Artist", "Album");
    fs.mkdirSync(albumDir, { recursive: true });
    fs.writeFileSync(path.join(albumDir, "track.mp3"), "audio");
    const srcCover = path.join(albumDir, "cover.jpg");
    fs.writeFileSync(srcCover, Buffer.alloc(200, 0x41));

    const destDir = path.join(devicePath, "Artist", "Album");
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(destDir, "cover.jpg"), Buffer.alloc(100, 0x42));

    const trackPath = path.join(albumDir, "track.mp3");
    const libraryTracks: Record<string, Record<string, unknown>> = {
      [trackPath]: { artist: "Artist", album: "Album" },
    };

    const result = copyAlbumArtworkToDevice(
      devicePath,
      "music",
      libraryTracks,
      undefined,
      undefined,
      undefined
    );

    expect(result.copied).toBe(1);
    expect(result.skipped).toBe(0);
    expect(fs.statSync(path.join(destDir, "cover.jpg")).size).toBe(200);
  });

  it("returns zeros for empty libraryTracks", () => {
    const result = copyAlbumArtworkToDevice(
      devicePath,
      "music",
      {},
      undefined,
      undefined,
      undefined
    );
    expect(result).toEqual({
      copied: 0,
      skipped: 0,
      errors: 0,
      totalCandidates: 0,
    });
  });

  it("does not copy non-artwork files", () => {
    const albumDir = path.join(tmpRoot, "Artist", "Album");
    fs.mkdirSync(albumDir, { recursive: true });
    fs.writeFileSync(path.join(albumDir, "track.mp3"), "audio");
    fs.writeFileSync(path.join(albumDir, "readme.txt"), "text");

    const trackPath = path.join(albumDir, "track.mp3");
    const libraryTracks: Record<string, Record<string, unknown>> = {
      [trackPath]: { artist: "Artist", album: "Album" },
    };

    const result = copyAlbumArtworkToDevice(
      devicePath,
      "music",
      libraryTracks,
      undefined,
      undefined,
      undefined
    );

    expect(result.copied).toBe(0);
    expect(result.totalCandidates).toBe(0);
    expect(fs.existsSync(path.join(devicePath, "Artist", "Album", "readme.txt")))
      .toBe(false);
  });

  it("does not copy .jpeg files (only .jpg and .png)", () => {
    const albumDir = path.join(tmpRoot, "Artist", "Album");
    fs.mkdirSync(albumDir, { recursive: true });
    fs.writeFileSync(path.join(albumDir, "track.mp3"), "audio");
    fs.writeFileSync(path.join(albumDir, "cover.jpeg"), "jpeg");

    const trackPath = path.join(albumDir, "track.mp3");
    const libraryTracks: Record<string, Record<string, unknown>> = {
      [trackPath]: { artist: "Artist", album: "Album" },
    };

    const result = copyAlbumArtworkToDevice(
      devicePath,
      "music",
      libraryTracks,
      undefined,
      undefined,
      undefined
    );

    expect(result.totalCandidates).toBe(0);
    expect(fs.existsSync(path.join(devicePath, "Artist", "Album", "cover.jpeg")))
      .toBe(false);
  });

  it("emits total_add with artwork candidate count", () => {
    const albumDir = path.join(tmpRoot, "Artist", "Album");
    fs.mkdirSync(albumDir, { recursive: true });
    fs.writeFileSync(path.join(albumDir, "track.mp3"), "audio");
    fs.writeFileSync(path.join(albumDir, "cover.jpg"), "jpeg");

    const trackPath = path.join(albumDir, "track.mp3");
    const libraryTracks: Record<string, Record<string, unknown>> = {
      [trackPath]: { artist: "Artist", album: "Album" },
    };

    const events: Array<{ event: string; path?: string }> = [];
    copyAlbumArtworkToDevice(
      devicePath,
      "music",
      libraryTracks,
      undefined,
      (e) => events.push({ event: e.event, path: e.path as string }),
      undefined
    );

    const totalAdd = events.find((e) => e.event === "total_add");
    expect(totalAdd).toBeDefined();
    expect(Number(totalAdd?.path)).toBe(1);
  });
});

describe("runSync artwork behavior", () => {
  let tmpRoot: string;
  let devicePath: string;
  let libraryPath: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sync-run-test-"));
    devicePath = path.join(tmpRoot, "device", "Music");
    libraryPath = path.join(tmpRoot, "library");
    fs.mkdirSync(devicePath, { recursive: true });
    fs.mkdirSync(path.join(libraryPath, "Artist", "Album"), {
      recursive: true,
    });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("copies artwork even when no tracks need syncing", async () => {
    const trackPath = path.join(libraryPath, "Artist", "Album", "track.mp3");
    const coverPath = path.join(libraryPath, "Artist", "Album", "cover.jpg");
    fs.writeFileSync(trackPath, "audio");
    fs.writeFileSync(coverPath, "jpeg");

    const deviceTrackPath = path.join(devicePath, "Artist", "Album", "track.mp3");
    fs.mkdirSync(path.dirname(deviceTrackPath), { recursive: true });
    fs.writeFileSync(deviceTrackPath, "audio");

    const libraryTracks: Record<string, Record<string, unknown>> = {
      [trackPath]: {
        artist: "Artist",
        album: "Album",
        fileSize: 5,
      },
    };
    const deviceFilesMap: Record<string, { file_size: number }> = {
      [deviceTrackPath]: { file_size: 5 },
    };

    const profile = {
      name: "Test",
      mountPath: path.dirname(devicePath),
      musicFolder: "Music",
      podcastFolder: "Podcasts",
      audiobookFolder: "Audiobooks",
      playlistFolder: "Playlists",
      modelId: null,
      defaultCodecConfigId: null,
      description: null,
      lastSyncDate: null,
      totalSyncedItems: 0,
      lastSyncCount: 0,
      defaultTransferModeId: 1,
      overrideBitrate: null,
      overrideQuality: null,
      overrideBits: null,
      partialSyncEnabled: false,
      sourceLibraryType: "primary" as const,
      shadowLibraryId: null,
      transferModeName: null,
      codecConfigName: "DIRECT COPY",
      codecConfigBitrate: null,
      codecConfigQuality: null,
      codecConfigBits: null,
      codecName: "DIRECT COPY",
      modelName: null,
      modelInternalValue: null,
    };
    const device = new Device(profile as never);

    await runSync(
      device,
      libraryTracks,
      "DIRECT COPY",
      "music",
      devicePath,
      deviceFilesMap,
      { extraTrackPolicy: "keep", skipAlbumArtwork: false },
      undefined
    );

    expect(fs.existsSync(path.join(devicePath, "Artist", "Album", "cover.jpg")))
      .toBe(true);
  });

  it("counts artwork errors into runSync result", async () => {
    const trackPath = path.join(libraryPath, "Artist", "Album", "track.mp3");
    const coverPath = path.join(libraryPath, "Artist", "Album", "cover.jpg");
    fs.writeFileSync(trackPath, "audio");
    fs.writeFileSync(coverPath, "jpeg");

    const deviceTrackPath = path.join(devicePath, "Artist", "Album", "track.mp3");
    const deviceAlbumDir = path.join(devicePath, "Artist", "Album");
    fs.mkdirSync(deviceAlbumDir, { recursive: true });
    fs.writeFileSync(deviceTrackPath, "audio");
    fs.mkdirSync(path.join(deviceAlbumDir, "cover.jpg"), { recursive: true });

    const libraryTracks: Record<string, Record<string, unknown>> = {
      [trackPath]: {
        artist: "Artist",
        album: "Album",
        fileSize: 5,
      },
    };
    const deviceFilesMap: Record<string, { file_size: number }> = {
      [deviceTrackPath]: { file_size: 5 },
    };

    const profile = {
      name: "Test",
      mountPath: path.dirname(devicePath),
      musicFolder: "Music",
      podcastFolder: "Podcasts",
      audiobookFolder: "Audiobooks",
      playlistFolder: "Playlists",
      modelId: null,
      defaultCodecConfigId: null,
      description: null,
      lastSyncDate: null,
      totalSyncedItems: 0,
      lastSyncCount: 0,
      defaultTransferModeId: 1,
      overrideBitrate: null,
      overrideQuality: null,
      overrideBits: null,
      partialSyncEnabled: false,
      sourceLibraryType: "primary" as const,
      shadowLibraryId: null,
      transferModeName: null,
      codecConfigName: "DIRECT COPY",
      codecConfigBitrate: null,
      codecConfigQuality: null,
      codecConfigBits: null,
      codecName: "DIRECT COPY",
      modelName: null,
      modelInternalValue: null,
    };
    const device = new Device(profile as never);

    const result = await runSync(
      device,
      libraryTracks,
      "DIRECT COPY",
      "music",
      devicePath,
      deviceFilesMap,
      { extraTrackPolicy: "keep", skipAlbumArtwork: false },
      undefined
    );

    expect(result.errors).toBeGreaterThan(0);
    expect(result.status).toBe("error");
  });

  it("skips artwork when skipAlbumArtwork is true", async () => {
    const trackPath = path.join(libraryPath, "Artist", "Album", "track.mp3");
    const coverPath = path.join(libraryPath, "Artist", "Album", "cover.jpg");
    fs.writeFileSync(trackPath, "audio");
    fs.writeFileSync(coverPath, "jpeg");

    const deviceTrackPath = path.join(devicePath, "Artist", "Album", "track.mp3");
    fs.mkdirSync(path.dirname(deviceTrackPath), { recursive: true });
    fs.writeFileSync(deviceTrackPath, "audio");

    const libraryTracks: Record<string, Record<string, unknown>> = {
      [trackPath]: {
        artist: "Artist",
        album: "Album",
        fileSize: 5,
      },
    };
    const deviceFilesMap: Record<string, { file_size: number }> = {
      [deviceTrackPath]: { file_size: 5 },
    };

    const profile = {
      name: "Test",
      mountPath: path.dirname(devicePath),
      musicFolder: "Music",
      podcastFolder: "Podcasts",
      audiobookFolder: "Audiobooks",
      playlistFolder: "Playlists",
      modelId: null,
      defaultCodecConfigId: null,
      description: null,
      lastSyncDate: null,
      totalSyncedItems: 0,
      lastSyncCount: 0,
      defaultTransferModeId: 1,
      overrideBitrate: null,
      overrideQuality: null,
      overrideBits: null,
      partialSyncEnabled: false,
      sourceLibraryType: "primary" as const,
      shadowLibraryId: null,
      transferModeName: null,
      codecConfigName: "DIRECT COPY",
      codecConfigBitrate: null,
      codecConfigQuality: null,
      codecConfigBits: null,
      codecName: "DIRECT COPY",
      modelName: null,
      modelInternalValue: null,
    };
    const device = new Device(profile as never);

    await runSync(
      device,
      libraryTracks,
      "DIRECT COPY",
      "music",
      devicePath,
      deviceFilesMap,
      { extraTrackPolicy: "keep", skipAlbumArtwork: true },
      undefined
    );

    expect(fs.existsSync(path.join(devicePath, "Artist", "Album", "cover.jpg")))
      .toBe(false);
  });

  it("removes empty directories after orphan removal", async () => {
    const trackPath = path.join(libraryPath, "Artist", "Album", "track.mp3");
    fs.writeFileSync(trackPath, "audio");

    const deviceTrackPath = path.join(devicePath, "Artist", "Album", "track.mp3");
    const orphanPath = path.join(devicePath, "OrphanArtist", "OrphanAlbum", "orphan.mp3");
    fs.mkdirSync(path.dirname(deviceTrackPath), { recursive: true });
    fs.mkdirSync(path.dirname(orphanPath), { recursive: true });
    fs.writeFileSync(deviceTrackPath, "audio");
    fs.writeFileSync(orphanPath, "orphan");

    const libraryTracks: Record<string, Record<string, unknown>> = {
      [trackPath]: { artist: "Artist", album: "Album", fileSize: 5 },
    };
    const deviceFilesMap: Record<string, { file_size: number }> = {
      [deviceTrackPath]: { file_size: 5 },
      [orphanPath]: { file_size: 6 },
    };

    const profile = {
      name: "Test",
      mountPath: path.dirname(devicePath),
      musicFolder: "Music",
      podcastFolder: "Podcasts",
      audiobookFolder: "Audiobooks",
      playlistFolder: "Playlists",
      modelId: null,
      defaultCodecConfigId: null,
      description: null,
      lastSyncDate: null,
      totalSyncedItems: 0,
      lastSyncCount: 0,
      defaultTransferModeId: 1,
      overrideBitrate: null,
      overrideQuality: null,
      overrideBits: null,
      partialSyncEnabled: false,
      sourceLibraryType: "primary" as const,
      shadowLibraryId: null,
      transferModeName: null,
      codecConfigName: "DIRECT COPY",
      codecConfigBitrate: null,
      codecConfigQuality: null,
      codecConfigBits: null,
      codecName: "DIRECT COPY",
      modelName: null,
      modelInternalValue: null,
    };
    const device = new Device(profile as never);

    await runSync(
      device,
      libraryTracks,
      "DIRECT COPY",
      "music",
      devicePath,
      deviceFilesMap,
      { extraTrackPolicy: "remove", skipAlbumArtwork: true },
      undefined
    );

    expect(fs.existsSync(orphanPath)).toBe(false);
    expect(fs.existsSync(path.join(devicePath, "OrphanArtist", "OrphanAlbum"))).toBe(false);
    expect(fs.existsSync(path.join(devicePath, "OrphanArtist"))).toBe(false);
  });
});
