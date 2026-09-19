/**
 * E2E — issue #138: "A new album was synced without the ratings."
 *
 * The reporter re-encoded his shadow library, synced, reinitialised his iPod's
 * database and synced again. The rebuild was caught and 343 ratings restored,
 * but the album copied in that sync arrived unrated, and nothing in the log said
 * why.
 *
 * `computeRatingPropagations()` joined `device_track_ratings` with an inner join,
 * and the only two things that write a row there are the ingest — which needs
 * the *device* to have reported the track — and the propagation bookkeeping
 * itself. So a rating on a track the device had never reported could not get
 * out. A rebuild verdict skips the ingest whole, so it could not get out on that
 * sync either.
 *
 * Drives the real built app through real channels, including a real sync, and
 * asserts against the bytes of the device's own `database_idx.tcd`. The units are
 * pinned in src/__tests__/regressions/rating-propagation-gap.test.ts.
 *
 * Run: npm run build && npx playwright test tests/e2e/rating-propagation-new-album.test.ts
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { test, expect, type Page } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./electron-launcher";
import {
  writeTcdFixture,
  readTcdNumericTag,
  TCD_TAG,
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

const DEVICE_NAME = "E2E Propagation iPod";
const ARTIST = "Prop Artist";
const OLD_ALBUM = "Old Album";
const NEW_ALBUM = "New Album";
const OLD_TITLES = ["One", "Two", "Three", "Four", "Five", "Six"];
const NEW_TITLES = ["Seven", "Eight", "Nine"];

async function readyWindow(): Promise<Page> {
  const window = await launched.app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await window.waitForFunction(
    () =>
      typeof (window as unknown as { api?: { invoke?: unknown } }).api?.invoke ===
      "function",
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

function writeAlbum(album: string, titles: string[]): void {
  const albumDir = path.join(libraryDir, ARTIST, album);
  fs.mkdirSync(albumDir, { recursive: true });
  for (const title of titles) {
    fs.writeFileSync(path.join(albumDir, `${title}.flac`), Buffer.alloc(4096));
  }
}

interface TrackRow {
  id: number;
  title: string;
  rating: number | null;
}

function libraryTracks(window: Page): Promise<TrackRow[]> {
  return call<TrackRow[]>(window, "library:getTracks", { contentType: "music" });
}

/**
 * Scan, then wait until every track it should have inserted is actually
 * readable, and return them.
 *
 * `library:scan` resolves before its inserts are visible to `library:getTracks`.
 * Reading straight after it is a race that a fast machine wins and CI does not:
 * only part of the library came back, so only part of it got rated, and the
 * "waiting for the device's database" assertion then failed against a log that
 * looked entirely reasonable. Never call `library:scan` here without this.
 */
async function scan(window: Page, expected: number): Promise<TrackRow[]> {
  await call(window, "library:scan", {
    folders: [{ name: "E2E Prop", path: libraryDir, contentType: "music" }],
  });
  return waitForTracks(window, expected);
}

/** Run a full music sync and return every log line it emitted. */
function runSync(window: Page, deviceId: number): Promise<string[]> {
  return window.evaluate(async (id) => {
    const api = (window as unknown as ApiWindow).api;
    const logs: string[] = [];
    const unsub = api.on("sync:progress", (...args: unknown[]) => {
      const p = args[args.length - 1] as { event?: string; message?: string };
      if (p?.event === "log" && p.message) logs.push(p.message);
    });
    await api.invoke("sync:start", {
      deviceId: id,
      syncType: "full",
      extraTrackPolicy: "keep",
      preserveFolderStructure: true,
      albumGrouping: "album-artist",
      includeMusic: true,
      includePodcasts: false,
      includeAudiobooks: false,
      includePlaylists: false,
    });
    unsub();
    return logs;
  }, deviceId);
}

/**
 * Plant a Rockbox database listing exactly the albums given, with a play history
 * so the runtime data is readable. Ratings default to 0 — "unrated", which is
 * all Rockbox can say — and `ratings` overrides per title, which is how a
 * re-plant models a device that still holds what was written to it earlier
 * rather than one that lost everything.
 */
