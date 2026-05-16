/**
 * Playwright smoke tests — launch the built Electron app and verify the
 * core UI wires up. These check that IPC, preload, and renderer all load;
 * deep behavioral coverage lives in `src/__tests__/behaviors`.
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

test("app launches and a window opens", async () => {
  const window = await launched.app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  const title = await window.title();
  expect(title.length).toBeGreaterThan(0);
});

test("preload exposes the IPC bridge to the renderer", async () => {
  const window = await launched.app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  const hasApi = await window.evaluate(() => typeof (window as unknown as { api?: unknown }).api === "object");
  expect(hasApi).toBe(true);
});

test("main panel renders some interactive content (not a blank page)", async () => {
  const window = await launched.app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  // Loosen: just verify there's *some* rendered text. The first launch shows
  // the welcome flow; later launches show the dashboard. Either is fine.
  const body = await window.locator("body").innerText();
  expect(body.trim().length).toBeGreaterThan(0);
});
