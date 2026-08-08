/**
 * @vitest-environment node
 *
 * Behavior test — shadow reconcile match predicate, against real encoded audio.
 *
 * `shadow-reconcile-match.test.ts` covers the rules with synthetic numbers.
 * This one closes the loop that actually matters: encode through the *real*
 * `convertWithCodec` with the settings a shadow library would use, probe the
 * output with the *real* `MetadataExtractor`, and assert the predicate accepts
 * what we ourselves just produced.
 *
 * That is what validates two things no synthetic test can:
 *   1. the bps→kbps unit convention between music-metadata and
 *      codec_configurations.bitrate_value, and
 *   2. that the ±15% window is actually wide enough for real encoder output,
 *      including a file carrying a large embedded cover.
 *
 * No music-metadata mock here — that is the whole point. Gated on ffmpeg.
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
import { MetadataExtractor } from "../../main/library/metadata-extractor";
import {
  audioMatchesCodecConfig,
  type CodecMatchTarget,
} from "../../main/library/shadow-reconcile";

function ffmpegAvailable(): boolean {
  try {
    return spawnSync(getFfmpegPath(), ["-version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

/**
 * buildFfmpegCommand names specific encoders (`libvorbis`, `libopus`, …) and
 * not every ffmpeg build ships them. `-h encoder=` resolves aliases the way
 * `-c:a` does — `mp3` reports as libmp3lame — which listing `-encoders` does
 * not, since the list is keyed on encoder name rather than codec name.
 */
function hasEncoder(name: string): boolean {
  try {
    const r = spawnSync(getFfmpegPath(), ["-hide_banner", "-h", `encoder=${name}`], {
      encoding: "utf8",
    });
    return /^Encoder /m.test(r.stdout ?? "");
  } catch {
    return false;
  }
}

const canRun = ffmpegAvailable();

