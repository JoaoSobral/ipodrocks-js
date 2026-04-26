/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PlaylistCore } from "../main/playlists/playlist-core";
import { SCHEMA_SQL } from "../main/database/schema";
import type { SmartPlaylistRule } from "../shared/types";

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
    genre?: string;
    contentType?: string;
  }
): { trackId: number; artistId: number; albumId: number; genreId: number } {
  const artistName = opts.artist ?? "Artist";
  db.prepare("INSERT OR IGNORE INTO artists (name) VALUES (?)").run(artistName);
  const artist = db.prepare("SELECT id FROM artists WHERE name = ?").get(artistName) as { id: number };

  const genreName = opts.genre ?? "Rock";
  db.prepare("INSERT OR IGNORE INTO genres (name) VALUES (?)").run(genreName);
  const genre = db.prepare("SELECT id FROM genres WHERE name = ?").get(genreName) as { id: number };

  const albumTitle = opts.album ?? "Album";
  db.prepare("INSERT OR IGNORE INTO albums (title, artist_id) VALUES (?, ?)").run(albumTitle, artist.id);
  const album = db.prepare("SELECT id FROM albums WHERE title = ? AND artist_id = ?").get(albumTitle, artist.id) as { id: number };

  db.prepare("INSERT OR IGNORE INTO codecs (name) VALUES ('MP3')").run();
  const codec = db.prepare("SELECT id FROM codecs WHERE name = 'MP3'").get() as { id: number };

  db.prepare("INSERT OR IGNORE INTO library_folders (name, path, content_type) VALUES ('Music', '/music', 'music')").run();
  const folder = db.prepare("SELECT id FROM library_folders WHERE path = '/music'").get() as { id: number };

  const contentType = opts.contentType ?? "music";
  const trackId = db.prepare(`
    INSERT INTO tracks (path, filename, title, artist_id, album_id, genre_id, codec_id, library_folder_id,
                        content_type, file_hash, metadata_hash, duration)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 200)
  `).run(
    `/music/${opts.filename}`,
    opts.filename,
    opts.title,
    artist.id,
    album.id,
    genre.id,
    codec.id,
    folder.id,
    contentType,
    `hash_${opts.filename}`,
    `mhash_${opts.filename}`,
  ).lastInsertRowid as number;

  return { trackId, artistId: artist.id, albumId: album.id, genreId: genre.id };
}

function rule(ruleType: string, targetId: number): SmartPlaylistRule {
  return { ruleType, targetId, targetLabel: "" };
}

