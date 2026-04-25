/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import { SCHEMA_SQL } from "../main/database/schema";
import { PlaylistCore } from "../main/playlists/playlist-core";
import { writePlaylistsToDevice } from "../main/sync/playlist-sync";

let canRunDbTests = false;
try {
  const DB = require("better-sqlite3");
  const probe = new DB(":memory:");
  probe.close();
  canRunDbTests = true;
} catch {
  /* better-sqlite3 may be compiled for Electron's Node; skip DB tests */
}

function makeDb() {
  const DB = require("better-sqlite3");
  const db = new DB(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

function insertCustomPlaylist(db: import("better-sqlite3").Database, name: string): number {
  const typeId = (db.prepare("SELECT id FROM playlist_types WHERE name = 'custom'").get() as { id: number }).id;
  const now = new Date().toISOString();
  const info = db.prepare(
    "INSERT INTO playlists (name, description, playlist_type_id, created_at, updated_at) VALUES (?, '', ?, ?, ?)"
  ).run(name, typeId, now, now);
  return Number(info.lastInsertRowid);
}

const M3U_OPTS = { musicFolder: "Music", codecName: "DIRECT COPY" };
const tagnaviPath = (mountPath: string) =>
  path.join(mountPath, ".rockbox", "tagnavi_user.config");
const legacyCustomPath = (mountPath: string) =>
  path.join(mountPath, ".rockbox", "tagnavi_custom.config");

describe("writePlaylistsToDevice (rockbox tagnavi integration)", () => {
  let db: import("better-sqlite3").Database;
  let core: PlaylistCore;
  let mountPath: string;
  let playlistFolder: string;

  beforeEach(async () => {
    if (!canRunDbTests) return;
    db = makeDb();
    core = new PlaylistCore(db);
    mountPath = await fsp.mkdtemp(path.join(os.tmpdir(), "ipr-tagnavi-"));
    playlistFolder = path.join(mountPath, "Playlists");
  });

  afterEach(async () => {
    if (db) db.close();
    if (mountPath) await fsp.rm(mountPath, { recursive: true, force: true });
  });

  it.skipIf(!canRunDbTests)("flag off → smart playlist written as M3U, no tagnavi file", async () => {
    core.createSmartPlaylist("Rock Hits", [{ ruleType: "genre", targetId: null, targetLabel: "Rock" }]);
    const playlists = core.getPlaylists();

    await writePlaylistsToDevice({
      playlistFolder,
      mountPath,
      playlistsToWrite: playlists,
      core,
      m3uOpts: M3U_OPTS,
      useTagnavi: false,
    });

    expect(fs.existsSync(path.join(playlistFolder, "Rock Hits.m3u"))).toBe(true);
    expect(fs.existsSync(tagnaviPath(mountPath))).toBe(false);
  });

  it.skipIf(!canRunDbTests)("flag on → smart playlist goes to tagnavi, not M3U", async () => {
    core.createSmartPlaylist("Rock Hits", [{ ruleType: "genre", targetId: null, targetLabel: "Rock" }]);
    const playlists = core.getPlaylists();

    await writePlaylistsToDevice({
      playlistFolder,
      mountPath,
      playlistsToWrite: playlists,
      core,
      m3uOpts: M3U_OPTS,
      useTagnavi: true,
    });

    expect(fs.existsSync(path.join(playlistFolder, "Rock Hits.m3u"))).toBe(false);
    expect(fs.existsSync(tagnaviPath(mountPath))).toBe(true);
    const config = fs.readFileSync(tagnaviPath(mountPath), "utf-8");
    expect(config).toContain('"Rock Hits"');
    expect(config).toContain('genre = "Rock"');
  });

  it.skipIf(!canRunDbTests)("flag on → custom playlists still write M3U", async () => {
    insertCustomPlaylist(db, "My Custom");
    core.createSmartPlaylist("Rock Hits", [{ ruleType: "genre", targetId: null, targetLabel: "Rock" }]);
    const playlists = core.getPlaylists();

    await writePlaylistsToDevice({
      playlistFolder,
      mountPath,
      playlistsToWrite: playlists,
      core,
      m3uOpts: M3U_OPTS,
      useTagnavi: true,
    });

    expect(fs.existsSync(path.join(playlistFolder, "My Custom.m3u"))).toBe(true);
    expect(fs.existsSync(path.join(playlistFolder, "Rock Hits.m3u"))).toBe(false);
    expect(fs.existsSync(tagnaviPath(mountPath))).toBe(true);
  });

  it.skipIf(!canRunDbTests)("flag on, no smart playlists → no tagnavi file; stale tagnavi deleted", async () => {
    insertCustomPlaylist(db, "My Custom");
    const playlists = core.getPlaylists();

    await fsp.mkdir(path.join(mountPath, ".rockbox"), { recursive: true });
    await fsp.writeFile(tagnaviPath(mountPath), "stale content", "utf-8");

    await writePlaylistsToDevice({
      playlistFolder,
      mountPath,
      playlistsToWrite: playlists,
      core,
      m3uOpts: M3U_OPTS,
      useTagnavi: true,
    });

    expect(fs.existsSync(tagnaviPath(mountPath))).toBe(false);
    expect(fs.existsSync(path.join(playlistFolder, "My Custom.m3u"))).toBe(true);
  });

  it.skipIf(!canRunDbTests)("flag toggled on→off → tagnavi removed, smart M3U reappears", async () => {
    core.createSmartPlaylist("Rock Hits", [{ ruleType: "genre", targetId: null, targetLabel: "Rock" }]);
    const playlists = core.getPlaylists();

    await writePlaylistsToDevice({
      playlistFolder,
      mountPath,
      playlistsToWrite: playlists,
      core,
      m3uOpts: M3U_OPTS,
      useTagnavi: true,
    });
    expect(fs.existsSync(tagnaviPath(mountPath))).toBe(true);
    expect(fs.existsSync(path.join(playlistFolder, "Rock Hits.m3u"))).toBe(false);

    await writePlaylistsToDevice({
      playlistFolder,
      mountPath,
      playlistsToWrite: playlists,
      core,
      m3uOpts: M3U_OPTS,
      useTagnavi: false,
    });
    expect(fs.existsSync(tagnaviPath(mountPath))).toBe(false);
    expect(fs.existsSync(path.join(playlistFolder, "Rock Hits.m3u"))).toBe(true);
  });

  it.skipIf(!canRunDbTests)("write-if-changed: re-sync does not re-write tagnavi", async () => {
    core.createSmartPlaylist("Rock Hits", [{ ruleType: "genre", targetId: null, targetLabel: "Rock" }]);
    const playlists = core.getPlaylists();

    await writePlaylistsToDevice({
      playlistFolder,
      mountPath,
      playlistsToWrite: playlists,
      core,
      m3uOpts: M3U_OPTS,
      useTagnavi: true,
    });
    const mtime1 = fs.statSync(tagnaviPath(mountPath)).mtimeMs;

    await new Promise((r) => setTimeout(r, 15));

    const result = await writePlaylistsToDevice({
      playlistFolder,
      mountPath,
      playlistsToWrite: playlists,
      core,
      m3uOpts: M3U_OPTS,
      useTagnavi: true,
    });

    expect(result.tagnaviCount).toBe(0);
    expect(fs.statSync(tagnaviPath(mountPath)).mtimeMs).toBe(mtime1);
  });

  it.skipIf(!canRunDbTests)("re-sync reports tagnavi playlists as skipped when config unchanged", async () => {
    core.createSmartPlaylist("Rock Hits", [{ ruleType: "genre", targetId: null, targetLabel: "Rock" }]);
    const playlists = core.getPlaylists();

    // First sync — writes the config
    await writePlaylistsToDevice({
      playlistFolder, mountPath, playlistsToWrite: playlists,
      core, m3uOpts: M3U_OPTS, useTagnavi: true,
    });

    // Second sync — config unchanged, should report "skipped"
    const events: Array<{ status: string; path: string }> = [];
    await writePlaylistsToDevice({
      playlistFolder, mountPath, playlistsToWrite: playlists,
      core, m3uOpts: M3U_OPTS, useTagnavi: true,
      progressCallback: (e) => {
        if (e.event === "copy") events.push({ status: String(e.status ?? ""), path: String(e.path) });
      },
    });

    const tagnaviEvent = events.find((e) => e.path.startsWith("<tagnavi>"));
    expect(tagnaviEvent).toBeDefined();
    expect(tagnaviEvent?.status).toBe("skipped");
  });

  it.skipIf(!canRunDbTests)("playlist with special chars produces valid tagnavi entry", async () => {
    core.createSmartPlaylist('Best "Rock" /// hits!', [{ ruleType: "genre", targetId: null, targetLabel: "Rock" }]);
    const playlists = core.getPlaylists();

    await writePlaylistsToDevice({
      playlistFolder,
      mountPath,
      playlistsToWrite: playlists,
      core,
      m3uOpts: M3U_OPTS,
      useTagnavi: true,
    });

    expect(fs.existsSync(tagnaviPath(mountPath))).toBe(true);
    const config = fs.readFileSync(tagnaviPath(mountPath), "utf-8");
    expect(config).toContain("'Rock'");
    const entryLine = config.split("\n").find((l) => l.includes("-> title"));
    expect(entryLine).toBeDefined();
    expect(entryLine).toMatch(/^".*" -> title = "fmt_ipr_title" \? .+$/);
  });

  it.skipIf(!canRunDbTests)("legacy tagnavi_custom.config is removed during sync", async () => {
    core.createSmartPlaylist("Rock Hits", [{ ruleType: "genre", targetId: null, targetLabel: "Rock" }]);
    const playlists = core.getPlaylists();

    // Simulate device with leftover file from older iPodRocks versions.
    await fsp.mkdir(path.join(mountPath, ".rockbox"), { recursive: true });
    await fsp.writeFile(legacyCustomPath(mountPath), "stale content from old version", "utf-8");

    await writePlaylistsToDevice({
      playlistFolder,
      mountPath,
      playlistsToWrite: playlists,
      core,
      m3uOpts: M3U_OPTS,
      useTagnavi: true,
    });

    expect(fs.existsSync(legacyCustomPath(mountPath))).toBe(false);
    expect(fs.existsSync(tagnaviPath(mountPath))).toBe(true);
  });

  it.skipIf(!canRunDbTests)("returns correct playlistsWritten and tagnaviCount", async () => {
    insertCustomPlaylist(db, "Custom One");
    core.createSmartPlaylist("Smart One", [{ ruleType: "genre", targetId: null, targetLabel: "Rock" }]);
    const playlists = core.getPlaylists();

    const result = await writePlaylistsToDevice({
      playlistFolder,
      mountPath,
      playlistsToWrite: playlists,
      core,
      m3uOpts: M3U_OPTS,
      useTagnavi: true,
    });

    expect(result.playlistsWritten).toBe(1);
    expect(result.tagnaviCount).toBe(1);
  });
});
