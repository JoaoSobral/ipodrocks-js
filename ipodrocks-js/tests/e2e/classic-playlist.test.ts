/**
 * Playwright E2E — Classic (hand-picked) playlists
 *
 * Drives the real picker UI in the built app:
 *  1. The Create chooser offers a Classic card that opens the track picker.
 *  2. Ticking rows updates the "N / 500 selected" counter.
 *  3. **Selection survives filtering** — narrowing by search or by the Artist
 *     dropdown hides rows but never unticks them. This is the core requirement
 *     for building a playlist across several searches.
 *  4. Saving persists the songs in tick order.
 *  5. "Edit tracks" reopens the picker pre-ticked and can shrink the list.
 *
 * The 500-track cap is covered by the unit tests
 * (`src/__tests__/behaviors/classic-playlists.test.ts`) — seeding 500 files
 * here would dominate the suite runtime. This test only asserts the counter
 * renders the cap.
 *
 * Seed folders must live under the user's home dir (path allowlist).
 *
 * Run with: `npm run build && npx playwright test tests/e2e/classic-playlist.test.ts`
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { test, expect, type Page } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./electron-launcher";

interface ApiWindow {
  api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
}

type Track = { id: number; path: string; title: string; artist: string };

let launched: LaunchedApp;
let seedDir: string;

function invoke<T>(window: Page, channel: string, arg?: unknown): Promise<T> {
  return window.evaluate(
    ([ch, a]) =>
      (window as unknown as ApiWindow).api.invoke(ch as string, ...(a === undefined ? [] : [a])),
    [channel, arg] as [string, unknown]
  ) as Promise<T>;
}

/** Seed the library with placeholder songs and scan them in. */
async function seedLibrary(window: Page, stems: string[]): Promise<Track[]> {
  for (const stem of stems) {
    fs.writeFileSync(path.join(seedDir, `${stem}.mp3`), Buffer.from(`bytes-${stem}`));
  }
  await invoke(window, "library:addFolder", {
    name: "E2E Classic Seed",
    path: seedDir,
    contentType: "music",
  });
  await invoke(window, "library:scan", {
    folders: [{ name: "E2E Classic Seed", path: seedDir, contentType: "music" }],
  });
  return invoke<Track[]>(window, "library:getTracks", { contentType: "music" });
}

async function openPlaylistsPanel(window: Page): Promise<void> {
  await window.locator('button:has-text("Playlists")').first().click();
}

/** Open Create Playlist → Classic and wait for the picker. */
async function openClassicPicker(window: Page): Promise<void> {
  await window.locator('button:has-text("+ Create Playlist")').first().click();
  await window.locator('[data-testid="create-classic-card"]').click();
  await expect(window.locator('[data-testid="classic-track-picker"]')).toBeVisible({
    timeout: 10_000,
  });
}

function rowCheckbox(window: Page, trackId: number) {
  return window.locator(`[data-testid="classic-track-row-${trackId}"] input[type="checkbox"]`);
}

