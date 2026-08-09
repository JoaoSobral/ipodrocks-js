/**
 * Playwright E2E — playlists self-heal when songs leave the library
 *
 * Regression for the bug where a playlist kept pointing at songs whose files
 * had been deleted. `LibraryScanner.deleteRemovedTracks()` runs its deletes
 * with `PRAGMA foreign_keys = OFF`, so the ON DELETE CASCADE on
 * `playlist_items.track_id` never fired and the user had to spot a "broken
 * playlists" banner and click Repair by hand.
 *
 * Verifies, with **no manual repair call anywhere in this test**:
 *  1. A Classic playlist drops a song whose file was deleted, after a rescan.
 *  2. A Smart playlist drops it too, and its positions stay contiguous.
 *  3. `playlist:getBroken` reports nothing afterwards.
 *  4. A rescan that *adds* a matching file grows the Smart playlist but leaves
 *     the hand-picked Classic playlist alone.
 *
 * Seed folders must live under the user's home dir (path allowlist).
 *
 * Run with: `npm run build && npx playwright test tests/e2e/playlist-auto-repair.test.ts`
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { test, expect } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./electron-launcher";

interface ApiWindow {
  api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
}

type Track = { id: number; path: string; title: string; genre: string };
type Playlist = { id: number; name: string; typeName: string; trackCount: number };
type BrokenPlaylist = { id: number; name: string; missingCount: number };

let launched: LaunchedApp;
let seedDir: string;

function writeSong(stem: string): string {
  const filePath = path.join(seedDir, `${stem}.mp3`);
  // Unparseable placeholders are fine — the scanner falls back to the filename
  // stem as the title, which is all this test needs to tell songs apart.
  fs.writeFileSync(filePath, Buffer.from(`bytes-${stem}`));
  return filePath;
}

function invoke<T>(
  window: import("@playwright/test").Page,
  channel: string,
  arg?: unknown
): Promise<T> {
  return window.evaluate(
    ([ch, a]) =>
      (window as unknown as ApiWindow).api.invoke(ch as string, ...(a === undefined ? [] : [a])),
    [channel, arg] as [string, unknown]
  ) as Promise<T>;
}

async function scan(window: import("@playwright/test").Page): Promise<void> {
  await invoke(window, "library:scan", {
    folders: [{ name: "E2E Playlist Seed", path: seedDir, contentType: "music" }],
  });
}

async function musicTracks(window: import("@playwright/test").Page): Promise<Track[]> {
  return invoke<Track[]>(window, "library:getTracks", { contentType: "music" });
}

async function playlistTrackIds(
  window: import("@playwright/test").Page,
  playlistId: number
): Promise<number[]> {
  const tracks = await invoke<Array<{ id: number }>>(window, "playlist:getTracks", playlistId);
  return tracks.map((t) => t.id);
}

test.beforeEach(async () => {
  seedDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-plrepair-"));
  launched = await launchApp();
});

test.afterEach(async () => {
  await launched.cleanup();
  try {
    fs.rmSync(seedDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test("playlists drop deleted songs automatically on the next library scan", async () => {
  const window = await launched.app.firstWindow();
  await window.waitForLoadState("domcontentloaded");

  writeSong("alpha");
  writeSong("bravo");
  writeSong("charlie");
  writeSong("delta");

  await invoke(window, "library:addFolder", {
    name: "E2E Playlist Seed",
    path: seedDir,
    contentType: "music",
  });
  await scan(window);

  const tracks = await musicTracks(window);
  expect(tracks).toHaveLength(4);

  const byStem = new Map(tracks.map((t) => [path.parse(t.path).name, t]));
  const alpha = byStem.get("alpha")!;
  const bravo = byStem.get("bravo")!;
  const charlie = byStem.get("charlie")!;
  expect(alpha && bravo && charlie).toBeTruthy();

  // A hand-picked Classic playlist over three of the four songs.
  const classic = await invoke<Playlist>(window, "playlist:createClassic", {
    name: "Road Trip",
    trackIds: [alpha.id, bravo.id, charlie.id],
  });
  expect(classic.typeName).toBe("classic");
  expect(classic.trackCount).toBe(3);

  // A Smart playlist over the genre every placeholder falls back to, so it
  // matches all four songs.
  const genres = await invoke<Array<{ id: number; name: string }>>(window, "playlist:getGenres");
  const genre = genres[0];
  expect(genre).toBeTruthy();
  const smart = await invoke<Playlist>(window, "playlist:create", {
    name: "Everything",
    strategy: "multi",
    rules: [{ ruleType: "genre", targetId: genre.id, targetLabel: genre.name }],
  });
  expect(smart.trackCount).toBe(4);

  // The user deletes a file outside the app, then rescans.
  fs.unlinkSync(alpha.path);
  await scan(window);

  const classicIds = await playlistTrackIds(window, classic.id);
  expect(classicIds).toEqual([bravo.id, charlie.id]);
  expect(classicIds).not.toContain(alpha.id);

  const smartIds = await playlistTrackIds(window, smart.id);
  expect(smartIds).toHaveLength(3);
  expect(smartIds).not.toContain(alpha.id);

  // No manual repair was called — nothing should still be reported broken.
  const broken = await invoke<BrokenPlaylist[]>(window, "playlist:getBroken");
  expect(broken).toEqual([]);
});

test("a rescan grows smart playlists but leaves hand-picked ones untouched", async () => {
  const window = await launched.app.firstWindow();
  await window.waitForLoadState("domcontentloaded");

  writeSong("one");
  writeSong("two");

  await invoke(window, "library:addFolder", {
    name: "E2E Playlist Seed",
    path: seedDir,
    contentType: "music",
  });
  await scan(window);

  const tracks = await musicTracks(window);
  expect(tracks).toHaveLength(2);

  const classic = await invoke<Playlist>(window, "playlist:createClassic", {
    name: "Just Two",
    trackIds: tracks.map((t) => t.id),
  });

  const genres = await invoke<Array<{ id: number; name: string }>>(window, "playlist:getGenres");
  const smart = await invoke<Playlist>(window, "playlist:create", {
    name: "All Of It",
    strategy: "multi",
    rules: [{ ruleType: "genre", targetId: genres[0].id, targetLabel: genres[0].name }],
  });
  expect(smart.trackCount).toBe(2);

  // A new song appears in the watched folder.
  writeSong("three");
  await scan(window);

  // Smart re-resolves from its rule and picks the new song up…
  expect(await playlistTrackIds(window, smart.id)).toHaveLength(3);
  // …while the hand-picked list is left exactly as the user built it.
  expect(await playlistTrackIds(window, classic.id)).toHaveLength(2);
});