describe("PlaylistCore.previewSmartTracks", () => {
  let db: import("better-sqlite3").Database;
  let core: PlaylistCore;

  beforeEach(() => {
    if (!canRunDbTests) return;
    db = makeDb();
    core = new PlaylistCore(db);
  });

  afterEach(() => {
    if (db) db.close();
  });

  it.skipIf(!canRunDbTests)("single genre — returns all tracks of that genre", () => {
    const { genreId } = seedTrack(db, { title: "T1", filename: "t1.mp3", genre: "Jazz" });
    seedTrack(db, { title: "T2", filename: "t2.mp3", genre: "Rock" });

    const res = core.previewSmartTracks([rule("genre", genreId)]);
    expect(res.count).toBe(1);
    expect(res.totalCount).toBe(1);
  });

  it.skipIf(!canRunDbTests)("multi-genre OR-within-type — returns tracks matching any listed genre", () => {
    const { genreId: jazzId } = seedTrack(db, { title: "Jazz1", filename: "j1.mp3", genre: "Jazz" });
    const { genreId: bluesId } = seedTrack(db, { title: "Blues1", filename: "b1.mp3", genre: "Blues" });
    seedTrack(db, { title: "Rock1", filename: "r1.mp3", genre: "Rock" });

    const res = core.previewSmartTracks([rule("genre", jazzId), rule("genre", bluesId)]);
    expect(res.count).toBe(2);
  });

  it.skipIf(!canRunDbTests)("multi-artist OR-within-type — returns tracks for any listed artist", () => {
    const { artistId: davisId } = seedTrack(db, { title: "Blue", filename: "blue.mp3", artist: "Miles Davis" });
    const { artistId: coltraneId } = seedTrack(db, { title: "Giant", filename: "giant.mp3", artist: "Coltrane" });
    seedTrack(db, { title: "Other", filename: "other.mp3", artist: "Someone Else" });

    const res = core.previewSmartTracks([rule("artist", davisId), rule("artist", coltraneId)]);
    expect(res.count).toBe(2);
  });

  it.skipIf(!canRunDbTests)("multi-album OR-within-type — returns tracks from any listed album", () => {
    const { albumId: kindId } = seedTrack(db, { title: "Track A", filename: "a.mp3", album: "Kind of Blue", artist: "Miles Davis" });
    const { albumId: giantId } = seedTrack(db, { title: "Track B", filename: "b.mp3", album: "Giant Steps", artist: "Coltrane" });
    seedTrack(db, { title: "Track C", filename: "c.mp3", album: "Other Album", artist: "Someone" });

    const res = core.previewSmartTracks([rule("album", kindId), rule("album", giantId)]);
    expect(res.count).toBe(2);
  });

  it.skipIf(!canRunDbTests)("genre + artist OR-across-type — returns tracks matching either", () => {
    const { genreId: jazzId } = seedTrack(db, { title: "Jazz Davis", filename: "jd.mp3", artist: "Miles Davis", genre: "Jazz" });
    const artist = db.prepare("SELECT id FROM artists WHERE name = 'Miles Davis'").get() as { id: number };
    const davisId = artist.id;
    // Rock track by Davis — included (matches artist)
    seedTrack(db, { title: "Rock Davis", filename: "rd.mp3", artist: "Miles Davis", genre: "Rock" });
    // Jazz track by someone else — included (matches genre)
    seedTrack(db, { title: "Jazz Other", filename: "jo.mp3", artist: "Coltrane", genre: "Jazz" });

    const res = core.previewSmartTracks([rule("genre", jazzId), rule("artist", davisId)]);
    expect(res.count).toBe(3);
  });

  it.skipIf(!canRunDbTests)("all three types combined — OR union across genre+artist+album", () => {
    const { genreId: jazzId, artistId: davisId, albumId: kindId } = seedTrack(db, {
      title: "So What", filename: "sowhat.mp3", artist: "Miles Davis", genre: "Jazz", album: "Kind of Blue",
    });
    // Matches genre+artist — included
    seedTrack(db, { title: "Freddie", filename: "freddie.mp3", artist: "Miles Davis", genre: "Jazz", album: "Other" });
    // Matches genre+album — included
    seedTrack(db, { title: "Blue", filename: "blue2.mp3", artist: "Evans", genre: "Jazz", album: "Kind of Blue" });
    // Matches none — excluded
    seedTrack(db, { title: "Pop", filename: "pop.mp3", artist: "Someone", genre: "Pop", album: "PopAlbum" });

    const res = core.previewSmartTracks([rule("genre", jazzId), rule("artist", davisId), rule("album", kindId)]);
    expect(res.count).toBe(3);
  });

  it.skipIf(!canRunDbTests)("disjoint album + artist — returns both sets as union", () => {
    const { albumId: kindId } = seedTrack(db, { title: "Track", filename: "t.mp3", artist: "Davis", album: "Kind of Blue" });
    const { artistId: coltraneId } = seedTrack(db, { title: "Giant", filename: "g.mp3", artist: "Coltrane", album: "Giant Steps" });

    const res = core.previewSmartTracks([rule("album", kindId), rule("artist", coltraneId)]);
    expect(res.count).toBe(2);
  });

  it.skipIf(!canRunDbTests)("trackLimit is honored when many rules match", () => {
    const { genreId: jazzId } = seedTrack(db, { title: "J1", filename: "j1.mp3", genre: "Jazz" });
    seedTrack(db, { title: "J2", filename: "j2.mp3", artist: "B", genre: "Jazz" });
    seedTrack(db, { title: "J3", filename: "j3.mp3", artist: "C", genre: "Jazz" });
    seedTrack(db, { title: "J4", filename: "j4.mp3", artist: "D", genre: "Jazz" });
    seedTrack(db, { title: "J5", filename: "j5.mp3", artist: "E", genre: "Jazz" });

    const res = core.previewSmartTracks([rule("genre", jazzId)], 3);
    expect(res.count).toBe(3);
    expect(res.totalCount).toBe(5);
  });

  it.skipIf(!canRunDbTests)("totalCount equals count when under the limit", () => {
    const { genreId: jazzId } = seedTrack(db, { title: "J1", filename: "j1.mp3", genre: "Jazz" });
    seedTrack(db, { title: "J2", filename: "j2.mp3", artist: "B", genre: "Jazz" });

    const res = core.previewSmartTracks([rule("genre", jazzId)], 10);
    expect(res.count).toBe(2);
    expect(res.totalCount).toBe(2);
  });

  it.skipIf(!canRunDbTests)("non-music tracks excluded — podcasts not in results", () => {
    const { genreId: jazzId } = seedTrack(db, { title: "Music track", filename: "music.mp3", genre: "Jazz" });
    // Seed a podcast with the same genre
    seedTrack(db, { title: "Podcast ep", filename: "pod.mp3", genre: "Jazz", contentType: "podcast" });

    const res = core.previewSmartTracks([rule("genre", jazzId)]);
    expect(res.count).toBe(1);
  });

  it.skipIf(!canRunDbTests)("affected IDs reflect metadata from matched tracks", () => {
    const { genreId: jazzId, artistId: davisId, albumId: kindId } = seedTrack(db, {
      title: "So What", filename: "sowhat.mp3", artist: "Miles Davis", genre: "Jazz", album: "Kind of Blue",
    });

    const res = core.previewSmartTracks([rule("genre", jazzId)]);
    expect(res.affectedArtistIds).toContain(davisId);
    expect(res.affectedAlbumIds).toContain(kindId);
    expect(res.affectedGenreIds).toContain(jazzId);
  });
});
