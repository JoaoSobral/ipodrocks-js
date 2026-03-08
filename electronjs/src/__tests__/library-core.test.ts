import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp" } }));

import { AppDatabase } from "../main/database/database";
import { LibraryCore } from "../main/library/library-core";

function makeDb(): AppDatabase {
  const db = new AppDatabase(":memory:");
  db.initialize();
  return db;
}

describe("LibraryCore", () => {
  let appDb: AppDatabase;
  let lib: LibraryCore;

  beforeEach(() => {
    appDb = makeDb();
    lib = new LibraryCore(appDb.getConnection());
  });

  afterEach(() => {
    appDb.close();
  });

  describe("addLibraryFolder", () => {
    it("inserts and retrieves a folder", () => {
      const id = lib.addLibraryFolder("My Music", "/home/music", "music");
      expect(id).toBeGreaterThan(0);

      const folders = lib.getLibraryFolders();
      expect(folders).toHaveLength(1);
      expect(folders[0].name).toBe("My Music");
      expect(folders[0].contentType).toBe("music");
    });

    it("throws on invalid content type", () => {
      expect(() =>
        lib.addLibraryFolder("Bad", "/bad", "invalid" as never)
      ).toThrow();
    });
  });

  describe("addOrUpdateTrack", () => {
    let folderId: number;

    beforeEach(() => {
      folderId = lib.addLibraryFolder("Music", "/music", "music");
    });

    it("inserts a new track", () => {
      lib.addOrUpdateTrack(
        "/music/song.flac",
        "song.flac",
        "Song Title",
        "1",
        "1",
        240,
        320000,
        16,
        5000000,
        "music",
        folderId,
        "Artist",
        "Album",
        "Rock",
        "FLAC",
        "abc123",
        "meta456"
      );

      const tracks = lib.getTracks();
      expect(tracks).toHaveLength(1);
      expect(tracks[0].title).toBe("Song Title");
      expect(tracks[0].artist).toBe("Artist");
      expect(tracks[0].album).toBe("Album");
    });

    it("updates an existing track on conflict", () => {
      lib.addOrUpdateTrack(
        "/music/song.flac",
        "song.flac",
        "Original",
        "1",
        "1",
        240,
        320000,
        16,
        5000000,
        "music",
        folderId,
        "Artist",
        "Album",
        "Rock",
        "FLAC",
        "abc123"
      );

      lib.addOrUpdateTrack(
        "/music/song.flac",
        "song.flac",
        "Updated Title",
        "1",
        "1",
        240,
        320000,
        16,
        5000000,
        "music",
        folderId,
        "Artist",
        "Album",
        "Rock",
        "FLAC",
        "abc123"
      );

      const tracks = lib.getTracks();
      expect(tracks).toHaveLength(1);
      expect(tracks[0].title).toBe("Updated Title");
    });
  });

  describe("getTracks", () => {
    let musicFolderId: number;
    let podcastFolderId: number;

    beforeEach(() => {
      musicFolderId = lib.addLibraryFolder("Music", "/music", "music");
      podcastFolderId = lib.addLibraryFolder("Pods", "/pods", "podcast");

      lib.addOrUpdateTrack(
        "/music/a.flac",
        "a.flac",
        "Song A",
        "1",
        "1",
        200,
        320000,
        16,
        4000000,
        "music",
        musicFolderId,
        "Artist A",
        "Album A",
        "Rock",
        "FLAC",
        "h1"
      );

      lib.addOrUpdateTrack(
        "/pods/ep1.mp3",
        "ep1.mp3",
        "Episode 1",
        "1",
        "1",
        3600,
        128000,
        null,
        50000000,
        "podcast",
        podcastFolderId,
        "Host",
        "Show",
        "Talk",
        "MP3",
        "h2"
      );
    });

    it("returns tracks with artist/album/genre JOINs", () => {
      const tracks = lib.getTracks();
      expect(tracks).toHaveLength(2);

      const song = tracks.find((t) => t.title === "Song A")!;
      expect(song.artist).toBe("Artist A");
      expect(song.album).toBe("Album A");
      expect(song.genre).toBe("Rock");
    });

    it("filters by contentType", () => {
      const podcasts = lib.getTracks({ contentType: "podcast" });
      expect(podcasts).toHaveLength(1);
      expect(podcasts[0].title).toBe("Episode 1");
    });
  });

  describe("getTrackByPath", () => {
    it("finds a track by path", () => {
      const folderId = lib.addLibraryFolder("Music", "/music", "music");
      lib.addOrUpdateTrack(
        "/music/song.flac",
        "song.flac",
        "Found Me",
        "1",
        "1",
        200,
        320000,
        16,
        4000000,
        "music",
        folderId,
        "Artist",
        "Album",
        "Genre",
        "FLAC",
        "hash1"
      );

      const track = lib.getTrackByPath("/music/song.flac");
      expect(track).toBeDefined();
      expect(track!.title).toBe("Found Me");
    });

    it("returns undefined for unknown path", () => {
      expect(lib.getTrackByPath("/nope")).toBeUndefined();
    });
  });

  describe("deleteTrack", () => {
    it("removes a track", () => {
      const folderId = lib.addLibraryFolder("Music", "/music", "music");
      lib.addOrUpdateTrack(
        "/music/del.flac",
        "del.flac",
        "Delete Me",
        "1",
        "1",
        200,
        320000,
        16,
        4000000,
        "music",
        folderId,
        "Artist",
        "Album",
        "Genre",
        "FLAC",
        "hash1"
      );

      const deleted = lib.deleteTrack("/music/del.flac");
      expect(deleted).toBe(true);
      expect(lib.getTrackByPath("/music/del.flac")).toBeUndefined();
    });

    it("returns false for non-existent path", () => {
      expect(lib.deleteTrack("/nonexistent")).toBe(false);
    });
  });
});
