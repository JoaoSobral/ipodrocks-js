/**
 * @vitest-environment node
 *
 * Tests the custom-sync playlist matching logic:
 * tracks that belong to a selected playlist must be included in the sync,
 * even when no albums/artists/genres are selected.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SCHEMA_SQL } from "../main/database/schema";
import { PlaylistCore } from "../main/playlists/playlist-core";

let canRunDbTests = false;
try {
  const Database = require("better-sqlite3");
  const probe = new Database(":memory:");
  probe.close();
  canRunDbTests = true;
} catch {
  /* better-sqlite3 may be compiled for Electron's Node */
}

function makeDb() {
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

function seedTrack(
  db: import("better-sqlite3").Database,
  opts: { path: string; filename: string; title: string; contentType?: string }
): number {
  db.prepare("INSERT OR IGNORE INTO artists (name) VALUES ('Artist')").run();
  const artist = db.prepare("SELECT id FROM artists WHERE name = 'Artist'").get() as { id: number };
  db.prepare("INSERT OR IGNORE INTO genres (name) VALUES ('Rock')").run();
  const genre = db.prepare("SELECT id FROM genres WHERE name = 'Rock'").get() as { id: number };
  db.prepare("INSERT OR IGNORE INTO albums (title, artist_id) VALUES ('Album', ?)").run(artist.id);
  const album = db.prepare("SELECT id FROM albums WHERE title = 'Album'").get() as { id: number };
  db.prepare("INSERT OR IGNORE INTO codecs (name) VALUES ('MP3')").run();
  const codec = db.prepare("SELECT id FROM codecs WHERE name = 'MP3'").get() as { id: number };
  db.prepare("INSERT OR IGNORE INTO library_folders (name, path, content_type) VALUES ('Music', '/music', 'music')").run();
  const folder = db.prepare("SELECT id FROM library_folders WHERE path = '/music'").get() as { id: number };

  return db.prepare(`
    INSERT INTO tracks (path, filename, title, artist_id, album_id, genre_id, codec_id, library_folder_id,
                        content_type, file_hash, metadata_hash, duration, play_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 200, 0)
  `).run(
    opts.path, opts.filename, opts.title,
    artist.id, album.id, genre.id, codec.id, folder.id,
    opts.contentType ?? "music",
    `hash_${opts.filename}`, `mhash_${opts.filename}`
  ).lastInsertRowid as number;
}

/** Mirrors the ipc.ts custom-sync playlist path collection logic. */
function collectPlaylistTrackPaths(
  core: PlaylistCore,
  selectedPlaylistNames: string[]
): Set<string> {
  const playlistTrackPaths = new Set<string>();
  if (!selectedPlaylistNames.length) return playlistTrackPaths;
  const nameSet = new Set(selectedPlaylistNames);
  for (const pl of core.getPlaylists()) {
    if (nameSet.has(pl.name)) {
      for (const track of core.getPlaylistTracks(pl.id)) {
        playlistTrackPaths.add(track.path);
      }
    }
  }
  return playlistTrackPaths;
}

describe("custom sync: playlist track collection", () => {
  let db: import("better-sqlite3").Database;
  let core: PlaylistCore;

  beforeEach(() => {
    if (!canRunDbTests) return;
    db = makeDb();
    core = new PlaylistCore(db);
  });

  afterEach(() => { if (canRunDbTests && db) db.close(); });

  it.skipIf(!canRunDbTests)("collects track paths from a selected playlist", () => {
    const trackId = seedTrack(db, { path: "/music/a.mp3", filename: "a.mp3", title: "Track A" });
    const typeId = (db.prepare("SELECT id FROM playlist_types WHERE name = 'manual'").get() as { id: number }).id;
    db.prepare("INSERT INTO playlists (name, playlist_type_id) VALUES ('My Playlist', ?)").run(typeId);
    const pl = db.prepare("SELECT id FROM playlists WHERE name = 'My Playlist'").get() as { id: number };
    db.prepare("INSERT INTO playlist_items (playlist_id, track_id, position) VALUES (?, ?, 0)").run(pl.id, trackId);

    const paths = collectPlaylistTrackPaths(core, ["My Playlist"]);
    expect(paths.has("/music/a.mp3")).toBe(true);
  });

  it.skipIf(!canRunDbTests)("returns empty set when no playlists are selected", () => {
    seedTrack(db, { path: "/music/a.mp3", filename: "a.mp3", title: "Track A" });
    const paths = collectPlaylistTrackPaths(core, []);
    expect(paths.size).toBe(0);
  });

  it.skipIf(!canRunDbTests)("only collects tracks from selected playlists, not others", () => {
    const trackA = seedTrack(db, { path: "/music/a.mp3", filename: "a.mp3", title: "Track A" });
    const trackB = seedTrack(db, { path: "/music/b.mp3", filename: "b.mp3", title: "Track B" });
    const typeId = (db.prepare("SELECT id FROM playlist_types WHERE name = 'manual'").get() as { id: number }).id;
    db.prepare("INSERT INTO playlists (name, playlist_type_id) VALUES ('Playlist X', ?)").run(typeId);
    db.prepare("INSERT INTO playlists (name, playlist_type_id) VALUES ('Playlist Y', ?)").run(typeId);
    const plX = db.prepare("SELECT id FROM playlists WHERE name = 'Playlist X'").get() as { id: number };
    const plY = db.prepare("SELECT id FROM playlists WHERE name = 'Playlist Y'").get() as { id: number };
    db.prepare("INSERT INTO playlist_items (playlist_id, track_id, position) VALUES (?, ?, 0)").run(plX.id, trackA);
    db.prepare("INSERT INTO playlist_items (playlist_id, track_id, position) VALUES (?, ?, 0)").run(plY.id, trackB);

    const paths = collectPlaylistTrackPaths(core, ["Playlist X"]);
    expect(paths.has("/music/a.mp3")).toBe(true);
    expect(paths.has("/music/b.mp3")).toBe(false);
  });

  it.skipIf(!canRunDbTests)("collects tracks from multiple selected playlists", () => {
    const trackA = seedTrack(db, { path: "/music/a.mp3", filename: "a.mp3", title: "Track A" });
    const trackB = seedTrack(db, { path: "/music/b.mp3", filename: "b.mp3", title: "Track B" });
    const typeId = (db.prepare("SELECT id FROM playlist_types WHERE name = 'manual'").get() as { id: number }).id;
    db.prepare("INSERT INTO playlists (name, playlist_type_id) VALUES ('Playlist X', ?)").run(typeId);
    db.prepare("INSERT INTO playlists (name, playlist_type_id) VALUES ('Playlist Y', ?)").run(typeId);
    const plX = db.prepare("SELECT id FROM playlists WHERE name = 'Playlist X'").get() as { id: number };
    const plY = db.prepare("SELECT id FROM playlists WHERE name = 'Playlist Y'").get() as { id: number };
    db.prepare("INSERT INTO playlist_items (playlist_id, track_id, position) VALUES (?, ?, 0)").run(plX.id, trackA);
    db.prepare("INSERT INTO playlist_items (playlist_id, track_id, position) VALUES (?, ?, 0)").run(plY.id, trackB);

    const paths = collectPlaylistTrackPaths(core, ["Playlist X", "Playlist Y"]);
    expect(paths.has("/music/a.mp3")).toBe(true);
    expect(paths.has("/music/b.mp3")).toBe(true);
  });

  it.skipIf(!canRunDbTests)("music tracks in a playlist are included in sync when only playlist selected", () => {
    const trackA = seedTrack(db, { path: "/music/a.mp3", filename: "a.mp3", title: "Track A" });
    const trackB = seedTrack(db, { path: "/music/b.mp3", filename: "b.mp3", title: "Track B" });
    const typeId = (db.prepare("SELECT id FROM playlist_types WHERE name = 'manual'").get() as { id: number }).id;
    db.prepare("INSERT INTO playlists (name, playlist_type_id) VALUES ('Road Trip', ?)").run(typeId);
    const pl = db.prepare("SELECT id FROM playlists WHERE name = 'Road Trip'").get() as { id: number };
    db.prepare("INSERT INTO playlist_items (playlist_id, track_id, position) VALUES (?, ?, 0)").run(pl.id, trackA);

    const playlistTrackPaths = collectPlaylistTrackPaths(core, ["Road Trip"]);

    // Simulate ipc.ts matchMusic when only playlist selected (no albums/artists/genres)
    const albumSet = new Set<string>();
    const artistSet = new Set<string>();
    const genreSet = new Set<string>();

    const matchMusic = (t: Record<string, unknown>, p: string) => {
      if (playlistTrackPaths.has(p)) return true;
      const album = (String(t.album ?? "Unknown Album")).trim();
      const artist = (String(t.artist ?? "Unknown Artist")).trim();
      const genre = (String(t.genre ?? "Unknown Genre")).trim();
      const albumLabel = `${album} — ${artist}`;
      return albumSet.has(albumLabel) || artistSet.has(artist) || genreSet.has(genre);
    };

    const allTracks: Record<string, Record<string, unknown>> = {
      "/music/a.mp3": { id: trackA, path: "/music/a.mp3", album: "Album", artist: "Artist", genre: "Rock" },
      "/music/b.mp3": { id: trackB, path: "/music/b.mp3", album: "Album", artist: "Artist", genre: "Rock" },
    };

    const syncedTracks: Record<string, Record<string, unknown>> = {};
    for (const [p, t] of Object.entries(allTracks)) {
      if (matchMusic(t, p)) syncedTracks[p] = t;
    }

    expect(Object.keys(syncedTracks)).toContain("/music/a.mp3");
    expect(Object.keys(syncedTracks)).not.toContain("/music/b.mp3");
    expect(Object.keys(syncedTracks).length).toBeGreaterThan(0);
  });
});
