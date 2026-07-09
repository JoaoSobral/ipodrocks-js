/**
 * @vitest-environment node
 *
 * Round-trips the real writer → reader so the two stay exact inverses, and
 * confirms the reader degrades gracefully (never throws) on malformed tags.
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { describe, it, expect } from "vitest";
import { writeTags } from "../../main/tagging/writer";
import { readApeTags } from "../../main/tagging/reader";
import { buildApeBlock } from "../../main/tagging/apev2/block";
import { buildTextItem } from "../../main/tagging/apev2/items";
import { ID3V1_MAGIC, ID3V1_SIZE } from "../../main/tagging/apev2/constants";
import type { ApeTags } from "../../main/tagging/apev2/types";

/** Minimal SV8 audio prefix — enough for detect/strip to treat as tagless audio. */
const SV8_PREFIX = Buffer.from("MPCK", "ascii");

function makeTempMpc(): string {
  const tmp = path.join(
    os.tmpdir(),
    `reader_${Date.now()}_${Math.random().toString(36).slice(2)}.mpc`
  );
  fs.writeFileSync(tmp, SV8_PREFIX);
  return tmp;
}

const FULL_TAGS: ApeTags = {
  title: "Song",
  artist: "The Artist",
  album: "The Album",
  albumArtist: "Various Artists",
  genre: "Electronic",
  year: "2003",
  originalYear: "1999",
  originalDate: "1999-05-01",
  composer: "A Composer, B Composer",
  comment: "a note",
  compilation: "1",
  track: "4",
  disc: "2",
  coverArt: {
    data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03]),
    mimeType: "image/png",
    filename: "Cover Art (Front).png",
  },
  extra: { ReplayGainTrackGain: "-3.21 dB" },
};

describe("tagging/reader readApeTags round-trip", () => {
  it("reads back every field the writer wrote", async () => {
    const file = makeTempMpc();
    try {
      await writeTags(file, FULL_TAGS);
      const tags = readApeTags(file);

      expect(tags.title).toBe("Song");
      expect(tags.artist).toBe("The Artist");
      expect(tags.album).toBe("The Album");
      expect(tags.albumArtist).toBe("Various Artists");
      expect(tags.genre).toBe("Electronic");
      expect(tags.year).toBe("2003");
      expect(tags.originalYear).toBe("1999");
      expect(tags.originalDate).toBe("1999-05-01");
      expect(tags.composer).toBe("A Composer, B Composer");
      expect(tags.comment).toBe("a note");
      expect(tags.compilation).toBe("1");
      expect(tags.track).toBe("4");
      expect(tags.disc).toBe("2");

      expect(tags.coverArt?.mimeType).toBe("image/png");
      expect(tags.coverArt?.filename).toBe("Cover Art (Front).png");
      expect(tags.coverArt?.data.equals(FULL_TAGS.coverArt!.data)).toBe(true);

      expect(tags.extra?.ReplayGainTrackGain).toBe("-3.21 dB");
    } finally {
      fs.unlinkSync(file);
    }
  });

  it("reads legacy 'Album Artist' / 'Disc' key tokens for backward compatibility", () => {
    // Files iPodRocks wrote before the ALBUMARTIST/DISCNUMBER change, and files
    // from taggers that use these tokens, must still scan correctly.
    const file = makeTempMpc();
    try {
      const block = buildApeBlock([
        buildTextItem("Album Artist", "Various Artists"),
        buildTextItem("Disc", "3"),
      ]);
      fs.appendFileSync(file, block);

      const tags = readApeTags(file);
      expect(tags.albumArtist).toBe("Various Artists");
      expect(tags.disc).toBe("3");
    } finally {
      fs.unlinkSync(file);
    }
  });

  it("reads tags with a trailing ID3v1 tag appended after the APE block", async () => {
    const file = makeTempMpc();
    try {
      await writeTags(file, FULL_TAGS);
      // Simulate a file that also carries a legacy ID3v1 footer.
      const id3 = Buffer.alloc(ID3V1_SIZE, 0);
      ID3V1_MAGIC.copy(id3, 0);
      fs.appendFileSync(file, id3);

      const tags = readApeTags(file);
      expect(tags.title).toBe("Song");
      expect(tags.artist).toBe("The Artist");
      expect(tags.disc).toBe("2");
    } finally {
      fs.unlinkSync(file);
    }
  });

  it("sniffs cover mime from PNG magic when the filename has no extension", async () => {
    const file = makeTempMpc();
    try {
      await writeTags(file, {
        title: "x",
        coverArt: {
          data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xaa]),
          mimeType: "image/png",
          filename: "artwork",
        },
      });
      const tags = readApeTags(file);
      expect(tags.coverArt?.mimeType).toBe("image/png");
    } finally {
      fs.unlinkSync(file);
    }
  });

  it("returns {} for audio with no tag", () => {
    const file = makeTempMpc();
    try {
      expect(readApeTags(file)).toEqual({});
    } finally {
      fs.unlinkSync(file);
    }
  });

  it("returns {} on a garbage APE-preamble footer without throwing", () => {
    const file = makeTempMpc();
    try {
      // "APETAGEX" preamble but a bogus, oversized tagSize.
      const junk = Buffer.alloc(32, 0);
      Buffer.from("APETAGEX", "ascii").copy(junk, 0);
      junk.writeUInt32LE(0xffffffff, 12); // tagSize
      junk.writeUInt32LE(9999, 16); // itemCount
      fs.appendFileSync(file, junk);

      expect(() => readApeTags(file)).not.toThrow();
      expect(readApeTags(file)).toEqual({});
    } finally {
      fs.unlinkSync(file);
    }
  });

  it("does not throw when the tag block is truncated", async () => {
    const file = makeTempMpc();
    try {
      await writeTags(file, { title: "Complete", artist: "AlsoComplete" });
      // Chop off the last few bytes so the final item's value runs past EOF.
      const full = fs.readFileSync(file);
      fs.writeFileSync(file, full.subarray(0, full.byteLength - 5));

      expect(() => readApeTags(file)).not.toThrow();
    } finally {
      fs.unlinkSync(file);
    }
  });
});
