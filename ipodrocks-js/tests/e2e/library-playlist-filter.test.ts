/**
 * Playwright E2E — Library panel playlist filter
 *
 * Verifies that:
 *  1. The old tracks/playlists tab toggle is gone from LibraryPanel.
 *  2. A "Playlist" filter <select> is present in the Library panel filters row.
 *
 * Run with: `npm run build && npx playwright test`
 */
import { test, expect } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./electron-launcher";

let launched: LaunchedApp;

test.beforeEach(async () => {
  launched = await launchApp();
});

test.afterEach(async () => {
  await launched.cleanup();
});

test("Library panel has a Playlist filter select and no tracks/playlists tab toggle", async () => {
  const window = await launched.app.firstWindow();
  await window.waitForLoadState("domcontentloaded");

  // Navigate to the Library panel via its nav item
  const libraryNav = window.locator('[data-panel="library"], [data-testid="nav-library"], button:has-text("Library")').first();
  if (await libraryNav.isVisible()) {
    await libraryNav.click();
  }

  // Wait for the panel to render
  await window.waitForTimeout(500);

  // The old tab buttons ("Tracks" / "Playlists" toggle) must not exist
  const tracksTab = window.locator('[role="tab"]:has-text("Tracks")');
  const playlistsTab = window.locator('[role="tab"]:has-text("Playlists")');
  await expect(tracksTab).toHaveCount(0);
  await expect(playlistsTab).toHaveCount(0);

  // A playlist filter select should be present — look for a <select> or combobox
  // whose placeholder/default option contains "All" or "Playlist"
  const playlistFilter = window.locator('select[data-testid="playlist-filter"], select').filter({ hasText: /all playlists|playlist/i }).first();
  await expect(playlistFilter).toBeVisible();
});
