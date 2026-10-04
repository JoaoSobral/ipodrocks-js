/**
 * Playwright E2E — a remote device's storage figures.
 *
 * A browser cannot read a disk's size. The old answer was
 * `navigator.storage.estimate()`, the browser's own origin quota, which made a
 * remote iPod read "0.0 GB / 10.0 GB" (and red, since free was 0). Now used
 * space is measured from the device's own files, and the total is the
 * capacity entered in the device profile.
 *
 * The device is an OPFS directory, as in `web-device-sync.test.ts`: a real
 * `FileSystemDirectoryHandle`, so the measuring walk runs for real.
 *
 * Run with: `npm run build && npx playwright test --project=web web-device-capacity`
 */
import { test, expect, type Page } from "@playwright/test";
import { invoke, setMpcReminderDisabled, signIn } from "./web-harness";

test.describe.configure({ mode: "serial" });

const GIB = 1024 ** 3;
/** Files seeded on the device, anywhere under its root — not only in Music. */
const SEED: Array<[string, number]> = [
  ["Music/A/B/01 One.mp3", 300_000],
  ["Music/A/B/02 Two.mp3", 200_000],
  [".rockbox/config.cfg", 4_096],
];
const SEEDED_BYTES = SEED.reduce((n, [, size]) => n + size, 0);

let deviceId: number;
let mpcReminderWas: boolean;

interface Disk {
  totalBytes: number;
  freeBytes: number;
  usedBytes?: number;
  source?: string;
}

test.beforeAll(async ({ request }) => {
  await signIn(request);
  mpcReminderWas = await setMpcReminderDisabled(request, true);
  const device = await invoke<{ id: number }>(request, "device:add", {
    name: `E2E Capacity Player ${Date.now()}`,
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
  try {
    if (deviceId) await invoke(request, "device:remove", deviceId);
    await setMpcReminderDisabled(request, mpcReminderWas);
  } catch {
    /* the scratch daemon is thrown away anyway */
  }
});

async function attachSeededDevice(page: Page, id: number): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(
    () => (window as unknown as { __ipodrocksDevice?: unknown }).__ipodrocksDevice
  );
  await page.evaluate(
    async ({ targetId, seed }) => {
      const root = await navigator.storage.getDirectory();
      for await (const name of (
        root as unknown as { keys(): AsyncIterable<string> }
      ).keys()) {
        await root.removeEntry(name, { recursive: true });
      }
      const deviceRoot = await root.getDirectoryHandle(`device-${targetId}`, { create: true });
      for (const [rel, size] of seed) {
        const parts = rel.split("/");
        const fileName = parts.pop()!;
        let dir = deviceRoot;
        for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: true });
        const w = await (await dir.getFileHandle(fileName, { create: true })).createWritable();
        await w.write(new Uint8Array(size));
        await w.close();
      }
      await (
        window as unknown as {
          __ipodrocksDevice: {
            attachHandle(id: number, h: FileSystemDirectoryHandle): Promise<void>;
          };
        }
      ).__ipodrocksDevice.attachHandle(targetId, deviceRoot);
    },
    { targetId: id, seed: SEED }
  );
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

async function checkDisk(page: Page, id: number): Promise<Disk> {
  const result = await page.evaluate(
    async (targetId: number) =>
      (await (
        window as unknown as {
          api: { invoke(c: string, ...a: unknown[]): Promise<unknown> };
        }
      ).api.invoke("device:check", targetId)) as { disk: Disk },
    id
  );
  return result.disk;
}

test("without a capacity, used space is measured and nothing else is claimed", async ({
  page,
}) => {
  await attachSeededDevice(page, deviceId);
  const disk = await checkDisk(page, deviceId);
  // Every file on the device, not just the content folders.
  expect(disk.usedBytes).toBe(SEEDED_BYTES);
  expect(disk.source).toBe("used-only");
  // The origin quota used to land here.
  expect(disk.totalBytes).toBe(0);
  expect(disk.freeBytes).toBe(0);
});

test("the card shows used space and says how to get the rest", async ({ page }) => {
  await attachSeededDevice(page, deviceId);
  // In-app navigation: a reload would drop the attachment this test just made.
  await page.getByRole("button", { name: "Devices" }).first().click();
  const card = page
    .getByRole("heading", { name: /E2E Capacity Player/ })
    .locator('xpath=ancestor::*[.//button[normalize-space()="Edit"]][1]');
  await card.getByRole("button", { name: "Check Device" }).click();
  const storage = card.getByTestId("device-storage");
  await expect(storage).toContainText("used", { timeout: 15_000 });
  await expect(storage).toContainText("Add its capacity in the device profile");
  await expect(storage).not.toContainText("10.0 GB");
});

test("with a capacity, the total is that number in the app's GB", async ({
  page,
  request,
}) => {
  const updated = await invoke<unknown>(request, "device:update", deviceId, {
    capacityGb: 1.2345,
  });
  expect((updated as { error?: string } | null)?.error).toBeUndefined();

  await attachSeededDevice(page, deviceId);
  const disk = await checkDisk(page, deviceId);
  expect(disk.source).toBe("estimated");
  expect(disk.totalBytes).toBe(Math.round(1.2345 * GIB));
  expect(disk.usedBytes).toBe(SEEDED_BYTES);
  expect(disk.freeBytes).toBe(Math.round(1.2345 * GIB) - SEEDED_BYTES);
});

test("the server refuses a capacity that is not a size, and clears on null", async ({
  request,
}) => {
  const bad = await invoke<{ error?: string }>(request, "device:update", deviceId, {
    capacityGb: -3,
  });
  expect(bad?.error).toMatch(/positive number of GB/);

  await invoke(request, "device:update", deviceId, { capacityGb: null });
  const list = await invoke<Array<{ id: number; capacityGb?: number | null }>>(
    request,
    "device:list"
  );
  expect(list.find((d) => d.id === deviceId)?.capacityGb ?? null).toBeNull();
});
