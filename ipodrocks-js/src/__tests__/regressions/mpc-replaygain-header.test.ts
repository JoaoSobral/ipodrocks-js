/**
 * Issue #137 — Musepack keeps ReplayGain in the stream header, and that is the
 * only place Rockbox reads it. These are format tests: the numbers are checked
 * against the SV8 spec's own worked examples and against the integer arithmetic
 * in Rockbox's `lib/rbcodec/metadata/mpc.c`, not against our own decoder.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  computeTargetRaws,
  decodeGain,
  decodePeak,
  encodeGain,
  encodePeak,
  headBufferNeedsReplayGain,
  locateSv8ReplayGainPacket,
  PEAK_FULL_SCALE_RAW,
  readMpcReplayGainHeader,
  readSv8ReplayGainRaw,
  writeMpcReplayGainHeader,
  ZERO_RAWS,
} from "../../main/tagging/mpc/replaygain-header";
import { buildSv8Mpc, writeSv8Mpc } from "../harness/sv8-mpc";
import { writeLegacyMpc } from "../harness/legacy-mpc";

/** The values the other ReplayGain specs in this repo use. */
const SOURCE = {
  trackGainDb: -3.38,
  trackPeak: 0.998054,
  albumGainDb: -2.32,
  albumPeak: 0.821448,
};

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpc-rg-header-"));
  file = path.join(dir, "track.mpc");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the Q8.8 codec", () => {
  it("matches Rockbox's own integer reduction of a gain", () => {
    const raw = encodeGain(-3.38);
    expect(raw).toBe(17459);
    // `gain = SV8_TO_SV7_CONVERT_GAIN - ((gain*100)/256)` in centi-dB, which is
    // the arithmetic that decides what the player actually applies. It
    // truncates, so it lands within a centi-dB of the value we encoded rather
    // than on it — inaudible, and not worth biasing the encoder to chase.
    expect(Math.abs(6482 - Math.trunc((raw * 100) / 256) - -338)).toBeLessThanOrEqual(1);
  });

  it("matches the spec's worked peak examples", () => {
    // "Peak for float (max 0.96) -> 20*log10(0.96 * 2^15) * 256 ~= 23029"
    expect(Math.abs(encodePeak(0.96) - 23029)).toBeLessThanOrEqual(1);
    // "Peak for 16-bit (max 68813) -> 20*log10(68813) * 256 ~= 24769"
    expect(Math.abs(encodePeak(68813 / 32768) - 24769)).toBeLessThanOrEqual(1);
    // Rockbox's SV8_TO_SV7_CONVERT_PEAK, i.e. full scale.
    expect(encodePeak(1.0)).toBe(PEAK_FULL_SCALE_RAW);
  });

  it("round-trips within a 256th of a dB and a tenth of a percent", () => {
    for (const db of [-12.5, -3.38, -0.01, 0, 2.75, 6]) {
      expect(Math.abs(decodeGain(encodeGain(db))! - db)).toBeLessThan(1 / 256);
    }
    for (const peak of [0.05, 0.821448, 0.998054, 1, 1.12]) {
      expect(Math.abs(decodePeak(encodePeak(peak))! - peak) / peak).toBeLessThan(0.001);
    }
  });

  it("never emits the zero sentinel for a value it holds, and reads it back as null", () => {
    // 0 means "not computed"; a real value encoding to it would read as absent.
    expect(encodeGain(64.82)).not.toBe(0);
    expect(encodePeak(1 / 32768)).not.toBe(0);
    expect(decodeGain(0)).toBeNull();
    expect(decodePeak(0)).toBeNull();
  });

  it("treats a missing or nonsensical value as 'not computed'", () => {
    expect(encodeGain(Number.NaN)).toBe(0);
    expect(encodePeak(0)).toBe(0);
    expect(encodePeak(-1)).toBe(0);
    expect(encodePeak(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("locating the RG packet", () => {
  it("finds the packet where mpcenc puts it", () => {
    const loc = locateSv8ReplayGainPacket(buildSv8Mpc());
    expect(loc).not.toBeNull();
    expect(loc!.start).toBe(18);
    expect(loc!.size).toBe(12);
    expect(loc!.payloadStart).toBe(21);
    expect(loc!.version).toBe(1);
    expect(loc!.rockboxVisible).toBe(true);
    expect(readSv8ReplayGainRaw(buildSv8Mpc(), loc!)).toEqual(ZERO_RAWS);
  });

  it("refuses a packet Rockbox would never look at", () => {
    // Rockbox jumps `SH_size - 2` from a read at offset 6: an RG packet behind
    // anything else is invisible to it, and nothing here may move one.
    expect(locateSv8ReplayGainPacket(buildSv8Mpc({ rgAfterEi: true }))).toBeNull();
    expect(locateSv8ReplayGainPacket(buildSv8Mpc({ rg: null }))).toBeNull();
    expect(locateSv8ReplayGainPacket(Buffer.alloc(6))).toBeNull();
    expect(locateSv8ReplayGainPacket(Buffer.from("MP+\x07 not sv8 at all", "ascii"))).toBeNull();
  });

  it("flags a packet outside Rockbox's 32-byte window without refusing it", () => {
    const loc = locateSv8ReplayGainPacket(buildSv8Mpc({ oversizedSh: true }));
    expect(loc).not.toBeNull();
    expect(loc!.rockboxVisible).toBe(false);
  });
});

describe("computeTargetRaws", () => {
  it("keeps a stored value it has no replacement for", () => {
    const existing = { trackGain: 100, trackPeak: 200, albumGain: 300, albumPeak: 400 };
    expect(computeTargetRaws(existing, {})).toEqual(existing);
  });

  it("assumes a full-scale peak for a gain that arrives without one", () => {
    // Rockbox skips a gain whose peak is 0, so a lone gain would do nothing.
    const target = computeTargetRaws(ZERO_RAWS, { trackGainDb: -3.38 });
    expect(target.trackGain).toBe(encodeGain(-3.38));
    expect(target.trackPeak).toBe(PEAK_FULL_SCALE_RAW);
    expect(target.albumGain).toBe(0);
    expect(target.albumPeak).toBe(0);
  });
});

describe("writing the header", () => {
  it("patches in place: same size, and nothing outside the packet moves", async () => {
    writeSv8Mpc(file, { ape: { Title: "Track" } });
    const before = fs.readFileSync(file);

    await expect(writeMpcReplayGainHeader(file, SOURCE)).resolves.toBe("written");

    const after = fs.readFileSync(file);
    expect(after.byteLength).toBe(before.byteLength);
    expect(after.subarray(0, 22)).toEqual(before.subarray(0, 22));
    expect(after.subarray(30)).toEqual(before.subarray(30));
    expect(after.subarray(22, 30)).not.toEqual(before.subarray(22, 30));
  });

  it("reads back what it wrote", async () => {
    writeSv8Mpc(file);
    await writeMpcReplayGainHeader(file, SOURCE);

    const raw = (await readMpcReplayGainHeader(file))!;
    expect(Math.abs(decodeGain(raw.trackGain)! - SOURCE.trackGainDb)).toBeLessThan(1 / 256);
    expect(Math.abs(decodeGain(raw.albumGain)! - SOURCE.albumGainDb)).toBeLessThan(1 / 256);
    expect(decodePeak(raw.trackPeak)!).toBeCloseTo(SOURCE.trackPeak, 3);
    expect(decodePeak(raw.albumPeak)!).toBeCloseTo(SOURCE.albumPeak, 3);
  });

  it("is idempotent: a second write changes nothing at all", async () => {
    writeSv8Mpc(file);
    await writeMpcReplayGainHeader(file, SOURCE);
    const after = fs.readFileSync(file);
    const mtime = fs.statSync(file).mtimeMs;

    await expect(writeMpcReplayGainHeader(file, SOURCE)).resolves.toBe("unchanged");
    expect(fs.readFileSync(file)).toEqual(after);
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
    expect(headBufferNeedsReplayGain(after, SOURCE)).toBe(false);
  });

  it("refuses, byte-for-byte, anything it may not patch", async () => {
    const cases: Array<[string, () => void]> = [
      ["SV7", () => writeLegacyMpc(file)],
      ["no RG packet", () => writeSv8Mpc(file, { rg: null })],
      ["RG behind EI", () => writeSv8Mpc(file, { rgAfterEi: true })],
      ["unknown RG version", () => writeSv8Mpc(file, { rgVersion: 2 })],
      ["truncated", () => fs.writeFileSync(file, Buffer.from("MPCKSH", "ascii"))],
    ];

    for (const [label, make] of cases) {
      make();
      const before = fs.readFileSync(file);
      await expect(writeMpcReplayGainHeader(file, SOURCE), label).resolves.toBe("unsupported");
      expect(fs.readFileSync(file), label).toEqual(before);
      expect(headBufferNeedsReplayGain(before, SOURCE), label).toBe(false);
    }
  });

  it("still writes a packet Rockbox cannot see, and says so", async () => {
    writeSv8Mpc(file, { oversizedSh: true });
    const lines: string[] = [];
    await expect(writeMpcReplayGainHeader(file, SOURCE, (l) => lines.push(l))).resolves.toBe(
      "written"
    );
    expect(lines.join("\n")).toMatch(/32-byte window/);
  });

  it("reports a missing file as a failure rather than throwing", async () => {
    await expect(
      writeMpcReplayGainHeader(path.join(dir, "gone.mpc"), SOURCE)
    ).resolves.toBe("failed");
    await expect(readMpcReplayGainHeader(path.join(dir, "gone.mpc"))).resolves.toBeNull();
  });
});
