/**
 * Playwright E2E — a remote sync that survives the network it runs over.
 *
 * Every byte of a sync to a browser-held device crosses the link between the
 * server and the tab twice, and over a Cloudflare tunnel that link drops,
 * stalls and cuts long requests (HTTP 524). Before this, any of those ended
 * the sync:
 *
 * - `sync:start` held its HTTP request open for the whole sync, so a sync
 *   longer than ~100 s "failed" in the browser while it carried on server-side;
 * - a dropped socket killed the device's attachment, and the running sync
 *   failed every remaining file against a device that had already reconnected;
 * - a reloaded tab had no way back to the sync it had started.
 *
 * Each test here makes the link misbehave on purpose — a real socket drop, a
 * real page reload, real offline mode — against the real daemon, with an OPFS
 * directory as the device (see `web-device-sync.test.ts` for why that is the
 * real File System Access path). Transfers are slowed with a route so the
 * misbehaviour lands *mid*-sync rather than after it.
 *
 * Run with: `npm run build && npx playwright test --project=web`
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  test,
  expect,
  request as playwrightRequest,
  type Page,
  type BrowserContext,
} from "@playwright/test";
import { WEB_ORIGIN, invoke, setMpcReminderDisabled, signIn } from "./web-harness";

test.describe.configure({ mode: "serial" });

let seedDir: string;
let deviceId: number;
let folderId: number;
let mpcReminderWasDisabled = false;

const GUEST_USERNAME = "e2e-sync-status-guest";
const GUEST_PASSWORD = "a-perfectly-valid-guest-password";

const TRACK_COUNT = 16;
const TRACK_BYTES = 64 * 1024;
/** Per-file delay on the data plane, so a sync lasts long enough to break. */
const PULL_DELAY_MS = 600;

