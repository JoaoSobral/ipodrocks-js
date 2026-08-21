/**
 * E2E — album-artist grouping for custom sync and device folders (issue #113).
 *
 * Drives the real built app (renderer → preload → main → SQLite → filesystem)
 * to verify the reported bug is gone end-to-end:
 *
 *   - A compilation whose tracks carry different `artist` tags but one shared
 *     `albumartist` is ONE entry in the custom-sync album list, not one per
 *     contributing artist.
 *   - Syncing that compilation with "Mirror library folder structure" OFF puts
 *     the whole album in a single `Various Artists/<album>/` folder instead of
 *     scattering it across one folder per track artist.
 *   - The grouping preference persists per device and can be switched back to
 *     the old track-artist behaviour.
 *
 * Seeds real tagged MP3s with ffmpeg (the app already depends on ffmpeg), so
 * the tags are read exactly as they would be in production. The whole suite
 * skips when ffmpeg is unavailable. Seed folders must live under the user's
 * home dir (path allowlist).
 *
 * Run: npm run build && npx playwright test
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { test, expect, type Page } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./electron-launcher";

interface ApiWindow {
  api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
}

type Track = {
  path: string;
  artist: string;
  albumArtist: string;
  album: string;
  contentType: string;
};

let launched: LaunchedApp;
let seedDir: string;
let deviceDir: string;
/** False when ffmpeg is unavailable — every test then skips rather than fails. */
let seeded = false;

const ALBUM = "E2E Compilation";
const ALBUM_ARTIST = "Various Artists";
const TRACK_ARTISTS = ["E2E Alpha", "E2E Beta", "E2E Gamma"];

/**
 * Seed real, properly tagged audio via ffmpeg. Hand-rolled tag blobs are not
 * worth the risk here — the point of this test is that the app reads the
 * `album_artist` tag off a real file the way it will in production.
 */
function seedCompilation(): boolean {
  const albumDir = path.join(seedDir, ALBUM);
  fs.mkdirSync(albumDir, { recursive: true });

  for (let i = 0; i < TRACK_ARTISTS.length; i++) {
    const artist = TRACK_ARTISTS[i];
    const out = path.join(albumDir, `0${i + 1} - ${artist}.mp3`);
    const res = spawnSync(
      "ffmpeg",
      [
        "-y", "-v", "quiet",
        "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono",
        "-t", "1",
        "-metadata", `title=Track ${i + 1}`,
        "-metadata", `artist=${artist}`,
        "-metadata", `album_artist=${ALBUM_ARTIST}`,
        "-metadata", `album=${ALBUM}`,
        out,
      ],
      { encoding: "utf8" }
    );
    if (res.status !== 0 || !fs.existsSync(out)) return false;
  }
  return true;
}

async function readyWindow(): Promise<Page> {
  const window = await launched.app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: { invoke?: unknown } }).api?.invoke === "function",
    null,
    { timeout: 15_000 }
  );
  return window;
}

async function scanAndAddDevice(window: Page): Promise<number> {
  return (await window.evaluate(
    async ([folder, mount]) => {
      const api = (window as unknown as ApiWindow).api;
      await api.invoke("library:addFolder", {
        name: "E2E Grouping Seed",
        path: folder,
        contentType: "music",
      });
      await api.invoke("library:scan", {
        folders: [{ name: "E2E Grouping Seed", path: folder, contentType: "music" }],
      });
      const dev = (await api.invoke("device:add", {
        name: `Grouping ${Date.now()}`,
        mountPath: mount,
      })) as { id: number };
      return dev.id;
    },
    [seedDir, deviceDir]
  )) as number;
}

async function compilationTracks(window: Page): Promise<Track[]> {
  const tracks = (await window.evaluate(() =>
    (window as unknown as ApiWindow).api.invoke("library:getTracks", {
      contentType: "music",
    })
  )) as Track[];
  return tracks.filter((t) => t.album === ALBUM);
}

test.beforeEach(async () => {
  seedDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-group-"));
  deviceDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-groupdev-"));
  seeded = seedCompilation();
  launched = await launchApp();
});

