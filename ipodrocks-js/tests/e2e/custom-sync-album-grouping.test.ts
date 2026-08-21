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

/** Seed a single-artist album, optionally with an album-artist tag. */
function seedAlbum(
  album: string,
  artist: string,
  albumArtist: string | null,
  fileName = "01.mp3"
): boolean {
  const dir = path.join(seedDir, `${artist} - ${album}`);
  fs.mkdirSync(dir, { recursive: true });
  const meta = [
    "-metadata", `title=Only Track`,
    "-metadata", `artist=${artist}`,
    "-metadata", `album=${album}`,
  ];
  if (albumArtist) meta.push("-metadata", `album_artist=${albumArtist}`);

  const out = path.join(dir, fileName);
  const res = spawnSync(
    "ffmpeg",
    ["-y", "-v", "quiet", "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono", "-t", "1", ...meta, out],
    { encoding: "utf8" }
  );
  return res.status === 0 && fs.existsSync(out);
}

/** Open Sync → Custom so the album picker is on screen. */
async function openCustomSync(window: Page): Promise<void> {
  await window.click('button:has-text("Sync")');
  await window.click('input[value="custom"], label:has-text("Custom")');
  await window.waitForSelector('text="Choose what to sync"', { timeout: 10_000 });
}

/** The visible text of every row in the Albums box. */
async function albumRowTexts(window: Page): Promise<string[]> {
  const box = window
    .locator("div.theme-box")
    .filter({ has: window.locator('p:text-is("Albums")') })
    .first();
  await box.waitFor({ timeout: 10_000 });
  await box.locator("label").first().waitFor({ timeout: 10_000 });
  return (await box.locator("label").allInnerTexts()).map((t) => t.trim());
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

test("the album row shows the album name, not \"Album — Artist\"", async () => {
  test.skip(!seeded, "ffmpeg unavailable — cannot seed tagged audio");
  const window = await readyWindow();
  await scanAndAddDevice(window);
  await openCustomSync(window);

  const rows = await albumRowTexts(window);
  // The compilation is one row, and it reads as the plain album name.
  expect(rows).toContain(ALBUM);
  expect(rows.filter((r) => r === ALBUM)).toHaveLength(1);
  // No artist suffix on an unambiguous album.
  expect(rows.some((r) => r.includes(`${ALBUM} — `))).toBe(false);
});

test("two albums sharing a title still show their artists", async () => {
  test.skip(!seeded, "ffmpeg unavailable — cannot seed tagged audio");
  // Without the artist these would be two identical, unpickable rows.
  const a = seedAlbum("Greatest Hits", "ABBA", "ABBA");
  const b = seedAlbum("Greatest Hits", "Queen", "Queen");
  test.skip(!a || !b, "ffmpeg unavailable");

  const window = await readyWindow();
  await scanAndAddDevice(window);
  await openCustomSync(window);

  const rows = await albumRowTexts(window);
  expect(rows).toContain("Greatest Hits — ABBA");
  expect(rows).toContain("Greatest Hits — Queen");
  // ...while the unambiguous compilation stays clean.
  expect(rows).toContain(ALBUM);
});

test("ticking a renamed-looking row still syncs the right tracks", async () => {
  test.skip(!seeded, "ffmpeg unavailable — cannot seed tagged audio");
  const window = await readyWindow();
  const deviceId = await scanAndAddDevice(window);
  await openCustomSync(window);

  // Tick the compilation by its displayed (bare) name...
  await window.click(`label:has-text("${ALBUM}") input[type="checkbox"]`);
  await window.click('button:has-text("Start Sync")');
  await window.waitForSelector('text=/Completed|Success|completed/i', { timeout: 30_000 });

  // ...and the underlying key still selected all three tracks.
  const prefs = await window.evaluate(
    async (id) =>
      (await (window as unknown as ApiWindow).api.invoke(
        "sync:getDevicePreferences",
        id
      )) as { selections?: { albums?: string[] } } | null,
    deviceId
  );
  expect(prefs?.selections?.albums).toEqual([`${ALBUM} — ${ALBUM_ARTIST}`]);
});

test("a library with no album-artist tags explains why the setting looks inert", async () => {
  test.skip(!seeded, "ffmpeg unavailable — cannot seed tagged audio");
  // Wipe the tagged compilation; seed one album with NO album_artist tag.
  fs.rmSync(seedDir, { recursive: true, force: true });
  fs.mkdirSync(seedDir, { recursive: true });
  test.skip(!seedAlbum("Untagged Album", "Some Artist", null), "ffmpeg unavailable");

  const window = await readyWindow();
  await scanAndAddDevice(window);
  await openCustomSync(window);

  await expect(
    window.locator("text=/No album-artist tags are in use/i")
  ).toBeVisible({ timeout: 10_000 });
  await expect(window.locator('button:has-text("Scan library")')).toBeVisible();
});

test("the hint is absent once the library does have album-artist tags", async () => {
  test.skip(!seeded, "ffmpeg unavailable — cannot seed tagged audio");
  const window = await readyWindow();
  await scanAndAddDevice(window);
  await openCustomSync(window);

  await expect(
    window.locator("text=/No album-artist tags are in use/i")
  ).toHaveCount(0);
});
