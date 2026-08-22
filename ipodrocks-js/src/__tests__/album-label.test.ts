/**
 * @vitest-environment node
 *
 * Issue #113: the album label is the identity of an album in custom-sync
 * selections, and it is persisted verbatim in device_sync_preferences. The
 * renderer and the main-process matcher must agree on it exactly — a mismatch
 * makes custom sync silently sync nothing — so it has one shared definition.
 */
import { describe, it, expect } from "vitest";
import {
  albumLabel,
  albumArtistOf,
  albumEntryForTrack,
  albumLabelForTrack,
  albumLabelsForTrack,
  buildAlbumDisplayMap,
} from "../shared/album-label";

const compilationTrack = {
  album: "Now Thats What I Call Music 40",
  artist: "Alpha Band",
  albumArtist: "Various Artists",
};

describe("albumLabel", () => {
  it("joins with an em dash and trims", () => {
    expect(albumLabel("  Discovery ", " Daft Punk ")).toBe("Discovery — Daft Punk");
  });

  it("keeps the exact separator the stored selections use", () => {
    // Guards the persisted format: changing this invalidates saved selections.
    expect(albumLabel("A", "B")).toBe("A — B");
  });
});

describe("albumArtistOf", () => {
  it("prefers the album artist", () => {
    expect(albumArtistOf(compilationTrack)).toBe("Various Artists");
  });

  it("falls back to the track artist when untagged", () => {
    expect(albumArtistOf({ artist: "Daft Punk" })).toBe("Daft Punk");
    expect(albumArtistOf({ artist: "Daft Punk", albumArtist: "  " })).toBe("Daft Punk");
  });

  it("falls back to Unknown Artist when nothing is tagged", () => {
    expect(albumArtistOf({})).toBe("Unknown Artist");
  });
});

describe("albumLabelForTrack", () => {
  it("groups a compilation under its album artist", () => {
    expect(albumLabelForTrack(compilationTrack, "album-artist")).toBe(
      "Now Thats What I Call Music 40 — Various Artists"
    );
  });

  it("reproduces the old per-track-artist label when asked", () => {
    expect(albumLabelForTrack(compilationTrack, "track-artist")).toBe(
      "Now Thats What I Call Music 40 — Alpha Band"
    );
  });

  it("gives every track of a compilation the same album-artist label", () => {
    const labels = ["Alpha Band", "Beta Crew", "Gamma Trio"].map((artist) =>
      albumLabelForTrack({ ...compilationTrack, artist }, "album-artist")
    );
    expect(new Set(labels).size).toBe(1);
  });

  it("defaults missing tags to the Unknown placeholders", () => {
    expect(albumLabelForTrack({}, "album-artist")).toBe(
      "Unknown Album — Unknown Artist"
    );
  });
});

describe("albumLabelsForTrack — upgrade compatibility", () => {
  it("offers both the album-artist and the legacy track-artist label", () => {
    expect(albumLabelsForTrack(compilationTrack, "album-artist")).toEqual([
      "Now Thats What I Call Music 40 — Various Artists",
      "Now Thats What I Call Music 40 — Alpha Band",
    ]);
  });

  it("does not duplicate the label when both artists agree", () => {
    const t = { album: "Discovery", artist: "Daft Punk", albumArtist: "Daft Punk" };
    expect(albumLabelsForTrack(t, "album-artist")).toEqual([
      "Discovery — Daft Punk",
    ]);
  });

  it("still includes the track-artist label under track-artist grouping", () => {
    expect(albumLabelsForTrack(compilationTrack, "track-artist")).toContain(
      "Now Thats What I Call Music 40 — Alpha Band"
    );
  });
});

describe("albumEntryForTrack — key must stay identical to the stored label", () => {
  // The key is persisted in custom_selections_json and compared in the
  // main-process matcher. If display work ever changes it, every saved
  // selection silently stops matching — so pin the equivalence.
  const cases = [
    compilationTrack,
    { album: "Discovery", artist: "Daft Punk", albumArtist: "Daft Punk" },
    { album: "Untagged", artist: "Someone" },
    {},
  ];

  for (const grouping of ["album-artist", "track-artist"] as const) {
    it(`matches albumLabelForTrack under ${grouping} grouping`, () => {
      for (const t of cases) {
        expect(albumEntryForTrack(t, grouping).key).toBe(
          albumLabelForTrack(t, grouping)
        );
      }
    });
  }

  it("exposes the parts the picker needs to render", () => {
    expect(albumEntryForTrack(compilationTrack, "album-artist")).toEqual({
      key: "Now Thats What I Call Music 40 — Various Artists",
      album: "Now Thats What I Call Music 40",
      artist: "Various Artists",
    });
  });
});

describe("buildAlbumDisplayMap", () => {
  const entry = (album: string, artist: string) =>
    albumEntryForTrack({ album, artist, albumArtist: artist }, "album-artist");

  it("shows a unique album as just its name", () => {
    const e = entry("Discovery", "Daft Punk");
    expect(buildAlbumDisplayMap([e]).get(e.key)).toBe("Discovery");
  });

  it("adds the artist only when two albums share a title", () => {
    const abba = entry("Greatest Hits", "ABBA");
    const queen = entry("Greatest Hits", "Queen");
    const solo = entry("Discovery", "Daft Punk");
    const map = buildAlbumDisplayMap([abba, queen, solo]);

    expect(map.get(abba.key)).toBe("Greatest Hits — ABBA");
    expect(map.get(queen.key)).toBe("Greatest Hits — Queen");
    // The unambiguous one stays clean.
    expect(map.get(solo.key)).toBe("Discovery");
  });

  it("does not treat a compilation's many tracks as ambiguity", () => {
    // Every track of a compilation yields the same key; that must not read as
    // "this title appears more than once".
    const entries = ["Alpha Band", "Beta Crew", "Gamma Trio"].map((artist) =>
      albumEntryForTrack(
        { album: "Now 40", artist, albumArtist: "Various Artists" },
        "album-artist"
      )
    );
    const map = buildAlbumDisplayMap(entries);
    expect(map.size).toBe(1);
    expect([...map.values()]).toEqual(["Now 40"]);
  });

  it("disambiguates under track-artist grouping, where a compilation does split", () => {
    const entries = ["Alpha Band", "Beta Crew"].map((artist) =>
      albumEntryForTrack(
        { album: "Now 40", artist, albumArtist: "Various Artists" },
        "track-artist"
      )
    );
    const map = buildAlbumDisplayMap(entries);
    expect([...map.values()].sort()).toEqual([
      "Now 40 — Alpha Band",
      "Now 40 — Beta Crew",
    ]);
  });

  it("returns an empty map for no entries", () => {
    expect(buildAlbumDisplayMap([]).size).toBe(0);
  });
});
