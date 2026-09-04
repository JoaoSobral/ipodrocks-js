/**
 * @vitest-environment node
 *
 * Regression for issue #125 — "Musepack Tag writing multiple Cover Art tags
 * into the APEv2 tag".
 *
 * iPodRocks wrote the cover-art item's type as `1`. In APEv2 the item type sits
 * in bits 1-2 and bit 0 is the read-only flag, so `1` means "read-only UTF-8
 * text": every reader then treated the JPEG as a text value, split it on its
 * NUL bytes into thousands of mostly-empty values (what the reporter saw in
 * MP3tag), and Rockbox's bounded tag buffer was consumed before it reached the
 * REPLAYGAIN_* items the writer emitted after the artwork.
 *
 * This pins both halves of the fix and the in-place repair of files already
 * written — including the properties that make the repair invisible to the
 * shadow-library stat baseline and the device sync (same size, same mtime).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { tagsToItems, writeTags } from "../../main/tagging/writer";
import { readApeTags, parseApeItems } from "../../main/tagging/reader";
import { serializeItem } from "../../main/tagging/apev2/items";
import { locateApeBlock } from "../../main/tagging/apev2/locate";
import {
  ITEM_TYPE_BINARY,
  itemTypeFromFlags,
} from "../../main/tagging/apev2/constants";
import { needsApeRepair, repairMpcTags } from "../../main/tagging/mpc/repair";
import type { ApeTags, RawApeItem } from "../../main/tagging/apev2/types";

/** "MP+" SV7 magic plus filler, so `detectMpcVersion` accepts the fixture. */
const AUDIO = Buffer.concat([
  Buffer.from([0x4d, 0x50, 0x2b, 0x07]),
  Buffer.alloc(4096, 0xa5),
]);

/**
 * A JPEG-ish blob riddled with NUL bytes — the property that turned one
 * mis-flagged item into thousands of displayed values.
 */
const COVER = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(64, 0x00),
  Buffer.from([0x01, 0x02, 0x00, 0x03]),
  Buffer.alloc(64, 0x00),
]);

const TAGS: ApeTags = {
  title: "Test Title",
  artist: "Test Artist",
  album: "Test Album",
  extra: {
    REPLAYGAIN_TRACK_GAIN: "-3.38 dB",
    REPLAYGAIN_TRACK_PEAK: "0.988556",
    REPLAYGAIN_ALBUM_GAIN: "-4.10 dB",
    REPLAYGAIN_ALBUM_PEAK: "0.999969",
  },
  coverArt: { data: COVER, mimeType: "image/jpeg", filename: "cover.jpg" },
};

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpc-125-"));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** Read the raw item list (flags included) back off a file. */
function readItems(filePath: string): RawApeItem[] {
  const full = fs.readFileSync(filePath);
  const loc = locateApeBlock(full);
  if (!loc) throw new Error("no APE block");
  return parseApeItems(full, loc);
}

function indexOfKey(items: RawApeItem[], key: string): number {
  return items.findIndex((i) => i.key.toLowerCase() === key.toLowerCase());
}

/**
 * Build a file exactly the way iPodRocks did before the fix: cover art ahead of
 * the ReplayGain items, and its flags word spelling read-only text.
 */
function writeLegacyFile(filePath: string): void {
  const items = [
    ...tagsToItems({ title: TAGS.title, artist: TAGS.artist, album: TAGS.album }),
    // The old writer emitted the artwork here, before `extra`.
    ...tagsToItems({ coverArt: TAGS.coverArt }),
    ...tagsToItems({ extra: TAGS.extra }),
  ];
  const serialized = Buffer.concat(items.map(serializeItem));

  // Flip the cover item's flags back to the buggy value in place: the key is
  // preceded by the 8-byte value_size + flags header.
  const keyOffset = serialized.indexOf(Buffer.from("Cover Art (Front)\0", "ascii"));
  expect(keyOffset).toBeGreaterThan(0);
  serialized.writeUInt32LE(1, keyOffset - 4);

  const tagSize = serialized.byteLength + 32;
  const head = (isHeader: boolean): Buffer => {
    const buf = Buffer.alloc(32, 0);
    buf.write("APETAGEX", 0, "ascii");
    buf.writeUInt32LE(2000, 8);
    buf.writeUInt32LE(tagSize, 12);
    buf.writeUInt32LE(items.length, 16);
    let flags = (1 << 31) | (1 << 30);
    if (isHeader) flags |= 1 << 29;
    buf.writeUInt32LE(flags >>> 0, 20);
    return buf;
  };

  fs.writeFileSync(
    filePath,
    Buffer.concat([AUDIO, head(true), serialized, head(false)])
  );
}

