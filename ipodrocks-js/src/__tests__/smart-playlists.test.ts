/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SmartPlaylistGenerator } from "../main/playlists/smart-playlists";
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

describe("SmartPlaylistGenerator", () => {
  let db: import("better-sqlite3").Database;

  beforeEach(() => {
    if (!canRunDbTests) return;
    db = makeDb();
  });

  afterEach(() => {
    if (db) db.close();
  });

  describe("getAvailableTypes", () => {
    it.skipIf(!canRunDbTests)("includes top_rated", () => {
      const gen = new SmartPlaylistGenerator(db);
      expect(gen.getAvailableTypes()).toContain("top_rated");
    });
  });

  describe("top_rated", () => {
    it.skipIf(!canRunDbTests)("returns only tracks rated 4+ stars (rating >= 8)", () => {
      seedTrack(db, { title: "Four Stars", filename: "four.mp3", rating: 8 });
      seedTrack(db, { title: "Two Stars", filename: "two.mp3", rating: 4 });
      seedTrack(db, { title: "No Rating", filename: "none.mp3", rating: null });

      const gen = new SmartPlaylistGenerator(db);
      const result = gen.generate("top_rated");

      expect(result.subtype).toBe("top_rated");
      expect(result.tracks).toHaveLength(1);
      expect(result.tracks[0].title).toBe("Four Stars");
    });

    it.skipIf(!canRunDbTests)("populates rating on returned tracks", () => {
      seedTrack(db, { title: "Five Stars", filename: "five.mp3", rating: 10 });

      const gen = new SmartPlaylistGenerator(db);
      const result = gen.generate("top_rated");

      expect(result.tracks[0].rating).toBe(10);
    });

    it.skipIf(!canRunDbTests)("returns empty result when no rated tracks exist", () => {
      seedTrack(db, { title: "Unrated", filename: "unrated.mp3", rating: null });

      const gen = new SmartPlaylistGenerator(db);
      const result = gen.generate("top_rated");

      expect(result.tracks).toHaveLength(0);
      expect(result.subtype).toBe("empty");
    });

    it.skipIf(!canRunDbTests)("respects limit option", () => {
      for (let i = 0; i < 5; i++) {
        seedTrack(db, { title: `Track ${i}`, filename: `t${i}.mp3`, rating: 8 });
      }

      const gen = new SmartPlaylistGenerator(db);
      const result = gen.generate("top_rated", { limit: 2 });
      expect(result.tracks).toHaveLength(2);
    });
  });
});
