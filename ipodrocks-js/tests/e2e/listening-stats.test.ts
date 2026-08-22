/**
 * Playwright e2e — Dashboard "Listening Stats" card.
 *
 * A fresh profile has no ingested `playback.log` data, and there is no IPC
 * channel to seed playback logs (see `genius-playlist.test.ts`), so this
 * covers the two things reachable through the built app on a fresh profile:
 * the `genius:getListeningStats` IPC channel returns a well-formed, zeroed
 * result for every period, and the Dashboard renders the card with its
 * period toggle and empty state. Positive-path aggregation (top tracks,
 * artists, genre, period filtering) is covered by the unit tests in
 * `src/__tests__/behaviors/genius.test.ts`.
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

test("genius:getListeningStats returns zeroed stats for every period on a fresh profile", async () => {
  const window = await launched.app.firstWindow();
  await window.waitForLoadState("domcontentloaded");

  for (const period of ["all", "year", "month"]) {
    const stats = await window.evaluate(async (p) => {
      return (window as unknown as {
        api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
      }).api.invoke("genius:getListeningStats", p);
    }, period);

    expect(stats).toMatchObject({
      period,
      totalPlays: 0,
      totalListeningTimeMs: 0,
      uniqueTracksPlayed: 0,
      topTracks: [],
      topArtists: [],
      topGenre: null,
      totalLibraryPlays: 0,
    });
  }
});

test("Dashboard renders the Listening Stats card with a period toggle and empty state", async () => {
  const window = await launched.app.firstWindow();
  await window.waitForLoadState("domcontentloaded");

  const dashboardNav = window
    .locator('[data-panel="dashboard"], [data-testid="nav-dashboard"], button:has-text("Dashboard")')
    .first();
  await dashboardNav.click();

  await expect(window.getByText("Listening Stats")).toBeVisible();
  await expect(window.getByRole("button", { name: "All Time" })).toBeVisible();
  await expect(window.getByRole("button", { name: "This Year" })).toBeVisible();
  await expect(window.getByRole("button", { name: "This Month" })).toBeVisible();
  await expect(window.getByText(/No listening data yet/i)).toBeVisible();
});
