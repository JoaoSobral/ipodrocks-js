/**
 * @vitest-environment node
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { describe, it, expect } from "vitest";
import { tagsToItems, writeTags } from "../../main/tagging/writer";
import type { ApeTags } from "../../main/tagging/apev2/types";
import { readAudioOnly } from "../../main/tagging/mpc/strip";

/** Decode a text item's value buffer back to a UTF-8 string. */
function itemValue(items: { key: string; value: Buffer }[], key: string): string | undefined {
  const item = items.find((i) => i.key === key);
  return item ? item.value.toString("utf8") : undefined;
}

describe("tagging/writer tagsToItems", () => {
  it("emits APEv2 items for the full set of preserved tag fields", () => {
    const tags: ApeTags = {
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
    };

    const items = tagsToItems(tags);
    const keys = items.map((i) => i.key);

    expect(keys).toEqual(
      expect.arrayContaining([
        "Title",
        "Artist",
        "Album",
        "Album Artist",
        "Genre",
        "Year",
        "Originalyear",
        "Originaldate",
        "Composer",
        "Comment",
        "Compilation",
        "Track",
        "Disc",
      ])
    );

    expect(itemValue(items, "Album Artist")).toBe("Various Artists");
    expect(itemValue(items, "Year")).toBe("2003");
    expect(itemValue(items, "Originalyear")).toBe("1999");
    expect(itemValue(items, "Originaldate")).toBe("1999-05-01");
    expect(itemValue(items, "Composer")).toBe("A Composer, B Composer");
    expect(itemValue(items, "Disc")).toBe("2");
  });

  it("omits empty and whitespace-only fields", () => {
    const items = tagsToItems({
      title: "Song",
      albumArtist: "",
      composer: "   ",
      year: "2003",
    });
    const keys = items.map((i) => i.key);
    expect(keys).toContain("Title");
    expect(keys).toContain("Year");
    expect(keys).not.toContain("Album Artist");
    expect(keys).not.toContain("Composer");
  });
});

describe("tagging/writer writeTags round-trip", () => {
  function makeTempMpc(): string {
    const tmp = path.join(os.tmpdir(), `writer_${Date.now()}_${Math.random().toString(36).slice(2)}.mpc`);
    // Minimal SV7 audio prefix; enough for detect/strip to treat as tagless audio.
    fs.writeFileSync(tmp, Buffer.from([0x4d, 0x50, 0x2b, 0x07, 0x00, 0x00, 0x00, 0x00]));
    return tmp;
  }

  it("writes the new fields into the file so they survive a strip round-trip", async () => {
    const file = makeTempMpc();
    try {
      const result = await writeTags(file, {
        artist: "The Artist",
        albumArtist: "Various Artists",
        originalYear: "1999",
      });
      expect(result.itemCount).toBeGreaterThanOrEqual(3);

      const full = fs.readFileSync(file);
      // The APEv2 block is appended after the audio; its item keys appear verbatim.
      expect(full.includes(Buffer.from("Album Artist", "ascii"))).toBe(true);
      expect(full.includes(Buffer.from("Originalyear", "ascii"))).toBe(true);

      // Audio prefix is untouched.
      const audioOnly = readAudioOnly(file);
      expect(audioOnly.subarray(0, 4).equals(Buffer.from([0x4d, 0x50, 0x2b, 0x07]))).toBe(true);
    } finally {
      fs.unlinkSync(file);
    }
  });
});
