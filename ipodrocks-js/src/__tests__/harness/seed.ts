/**
 * Seed helpers for behavioral/regression tests.
 *
 * Each helper resolves or creates the related entities (artist/album/genre/
 * codec) and returns the inserted row id. Helpers are small and direct — they
 * do not aim to model every column.
 */
import type { TestDb } from "./db";

export interface SeedTrackInput {
  path: string;
  title?: string;
  artist?: string;
  album?: string;
  genre?: string;
  codec?: string;
  contentType?: "music" | "podcast" | "audiobook";
  libraryFolderId?: number;
  trackNumber?: number;
  discNumber?: number;
  duration?: number;
  bitrate?: number;
  fileSize?: number;
  rating?: number | null;
}

export interface SeedLibraryFolderInput {
  name: string;
  path: string;
  contentType?: "music" | "podcast" | "audiobook";
}

export function seedLibraryFolder(db: TestDb, input: SeedLibraryFolderInput): number {
  const result = db
    .prepare(
      "INSERT INTO library_folders (name, path, content_type) VALUES (?, ?, ?)"
    )
    .run(input.name, input.path, input.contentType ?? "music");
  return Number(result.lastInsertRowid);
}

function getOrCreate(
  db: TestDb,
  table: "artists" | "genres",
  name: string
): number {
  const existing = db
    .prepare(`SELECT id FROM ${table} WHERE name = ? COLLATE NOCASE`)
    .get(name) as { id: number } | undefined;
  if (existing) return existing.id;
  const result = db.prepare(`INSERT INTO ${table} (name) VALUES (?)`).run(name);
  return Number(result.lastInsertRowid);
}

function getOrCreateAlbum(db: TestDb, title: string, artistId: number): number {
  const existing = db
    .prepare("SELECT id FROM albums WHERE title = ? COLLATE NOCASE AND artist_id = ?")
    .get(title, artistId) as { id: number } | undefined;
  if (existing) return existing.id;
  const result = db
    .prepare("INSERT INTO albums (title, artist_id) VALUES (?, ?)")
    .run(title, artistId);
  return Number(result.lastInsertRowid);
}

function getOrCreateCodec(db: TestDb, name: string): number {
  const existing = db
    .prepare("SELECT id FROM codecs WHERE name = ?")
    .get(name) as { id: number } | undefined;
  if (existing) return existing.id;
  const result = db.prepare("INSERT INTO codecs (name) VALUES (?)").run(name);
  return Number(result.lastInsertRowid);
}

export function seedTrack(db: TestDb, input: SeedTrackInput): number {
  const artistId = getOrCreate(db, "artists", input.artist ?? "Unknown Artist");
  const albumId = getOrCreateAlbum(db, input.album ?? "Unknown Album", artistId);
  const genreId = input.genre ? getOrCreate(db, "genres", input.genre) : null;
  const codecId = getOrCreateCodec(db, input.codec ?? "FLAC");

  const filename = input.path.split("/").pop() ?? input.path;
  const result = db
    .prepare(
      `INSERT INTO tracks (path, filename, title, content_type, library_folder_id, artist_id, album_id, genre_id, codec_id, track_number, disc_number, duration, bitrate, file_size, rating)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.path,
      filename,
      input.title ?? filename,
      input.contentType ?? "music",
      input.libraryFolderId ?? null,
      artistId,
      albumId,
      genreId,
      codecId,
      input.trackNumber ?? null,
      input.discNumber ?? null,
      input.duration ?? null,
      input.bitrate ?? null,
      input.fileSize ?? null,
      input.rating ?? null
    );
  return Number(result.lastInsertRowid);
}

export interface SeedPlaylistInput {
  name: string;
  type?: "smart" | "custom" | "genius" | "savant";
  trackIds?: number[];
}

export function seedPlaylist(db: TestDb, input: SeedPlaylistInput): number {
  const typeName = input.type ?? "custom";
  const typeRow = db
    .prepare("SELECT id FROM playlist_types WHERE name = ?")
    .get(typeName) as { id: number } | undefined;
  if (!typeRow) {
    throw new Error(`playlist_types row missing for "${typeName}" — schema seed should populate it`);
  }
  const result = db
    .prepare("INSERT INTO playlists (name, playlist_type_id) VALUES (?, ?)")
    .run(input.name, typeRow.id);
  const playlistId = Number(result.lastInsertRowid);
  (input.trackIds ?? []).forEach((trackId, idx) => {
    db.prepare(
      "INSERT INTO playlist_items (playlist_id, track_id, position) VALUES (?, ?, ?)"
    ).run(playlistId, trackId, idx);
  });
  return playlistId;
}

export interface SeedDeviceInput {
  name: string;
  mountPath: string;
  autoPodcastsEnabled?: boolean;
  devMode?: boolean;
  modelInternal?: string;
}

export function seedDevice(db: TestDb, input: SeedDeviceInput): number {
  const mode = db
    .prepare("SELECT id FROM device_transfer_modes WHERE name = 'copy'")
    .get() as { id: number } | undefined;
  if (!mode) {
    throw new Error("device_transfer_modes 'copy' missing — schema seed should populate it");
  }
  const modelId =
    input.modelInternal
      ? (db
          .prepare("SELECT id FROM device_models WHERE internal_value = ?")
          .get(input.modelInternal) as { id: number } | undefined)?.id ?? null
      : null;
  const result = db
    .prepare(
      `INSERT INTO devices
        (name, mount_path, default_transfer_mode_id, model_id, auto_podcasts_enabled, dev_mode)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.name,
      input.mountPath,
      mode.id,
      modelId,
      input.autoPodcastsEnabled ? 1 : 0,
      input.devMode ? 1 : 0
    );
  return Number(result.lastInsertRowid);
}
