/**
 * @vitest-environment node
 *
 * The Rockbox database encoder (`rockbox/tagcache-build.ts`).
 *
 * The first block is a **hand-assembled** two-track database: every offset and
 * length below was worked out from `apps/tagcache.c`, not from the encoder.
 * A round trip through our own decoder cannot catch an encoder and decoder
 * that share one misreading of the format — that is exactly how the APEv2
 * item-flags bug (issue #125) survived its round-trip test.
 */
import { describe, it, expect } from "vitest";

import {
  INDEX_FILE_NAME,
  UNTAGGED,
  compareTagStrings,
  decodeTagcache,
  encodeTagcache,
  tagFileName,
  type TagcacheEntry,
} from "../../main/rockbox/tagcache-build";
import {
  FLAG,
  TAG,
  decodeMasterHeader,
  decodeTagFile,
} from "../../main/rockbox/tcd-format";

const MAGIC = 0x54434810;

/** int32 LE words. */
function words(...ws: number[]): Buffer {
  const b = Buffer.alloc(ws.length * 4);
  ws.forEach((w, i) => b.writeInt32LE(w, i * 4));
  return b;
}

/** One tag-file entry: tag_length, idx_id, data. */
function entry(tagLength: number, idxId: number, data: string): Buffer {
  const d = Buffer.from(data, "latin1");
  expect(d.length).toBe(tagLength);
  return Buffer.concat([words(tagLength, idxId), d]);
}

function tagFile(...entries: Buffer[]): Buffer {
  const body = Buffer.concat(entries);
  return Buffer.concat([words(MAGIC, body.length, entries.length), body]);
}

const A: TagcacheEntry = {
  filename: "/Music/b.mp3",
  title: "Zed",
  artist: "abba",
  album: "X",
  genre: "",
  year: 1999,
  discnumber: 1,
  tracknumber: 2,
  bitrate: 320,
  length: 1000,
  mtime: 10,
};

const B: TagcacheEntry = {
  filename: "/Music/a.mp3",
  title: "alpha",
  // Same artist, different case: one entry, first spelling ("abba") wins.
  artist: "ABBA",
  album: null,
  genre: "Rock",
};

describe("tagcache encoder — hand-assembled fixture", () => {
  const { files } = encodeTagcache([A, B]);

  it("artist: one deduplicated entry, idx_id -1, padded to 8 bytes with 'X'", () => {
    expect(files.get(tagFileName(TAG.artist))).toEqual(tagFile(entry(8, -1, "abba\0XXX")));
  });

  it("album: <Untagged> sorts first, then the real value", () => {
    expect(files.get(tagFileName(TAG.album))).toEqual(
      tagFile(entry(16, -1, "<Untagged>\0XXXXX"), entry(8, -1, "X\0XXXXXX"))
    );
  });

  it("title: sorted case-insensitively, one entry per track pointing back", () => {
    expect(files.get(tagFileName(TAG.title))).toEqual(
      tagFile(entry(8, 1, "alpha\0XX"), entry(8, 0, "Zed\0XXXX"))
    );
  });

  it("filename: index order, idx_id = index, NUL-terminated and unpadded", () => {
    expect(files.get(tagFileName(TAG.filename))).toEqual(
      tagFile(entry(13, 0, "/Music/b.mp3\0"), entry(13, 1, "/Music/a.mp3\0"))
    );
  });

  it("grouping falls back to the title, canonicalartist to the artist", () => {
    expect(files.get(tagFileName(TAG.grouping))).toEqual(
      tagFile(entry(8, -1, "alpha\0XX"), entry(8, -1, "Zed\0XXXX"))
    );
    expect(files.get(tagFileName(TAG.canonicalartist))).toEqual(
      tagFile(entry(8, -1, "abba\0XXX"))
    );
  });

  it("index: header datasize counts every tag file except filename's", () => {
    // 24 + 96*2 + (artist 16 + album 40 + genre 40 + title 32 + composer 24 +
    // comment 24 + albumartist 24 + grouping 32 + canonicalartist 16)
    const header = words(MAGIC, 464, 2, 0, 1, 0);
    const a = words(
      12, 36, 12, 28, 12, 12, 12, 12, 28, // artist..grouping seeks
      1999, 1, 2, // year, disc, track
      12, // canonicalartist
      320, 1000, // bitrate, length
      0, 0, 0, 0, 0, // playcount, rating, playtime, lastplayed, commitid
      10, 0, 0, // mtime, lastelapsed, lastoffset
      0 // flag
    );
    const b = words(
      12, 12, 36, 12, 33, 12, 12, 12, 12,
      0, 0, -1,
      12,
      0, 0,
      0, 0, 0, 0, 0,
      0, 0, 0,
      0
    );
    expect(files.get(INDEX_FILE_NAME)).toEqual(Buffer.concat([header, a, b]));
  });

  it("writes exactly the eleven files Rockbox opens", () => {
    expect([...files.keys()].sort()).toEqual(
      [
        "database_0.tcd",
        "database_1.tcd",
        "database_2.tcd",
        "database_3.tcd",
        "database_4.tcd",
        "database_5.tcd",
        "database_6.tcd",
        "database_7.tcd",
        "database_8.tcd",
        "database_12.tcd",
        INDEX_FILE_NAME,
      ].sort()
    );
  });
});

