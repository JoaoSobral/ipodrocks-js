/**
 * @vitest-environment node
 *
 * Behavior test — embedded cover art survives a music-metadata parse failure.
 *
 * music-metadata (11.x) cannot read Ogg/Opus files whose cover art is large
 * enough to span multiple Ogg pages: it fails to reassemble the split Vorbis
 * comment and throws "Offset is outside the bounds of the DataView" or "The
 * string to be decoded is not correctly encoded". The files are perfectly
 * valid — ffmpeg reads them fine — but `extractEmbeddedPicture` used to return
 * null, so those albums silently lost their embedded artwork on sync.
 *
 * This drives the contract that fixes it: when the parser throws, fall back to
 * ffmpeg. `parseFile` is mocked to raise the exact errors seen in the wild,
 * while the audio file and its attached picture are real, so the ffmpeg
 * recovery path is genuinely exercised.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";

import { installElectronMock } from "../harness/ipc-harness";

installElectronMock();

/** Set per-test to make parseFile throw, or left null to let it behave. */
let parseFileError: Error | null = null;
/** What a "successful" parse reports, when parseFileError is null. */
let parseFileResult: unknown = { common: { picture: undefined }, format: {} };
const parseFileCalls: string[] = [];

vi.mock("music-metadata", () => ({
  parseFile: vi.fn(async (filePath: string) => {
    parseFileCalls.push(filePath);
    if (parseFileError) throw parseFileError;
    return parseFileResult;
  }),
}));

import { getFfmpegPath } from "../../main/utils/ffmpeg-path";
import { extractEmbeddedPicture } from "../../main/utils/embedded-art";

function ffmpegAvailable(): boolean {
  try {
    return spawnSync(getFfmpegPath(), ["-version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

const canRun = ffmpegAvailable();

describe.skipIf(!canRun)("embedded art — ffmpeg fallback", () => {
  let workDir: string;
  let withPng: string;
  let withJpeg: string;
  let noArt: string;
  let coverBytes: number;

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "embedded-art-"));
    const ff = getFfmpegPath();

    const run = (args: string[], label: string): void => {
      const r = spawnSync(ff, args, { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`ffmpeg ${label} failed: ${r.stderr}`);
    };

    // Random pixels so the PNG stays large — a flat colour would compress to a
    // few hundred bytes and not resemble real cover art. Generated with
    // ffmpeg's own lavfi noise source (geq + random()) rather than reading
    // /dev/urandom, which doesn't exist on Windows CI runners.
    const cover = path.join(workDir, "cover.png");
    run(
      ["-y", "-v", "error", "-f", "lavfi",
       "-i", "color=c=black:s=400x400,geq=random(1)*255:random(2)*255:random(3)*255",
       "-frames:v", "1", cover],
      "cover"
    );
    coverBytes = fs.statSync(cover).size;
    expect(coverBytes).toBeGreaterThan(50_000);

    const jpegCover = path.join(workDir, "cover.jpg");
    run(["-y", "-v", "error", "-i", cover, jpegCover], "jpeg cover");

    const src = path.join(workDir, "src.flac");
    run(
      ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
       "-c:a", "flac", src],
      "source"
    );

    withPng = path.join(workDir, "with-png.mp3");
    run(
      ["-y", "-v", "error", "-i", src, "-i", cover, "-map", "0:a", "-map", "1:v",
       "-c:a", "mp3", "-b:a", "128k", "-c:v", "copy", "-id3v2_version", "3", withPng],
      "with-png"
    );

    withJpeg = path.join(workDir, "with-jpeg.mp3");
    run(
      ["-y", "-v", "error", "-i", src, "-i", jpegCover, "-map", "0:a", "-map", "1:v",
       "-c:a", "mp3", "-b:a", "128k", "-c:v", "copy", "-id3v2_version", "3", withJpeg],
      "with-jpeg"
    );

    noArt = path.join(workDir, "no-art.mp3");
    run(["-y", "-v", "error", "-i", src, "-c:a", "mp3", "-b:a", "128k", noArt], "no-art");
  }, 120_000);

  afterAll(() => {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  beforeEach(() => {
    parseFileError = null;
    parseFileResult = { common: { picture: undefined }, format: {} };
    parseFileCalls.length = 0;
  });

  // The two errors observed in the wild on real .opus libraries.
  for (const message of [
    "Offset is outside the bounds of the DataView",
    "The string to be decoded is not correctly encoded.",
  ]) {
    it(`recovers a PNG cover when the parser throws "${message}"`, async () => {
      parseFileError = new Error(message);

      const picture = await extractEmbeddedPicture(withPng);

      expect(picture).not.toBeNull();
      expect(picture?.format).toBe("image/png");
      expect(picture?.data.length).toBe(coverBytes);
    }, 30_000);
  }

  it("recovers a JPEG cover and reports the right MIME type", async () => {
    parseFileError = new Error("Offset is outside the bounds of the DataView");

    const picture = await extractEmbeddedPicture(withJpeg);

    expect(picture?.format).toBe("image/jpeg");
    expect(picture?.data.length).toBeGreaterThan(0);
  }, 30_000);

  it("returns null when the parser throws and there is no art to recover", async () => {
    parseFileError = new Error("Offset is outside the bounds of the DataView");

    expect(await extractEmbeddedPicture(noArt)).toBeNull();
  }, 30_000);

  // Spawning ffmpeg for every art-less track would cost a subprocess per album
  // on a full sync, so a *successful* parse reporting no picture is trusted.
  it("does not fall back when the parser succeeds with no picture", async () => {
    parseFileError = null;
    parseFileResult = { common: { picture: undefined }, format: {} };

    const started = Date.now();
    expect(await extractEmbeddedPicture(withPng)).toBeNull();

    expect(parseFileCalls).toEqual([withPng]);
    // An ffmpeg spawn could not complete this fast.
    expect(Date.now() - started).toBeLessThan(150);
  });

  it("uses the parser's picture when it parses successfully", async () => {
    parseFileError = null;
    parseFileResult = {
      common: { picture: [{ data: new Uint8Array([1, 2, 3]), format: "image/gif" }] },
      format: {},
    };

    const picture = await extractEmbeddedPicture(withPng);

    expect(picture?.format).toBe("image/gif");
    expect(picture?.data.length).toBe(3);
  });
});
