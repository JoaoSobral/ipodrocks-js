/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MetadataExtractor } from "../main/library/metadata-extractor";

vi.mock("music-metadata", () => ({
  parseFile: vi.fn(),
}));

vi.mock("child_process", () => ({
  spawnSync: vi.fn(),
}));

vi.mock("../main/utils/encoder-env", () => ({
  getEncoderEnv: () => ({ PATH: "/usr/bin" }),
}));

import { parseFile } from "music-metadata";
import { spawnSync } from "child_process";

const mockParseFile = vi.mocked(parseFile);
const mockSpawnSync = vi.mocked(spawnSync);

const FFPROBE_OK = (duration = "476.34", bitrate = "128000", codec = "opus") =>
  ({
    status: 0,
    stdout: JSON.stringify({
      format: { duration, bit_rate: bitrate },
      streams: [{ codec_name: codec, sample_rate: "48000" }],
    }),
    stderr: "",
    error: undefined,
  } as ReturnType<typeof spawnSync>);

const FFPROBE_FAIL = { status: 1, stdout: "", stderr: "", error: undefined } as ReturnType<typeof spawnSync>;

describe("MetadataExtractor", () => {
  let extractor: MetadataExtractor;

  beforeEach(() => {
    extractor = new MetadataExtractor();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── extractAudioInfo ──────────────────────────────────────────────────────

  describe("extractAudioInfo", () => {
    it("returns music-metadata values when fully populated", async () => {
      mockParseFile.mockResolvedValue({
        format: { duration: 300, bitrate: 256000, codec: "MP3", sampleRate: 44100 },
        common: {},
        native: {},
        quality: { warnings: [] },
      } as never);

      const info = await extractor.extractAudioInfo("/test/track.mp3");
      expect(info.duration).toBe(300);
      expect(info.bitrate).toBe(256000);
      expect(info.codec).toBe("MP3");
      expect(info.sampleRate).toBe(44100);
    });

    it("falls back to ffprobe when music-metadata returns duration=0", async () => {
      mockParseFile.mockResolvedValue({
        format: { duration: 0, bitrate: 0, codec: "opus", sampleRate: 48000 },
        common: {},
        native: {},
        quality: { warnings: [] },
      } as never);
      mockSpawnSync.mockReturnValue(FFPROBE_OK("476.34", "128000", "opus"));

      const info = await extractor.extractAudioInfo("/test/track.opus");
      expect(info.duration).toBeCloseTo(476.34);
      expect(info.bitrate).toBe(128000);
    });

    it("falls back to ffprobe when music-metadata returns bitrate=0 but has duration", async () => {
      mockParseFile.mockResolvedValue({
        format: { duration: 300, bitrate: 0, codec: "opus", sampleRate: 48000 },
        common: {},
        native: {},
        quality: { warnings: [] },
      } as never);
      mockSpawnSync.mockReturnValue(FFPROBE_OK("300", "96000", "opus"));

      const info = await extractor.extractAudioInfo("/test/track.opus");
      expect(info.duration).toBe(300);
      expect(info.bitrate).toBe(96000);
    });

    it("prefers music-metadata duration over ffprobe when music-metadata has it", async () => {
      mockParseFile.mockResolvedValue({
        format: { duration: 300, bitrate: 0, codec: "opus", sampleRate: 48000 },
        common: {},
        native: {},
        quality: { warnings: [] },
      } as never);
      mockSpawnSync.mockReturnValue(FFPROBE_OK("999", "96000", "opus"));

      const info = await extractor.extractAudioInfo("/test/track.opus");
      expect(info.duration).toBe(300);
      expect(info.bitrate).toBe(96000);
    });

    it("falls back to ffprobe when music-metadata throws", async () => {
      mockParseFile.mockRejectedValue(new RangeError("Offset is outside the bounds of the DataView"));
      mockSpawnSync.mockReturnValue(FFPROBE_OK("476.34", "324188", "opus"));

      const info = await extractor.extractAudioInfo("/test/track.opus");
      expect(info.duration).toBeCloseTo(476.34);
      expect(info.bitrate).toBe(324188);
      expect(info.codec).toBe("OPUS");
    });

    it("returns zeros when music-metadata throws and ffprobe also fails", async () => {
      mockParseFile.mockRejectedValue(new RangeError("Offset is outside the bounds of the DataView"));
      mockSpawnSync.mockReturnValue(FFPROBE_FAIL);

      const info = await extractor.extractAudioInfo("/test/track.opus");
      expect(info.duration).toBe(0);
      expect(info.bitrate).toBe(0);
      expect(info.codec).toBe("Unknown");
    });

    it("uses stream-level duration/bitrate from ffprobe when format-level is absent", async () => {
      mockParseFile.mockRejectedValue(new RangeError("parse error"));
      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: JSON.stringify({
          format: {},
          streams: [{ codec_name: "opus", sample_rate: "48000", duration: "300.5", bit_rate: "64000" }],
        }),
        stderr: "",
        error: undefined,
      } as ReturnType<typeof spawnSync>);

      const info = await extractor.extractAudioInfo("/test/track.opus");
      expect(info.duration).toBeCloseTo(300.5);
      expect(info.bitrate).toBe(64000);
    });

    it("normalises ALAC codec when m4a has alac in codec string", async () => {
      mockParseFile.mockResolvedValue({
        format: { duration: 200, bitrate: 500000, codec: "ALAC", sampleRate: 44100 },
        common: {},
        native: {},
        quality: { warnings: [] },
      } as never);

      const info = await extractor.extractAudioInfo("/test/track.m4a");
      expect(info.codec).toBe("ALAC");
      expect(info.bitsPerSample).toBe(16);
    });

    it("sets bitsPerSample=null for lossy formats", async () => {
      mockParseFile.mockResolvedValue({
        format: { duration: 200, bitrate: 128000, codec: "MP3", sampleRate: 44100 },
        common: {},
        native: {},
        quality: { warnings: [] },
      } as never);

      const info = await extractor.extractAudioInfo("/test/track.mp3");
      expect(info.bitsPerSample).toBeNull();
    });
  });

  // ── extractMetadata ───────────────────────────────────────────────────────

  describe("extractMetadata", () => {
    it("returns parsed tags from music-metadata", async () => {
      mockParseFile.mockResolvedValue({
        format: {},
        common: {
          title: "War Pigs",
          artist: "Black Sabbath",
          album: "Paranoid",
          genre: ["Metal"],
          track: { no: 1 },
          disk: { no: 1 },
        },
        native: {},
        quality: { warnings: [] },
      } as never);

      const meta = await extractor.extractMetadata("/test/01.opus");
      expect(meta.title).toBe("War Pigs");
      expect(meta.artist).toBe("Black Sabbath");
      expect(meta.album).toBe("Paranoid");
      expect(meta.genre).toBe("Metal");
      expect(meta.trackNumber).toBe("1");
    });

    it("falls back to ffprobe tags when music-metadata throws", async () => {
      mockParseFile.mockRejectedValue(new RangeError("Offset is outside the bounds of the DataView"));
      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: JSON.stringify({
          format: {
            tags: { title: "War Pigs", artist: "Black Sabbath", album: "Paranoid", genre: "Metal", track: "1" },
          },
        }),
        stderr: "",
        error: undefined,
      } as ReturnType<typeof spawnSync>);

      const meta = await extractor.extractMetadata("/test/01 - War Pigs.opus");
      expect(meta.title).toBe("War Pigs");
      expect(meta.artist).toBe("Black Sabbath");
      expect(meta.album).toBe("Paranoid");
    });

    it("uses file stem as title when both music-metadata and ffprobe fail", async () => {
      mockParseFile.mockRejectedValue(new RangeError("parse error"));
      mockSpawnSync.mockReturnValue(FFPROBE_FAIL);

      const meta = await extractor.extractMetadata("/test/01 - War Pigs.opus");
      expect(meta.title).toBe("01 - War Pigs");
      expect(meta.artist).toBe("Unknown Artist");
    });

    it("returns showTitle and episodeNumber for podcast content type", async () => {
      mockParseFile.mockResolvedValue({
        format: {},
        common: { title: "Ep 42", album: "My Show", artist: "Host", genre: [], track: { no: 42 }, disk: {} },
        native: {},
        quality: { warnings: [] },
      } as never);

      const meta = await extractor.extractMetadata("/test/ep42.mp3", "podcast");
      expect(meta.showTitle).toBe("My Show");
      expect(meta.episodeNumber).toBe("42");
    });
  });
});