describe.skipIf(!canRun)("shadow reconcile — real encoded audio", () => {
  let workDir: string;
  let source: string;
  let sourceDurationSec: number;
  let extractor: MetadataExtractor;

  const SOURCE_SECONDS = 5;

  beforeAll(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-recon-"));
    extractor = new MetadataExtractor();

    // Pink noise, not a tone: a pure sine is so compressible that every
    // quality-targeting encoder undershoots wildly, which would make this test
    // measure the fixture rather than the encoder.
    source = path.join(workDir, "source.flac");
    const r = spawnSync(
      getFfmpegPath(),
      [
        "-y", "-f", "lavfi",
        "-i", `anoisesrc=d=${SOURCE_SECONDS}:c=pink:a=0.5`,
        "-c:a", "flac", source,
      ],
      { encoding: "utf8" }
    );
    if (r.status !== 0) throw new Error(`ffmpeg source generation failed: ${r.stderr}`);

    sourceDurationSec = (await extractor.extractAudioInfo(source)).duration;
    expect(sourceDurationSec).toBeGreaterThan(0);
  }, 60_000);

  afterAll(() => {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function target(
    codecName: string,
    bitrateKbps: number | null,
    extra: Partial<CodecMatchTarget> = {}
  ): CodecMatchTarget {
    return {
      codecName,
      bitrateKbps,
      qualityValue: null,
      vbrEnabled: false,
      sourceDurationSec,
      ...extra,
    };
  }

  /** Encode `source` the way a shadow library with this config would. */
  async function encode(
    name: string,
    ext: string,
    codec: string,
    bitrateKbps: number | null,
    src = source
  ): Promise<string> {
    const dest = path.join(workDir, `${name}${ext}`);
    const ok = await convertWithCodec(src, dest, {
      codec,
      transfer_mode: "convert",
      vbr: false,
      ...(bitrateKbps != null ? { bitrate: bitrateKbps } : {}),
    });
    expect(ok, `encode ${name} failed`).toBe(true);
    return dest;
  }

  // Encoder each codec needs, per buildFfmpegCommand's codecArgs.
  const matrix: [
    label: string, ext: string, codec: string, kbps: number | null, encoder: string
  ][] = [
    ["mp3-320", ".mp3", "mp3", 320, "mp3"],
    ["mp3-128", ".mp3", "mp3", 128, "mp3"],
    ["aac-256", ".m4a", "aac", 256, "aac"],
    ["opus-128", ".opus", "opus", 128, "libopus"],
    ["ogg-192", ".ogg", "ogg", 192, "libvorbis"],
    ["flac", ".flac", "flac", null, "flac"],
    ["alac", ".m4a", "alac", null, "alac"],
  ];

  for (const [label, ext, codec, kbps, encoder] of matrix) {
    it.skipIf(!hasEncoder(encoder))(`accepts its own ${label} output`, async () => {
      const dest = await encode(label, ext, codec, kbps);
      const info = await extractor.extractAudioInfo(dest);
      const result = audioMatchesCodecConfig(info, target(codec.toUpperCase(), kbps));

      expect(
        result.ok,
        `${label}: probed codec=${info.codec} bitrate=${info.bitrate} ` +
          `duration=${info.duration} — ${result.ok ? "" : result.reason}`
      ).toBe(true);
    }, 60_000);
  }

  // The .m4a ambiguity is the reason this pass probes at all: CODEC_EXT_MAP
  // maps both aac and alac to .m4a, so the destination path cannot tell them
  // apart and only the probe can.
  it("rejects AAC output against an ALAC target", async () => {
    const dest = await encode("ambiguity-aac", ".m4a", "aac", 256);
    const info = await extractor.extractAudioInfo(dest);
    expect(info.codec.toUpperCase()).toBe("AAC");
    expect(audioMatchesCodecConfig(info, target("ALAC", null)).ok).toBe(false);
  }, 60_000);

  it("rejects ALAC output against an AAC target", async () => {
    const dest = await encode("ambiguity-alac", ".m4a", "alac", null);
    const info = await extractor.extractAudioInfo(dest);
    expect(info.codec.toUpperCase()).toBe("ALAC");
    expect(audioMatchesCodecConfig(info, target("AAC", 256)).ok).toBe(false);
  }, 60_000);

  it("rejects a 128 kbps file against a 320 kbps target", async () => {
    const dest = await encode("underrate", ".mp3", "mp3", 128);
    const info = await extractor.extractAudioInfo(dest);
    expect(audioMatchesCodecConfig(info, target("MP3", 320)).ok).toBe(false);
  }, 60_000);

  // buildFfmpegCommand copies embedded artwork (-c:v copy). A large cover
  // inflates the *container* bitrate, so reading format.bit_rate rather than
  // the audio stream's would push a correct file outside the ±15% window.
  it("accepts CBR output that carries a large embedded cover", async () => {
    const cover = path.join(workDir, "cover.jpg");
    const gen = spawnSync(
      getFfmpegPath(),
      ["-y", "-f", "lavfi", "-i", "color=c=red:s=1400x1400", "-frames:v", "1", cover],
      { encoding: "utf8" }
    );
    expect(gen.status, gen.stderr).toBe(0);

    const withCover = path.join(workDir, "source-cover.mp3");
    const embed = spawnSync(
      getFfmpegPath(),
      [
        "-y", "-i", source, "-i", cover,
        "-map", "0:a", "-map", "1:v",
        "-c:a", "mp3", "-b:a", "128k", "-c:v", "copy",
        "-id3v2_version", "3",
        withCover,
      ],
      { encoding: "utf8" }
    );
    expect(embed.status, embed.stderr).toBe(0);

    const dest = await encode("cover-cbr", ".mp3", "mp3", 128, withCover);
    const info = await extractor.extractAudioInfo(dest);
    const result = audioMatchesCodecConfig(info, target("MP3", 128));

    expect(
      result.ok,
      `probed bitrate=${info.bitrate} bps — ${result.ok ? "" : result.reason}`
    ).toBe(true);
  }, 60_000);
});
