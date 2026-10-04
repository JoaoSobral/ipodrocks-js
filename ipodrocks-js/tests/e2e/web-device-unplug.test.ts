/**
 * Playwright E2E — the iPod drops off USB in the middle of a remote sync.
 *
 * Reported: macOS said "Disk Not Ejected Properly", and the sync then failed
 * every remaining file — "8 / 3067 copied", a ✕ per track and then per album,
 * and a red box naming an album folder. An unmounted volume makes every File
 * System Access call throw `NotFoundError`, and the copy loop read each one
 * as that file's own failure.
 *
 * The unplug is simulated by deleting the OPFS folder the device is attached
 * to: from then on every call through the held handle throws `NotFoundError`,
 * which is what a vanished volume does. Plugging back in is a fresh folder
 * attached through `attachHandle()` — exactly what the modal's Reconnect
 * button does after the picker.
 *
 * Run with: `npm run build && npx playwright test --project=web web-device-unplug`
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { invoke, setMpcReminderDisabled, signIn } from "./web-harness";

test.describe.configure({ mode: "serial" });

const TRACK_COUNT = 8;
const TRACK_BYTES = 48 * 1024;
/** Held before each transfer, so the unplug lands between files. */
const PULL_DELAY_MS = 800;

let seedDir: string;
let deviceId: number;
let folderId: number;
let mpcReminderWas = false;

const SYNC_OPTS = {
  syncType: "full",
  extraTrackPolicy: "keep",
  includeMusic: true,
  includePodcasts: false,
  includeAudiobooks: false,
  includePlaylists: false,
};

interface Snapshot {
  active: boolean;
  state: string;
  waitKind?: string;
  processed: number;
  synced: number;
  errors: number;
  result?: { synced: number; errors: number; error?: string };
}

test.beforeAll(async ({ request }) => {
  await signIn(request);
  mpcReminderWas = await setMpcReminderDisabled(request, true);

  seedDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-unplug-"));
  const album = path.join(seedDir, "Unplug Artist", "Unplug Album");
  fs.mkdirSync(album, { recursive: true });
  for (let i = 0; i < TRACK_COUNT; i++) {
    fs.writeFileSync(
      path.join(album, `${String(i + 1).padStart(2, "0")} Cable.mp3`),
      Buffer.alloc(TRACK_BYTES + i, i + 1)
    );
  }
  folderId = await invoke<number>(request, "library:addFolder", {
    name: "UnplugLib",
    path: seedDir,
    contentType: "music",
  });
  await invoke(request, "library:scan", {
    folders: [{ name: "UnplugLib", path: seedDir, contentType: "music" }],
  });
  const device = await invoke<{ id: number; maxParallelCopies?: number | null }>(
    request,
    "device:add",
    { name: `Unplug Player ${Date.now()}`, transport: "web", modelId: null }
  );
  deviceId = device.id;
});

test.beforeEach(async ({ page, request }) => {
  await signIn(request);
  await signIn(page.request);
});

test.afterAll(async ({ request }) => {
  await signIn(request);
  await setMpcReminderDisabled(request, mpcReminderWas);
  try {
    if (deviceId) await invoke(request, "device:remove", deviceId);
    if (folderId) await invoke(request, "library:removeFolder", folderId);
  } catch {
    /* the scratch daemon is thrown away anyway */
  }
  fs.rmSync(seedDir, { recursive: true, force: true });
});

async function slowTransfers(context: BrowserContext): Promise<void> {
  await context.route("**/api/device-io/pull/**", async (route) => {
    await new Promise((r) => setTimeout(r, PULL_DELAY_MS));
    await route.continue();
  });
}

/** Creates `<folder>` in OPFS with Rockbox's folders and attaches it. */
async function plugIn(page: Page, id: number, folder: string, wipe: boolean): Promise<void> {
  await page.evaluate(
    async ({ targetId, name, wipeAll }) => {
      const root = await navigator.storage.getDirectory();
      if (wipeAll) {
        for await (const n of (root as unknown as { keys(): AsyncIterable<string> }).keys()) {
          await root.removeEntry(n, { recursive: true });
        }
      }
      const deviceRoot = await root.getDirectoryHandle(name, { create: true });
      for (const f of ["Music", "Podcasts", "Audiobooks", "Playlists"]) {
        await deviceRoot.getDirectoryHandle(f, { create: true });
      }
      await (
        window as unknown as {
          __ipodrocksDevice: {
            attachHandle(id: number, h: FileSystemDirectoryHandle): Promise<void>;
          };
        }
      ).__ipodrocksDevice.attachHandle(targetId, deviceRoot);
    },
    { targetId: id, name: folder, wipeAll: wipe }
  );
}