test.beforeAll(async ({ request }) => {
  await signIn(request);
  mpcReminderWasDisabled = await setMpcReminderDisabled(request, true);

  seedDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-resilience-"));
  const album = path.join(seedDir, "Resilient Artist", "Resilient Album");
  fs.mkdirSync(album, { recursive: true });
  for (let i = 0; i < TRACK_COUNT; i++) {
    fs.writeFileSync(
      path.join(album, `${String(i + 1).padStart(2, "0")} Track.mp3`),
      Buffer.alloc(TRACK_BYTES + i, i + 1)
    );
  }
  folderId = await invoke<number>(request, "library:addFolder", {
    name: "ResilienceLib",
    path: seedDir,
    contentType: "music",
  });
  await invoke(request, "library:scan", {
    folders: [{ name: "ResilienceLib", path: seedDir, contentType: "music" }],
  });

  const device = await invoke<{ id: number }>(request, "device:add", {
    name: `Resilient Player ${Date.now()}`,
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
  await setMpcReminderDisabled(request, mpcReminderWasDisabled);
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

async function bootPage(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(
    () => (window as unknown as { __ipodrocksDevice?: unknown }).__ipodrocksDevice
  );
}

/** Attaches the OPFS folder for the device — wiping it first only when asked. */
async function attach(page: Page, id: number, opts: { wipe: boolean }): Promise<void> {
  await page.evaluate(
    async ({ targetId, wipe }) => {
      const root = await navigator.storage.getDirectory();
      if (wipe) {
        for await (const name of (
          root as unknown as { keys(): AsyncIterable<string> }
        ).keys()) {
          await root.removeEntry(name, { recursive: true });
        }
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
    },
    { targetId: id, wipe: opts.wipe }
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

async function musicFiles(page: Page, id: number): Promise<Record<string, number>> {
  return page.evaluate(async (targetId: number) => {
    const root = await navigator.storage.getDirectory();
    const deviceRoot = await root.getDirectoryHandle(`device-${targetId}`);
    const out: Record<string, number> = {};
    const walk = async (dir: FileSystemDirectoryHandle, prefix: string) => {
      for await (const handle of (
        dir as unknown as { values(): AsyncIterable<FileSystemHandle> }
      ).values()) {
        const rel = prefix ? `${prefix}/${handle.name}` : handle.name;
        if (handle.kind === "directory") await walk(handle as FileSystemDirectoryHandle, rel);
        else if (rel.endsWith(".mp3")) {
          out[rel] = (await (handle as FileSystemFileHandle).getFile()).size;
        }
      }
    };
    await walk(deviceRoot, "");
    return out;
  }, id);
}

const SYNC_OPTS = {
  syncType: "full",
  extraTrackPolicy: "keep",
  includeMusic: true,
  includePodcasts: false,
  includeAudiobooks: false,
  includePlaylists: false,
};

test("a sync rides out a dropped socket and finishes every file", async ({ page, context }) => {
  await slowTransfers(context);
  await bootPage(page);
  await attach(page, deviceId, { wipe: true });

  const resultRequests: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/invoke/result/")) resultRequests.push(req.url());
  });

  // Started in the page and *not* awaited there: the drop happens mid-flight.
  await page.evaluate(
    ({ targetId, opts }) => {
      const w = window as unknown as {
        api: {
          invoke(c: string, ...a: unknown[]): Promise<unknown>;
          on(c: string, cb: (p: { event: string; state?: string; bytes?: number }) => void): void;
        };
        __events: { event: string; state?: string; bytes?: number }[];
        __syncResult: Promise<unknown>;
      };
      w.__events = [];
      w.api.on("sync:progress", (p) => w.__events.push(p));
      w.__syncResult = w.api.invoke("sync:start", { deviceId: targetId, ...opts });
    },
    { targetId: deviceId, opts: SYNC_OPTS }
  );

  // Wait for the first file to land, then pull the socket out from under it.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __events: { event: string }[] }).__events.filter(
            (e) => e.event === "copy"
          ).length
      )
    )
    .toBeGreaterThan(0);
  await page.evaluate(() =>
    (window as unknown as { __ipodrocksTransport: { simulateDrop(): void } })
      .__ipodrocksTransport.simulateDrop()
  );

  const result = (await page.evaluate(
    () => (window as unknown as { __syncResult: Promise<unknown> }).__syncResult
  )) as { synced: number; errors: number };

  expect(result.errors).toBe(0);
  expect(result.synced).toBe(TRACK_COUNT);
  const files = await musicFiles(page, deviceId);
  expect(Object.keys(files)).toHaveLength(TRACK_COUNT);
  for (const size of Object.values(files)) expect(size).toBeGreaterThanOrEqual(TRACK_BYTES);

  const events = await page.evaluate(
    () => (window as unknown as { __events: { event: string; state?: string; bytes?: number }[] }).__events
  );
  // The waiting/resumed pair was pushed while the socket was down — it is
  // here only because the reconnect replayed it.
  const states = events.filter((e) => e.event === "state").map((e) => e.state);
  expect(states).toContain("waiting");
  expect(states[states.length - 1]).toBe("running");
  // Byte progress, for the MB/s readout.
  const bytes = events
    .filter((e) => e.event === "bytes")
    .reduce((sum, e) => sum + (e.bytes ?? 0), 0);
  expect(bytes).toBeGreaterThanOrEqual(TRACK_COUNT * TRACK_BYTES);
  // And the sync outlived the defer deadline, so its outcome came back through
  // the result route rather than one long-held request.
  expect(resultRequests.length).toBeGreaterThan(0);
});

test("a reloaded tab re-joins the sync it started, which still finishes", async ({
  page,
  context,
}) => {
  await slowTransfers(context);
  await bootPage(page);
  await attach(page, deviceId, { wipe: true });

  await page.evaluate(
    ({ targetId, opts }) => {
      void (
        window as unknown as { api: { invoke(c: string, ...a: unknown[]): Promise<unknown> } }
      ).api.invoke("sync:start", { deviceId: targetId, ...opts });
    },
    { targetId: deviceId, opts: SYNC_OPTS }
  );
  await expect
    .poll(async () =>
      (
        await invoke<{ processed: number }[]>(page.request, "sync:status", deviceId)
      )[0]?.processed ?? 0
    )
    .toBeGreaterThan(0);

  // The reload throws away the request, the worker and the folder handle.
  await page.reload();
  await page.waitForFunction(
    () => (window as unknown as { __ipodrocksDevice?: unknown }).__ipodrocksDevice
  );
  // Re-attach the same folder, as the Connect button would.
  await attach(page, deviceId, { wipe: false });

  await page.getByRole("button", { name: "Sync", exact: true }).first().click();
  const dialog = page.getByRole("dialog").filter({ hasText: "Syncing to Device" });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  // The transfer readout, from the snapshot plus the live frames.
  await expect(dialog.getByTestId("sync-rate")).toContainText(/(KB|MB)\/s/, {
    timeout: 15_000,
  });

  await expect
    .poll(
      async () =>
        (await invoke<{ active: boolean }[]>(page.request, "sync:status", deviceId))[0]?.active,
      { timeout: 45_000 }
    )
    .toBe(false);
  const [done] = await invoke<{ result: { synced: number; errors: number } }[]>(
    page.request,
    "sync:status",
    deviceId
  );
  expect(done.result.errors).toBe(0);
  expect(Object.keys(await musicFiles(page, deviceId))).toHaveLength(TRACK_COUNT);
  await expect(dialog.getByRole("button", { name: "Close" })).toBeVisible({ timeout: 10_000 });
});

test("another account cannot read a sync's status", async ({ page }) => {
  // Control first: the owner sees the sync from the previous test, log and all.
  const own = await invoke<{ deviceId: number; log: string[] }[]>(
    page.request,
    "sync:status",
    deviceId
  );
  expect(own).toHaveLength(1);
  expect(own[0].log.length).toBeGreaterThan(0);

  // A sync's log names library files; a guest has no business reading it.
  await invoke(page.request, "server:allowIdentity", {
    provider: "local",
    subject: GUEST_USERNAME,
    displayName: "E2E Sync Status Guest",
    password: GUEST_PASSWORD,
  });
  const guest = await playwrightRequest.newContext({ baseURL: WEB_ORIGIN });
  try {
    const login = await guest.post("/api/auth/local/login", {
      data: { username: GUEST_USERNAME, password: GUEST_PASSWORD },
    });
    expect(login.ok()).toBe(true);
    expect(await invoke<unknown[]>(guest, "sync:status", deviceId)).toEqual([]);
    expect(await invoke<unknown[]>(guest, "sync:status")).toEqual([]);
  } finally {
    await guest.dispose();
    const res = await invoke<{ identities?: { id: number; subject: string }[] }>(
      page.request,
      "server:listIdentities"
    );
    const id = res.identities?.find((i) => i.subject === GUEST_USERNAME)?.id;
    if (id) await invoke(page.request, "server:revokeIdentity", id);
  }
});

test("a retried request with the same id runs once", async ({ request }) => {
  const name = `Retried Device ${Date.now()}`;
  const id = `retry-${Date.now()}-abcdef`;
  for (let i = 0; i < 2; i++) {
    const res = await request.post("/api/invoke/device:add", {
      headers: { "X-Request-Id": id },
      data: { args: [{ name, transport: "web" }] },
    });
    expect(res.ok()).toBe(true);
  }
  const devices = await invoke<{ id: number; name: string }[]>(request, "device:list");
  const created = devices.filter((d) => d.name === name);
  try {
    expect(created).toHaveLength(1);
  } finally {
    for (const d of created) await invoke(request, "device:remove", d.id);
  }
});