describe("tagcache encoder — rules", () => {
  it("every tag file's datasize is its length minus the 12-byte header", () => {
    const { files } = encodeTagcache([A, B]);
    for (const [name, buf] of files) {
      if (name === INDEX_FILE_NAME) continue;
      expect(buf.readInt32LE(4)).toBe(buf.length - 12);
    }
  });

  it("the existing runtime decoder reads the filenames back", () => {
    const { files } = encodeTagcache([A, B]);
    const idx = files.get(INDEX_FILE_NAME)!;
    const header = decodeMasterHeader(idx, idx.length);
    const names = decodeTagFile(files.get(tagFileName(TAG.filename))!, header.swapped);
    expect(names.get(0)).toBe("/Music/b.mp3");
    expect(names.get(1)).toBe("/Music/a.mp3");
  });

  it("round-trips through the full decoder, including runtime data", () => {
    const withStats: TagcacheEntry = {
      ...A,
      composer: "Benny",
      runtime: {
        playcount: 3,
        rating: 8,
        playtime: 2500,
        lastplayed: 41,
        commitid: 2,
        lastelapsed: 0,
        lastoffset: 0,
      },
    };
    const { files, serial, commitId } = encodeTagcache([withStats, B], {
      serial: 10,
      commitId: 1,
    });
    // serial must stay above every lastplayed; commitid above every entry's.
    expect(serial).toBe(42);
    expect(commitId).toBe(3);

    const tagFiles = new Map<number, Buffer>();
    for (const [name, buf] of files) {
      const m = /^database_(\d+)\.tcd$/.exec(name);
      if (m) tagFiles.set(Number(m[1]), buf);
    }
    const decoded = decodeTagcache(files.get(INDEX_FILE_NAME)!, tagFiles);
    expect(decoded.header.serial).toBe(42);
    const [a, b] = decoded.entries;
    expect(a.filename).toBe("/Music/b.mp3");
    expect(a.composer).toBe("Benny");
    expect(a.runtime.rating).toBe(8);
    expect(a.runtime.playcount).toBe(3);
    expect(a.flag & FLAG.DIRTYNUM).toBe(FLAG.DIRTYNUM);
    expect(b.album).toBe(UNTAGGED);
    expect(b.artist).toBe("abba");
    expect(b.flag).toBe(0);
  });

  it("sorts like strncasecmp: ASCII folded, UTF-8 after ASCII, <Untagged> first", () => {
    const sorted = ["Émile", "beta", "Alpha", UNTAGGED, "zeta"]
      .map((s) => Buffer.from(s, "utf8"))
      .sort(compareTagStrings)
      .map((b) => b.toString("utf8"));
    expect(sorted).toEqual([UNTAGGED, "Alpha", "beta", "zeta", "Émile"]);
  });

  it("truncates an over-long tag at a character boundary", () => {
    const long = "é".repeat(400); // 800 bytes
    const { files } = encodeTagcache([{ filename: "/a.mp3", title: long }]);
    const title = files.get(tagFileName(TAG.title))!;
    const len = title.readInt32LE(12);
    const data = title.subarray(20, 20 + len);
    const str = data.subarray(0, data.indexOf(0)).toString("utf8");
    expect(Buffer.byteLength(str)).toBe(520);
    expect(str).toBe("é".repeat(260));
  });

  it("refuses a path Rockbox itself would never index", () => {
    expect(() => encodeTagcache([{ filename: "/" + "a".repeat(300) + ".mp3" }])).toThrow(
      /path too long/
    );
  });
});
