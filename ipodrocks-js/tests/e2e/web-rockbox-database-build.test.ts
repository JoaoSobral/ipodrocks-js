/**
 * Playwright E2E — "Build Rockbox database" on a device held in the browser.
 *
 * The desktop spec (`rockbox-database-build.test.ts`) drives the checkbox and
 * a local mount. This one runs the same build through `RemoteDeviceFs`: the
 * listing, the old database's read and the eleven writes all cross the
 * socket into an OPFS folder (a real `FileSystemDirectoryHandle`, as in
 * `web-device-sync.test.ts`). Two things differ from a local mount and are
 * pinned here:
 *
 *  - the files are written in place, not staged and renamed — a remote rename
 *    is a read, a write and a delete, and would double every byte;
 *  - a file the library does not know cannot be read from here, so it is left
 *    out rather than guessed at — unless the old database already had it.
 *
 * Run with: `npm run build && npx playwright test --project=web web-rockbox-database-build`
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { test, expect, type Page } from "@playwright/test";
import { invoke, signIn } from "./web-harness";
import {
  INDEX_FILE_NAME,
  decodeTagcache,
} from "../../src/main/rockbox/tagcache-build";

let seedDir: string;
let deviceId: number;
let folderId: number;

const TRACKS = ["01 First.mp3", "02 Second.mp3"];

interface PageApi {
  api: { invoke(c: string, ...a: unknown[]): Promise<unknown> };
  __ipodrocksDevice: {
    attachHandle(id: number, h: FileSystemDirectoryHandle): Promise<void>;
  };
}

test.beforeAll(async ({ request }) => {
  await signIn(request);
  seedDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-webrbdb-"));
  const album = path.join(seedDir, "Web DB Artist", "Web DB Album");
  fs.mkdirSync(album, { recursive: true });
  TRACKS.forEach((name, i) => fs.writeFileSync(path.join(album, name), Buffer.alloc(3000 + i, i + 1)));

  folderId = await invoke<number>(request, "library:addFolder", {
    name: "WebRockboxDbLib",
    path: seedDir,
    contentType: "music",
  });
  await invoke(request, "library:scan", {
    folders: [{ name: "WebRockboxDbLib", path: seedDir, contentType: "music" }],
  });
  const device = await invoke<{ id: number }>(request, "device:add", {
    name: `Web Rockbox DB ${Date.now()}`,
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
  try {
    if (deviceId) await invoke(request, "device:remove", deviceId);
    if (folderId) await invoke(request, "library:removeFolder", folderId);
  } catch {
    /* the scratch daemon is thrown away anyway */
  }
  fs.rmSync(seedDir, { recursive: true, force: true });
});

/** A fresh OPFS device with a `.rockbox` folder and one hand-copied file. */
async function attachRockboxDevice(page: Page, id: number): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(
    () => (window as unknown as { __ipodrocksDevice?: unknown }).__ipodrocksDevice
  );
  await page.evaluate(async (targetId: number) => {
    const root = await navigator.storage.getDirectory();
    for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) {
      await root.removeEntry(name, { recursive: true });
    }
    const dev = await root.getDirectoryHandle(`device-${targetId}`, { create: true });
    for (const folder of ["Music", "Podcasts", "Audiobooks", "Playlists"]) {
      await dev.getDirectoryHandle(folder, { create: true });
    }
    const write = async (dir: FileSystemDirectoryHandle, name: string, text: string) => {
      const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await w.write(text);
      await w.close();
    };
    const rb = await dev.getDirectoryHandle(".rockbox", { create: true });
    await write(rb, "rockbox-info.txt", "Target: ipodvideo\nVersion: 4.0\n");
    // Not in the library, and no old database knows it: unreadable from here.
    await write(await dev.getDirectoryHandle("Manual", { create: true }), "hand.mp3", "x".repeat(500));
    await (window as unknown as PageApi).__ipodrocksDevice.attachHandle(targetId, dev);
  }, id);

  await expect
    .poll(
      async () =>
        (
          (await page.evaluate(
            (targetId: number) =>
              (window as unknown as PageApi).api.invoke("device:ping", targetId),
            id
          )) as { online: boolean }
        ).online,
      { timeout: 10_000 }
    )
    .toBe(true);
}

/** The `.rockbox` folder's files and every audio file under `Music/`. */
async function readDevice(
  page: Page,
  id: number
): Promise<{ rockbox: Record<string, string>; music: string[] }> {
  return page.evaluate(async (targetId: number) => {
    const root = await navigator.storage.getDirectory();
    const dev = await root.getDirectoryHandle(`device-${targetId}`);
    const rockbox: Record<string, string> = {};
    const rb = await dev.getDirectoryHandle(".rockbox");
    for await (const h of (rb as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
      if (h.kind !== "file") continue;
      const bytes = new Uint8Array(await (await (h as FileSystemFileHandle).getFile()).arrayBuffer());
      let bin = "";
      for (const b of bytes) bin += String.fromCharCode(b);
      rockbox[h.name] = btoa(bin);
    }
    const music: string[] = [];
    const walk = async (dir: FileSystemDirectoryHandle, prefix: string) => {
      for await (const h of (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
        const rel = `${prefix}/${h.name}`;
        if (h.kind === "directory") await walk(h as FileSystemDirectoryHandle, rel);
        else music.push(rel);
      }
    };
    await walk(await dev.getDirectoryHandle("Music"), "Music");
    return { rockbox, music };
  }, id);
}

test("a sync with the option on writes the database into the browser-held device", async ({
  page,
}) => {
  await attachRockboxDevice(page, deviceId);

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
        buildRockboxDatabase: true,
      }),
    deviceId
  )) as { errors: number; synced: number };
  expect(result.errors).toBe(0);
  expect(result.synced).toBe(TRACKS.length);

  const { rockbox, music } = await readDevice(page, deviceId);
  expect(music).toHaveLength(TRACKS.length);

  // Written in place: no staging files left behind, and no backup because
  // there was no database before.
  expect(Object.keys(rockbox).filter((n) => n.includes(".ipodrocks-"))).toEqual([]);

  const tagFiles = new Map<number, Buffer>();
  for (const [name, b64] of Object.entries(rockbox)) {
    const m = /^database_(\d+)\.tcd$/.exec(name);
    if (m) tagFiles.set(Number(m[1]), Buffer.from(b64, "base64"));
  }
  const db = decodeTagcache(Buffer.from(rockbox[INDEX_FILE_NAME], "base64"), tagFiles);
  expect(db.header.dirty).toBe(0);
  // Exactly the synced files, named as the device spells them; the hand-copied
  // one is left out because a browser-held device cannot be read file by file.
  expect(db.entries.map((e) => e.filename).sort()).toEqual(music.map((m) => `/${m}`).sort());
  for (const e of db.entries) expect(e.title).toMatch(/^0[12] (First|Second)$/);

  // Remembered for this device.
  const prefs = (await page.evaluate(
    (id: number) => (window as unknown as PageApi).api.invoke("sync:getDevicePreferences", id),
    deviceId
  )) as { buildRockboxDatabase: boolean };
  expect(prefs.buildRockboxDatabase).toBe(true);
});
