import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp" } }));

import { AppDatabase } from "../main/database/database";

describe("AppDatabase", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = new AppDatabase(":memory:");
    db.initialize();
  });

  afterEach(() => {
    db.close();
  });

  it("creates an in-memory database", () => {
    expect(db.getConnection()).toBeDefined();
  });

  it("initializes all schema tables", () => {
    const tables = db
      .getAll<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      )
      .map((r) => r.name);

    const expected = [
      "albums",
      "app_settings",
      "artists",
      "codec_configurations",
      "codecs",
      "content_hashes",
      "device_file_cache",
      "device_log_cache",
      "device_models",
      "device_synced_tracks",
      "device_transfer_modes",
      "devices",
      "genius_playlist_configs",
      "genres",
      "library_folders",
      "playlist_items",
      "playlist_types",
      "playlists",
      "playback_logs",
      "playback_stats",
      "smart_playlist_rules",
      "sync_configurations",
      "sync_history",
      "sync_items",
      "sync_rules",
      "tracks",
    ];
    for (const t of expected) {
      expect(tables).toContain(t);
    }
  });

  describe("getAll / getOne / run helpers", () => {
    it("run inserts a row and getOne retrieves it", () => {
      db.run(
        "INSERT INTO library_folders (name, path, content_type) VALUES (?, ?, ?)",
        "Music",
        "/music",
        "music"
      );

      const row = db.getOne<{ id: number; name: string }>(
        "SELECT id, name FROM library_folders WHERE path = ?",
        "/music"
      );
      expect(row).toBeDefined();
      expect(row!.name).toBe("Music");
    });

    it("getAll returns multiple rows", () => {
      db.run(
        "INSERT INTO library_folders (name, path, content_type) VALUES (?, ?, ?)",
        "Music",
        "/music",
        "music"
      );
      db.run(
        "INSERT INTO library_folders (name, path, content_type) VALUES (?, ?, ?)",
        "Podcasts",
        "/pods",
        "podcast"
      );

      const rows = db.getAll<{ name: string }>(
        "SELECT name FROM library_folders"
      );
      expect(rows).toHaveLength(2);
    });

    it("accepts content_type audiobook in library_folders", () => {
      db.run(
        "INSERT INTO library_folders (name, path, content_type) VALUES (?, ?, ?)",
        "Audiobooks",
        "/audiobooks",
        "audiobook"
      );
      const row = db.getOne<{ name: string; content_type: string }>(
        "SELECT name, content_type FROM library_folders WHERE path = ?",
        "/audiobooks"
      );
      expect(row?.name).toBe("Audiobooks");
      expect(row?.content_type).toBe("audiobook");
    });

    it("getOne returns undefined for missing row", () => {
      const row = db.getOne("SELECT * FROM library_folders WHERE id = ?", 999);
      expect(row).toBeUndefined();
    });
  });

  describe("transaction", () => {
    it("commits on success", () => {
      db.transaction((conn) => {
        conn
          .prepare(
            "INSERT INTO library_folders (name, path, content_type) VALUES (?, ?, ?)"
          )
          .run("Test", "/test", "music");
      });

      const row = db.getOne<{ name: string }>(
        "SELECT name FROM library_folders WHERE path = ?",
        "/test"
      );
      expect(row?.name).toBe("Test");
    });

    it("rolls back on error", () => {
      expect(() =>
        db.transaction((conn) => {
          conn
            .prepare(
              "INSERT INTO library_folders (name, path, content_type) VALUES (?, ?, ?)"
            )
            .run("Before", "/before", "music");
          throw new Error("boom");
        })
      ).toThrow("boom");

      const row = db.getOne(
        "SELECT * FROM library_folders WHERE path = ?",
        "/before"
      );
      expect(row).toBeUndefined();
    });
  });

  it("throws when getConnection called before initialize", () => {
    const uninit = new AppDatabase(":memory:");
    expect(() => uninit.getConnection()).toThrow("Database not initialized");
  });
});
