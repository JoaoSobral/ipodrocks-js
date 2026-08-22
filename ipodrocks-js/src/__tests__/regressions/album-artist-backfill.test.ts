/**
 * @vitest-environment node
 *
 * Issue #113 — upgrade path.
 *
 * Libraries scanned before album-artist support have their `albums` rows keyed
 * on the *track* artist, so a compilation exists as N rows. A plain rescan does
 * not repair them: the scanner skips unchanged files on mtime, so their tags are
 * never re-read. The one-shot backfill re-reads only the tags and repoints each
 * track at an album keyed on its album artist.
 *
 * These tests build the pre-fix DB state by hand, then run the backfill.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { canRunDbTests, createTestDb, type TestDb } from "../harness/db";
import {
  backfillAlbumArtists,
  isAlbumArtistBackfillDone,
} from "../../main/library/album-artist-backfill";
import type { MetadataExtractor } from "../../main/library/metadata-extractor";

const itDb = it.skipIf(!canRunDbTests);

const ALBUM = "Greatest Hits Vol 1";
const ALBUM_ARTIST = "Various Artists";
const TRACK_ARTISTS = ["Alpha Band", "Beta Crew", "Gamma Trio"];

/** A stub extractor that reports the album artist we tagged the file with. */
function stubExtractor(albumArtistByPath: Map<string, string>): MetadataExtractor {
  return {
    async extractMetadata(filePath: string) {
      return {
        title: path.basename(filePath),
        artist: "ignored",
        albumArtist: albumArtistByPath.get(filePath) ?? "",
        album: ALBUM,
        genre: "Pop",
        trackNumber: "1",
        discNumber: "",
      };
    },
  } as unknown as MetadataExtractor;
}

describe("album-artist backfill (issue #113)", () => {
  let db: TestDb;
  let dir: string;
  let paths: string[];
  let albumArtistByPath: Map<string, string>;

  beforeEach(() => {
    if (!canRunDbTests) return;
    db = createTestDb();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-backfill-"));
    paths = [];
    albumArtistByPath = new Map();

    db.prepare(
      "INSERT INTO library_folders (id, name, path, content_type) VALUES (1, 'Music', ?, 'music')"
    ).run(dir);

    // Pre-fix state: one artist row AND one album row per track artist.
    TRACK_ARTISTS.forEach((artist, i) => {
      const p = path.join(dir, `0${i + 1}.flac`);
      fs.writeFileSync(p, Buffer.from(`bytes-${i}`));
      paths.push(p);
      albumArtistByPath.set(p, ALBUM_ARTIST);

      db.prepare("INSERT INTO artists (name) VALUES (?)").run(artist);
      const artistId = (
        db.prepare("SELECT id FROM artists WHERE name = ?").get(artist) as {
          id: number;
        }
      ).id;
      db.prepare("INSERT INTO albums (title, artist_id) VALUES (?, ?)").run(
        ALBUM,
        artistId
      );
      const albumId = (
        db
          .prepare("SELECT id FROM albums WHERE title = ? AND artist_id = ?")
          .get(ALBUM, artistId) as { id: number }
      ).id;
      db.prepare(
        `INSERT INTO tracks (path, filename, title, content_type, library_folder_id, artist_id, album_id)
         VALUES (?, ?, ?, 'music', 1, ?, ?)`
      ).run(p, path.basename(p), `Track ${i + 1}`, artistId, albumId);
    });
  });

  afterEach(() => {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function albumRowsForTitle(): number {
    return (
      db.prepare("SELECT COUNT(*) AS c FROM albums WHERE title = ?").get(ALBUM) as {
        c: number;
      }
    ).c;
  }

  itDb("starts from the broken state: one album row per track artist", () => {
    expect(albumRowsForTitle()).toBe(3);
  });

  itDb("repoints every track at a single album keyed on the album artist", async () => {
    const result = await backfillAlbumArtists(db, stubExtractor(albumArtistByPath));

    expect(result.skipped).toBe(false);
    expect(result.processed).toBe(3);
    expect(result.repointed).toBe(3);

    const albumIds = db
      .prepare("SELECT DISTINCT album_id FROM tracks")
      .all() as { album_id: number }[];
    expect(albumIds).toHaveLength(1);

    const owner = db
      .prepare(
        `SELECT a.name FROM albums al JOIN artists a ON al.artist_id = a.id
         WHERE al.id = ?`
      )
      .get(albumIds[0].album_id) as { name: string };
    expect(owner.name).toBe(ALBUM_ARTIST);
  });

  itDb("is idempotent — a second run is skipped by the sentinel", async () => {
    await backfillAlbumArtists(db, stubExtractor(albumArtistByPath));
    expect(isAlbumArtistBackfillDone(db)).toBe(true);

    const second = await backfillAlbumArtists(db, stubExtractor(albumArtistByPath));
    expect(second.skipped).toBe(true);
    expect(second.processed).toBe(0);

    const albumIds = db
      .prepare("SELECT DISTINCT album_id FROM tracks")
      .all() as { album_id: number }[];
    expect(albumIds).toHaveLength(1);
  });

  itDb("forcing a re-run converges to the same album row", async () => {
    await backfillAlbumArtists(db, stubExtractor(albumArtistByPath));
    const before = db.prepare("SELECT DISTINCT album_id FROM tracks").all();

    const again = await backfillAlbumArtists(db, stubExtractor(albumArtistByPath), {
      force: true,
    });
    expect(again.skipped).toBe(false);

    const after = db.prepare("SELECT DISTINCT album_id FROM tracks").all();
    expect(after).toEqual(before);
  });

  itDb("leaves tracks alone when the album artist equals the track artist", async () => {
    // Untagged library: albumArtist falls back to the track artist, so the
    // existing per-artist album rows are already correct and must not move.
    const extractor = {
      async extractMetadata(filePath: string) {
        const artist = db
          .prepare(
            "SELECT a.name FROM tracks t JOIN artists a ON t.artist_id = a.id WHERE t.path = ?"
          )
          .get(filePath) as { name: string };
        return {
          title: "t",
          artist: artist.name,
          albumArtist: artist.name,
          album: ALBUM,
          genre: "Pop",
          trackNumber: "1",
          discNumber: "",
        };
      },
    } as unknown as MetadataExtractor;

    const result = await backfillAlbumArtists(db, extractor);
    expect(result.repointed).toBe(0);
    expect(albumRowsForTitle()).toBe(3);
  });

  itDb("does not mark itself done when cancelled midway", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await backfillAlbumArtists(db, stubExtractor(albumArtistByPath), {
      cancelSignal: controller.signal,
    });
    expect(result.processed).toBe(0);
    expect(isAlbumArtistBackfillDone(db)).toBe(false);
  });

  itDb("skips tracks whose files no longer exist", async () => {
    fs.rmSync(paths[0]);
    const result = await backfillAlbumArtists(db, stubExtractor(albumArtistByPath));
    expect(result.processed).toBe(3);
    expect(result.repointed).toBe(2);
  });
});
