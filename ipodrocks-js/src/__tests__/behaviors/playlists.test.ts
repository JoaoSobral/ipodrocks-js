/**
 * @vitest-environment node
 *
 * Behavioral journeys for playlists — creating smart playlists with rules
 * (genre, artist, album), retrieving their tracks, and listing/deleting them.
 *
 * Drives the `PlaylistCore` class directly (the same object the `playlist:*`
 * IPC handlers in `src/main/ipc/` delegate to).
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

describe("Playlists — smart playlist journey", () => {
  let db: TestDb;
  let core: PlaylistCore;
  let folderId: number;

  beforeEach(() => {
    if (!canRunDbTests) return;
    db = createTestDb();
    core = new PlaylistCore(db);
    folderId = seedLibraryFolder(db, { name: "Music", path: "/music", contentType: "music" });
  });

  afterEach(() => {
    closeDb(db);
  });

  itDb("creates a smart playlist with a genre rule and resolves matching tracks", () => {
    seedTrack(db, { path: "/music/a.flac", title: "Rock Song", artist: "A", album: "X", genre: "Rock", libraryFolderId: folderId });
    seedTrack(db, { path: "/music/b.flac", title: "Pop Song", artist: "B", album: "Y", genre: "Pop", libraryFolderId: folderId });
    seedTrack(db, { path: "/music/c.flac", title: "Rock Other", artist: "C", album: "Z", genre: "Rock", libraryFolderId: folderId });

    const rockGenreId = (db.prepare("SELECT id FROM genres WHERE name = ?").get("Rock") as { id: number }).id;

    const playlistId = core.createSmartPlaylist(
      "Rock Mix",
      [{ id: 0, ruleType: "genre", targetId: rockGenreId, targetLabel: "Rock" }],
      ""
    );

    const tracks = core.getPlaylistTracks(playlistId);
    const titles = tracks.map((t) => t.title).sort();
    expect(titles).toEqual(["Rock Other", "Rock Song"]);
  });

  itDb("creates a smart playlist with multiple rules and unions matching tracks", () => {
    seedTrack(db, { path: "/music/a.flac", title: "Rock A", artist: "Beatles", album: "X", genre: "Rock", libraryFolderId: folderId });
    seedTrack(db, { path: "/music/b.flac", title: "Pop B", artist: "Beatles", album: "Y", genre: "Pop", libraryFolderId: folderId });
    seedTrack(db, { path: "/music/c.flac", title: "Rock C", artist: "Stones", album: "Z", genre: "Rock", libraryFolderId: folderId });
    seedTrack(db, { path: "/music/d.flac", title: "Jazz D", artist: "Davis", album: "W", genre: "Jazz", libraryFolderId: folderId });

    const beatlesId = (db.prepare("SELECT id FROM artists WHERE name = ?").get("Beatles") as { id: number }).id;
    const rockId = (db.prepare("SELECT id FROM genres WHERE name = ?").get("Rock") as { id: number }).id;

    const playlistId = core.createSmartPlaylist(
      "Beatles or Rock",
      [
        { id: 0, ruleType: "artist", targetId: beatlesId, targetLabel: "Beatles" },
        { id: 0, ruleType: "genre", targetId: rockId, targetLabel: "Rock" },
      ],
      ""
    );

    const titles = core.getPlaylistTracks(playlistId).map((t) => t.title).sort();
    expect(titles).toEqual(["Pop B", "Rock A", "Rock C"]);
    expect(titles).not.toContain("Jazz D");
  });

  itDb("lists smart playlists and excludes other types", () => {
    seedTrack(db, { path: "/music/a.flac", title: "T1", genre: "Rock", libraryFolderId: folderId });
    const rockId = (db.prepare("SELECT id FROM genres WHERE name = ?").get("Rock") as { id: number }).id;
    core.createSmartPlaylist("My Smart", [{ id: 0, ruleType: "genre", targetId: rockId, targetLabel: "Rock" }]);

    const customTypeId = (db.prepare("SELECT id FROM playlist_types WHERE name = 'custom'").get() as { id: number }).id;
    db.prepare("INSERT INTO playlists (name, playlist_type_id) VALUES (?, ?)").run("Manual List", customTypeId);

    const smart = core.getPlaylists("smart");
    expect(smart.map((p) => p.name)).toEqual(expect.arrayContaining(["smart_My Smart"]));
    expect(smart.every((p) => p.typeName === "smart")).toBe(true);

    const all = core.getPlaylists();
    expect(all.length).toBe(2);
  });

  itDb("deletes a smart playlist and removes its items and rules", () => {
    seedTrack(db, { path: "/music/a.flac", genre: "Rock", libraryFolderId: folderId });
    const rockId = (db.prepare("SELECT id FROM genres WHERE name = ?").get("Rock") as { id: number }).id;
    const id = core.createSmartPlaylist("Doomed", [{ id: 0, ruleType: "genre", targetId: rockId, targetLabel: "Rock" }]);

    core.deletePlaylist(id);

    expect(core.getPlaylistById(id)).toBeUndefined();
    const items = db.prepare("SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?").get(id) as { n: number };
    expect(items.n).toBe(0);
    const rules = db.prepare("SELECT COUNT(*) AS n FROM smart_playlist_rules WHERE playlist_id = ?").get(id) as { n: number };
    expect(rules.n).toBe(0);
  });
});

describe("Playlists — broken-playlist detection & repair", () => {
  let db: TestDb;
  let core: PlaylistCore;
  let folderId: number;

  beforeEach(() => {
    if (!canRunDbTests) return;
    db = createTestDb();
    core = new PlaylistCore(db);
    folderId = seedLibraryFolder(db, { name: "Music", path: "/music", contentType: "music" });
  });

  afterEach(() => {
    closeDb(db);
  });

  itDb("getBrokenPlaylists returns empty when all tracks exist", () => {
    seedTrack(db, { path: "/music/a.flac", genre: "Rock", libraryFolderId: folderId });
    const rockId = (db.prepare("SELECT id FROM genres WHERE name = ?").get("Rock") as { id: number }).id;
    core.createSmartPlaylist("Healthy", [{ id: 0, ruleType: "genre", targetId: rockId, targetLabel: "Rock" }]);

    expect(core.getBrokenPlaylists()).toHaveLength(0);
  });

  itDb("getBrokenPlaylists detects a playlist with a dangling item (simulating deleteRemovedTracks scan path)", () => {
    const trackId = seedTrack(db, { path: "/music/a.flac", title: "Gone", genre: "Rock", libraryFolderId: folderId });
    const keepId  = seedTrack(db, { path: "/music/b.flac", title: "Stay", genre: "Rock", libraryFolderId: folderId });
    const rockId  = (db.prepare("SELECT id FROM genres WHERE name = ?").get("Rock") as { id: number }).id;
    const playlistId = core.createSmartPlaylist("Mixed", [{ id: 0, ruleType: "genre", targetId: rockId, targetLabel: "Rock" }]);

    // Simulate the scanner's FK-off deletion — dangling playlist_items row remains
    db.pragma("foreign_keys = OFF");
    db.prepare("DELETE FROM tracks WHERE id = ?").run(trackId);
    db.pragma("foreign_keys = ON");

    const broken = core.getBrokenPlaylists();
    expect(broken).toHaveLength(1);
    expect(broken[0].id).toBe(playlistId);
    expect(broken[0].missingCount).toBe(1);
    expect(broken[0].totalCount).toBe(2);

    // trackCount in the playlist listing must already exclude the dangling row
    const listed = core.getPlaylists();
    const p = listed.find((x) => x.id === playlistId)!;
    expect(p.trackCount).toBe(1);

    // getPlaylistTracks must not return the dangling track
    const tracks = core.getPlaylistTracks(playlistId);
    expect(tracks.map((t) => t.id)).not.toContain(trackId);
    expect(tracks.map((t) => t.id)).toContain(keepId);
  });

  itDb("repairPlaylist removes dangling items and accurate count is restored", () => {
    const trackId = seedTrack(db, { path: "/music/a.flac", title: "Gone", genre: "Rock", libraryFolderId: folderId });
    seedTrack(db, { path: "/music/b.flac", title: "Stay", genre: "Rock", libraryFolderId: folderId });
    const rockId = (db.prepare("SELECT id FROM genres WHERE name = ?").get("Rock") as { id: number }).id;
    const playlistId = core.createSmartPlaylist("Repairable", [{ id: 0, ruleType: "genre", targetId: rockId, targetLabel: "Rock" }]);

    db.pragma("foreign_keys = OFF");
    db.prepare("DELETE FROM tracks WHERE id = ?").run(trackId);
    db.pragma("foreign_keys = ON");

    expect(core.getBrokenPlaylists()).toHaveLength(1);

    const result = core.repairPlaylist(playlistId);
    expect(result.removed).toBe(1);
    expect(result.remaining).toBe(1);

    expect(core.getBrokenPlaylists()).toHaveLength(0);

    const items = db.prepare("SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY position").all(playlistId) as Array<{ position: number }>;
    expect(items).toHaveLength(1);
    expect(items[0].position).toBe(1);
  });

  itDb("repairPlaylist with all tracks missing leaves an empty playlist (not deleted)", () => {
    const t1 = seedTrack(db, { path: "/music/a.flac", genre: "Rock", libraryFolderId: folderId });
    const t2 = seedTrack(db, { path: "/music/b.flac", genre: "Rock", libraryFolderId: folderId });
    const rockId = (db.prepare("SELECT id FROM genres WHERE name = ?").get("Rock") as { id: number }).id;
    const playlistId = core.createSmartPlaylist("Empty After Repair", [{ id: 0, ruleType: "genre", targetId: rockId, targetLabel: "Rock" }]);

    db.pragma("foreign_keys = OFF");
    db.prepare("DELETE FROM tracks WHERE id IN (?, ?)").run(t1, t2);
    db.pragma("foreign_keys = ON");

    const result = core.repairPlaylist(playlistId);
    expect(result.removed).toBe(2);
    expect(result.remaining).toBe(0);

    expect(core.getPlaylistById(playlistId)).toBeDefined();
    expect(core.getBrokenPlaylists()).toHaveLength(0);
  });
});
