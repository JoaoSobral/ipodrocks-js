/**
 * @vitest-environment node
 *
 * Issue #82: when "mirror library folder structure" is enabled, the device path
 * must reproduce the source folder layout 1:1 — including album folders that
 * carry the year in parentheses (e.g. "Levels (2011)") — instead of rebuilding
 * the path from artist/album tags (which drops the year).
 */
import { describe, it, expect } from "vitest";
import * as path from "path";
import { computeDeviceRelativePath } from "../main/sync/sync-core";

const LIB_ROOT = path.resolve("/music-library");
const folderPaths = new Map<number, string>([[1, LIB_ROOT]]);

// Source folder keeps the year; the album *tag* does not.
const trackPath = path.join(
  LIB_ROOT,
  "Avicii",
  "Levels (2011)",
  "Avicii - Levels - 01 - Levels.flac"
);
const trackInfo = {
  artist: "Avicii",
  album: "Levels",
  libraryFolderId: 1,
};

describe("computeDeviceRelativePath — preserveFolderStructure (issue #82)", () => {
  it("mirrors the source folder layout (keeps the year) when enabled", () => {
    const rel = computeDeviceRelativePath(
      trackPath,
      trackInfo,
      "music",
      { libraryFolderPaths: folderPaths, preserveFolderStructure: true }
    );
    expect(rel).toBe("Avicii/Levels (2011)/Avicii - Levels - 01 - Levels.flac");
  });

  it("rebuilds from tags (drops the year) when disabled — existing behavior", () => {
    const rel = computeDeviceRelativePath(
      trackPath,
      trackInfo,
      "music",
      { libraryFolderPaths: folderPaths, preserveFolderStructure: false }
    );
    expect(rel).toBe("Avicii/Levels/Avicii - Levels - 01 - Levels.flac");
  });

  it("defaults to the tag-based path when the flag is omitted", () => {
    const rel = computeDeviceRelativePath(trackPath, trackInfo, "music", {
      libraryFolderPaths: folderPaths,
    });
    expect(rel).toBe("Avicii/Levels/Avicii - Levels - 01 - Levels.flac");
  });

  it("strips a leading 'Music' content folder when mirroring", () => {
    const p = path.join(LIB_ROOT, "Music", "Daft Punk", "Discovery (2001)", "01.flac");
    const rel = computeDeviceRelativePath(
      p,
      { artist: "Daft Punk", album: "Discovery", libraryFolderId: 1 },
      "music",
      { libraryFolderPaths: folderPaths, preserveFolderStructure: true }
    );
    expect(rel).toBe("Daft Punk/Discovery (2001)/01.flac");
  });

  it("falls back to the tag-based path when the track is outside any library root", () => {
    const outside = path.resolve("/elsewhere", "Artist", "Album (1999)", "x.flac");
    const rel = computeDeviceRelativePath(
      outside,
      { artist: "Artist", album: "Album", libraryFolderId: 1 },
      "music",
      { libraryFolderPaths: folderPaths, preserveFolderStructure: true }
    );
    // No mirror possible → tag-based path (year dropped).
    expect(rel).toBe("Artist/Album/x.flac");
  });
});

/**
 * Issue #113: with mirroring OFF the path is rebuilt from tags, and the artist
 * component must come from the album artist so a compilation lands in one
 * folder instead of one per contributing track artist.
 */
describe("computeDeviceRelativePath — albumGrouping (issue #113)", () => {
  const compilationPath = path.join(
    LIB_ROOT,
    "Compilations",
    "Now 40",
    "01 - Alpha Band.flac"
  );
  const compilationTrack = {
    artist: "Alpha Band",
    albumArtist: "Various Artists",
    album: "Now 40",
    libraryFolderId: 1,
  };

  it("uses the album artist by default", () => {
    expect(
      computeDeviceRelativePath(compilationPath, compilationTrack, "music", {
        libraryFolderPaths: folderPaths,
        preserveFolderStructure: false,
      })
    ).toBe("Various Artists/Now 40/01 - Alpha Band.flac");
  });

  it("uses the track artist when grouping is track-artist", () => {
    expect(
      computeDeviceRelativePath(
        compilationPath,
        compilationTrack,
        "music",
        {
          libraryFolderPaths: folderPaths,
          preserveFolderStructure: false,
          albumGrouping: "track-artist",
        }
      )
    ).toBe("Alpha Band/Now 40/01 - Alpha Band.flac");
  });

  it("gives every track of a compilation the same album folder", () => {
    const dests = ["Alpha Band", "Beta Crew", "Gamma Trio"].map((artist) =>
      computeDeviceRelativePath(
        path.join(LIB_ROOT, "Compilations", "Now 40", `${artist}.flac`),
        { ...compilationTrack, artist },
        "music",
        {
          libraryFolderPaths: folderPaths,
          preserveFolderStructure: false,
          albumGrouping: "album-artist",
        }
      )
    );
    expect(new Set(dests.map((d) => path.posix.dirname(d))).size).toBe(1);
  });

  it("falls back to the track artist when no album artist is tagged", () => {
    expect(
      computeDeviceRelativePath(trackPath, trackInfo, "music", {
        libraryFolderPaths: folderPaths,
        preserveFolderStructure: false,
        albumGrouping: "album-artist",
      })
    ).toBe("Avicii/Levels/Avicii - Levels - 01 - Levels.flac");
  });

  it("is ignored while mirroring is on — the source layout still wins", () => {
    expect(
      computeDeviceRelativePath(
        compilationPath,
        compilationTrack,
        "music",
        {
          libraryFolderPaths: folderPaths,
          preserveFolderStructure: true,
          albumGrouping: "album-artist",
        }
      )
    ).toBe("Compilations/Now 40/01 - Alpha Band.flac");
  });
});
