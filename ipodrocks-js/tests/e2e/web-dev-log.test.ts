/**
 * Playwright E2E — the developer log, read from a remote client.
 *
 * `IPODROCKS_DEV_LOGS=1` (set for the whole `web` project in
 * `playwright.config.ts`) makes a device check and a sync explain themselves:
 * what was on the device, and why each track counts as synced or to-sync. The
 * point of serving it to the browser is that the person holding the iPod is
 * often not the person with a shell on the server.
 *
 * It is owner-only: the ring holds every device's diagnostics and the
 * server's own paths. The load-bearing guest assertion is that `read` is
 * refused, not merely that the console is hidden.
 *
 * Run with: `npm run build && npx playwright test --project=web web-dev-log`
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  test,
  expect,
  request as playwrightRequest,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { WEB_ORIGIN, invoke, setMpcReminderDisabled, signIn } from "./web-harness";

test.describe.configure({ mode: "serial" });

const GUEST_USERNAME = "e2e-devlog-guest";
const GUEST_PASSWORD = "a-perfectly-fine-devlog-password";
const TRACK = path.join("DevLog Artist", "DevLog Album", "01 Logged.mp3");

let seedDir: string;
let folderId: number;
let deviceId: number;
let guest: APIRequestContext;
let mpcReminderWas: boolean;

interface DevLogPage {
  enabled: boolean;
  entries: Array<{ seq: number; scope: string; message: string }>;
  lastSeq: number;
}

async function removeGuest(owner: APIRequestContext): Promise<void> {
  const res = await invoke<{ identities?: Array<{ id: number; subject: string }> }>(
    owner,
    "server:listIdentities"
  );
  const found = (res.identities ?? []).find((i) => i.subject === GUEST_USERNAME);
  if (found) await invoke(owner, "server:revokeIdentity", found.id);
}

test.beforeAll(async ({ request }) => {
  await signIn(request);
  mpcReminderWas = await setMpcReminderDisabled(request, true);

  seedDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-devlog-"));
  fs.mkdirSync(path.dirname(path.join(seedDir, TRACK)), { recursive: true });
  fs.writeFileSync(path.join(seedDir, TRACK), Buffer.alloc(4096, 7));
  folderId = await invoke<number>(request, "library:addFolder", {
    name: "DevLogLib",
    path: seedDir,
    contentType: "music",
  });
  await invoke(request, "library:scan", {
    folders: [{ name: "DevLogLib", path: seedDir, contentType: "music" }],
  });

  const device = await invoke<{ id: number }>(request, "device:add", {
    name: `DevLog Player ${Date.now()}`,
    transport: "web",
    modelId: null,
  });
  deviceId = device.id;

  await removeGuest(request);
  await invoke(request, "server:allowIdentity", {
    provider: "local",
    subject: GUEST_USERNAME,
    displayName: "E2E DevLog Guest",
    password: GUEST_PASSWORD,
  });
  guest = await playwrightRequest.newContext({ baseURL: WEB_ORIGIN });
  const login = await guest.post("/api/auth/local/login", {
    data: { username: GUEST_USERNAME, password: GUEST_PASSWORD },
  });
  expect(login.ok()).toBe(true);
});

test.beforeEach(async ({ page, request }) => {
  await signIn(request);
  await signIn(page.request);
});

test.afterAll(async ({ request }) => {
  await guest?.dispose();
  await signIn(request);
  try {
    await removeGuest(request);
    if (deviceId) await invoke(request, "device:remove", deviceId);
    if (folderId) await invoke(request, "library:removeFolder", folderId);
    await setMpcReminderDisabled(request, mpcReminderWas);
  } catch {
    /* the scratch daemon is thrown away anyway */
  }
  fs.rmSync(seedDir, { recursive: true, force: true });
});

async function attachOpfsDevice(page: Page, id: number): Promise<void> {
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

test("a device check explains itself in the owner's developer log", async ({
  page,
  request,
}) => {
  expect(await invoke<{ enabled: boolean }>(request, "app:devLog:status")).toEqual({
    enabled: true,
  });
  const before = await invoke<DevLogPage>(request, "app:devLog:read", 0);
  const since = before.lastSeq;

  await attachOpfsDevice(page, deviceId);
  await page.evaluate(
    async (id: number) =>
      (
        window as unknown as {
          api: { invoke(c: string, ...a: unknown[]): Promise<unknown> };
        }
      ).api.invoke("device:check", id),
    deviceId
  );

  const after = await invoke<DevLogPage>(request, "app:devLog:read", since);
  const lines = after.entries.map((e) => `[${e.scope}] ${e.message}`);
  // The device line, the music summary, and the reason the one track is
  // still to sync — the three things a count on its own cannot say.
  expect(lines.some((l) => l.startsWith("[check]") && l.includes(`device ${deviceId}`))).toBe(true);
  expect(lines.some((l) => l.startsWith("[check:music]") && l.includes("to sync"))).toBe(true);
  expect(
    lines.some(
      (l) => l.startsWith("[check:music]") && l.includes("not on device") && l.includes("01 Logged.mp3")
    )
  ).toBe(true);
});

test("the owner sees the console in the app", async ({ page }) => {
  await page.goto("/");
  const toggle = page.getByTestId("dev-console-toggle");
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  await toggle.click();
  const panel = page.getByTestId("dev-console");
  await expect(panel).toBeVisible();
  // The check in the previous test is already in the ring.
  await expect(panel.getByTestId("dev-console-line").filter({ hasText: "[check:music]" }).first())
    .toBeVisible({ timeout: 10_000 });
});

test("a guest is told the log is off and refused if it asks anyway", async ({ request }) => {
  // Control: the owner still reads it, so the refusal below is the gate.
  expect((await invoke<DevLogPage>(request, "app:devLog:read", 0)).enabled).toBe(true);

  expect(await invoke<{ enabled: boolean }>(guest, "app:devLog:status")).toEqual({
    enabled: false,
  });
  const read = await invoke<{ error?: string; entries?: unknown }>(guest, "app:devLog:read", 0);
  expect(read.error).toMatch(/owner/);
  expect(read.entries).toBeUndefined();
  const clear = await invoke<{ error?: string }>(guest, "app:devLog:clear");
  expect(clear.error).toMatch(/owner/);
  // And the clear did not happen.
  expect((await invoke<DevLogPage>(request, "app:devLog:read", 0)).entries.length).toBeGreaterThan(0);
});