function fixture(
  albums: { album: string; titles: string[] }[],
  ratings: Record<string, number> = {}
): Map<string, number> {
  const tracks: TcdFixtureTrack[] = [];
  const idxByTitle = new Map<string, number>();
  for (const { album, titles } of albums) {
    for (const title of titles) {
      idxByTitle.set(title, tracks.length);
      tracks.push({
        path: `/<HDD0>/Music/${ARTIST}/${album}/${title}.flac`,
        playCount: 2,
        playTimeMs: 400_000,
        lengthMs: 200_000,
        rating: ratings[title] ?? 0,
        lastPlayedSerial: tracks.length + 1,
      });
    }
  }
  writeTcdFixture(deviceDir, tracks);
  return idxByTitle;
}

/**
 * Poll until the library holds at least `count` tracks. Used only by
 * {@link scan}, which is the one place that needs it.
 */
async function waitForTracks(window: Page, count: number): Promise<TrackRow[]> {
  for (let i = 0; i < 50; i++) {
    const tracks = await libraryTracks(window);
    if (tracks.length >= count) return tracks;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`library never reached ${count} tracks`);
}

test.beforeEach(async () => {
  rootDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-prop-"));
  libraryDir = path.join(rootDir, "library");
  deviceDir = path.join(rootDir, "device");
  fs.mkdirSync(libraryDir, { recursive: true });
  fs.mkdirSync(deviceDir, { recursive: true });
  writeAlbum(OLD_ALBUM, OLD_TITLES);
  for (const folder of ["Music", "Podcasts", "Audiobooks", "Playlists"]) {
    fs.mkdirSync(path.join(deviceDir, folder), { recursive: true });
  }
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

test("an album the device has never rated gets its library ratings written", async () => {
  const window = await readyWindow();
  const tracks = await scan(window, OLD_TITLES.length);
  const device = await call<{ id: number }>(window, "device:add", {
    name: DEVICE_NAME,
    mountPath: deviceDir,
    devMode: true,
  });

  // Rated only in iPodRocks. The device has never had an opinion about any of
  // them, so nothing has ever created a device_track_ratings row.
  expect(tracks).toHaveLength(OLD_TITLES.length);
  for (const t of tracks) {
    await call(window, "ratings:setTrackRating", t.id, 8);
  }

  // The files are on the device and its database lists them, all reading 0.
  await runSync(window, device.id);
  const idx = fixture([{ album: OLD_ALBUM, titles: OLD_TITLES }]);

  const logs = await runSync(window, device.id);

  expect(logs.join("\n")).toMatch(/wrote 6 rating/i);
  for (const title of OLD_TITLES) {
    expect(readTcdNumericTag(deviceDir, idx.get(title)!, TCD_TAG.rating)).toBe(8);
  }
  // The library is untouched by the device's zeros.
  expect(
    (await libraryTracks(window)).filter((t) => t.rating === 8)
  ).toHaveLength(6);
});

test("a rebuilt device also repairs an album it has never reported", async () => {
  // The reporter's sync, end to end. The old album has been rated, pushed and
  // read back, so it has a baseline; then the device's database is rebuilt and a
  // new album is added to the library in the same breath. The rebuild verdict
  // skips the ingest, so nothing creates a baseline for the new album — and it
  // used to be unreachable for the rest of the device's life.
  const window = await readyWindow();
  const tracks = await scan(window, OLD_TITLES.length);
  const device = await call<{ id: number }>(window, "device:add", {
    name: DEVICE_NAME,
    mountPath: deviceDir,
    devMode: true,
  });

  expect(tracks).toHaveLength(OLD_TITLES.length);
  for (const t of tracks) {
    await call(window, "ratings:setTrackRating", t.id, 7);
  }
  await runSync(window, device.id);

  // The device reports those ratings back, establishing last_seen_rating.
  const rated = fixture([{ album: OLD_ALBUM, titles: OLD_TITLES }]);
  writeTcdFixture(
    deviceDir,
    OLD_TITLES.map((title, i) => ({
      path: `/<HDD0>/Music/${ARTIST}/${OLD_ALBUM}/${title}.flac`,
      playCount: 2,
      playTimeMs: 400_000,
      lengthMs: 200_000,
      rating: 7,
      lastPlayedSerial: i + 1,
    }))
  );
  await runSync(window, device.id);
  expect(rated.size).toBe(6);

  // Now: a new album in the library, and Database → Initialize Now on the
  // player, which lists both albums and has lost every rating.
  writeAlbum(NEW_ALBUM, NEW_TITLES);
  const all = await scan(window, OLD_TITLES.length + NEW_TITLES.length);
  // By title, not album: these stub files carry no tags, so every track scans
  // into "Unknown Album".
  const fresh = all.filter((t) => NEW_TITLES.includes(t.title));
  expect(fresh).toHaveLength(NEW_TITLES.length);
  for (const t of fresh) {
    await call(window, "ratings:setTrackRating", t.id, 10);
  }
  const idx = fixture([
    { album: OLD_ALBUM, titles: OLD_TITLES },
    { album: NEW_ALBUM, titles: NEW_TITLES },
  ]);

  const logs = await runSync(window, device.id);
  const log = logs.join("\n");

  expect(log).toMatch(/looks rebuilt/i);
  // Nine, not six: the three the device has never reported are repaired too.
  expect(log).toMatch(/restored 9 rating/i);
  for (const title of OLD_TITLES) {
    expect(readTcdNumericTag(deviceDir, idx.get(title)!, TCD_TAG.rating)).toBe(7);
  }
  for (const title of NEW_TITLES) {
    expect(readTcdNumericTag(deviceDir, idx.get(title)!, TCD_TAG.rating)).toBe(10);
  }
  // And the library kept its own ratings through the rebuild.
  const after = await libraryTracks(window);
  expect(after.filter((t) => t.rating === 7)).toHaveLength(6);
  expect(after.filter((t) => t.rating === 10)).toHaveLength(3);
});

test("a rating the device's database cannot take yet is reported, and lands next sync", async () => {
  // The other half of the reporter's confusion: on the sync that *copies* an
  // album, Rockbox does not know the files exist, so there is no record to write
  // a rating into. That is unavoidable — but it must be said out loud, and the
  // rating must survive to the sync after.
  const window = await readyWindow();
  const tracks = await scan(window, OLD_TITLES.length);
  const device = await call<{ id: number }>(window, "device:add", {
    name: DEVICE_NAME,
    mountPath: deviceDir,
    devMode: true,
  });

  // All six, or the counts below mean something else entirely: with only four
  // rated, four get written and none are left waiting, which is a *plausible*
  // log for a completely different reason.
  expect(tracks).toHaveLength(OLD_TITLES.length);
  for (const t of tracks) {
    await call(window, "ratings:setTrackRating", t.id, 6);
  }
  expect(
    (await libraryTracks(window)).filter((t) => t.rating === 6)
  ).toHaveLength(OLD_TITLES.length);

  await runSync(window, device.id);

  // The device's database knows about four of the six files only.
  const partial = fixture([{ album: OLD_ALBUM, titles: OLD_TITLES.slice(0, 4) }]);
  const logs = await runSync(window, device.id);
  const log = logs.join("\n");

  expect(log).toMatch(/wrote 4 rating/i);
  expect(log).toMatch(/2 rating\(s\) are waiting for the device's database/i);
  for (const title of OLD_TITLES.slice(0, 4)) {
    expect(readTcdNumericTag(deviceDir, partial.get(title)!, TCD_TAG.rating)).toBe(6);
  }

  // The user runs Database → Update now. The four already written keep their
  // value — iPodRocks correctly believes it has pushed those and leaves them be,
  // so a fixture that dropped them back to 0 would be testing a second wipe.
  const full = fixture(
    [{ album: OLD_ALBUM, titles: OLD_TITLES }],
    Object.fromEntries(OLD_TITLES.slice(0, 4).map((t) => [t, 6]))
  );
  const logs2 = (await runSync(window, device.id)).join("\n");

  expect(logs2).toMatch(/wrote 2 rating/i);
  expect(logs2).not.toMatch(/waiting for the device's database/i);
  for (const title of OLD_TITLES) {
    expect(readTcdNumericTag(deviceDir, full.get(title)!, TCD_TAG.rating)).toBe(6);
  }
});
