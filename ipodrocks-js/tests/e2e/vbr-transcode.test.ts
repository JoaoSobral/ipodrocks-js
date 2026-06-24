/**
 * E2E tests for the VBR (variable-bitrate) transcode option.
 *
 * Drives the real built app through the IPC bridge (renderer → preload → main
 * → SQLite) to verify that the `vbrEnabled` flag persists for both devices and
 * shadow libraries when a lossy codec is chosen.
 *
 * Run: npm run build && npx playwright test
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
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

test("device VBR setting round-trips through IPC for a lossy codec", async () => {
  const window = await readyWindow();

  const result = await window.evaluate(async () => {
    const api = (window as unknown as {
      api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    }).api;

    const configs = (await api.invoke("device:getCodecConfigs")) as Array<{
      id: number;
      codec_name: string;
    }>;
    const mp3 = configs.find((c) => (c.codec_name ?? "").toUpperCase() === "MP3");

    const onName = `VBR On ${Date.now()}`;
    const offName = `VBR Off ${Date.now()}`;
    const on = (await api.invoke("device:add", {
      name: onName,
      mountPath: "/tmp/ipr-vbr-on",
      defaultCodecConfigId: mp3 ? mp3.id : null,
      vbrEnabled: true,
    })) as { id: number };
    const off = (await api.invoke("device:add", {
      name: offName,
      mountPath: "/tmp/ipr-vbr-off",
      defaultCodecConfigId: mp3 ? mp3.id : null,
      vbrEnabled: false,
    })) as { id: number };

    const list = (await api.invoke("device:list")) as Array<{
      id: number;
      vbrEnabled?: boolean;
    }>;
    return {
      onVbr: list.find((d) => d.id === on.id)?.vbrEnabled,
      offVbr: list.find((d) => d.id === off.id)?.vbrEnabled,
    };
  });

  expect(result.onVbr).toBe(true);
  expect(result.offVbr).toBe(false);
});

test("device VBR can be toggled via update", async () => {
  const window = await readyWindow();

  const result = await window.evaluate(async () => {
    const api = (window as unknown as {
      api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    }).api;

    const added = (await api.invoke("device:add", {
      name: `VBR Toggle ${Date.now()}`,
      mountPath: "/tmp/ipr-vbr-toggle",
      vbrEnabled: false,
    })) as { id: number };

    await api.invoke("device:update", added.id, { vbrEnabled: true });

    const list = (await api.invoke("device:list")) as Array<{
      id: number;
      vbrEnabled?: boolean;
    }>;
    return list.find((d) => d.id === added.id)?.vbrEnabled;
  });

  expect(result).toBe(true);
});

test("shadow library VBR setting round-trips through IPC", async () => {
  const window = await readyWindow();

  // shadow:create validates the path exists and lives under an allowed prefix
  // (the user's home dir), so create the target there.
  const shadowDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-shadow-"));
  try {
    const result = await window.evaluate(async (dir) => {
      const api = (window as unknown as {
        api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
      }).api;

      const configs = (await api.invoke("device:getCodecConfigs")) as Array<{
        id: number;
        codec_name: string;
      }>;
      const mp3 = configs.find((c) => (c.codec_name ?? "").toUpperCase() === "MP3");

      const created = (await api.invoke("shadow:create", {
        name: `VBR Shadow ${Date.now()}`,
        path: dir,
        codecConfigId: mp3 ? mp3.id : configs[0]?.id,
        vbrEnabled: true,
      })) as { id: number; vbrEnabled?: boolean };

      const all = (await api.invoke("shadow:getAll")) as Array<{
        id: number;
        vbrEnabled?: boolean;
      }>;
      return {
        createdVbr: created?.vbrEnabled,
        persistedVbr: all.find((s) => s.id === created.id)?.vbrEnabled,
      };
    }, shadowDir);

    expect(result.createdVbr).toBe(true);
    expect(result.persistedVbr).toBe(true);
  } finally {
    fs.rmSync(shadowDir, { recursive: true, force: true });
  }
});
