/**
 * @vitest-environment node
 *
 * Regression — issue #130, the repair half.
 *
 * Settings → Maintenance now has more to fix than the #125 flags bug: artwork
 * is no longer embedded at all, and a file transcoded while ReplayGain was
 * being dropped has to get it back. Both happen in the trailing tag block, so
 * neither re-encodes anything.
 *
 * The invariant that changed: the block used to be guaranteed the same size,
 * and the pass refused to write when it was not. Removing a cover makes it
 * smaller on purpose, so the guard is now "must not grow" — and the file has to
 * be truncated, with anything after the block (an ID3v1 tag) moved down.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { itemsNeedRepair, needsApeRepair, repairMpcTags } from "../../main/tagging/mpc/repair";
import { readApeTags, parseApeItems } from "../../main/tagging/reader";
import { locateApeBlock } from "../../main/tagging/apev2/locate";
import { writeLegacyMpc, AUDIO, COVER } from "../harness/legacy-mpc";

let workDir: string;
let file: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-mpc-repair-"));
  file = path.join(workDir, "track.mpc");
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function items(p: string) {
  const buf = fs.readFileSync(p);
  const loc = locateApeBlock(buf);
  if (!loc) throw new Error("no APE block");
  return parseApeItems(buf, loc);
}

describe("the repair strips embedded artwork", () => {
  it("removes the cover and shrinks the file, leaving the audio untouched", async () => {
    writeLegacyMpc(file);
    const before = fs.statSync(file);
    expect(readApeTags(file).coverArt).toBeDefined();

    expect(await repairMpcTags(file)).toBe("repaired");

    const after = fs.readFileSync(file);
    expect(readApeTags(file).coverArt).toBeUndefined();
    expect(after.includes(COVER)).toBe(false);
    expect(after.subarray(0, AUDIO.byteLength).equals(AUDIO)).toBe(true);
    expect(fs.statSync(file).size).toBeLessThan(before.size);
  });

  it("leaves the file no longer than it was — the tag is the last thing in it", async () => {
    writeLegacyMpc(file);
    const before = fs.statSync(file).size;
    await repairMpcTags(file, {
      REPLAYGAIN_TRACK_PEAK: "0.9",
      REPLAYGAIN_ALBUM_PEAK: "0.8",
    });
    expect(fs.statSync(file).size).toBeLessThanOrEqual(before);
  });

  it("keeps every other tag, and the ReplayGain that was already there", async () => {
    writeLegacyMpc(file);
    await repairMpcTags(file);

    const tags = readApeTags(file);
    expect(tags.title).toBe("Legacy Track");
    expect(tags.extra?.REPLAYGAIN_TRACK_GAIN).toBe("-3.38 dB");
    expect(tags.extra?.REPLAYGAIN_ALBUM_GAIN).toBe("-4.10 dB");
  });

  it("preserves the mtime, so nothing re-transcodes behind it", async () => {
    writeLegacyMpc(file);
    const before = fs.statSync(file);

    await repairMpcTags(file);

    // Whole milliseconds: that is what `shadow_tracks.mtime` stores and
    // compares, via Math.floor(mtimeMs).
    expect(Math.floor(fs.statSync(file).mtimeMs)).toBe(Math.floor(before.mtimeMs));
  });

  it("is idempotent", async () => {
    writeLegacyMpc(file);
    expect(await repairMpcTags(file)).toBe("repaired");
    const settled = fs.readFileSync(file);
    expect(await repairMpcTags(file)).toBe("ok");
    expect(fs.readFileSync(file).equals(settled)).toBe(true);
  });
});

describe("the repair restores ReplayGain the transcode lost", () => {
  it("adds only the values the file is missing", async () => {
    writeLegacyMpc(file); // already carries TRACK_GAIN and ALBUM_GAIN
    expect(
      await repairMpcTags(file, {
        REPLAYGAIN_TRACK_GAIN: "-99.0 dB", // present already — must not win
        REPLAYGAIN_TRACK_PEAK: "0.998054", // missing — must be added
      })
    ).toBe("repaired");

    const tags = readApeTags(file);
    expect(tags.extra?.REPLAYGAIN_TRACK_GAIN).toBe("-3.38 dB");
    expect(tags.extra?.REPLAYGAIN_TRACK_PEAK).toBe("0.998054");
  });

  it("matches what is already present case-insensitively", () => {
    const present = [
      { key: "replaygain_track_gain", type: "utf8" as const, value: Buffer.from("-1 dB"), flags: 0 },
    ];
    expect(itemsNeedRepair(present, { REPLAYGAIN_TRACK_GAIN: "-2 dB" })).toBe(false);
  });

  it("does nothing when there is no source to read from", async () => {
    // A file with no artwork and no missing values: the pass must not rewrite
    // it just because it was asked to look.
    writeLegacyMpc(file);
    await repairMpcTags(file);
    expect(await needsApeRepair(file)).toBe(false);
    expect(await needsApeRepair(file, undefined)).toBe(false);
  });
});

describe("an ID3v1 tag after the APE block", () => {
  it("moves down with the block instead of being orphaned", async () => {
    writeLegacyMpc(file);
    const id3 = Buffer.alloc(128, 0);
    id3.write("TAG", 0, "ascii");
    id3.write("Legacy Track", 3, "ascii");
    fs.appendFileSync(file, id3);

    expect(await repairMpcTags(file)).toBe("repaired");

    const after = fs.readFileSync(file);
    // Still there, still last, byte for byte. (Not searched for with indexOf:
    // the APEv2 preamble "APETAGEX" contains "TAG" too.)
    expect(after.subarray(after.length - 128).equals(id3)).toBe(true);
    // And the APE block behind it still parses.
    expect(items(file).some((i) => i.key === "Title")).toBe(true);
    expect(readApeTags(file).coverArt).toBeUndefined();
  });
});
