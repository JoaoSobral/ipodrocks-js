/**
 * Playwright E2E — a hybrid device, from the browser.
 *
 * A player plugged into the server (local, with a USB identity) is opened to
 * this browser by the server's owner from its card. From then on a browser
 * sync goes to the folder *this browser* holds — an OPFS folder here, a real
 * `FileSystemDirectoryHandle` — and never to the server's mount, which must
 * stay untouched. A guest is refused at every way in.
 *
 * The desktop side (adding a local side to a remote device, syncing through
 * the mount) is `hybrid-device.test.ts`.
 *
 * Run: `npm run build && npx playwright test --project=web web-hybrid-device`
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Database from "better-sqlite3";
import { test, expect, request as playwrightRequest, type Page } from "@playwright/test";
import {
  WEB_DATA_DIR,
  WEB_ORIGIN,
  invoke,
  removeDeviceRow,
  seedLocalDeviceRow,
  signIn,
  setMpcReminderDisabled,
} from "./web-harness";

test.describe.configure({ mode: "serial" });

const GUEST_USERNAME = "e2e-hybrid-guest";
const GUEST_PASSWORD = "a-perfectly-fine-hybrid-password";
const DEVICE_NAME = `Web Hybrid ${Date.now()}`;

let seedDir: string;
let serverMount: string;
let deviceId: number;
let folderId: number;
let mpcBefore: boolean | undefined;

interface PageApi {
  api: { invoke(c: string, ...a: unknown[]): Promise<unknown> };
  __ipodrocksDevice: { attachHandle(id: number, h: FileSystemDirectoryHandle): Promise<void> };
}

interface Identity {
  id: number;
  subject: string;
}

async function removeGuest(owner: import("@playwright/test").APIRequestContext): Promise<void> {
  const res = await invoke<{ identities?: Identity[] }>(owner, "server:listIdentities");
  const found = (res.identities ?? []).find((i) => i.subject === GUEST_USERNAME);
  if (found) await invoke(owner, "server:revokeIdentity", found.id);
}

test.beforeAll(async ({ request }) => {
  await signIn(request);
  mpcBefore = await setMpcReminderDisabled(request, true);
  seedDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-webhybrid-"));
  const album = path.join(seedDir, "Hybrid Artist", "Hybrid Album");
  fs.mkdirSync(album, { recursive: true });
  fs.writeFileSync(path.join(album, "01 One.mp3"), Buffer.alloc(3000, 1));
  folderId = await invoke<number>(request, "library:addFolder", {
    name: "WebHybridLib",
    path: seedDir,
    contentType: "music",
  });
  await invoke(request, "library:scan", {
    folders: [{ name: "WebHybridLib", path: seedDir, contentType: "music" }],
  });

  // The player as the server sees it: a mount on its own disk, with a USB
  // identity. Seeded directly — a browser can only ever add remote devices.
  serverMount = path.join(seedDir, "server-mount");
  fs.mkdirSync(serverMount);
  deviceId = seedLocalDeviceRow(DEVICE_NAME, serverMount);
  const db = new Database(path.join(WEB_DATA_DIR, "ipodrock.db"));
  try {
    db.prepare(
      "UPDATE devices SET usb_vendor_id = '05ac', usb_product_id = '1261', usb_serial = 'WEBHYB', dev_mode = 1 WHERE id = ?"
    ).run(deviceId);
  } finally {
    db.close();
  }

  await removeGuest(request);
  await invoke(request, "server:allowIdentity", {
    provider: "local",
    subject: GUEST_USERNAME,
    displayName: "E2E Hybrid Guest",
    password: GUEST_PASSWORD,
  });
});

test.afterAll(async () => {
  const owner = await playwrightRequest.newContext({ baseURL: WEB_ORIGIN });
  await signIn(owner);
  try {
    await removeGuest(owner);
    if (folderId) await invoke(owner, "library:removeFolder", folderId);
    if (mpcBefore !== undefined) await setMpcReminderDisabled(owner, mpcBefore);
  } finally {
    await owner.dispose();
  }
  if (deviceId) removeDeviceRow(deviceId);
  fs.rmSync(seedDir, { recursive: true, force: true });
});

async function openDevices(page: Page): Promise<void> {
  await signIn(page.request);
  await page.goto("/");
  await page.getByRole("button", { name: "Devices" }).first().click();
}

function card(page: Page) {
  return page
    .locator("div", { has: page.getByRole("heading", { name: DEVICE_NAME, exact: true }) })
    .filter({ has: page.getByTestId("device-connections") })
    .last();
}

test("a guest cannot open the server's player to a browser", async () => {
  const guest = await playwrightRequest.newContext({ baseURL: WEB_ORIGIN });
  try {
    const login = await guest.post("/api/auth/local/login", {
      data: { username: GUEST_USERNAME, password: GUEST_PASSWORD },
    });
    expect(login.ok()).toBe(true);
    const res = await invoke<{ error?: string }>(guest, "device:setConnections", deviceId, { remote: true });
    expect(res.error).toMatch(/owner/i);
  } finally {
    await guest.dispose();
  }
});

test("the owner opens it to this browser and syncs into the browser's folder", async ({ page }) => {
  await openDevices(page);
  const c = card(page);
  // Server-attached: nothing to sync from here yet.
  await expect(c.getByRole("button", { name: "Check Device" })).toBeDisabled();
  await c.getByTestId("device-allow-browser").click();
  await expect(card(page).getByTestId("device-hybrid-badge")).toBeVisible();

  // Connect a folder for it — the "Connect folder" control, minus the picker.
  await page.evaluate(async (id: number) => {
    const root = await navigator.storage.getDirectory();
    for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) {
      await root.removeEntry(name, { recursive: true });
    }
    const dev = await root.getDirectoryHandle(`device-${id}`, { create: true });
    for (const f of ["Music", "Podcasts", "Audiobooks", "Playlists"]) {
      await dev.getDirectoryHandle(f, { create: true });
    }
    await (window as unknown as PageApi).__ipodrocksDevice.attachHandle(id, dev);
  }, deviceId);
  await expect
    .poll(
      async () =>
        (
          (await page.evaluate(
            (id: number) => (window as unknown as PageApi).api.invoke("device:ping", id),
            deviceId
          )) as { online: boolean }
        ).online,
      { timeout: 10_000 }
    )
    .toBe(true);

  const result = (await page.evaluate(
    (id: number) =>
      (window as unknown as PageApi).api.invoke("sync:start", {
        deviceId: id,
        syncType: "full",
        extraTrackPolicy: "keep",
        includeMusic: true,
        includePodcasts: false,
        includeAudiobooks: false,
        includePlaylists: false,
      }),
    deviceId
  )) as { errors: number; synced: number; error?: string };
  expect(result.error).toBeUndefined();
  expect(result.synced).toBe(1);

  const inBrowser = await page.evaluate(async (id: number) => {
    const root = await navigator.storage.getDirectory();
    const dev = await root.getDirectoryHandle(`device-${id}`);
    const files: string[] = [];
    const walk = async (dir: FileSystemDirectoryHandle, prefix: string) => {
      for await (const h of (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
        if (h.kind === "directory") await walk(h as FileSystemDirectoryHandle, `${prefix}/${h.name}`);
        else files.push(`${prefix}/${h.name}`);
      }
    };
    await walk(await dev.getDirectoryHandle("Music"), "Music");
    return files;
  }, deviceId);
  expect(inBrowser.some((f) => f.endsWith("01 One.mp3"))).toBe(true);
  // The server's own mount was never touched by the browser's sync.
  expect(fs.readdirSync(serverMount)).toEqual([]);
});

test("the guest cannot use the owner's browser side either", async () => {
  const guest = await playwrightRequest.newContext({ baseURL: WEB_ORIGIN });
  try {
    await guest.post("/api/auth/local/login", { data: { username: GUEST_USERNAME, password: GUEST_PASSWORD } });
    const res = await invoke<{ error?: string }>(guest, "sync:start", {
      deviceId,
      syncType: "full",
      extraTrackPolicy: "keep",
      includeMusic: true,
    });
    expect(res.error).toMatch(/different account|owner/i);
  } finally {
    await guest.dispose();
  }
});
