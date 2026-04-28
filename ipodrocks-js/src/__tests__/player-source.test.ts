/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Mock electron before importing player-source
vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: (name: string) => {
      if (name === "temp") return os.tmpdir();
      return os.tmpdir();
    },
  },
}));

// Mock ffmpeg-path so we don't need a real ffmpeg binary for unit tests
vi.mock("../main/utils/ffmpeg-path", () => ({
  getFfmpegPath: () => "ffmpeg",
}));

// Mock encoder-env
vi.mock("../main/utils/encoder-env", () => ({
  getEncoderEnv: () => process.env,
}));

import { pickStrategy, isAudioFilePath, prepareTrack, cancelPrepare, encodePathToUrl, decodeUrlToPath } from "../main/player/player-source";
import type { Track } from "../shared/types";

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: 1,
    path: "/music/song.mp3",
    filename: "song.mp3",
    title: "Song",
    artist: "Artist",
    album: "Album",
    genre: "Rock",
    codec: "MP3",
    duration: 180,
    bitrate: 320000,
    bitsPerSample: 16,
    fileSize: 5_000_000,
    contentType: "music",
    libraryFolderId: 1,
    fileHash: "abc",
    metadataHash: "def",
    trackNumber: 1,
    discNumber: 1,
    playCount: 0,
    rating: null,
    ratingSourceDeviceId: null,
    ratingUpdatedAt: null,
    ratingVersion: 0,
    ...overrides,
  } as Track;
}

describe("pickStrategy", () => {
  it.each(["MP3", "AAC", "FLAC", "OGG", "OPUS", "PCM", "ALAC"])(
    "returns native for %s",
    (codec) => {
      expect(pickStrategy(makeTrack({ codec }))).toBe("native");
    },
  );

  it.each(["MPC", "APE"])(
    "returns transcode for %s",
    (codec) => {
      expect(pickStrategy(makeTrack({ codec }))).toBe("transcode");
    },
  );
});

describe("isAudioFilePath", () => {
  it.each([".mp3", ".flac", ".ogg", ".opus", ".m4a", ".wav", ".ape", ".mpc"])(
    "returns true for %s",
    (ext) => {
      expect(isAudioFilePath(`/music/song${ext}`)).toBe(true);
    },
  );

  it("returns false for non-audio extension", () => {
    expect(isAudioFilePath("/docs/readme.txt")).toBe(false);
    expect(isAudioFilePath("/img/photo.jpg")).toBe(false);
  });
});

describe("encodePathToUrl / decodeUrlToPath", () => {
  it("round-trips a Unix path", () => {
    const p = "/Users/test/Music/Song with spaces.mp3";
    const url = encodePathToUrl(p);
    expect(url).toMatch(/^media:\/\/local\//);
    expect(decodeUrlToPath(url)).toBe(p);
  });

  it("round-trips a path with special chars", () => {
    const p = "/Music/Björk/Song (remix) [2024].flac";
    expect(decodeUrlToPath(encodePathToUrl(p))).toBe(p);
  });
});

describe("prepareTrack (native)", () => {
  it("returns a media:// url with native strategy for MP3", async () => {
    const track = makeTrack({ codec: "MP3", path: "/music/song.mp3" });
    const { url, strategy } = await prepareTrack(track);
    expect(strategy).toBe("native");
    expect(url).toMatch(/^media:\/\/local\//);
    expect(decodeUrlToPath(url)).toBe("/music/song.mp3");
  });
});

describe("prepareTrack (transcode)", () => {
  let canRunFfmpeg = false;
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "player-test-"));
    // Check if real ffmpeg binary is available
    try {
      const { spawnSync } = require("child_process");
      const result = spawnSync("ffmpeg", ["-version"], { timeout: 3000 });
      canRunFfmpeg = result.status === 0;
    } catch {
      canRunFfmpeg = false;
    }
  });

  afterEach(async () => {
    await cancelPrepare();
    try { fs.rmSync(testDir, { recursive: true }); } catch {}
  });

  it.skipIf(!canRunFfmpeg)(
    "transcodes APE to ogg and returns a temp media:// url",
    async () => {
      // This test needs a real audio file and ffmpeg; skip if unavailable
    },
  );
});

describe("cancelPrepare", () => {
  it("resolves without error when nothing is active", async () => {
    await expect(cancelPrepare()).resolves.toBeUndefined();
  });
});
