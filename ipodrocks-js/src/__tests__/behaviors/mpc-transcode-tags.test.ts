/**
 * @vitest-environment node
 *
 * End-to-end regression for issue #91: transcoding to Musepack must preserve
 * the source file's tags (Album Artist, Year, Original Year, Disc, ...), even
 * when no explicit ConversionMetadata is supplied (the device-sync path).
 *
 * Runs the REAL ffmpeg + mpcenc + APEv2 write pipeline, then reads the tags
 * back with ffmpeg. Skipped automatically when either encoder is missing on the
 * host.
 *
 * Note: tags are verified with ffmpeg rather than music-metadata because
 * music-metadata (the library iPodRocks uses elsewhere) has a pre-existing bug
 * parsing APEv2 tags on SV8 Musepack files; ffmpeg reads them correctly.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";

import { installElectronMock } from "../harness/ipc-harness";

installElectronMock();

import { isMpcencAvailable } from "../../main/utils/mpcenc";
import { getFfmpegPath } from "../../main/utils/ffmpeg-path";
import { convertWithCodec } from "../../main/sync/sync-conversion";
import { MetadataExtractor } from "../../main/library/metadata-extractor";
import { readApeTags, parseApeItems } from "../../main/tagging/reader";
import { locateApeBlock } from "../../main/tagging/apev2/locate";
import {
  ITEM_TYPE_BINARY,
  itemTypeFromFlags,
} from "../../main/tagging/apev2/constants";

function ffmpegAvailable(): boolean {
  try {
    const r = spawnSync(getFfmpegPath(), ["-version"], { encoding: "utf8" });
    return r.status === 0;
  } catch {
    return false;
  }
}

const canRun = ffmpegAvailable() && isMpcencAvailable();

describe.skipIf(!canRun)("FLAC → Musepack tag preservation", () => {
  let workDir: string;
  let srcFlac: string;
  let destMpc: string;

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpc-tags-"));
    srcFlac = path.join(workDir, "source.flac");
    destMpc = path.join(workDir, "out.mpc");

    // Generate a 1s tagged FLAC using ffmpeg's sine source.
    const cmd = [
      "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-metadata", "title=Test Title",
      "-metadata", "artist=Test Artist",
      "-metadata", "album=Test Album",
      "-metadata", "album_artist=Various Artists",
      "-metadata", "date=2003",
      "-metadata", "originalyear=1999",
      "-metadata", "disc=2",
      "-metadata", "track=4",
      "-metadata", "REPLAYGAIN_TRACK_GAIN=-3.38 dB",
      "-metadata", "REPLAYGAIN_TRACK_PEAK=0.998054",
      "-metadata", "REPLAYGAIN_ALBUM_GAIN=-2.32 dB",
      "-metadata", "REPLAYGAIN_ALBUM_PEAK=0.821448",
      srcFlac,
    ];
    const r = spawnSync(getFfmpegPath(), cmd, { encoding: "utf8" });
    if (r.status !== 0) {
      throw new Error(`ffmpeg fixture generation failed: ${r.stderr}`);
    }

    // Issue #125: without a picture the write path never emits a *binary* APEv2
    // item, which is exactly why the malformed cover art shipped untested. A
    // real folder cover here makes `writeMpcMetadata` take that branch, and a
    // JPEG is guaranteed to carry the NUL bytes that made the mis-flagged item
    // read as thousands of empty text values.
    const cover = spawnSync(
      getFfmpegPath(),
      ["-y", "-f", "lavfi", "-i", "color=c=red:s=64x64:d=1", "-frames:v", "1",
       path.join(workDir, "cover.jpg")],
      { encoding: "utf8" }
    );
    if (cover.status !== 0) {
      throw new Error(`ffmpeg cover generation failed: ${cover.stderr}`);
    }
  });

  afterAll(() => {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("carries source tags into the MPC output with no explicit metadata", async () => {
    const ok = await convertWithCodec(srcFlac, destMpc, { codec: "mpc", quality: 5 });
    expect(ok).toBe(true);
    expect(fs.existsSync(destMpc)).toBe(true);

    // ffmpeg prints format tags to stderr; read them back as the oracle.
    const probe = spawnSync(getFfmpegPath(), ["-i", destMpc], { encoding: "utf8" });
    const out = `${probe.stdout}${probe.stderr}`;
    const tag = (name: string): string | undefined => {
      const m = out.match(new RegExp(`\\n\\s*${name}\\s*:\\s*(.+)`, "i"));
      return m ? m[1].trim() : undefined;
    };

    // ffmpeg echoes the APEv2 key names as written. Album artist and disc use
    // the MP3tag-recognized tokens ALBUMARTIST / DISCNUMBER.
    expect(tag("Artist")).toBe("Test Artist");
    expect(tag("Album")).toBe("Test Album");
    expect(tag("ALBUMARTIST")).toBe("Various Artists");
    expect(tag("Year")).toBe("2003");
    expect(tag("Originalyear")).toBe("1999");
    expect(tag("Track")).toBe("4");
    expect(tag("DISCNUMBER")).toBe("2");
    expect(tag("REPLAYGAIN_TRACK_GAIN")).toBe("-3.38 dB");
    expect(tag("REPLAYGAIN_TRACK_PEAK")).toBe("0.998054");
    expect(tag("REPLAYGAIN_ALBUM_GAIN")).toBe("-2.32 dB");
    expect(tag("REPLAYGAIN_ALBUM_PEAK")).toBe("0.821448");
  }, 30000);

  it("embeds the folder cover as a binary item that does not swallow ReplayGain", async () => {
    const ok = await convertWithCodec(srcFlac, destMpc, { codec: "mpc", quality: 5 });
    expect(ok).toBe(true);

    const full = fs.readFileSync(destMpc);
    const loc = locateApeBlock(full);
    expect(loc).not.toBeNull();
    const items = parseApeItems(full, loc!);

    const coverIndex = items.findIndex(
      (i) => i.key.toLowerCase() === "cover art (front)"
    );
    expect(coverIndex).toBeGreaterThanOrEqual(0);

    // The defect: type bits saying "text" for a JPEG. Bit 0 is read-only and is
    // not part of the type, so the whole word must be exactly 2.
    expect(itemTypeFromFlags(items[coverIndex].flags)).toBe(ITEM_TYPE_BINARY);
    expect(items[coverIndex].flags).toBe(2);

    // ...and every ReplayGain item sits ahead of the artwork, so a reader with
    // a bounded tag buffer reaches them regardless.
    const rgIndexes = items
      .map((item, i) => (item.key.toLowerCase().startsWith("replaygain_") ? i : -1))
      .filter((i) => i >= 0);
    expect(rgIndexes).toHaveLength(4);
    for (const i of rgIndexes) expect(i).toBeLessThan(coverIndex);

    // The image itself round-trips intact.
    const tags = readApeTags(destMpc);
    expect(tags.coverArt?.mimeType).toBe("image/jpeg");
    expect(tags.coverArt?.data.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));

    // Independent oracle: ffmpeg still reports the ReplayGain tags on a file
    // that now carries several KB of artwork ahead of nothing.
    const probe = spawnSync(getFfmpegPath(), ["-i", destMpc], { encoding: "utf8" });
    const out = `${probe.stdout}${probe.stderr}`;
    expect(out).toContain("REPLAYGAIN_TRACK_GAIN");
    expect(out).toContain("REPLAYGAIN_ALBUM_PEAK");
  }, 30000);

  it("scans the generated MPC back through the real MetadataExtractor", async () => {
    // This is the exact library-scanner seam that regressed under the
    // music-metadata SV8+APEv2 bug: unmocked, parseFile throws and the file
    // used to degrade to filename/"Unknown Artist"/zero-duration. With the
    // built-in APEv2 reader + tag-stripped parseBuffer fallback it recovers.
    const ok = await convertWithCodec(srcFlac, destMpc, { codec: "mpc", quality: 5 });
    expect(ok).toBe(true);

    const extractor = new MetadataExtractor();
    const meta = await extractor.extractMetadata(destMpc, "music");
    expect(meta.title).toBe("Test Title");
    expect(meta.artist).toBe("Test Artist");
    expect(meta.album).toBe("Test Album");
    expect(meta.trackNumber).toBe("4");
    expect(meta.discNumber).toBe("2");

    const info = await extractor.extractAudioInfo(destMpc);
    expect(info.duration).toBeGreaterThan(0);
    expect(info.codec).toBe("MPC");
  }, 30000);
});
