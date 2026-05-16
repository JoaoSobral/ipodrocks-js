/**
 * @vitest-environment node
 *
 * Regression coverage for smart-playlist resolution edge cases:
 * empty rule, NULL genre/artist tracks, duplicate rules, and very large
 * track sets (track_limit honoured).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  canRunDbTests,
  closeDb,
  createTestDb,
  seedLibraryFolder,
  seedTrack,
  type TestDb,
} from "../harness";

import { PlaylistCore } from "../../main/playlists/playlist-core";

const itDb = it.skipIf(!canRunDbTests);

describe("smart playlists — regressions", () => {
  let db: TestDb;
  let core: PlaylistCore;
  let folderId: number;

  beforeEach(() => {
    if (!canRunDbTests) return;
    db = createTestDb();
    core = new PlaylistCore(db);
    folderId = seedLibraryFolder(db, { name: "M", path: "/m", contentType: "music" });
  });

  afterEach(() => {
    closeDb(db);
  });

  itDb("returns an empty track list when no track matches the rule", () => {
    seedTrack(db, { path: "/m/a.flac", title: "A", genre: "Rock", libraryFolderId: folderId });
    const id = core.createSmartPlaylist(
      "Empty",
      [{ id: 0, ruleType: "genre", targetId: 99999, targetLabel: "Nonexistent" }]
    );
    expect(core.getPlaylistTracks(id)).toEqual([]);
    expect(core.getPlaylistById(id)?.trackCount).toBe(0);
  });

  itDb("ignores tracks with NULL genre when rule is by genre", () => {
    seedTrack(db, { path: "/m/has.flac", title: "Genred", genre: "Jazz", libraryFolderId: folderId });
    seedTrack(db, { path: "/m/null.flac", title: "Genreless", libraryFolderId: folderId });
    const jazzId = (db.prepare("SELECT id FROM genres WHERE name = ?").get("Jazz") as { id: number }).id;
    const playlistId = core.createSmartPlaylist(
      "Jazz",
      [{ id: 0, ruleType: "genre", targetId: jazzId, targetLabel: "Jazz" }]
    );
    const titles = core.getPlaylistTracks(playlistId).map((t) => t.title);
    expect(titles).toEqual(["Genred"]);
  });

  itDb("does not produce duplicates when multiple rules match the same track", () => {
    const trackId = seedTrack(db, {
      path: "/m/both.flac",
      title: "Both",
      artist: "Beatles",
      genre: "Rock",
      libraryFolderId: folderId,
    });
    const beatlesId = (db.prepare("SELECT id FROM artists WHERE name = ?").get("Beatles") as { id: number }).id;
    const rockId = (db.prepare("SELECT id FROM genres WHERE name = ?").get("Rock") as { id: number }).id;

    const playlistId = core.createSmartPlaylist(
      "Beatles+Rock",
      [
        { id: 0, ruleType: "artist", targetId: beatlesId, targetLabel: "Beatles" },
        { id: 0, ruleType: "genre", targetId: rockId, targetLabel: "Rock" },
      ]
    );

    const tracks = core.getPlaylistTracks(playlistId);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].id).toBe(trackId);
  });

  itDb("excludes podcast/audiobook tracks from a music smart playlist", () => {
    seedTrack(db, { path: "/m/music.flac", title: "Music Track", genre: "Rock", libraryFolderId: folderId, contentType: "music" });
    seedTrack(db, { path: "/m/podcast.mp3", title: "Podcast Track", genre: "Rock", libraryFolderId: folderId, contentType: "podcast" });
    seedTrack(db, { path: "/m/book.mp3", title: "Audiobook Track", genre: "Rock", libraryFolderId: folderId, contentType: "audiobook" });

    const rockId = (db.prepare("SELECT id FROM genres WHERE name = ?").get("Rock") as { id: number }).id;
    const playlistId = core.createSmartPlaylist(
      "Music Only",
      [{ id: 0, ruleType: "genre", targetId: rockId, targetLabel: "Rock" }]
    );
    const titles = core.getPlaylistTracks(playlistId).map((t) => t.title);
    expect(titles).toEqual(["Music Track"]);
  });

  itDb("respects a trackLimit when many tracks match", () => {
    const rockId = (() => {
      db.prepare("INSERT INTO genres (name) VALUES ('Rock')").run();
      return (db.prepare("SELECT id FROM genres WHERE name = 'Rock'").get() as { id: number }).id;
    })();
    for (let i = 0; i < 20; i++) {
      seedTrack(db, {
        path: `/m/t${i}.flac`,
        title: `T${i}`,
        genre: "Rock",
        libraryFolderId: folderId,
      });
    }
    const playlistId = core.createSmartPlaylist(
      "Limit",
      [{ id: 0, ruleType: "genre", targetId: rockId, targetLabel: "Rock" }],
      "",
      5
    );
    expect(core.getPlaylistTracks(playlistId)).toHaveLength(5);
  });
});
