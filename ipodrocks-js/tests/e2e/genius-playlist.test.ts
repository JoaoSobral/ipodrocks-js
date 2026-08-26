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

test("genius:types returns all 13 types, gating the counter-based ones on a fresh profile", async () => {
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
      requiresRuntimeData?: boolean;
    }>;
    tracksWithPlays: number;
    totalPlays: number;
    deviceCount: number;
  };

  expect(Array.isArray(typed.types)).toBe(true);
  expect(typed.types.length).toBe(13);
  expect(typed.tracksWithPlays).toBe(0);
  expect(typed.totalPlays).toBe(0);
  expect(typed.deviceCount).toBe(0);

  const byValue = new Map(typed.types.map((t) => [t.value, t]));

  // These read library metadata only — ratings, and the absence of any play —
  // so they work on a library that has never been near a device.
  expect(byValue.get("top_rated")?.available).toBe(true);
  expect(byValue.get("starred")?.available).toBe(true);
  expect(byValue.get("hidden_gems")?.available).toBe(true);

  // Everything else needs Rockbox's counters. Disabled with a reason the UI
  // renders as a tooltip, rather than offering a guaranteed-empty playlist.
  for (const gated of ["most_played", "top_genre", "finish_album", "forgotten_favorites"]) {
    const t = byValue.get(gated);
    expect(t?.requiresRuntimeData, gated).toBe(true);
    expect(t?.available, gated).toBe(false);
    expect(t?.unavailableReason, gated).toMatch(/Gather Runtime Data/);
  }

  // Removed types must not come back. `late_night` bucketed plays by hour of
  // day, which runtime data cannot express — it carries no clock at all.
  for (const dead of [
    "late_night",
    "oldies",
    "nostalgia",
    "recent_favorites",
    "time_capsule",
    "golden_era",
  ]) {
    expect(byValue.has(dead), dead).toBe(false);
  }
});
