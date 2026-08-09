/**
 * @vitest-environment node
 *
 * Behavioral journeys for Classic playlists — the hand-picked playlist type.
 * Unlike smart/genius/savant, the track list comes straight from the user's
 * selection, so ordering, deduplication and the 500-track cap are the contract.
 *
 * Drives `PlaylistCore` directly (the same object the `playlist:createClassic`
 * and `playlist:updateClassic` IPC handlers delegate to).
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
import { CLASSIC_PLAYLIST_MAX_TRACKS } from "../../shared/types";

const itDb = it.skipIf(!canRunDbTests);

describe("Playlists — Classic (hand-picked) journey", () => {
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

  /** Seed n music tracks named Song 1..n, returning their ids in order. */
  function seedSongs(n: number): number[] {
    const ids: number[] = [];
    for (let i = 1; i <= n; i++) {
      ids.push(
        seedTrack(db, {
          path: `/music/song-${i}.flac`,
          title: `Song ${i}`,
          artist: `Artist ${i}`,
          album: `Album ${i}`,
          genre: "Rock",
          libraryFolderId: folderId,
        })
      );
    }
    return ids;
  }

  itDb("stores the tracks in the order the user picked them, not library order", () => {
    const [a, b, c] = seedSongs(3);

    // Deliberately not artist/album/title order — this is the running order the
    // user built by ticking boxes.
    const playlistId = core.createClassicPlaylist("My Mixtape", [c, a, b]);

    const tracks = core.getPlaylistTracks(playlistId);
    expect(tracks.map((t) => t.id)).toEqual([c, a, b]);
    expect(tracks.map((t) => t.title)).toEqual(["Song 3", "Song 1", "Song 2"]);
  });

  itDb("stores the name with a classic_ prefix and resolves typeName 'classic'", () => {
    const ids = seedSongs(2);
    const playlistId = core.createClassicPlaylist("My Mixtape", ids);

    const playlist = core.getPlaylistById(playlistId);
    expect(playlist?.name).toBe("classic_My Mixtape");
    expect(playlist?.typeName).toBe("classic");
    expect(playlist?.trackCount).toBe(2);
  });

  itDb("writes contiguous positions starting at 1", () => {
    const ids = seedSongs(4);
    const playlistId = core.createClassicPlaylist("Positions", ids);

    const positions = (
      db
        .prepare("SELECT position FROM playlist_items WHERE playlist_id = ? ORDER BY position")
        .all(playlistId) as { position: number }[]
    ).map((r) => r.position);
    expect(positions).toEqual([1, 2, 3, 4]);
  });

  itDb("collapses duplicate ids keeping the first occurrence", () => {
    const [a, b] = seedSongs(2);

    const playlistId = core.createClassicPlaylist("Dupes", [a, b, a, b, a]);

    expect(core.getPlaylistTracks(playlistId).map((t) => t.id)).toEqual([a, b]);
  });

  itDb("drops ids that are not music tracks in the library", () => {
    const [a] = seedSongs(1);
    const podcastId = seedTrack(db, {
      path: "/music/episode.mp3",
      title: "Episode 1",
      contentType: "podcast",
      libraryFolderId: folderId,
    });

    const playlistId = core.createClassicPlaylist("Music only", [a, podcastId, 999999]);

    expect(core.getPlaylistTracks(playlistId).map((t) => t.id)).toEqual([a]);
  });

  itDb("rejects an empty selection", () => {
    seedSongs(1);
    expect(() => core.createClassicPlaylist("Empty", [])).toThrow(/at least one song/i);
  });

  itDb("rejects a selection where nothing resolves to a library track", () => {
    seedSongs(1);
    expect(() => core.createClassicPlaylist("Ghosts", [90001, 90002])).toThrow(
      /none of the selected songs are in the music library/i
    );
  });

  itDb(`accepts exactly ${CLASSIC_PLAYLIST_MAX_TRACKS} tracks`, () => {
    const ids = seedSongs(CLASSIC_PLAYLIST_MAX_TRACKS);
    const playlistId = core.createClassicPlaylist("Full house", ids);
    expect(core.getPlaylistTracks(playlistId)).toHaveLength(CLASSIC_PLAYLIST_MAX_TRACKS);
  });

  itDb(`rejects more than ${CLASSIC_PLAYLIST_MAX_TRACKS} tracks`, () => {
    const ids = seedSongs(CLASSIC_PLAYLIST_MAX_TRACKS + 1);
    expect(() => core.createClassicPlaylist("Too many", ids)).toThrow(/at most 500 songs/i);
  });

  describe("editing", () => {
    itDb("replaces the track list and renames the playlist", () => {
      const [a, b, c] = seedSongs(3);
      const playlistId = core.createClassicPlaylist("Before", [a, b]);

      core.updateClassicPlaylist(playlistId, "After", [c, a]);

      expect(core.getPlaylistTracks(playlistId).map((t) => t.id)).toEqual([c, a]);
      expect(core.getPlaylistById(playlistId)?.name).toBe("classic_After");
    });

    itDb("replaces rather than appends", () => {
      const [a, b, c] = seedSongs(3);
      const playlistId = core.createClassicPlaylist("Shrink", [a, b, c]);

      core.updateClassicPlaylist(playlistId, "Shrink", [b]);

      expect(core.getPlaylistTracks(playlistId).map((t) => t.id)).toEqual([b]);
      expect(core.getPlaylistById(playlistId)?.trackCount).toBe(1);
    });

    itDb("does not double-prefix a name that already carries classic_", () => {
      const ids = seedSongs(2);
      const playlistId = core.createClassicPlaylist("Mix", ids);

      core.updateClassicPlaylist(playlistId, "classic_Mix", ids);

      expect(core.getPlaylistById(playlistId)?.name).toBe("classic_Mix");
    });

    itDb("refuses to edit a playlist that is not Classic", () => {
      const ids = seedSongs(2);
      const genreId = (db.prepare("SELECT id FROM genres WHERE name = ?").get("Rock") as { id: number }).id;
      const smartId = core.createSmartPlaylist("Rock", [
        { id: 0, ruleType: "genre", targetId: genreId, targetLabel: "Rock" },
      ]);

      expect(() => core.updateClassicPlaylist(smartId, "Hijacked", ids)).toThrow(
        /only Classic playlists can be edited/i
      );
    });

    itDb("refuses to edit a playlist that does not exist", () => {
      const ids = seedSongs(1);
      expect(() => core.updateClassicPlaylist(4242, "Ghost", ids)).toThrow(/not found/i);
    });
  });

  describe("shares the generic playlist machinery", () => {
    itDb("can be deleted like any other playlist", () => {
      const ids = seedSongs(2);
      const playlistId = core.createClassicPlaylist("Doomed", ids);

      core.deletePlaylist(playlistId);

      expect(core.getPlaylistById(playlistId)).toBeUndefined();
      const leftovers = db
        .prepare("SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?")
        .get(playlistId) as { n: number };
      expect(leftovers.n).toBe(0);
    });

    itDb("is reported as broken and repairable when a track goes missing", () => {
      const [a, b] = seedSongs(2);
      const playlistId = core.createClassicPlaylist("Fragile", [a, b]);

      // Delete the way the scanner does — FKs off, so no CASCADE.
      db.pragma("foreign_keys = OFF");
      db.prepare("DELETE FROM tracks WHERE id = ?").run(a);
      db.pragma("foreign_keys = ON");

      expect(core.getBrokenPlaylists().map((p) => p.id)).toContain(playlistId);

      const result = core.repairPlaylist(playlistId);
      expect(result.removed).toBe(1);
      expect(result.remaining).toBe(1);
      expect(core.getBrokenPlaylists()).toHaveLength(0);
    });

    itDb("cannot be rebuilt from rules — it has none", () => {
      const ids = seedSongs(2);
      const playlistId = core.createClassicPlaylist("No rules", ids);

      expect(core.rebuildSmartPlaylist(playlistId)).toBe(false);
      expect(core.getPlaylistTracks(playlistId)).toHaveLength(2);
    });

    itDb("appears under the 'classic' type filter and in the unfiltered list", () => {
      const ids = seedSongs(2);
      core.createClassicPlaylist("Listed", ids);

      expect(core.getPlaylists("classic").map((p) => p.name)).toEqual(["classic_Listed"]);
      expect(core.getPlaylists().map((p) => p.name)).toContain("classic_Listed");
    });
  });
});