/** Pulls the cable: the held handle now points at nothing. */
async function unplug(page: Page, folder: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async (name: string) => {
          const root = await navigator.storage.getDirectory();
          try {
            await root.removeEntry(name, { recursive: true });
            return true;
          } catch {
            // A write was open in it; try again between files.
            return false;
          }
        }, folder),
      { timeout: 10_000, intervals: [100] }
    )
    .toBe(true);
}

async function status(page: Page): Promise<Snapshot | undefined> {
  return (await invoke<Snapshot[]>(page.request, "sync:status", deviceId))[0];
}

test("a sync that loses its device waits, then finishes once it is back", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  await slowTransfers(context);
  await page.goto("/");
  await page.waitForFunction(
    () => (window as unknown as { __ipodrocksDevice?: unknown }).__ipodrocksDevice
  );
  await plugIn(page, deviceId, `device-${deviceId}`, true);
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(
            async (targetId: number) =>
              (await (
                window as unknown as {
                  api: { invoke(c: string, ...a: unknown[]): Promise<unknown> };
                }
              ).api.invoke("device:ping", targetId)) as { online: boolean },
            deviceId
          )
        ).online,
      { timeout: 10_000 }
    )
    .toBe(true);

  await page.evaluate(
    ({ targetId, opts }) => {
      void (
        window as unknown as { api: { invoke(c: string, ...a: unknown[]): Promise<unknown> } }
      ).api.invoke("sync:start", { deviceId: targetId, ...opts });
    },
    { targetId: deviceId, opts: SYNC_OPTS }
  );

  await expect.poll(async () => (await status(page))?.synced ?? 0, { timeout: 20_000 })
    .toBeGreaterThanOrEqual(2);

  // Spotlight was told to leave the device alone before anything was copied.
  expect(
    await page.evaluate(async (name: string) => {
      const root = await navigator.storage.getDirectory();
      const dev = await root.getDirectoryHandle(name);
      try {
        await dev.getFileHandle(".metadata_never_index");
        return true;
      } catch {
        return false;
      }
    }, `device-${deviceId}`)
  ).toBe(true);

  await unplug(page, `device-${deviceId}`);

  // Waiting for the device — not failing every file left.
  await expect.poll(async () => (await status(page))?.waitKind, { timeout: 20_000 }).toBe(
    "unplugged"
  );
  const waiting = await status(page);
  expect(waiting?.state).toBe("waiting");
  expect(waiting?.errors).toBe(0);
  expect(waiting?.active).toBe(true);
  const syncedBeforeUnplug = waiting!.synced;
  expect(syncedBeforeUnplug).toBeLessThan(TRACK_COUNT);

  // The sync window says so, and offers to reconnect.
  await page.getByRole("button", { name: "Sync", exact: true }).first().click();
  const dialog = page.getByRole("dialog").filter({ hasText: "Syncing to Device" });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByTestId("sync-waiting")).toContainText("disconnected", {
    timeout: 15_000,
  });
  await expect(dialog.getByTestId("sync-reconnect-device")).toBeVisible();

  // Plug it back in: a folder at the same place, attached as Reconnect would.
  await plugIn(page, deviceId, `device-${deviceId}`, false);

  await expect.poll(async () => (await status(page))?.active, { timeout: 60_000 }).toBe(false);
  const done = await status(page);
  expect(done?.result?.error).toBeUndefined();
  expect(done?.result?.errors).toBe(0);
  // Every track arrived — the interrupted one included — and none twice.
  expect(done?.result?.synced).toBe(TRACK_COUNT);
  await expect(dialog.getByTestId("sync-waiting")).toHaveCount(0);
});