test.afterEach(async () => {
  await launched.cleanup();
  for (const dir of [seedDir, deviceDir]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

test("a compilation is one album entry, not one per track artist", async () => {
  test.skip(!seeded, "ffmpeg unavailable — cannot seed tagged audio");
  const window = await readyWindow();
  await scanAndAddDevice(window);

  const tracks = await compilationTracks(window);
  expect(tracks).toHaveLength(3);

  // Track artists stay distinct; the album artist is shared.
  expect(new Set(tracks.map((t) => t.artist)).size).toBe(3);
  expect(new Set(tracks.map((t) => t.albumArtist))).toEqual(new Set([ALBUM_ARTIST]));

  // The picker builds labels as `${album} — ${artist}`; under album-artist
  // grouping the compilation collapses to a single entry.
  const byAlbumArtist = new Set(tracks.map((t) => `${t.album} — ${t.albumArtist}`));
  expect([...byAlbumArtist]).toEqual([`${ALBUM} — ${ALBUM_ARTIST}`]);

  const byTrackArtist = new Set(tracks.map((t) => `${t.album} — ${t.artist}`));
  expect(byTrackArtist.size).toBe(3);
});

test("syncing without folder mirroring puts the compilation in one folder", async () => {
  test.skip(!seeded, "ffmpeg unavailable — cannot seed tagged audio");
  const window = await readyWindow();
  const deviceId = await scanAndAddDevice(window);

  const result = await window.evaluate(
    async (id) =>
      (await (window as unknown as ApiWindow).api.invoke("sync:start", {
        deviceId: id,
        syncType: "full",
        extraTrackPolicy: "keep",
        preserveFolderStructure: false,
        albumGrouping: "album-artist",
        includeMusic: true,
        includePodcasts: false,
        includeAudiobooks: false,
        includePlaylists: false,
      })) as { status: string; errors: number },
    deviceId
  );
  expect(result.errors).toBe(0);

  const musicDir = path.join(deviceDir, "Music");
  const albumDir = path.join(musicDir, ALBUM_ARTIST, ALBUM);
  expect(fs.existsSync(albumDir)).toBe(true);
  expect(fs.readdirSync(albumDir).filter((f) => f.endsWith(".mp3"))).toHaveLength(3);

  // The old bug: one top-level folder per contributing track artist.
  for (const artist of TRACK_ARTISTS) {
    expect(fs.existsSync(path.join(musicDir, artist))).toBe(false);
  }
});

test("track-artist grouping restores the per-artist folder layout", async () => {
  test.skip(!seeded, "ffmpeg unavailable — cannot seed tagged audio");
  const window = await readyWindow();
  const deviceId = await scanAndAddDevice(window);

  await window.evaluate(
    async (id) =>
      (window as unknown as ApiWindow).api.invoke("sync:start", {
        deviceId: id,
        syncType: "full",
        extraTrackPolicy: "keep",
        preserveFolderStructure: false,
        albumGrouping: "track-artist",
        includeMusic: true,
        includePodcasts: false,
        includeAudiobooks: false,
        includePlaylists: false,
      }),
    deviceId
  );

  const musicDir = path.join(deviceDir, "Music");
  for (const artist of TRACK_ARTISTS) {
    expect(fs.existsSync(path.join(musicDir, artist, ALBUM))).toBe(true);
  }
});

test("the grouping preference persists per device", async () => {
  test.skip(!seeded, "ffmpeg unavailable — cannot seed tagged audio");
  const window = await readyWindow();
  const deviceId = await scanAndAddDevice(window);

  const prefs = await window.evaluate(async (id) => {
    const api = (window as unknown as ApiWindow).api;
    const before = (await api.invoke("sync:getDevicePreferences", id)) as {
      albumGrouping?: string;
    } | null;

    await api.invoke("sync:start", {
      deviceId: id,
      syncType: "full",
      extraTrackPolicy: "keep",
      preserveFolderStructure: false,
      albumGrouping: "track-artist",
      includeMusic: true,
      includePodcasts: false,
      includeAudiobooks: false,
      includePlaylists: false,
    });

    const after = (await api.invoke("sync:getDevicePreferences", id)) as {
      albumGrouping?: string;
    } | null;
    return { before: before?.albumGrouping ?? null, after: after?.albumGrouping ?? null };
  }, deviceId);

  // Defaults to album-artist (or has no saved prefs yet), then persists the choice.
  expect(prefs.after).toBe("track-artist");
  if (prefs.before !== null) expect(prefs.before).toBe("album-artist");
});

test("custom sync selects the whole compilation from a single album label", async () => {
  test.skip(!seeded, "ffmpeg unavailable — cannot seed tagged audio");
  const window = await readyWindow();
  const deviceId = await scanAndAddDevice(window);

  const result = await window.evaluate(
    async ([id, label]) =>
      (await (window as unknown as ApiWindow).api.invoke("sync:start", {
        deviceId: id,
        syncType: "custom",
        extraTrackPolicy: "keep",
        preserveFolderStructure: false,
        albumGrouping: "album-artist",
        selections: {
          mode: "include",
          albums: [label],
          artists: [],
          genres: [],
          podcasts: [],
          audiobooks: [],
          playlists: [],
        },
      })) as { errors: number; synced: number },
    [deviceId, `${ALBUM} — ${ALBUM_ARTIST}`] as [number, string]
  );

  expect(result.errors).toBe(0);
  expect(result.synced).toBe(3);
});
