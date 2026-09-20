/**
 * Playwright E2E — a full sync to a device held in the browser.
 *
 * This is the spec the whole project exists for: the library, the database and
 * the encoders are on the server, the player is a folder in the browser, and
 * every byte crosses between them.
 *
 * **How the picker problem is solved.** `showDirectoryPicker()` is a
 * user-gesture-gated native dialog Playwright cannot drive. But
 * `navigator.storage.getDirectory()` returns a real
 * `FileSystemDirectoryHandle` with the identical interface — so the page seeds
 * an OPFS tree and hands that handle to the same `attachHandle()` the picker
 * flow calls. Every line of the File System Access path runs for real; only
 * the dialog itself is left to manual verification, the way the `mpcenc` skip
 * already is.
 *
 * The second sync is the most important assertion in the file. A web device
 * cannot have its mtimes set — the API has no way to — and the browser's clock
 * is not the server's. If either the size-first comparison or the clock-skew
 * correction is wrong, the second sync copies the entire library again, for
 * ever, and says nothing about why.
 *
 * Run with: `npm run build && npx playwright test --project=web`
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { test, expect, type Page } from "@playwright/test";
import { invoke, signIn } from "./web-harness";

let seedDir: string;
let deviceId: number;
let folderId: number;

const ALBUM = path.join("Web Artist", "Web Album");
const TRACKS = ["01 First.mp3", "02 Second.mp3", "03 Third.mp3"];

test.beforeAll(async ({ request }) => {
  await signIn(request);

  seedDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-webdev-"));
  const album = path.join(seedDir, ALBUM);
  fs.mkdirSync(album, { recursive: true });
  TRACKS.forEach((name, i) => {
    // Distinct lengths so a mixed-up destination shows as a size mismatch
    // rather than passing by accident.
    fs.writeFileSync(path.join(album, name), Buffer.alloc(2048 + i * 64, i + 1));
  });

  folderId = await invoke<number>(request, "library:addFolder", {
    name: "WebDeviceLib",
    path: seedDir,
    contentType: "music",
  });
  await invoke(request, "library:scan", {
    folders: [{ name: "WebDeviceLib", path: seedDir, contentType: "music" }],
  });

  const device = await invoke<{ id: number; mountPath: string; transport: string }>(
    request,
    "device:add",
    {
      name: `Web Player ${Date.now()}`,
      transport: "web",
      // Direct copy: the point of this spec is the transport, not the encoder.
      modelId: null,
    }
  );
  deviceId = device.id;

  // The synthetic root is minted by `addDevice` and is host-flavoured, so the
  // six containment guards in the sync keep doing plain `path` arithmetic.
  expect(device.transport).toBe("web");
  expect(device.mountPath).toContain("ipodrocks-web");
});

test.beforeEach(async ({ page, request }) => {
  // `page.request` and the standalone `request` fixture have separate cookie
  // jars. Without this the page renders the login screen, the bootstrap never
  // builds the device client, and every failure below is "undefined is not an
  // object" a long way from its cause.
  await signIn(request);
  await signIn(page.request);
});

test.afterAll(async ({ request }) => {
  try {
    if (deviceId) await invoke(request, "device:remove", deviceId);
    if (folderId) await invoke(request, "library:removeFolder", folderId);
  } catch {
    /* the scratch daemon is thrown away anyway */
  }
  try {
    fs.rmSync(seedDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/**
 * Opens the app, wipes OPFS, and attaches a fresh OPFS directory as the device.
 *
 * The wipe matters: the `web` project runs several specs against one daemon and
 * one origin, so OPFS carries over between them.
 */
async function attachOpfsDevice(page: Page, id: number): Promise<void> {
  await page.goto("/");
  // Wait for the bootstrap, not just for markup: the login screen is markup
  // too, and it has no device client.
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
    const deviceRoot = await root.getDirectoryHandle(`device-${targetId}`, {
      create: true,
    });
    // Rockbox's own folders, as a real player would have them.
    for (const folder of ["Music", "Podcasts", "Audiobooks", "Playlists"]) {
      await deviceRoot.getDirectoryHandle(folder, { create: true });
    }
    const client = (
      window as unknown as {
        __ipodrocksDevice: {
          attachHandle(id: number, h: FileSystemDirectoryHandle): Promise<void>;
        };
      }
    ).__ipodrocksDevice;
    await client.attachHandle(targetId, deviceRoot);
  }, id);

  // The attach is announced over the socket; the server registers the transport
  // when it arrives. Poll rather than sleep so a slow CI box does not flake.
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

/** Every file under the attached OPFS device, as `relative/path -> size`. */
async function deviceContents(page: Page, id: number): Promise<Record<string, number>> {
  return page.evaluate(async (targetId: number) => {
    const root = await navigator.storage.getDirectory();
    const deviceRoot = await root.getDirectoryHandle(`device-${targetId}`);
    const out: Record<string, number> = {};
    const walk = async (dir: FileSystemDirectoryHandle, prefix: string) => {
      for await (const handle of (
        dir as unknown as { values(): AsyncIterable<FileSystemHandle> }
      ).values()) {
        const rel = prefix ? `${prefix}/${handle.name}` : handle.name;
        if (handle.kind === "directory") {
          await walk(handle as FileSystemDirectoryHandle, rel);
        } else {
          out[rel] = (await (handle as FileSystemFileHandle).getFile()).size;
        }
      }
    };
    await walk(deviceRoot, "");
    return out;
  }, id);
}

/** Runs a sync through the page, so the device RPC rides the page's socket. */
async function runSync(
  page: Page,
  id: number,
  overrides: Record<string, unknown> = {}
): Promise<{ status: string; synced: number; removed: number; errors: number }> {
  return page.evaluate(
    async (payload) => {
      return (await (
        window as unknown as {
          api: { invoke(c: string, ...a: unknown[]): Promise<unknown> };
        }
      ).api.invoke("sync:start", payload)) as {
        status: string;
        synced: number;
        removed: number;
        errors: number;
      };
    },
    {
      deviceId: id,
      syncType: "full",
      extraTrackPolicy: "keep",
      includeMusic: true,
      includePodcasts: false,
      includeAudiobooks: false,
      includePlaylists: false,
      ...overrides,
    }
  );
}

test("a library on the server syncs onto a folder held in the browser", async ({
  page,
}) => {
  await attachOpfsDevice(page, deviceId);

  const result = await runSync(page, deviceId);
  expect(result.errors).toBe(0);
  expect(result.synced).toBe(TRACKS.length);

  const contents = await deviceContents(page, deviceId);
  const music = Object.keys(contents).filter((p) => p.startsWith("Music/"));
  expect(music).toHaveLength(TRACKS.length);

  // Bytes, not just names: a data-plane transfer that truncated would still
  // produce three files with the right names.
  for (const [i, name] of TRACKS.entries()) {
    const entry = music.find((p) => p.endsWith(name));
    expect(entry, `${name} should be on the device`).toBeTruthy();
    expect(contents[entry!]).toBe(2048 + i * 64);
  }
});

test("a second sync copies nothing, although the device has no mtimes", async ({
  page,
}) => {
  await attachOpfsDevice(page, deviceId);

  const first = await runSync(page, deviceId);
  expect(first.synced).toBe(TRACKS.length);

  const second = await runSync(page, deviceId);
  // The whole clock-skew and size-first comparison, in one number. If this is
  // 3 the sync never converges and a remote user re-uploads their library on
  // every run with nothing saying why.
  expect(second.synced).toBe(0);
  expect(second.errors).toBe(0);
});

test("orphans on the device are swept when the policy says so", async ({ page }) => {
  await attachOpfsDevice(page, deviceId);
  await runSync(page, deviceId);

  // A track the library does not have, in the layout the sync uses.
  await page.evaluate(async (targetId: number) => {
    const root = await navigator.storage.getDirectory();
    const deviceRoot = await root.getDirectoryHandle(`device-${targetId}`);
    const music = await deviceRoot.getDirectoryHandle("Music");
    const artist = await music.getDirectoryHandle("Stale Artist", { create: true });
    const album = await artist.getDirectoryHandle("Stale Album", { create: true });
    const file = await album.getFileHandle("99 Gone.mp3", { create: true });
    const writable = await file.createWritable();
    await writable.write(new Uint8Array(128));
    await writable.close();
  }, deviceId);

  const swept = await runSync(page, deviceId, { extraTrackPolicy: "remove" });
  expect(swept.removed).toBeGreaterThanOrEqual(1);

  const contents = await deviceContents(page, deviceId);
  expect(Object.keys(contents).some((p) => p.includes("99 Gone.mp3"))).toBe(false);
  // And the emptied folders went with it, which is `cleanEmptyDirectoriesOn`.
  expect(Object.keys(contents).some((p) => p.includes("Stale Artist"))).toBe(false);
});

test("playlists are written onto the browser-held device", async ({ page, request }) => {
  await attachOpfsDevice(page, deviceId);
  await runSync(page, deviceId);

  const tracks = await invoke<{ id: number }[]>(request, "library:getTracks", {
    limit: 10,
  });
  expect(tracks.length).toBeGreaterThan(0);

  const playlist = await invoke<{ id: number } | { error: string }>(
    request,
    "playlist:createClassic",
    { name: `Web Mix ${Date.now()}`, trackIds: [tracks[0].id] }
  );
  expect("id" in playlist).toBe(true);

  const result = await runSync(page, deviceId, { includePlaylists: true });
  expect(result.errors).toBe(0);

  const contents = await deviceContents(page, deviceId);
  const m3u = Object.keys(contents).filter((p) => p.endsWith(".m3u"));
  expect(m3u.length).toBeGreaterThan(0);
});

test("a device nobody is holding refuses to sync rather than reporting success", async ({
  page,
  request,
}) => {
  // Attach, then take the folder away — the state a user reaches by closing
  // the tab their player is plugged into.
  await attachOpfsDevice(page, deviceId);
  await page.evaluate(async (targetId: number) => {
    await (
      window as unknown as {
        __ipodrocksDevice: { disconnect(id: number): Promise<void> };
      }
    ).__ipodrocksDevice.disconnect(targetId);
  }, deviceId);

  await expect
    .poll(
      async () =>
        (await invoke<{ online: boolean }>(request, "device:ping", deviceId)).online,
      { timeout: 10_000 }
    )
    .toBe(false);

  // The important half: an empty answer would read as "every track is missing"
  // and a mirror sync would start writing the library into a directory on the
  // *server*. It has to be an error.
  const result = await invoke<{ error?: string; synced?: number }>(
    request,
    "sync:start",
    {
      deviceId,
      syncType: "full",
      extraTrackPolicy: "keep",
      includeMusic: true,
      includePodcasts: false,
      includeAudiobooks: false,
      includePlaylists: false,
    }
  );
  expect(result.error ?? "").toMatch(/not connected|disconnected/i);
});
