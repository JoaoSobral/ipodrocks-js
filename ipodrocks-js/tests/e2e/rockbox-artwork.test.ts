/**
 * E2E tests for the per-device Rockbox artwork setting.
 *
 * Drives the real built app through the IPC bridge (renderer → preload → main
 * → SQLite) to verify that `artworkMaxDimension` and `skipAlbumArtwork` persist
 * and can be updated. The actual cover.jpg generation (real ffmpeg) is covered
 * by src/__tests__/behaviors/rockbox-artwork.test.ts.
 *
 * Run: npm run build && npx playwright test
 */
import { test, expect, type Page } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./electron-launcher";

let launched: LaunchedApp;

test.beforeEach(async () => {
  launched = await launchApp();
});
test.afterEach(async () => {
  await launched.cleanup();
});

async function readyWindow(): Promise<Page> {
  const window = await launched.app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: { invoke?: unknown } }).api?.invoke === "function",
    null,
    { timeout: 15_000 }
  );
  return window;
}

test("artwork max dimension defaults to 300 and round-trips through update", async () => {
  const window = await readyWindow();

  const result = await window.evaluate(async () => {
    const api = (window as unknown as {
      api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    }).api;

    const added = (await api.invoke("device:add", {
      name: `Artwork ${Date.now()}`,
      mountPath: "/tmp/ipr-artwork",
    })) as { id: number };

    const listBefore = (await api.invoke("device:list")) as Array<{
      id: number;
      artworkMaxDimension?: number;
    }>;
    const defaultDim = listBefore.find((d) => d.id === added.id)?.artworkMaxDimension;

    // Update to a different allowed size + skip flag.
    await api.invoke("device:update", added.id, {
      artworkMaxDimension: 500,
      skipAlbumArtwork: true,
    });

    const listAfter = (await api.invoke("device:list")) as Array<{
      id: number;
      artworkMaxDimension?: number;
      skipAlbumArtwork?: boolean;
    }>;
    const after = listAfter.find((d) => d.id === added.id);
    return { defaultDim, updatedDim: after?.artworkMaxDimension, skip: after?.skipAlbumArtwork };
  });

  expect(result.defaultDim).toBe(300);
  expect(result.updatedDim).toBe(500);
  expect(result.skip).toBe(true);
});

test("an out-of-range artwork dimension is clamped to the safe default", async () => {
  const window = await readyWindow();

  const dim = await window.evaluate(async () => {
    const api = (window as unknown as {
      api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    }).api;

    const added = (await api.invoke("device:add", {
      name: `Artwork Clamp ${Date.now()}`,
      mountPath: "/tmp/ipr-artwork-clamp",
    })) as { id: number };

    await api.invoke("device:update", added.id, { artworkMaxDimension: 9999 });

    const list = (await api.invoke("device:list")) as Array<{
      id: number;
      artworkMaxDimension?: number;
    }>;
    return list.find((d) => d.id === added.id)?.artworkMaxDimension;
  });

  // 9999 is not an allowed value → clamped to the 300 default.
  expect(dim).toBe(300);
});
