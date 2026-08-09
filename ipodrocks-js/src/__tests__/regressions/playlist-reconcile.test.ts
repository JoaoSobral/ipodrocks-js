/**
 * @vitest-environment node
 *
 * Regression: playlists kept pointing at songs that had been deleted from the
 * library.
 *
 * Root cause — `LibraryScanner.deleteRemovedTracks()` runs its deletes with
 * `PRAGMA foreign_keys = OFF`, so the `ON DELETE CASCADE` declared on
 * `playlist_items.track_id` never fired and orphan rows piled up. Users had to
 * spot a "broken playlists" banner and click Repair by hand.
 *
 * Fix — the scanner now deletes `playlist_items` explicitly, and
 * `PlaylistCore.reconcileAllPlaylists()` runs after every scan / folder removal
 * to clean up anything already orphaned and re-resolve smart playlists.
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

describe("Playlist reconciliation after library changes", () => {
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

  function seedSong(n: number, genre = "Rock"): number {
    return seedTrack(db, {
      path: `/music/song-${n}.flac`,
      title: `Song ${n}`,
      artist: `Artist ${n}`,
      album: `Album ${n}`,
      genre,
      libraryFolderId: folderId,
    });
  }

  /** Delete a track row the way the scanner does: FK enforcement off. */
  function deleteTrackLikeScanner(trackId: number): void {
    db.pragma("foreign_keys = OFF");
    db.prepare("DELETE FROM tracks WHERE id = ?").run(trackId);
    db.pragma("foreign_keys = ON");
  }

  function genreId(name: string): number {
    return (db.prepare("SELECT id FROM genres WHERE name = ?").get(name) as { id: number }).id;
  }

  function positionsOf(playlistId: number): number[] {
    return (
      db
        .prepare("SELECT position FROM playlist_items WHERE playlist_id = ? ORDER BY position")
        .all(playlistId) as { position: number }[]
    ).map((r) => r.position);
  }

  itDb("reproduces the orphan: deleting a track with FKs off leaves playlist_items behind", () => {
    const a = seedSong(1);
    const b = seedSong(2);
    const playlistId = core.createClassicPlaylist("Fragile", [a, b]);

    deleteTrackLikeScanner(a);

    const orphans = db
      .prepare("SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ? AND track_id = ?")
      .get(playlistId, a) as { n: number };
    expect(orphans.n).toBe(1);
    expect(core.getBrokenPlaylists()).toHaveLength(1);
  });

  itDb("reconcile prunes orphans and reports what it did", () => {
    const a = seedSong(1);
    const b = seedSong(2);
    const c = seedSong(3);
    const playlistId = core.createClassicPlaylist("Fragile", [a, b, c]);

    deleteTrackLikeScanner(a);
    deleteTrackLikeScanner(c);

    const summary = core.reconcileAllPlaylists();

    expect(summary.prunedItems).toBe(2);
    expect(summary.prunedPlaylists).toBe(1);
    expect(core.getPlaylistTracks(playlistId).map((t) => t.id)).toEqual([b]);
    expect(core.getBrokenPlaylists()).toHaveLength(0);
  });

  itDb("reconcile compacts positions to a contiguous 1..n run", () => {
    const ids = [seedSong(1), seedSong(2), seedSong(3), seedSong(4)];
    const playlistId = core.createClassicPlaylist("Gaps", ids);

    // Remove from the middle so positions 2 and 3 become holes.
    deleteTrackLikeScanner(ids[1]);
    deleteTrackLikeScanner(ids[2]);

    core.reconcileAllPlaylists();

    expect(positionsOf(playlistId)).toEqual([1, 2]);
    expect(core.getPlaylistTracks(playlistId).map((t) => t.id)).toEqual([ids[0], ids[3]]);
  });

  itDb("reconcile leaves untouched playlists alone", () => {
    const a = seedSong(1);
    const b = seedSong(2);
    const damaged = core.createClassicPlaylist("Damaged", [a, b]);
    const healthy = core.createClassicPlaylist("Healthy", [b]);

    const before = core.getPlaylistById(healthy)?.updatedAt;
    deleteTrackLikeScanner(a);

    const summary = core.reconcileAllPlaylists();

    expect(summary.prunedPlaylists).toBe(1);
    expect(core.getPlaylistTracks(damaged).map((t) => t.id)).toEqual([b]);
    expect(core.getPlaylistById(healthy)?.updatedAt).toBe(before);
  });

  itDb("re-resolves smart playlists so they also gain newly scanned tracks", () => {
    const a = seedSong(1);
    seedSong(2);
    const smartId = core.createSmartPlaylist("Rock", [
      { id: 0, ruleType: "genre", targetId: genreId("Rock"), targetLabel: "Rock" },
    ]);
    expect(core.getPlaylistTracks(smartId)).toHaveLength(2);

    // One song vanishes, a new one is scanned in.
    deleteTrackLikeScanner(a);
    const fresh = seedSong(3);

    const summary = core.reconcileAllPlaylists();

    expect(summary.rebuiltSmart).toBe(1);
    const ids = core.getPlaylistTracks(smartId).map((t) => t.id);
    expect(ids).not.toContain(a);
    expect(ids).toContain(fresh);
    expect(ids).toHaveLength(2);
  });

  itDb("a rebuilt smart playlist still respects its saved track limit", () => {
    for (let i = 1; i <= 5; i++) seedSong(i);
    const smartId = core.createSmartPlaylist(
      "Capped",
      [{ id: 0, ruleType: "genre", targetId: genreId("Rock"), targetLabel: "Rock" }],
      "",
      3
    );
    expect(core.getPlaylistTracks(smartId)).toHaveLength(3);

    // More matching songs appear — the limit must survive the rebuild.
    for (let i = 6; i <= 10; i++) seedSong(i);

    core.reconcileAllPlaylists();

    expect(core.getPlaylistTracks(smartId)).toHaveLength(3);
  });

  itDb("prunes hand-picked playlists without regenerating them", () => {
    const a = seedSong(1);
    const b = seedSong(2);
    const classicId = core.createClassicPlaylist("Mixtape", [a, b]);
    const geniusId = core.createGeniusPlaylist("most_played", [a, b], null, 50, "Faves");
    const savantId = core.createSavantPlaylist("Mood", [a, b], "{}");

    deleteTrackLikeScanner(a);
    // A brand-new Rock track that a smart playlist would have picked up.
    const fresh = seedSong(3);

    core.reconcileAllPlaylists();

    for (const id of [classicId, geniusId, savantId]) {
      const ids = core.getPlaylistTracks(id).map((t) => t.id);
      expect(ids).toEqual([b]);
      expect(ids).not.toContain(fresh);
    }
  });

  itDb("is a no-op on an empty library rather than wiping every playlist", () => {
    const a = seedSong(1);
    const b = seedSong(2);
    const playlistId = core.createClassicPlaylist("Precious", [a, b]);

    // Simulates a failed scan / unreachable folder: every track row is gone.
    deleteTrackLikeScanner(a);
    deleteTrackLikeScanner(b);

    const summary = core.reconcileAllPlaylists();

    expect(summary).toEqual({ prunedItems: 0, prunedPlaylists: 0, rebuiltSmart: 0 });
    const remaining = db
      .prepare("SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?")
      .get(playlistId) as { n: number };
    expect(remaining.n).toBe(2);
  });

  itDb("is idempotent — a second pass finds nothing to do", () => {
    const a = seedSong(1);
    const b = seedSong(2);
    core.createClassicPlaylist("Fragile", [a, b]);

    deleteTrackLikeScanner(a);
    core.reconcileAllPlaylists();

    const second = core.reconcileAllPlaylists();
    expect(second.prunedItems).toBe(0);
    expect(second.prunedPlaylists).toBe(0);
  });

  itDb("a reconciled playlist can still take new tracks at the end", () => {
    const ids = [seedSong(1), seedSong(2), seedSong(3)];
    const playlistId = core.createClassicPlaylist("Growing", ids);

    deleteTrackLikeScanner(ids[0]);
    core.reconcileAllPlaylists();

    // Position compaction has to leave room — appending relies on
    // UNIQUE(playlist_id, position) not colliding.
    const fresh = seedSong(4);
    core.addTracksToPlaylist(playlistId, [fresh]);

    expect(positionsOf(playlistId)).toEqual([1, 2, 3]);
    expect(core.getPlaylistTracks(playlistId).map((t) => t.id)).toEqual([ids[1], ids[2], fresh]);
  });
});
