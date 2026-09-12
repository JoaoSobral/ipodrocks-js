/**
 * @vitest-environment node
 *
 * Regression — issue #130: ReplayGain went missing from shadow-library `.mpc`
 * files, and the artwork came out at the source's original resolution.
 *
 * `readSourceApeTags()` is the only producer of ReplayGain anywhere in the app.
 * It used to end in a bare `catch { return {}; }`, which is indistinguishable
 * from "this file has no tags" — so a source that failed to parse produced a
 * transcode carrying only the six fields the library database passes in
 * (title/artist/album/genre/track/disc), with no year, no album artist, no
 * ReplayGain, and no cover, which is what made it fall through to embedding the
 * folder art full-size.
 *
 * These tests use real ffmpeg-generated files, because the whole point is what
 * happens when the parser and the real file disagree.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const parseFileMock = vi.fn();
vi.mock("music-metadata", () => ({
  parseFile: (...args: unknown[]) => parseFileMock(...args),
}));

import {
  extractReplayGainTags,
  readReplayGainFromFile,
  readSourceApeTags,
} from "../../main/sync/sync-conversion";

const RG = {
  REPLAYGAIN_TRACK_GAIN: "-3.38 dB",
  REPLAYGAIN_TRACK_PEAK: "0.998054",
  REPLAYGAIN_ALBUM_GAIN: "-2.32 dB",
  REPLAYGAIN_ALBUM_PEAK: "0.821448",
};

function ffmpegAvailable(): boolean {
  return spawnSync("ffmpeg", ["-version"], { encoding: "utf8" }).status === 0;
}

const canRun = ffmpegAvailable();
const itFf = it.skipIf(!canRun);

let workDir: string;
let srcFlac: string;

beforeAll(() => {
  if (!canRun) return;
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-rg-source-"));
  srcFlac = path.join(workDir, "source.flac");
  const args = [
    "-v", "quiet", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-c:a", "flac",
    "-metadata", "title=Source Title",
    "-metadata", "artist=Source Artist",
    "-metadata", "album=Source Album",
    "-metadata", "album_artist=Source AlbumArtist",
    "-metadata", "date=2001",
  ];
  for (const [k, v] of Object.entries(RG)) args.push("-metadata", `${k}=${v}`);
  args.push(srcFlac);
  const r = spawnSync("ffmpeg", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`fixture generation failed: ${r.stderr}`);
});

afterAll(() => {
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

describe("readSourceApeTags — a source that fails to parse (#130)", () => {
  itFf("falls back to an external probe instead of silently returning no tags", async () => {
    parseFileMock.mockRejectedValueOnce(new Error("unexpected end of stream"));

    const tags = await readSourceApeTags(srcFlac);

    // The fields that used to vanish are the ones the DB does not carry.
    expect(tags.albumArtist).toBe("Source AlbumArtist");
    expect(tags.year).toBe("2001");
    expect(tags.extra).toEqual(RG);
  });

  itFf("says so rather than failing quietly", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    parseFileMock.mockRejectedValueOnce(new Error("boom"));

    await readSourceApeTags(srcFlac);

    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toMatch(/could not read source tags/i);
    warn.mockRestore();
  });
});

describe("readSourceApeTags — a parse that succeeds but maps no ReplayGain", () => {
  itFf("tops the values up from an external probe", async () => {
    // Exactly what music-metadata returns for a container/spelling its tag
    // tables do not list: everything else present, ReplayGain absent.
    parseFileMock.mockResolvedValueOnce({
      common: { title: "Source Title", artist: "Source Artist" },
      format: {},
    });

    const tags = await readSourceApeTags(srcFlac);

    expect(tags.title).toBe("Source Title");
    expect(tags.extra).toEqual(RG);
  });

  itFf("leaves a source that genuinely has none alone", async () => {
    const bare = path.join(workDir, "bare.flac");
    const r = spawnSync(
      "ffmpeg",
      ["-v", "quiet", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "flac", bare],
      { encoding: "utf8" }
    );
    expect(r.status).toBe(0);

    parseFileMock.mockResolvedValueOnce({ common: { title: "Bare" }, format: {} });

    const tags = await readSourceApeTags(bare);
    expect(tags.extra).toBeUndefined();
  });
});

describe("readSourceApeTags — artwork is never embedded any more (#130)", () => {
  itFf("ignores a picture on the source", async () => {
    // A 1500x1500 cover is what the reporter had inside every transcode.
    parseFileMock.mockResolvedValueOnce({
      common: {
        title: "Has Art",
        picture: [{ format: "image/jpeg", data: Buffer.alloc(4096, 0x7f) }],
      },
      format: {},
    });

    const tags = await readSourceApeTags(srcFlac);

    expect(tags.title).toBe("Has Art");
    expect(tags.coverArt).toBeUndefined();
  });
});

describe("readReplayGainFromFile", () => {
  itFf("matches the tag names case-insensitively and normalizes to upper case", () => {
    expect(readReplayGainFromFile(srcFlac)).toEqual(RG);
  });

  itFf("still works when ffprobe is not installed", () => {
    // ffprobe is whatever the user happens to have; ffmpeg is what this app
    // ships. Reading a tag the transcode depends on cannot hinge on the former,
    // so the scrape of `ffmpeg -i` has to produce the same four values.
    const path0 = process.env.PATH;
    // A PATH with nothing on it: `ffprobe` cannot resolve, the bundled ffmpeg
    // is invoked by absolute path and still can.
    process.env.PATH = "/nonexistent-for-this-test";
    try {
      expect(readReplayGainFromFile(srcFlac)).toEqual(RG);
    } finally {
      process.env.PATH = path0;
    }
  });

  it("returns undefined rather than throwing for a file that is not there", () => {
    expect(readReplayGainFromFile("/nope/missing.flac")).toBeUndefined();
  });
});

describe("extractReplayGainTags", () => {
  it("reads music-metadata's parsed shape", () => {
    expect(
      extractReplayGainTags({
        replaygain_track_gain: { dB: -3.38 },
        replaygain_album_peak: { ratio: 0.821448 },
      })
    ).toEqual({
      REPLAYGAIN_TRACK_GAIN: "-3.38 dB",
      REPLAYGAIN_ALBUM_PEAK: "0.821448",
    });
  });

  it("drops a value that did not parse to a number", () => {
    // music-metadata's toRatio() splits on a space, so "-3.38dB" yields
    // { dB: null }. Writing that produced the literal string "null dB"; now it
    // is skipped so the ffprobe top-up can supply the real value instead.
    expect(
      extractReplayGainTags({
        replaygain_track_gain: { dB: null as unknown as number },
      })
    ).toBeUndefined();
  });

  it("returns undefined when there is nothing at all", () => {
    expect(extractReplayGainTags({})).toBeUndefined();
  });
});
