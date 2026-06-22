/**
 * Playwright E2E — Library panel playlist filter
 *
 * Verifies that:
 *  1. The old tracks/playlists tab toggle is gone from LibraryPanel.
 *  2. A "Playlist" filter <select> is present in the Library panel filters row.
 *
 * The filters row only renders once the library has at least one folder
 * configured (otherwise the panel shows the "add a folder" empty state), so the
 * test seeds a folder via the exposed `library:addFolder` IPC before asserting.
 * The folder path must live under an allowed root (the user's home dir).
 *
 * Run with: `npm run build && npx playwright test`
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { test, expect } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./electron-launcher";

let launched: LaunchedApp;
let seedDir: string;

test.beforeEach(async () => {
  // Folder paths are validated against allowed prefixes (home dir), so the
  // seed folder must live under home — not os.tmpdir().
  seedDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-lib-"));
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

test("Library panel has a Playlist filter select and no tracks/playlists tab toggle", async () => {
  const window = await launched.app.firstWindow();
  await window.waitForLoadState("domcontentloaded");

  // Seed a library folder so the panel renders the track/filters view instead
  // of the "no folders configured" empty state.
  await window.evaluate(
    (folderPath) =>
      (window as unknown as { api: { invoke: (c: string, ...a: unknown[]) => Promise<unknown> } }).api.invoke(
        "library:addFolder",
        { name: "E2E Seed", path: folderPath, contentType: "music" }
      ),
    seedDir
  );

  // Navigate to the Library panel via its nav item (mounts fresh and fetches
  // the seeded folder).
  const libraryNav = window.locator('[data-panel="library"], [data-testid="nav-library"], button:has-text("Library")').first();
  if (await libraryNav.isVisible()) {
    await libraryNav.click();
  }

  // The old tab buttons ("Tracks" / "Playlists" toggle) must not exist
  const tracksTab = window.locator('[role="tab"]:has-text("Tracks")');
  const playlistsTab = window.locator('[role="tab"]:has-text("Playlists")');
  await expect(tracksTab).toHaveCount(0);
  await expect(playlistsTab).toHaveCount(0);

  // A playlist filter select should be present. The Library panel uses the
  // custom <Select> component (a button + role="listbox" dropdown, not a native
  // <select>), tagged with data-testid="playlist-filter".
  const playlistFilter = window.locator('[data-testid="playlist-filter"]').first();
  await expect(playlistFilter).toBeVisible({ timeout: 10_000 });
  // It sits next to a "Playlist:" label.
  await expect(window.locator("text=Playlist:").first()).toBeVisible();
});
