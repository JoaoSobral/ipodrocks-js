/**
 * @vitest-environment node
 *
 * End-to-end regression for issue #121 (extended to AAC/ALAC): ffmpeg's own
 * MOV/MP4 muxer silently drops any metadata key it doesn't recognize as a
 * standard atom — confirmed by transcoding a tagged FLAC to AAC and finding
 * ReplayGain gone even with an explicit per-stream `-metadata` override.
 * `writeM4aReplayGainTags` fixes this by appending iTunes-style `----`
 * freeform atoms after the ffmpeg encode.
 *
 * Runs the REAL ffmpeg pipeline, then reads the tags back with ffmpeg's own
 * `-i` probe (which parses `----` atoms into its format-level Metadata dump)
 * as an independent oracle — the same pattern as
 * `mpc-transcode-tags.test.ts`. Skipped automatically when ffmpeg is missing.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";

import { installElectronMock } from "../harness/ipc-harness";

installElectronMock();

import { getFfmpegPath } from "../../main/utils/ffmpeg-path";
import { convertWithCodec } from "../../main/sync/sync-conversion";

function ffmpegAvailable(): boolean {
  try {
    const r = spawnSync(getFfmpegPath(), ["-version"], { encoding: "utf8" });
    return r.status === 0;
  } catch {
    return false;
  }
}

const canRun = ffmpegAvailable();

describe.skipIf(!canRun)("FLAC → AAC ReplayGain propagation", () => {
  let workDir: string;
  let srcFlac: string;
  let destM4a: string;

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "m4a-rg-"));
    srcFlac = path.join(workDir, "source.flac");
    destM4a = path.join(workDir, "out.m4a");

    const cmd = [
      "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-metadata", "title=Test Title",
      "-metadata", "artist=Test Artist",
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
  });

  afterAll(() => {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function probeTags(filePath: string): (name: string) => string | undefined {
    const probe = spawnSync(getFfmpegPath(), ["-i", filePath], { encoding: "utf8" });
    const out = `${probe.stdout}${probe.stderr}`;
    return (name: string) => {
      const m = out.match(new RegExp(`\\n\\s*${name}\\s*:\\s*(.+)`, "i"));
      return m ? m[1].trim() : undefined;
    };
  }

  it("carries source ReplayGain tags into AAC output that ffmpeg alone would drop", async () => {
    const ok = await convertWithCodec(srcFlac, destM4a, { codec: "aac", bitrate: 256 });
    expect(ok).toBe(true);
    expect(fs.existsSync(destM4a)).toBe(true);

    const tag = probeTags(destM4a);
    expect(tag("title")).toBe("Test Title");
    expect(tag("replaygain_track_gain")).toBe("-3.38 dB");
    expect(tag("replaygain_track_peak")).toBe("0.998054");
    expect(tag("replaygain_album_gain")).toBe("-2.32 dB");
    expect(tag("replaygain_album_peak")).toBe("0.821448");
  }, 30000);

  it("produces a playable file with no ReplayGain tags when the source has none", async () => {
    const plainFlac = path.join(workDir, "plain.flac");
    const plainM4a = path.join(workDir, "plain.m4a");
    const r = spawnSync(getFfmpegPath(), [
      "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", plainFlac,
    ]);
    expect(r.status).toBe(0);

    const ok = await convertWithCodec(plainFlac, plainM4a, { codec: "aac", bitrate: 256 });
    expect(ok).toBe(true);

    const tag = probeTags(plainM4a);
    expect(tag("replaygain_track_gain")).toBeUndefined();
  }, 30000);
});
