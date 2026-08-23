/**
 * E2E — importing Rockbox's runtime data from a device that does not hold the
 * library's own files (issue #117).
 *
 * `rockbox-runtime-data.test.ts` covers the happy path where the device holds a
 * byte-identical copy of the library, so every path lines up and the exact
 * match recorded by Check Device carries the whole import. That is the one
 * configuration in which the old matcher worked. The normal configuration is
 * the opposite: a codec profile converts on the way to the device, so the file
 * Rockbox has recorded counters against is spelled differently from the library
 * track it came from — a different extension always, and sanitised folder and
 * file names whenever a tag holds a character FAT cannot store.
 *
 * On the reporter's iPod that made all 2411 runtime records unmatchable and the
 * import silently did nothing. These tests hold every part of that spelling
 * difference: the extension across every codec the app can produce, the
 * FAT-invalid characters, and the shadow-library indirection that made the
 * exact tier miss as well.
 *
 * Drives the real built app (renderer → preload → main → SQLite → filesystem)
 * through real channels only. Seed folders live under the user's home dir
 * (main-process path allowlist).
 *
 * The shadow-library join is pinned on its own, in isolation from the tiers
 * that can mask it, in
 * src/__tests__/regressions/runtime-shadow-device-match.test.ts.
 *
 * Run: npm run build && npx playwright test tests/e2e/rockbox-runtime-transcoded.test.ts
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { test, expect, type Page } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./electron-launcher";
import {
  writeTcdFixture,
  type TcdFixtureTrack,
} from "../../src/__tests__/harness/tcd-fixture";

interface Api {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, cb: (...args: unknown[]) => void) => () => void;
}
interface ApiWindow {
  api: Api;
}

let launched: LaunchedApp;
let rootDir: string;
let libraryDir: string;
let deviceDir: string;
let shadowDir: string;

const DEVICE_NAME = "E2E Transcoded iPod";

/**
 * The extensions the app's codec profiles produce, one per track.
 *
 * The point of the list is that it is a list: matching must not care which of
 * these the device happens to hold, so every one of them is put on the device
 * against the same kind of FLAC source and every one must come back matched.
 * `.flac` is in here deliberately — a passthrough profile is just another case,
 * not the only one that works.
 */
const DEVICE_EXTENSIONS = [".mp3", ".m4a", ".ogg", ".opus", ".mpc", ".flac"];

