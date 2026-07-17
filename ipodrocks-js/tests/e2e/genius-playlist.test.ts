/**
 * Playwright e2e — Genius playlist type availability contract.
 *
 * A fresh profile has no ingested `playback.log` data, and there is no IPC
 * channel to seed playback logs, so this drives the `genius:types` IPC through
 * the built app and asserts the availability contract the picker UI relies on:
 * every type is returned, and time-gated types are marked unavailable with the
 * data-span context. Positive-path generation is covered by the unit tests in
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

test("genius:types returns all types with gated ones unavailable on a fresh profile", async () => {
  const window = await launched.app.firstWindow();
  await window.waitForLoadState("domcontentloaded");

  const res = await window.evaluate(async () => {
    return (window as unknown as {
      api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    }).api.invoke("genius:types");
  });

  const typed = res as {
    types: Array<{ value: string; available?: boolean; minMonths?: number }>;
    dataMonths: number;
    firstLogDate: string | null;
  };

  expect(Array.isArray(typed.types)).toBe(true);
  expect(typed.types.length).toBe(14);
  expect(typed.dataMonths).toBe(0);
  expect(typed.firstLogDate).toBeNull();

  const byValue = new Map(typed.types.map((t) => [t.value, t]));
  // No-threshold types are always available.
  expect(byValue.get("most_played")?.available).toBe(true);
  expect(byValue.get("top_rated")?.available).toBe(true);
  // Time-gated types are present but unavailable without history.
  for (const gated of ["recent_favorites", "nostalgia", "time_capsule", "golden_era", "oldies"]) {
    expect(byValue.get(gated)?.available, gated).toBe(false);
    expect(byValue.get(gated)?.minMonths, gated).toBeGreaterThan(0);
  }
});
