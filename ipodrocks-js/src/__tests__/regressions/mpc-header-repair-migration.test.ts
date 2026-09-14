/**
 * Issue #137 — the retroactive half: every `.mpc` iPodRocks has already
 * written carries its ReplayGain in the APEv2 tag and an all-zero `RG` packet,
 * so Rockbox applies nothing. Settings → Maintenance → Repair Musepack tags
 * moves the values into the header and drops the tag copy.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { needsApeRepair, repairMpcTags } from "../../main/tagging/mpc/repair";
import {
  decodeGain,
  decodePeak,
  readMpcReplayGainHeader,
} from "../../main/tagging/mpc/replaygain-header";
import { writeSv8Mpc } from "../harness/sv8-mpc";
import { writeLegacyMpc } from "../harness/legacy-mpc";

const TAGS = {
  REPLAYGAIN_TRACK_GAIN: "-3.38 dB",
  REPLAYGAIN_TRACK_PEAK: "0.998054",
  REPLAYGAIN_ALBUM_GAIN: "-2.32 dB",
  REPLAYGAIN_ALBUM_PEAK: "0.821448",
};

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpc-header-migration-"));
  file = path.join(dir, "track.mpc");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function hasItem(key: string): boolean {
  return fs.readFileSync(file).includes(Buffer.from(`${key}\0`, "ascii"));
}

async function expectHeader(expected: {
  trackGainDb: number;
  trackPeak: number;
  albumGainDb: number;
  albumPeak: number;
}): Promise<void> {
  const raw = (await readMpcReplayGainHeader(file))!;
  expect(raw).not.toBeNull();
  expect(decodeGain(raw.trackGain)!).toBeCloseTo(expected.trackGainDb, 2);
  expect(decodePeak(raw.trackPeak)!).toBeCloseTo(expected.trackPeak, 3);
  expect(decodeGain(raw.albumGain)!).toBeCloseTo(expected.albumGainDb, 2);
  expect(decodePeak(raw.albumPeak)!).toBeCloseTo(expected.albumPeak, 3);
}

describe("migrating tag ReplayGain into the SV8 header", () => {
  it("moves all four values and removes the tag copy", async () => {
    writeSv8Mpc(file, { ape: { Title: "Track", ...TAGS } });
    const before = fs.statSync(file);

    // Nothing here is wrong about the *tag* — the header is what is empty.
    expect(await needsApeRepair(file)).toBe(true);
    expect(await repairMpcTags(file)).toBe("repaired");

    await expectHeader({
      trackGainDb: -3.38,
      trackPeak: 0.998054,
      albumGainDb: -2.32,
      albumPeak: 0.821448,
    });
    for (const key of Object.keys(TAGS)) expect(hasItem(key)).toBe(false);
    expect(hasItem("Title")).toBe(true);
    expect(fs.statSync(file).size).toBeLessThan(before.size);
    expect(Math.floor(fs.statSync(file).mtimeMs)).toBe(Math.floor(before.mtimeMs));
  });

  it("is idempotent", async () => {
    writeSv8Mpc(file, { ape: { Title: "Track", ...TAGS } });
    await repairMpcTags(file);
    const after = fs.readFileSync(file);

    expect(await needsApeRepair(file)).toBe(false);
    expect(await repairMpcTags(file)).toBe("ok");
    expect(fs.readFileSync(file)).toEqual(after);
  });

  it("strips the cover and fills the header in one pass, under one mtime restore", async () => {
    writeSv8Mpc(file, { ape: { Title: "Track", ...TAGS }, cover: true });
    const before = fs.statSync(file);

    expect(await repairMpcTags(file)).toBe("repaired");

    expect(hasItem("Cover Art (Front)")).toBe(false);
    expect(hasItem("REPLAYGAIN_TRACK_GAIN")).toBe(false);
    await expectHeader({
      trackGainDb: -3.38,
      trackPeak: 0.998054,
      albumGainDb: -2.32,
      albumPeak: 0.821448,
    });
    expect(fs.statSync(file).size).toBeLessThan(before.size);
    expect(Math.floor(fs.statSync(file).mtimeMs)).toBe(Math.floor(before.mtimeMs));
  });

  it("fills the header from the source for a file whose tag never had any", async () => {
    // The tag block has no cover and nothing to remove, so it is never
    // rewritten — which is also why the "must not grow" rule cannot bite here.
    writeSv8Mpc(file, { ape: { Title: "Track" } });
    const before = fs.readFileSync(file);

    expect(await needsApeRepair(file, TAGS)).toBe(true);
    expect(await repairMpcTags(file, TAGS)).toBe("repaired");

    await expectHeader({
      trackGainDb: -3.38,
      trackPeak: 0.998054,
      albumGainDb: -2.32,
      albumPeak: 0.821448,
    });
    const after = fs.readFileSync(file);
    expect(after.byteLength).toBe(before.byteLength);
    expect(after.subarray(30)).toEqual(before.subarray(30));
    expect(hasItem("REPLAYGAIN_TRACK_GAIN")).toBe(false);
  });

  it("lets the file's own values win over the source's, field by field", async () => {
    writeSv8Mpc(file, {
      ape: { REPLAYGAIN_TRACK_GAIN: "-3.38 dB", REPLAYGAIN_TRACK_PEAK: "0.998054" },
    });

    await repairMpcTags(file, {
      REPLAYGAIN_TRACK_GAIN: "-9.99 dB",
      REPLAYGAIN_TRACK_PEAK: "0.5",
      REPLAYGAIN_ALBUM_GAIN: "-2.32 dB",
      REPLAYGAIN_ALBUM_PEAK: "0.821448",
    });

    // The file's own pair was measured for these exact bytes; the album pair it
    // never had can still come from the source track.
    await expectHeader({
      trackGainDb: -3.38,
      trackPeak: 0.998054,
      albumGainDb: -2.32,
      albumPeak: 0.821448,
    });
  });

  it("resolves the source lazily, so a file that needs nothing never asks", async () => {
    writeSv8Mpc(file, { ape: { Title: "Track", ...TAGS } });
    await repairMpcTags(file);

    let asked = 0;
    const source = () => {
      asked++;
      return TAGS;
    };
    expect(await needsApeRepair(file, source)).toBe(false);
    expect(asked).toBe(1); // consulted once per file, never per item
  });

  it("keeps an SV7 file's ReplayGain in its tag, and still restores what it lacks", async () => {
    // "MP+" has no RG packet and a different layout entirely, so there is
    // nowhere to move the values to. Those files keep the pre-#137 behaviour
    // whole: the strip is never authorized, and a value the source has that the
    // file lacks still goes into the tag.
    writeLegacyMpc(file);

    expect(await repairMpcTags(file, TAGS)).toBe("repaired");
    expect(await readMpcReplayGainHeader(file)).toBeNull();
    for (const key of Object.keys(TAGS)) expect(hasItem(key)).toBe(true);

    const after = fs.readFileSync(file);
    expect(await needsApeRepair(file, TAGS)).toBe(false);
    expect(await repairMpcTags(file, TAGS)).toBe("ok");
    expect(fs.readFileSync(file)).toEqual(after);
  });
});