test.beforeEach(async () => {
  seedDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-classic-"));
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

test("hand-picks songs into a Classic playlist and keeps the selection while filtering", async () => {
  const window = await launched.app.firstWindow();
  await window.waitForLoadState("domcontentloaded");

  const tracks = await seedLibrary(window, ["aurora", "beacon", "cinder", "dusk"]);
  expect(tracks).toHaveLength(4);

  const byStem = new Map(tracks.map((t) => [path.parse(t.path).name, t]));
  const aurora = byStem.get("aurora")!;
  const beacon = byStem.get("beacon")!;

  await openPlaylistsPanel(window);
  await openClassicPicker(window);

  const count = window.locator('[data-testid="classic-selection-count"]');
  await expect(count).toHaveText("0 / 500 selected");

  await rowCheckbox(window, aurora.id).check();
  await rowCheckbox(window, beacon.id).check();
  await expect(count).toHaveText("2 / 500 selected");

  // --- partial substring search, not just whole-word ---
  const search = window.locator('[data-testid="classic-picker-search"]');
  await search.fill("uror");
  await expect(window.locator('[data-testid^="classic-track-row-"]')).toHaveCount(1);
  await expect(window.locator(`[data-testid="classic-track-row-${aurora.id}"]`)).toBeVisible();

  // --- multi-term search spans fields: "aurora" is the title, "unknown" the
  //     artist/album fallback, and no single field contains both ---
  await search.fill("aurora unknown");
  await expect(window.locator('[data-testid^="classic-track-row-"]')).toHaveCount(1);
  await expect(window.locator(`[data-testid="classic-track-row-${aurora.id}"]`)).toBeVisible();

  // --- selection must survive a text search that hides one of the picks ---
  await search.fill("aurora");
  await expect(window.locator('[data-testid^="classic-track-row-"]')).toHaveCount(1);
  await expect(count).toHaveText("2 / 500 selected");
  await expect(rowCheckbox(window, aurora.id)).toBeChecked();

  // --- a term that matches nothing empties the list without losing picks ---
  await search.fill("zzzznomatch");
  await expect(window.locator('[data-testid^="classic-track-row-"]')).toHaveCount(0);
  await expect(count).toHaveText("2 / 500 selected");

  await search.fill("");
  await expect(count).toHaveText("2 / 500 selected");
  await expect(rowCheckbox(window, aurora.id)).toBeChecked();
  await expect(rowCheckbox(window, beacon.id)).toBeChecked();

  // --- and survive a dropdown filter too ---
  const artistFilter = window.locator('[data-testid="classic-artist-filter"]');
  await artistFilter.locator("button").first().click();
  await window.locator('[role="option"]').nth(1).click();
  await expect(count).toHaveText("2 / 500 selected");

  await window.locator('[data-testid="classic-reset-filters"]').click();
  await expect(count).toHaveText("2 / 500 selected");

  // --- save ---
  await window.locator('[data-testid="classic-name-input"]').fill("Road Trip");
  await window.locator('[data-testid="classic-save"]').click();

  await expect(window.locator('[data-testid="classic-track-picker"]')).toHaveCount(0, {
    timeout: 10_000,
  });

  const playlists = await invoke<Array<{ id: number; name: string; typeName: string; trackCount: number }>>(
    window,
    "playlist:list"
  );
  const created = playlists.find((p) => p.name.includes("Road Trip"));
  expect(created).toBeTruthy();
  expect(created!.typeName).toBe("classic");
  expect(created!.trackCount).toBe(2);

  // Order must match the order the boxes were ticked, not library sort order.
  const savedIds = (
    await invoke<Array<{ id: number }>>(window, "playlist:getTracks", created!.id)
  ).map((t) => t.id);
  expect(savedIds).toEqual([aurora.id, beacon.id]);
});

test("reopens an existing Classic playlist to edit its tracks", async () => {
  const window = await launched.app.firstWindow();
  await window.waitForLoadState("domcontentloaded");

  const tracks = await seedLibrary(window, ["ember", "frost", "glow"]);
  const [first, second] = tracks;

  await invoke(window, "playlist:createClassic", {
    name: "Evening",
    trackIds: [first.id, second.id],
  });

  await openPlaylistsPanel(window);

  // Open the playlist's detail view via its card's View button, then the editor.
  await window
    .locator('div:has(> div h4:text-is("classic_Evening"))')
    .locator('button:text-is("View")')
    .first()
    .click();
  const editButton = window.locator('[data-testid="classic-edit-tracks"]');
  await expect(editButton).toBeVisible({ timeout: 10_000 });
  await editButton.click();

  await expect(window.locator('[data-testid="classic-track-picker"]')).toBeVisible();
  const count = window.locator('[data-testid="classic-selection-count"]');
  await expect(count).toHaveText("2 / 500 selected");
  await expect(rowCheckbox(window, first.id)).toBeChecked();
  await expect(rowCheckbox(window, second.id)).toBeChecked();

  // Untick one and save.
  await rowCheckbox(window, first.id).uncheck();
  await expect(count).toHaveText("1 / 500 selected");
  await window.locator('[data-testid="classic-save"]').click();

  await expect(window.locator('[data-testid="classic-track-picker"]')).toHaveCount(0, {
    timeout: 10_000,
  });

  const playlists = await invoke<Array<{ id: number; name: string; trackCount: number }>>(
    window,
    "playlist:list"
  );
  const edited = playlists.find((p) => p.name.includes("Evening"))!;
  expect(edited.trackCount).toBe(1);

  const remaining = (
    await invoke<Array<{ id: number }>>(window, "playlist:getTracks", edited.id)
  ).map((t) => t.id);
  expect(remaining).toEqual([second.id]);
});