function ffmpegAvailable(): boolean {
  try {
    return spawnSync("ffmpeg", ["-version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

test.skip(!ffmpegAvailable(), "requires ffmpeg to generate tagged audio fixtures");

interface SourceTrack {
  /** Path under the library folder, extension included. */
  relPath: string;
  title: string;
  artist: string;
  album: string;
}

/** A real, tagged FLAC — the app has to read these tags for the match to work. */
function makeSource(track: SourceTrack): void {
  const full = path.join(libraryDir, track.relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const r = spawnSync(
    "ffmpeg",
    [
      "-y", "-f", "lavfi",
      "-i", "sine=frequency=440:duration=1",
      "-metadata", `title=${track.title}`,
      "-metadata", `artist=${track.artist}`,
      "-metadata", `album=${track.album}`,
      "-c:a", "flac", full,
    ],
    { encoding: "utf8" }
  );
  if (r.status !== 0) throw new Error(`ffmpeg failed for ${track.relPath}: ${r.stderr}`);
}

/** Create the four folders Rockbox expects, so the device walk has somewhere to look. */
function makeDeviceFolders(): void {
  for (const folder of ["Music", "Podcasts", "Audiobooks", "Playlists"]) {
    fs.mkdirSync(path.join(deviceDir, folder), { recursive: true });
  }
}

/** Put a file on the device at `Music/<relPath>` and return its Rockbox path. */
function putOnDevice(relPath: string): string {
  const full = path.join(deviceDir, "Music", relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(2048));
  return `/<HDD0>/Music/${relPath.split(path.sep).join("/")}`;
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

function call<T>(window: Page, channel: string, ...args: unknown[]): Promise<T> {
  return window.evaluate(
    async ([c, a]) =>
      (window as unknown as ApiWindow).api.invoke(c as string, ...(a as unknown[])),
    [channel, args] as const
  ) as Promise<T>;
}

interface ImportResult {
  imported: number;
  unmatched: number;
  newPlays: number;
  reason: string | null;
}

/**
 * Scan the library and register the device.
 *
 * `devMode` bypasses the mount-point test so a plain folder counts as a
 * connected device. Check Device runs too, exactly as a user would run it: with
 * a converting profile it cannot match the device's files by name and size, so
 * it records nothing — which is the state the import has to work from.
 */
async function setUp(window: Page): Promise<number> {
  await call(window, "library:scan", {
    folders: [{ name: "E2E Transcoded", path: libraryDir, contentType: "music" }],
  });
  const device = await call<{ id: number }>(window, "device:add", {
    name: DEVICE_NAME,
    mountPath: deviceDir,
    devMode: true,
  });
  await call(window, "device:check", device.id);
  return device.id;
}

/** title -> play count, straight out of the imported statistics. */
async function playCountsByTitle(
  window: Page
): Promise<Record<string, number>> {
  const playlist = await call<{
    tracks: Array<{ title: string; playCount: number }>;
  }>(window, "genius:generate", null, "most_played", {
    maxTracks: 100,
    minPlays: 1,
  });
  const out: Record<string, number> = {};
  for (const t of playlist.tracks) out[t.title] = t.playCount;
  return out;
}

test.beforeEach(async () => {
  rootDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-rttrans-"));
  libraryDir = path.join(rootDir, "library");
  deviceDir = path.join(rootDir, "device");
  shadowDir = path.join(rootDir, "shadow");
  for (const dir of [libraryDir, deviceDir, shadowDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  makeDeviceFolders();
  launched = await launchApp();
});

test.afterEach(async () => {
  await launched.cleanup();
  try {
    fs.rmSync(rootDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test("counters import whatever codec the device holds them against", async () => {
  const ARTIST = "Runtime Artist";
  const ALBUM = "Runtime Album";

  // One track per codec the app can write, each with its own play count so a
  // counter landing on the wrong track shows up as a wrong number rather than
  // as a matching total.
  const expected: Record<string, number> = {};
  const fixture: TcdFixtureTrack[] = [];
  DEVICE_EXTENSIONS.forEach((ext, i) => {
    const title = `Track ${i + 1}`;
    const stem = `0${i + 1} ${title}`;
    makeSource({
      relPath: path.join(ARTIST, ALBUM, `${stem}.flac`),
      title,
      artist: ARTIST,
      album: ALBUM,
    });
    const devicePath = putOnDevice(path.join(ARTIST, ALBUM, `${stem}${ext}`));
    const playCount = (i + 1) * 2;
    expected[title] = playCount;
    fixture.push({
      path: devicePath,
      playCount,
      playTimeMs: playCount * 200_000,
      lengthMs: 200_000,
      lastPlayedSerial: i + 1,
    });
  });
  writeTcdFixture(deviceDir, fixture);

  const window = await readyWindow();
  const deviceId = await setUp(window);

  const res = await call<ImportResult>(window, "device:readRuntimeData", deviceId);
  expect(res.reason).toBeNull();
  // The whole of issue #117 in one assertion: not one of these matched before.
  expect(res.unmatched).toBe(0);
  expect(res.imported).toBe(DEVICE_EXTENSIONS.length);

  // And each counter reached the track it belongs to, not merely some track.
  expect(await playCountsByTitle(window)).toEqual(expected);

  const stats = await call<{ totalPlays: number }>(
    window,
    "genius:getListeningStats",
    "all"
  );
  expect(stats.totalPlays).toBe(
    Object.values(expected).reduce((a, b) => a + b, 0)
  );
});

test("names FAT cannot store still match the track they came from", async () => {
  // The library folder is deliberately not the tag layout, so the folder-mirror
  // match cannot carry this test — it has to be made on the tags, which is
  // where the sanitisation has to agree.
  const ARTIST = 'AC/DC';
  const ALBUM = 'Back in Black (Atlantic)';
  const cases = [
    { title: "Hells Bells", libName: "01 Hells Bells", deviceName: "01 Hells Bells" },
    // "?" and '"' are legal in a library filename and impossible on the device.
    { title: "What Good Am I?", libName: "02 What Good Am I?", deviceName: "02 What Good Am I_" },
    { title: '"40"', libName: '03 "40"', deviceName: "03 _40_" },
  ];

  const expected: Record<string, number> = {};
  const fixture: TcdFixtureTrack[] = [];
  cases.forEach((c, i) => {
    makeSource({
      relPath: path.join("Assorted", `${c.libName}.flac`),
      title: c.title,
      artist: ARTIST,
      album: ALBUM,
    });
    // What the sync writes: the artist's slash becomes "_" rather than an extra
    // folder, and the codec profile has changed the extension.
    const devicePath = putOnDevice(
      path.join("AC_DC", ALBUM, `${c.deviceName}.ogg`)
    );
    const playCount = (i + 1) * 3;
    expected[c.title] = playCount;
    fixture.push({
      path: devicePath,
      playCount,
      playTimeMs: playCount * 180_000,
      lengthMs: 180_000,
      rating: 8,
      lastPlayedSerial: i + 1,
    });
  });
  writeTcdFixture(deviceDir, fixture);

  const window = await readyWindow();
  const deviceId = await setUp(window);

  const res = await call<ImportResult>(window, "device:readRuntimeData", deviceId);
  expect(res.unmatched).toBe(0);
  expect(res.imported).toBe(cases.length);
  expect(await playCountsByTitle(window)).toEqual(expected);
});

test("a track the library does not have is reported unmatched, not guessed at", async () => {
  makeSource({
    relPath: path.join("Known Artist", "Known Album", "01 Known.flac"),
    title: "Known",
    artist: "Known Artist",
    album: "Known Album",
  });
  const known = putOnDevice(
    path.join("Known Artist", "Known Album", "01 Known.opus")
  );
  const stranger = putOnDevice(
    path.join("Some Other Artist", "Some Other Album", "09 Stranger.opus")
  );
  writeTcdFixture(deviceDir, [
    { path: known, playCount: 4, playTimeMs: 800_000, lengthMs: 200_000 },
    { path: stranger, playCount: 7, playTimeMs: 1_400_000, lengthMs: 200_000 },
  ]);

  const window = await readyWindow();
  const deviceId = await setUp(window);

  const res = await call<ImportResult>(window, "device:readRuntimeData", deviceId);
  expect(res.imported).toBe(1);
  expect(res.unmatched).toBe(1);
  // The stranger's 7 plays must not have been credited to the one track we do
  // hold. Ignoring the extension widens what matches; it must not widen this.
  expect(await playCountsByTitle(window)).toEqual({ Known: 4 });
});

test("two tracks that differ only by extension leave each other alone", async () => {
  // A library holding both a FLAC and an MP3 of one song gives two candidates
  // for one device file once the extension stops being part of the comparison.
  // Neither may be picked: a play count on the wrong copy is invisible.
  for (const ext of [".flac", ".mp3"]) {
    const full = path.join(libraryDir, "Dupe Artist", "Dupe Album", `01 Twin${ext}`);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const r = spawnSync(
      "ffmpeg",
      [
        "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
        "-metadata", "title=Twin",
        "-metadata", "artist=Dupe Artist",
        "-metadata", "album=Dupe Album",
        full,
      ],
      { encoding: "utf8" }
    );
    if (r.status !== 0) throw new Error(`ffmpeg failed for ${ext}: ${r.stderr}`);
  }
  const devicePath = putOnDevice(
    path.join("Dupe Artist", "Dupe Album", "01 Twin.ogg")
  );
  writeTcdFixture(deviceDir, [
    { path: devicePath, playCount: 9, playTimeMs: 1_800_000, lengthMs: 200_000 },
  ]);

  const window = await readyWindow();
  const deviceId = await setUp(window);

  const res = await call<ImportResult>(window, "device:readRuntimeData", deviceId);
  expect(res.imported).toBe(0);
  expect(res.unmatched).toBe(1);
  expect(await playCountsByTitle(window)).toEqual({});
});

test("a device fed by a shadow library imports through to the source tracks", async () => {
  // The reporter's configuration: the library is FLAC, a shadow library holds
  // the transcodes, and the device holds a copy of the shadow library. The
  // path Check Device records is therefore the shadow file, which is not any
  // track's path — the join has to follow it back through shadow_tracks.
  const ARTIST = "Shadow Artist";
  const ALBUM = "Shadow Album";
  const titles = ["Shadow One", "Shadow Two"];
  titles.forEach((title, i) => {
    makeSource({
      relPath: path.join(ARTIST, ALBUM, `0${i + 1} ${title}.flac`),
      title,
      artist: ARTIST,
      album: ALBUM,
    });
  });

  const window = await readyWindow();
  await call(window, "library:scan", {
    folders: [{ name: "E2E Shadow Src", path: libraryDir, contentType: "music" }],
  });

  // Build the shadow library for real — MP3 via ffmpeg, no external encoder.
  const shadowLibId = await window.evaluate(
    async ({ shadowPath }) => {
      const api = (window as unknown as ApiWindow).api;
      let done: () => void;
      const finished = new Promise<void>((resolve) => (done = resolve));
      const unsub = api.on("shadow:buildProgress", (...args: unknown[]) => {
        const p = args[args.length - 1] as { status: string };
        if (p.status === "complete" || p.status === "error" || p.status === "paused") done();
      });
      const configs = (await api.invoke("device:getCodecConfigs")) as Array<{
        id: number;
        codec_name: string;
      }>;
      const cfg = configs.find((c) => (c.codec_name ?? "").toUpperCase() === "MP3");
      if (!cfg) throw new Error("no MP3 codec configuration");
      const created = (await api.invoke("shadow:create", {
        name: "E2E Shadow",
        path: shadowPath,
        codecConfigId: cfg.id,
        vbrEnabled: false,
      })) as { id?: number; error?: string };
      if (created.error) throw new Error(`shadow:create failed: ${created.error}`);
      await finished;
      unsub();
      return created.id as number;
    },
    { shadowPath: shadowDir }
  );

  const shadowLibs = await call<Array<{ id: number; status: string }>>(
    window,
    "shadow:getAll"
  );
  expect(shadowLibs.find((l) => l.id === shadowLibId)?.status).toBe("ready");

  // Copy the shadow library onto the device, which is what a sync does.
  const copyTree = (from: string, to: string): void => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(dst, { recursive: true });
        copyTree(src, dst);
      } else {
        fs.copyFileSync(src, dst);
      }
    }
  };
  copyTree(shadowDir, path.join(deviceDir, "Music"));

  const device = await call<{ id: number }>(window, "device:add", {
    name: DEVICE_NAME,
    mountPath: deviceDir,
    devMode: true,
    sourceLibraryType: "shadow",
    shadowLibraryId: shadowLibId,
  });
  await call(window, "device:check", device.id);

  const expected: Record<string, number> = {};
  const fixture: TcdFixtureTrack[] = titles.map((title, i) => {
    const playCount = (i + 1) * 5;
    expected[title] = playCount;
    return {
      path: `/<HDD0>/Music/${ARTIST}/${ALBUM}/0${i + 1} ${title}.mp3`,
      playCount,
      playTimeMs: playCount * 200_000,
      lengthMs: 200_000,
      lastPlayedSerial: i + 1,
    };
  });
  writeTcdFixture(deviceDir, fixture);

  const res = await call<ImportResult>(window, "device:readRuntimeData", device.id);
  expect(res.unmatched).toBe(0);
  expect(res.imported).toBe(titles.length);
  expect(await playCountsByTitle(window)).toEqual(expected);
});
