/**
 * @vitest-environment node
 *
 * Regression: the one-time NFC path migration must collapse NFC/NFD duplicate
 * rows (created by the old byte-for-byte path comparison on SMB mounts) and
 * rewrite every stored path to NFC, repointing all references without leaving
 * orphans or violating UNIQUE constraints.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { canRunDbTests, closeDb, createTestDb, type TestDb } from "../harness";
import { seedTrack, seedLibraryFolder } from "../harness";
import { migrateNfcPaths } from "../../main/database/nfc-path-migration";

const itDb = it.skipIf(!canRunDbTests);

// "Café Album" in the two Unicode normalization forms.
const NFC_DIR = "/music/Caf\u00e9 Album"; // precomposed e-acute
const NFD_DIR = "/music/Cafe\u0301 Album"; // e + combining acute
const NFC_TRACK = `${NFC_DIR}/track.flac`;
const NFD_TRACK = `${NFD_DIR}/track.flac`;

describe("NFC path migration", () => {
  let db: TestDb;

  beforeEach(() => {
    if (canRunDbTests) db = createTestDb();
  });
  afterEach(() => closeDb(db));

  itDb("collapses NFC/NFD duplicate tracks, keeping the richer row as NFC", () => {
    const folderId = seedLibraryFolder(db, { name: "Music", path: NFC_DIR });
    // NFC row: no duration (lower score). NFD row: has duration (higher score,
    // becomes the keeper and is renamed to NFC).
    const nfcId = seedTrack(db, { path: NFC_TRACK, title: "Track", libraryFolderId: folderId });
    const nfdId = seedTrack(db, { path: NFD_TRACK, title: "Track", libraryFolderId: folderId, duration: 180 });

    // A playlist referencing BOTH rows.
    db.prepare("INSERT INTO playlist_types (name) VALUES ('manual')").run();
    const playlistId = Number(
      db.prepare("INSERT INTO playlists (name, playlist_type_id) VALUES ('P', 1)").run().lastInsertRowid
    );
    db.prepare("INSERT INTO playlist_items (playlist_id, track_id, position) VALUES (?, ?, 0)").run(playlistId, nfcId);
    db.prepare("INSERT INTO playlist_items (playlist_id, track_id, position) VALUES (?, ?, 1)").run(playlistId, nfdId);

    migrateNfcPaths(db);

    const tracks = db.prepare("SELECT id, path FROM tracks").all() as { id: number; path: string }[];
    expect(tracks).toHaveLength(1);
    expect(tracks[0].path).toBe(NFC_TRACK);
    expect(tracks[0].path.normalize("NFC")).toBe(tracks[0].path);
    expect(tracks[0].id).toBe(nfdId); // richer (has duration) survived

    // Both playlist items now point at the surviving track.
    const items = db.prepare("SELECT track_id FROM playlist_items ORDER BY position").all() as { track_id: number }[];
    expect(items.map((i) => i.track_id)).toEqual([nfdId, nfdId]);
  });

  itDb("dedupes content_hashes to a single NFC row", () => {
    const ins = db.prepare(
      "INSERT INTO content_hashes (file_path, content_hash, metadata_hash, file_size, last_modified, hash_type, updated_at) VALUES (?, 'h', 'm', 1, 't', 'sha256', ?)"
    );
    ins.run(NFC_TRACK, "2024-01-01");
    ins.run(NFD_TRACK, "2024-06-01"); // newer → keeper

    migrateNfcPaths(db);

    const rows = db.prepare("SELECT file_path FROM content_hashes").all() as { file_path: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].file_path).toBe(NFC_TRACK);
  });

  itDb("dedupes library_folders and repoints tracks.library_folder_id", () => {
    const nfcFolder = seedLibraryFolder(db, { name: "Café Album", path: NFC_DIR });
    const nfdFolder = seedLibraryFolder(db, { name: "Café Album", path: NFD_DIR });
    const trackId = seedTrack(db, { path: NFC_TRACK, libraryFolderId: nfdFolder });

    migrateNfcPaths(db);

    const folders = db.prepare("SELECT id, path FROM library_folders").all() as { id: number; path: string }[];
    expect(folders).toHaveLength(1);
    expect(folders[0].path).toBe(NFC_DIR);
    expect(folders[0].id).toBe(nfcFolder); // lowest id kept
    const track = db.prepare("SELECT library_folder_id FROM tracks WHERE id = ?").get(trackId) as { library_folder_id: number };
    expect(track.library_folder_id).toBe(nfcFolder);
  });

  itDb("dedupes device_synced_tracks per device", () => {
    // device_synced_tracks FKs to devices; seed with FK checks off.
    db.pragma("foreign_keys = OFF");
    const ins = db.prepare("INSERT INTO device_synced_tracks (device_id, library_path) VALUES (?, ?)");
    ins.run(1, NFC_TRACK);
    ins.run(1, NFD_TRACK);
    ins.run(2, NFD_TRACK); // different device → independent row
    db.pragma("foreign_keys = ON");

    migrateNfcPaths(db);

    const rows = db.prepare("SELECT device_id, library_path FROM device_synced_tracks ORDER BY device_id").all() as {
      device_id: number;
      library_path: string;
    }[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.library_path === NFC_TRACK)).toBe(true);
    expect(rows.map((r) => r.device_id)).toEqual([1, 2]);
  });

  itDb("sets the done flag and is a no-op on a second run", () => {
    seedTrack(db, { path: NFD_TRACK, duration: 100 });
    migrateNfcPaths(db);

    const flag = db.prepare("SELECT value FROM app_settings WHERE key = 'migrate_nfc_paths_done'").get() as { value: string };
    expect(flag.value).toBe("1");

    // Re-insert an NFD row; because the flag is set, the migration must skip it.
    seedTrack(db, { path: `${NFD_DIR}/second.flac`, duration: 100 });
    migrateNfcPaths(db);
    const stillNfd = db.prepare("SELECT path FROM tracks WHERE path LIKE '%second.flac'").get() as { path: string };
    expect(stillNfd.path).toBe(`${NFD_DIR}/second.flac`);
  });
});