describe("issue #125 — APEv2 cover-art item type flags", () => {
  it("writes the cover art as a binary item, never as read-only text", async () => {
    const file = path.join(workDir, "new.mpc");
    fs.writeFileSync(file, AUDIO);
    await writeTags(file, TAGS);

    const items = readItems(file);
    const cover = items[indexOfKey(items, "Cover Art (Front)")];
    expect(itemTypeFromFlags(cover.flags)).toBe(ITEM_TYPE_BINARY);
    expect(cover.flags).toBe(2);
    // Bit 0 is read-only, and nothing here is read-only.
    expect(cover.flags & 1).toBe(0);
  });

  it("puts every ReplayGain item ahead of the artwork", async () => {
    const file = path.join(workDir, "order.mpc");
    fs.writeFileSync(file, AUDIO);
    await writeTags(file, TAGS);

    const items = readItems(file);
    const coverIndex = indexOfKey(items, "Cover Art (Front)");
    const rgIndexes = items
      .map((item, i) => (item.key.toLowerCase().startsWith("replaygain_") ? i : -1))
      .filter((i) => i >= 0);

    expect(rgIndexes).toHaveLength(4);
    for (const i of rgIndexes) expect(i).toBeLessThan(coverIndex);
  });

  it("declares one item per tag — the empty values were never extra items", async () => {
    const file = path.join(workDir, "count.mpc");
    fs.writeFileSync(file, AUDIO);
    const result = await writeTags(file, TAGS);

    const full = fs.readFileSync(file);
    const footerCount = full.readUInt32LE(full.byteLength - 32 + 16);
    // 3 text + 4 ReplayGain + 1 cover
    expect(result.itemCount).toBe(8);
    expect(footerCount).toBe(result.itemCount);
  });

  it("still reads the artwork out of a file written before the fix", () => {
    const file = path.join(workDir, "legacy.mpc");
    writeLegacyFile(file);

    const tags = readApeTags(file);
    expect(tags.coverArt?.data.equals(COVER)).toBe(true);
    expect(tags.coverArt?.mimeType).toBe("image/jpeg");
    // The blob must never leak into `extra` as a text value — that is what
    // would let the repair rewrite a JPEG back out as a text item.
    expect(Object.keys(tags.extra ?? {})).not.toContain("Cover Art (Front)");
  });

  describe("repairMpcTags", () => {
    it("fixes a legacy file without touching the audio, its size or its mtime", async () => {
      const file = path.join(workDir, "repair.mpc");
      writeLegacyFile(file);

      const before = fs.readFileSync(file);
      // The mtime a real write leaves behind carries a fractional millisecond.
      // That matters: restoring it through the `Date` form of `utimes` loses
      // ~0.9 ms, which is enough to shift `Math.floor(mtimeMs)` by one — and
      // that floored value is exactly what `shadow_tracks.mtime` stores and
      // compares for equality. So this must be read at full resolution.
      const beforeStat = fs.statSync(file, { bigint: true });
      expect(Number(beforeStat.mtimeNs) % 1_000_000).not.toBe(0);

      expect(await needsApeRepair(file)).toBe(true);
      expect(await repairMpcTags(file)).toBe("repaired");

      const after = fs.readFileSync(file);
      const afterStat = fs.statSync(file, { bigint: true });

      expect(after.byteLength).toBe(before.byteLength);
      expect(afterStat.size).toBe(beforeStat.size);
      expect(Math.floor(Number(afterStat.mtimeNs) / 1e6)).toBe(
        Math.floor(Number(beforeStat.mtimeNs) / 1e6)
      );
      expect(after.subarray(0, AUDIO.byteLength).equals(AUDIO)).toBe(true);
    });

    it("leaves the artwork byte-identical and reorders ReplayGain ahead of it", async () => {
      const file = path.join(workDir, "roundtrip.mpc");
      writeLegacyFile(file);
      await repairMpcTags(file);

      const tags = readApeTags(file);
      expect(tags.coverArt?.data.equals(COVER)).toBe(true);
      expect(tags.title).toBe("Test Title");
      expect(tags.extra?.REPLAYGAIN_TRACK_GAIN).toBe("-3.38 dB");

      const items = readItems(file);
      const cover = items[indexOfKey(items, "Cover Art (Front)")];
      expect(itemTypeFromFlags(cover.flags)).toBe(ITEM_TYPE_BINARY);
      expect(indexOfKey(items, "REPLAYGAIN_TRACK_GAIN")).toBeLessThan(
        indexOfKey(items, "Cover Art (Front)")
      );
    });

    it("is idempotent — a second pass reports nothing to do", async () => {
      const file = path.join(workDir, "idempotent.mpc");
      writeLegacyFile(file);
      await repairMpcTags(file);

      expect(await needsApeRepair(file)).toBe(false);
      expect(await repairMpcTags(file)).toBe("ok");
    });

    it("leaves a file this writer produced alone", async () => {
      const file = path.join(workDir, "already-good.mpc");
      fs.writeFileSync(file, AUDIO);
      await writeTags(file, TAGS);

      expect(await needsApeRepair(file)).toBe(false);
      expect(await repairMpcTags(file)).toBe("ok");
    });

    it("ignores a tagged file with no artwork, and an untagged one", async () => {
      const tagged = path.join(workDir, "no-art.mpc");
      fs.writeFileSync(tagged, AUDIO);
      await writeTags(tagged, { title: "No Art", extra: TAGS.extra });

      const untagged = path.join(workDir, "bare.mpc");
      fs.writeFileSync(untagged, AUDIO);

      expect(await needsApeRepair(tagged)).toBe(false);
      expect(await needsApeRepair(untagged)).toBe(false);
      expect(await repairMpcTags(untagged)).toBe("ok");
    });
  });
});
