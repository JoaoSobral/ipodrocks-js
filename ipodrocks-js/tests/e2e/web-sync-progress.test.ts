/**
 * Playwright E2E — the sync modal shows a remote sync moving.
 *
 * Reported: a remote sync sat at "0 / 2921 copied, 0%" with "Preparing files
 * for sync…" while 110 MB went across at 4.2 MB/s. Nothing was wrong with
 * the copy. Four workers share the link, so with large files nothing
 * *finishes* for a minute, and the modal showed only finished files and a
 * count-based percentage. Every phase line the sync sent ("Comparing library
 * with device…", "Found N to sync…") went into a list that was never rendered.
 *
 * Transfers are slowed with a route, as in `web-sync-resilience.test.ts`, so
 * the window before the first file lands is long enough to look at.
 *
 * Run with: `npm run build && npx playwright test --project=web web-sync-progress`
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { invoke, setMpcReminderDisabled, signIn } from "./web-harness";

test.describe.configure({ mode: "serial" });

const TRACK_COUNT = 8;
const TRACK_BYTES = 96 * 1024;
/** Held before each transfer starts, so files sit "in progress". */
const PULL_DELAY_MS = 1500;

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

test.beforeAll(async ({ request }) => {
  await signIn(request);
  mpcReminderWas = await setMpcReminderDisabled(request, true);

  seedDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-syncprogress-"));
  const album = path.join(seedDir, "Progress Artist", "Progress Album");
  fs.mkdirSync(album, { recursive: true });
  for (let i = 0; i < TRACK_COUNT; i++) {
    fs.writeFileSync(
      path.join(album, `${String(i + 1).padStart(2, "0")} Slow Song.mp3`),
      Buffer.alloc(TRACK_BYTES + i, i + 1)
    );
  }
  folderId = await invoke<number>(request, "library:addFolder", {
    name: "SyncProgressLib",
    path: seedDir,
    contentType: "music",
  });
  await invoke(request, "library:scan", {
    folders: [{ name: "SyncProgressLib", path: seedDir, contentType: "music" }],
  });
  const device = await invoke<{ id: number }>(request, "device:add", {
    name: `Progress Player ${Date.now()}`,
    transport: "web",
    modelId: null,
  });
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

async function attachFreshDevice(page: Page, id: number): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(
    () => (window as unknown as { __ipodrocksDevice?: unknown }).__ipodrocksDevice
  );
  await page.evaluate(async (targetId: number) => {
    const root = await navigator.storage.getDirectory();
    for await (const name of (
      root as unknown as { keys(): AsyncIterable<string> }
    ).keys()) {
      await root.removeEntry(name, { recursive: true });
    }
    const deviceRoot = await root.getDirectoryHandle(`device-${targetId}`, { create: true });
    for (const folder of ["Music", "Podcasts", "Audiobooks", "Playlists"]) {
      await deviceRoot.getDirectoryHandle(folder, { create: true });
    }
    await (
      window as unknown as {
        __ipodrocksDevice: {
          attachHandle(id: number, h: FileSystemDirectoryHandle): Promise<void>;
        };
      }
    ).__ipodrocksDevice.attachHandle(targetId, deviceRoot);
  }, id);
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
            id
          )
        ).online,
      { timeout: 10_000 }
    )
    .toBe(true);
}

test("a slow remote sync shows what it is doing before any file lands", async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  await slowTransfers(context);
  await attachFreshDevice(page, deviceId);

  // Started from the page so the device RPC rides its socket; the Sync panel
  // then joins it, which is the same modal a reload or a second tab gets.
  await page.evaluate(
    ({ targetId, opts }) => {
      void (
        window as unknown as { api: { invoke(c: string, ...a: unknown[]): Promise<unknown> } }
      ).api.invoke("sync:start", { deviceId: targetId, ...opts });
    },
    { targetId: deviceId, opts: SYNC_OPTS }
  );
  await page.getByRole("button", { name: "Sync", exact: true }).first().click();
  const dialog = page.getByRole("dialog").filter({ hasText: "Syncing to Device" });
  await expect(dialog).toBeVisible({ timeout: 15_000 });

  // Files are named while they are still on their way.
  await expect(dialog.getByTestId("sync-inflight-file").first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(dialog.getByTestId("sync-inflight")).toContainText("Slow Song.mp3");

  // ...and the sync's own phase lines are in the Progress box, not only in
  // "Copy log".
  const logLines = dialog.getByTestId("sync-feed-log");
  await expect(logLines.filter({ hasText: /Comparing library with device/ }).first()).toBeVisible();
  await expect(logLines.filter({ hasText: /Copying \d+ track\(s\) to device/ }).first()).toBeVisible();

  // Once it is done nothing is left "in progress".
  await expect
    .poll(
      async () =>
        (await invoke<{ active: boolean }[]>(page.request, "sync:status", deviceId))[0]?.active,
      { timeout: 60_000 }
    )
    .toBe(false);
  await expect(dialog.getByTestId("sync-inflight")).toHaveCount(0, { timeout: 15_000 });
  const [done] = await invoke<{ result: { synced: number; errors: number } }[]>(
    page.request,
    "sync:status",
    deviceId
  );
  expect(done.result.errors).toBe(0);
  expect(done.result.synced).toBe(TRACK_COUNT);
});

test("the sync status a re-joining tab reads carries the byte total and the files in flight", async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  await slowTransfers(context);
  await attachFreshDevice(page, deviceId);

  await page.evaluate(
    ({ targetId, opts }) => {
      void (
        window as unknown as { api: { invoke(c: string, ...a: unknown[]): Promise<unknown> } }
      ).api.invoke("sync:start", { deviceId: targetId, ...opts });
    },
    { targetId: deviceId, opts: SYNC_OPTS }
  );

  // Mid-copy, the snapshot names what is moving and how much there is to move.
  await expect
    .poll(
      async () => {
        const [snap] = await invoke<
          { totalBytes: number; inflight: { path: string }[] }[]
        >(page.request, "sync:status", deviceId);
        return snap ? snap.inflight.length > 0 && snap.totalBytes > 0 : false;
      },
      { timeout: 20_000 }
    )
    .toBe(true);
  const [mid] = await invoke<{ totalBytes: number }[]>(page.request, "sync:status", deviceId);
  // Direct copy: exactly the library's bytes.
  const expected = Array.from({ length: TRACK_COUNT }, (_, i) => TRACK_BYTES + i).reduce(
    (a, b) => a + b,
    0
  );
  expect(mid.totalBytes).toBe(expected);

  await expect
    .poll(
      async () =>
        (await invoke<{ active: boolean }[]>(page.request, "sync:status", deviceId))[0]?.active,
      { timeout: 60_000 }
    )
    .toBe(false);
});
