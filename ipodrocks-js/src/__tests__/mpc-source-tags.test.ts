/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { parseFileMock } = vi.hoisted(() => ({ parseFileMock: vi.fn() }));

vi.mock("music-metadata", () => ({
  parseFile: parseFileMock,
}));

import {
  readSourceApeTags,
  buildMpcApeTags,
  sanitizeTagText,
  extractReplayGainTags,
  pickReplayGainForM4a,
} from "../main/sync/sync-conversion";

beforeEach(() => {
  parseFileMock.mockReset();
});

describe("sanitizeTagText", () => {
  it("strips NULs and newlines and trims", () => {
    expect(sanitizeTagText("a\0b\nc\r\nd  ")).toBe("ab c d");
  });
});

describe("readSourceApeTags", () => {
  it("maps the full common tag set into ApeTags", async () => {
    parseFileMock.mockResolvedValue({
      common: {
        title: "Song",
        artist: "The Artist",
        album: "The Album",
        albumartist: "Various Artists",
        genre: ["Electronic", "House"],
        year: 2003,
        originalyear: 1999,
        originaldate: "1999-05-01",
        composer: ["A Composer", "B Composer"],
        comment: [{ text: "a note" }],
        compilation: true,
        track: { no: 4, of: 12 },
        disk: { no: 2, of: 2 },
      },
    });

    const tags = await readSourceApeTags("/music/song.flac");

    expect(tags.title).toBe("Song");
    expect(tags.albumArtist).toBe("Various Artists");
    expect(tags.genre).toBe("Electronic");
    expect(tags.year).toBe("2003");
    expect(tags.originalYear).toBe("1999");
    expect(tags.originalDate).toBe("1999-05-01");
    expect(tags.composer).toBe("A Composer, B Composer");
    expect(tags.comment).toBe("a note");
    expect(tags.compilation).toBe("1");
    expect(tags.track).toBe("4");
    expect(tags.disc).toBe("2");
  });

  it("sanitizes embedded NULs and newlines and skips empty fields", async () => {
    parseFileMock.mockResolvedValue({
      common: {
        artist: "The\0 Artist\n",
        album: "   ",
        year: 0,
      },
    });

    const tags = await readSourceApeTags("/music/song.flac");
    expect(tags.artist).toBe("The Artist");
    expect(tags.album).toBeUndefined();
    expect(tags.year).toBeUndefined();
  });

  it("maps embedded PNG cover art", async () => {
    parseFileMock.mockResolvedValue({
      common: {
        picture: [{ format: "image/png", data: Buffer.from([1, 2, 3]) }],
      },
    });
    const tags = await readSourceApeTags("/music/song.flac");
    expect(tags.coverArt?.mimeType).toBe("image/png");
    expect(tags.coverArt?.data.length).toBe(3);
  });

  it("returns empty tags when parsing fails", async () => {
    parseFileMock.mockRejectedValue(new Error("corrupt"));
    const tags = await readSourceApeTags("/music/broken.flac");
    expect(tags).toEqual({});
  });

  it("carries ReplayGain into extra as REPLAYGAIN_* APEv2 keys", async () => {
    parseFileMock.mockResolvedValue({
      common: {
        replaygain_track_gain: { dB: -3.38, ratio: 0.459 },
        replaygain_track_peak: { dB: -0.0085, ratio: 0.998054 },
        replaygain_album_gain: { dB: -2.32, ratio: 0.586 },
        replaygain_album_peak: { dB: -0.854, ratio: 0.821448 },
      },
    });

    const tags = await readSourceApeTags("/music/song.flac");

    expect(tags.extra).toEqual({
      REPLAYGAIN_TRACK_GAIN: "-3.38 dB",
      REPLAYGAIN_TRACK_PEAK: "0.998054",
      REPLAYGAIN_ALBUM_GAIN: "-2.32 dB",
      REPLAYGAIN_ALBUM_PEAK: "0.821448",
    });
  });

  it("omits extra when the source has no ReplayGain tags", async () => {
    parseFileMock.mockResolvedValue({ common: { title: "Song" } });
    const tags = await readSourceApeTags("/music/song.flac");
    expect(tags.extra).toBeUndefined();
  });
});

describe("extractReplayGainTags", () => {
  it("formats gain with a dB suffix and peak as a bare ratio", () => {
    const tags = extractReplayGainTags({
      replaygain_track_gain: { dB: -3.38 },
      replaygain_track_peak: { ratio: 0.998054 },
    });
    expect(tags).toEqual({
      REPLAYGAIN_TRACK_GAIN: "-3.38 dB",
      REPLAYGAIN_TRACK_PEAK: "0.998054",
    });
  });

  it("returns undefined when nothing is present", () => {
    expect(extractReplayGainTags({})).toBeUndefined();
  });
});

describe("pickReplayGainForM4a", () => {
  it("normalizes REPLAYGAIN_* keys to lowercase, case-insensitively", () => {
    const picked = pickReplayGainForM4a({
      REPLAYGAIN_TRACK_GAIN: "-3.38 dB",
      Album: "Ignored",
      replaygain_album_peak: "0.821448",
    });
    expect(picked).toEqual({
      replaygain_track_gain: "-3.38 dB",
      replaygain_album_peak: "0.821448",
    });
  });

  it("returns an empty object when extra is undefined", () => {
    expect(pickReplayGainForM4a(undefined)).toEqual({});
  });
});

describe("buildMpcApeTags", () => {
  const source = {
    title: "Source Title",
    artist: "Source Artist",
    albumArtist: "Various Artists",
    year: "2003",
    originalYear: "1999",
  };

  it("overlays ConversionMetadata over source for shared fields", () => {
    const tags = buildMpcApeTags(source, {
      title: "Edited Title",
      artist: "Edited Artist",
    });
    expect(tags.title).toBe("Edited Title");
    expect(tags.artist).toBe("Edited Artist");
    // Source-only fields survive the merge.
    expect(tags.albumArtist).toBe("Various Artists");
    expect(tags.originalYear).toBe("1999");
  });

  it("keeps the full source tag set when no metadata is provided (device-sync path)", () => {
    const tags = buildMpcApeTags(source, undefined);
    expect(tags.albumArtist).toBe("Various Artists");
    expect(tags.year).toBe("2003");
    expect(tags.originalYear).toBe("1999");
  });

  it("ignores zero/empty ConversionMetadata numeric fields", () => {
    const tags = buildMpcApeTags(source, { year: 0, trackNumber: 0, discNumber: 0 });
    expect(tags.year).toBe("2003");
    expect(tags.track).toBeUndefined();
  });
});
