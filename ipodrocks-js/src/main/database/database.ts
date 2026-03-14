import Database from "better-sqlite3";
import { app } from "electron";
import path from "path";
import { SCHEMA_SQL } from "./schema";

export class AppDatabase {
  private db: Database.Database | null = null;
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath =
      dbPath ?? path.join(app.getPath("userData"), "ipodrock.db");
  }

  initialize(): void {
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA_SQL);
    this.migrateDevicesTable();
    this.migrateAudiobooks();
    this.migrateSavant();
    this.migratePlaybackLog();
    this.migrateAssistantChat();
  }

  private migrateAssistantChat(): void {
    if (!this.db) return;
    try {
      const tableExists = this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'assistant_chat_history'"
        )
        .get();
      if (!tableExists) {
        this.db.exec(`
          CREATE TABLE assistant_chat_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
            content TEXT NOT NULL,
            pinned INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `);
      } else {
        const cols = this.db
          .prepare("PRAGMA table_info(assistant_chat_history)")
          .all() as { name: string }[];
        const colNames = new Set(cols.map((r) => r.name));
        if (!colNames.has("pinned")) {
          this.db
            .prepare(
              "ALTER TABLE assistant_chat_history ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0"
            )
            .run();
        }
      }
    } catch (err) {
      console.error("[db] migration failed (assistant_chat_history):", err);
    }
  }

  private migrateSavant(): void {
    if (!this.db) return;
    try {
      const trackRows = this.db
        .prepare("PRAGMA table_info(tracks)")
        .all() as { name: string }[];
      const trackNames = new Set(trackRows.map((r) => r.name));
      if (!trackNames.has("key")) {
        this.db.prepare("ALTER TABLE tracks ADD COLUMN key TEXT").run();
      }
      if (!trackNames.has("bpm")) {
        this.db.prepare("ALTER TABLE tracks ADD COLUMN bpm REAL").run();
      }
      if (!trackNames.has("camelot")) {
        this.db.prepare("ALTER TABLE tracks ADD COLUMN camelot TEXT").run();
      }
      if (!trackNames.has("features_scanned")) {
        this.db
          .prepare(
            "ALTER TABLE tracks ADD COLUMN features_scanned INTEGER DEFAULT 0"
          )
          .run();
      }

      const playlistRows = this.db
        .prepare("PRAGMA table_info(playlists)")
        .all() as { name: string }[];
      const playlistNames = new Set(playlistRows.map((r) => r.name));
      if (!playlistNames.has("savant_config")) {
        this.db
          .prepare("ALTER TABLE playlists ADD COLUMN savant_config TEXT")
          .run();
      }
    } catch (err) {
      console.error("[db] migration failed (savant_config):", err);
    }
  }

  private migrateDevicesTable(): void {
    if (!this.db) return;
    try {
      const rows = this.db
        .prepare("PRAGMA table_info(devices)")
        .all() as { name: string }[];
      const names = new Set(rows.map((r) => r.name));
      if (!names.has("source_library_type")) {
        this.db
          .prepare(
            "ALTER TABLE devices ADD COLUMN source_library_type TEXT NOT NULL DEFAULT 'primary'"
          )
          .run();
      }
      if (!names.has("shadow_library_id")) {
        this.db
          .prepare(
            "ALTER TABLE devices ADD COLUMN shadow_library_id INTEGER"
          )
          .run();
      }
      if (!names.has("last_sync_count")) {
        this.db
          .prepare(
            "ALTER TABLE devices ADD COLUMN last_sync_count INTEGER DEFAULT 0"
          )
          .run();
      }
      if (!names.has("skip_playback_log")) {
        this.db
          .prepare(
            "ALTER TABLE devices ADD COLUMN skip_playback_log INTEGER NOT NULL DEFAULT 0"
          )
          .run();
      }
    } catch (err) {
      console.error("[db] migration failed (devices):", err);
    }
  }

  private migratePlaybackLog(): void {
    if (!this.db) return;
    try {
      const plRows = this.db
        .prepare("PRAGMA table_info(playback_logs)")
        .all() as { name: string }[];
      const plNames = new Set(plRows.map((r) => r.name));
      if (!plNames.has("device_db_id")) {
        this.db
          .prepare(
            "ALTER TABLE playback_logs ADD COLUMN device_db_id INTEGER REFERENCES devices(id)"
          )
          .run();
      }
      const indexes = this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='playback_logs'"
        )
        .all() as { name: string }[];
      const indexNames = new Set(indexes.map((i) => i.name));
      if (!indexNames.has("idx_playback_logs_device_timestamp_path")) {
        this.db
          .prepare(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_playback_logs_device_timestamp_path " +
              "ON playback_logs(device_db_id, timestamp_tick, file_path) " +
              "WHERE device_db_id IS NOT NULL"
          )
          .run();
      }
    } catch (err) {
      console.error("[db] migration failed (playback_logs):", err);
    }
  }

  private migrateAudiobooks(): void {
    if (!this.db) return;
    try {
      const devRows = this.db
        .prepare("PRAGMA table_info(devices)")
        .all() as { name: string }[];
      const devNames = new Set(devRows.map((r) => r.name));
      if (!devNames.has("audiobook_folder")) {
        this.db
          .prepare(
            "ALTER TABLE devices ADD COLUMN audiobook_folder TEXT NOT NULL DEFAULT 'Audiobooks'"
          )
          .run();
      }

      const syncRows = this.db
        .prepare("PRAGMA table_info(sync_configurations)")
        .all() as { name: string }[];
      const syncNames = new Set(syncRows.map((r) => r.name));
      if (!syncNames.has("include_audiobooks")) {
        this.db
          .prepare(
            "ALTER TABLE sync_configurations ADD COLUMN include_audiobooks INTEGER NOT NULL DEFAULT 1"
          )
          .run();
      }

      this.migrateContentTypeAudiobook();
    } catch (err) {
      console.error("[db] migration failed (migrateAudiobooks):", err);
    }
  }

  private migrateContentTypeAudiobook(): void {
    if (!this.db) return;
    try {
      const done = this.db
        .prepare(
          "SELECT value FROM app_settings WHERE key = 'migrate_audiobook_content_type_done'"
        )
        .get() as { value: string } | undefined;
      if (done?.value === "1") return;

      this.db.pragma("foreign_keys = OFF");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS library_folders_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          path TEXT NOT NULL UNIQUE,
          content_type TEXT NOT NULL CHECK(content_type IN ('music', 'podcast', 'audiobook')),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO library_folders_new SELECT id, name, path, content_type, created_at FROM library_folders;
        DROP TABLE library_folders;
        ALTER TABLE library_folders_new RENAME TO library_folders;
        CREATE INDEX IF NOT EXISTS idx_library_folders_content_type ON library_folders(content_type);
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS tracks_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          path TEXT UNIQUE NOT NULL,
          filename TEXT NOT NULL,
          title TEXT,
          track_number INTEGER,
          disc_number INTEGER,
          duration REAL,
          bitrate INTEGER,
          bits_per_sample INTEGER,
          file_size INTEGER,
          content_type TEXT NOT NULL CHECK(content_type IN ('music', 'podcast', 'audiobook')),
          library_folder_id INTEGER,
          artist_id INTEGER,
          album_id INTEGER,
          genre_id INTEGER,
          codec_id INTEGER,
          file_hash TEXT,
          play_count INTEGER DEFAULT 0,
          show_title TEXT,
          episode_number INTEGER,
          metadata_hash TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (library_folder_id) REFERENCES library_folders (id),
          FOREIGN KEY (artist_id) REFERENCES artists (id),
          FOREIGN KEY (album_id) REFERENCES albums (id),
          FOREIGN KEY (genre_id) REFERENCES genres (id),
          FOREIGN KEY (codec_id) REFERENCES codecs (id)
        );
        INSERT INTO tracks_new SELECT id, path, filename, title, track_number, disc_number, duration, bitrate, bits_per_sample, file_size, content_type, library_folder_id, artist_id, album_id, genre_id, codec_id, file_hash, play_count, show_title, episode_number, metadata_hash, created_at FROM tracks;
        DROP TABLE tracks;
        ALTER TABLE tracks_new RENAME TO tracks;
      `);
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_tracks_content_type ON tracks(content_type);
        CREATE INDEX IF NOT EXISTS idx_tracks_library_folder ON tracks(library_folder_id);
        CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist_id);
        CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album_id);
        CREATE INDEX IF NOT EXISTS idx_tracks_genre ON tracks(genre_id);
        CREATE INDEX IF NOT EXISTS idx_tracks_codec ON tracks(codec_id);
        CREATE INDEX IF NOT EXISTS idx_tracks_file_hash ON tracks(file_hash);
        CREATE INDEX IF NOT EXISTS idx_tracks_metadata_hash ON tracks(metadata_hash);
      `);
      this.db.pragma("foreign_keys = ON");
      this.db
        .prepare(
          "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('migrate_audiobook_content_type_done', '1', CURRENT_TIMESTAMP)"
        )
        .run();
    } catch (err) {
      console.error("[db] migration failed (migrateContentTypeAudiobook):", err);
      try {
        this.db?.pragma("foreign_keys = ON");
      } catch {
        // ignore
      }
    }
  }

  getConnection(): Database.Database {
    if (!this.db) {
      throw new Error("Database not initialized. Call initialize() first.");
    }
    return this.db;
  }

  getAll<T = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): T[] {
    return this.getConnection().prepare(sql).all(...params) as T[];
  }

  getOne<T = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): T | undefined {
    return this.getConnection().prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: unknown[]): Database.RunResult {
    return this.getConnection().prepare(sql).run(...params);
  }

  transaction<T>(fn: (db: Database.Database) => T): T {
    const conn = this.getConnection();
    const wrapped = conn.transaction(() => fn(conn));
    return wrapped();
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
