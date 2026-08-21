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
  albumLabelForTrack,
  albumLabelsForTrack,
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
