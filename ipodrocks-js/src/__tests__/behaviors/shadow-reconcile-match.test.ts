/**
 * Behavior test — shadow reconcile match predicate.
 *
 * `audioMatchesCodecConfig` decides whether a file already sitting at a shadow
 * library's destination path is genuinely what that library would have encoded.
 * Getting it wrong is expensive in both directions: too loose and a 128 kbps
 * folder is silently adopted into a 320 kbps library; too strict and every
 * legitimately-encoded file is thrown away and re-encoded.
 *
 * Pure — no DB, no filesystem, no gate.
 */
import { describe, it, expect } from "vitest";

import {
  audioMatchesCodecConfig,
  canSkipProbe,
  BITRATE_TOLERANCE,
  DURATION_TOLERANCE_SEC,
  type CodecMatchTarget,
} from "../../main/library/shadow-reconcile";

/** Build a target; bitrate is kbps, matching codec_configurations.bitrate_value. */
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
    sourceDurationSec: null,
    ...extra,
  };
}

/** Probe result; bitrate is bps and duration seconds, per music-metadata. */
function info(codec: string, kbps: number, duration = 0) {
  return { codec, bitrate: kbps * 1000, duration };
}

describe("shadow reconcile — codec/encoding match", () => {
  // MP3 is the only codec in this pipeline that actually encodes at a constant
  // bitrate, so it is the only one whose measured bitrate is worth comparing.
  describe("MP3 bitrate window", () => {
    const cases: [name: string, kbps: number, expected: boolean][] = [
      ["exact", 320, true],
      ["-10% (inside)", 288, true],
      ["+10% (inside)", 352, true],
      ["-26% (outside)", 237, false],
      ["+16% (outside)", 371, false],
    ];

    for (const [name, kbps, expected] of cases) {
      it(`MP3 320 kbps target, measured ${kbps} kbps — ${name}`, () => {
        expect(audioMatchesCodecConfig(info("MP3", kbps), target("MP3", 320)).ok).toBe(
          expected
        );
      });
    }

    it("uses the documented ±15% tolerance", () => {
      expect(BITRATE_TOLERANCE).toBe(0.15);
    });

    it("reports the measured value and the accepted window when it fails", () => {
      const result = audioMatchesCodecConfig(info("MP3", 128), target("MP3", 320));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("128 kbps");
        expect(result.reason).toContain("272");
        expect(result.reason).toContain("368");
      }
    });
  });

  // ffmpeg's native AAC encoder and libopus treat -b:a as a target to aim for,
  // not a constraint. Measured output ranges from ~40% to ~85% of nominal
  // purely on how compressible the material is, which overlaps the range a
  // wrongly-configured folder would produce. Duration carries identity here.
  describe("quality-targeting codecs skip the bitrate check", () => {
    it("accepts AAC measured at 105 kbps against a 256 kbps target", () => {
      // Real figure: a pure tone encoded with `-c:a aac -b:a 256k`.
      expect(audioMatchesCodecConfig(info("AAC", 105), target("AAC", 256)).ok).toBe(true);
    });

    it("accepts Opus measured at 95 kbps against a 128 kbps target", () => {
      expect(audioMatchesCodecConfig(info("OPUS", 95), target("OPUS", 128)).ok).toBe(true);
    });

    it("accepts OGG well under its nominal target", () => {
      expect(audioMatchesCodecConfig(info("OGG", 120), target("OGG", 192)).ok).toBe(true);
    });
  });

  describe("duration identity check", () => {
    it("accepts a file matching the source length", () => {
      expect(
        audioMatchesCodecConfig(
          info("AAC", 256, 183.4),
          target("AAC", 256, { sourceDurationSec: 183.0 })
        ).ok
      ).toBe(true);
    });

    it("rejects a truncated file", () => {
      const result = audioMatchesCodecConfig(
        info("AAC", 256, 12.0),
        target("AAC", 256, { sourceDurationSec: 183.0 })
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("duration");
    });

    it("rejects a different recording at the same codec and bitrate", () => {
      expect(
        audioMatchesCodecConfig(
          info("MP3", 320, 240.0),
          target("MP3", 320, { sourceDurationSec: 183.0 })
        ).ok
      ).toBe(false);
    });

    it("applies to lossless too", () => {
      expect(
        audioMatchesCodecConfig(
          info("FLAC", 900, 12.0),
          target("FLAC", null, { sourceDurationSec: 183.0 })
        ).ok
      ).toBe(false);
    });

    it("tolerates sub-tolerance encoder padding", () => {
      expect(
        audioMatchesCodecConfig(
          info("MP3", 320, 183.0 + DURATION_TOLERANCE_SEC - 0.1),
          target("MP3", 320, { sourceDurationSec: 183.0 })
        ).ok
      ).toBe(true);
    });

    it("is skipped when the source duration is unknown", () => {
      expect(
        audioMatchesCodecConfig(
          info("MP3", 320, 240.0),
          target("MP3", 320, { sourceDurationSec: null })
        ).ok
      ).toBe(true);
    });

    it("is skipped when the file reports no duration", () => {
      expect(
        audioMatchesCodecConfig(
          info("MP3", 320, 0),
          target("MP3", 320, { sourceDurationSec: 183.0 })
        ).ok
      ).toBe(true);
    });
  });

  describe("codec identity", () => {
    it("rejects a different codec at the right bitrate", () => {
      expect(audioMatchesCodecConfig(info("MP3", 256), target("OPUS", 256)).ok).toBe(false);
    });

    it("is case-insensitive on both sides", () => {
      expect(audioMatchesCodecConfig(info("opus", 256), target("Opus", 256)).ok).toBe(true);
    });

    it("rejects a wrong codec even when the duration matches", () => {
      expect(
        audioMatchesCodecConfig(
          info("MP3", 320, 183.0),
          target("OPUS", 256, { sourceDurationSec: 183.0 })
        ).ok
      ).toBe(false);
    });

    // The reason probing exists at all: aac and alac both map to .m4a in
    // CODEC_EXT_MAP, so the destination path alone cannot distinguish them.
    it("rejects an AAC file against an ALAC target", () => {
      expect(audioMatchesCodecConfig(info("AAC", 256), target("ALAC", null)).ok).toBe(false);
    });

    it("accepts an ALAC file against an ALAC target", () => {
      expect(audioMatchesCodecConfig(info("ALAC", 900), target("ALAC", null)).ok).toBe(true);
    });

    it("rejects an unreadable file (probes as Unknown)", () => {
      expect(audioMatchesCodecConfig(info("Unknown", 0), target("MP3", 320)).ok).toBe(false);
    });
  });

  describe("lossless verifies codec only", () => {
    // buildFfmpegCommand passes no -sample_fmt, so output bit depth equals
    // source bit depth. A "FLAC 16" config fed 24-bit sources legitimately
    // produces 24-bit FLACs — rejecting those would reject most of a real
    // mixed library.
    it("accepts 24-bit FLAC against a 16-bit-labelled FLAC config", () => {
      expect(
        audioMatchesCodecConfig(info("FLAC", 2300), target("FLAC", null)).ok
      ).toBe(true);
    });

    it("ignores bitrate entirely for lossless", () => {
      expect(audioMatchesCodecConfig(info("FLAC", 400), target("FLAC", 1000)).ok).toBe(true);
    });
  });

  describe("relaxations", () => {
    it("skips the bitrate check when the library is VBR", () => {
      // Real VBR output routinely lands far from the nominal figure.
      expect(
        audioMatchesCodecConfig(info("MP3", 128), target("MP3", 320, { vbrEnabled: true })).ok
      ).toBe(true);
    });

    it("skips the bitrate check for quality-based configs (MPC Qn)", () => {
      expect(
        audioMatchesCodecConfig(info("MPC", 0), target("MPC", null, { qualityValue: 7 })).ok
      ).toBe(true);
    });
  });

  describe("guards", () => {
    it("refuses a DIRECT COPY target", () => {
      expect(audioMatchesCodecConfig(info("MP3", 320), target("DIRECT COPY", null)).ok).toBe(
        false
      );
    });

    it("refuses an Unknown target", () => {
      expect(audioMatchesCodecConfig(info("MP3", 320), target("Unknown", null)).ok).toBe(false);
    });

    it("rejects a CBR target when no bitrate could be read", () => {
      const result = audioMatchesCodecConfig(info("MP3", 0), target("MP3", 320));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("no readable bitrate");
    });
  });

  describe("canSkipProbe", () => {
    // MPC's probe is a synchronous whole-file readFileSync — it would block the
    // main process for the length of every file in the library.
    it("skips probing MPC", () => {
      expect(canSkipProbe(target("MPC", null))).toBe(true);
    });

    for (const codec of ["AAC", "ALAC", "MP3", "FLAC", "OPUS", "OGG"]) {
      it(`probes ${codec}`, () => {
        expect(canSkipProbe(target(codec, 256))).toBe(false);
      });
    }
  });
});
