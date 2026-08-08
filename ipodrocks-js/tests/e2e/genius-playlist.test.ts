/**
 * Playwright e2e — Genius playlist type availability contract.
 *
 * A fresh profile has no ingested `playback.log` data, and there is no IPC
 * channel to seed playback logs, so this drives the `genius:types` IPC through
 * the built app and asserts the availability contract the picker UI relies on:
 * every type is returned, and the clock-dependent type is marked unavailable
 * with a reason the UI can render verbatim. Positive-path generation is
 * covered by the unit tests in `src/__tests__/behaviors/genius.test.ts`.
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

test("genius:types returns all 12 types with the clock-gated one unavailable on a fresh profile", async () => {
  const window = await launched.app.firstWindow();
  await window.waitForLoadState("domcontentloaded");

  const res = await window.evaluate(async () => {
    return (window as unknown as {
      api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    }).api.invoke("genius:types");
  });

  const typed = res as {
    types: Array<{
      value: string;
      available?: boolean;
      unavailableReason?: string;
      requiresDeviceClock?: boolean;
    }>;
    dataMonths: number;
    firstLogDate: string | null;
    totalMatched: number;
    implausibleCount: number;
    clockValid: boolean;
  };

  expect(Array.isArray(typed.types)).toBe(true);
  expect(typed.types.length).toBe(12);
  expect(typed.dataMonths).toBe(0);
  expect(typed.firstLogDate).toBeNull();
  expect(typed.totalMatched).toBe(0);
  expect(typed.implausibleCount).toBe(0);
  // No plausible rows on a fresh profile, so the clock is not yet trusted.
  expect(typed.clockValid).toBe(false);

  const byValue = new Map(typed.types.map((t) => [t.value, t]));
  // Types needing no playback history at all.
  expect(byValue.get("top_rated")?.available).toBe(true);
  expect(byValue.get("hidden_gems")?.available).toBe(true);
  // Count/completion types stay selectable; they just come back empty.
  expect(byValue.get("most_played")?.available).toBe(true);
  expect(byValue.get("top_genre")?.available).toBe(true);
  expect(byValue.get("finish_album")?.available).toBe(true);

  // The one clock-dependent type is disabled, with a reason the UI renders.
  const lateNight = byValue.get("late_night");
  expect(lateNight?.requiresDeviceClock).toBe(true);
  expect(lateNight?.available).toBe(false);
  expect(lateNight?.unavailableReason).toBeTruthy();

  // The removed time-window types must not come back.
  for (const dead of ["oldies", "nostalgia", "recent_favorites", "time_capsule", "golden_era"]) {
    expect(byValue.has(dead), dead).toBe(false);
  }
});
