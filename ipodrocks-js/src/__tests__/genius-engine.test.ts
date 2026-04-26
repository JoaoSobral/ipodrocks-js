/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getAvailableGeniusTypes,
  buildAnalysisSummary,
  matchEventsToLibrary,
  generateGeniusPlaylist,
} from "../main/playlists/genius-engine";
import { SCHEMA_SQL } from "../main/database/schema";

let canRunDbTests = false;
try {
  const Database = require("better-sqlite3");
  const probe = new Database(":memory:");
  probe.close();
  canRunDbTests = true;
} catch {
  /* better-sqlite3 may be compiled for Electron's Node; skip DB tests */
}

function makeDb() {
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

function seedTrack(
  db: import("better-sqlite3").Database,
  opts: {
    title: string;
    filename: string;
    artist?: string;
    album?: string;
    rating?: number | null;
    playCount?: number;
  }
): number {
  const artistName = opts.artist ?? "Artist";
  db.prepare("INSERT OR IGNORE INTO artists (name) VALUES (?)").run(artistName);
  const artist = db.prepare("SELECT id FROM artists WHERE name = ?").get(artistName) as { id: number };

  db.prepare("INSERT OR IGNORE INTO genres (name) VALUES ('Rock')").run();
  const genre = db.prepare("SELECT id FROM genres WHERE name = 'Rock'").get() as { id: number };

  const albumTitle = opts.album ?? "Album";
  db.prepare("INSERT OR IGNORE INTO albums (title, artist_id) VALUES (?, ?)").run(albumTitle, artist.id);
  const album = db.prepare("SELECT id FROM albums WHERE title = ? AND artist_id = ?").get(albumTitle, artist.id) as { id: number };

  db.prepare("INSERT OR IGNORE INTO codecs (name) VALUES ('MP3')").run();
  const codec = db.prepare("SELECT id FROM codecs WHERE name = 'MP3'").get() as { id: number };

  db.prepare("INSERT OR IGNORE INTO library_folders (name, path, content_type) VALUES ('Music', '/music', 'music')").run();
  const folder = db.prepare("SELECT id FROM library_folders WHERE path = '/music'").get() as { id: number };

  return db.prepare(`
    INSERT INTO tracks (path, filename, title, artist_id, album_id, genre_id, codec_id, library_folder_id,
                        content_type, file_hash, metadata_hash, duration, play_count, rating)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'music', ?, ?, 200, ?, ?)
  `).run(
    `/music/${opts.filename}`,
    opts.filename,
    opts.title,
    artist.id,
    album.id,
    genre.id,
    codec.id,
    folder.id,
    `hash_${opts.filename}`,
    `mhash_${opts.filename}`,
    opts.playCount ?? 0,
    opts.rating ?? null,
  ).lastInsertRowid as number;
}

describe("genius-engine", () => {
  describe("getAvailableGeniusTypes", () => {
    it("returns array of genius type options", () => {
      const types = getAvailableGeniusTypes();
      expect(Array.isArray(types)).toBe(true);
      expect(types.length).toBeGreaterThan(0);
      expect(types[0]).toHaveProperty("value");
      expect(types[0]).toHaveProperty("label");
      expect(types[0]).toHaveProperty("description");
    });

    it("includes top_rated type", () => {
      const types = getAvailableGeniusTypes();
      const topRated = types.find((t) => t.value === "top_rated");
      expect(topRated).toBeDefined();
      expect(topRated?.label).toBe("Top Rated");
    });
  });

  describe("buildAnalysisSummary", () => {
    it("builds summary from events", () => {
      const events: { timestamp: number; completionRatio: number }[] = [
        { timestamp: 1000, completionRatio: 1 },
        { timestamp: 2000, completionRatio: 0.5 },
      ];
      const matched = events.map((e, i) => ({
        ...e,
        trackId: i + 1,
        artist: "A",
        album: "B",
        title: "T",
        genre: "G",
        duration: 180,
        rating: null,
      }));
      const summary = buildAnalysisSummary(events as never, matched as never);
      expect(summary.totalPlays).toBe(2);
      expect(summary.matchedPlays).toBe(2);
    });
  });

  describe("matchEventsToLibrary", () => {
    let db: import("better-sqlite3").Database;

    beforeEach(() => {
      if (!canRunDbTests) return;
      db = makeDb();
    });

    afterEach(() => {
      if (db) db.close();
    });

    it.skipIf(!canRunDbTests)("propagates rating from library to matched events", () => {
      seedTrack(db, { title: "Rated Song", filename: "rated.mp3", rating: 9 });

      const events = [
        { filePath: "/Music/Artist/Album/rated.mp3", timestamp: 1000, completionRatio: 1 },
      ];

      const matched = matchEventsToLibrary(events as never, db);
      expect(matched).toHaveLength(1);
      expect(matched[0].rating).toBe(9);
    });

    it.skipIf(!canRunDbTests)("sets rating null when track has no rating", () => {
      seedTrack(db, { title: "Unrated Song", filename: "unrated.mp3", rating: null });

      const events = [
        { filePath: "/Music/Artist/Album/unrated.mp3", timestamp: 1000, completionRatio: 1 },
      ];

      const matched = matchEventsToLibrary(events as never, db);
      expect(matched).toHaveLength(1);
      expect(matched[0].rating).toBeNull();
    });
  });

  describe("generateGeniusPlaylist — top_rated", () => {
    let db: import("better-sqlite3").Database;

    beforeEach(() => {
      if (!canRunDbTests) return;
      db = makeDb();
    });

    afterEach(() => {
      if (db) db.close();
    });

    it.skipIf(!canRunDbTests)("works with empty play history (no events needed)", () => {
      seedTrack(db, { title: "Five Stars", filename: "five.mp3", rating: 10 });

      const result = generateGeniusPlaylist("top_rated", [], db);
      expect(result.subtype).toBe("top_rated");
      expect(result.tracks).toHaveLength(1);
      expect(result.tracks[0].title).toBe("Five Stars");
      expect(result.tracks[0].rating).toBe(10);
    });

    it.skipIf(!canRunDbTests)("excludes tracks below 4 stars (rating < 8)", () => {
      seedTrack(db, { title: "Low Rated", filename: "low.mp3", rating: 4 });
      seedTrack(db, { title: "High Rated", filename: "high.mp3", rating: 8 });

      const result = generateGeniusPlaylist("top_rated", [], db);
      expect(result.tracks).toHaveLength(1);
      expect(result.tracks[0].title).toBe("High Rated");
    });

    it.skipIf(!canRunDbTests)("excludes tracks with no rating", () => {
      seedTrack(db, { title: "No Rating", filename: "norating.mp3", rating: null });

      const result = generateGeniusPlaylist("top_rated", [], db);
      expect(result.tracks).toHaveLength(0);
    });

    it.skipIf(!canRunDbTests)("orders by rating descending", () => {
      seedTrack(db, { title: "Rating 8", filename: "r8.mp3", rating: 8 });
      seedTrack(db, { title: "Rating 10", filename: "r10.mp3", rating: 10 });
      seedTrack(db, { title: "Rating 9", filename: "r9.mp3", rating: 9 });

      const result = generateGeniusPlaylist("top_rated", [], db, { maxTracks: 3 });
      expect(result.tracks[0].title).toBe("Rating 10");
      expect(result.tracks[1].title).toBe("Rating 9");
      expect(result.tracks[2].title).toBe("Rating 8");
    });

    it.skipIf(!canRunDbTests)("respects maxTracks option", () => {
      for (let i = 0; i < 5; i++) {
        seedTrack(db, { title: `Track ${i}`, filename: `t${i}.mp3`, rating: 8 });
      }

      const result = generateGeniusPlaylist("top_rated", [], db, { maxTracks: 2 });
      expect(result.tracks).toHaveLength(2);
    });
  });
});
