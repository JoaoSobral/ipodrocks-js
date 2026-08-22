/**
 * @vitest-environment node
 *
 * The Rockbox tagcache binary reader and the narrow rating writer.
 *
 * This file has no checksum and no redundancy, and it is the user's own device
 * database, so the reader has to be strict about anything it cannot address
 * safely and the writer has to touch exactly four bytes (plus the flag word)
 * and nothing else.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

import { createTmpDir, cleanupTmp } from "../harness";
import {
  writeTcdFixture,
  readTcdNumericTag,
  TCD_TAG,
} from "../harness/tcd-fixture";

import {
  FLAG,
  TAG,
  TcdFormatError,
  decodeMasterHeader,
  decodeTagFile,
  flagOffset,
  numericTagOffset,
} from "../../main/rockbox/tcd-format";
import {
  detectRuntimeCapability,
  readRuntimeIndex,
  resetBackupState,
  writeRating,
} from "../../main/rockbox/tagcache-index";

const IDX = (m: string) => path.join(m, ".rockbox", "database_idx.tcd");

describe("Rockbox tagcache format", () => {
  let mount: string;

  beforeEach(() => {
    mount = createTmpDir("tcd-");
    resetBackupState();
  });

  afterEach(() => {
    cleanupTmp(mount);
  });

  describe("reading", () => {
    it("reads play count, listening time, rating and play order", () => {
      writeTcdFixture(mount, [
        {
          path: "/<HDD0>/Music/A/Album/01 - One.mp3",
          playCount: 3,
          playTimeMs: 600_000,
          rating: 8,
          lastPlayedSerial: 4,
          lengthMs: 210_000,
        },
        { path: "/<HDD0>/Music/A/Album/02 - Two.mp3" },
      ]);

      const snap = readRuntimeIndex(mount);
      expect(snap).not.toBeNull();
      expect(snap!.entries).toHaveLength(2);

      expect(snap!.entries[0]).toMatchObject({
        idxId: 0,
        devicePath: "/<HDD0>/Music/A/Album/01 - One.mp3",
        playCount: 3,
        playTimeMs: 600_000,
        rating: 8,
        lastPlayedSerial: 4,
        lengthMs: 210_000,
      });
    });

    it("reads a never-played track as zero plays, not as missing data", () => {
      writeTcdFixture(mount, [{ path: "/<HDD0>/Music/A/never.mp3" }]);

      const entry = readRuntimeIndex(mount)!.entries[0];
      expect(entry.playCount).toBe(0);
      expect(entry.playTimeMs).toBe(0);
      expect(entry.rating).toBe(0);
    });

    it("strips the NUL terminator and the 'X' alignment padding from paths", () => {
      // "3 Doors Down" is 12 bytes, so Rockbox stores "3 Doors Down\0XXX".
      // Reading tag_length verbatim would leave the padding on every path and
      // break every comparison downstream.
      writeTcdFixture(mount, [{ path: "/<HDD0>/Music/3 Doors Down/x.mp3" }]);

      const raw = fs.readFileSync(path.join(mount, ".rockbox", "database_4.tcd"));
      expect(raw.includes(Buffer.from("XX"))).toBe(true);

      expect(readRuntimeIndex(mount)!.entries[0].devicePath).toBe(
        "/<HDD0>/Music/3 Doors Down/x.mp3"
      );
    });

    it("skips deleted entries", () => {
      writeTcdFixture(mount, [
        { path: "/<HDD0>/Music/live.mp3", playCount: 1 },
        { path: "/<HDD0>/Music/gone.mp3", flag: FLAG.DELETED },
      ]);

      const paths = readRuntimeIndex(mount)!.entries.map((e) => e.devicePath);
      expect(paths).toEqual(["/<HDD0>/Music/live.mp3"]);
    });

    it("reads a big-endian database", () => {
      writeTcdFixture(
        mount,
        [{ path: "/<HDD0>/Music/be.mp3", playCount: 7, rating: 10 }],
        { bigEndian: true }
      );

      const entry = readRuntimeIndex(mount)!.entries[0];
      expect(entry.playCount).toBe(7);
      expect(entry.rating).toBe(10);
    });

    it("handles a large play count", () => {
      writeTcdFixture(mount, [
        { path: "/<HDD0>/Music/loved.mp3", playCount: 65_535, playTimeMs: 2_000_000_000 },
      ]);

      const entry = readRuntimeIndex(mount)!.entries[0];
      expect(entry.playCount).toBe(65_535);
      expect(entry.playTimeMs).toBe(2_000_000_000);
    });

    it("reports serial, which is what identifies a rebuilt database", () => {
      writeTcdFixture(
        mount,
        [{ path: "/<HDD0>/Music/a.mp3", playCount: 1, lastPlayedSerial: 5 }],
        { serial: 6 }
      );
      expect(readRuntimeIndex(mount)!.serial).toBe(6);
    });
  });

  describe("header validation", () => {
    it("rejects a file that is not a tagcache", () => {
      const buf = Buffer.alloc(24);
      buf.writeInt32LE(0xdeadbeef | 0, 0);
      expect(() => decodeMasterHeader(buf, 24)).toThrow(TcdFormatError);
    });

    it("rejects a truncated header", () => {
      expect(() => decodeMasterHeader(Buffer.alloc(8), 8)).toThrow(TcdFormatError);
    });

    it("rejects an entry count that does not match the file size", () => {
      // A future Rockbox that adds a tag changes the record stride; we refuse
      // rather than read every field from the wrong offset.
      const buf = Buffer.alloc(24);
      buf.writeInt32LE(0x54434810, 0);
      buf.writeInt32LE(10, 8);
      expect(() => decodeMasterHeader(buf, 24 + 10 * 100)).toThrow(/size mismatch/);
    });

    it("returns null rather than throwing when the index is corrupt", () => {
      writeTcdFixture(mount, [{ path: "/<HDD0>/Music/a.mp3" }]);
      fs.writeFileSync(IDX(mount), Buffer.alloc(64));
      expect(readRuntimeIndex(mount)).toBeNull();
    });

    it("returns null when there is no database at all", () => {
      expect(readRuntimeIndex(mount)).toBeNull();
    });
  });

  describe("offset arithmetic", () => {
    it("addresses the rating and flag words of a given record", () => {
      expect(numericTagOffset(0, TAG.rating)).toBe(24 + 16 * 4);
      expect(numericTagOffset(3, TAG.playcount)).toBe(24 + 3 * 96 + 15 * 4);
      expect(flagOffset(3)).toBe(24 + 3 * 96 + 23 * 4);
    });
  });

  describe("tag files", () => {
    it("ignores entries with no index back-pointer", () => {
      // Non-unique tags (artist, album, …) carry idx_id -1 because one string
      // is shared by many tracks; only unique tags such as filename point back.
      const entry = Buffer.alloc(16);
      entry.writeInt32LE(8, 0);
      entry.writeInt32LE(-1, 4);
      Buffer.from("shared\0X").copy(entry, 8);
      const file = Buffer.alloc(12 + 16);
      file.writeInt32LE(0x54434810, 0);
      file.writeInt32LE(16, 4);
      file.writeInt32LE(1, 8);
      entry.copy(file, 12);

      expect(decodeTagFile(file, false).size).toBe(0);
    });
  });

  describe("capability detection", () => {
    it("says the database has not been built", () => {
      const state = detectRuntimeCapability(mount);
      expect(state.kind).toBe("no-database");
      expect(state).toHaveProperty("message", expect.stringContaining("Initialize Now"));
    });

    it("says runtime data is not being gathered when nothing was ever recorded", () => {
      writeTcdFixture(
        mount,
        [{ path: "/<HDD0>/Music/a.mp3" }, { path: "/<HDD0>/Music/b.mp3" }],
        { serial: 0 }
      );

      const state = detectRuntimeCapability(mount);
      expect(state.kind).toBe("no-runtime-data");
      expect(state).toHaveProperty(
        "message",
        expect.stringContaining("Gather Runtime Data")
      );
    });

    it("does not treat one unplayed track as an error", () => {
      writeTcdFixture(mount, [
        { path: "/<HDD0>/Music/played.mp3", playCount: 2, lastPlayedSerial: 1 },
        { path: "/<HDD0>/Music/unplayed.mp3" },
      ]);

      const state = detectRuntimeCapability(mount);
      expect(state.kind).toBe("ok");
      expect(state).toMatchObject({ entryCount: 2, tracksWithPlays: 1 });
    });

    it("refuses to act while Rockbox is mid-update", () => {
      writeTcdFixture(mount, [{ path: "/<HDD0>/Music/a.mp3", playCount: 1 }], {
        dirty: 1,
      });
      expect(detectRuntimeCapability(mount).kind).toBe("busy");
    });
  });

  describe("writing a rating", () => {
    it("writes the rating and flags the record dirty", () => {
      writeTcdFixture(mount, [
        { path: "/<HDD0>/Music/a.mp3", playCount: 1 },
        { path: "/<HDD0>/Music/b.mp3" },
      ]);

      expect(writeRating(mount, 1, 9)).toBe(true);
      expect(readTcdNumericTag(mount, 1, TCD_TAG.rating)).toBe(9);
      expect(readTcdNumericTag(mount, 1, TCD_TAG.flag) & FLAG.DIRTYNUM).toBe(
        FLAG.DIRTYNUM
      );
    });

    it("leaves every other byte of the file untouched", () => {
      writeTcdFixture(mount, [
        { path: "/<HDD0>/Music/a.mp3", playCount: 3, playTimeMs: 9000, lastPlayedSerial: 2 },
        { path: "/<HDD0>/Music/b.mp3", playCount: 5, rating: 4 },
      ]);
      const before = fs.readFileSync(IDX(mount));

      writeRating(mount, 0, 6);

      const after = fs.readFileSync(IDX(mount));
      const changed: number[] = [];
      for (let i = 0; i < before.length; i++) {
        if (before[i] !== after[i]) changed.push(i);
      }
      // Only the rating int32 and the flag int32 of record 0.
      const ratingAt = numericTagOffset(0, TAG.rating);
      const flagAt = flagOffset(0);
      for (const i of changed) {
        const inRating = i >= ratingAt && i < ratingAt + 4;
        const inFlag = i >= flagAt && i < flagAt + 4;
        expect(inRating || inFlag).toBe(true);
      }
      expect(changed.length).toBeGreaterThan(0);

      // The neighbouring record is byte-identical.
      expect(readTcdNumericTag(mount, 1, TCD_TAG.playcount)).toBe(5);
      expect(readTcdNumericTag(mount, 1, TCD_TAG.rating)).toBe(4);
    });

    it("writes nothing when the rating already matches", () => {
      writeTcdFixture(mount, [{ path: "/<HDD0>/Music/a.mp3", rating: 7 }]);
      const before = fs.readFileSync(IDX(mount));

      expect(writeRating(mount, 0, 7)).toBe(false);

      expect(fs.readFileSync(IDX(mount)).equals(before)).toBe(true);
    });

    it("backs the index up before its first write, and only then", () => {
      writeTcdFixture(mount, [{ path: "/<HDD0>/Music/a.mp3", rating: 7 }]);
      const backup = IDX(mount) + ".ipodrocks-bak";

      // A no-op write must not leave a backup behind.
      writeRating(mount, 0, 7);
      expect(fs.existsSync(backup)).toBe(false);

      writeRating(mount, 0, 3);
      expect(fs.existsSync(backup)).toBe(true);
      // The backup holds the pre-write value.
      const saved = fs.readFileSync(backup);
      expect(saved.readInt32LE(numericTagOffset(0, TAG.rating))).toBe(7);
    });

    it("refuses to write while Rockbox is mid-update", () => {
      writeTcdFixture(mount, [{ path: "/<HDD0>/Music/a.mp3" }], { dirty: 1 });
      expect(writeRating(mount, 0, 8)).toBe(false);
      expect(readTcdNumericTag(mount, 0, TCD_TAG.rating)).toBe(0);
    });

    it("refuses an index id the header does not account for", () => {
      writeTcdFixture(mount, [{ path: "/<HDD0>/Music/a.mp3" }]);
      expect(() => writeRating(mount, 5, 8)).toThrow(/out of range/);
    });

    it("refuses a rating outside Rockbox's 0-10 scale", () => {
      writeTcdFixture(mount, [{ path: "/<HDD0>/Music/a.mp3" }]);
      expect(() => writeRating(mount, 0, 11)).toThrow(RangeError);
      expect(() => writeRating(mount, 0, -1)).toThrow(RangeError);
    });

    it("writes into a big-endian database in its own byte order", () => {
      writeTcdFixture(mount, [{ path: "/<HDD0>/Music/a.mp3" }], {
        bigEndian: true,
      });

      expect(writeRating(mount, 0, 6)).toBe(true);
      expect(readTcdNumericTag(mount, 0, TCD_TAG.rating, true)).toBe(6);
      expect(readRuntimeIndex(mount)!.entries[0].rating).toBe(6);
    });
  });
});
