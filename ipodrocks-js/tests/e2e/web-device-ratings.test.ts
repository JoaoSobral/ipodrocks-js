/**
 * Playwright E2E — Rockbox's runtime data, read and written over the device RPC.
 *
 * Ratings are the part of the sync that touches raw bytes in a file with no
 * checksum, and on a browser-held device those bytes cross the wire twice:
 * out as a `readFile`/`readRange`, back as a `patch`. Every hazard CLAUDE.md
 * records about ratings — the zero-is-not-null rule, the rebuilt-database
 * verdict, the propagation gap of issue #138 — is reached through code that
 * now has a second implementation underneath it.
 *
 * What this spec is really checking is that the second implementation writes
 * the *same bytes in the same places* as the first, because a rating write
 * that lands one word off is not an error anywhere: it corrupts a play count
 * or a length, and the user finds out much later.
 *
 * The device is an OPFS directory, for the reason given in
 * `web-device-sync.test.ts`: it is a real `FileSystemDirectoryHandle`, so the
 * whole File System Access path runs, and only the picker dialog is left to
 * manual verification.
 *
 * Run with: `npm run build && npx playwright test --project=web`
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { test, expect, type Page } from "@playwright/test";
import { invoke, signIn } from "./web-harness";
import {
  writeTcdFixture,
  type TcdFixtureTrack,
} from "../../src/__tests__/harness/tcd-fixture";

const MASTER_HEADER_SIZE = 24;
const TAG_COUNT = 23;
const INDEX_ENTRY_SIZE = (TAG_COUNT + 1) * 4;
const TAG_RATING = 16;
const TAG_PLAYCOUNT = 15;
const FLAG_DIRTYNUM = 0x4;

const ARTIST = "Runtime Artist";
const ALBUM = "Runtime Album";
const TITLES = ["One", "Two", "Three"];

let seedDir: string;
let fixtureDir: string;
let deviceId: number;
let folderId: number;

function ratingOffset(idxId: number): number {
  return MASTER_HEADER_SIZE + idxId * INDEX_ENTRY_SIZE + TAG_RATING * 4;
}
function playCountOffset(idxId: number): number {
  return MASTER_HEADER_SIZE + idxId * INDEX_ENTRY_SIZE + TAG_PLAYCOUNT * 4;
}
function flagOffset(idxId: number): number {
  return MASTER_HEADER_SIZE + idxId * INDEX_ENTRY_SIZE + TAG_COUNT * 4;
}

test.beforeAll(async ({ request }) => {
  await signIn(request);

  seedDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-webrate-"));
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-e2e-tcd-"));

  const album = path.join(seedDir, ARTIST, ALBUM);
  fs.mkdirSync(album, { recursive: true });
  TITLES.forEach((title, i) => {
    fs.writeFileSync(path.join(album, `${title}.mp3`), Buffer.alloc(1024 + i * 32, i + 1));
  });

  folderId = await invoke<number>(request, "library:addFolder", {
    name: "WebRatingLib",
    path: seedDir,
    contentType: "music",
  });
  await invoke(request, "library:scan", {
    folders: [{ name: "WebRatingLib", path: seedDir, contentType: "music" }],
  });

  const device = await invoke<{ id: number }>(request, "device:add", {
    name: `Rating Player ${Date.now()}`,
    transport: "web",
    modelId: null,
  });
  deviceId = device.id;
});

test.afterAll(async ({ request }) => {
  try {
    if (deviceId) await invoke(request, "device:remove", deviceId);
    if (folderId) await invoke(request, "library:removeFolder", folderId);
  } catch {
    /* the scratch daemon is discarded anyway */
  }
  for (const dir of [seedDir, fixtureDir]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

test.beforeEach(async ({ page, request }) => {
  await signIn(request);
  await signIn(page.request);
});

/**
 * Build the two `.tcd` files in Node, then put them in the browser's OPFS.
 *
 * The fixture writer is the same one the Electron rating specs use, so both
 * transports are driven against byte-identical input — which is the only way
 * "the remote path writes the same bytes" means anything.
 */
function buildTcd(ratings: Record<string, number>): {
  idx: string;
  tags: string;
  idxByTitle: Map<string, number>;
} {
  fs.rmSync(path.join(fixtureDir, ".rockbox"), { recursive: true, force: true });
  const tracks: TcdFixtureTrack[] = [];
  const idxByTitle = new Map<string, number>();
  TITLES.forEach((title) => {
    idxByTitle.set(title, tracks.length);
    tracks.push({
      path: `/<HDD0>/Music/${ARTIST}/${ALBUM}/${title}.mp3`,
      playCount: 2,
      playTimeMs: 400_000,
      lengthMs: 200_000,
      rating: ratings[title] ?? 0,
      lastPlayedSerial: tracks.length + 1,
    });
  });
  writeTcdFixture(fixtureDir, tracks);
  const rockbox = path.join(fixtureDir, ".rockbox");
  return {
    idx: fs.readFileSync(path.join(rockbox, "database_idx.tcd")).toString("base64"),
    tags: fs.readFileSync(path.join(rockbox, "database_4.tcd")).toString("base64"),
    idxByTitle,
  };
}

/** Attaches a fresh OPFS device carrying the given `.tcd` pair and the tracks. */
async function attachDeviceWithRuntime(
  page: Page,
  ratings: Record<string, number>
): Promise<Map<string, number>> {
  const { idx, tags, idxByTitle } = buildTcd(ratings);

  await page.goto("/");
  await page.waitForFunction(
    () => (window as unknown as { __ipodrocksDevice?: unknown }).__ipodrocksDevice
  );

  await page.evaluate(
    async (args: { id: number; idx: string; tags: string; rel: string[] }) => {
      const decode = (b64: string) => {
        const binary = atob(b64);
        const out = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
        return out;
      };
      const write = async (
        dir: FileSystemDirectoryHandle,
        name: string,
        bytes: Uint8Array
      ) => {
        const handle = await dir.getFileHandle(name, { create: true });
        const writable = await handle.createWritable();
        await writable.write(bytes);
        await writable.close();
      };

      const root = await navigator.storage.getDirectory();
      for await (const name of (
        root as unknown as { keys(): AsyncIterable<string> }
      ).keys()) {
        await root.removeEntry(name, { recursive: true });
      }
      const deviceRoot = await root.getDirectoryHandle(`device-${args.id}`, {
        create: true,
      });
      for (const folder of ["Music", "Podcasts", "Audiobooks", "Playlists"]) {
        await deviceRoot.getDirectoryHandle(folder, { create: true });
      }

      // The audio files Rockbox's database claims to describe, laid out the
      // way the sync would have written them.
      let dir = await deviceRoot.getDirectoryHandle("Music");
      for (const segment of args.rel) {
        dir = await dir.getDirectoryHandle(segment, { create: true });
      }
      for (const title of ["One", "Two", "Three"]) {
        await write(dir, `${title}.mp3`, new Uint8Array(1024));
      }

      const rockbox = await deviceRoot.getDirectoryHandle(".rockbox", { create: true });
      await write(rockbox, "database_idx.tcd", decode(args.idx));
      await write(rockbox, "database_4.tcd", decode(args.tags));

      await (
        window as unknown as {
          __ipodrocksDevice: {
            attachHandle(id: number, h: FileSystemDirectoryHandle): Promise<void>;
          };
        }
      ).__ipodrocksDevice.attachHandle(args.id, deviceRoot);
    },
    { id: deviceId, idx, tags, rel: [ARTIST, ALBUM] }
  );

  await expect
    .poll(
      async () =>
        (
          await page.evaluate(
            async (id: number) =>
              (await (
                window as unknown as {
                  api: { invoke(c: string, ...a: unknown[]): Promise<unknown> };
                }
              ).api.invoke("device:ping", id)) as { online: boolean },
            deviceId
          )
        ).online,
      { timeout: 10_000 }
    )
    .toBe(true);

  return idxByTitle;
}

/** The device's index file, straight out of OPFS. */
async function readIndexBytes(page: Page): Promise<Buffer> {
  const b64 = await page.evaluate(async (id: number) => {
    const root = await navigator.storage.getDirectory();
    const deviceRoot = await root.getDirectoryHandle(`device-${id}`);
    const rockbox = await deviceRoot.getDirectoryHandle(".rockbox");
    const file = await (await rockbox.getFileHandle("database_idx.tcd")).getFile();
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }, deviceId);
  return Buffer.from(b64, "base64");
}

async function runSync(page: Page): Promise<{ status: string; errors: number }> {
  return page.evaluate(
    async (id: number) =>
      (await (
        window as unknown as {
          api: { invoke(c: string, ...a: unknown[]): Promise<unknown> };
        }
      ).api.invoke("sync:start", {
        deviceId: id,
        syncType: "full",
        extraTrackPolicy: "keep",
        includeMusic: true,
        includePodcasts: false,
        includeAudiobooks: false,
        includePlaylists: false,
      })) as { status: string; errors: number },
    deviceId
  );
}

interface TrackRow {
  id: number;
  title: string | null;
  rating: number | null;
}

async function libraryTracks(page: Page): Promise<TrackRow[]> {
  return page.evaluate(
    async () =>
      (await (
        window as unknown as {
          api: { invoke(c: string, ...a: unknown[]): Promise<unknown> };
        }
      ).api.invoke("library:getTracks", { limit: 100 })) as TrackRow[]
  );
}

test("ratings on the device are read back over the RPC and adopted", async ({
  page,
}) => {
  // Two rated, one not. A device 0 against a library null must stay a noop —
  // Rockbox has no null rating, so reading it as an assertion is what queued
  // one unanswerable conflict per track in issue #117.
  await attachDeviceWithRuntime(page, { One: 8, Two: 6 });

  const result = await runSync(page);
  expect(result.errors).toBe(0);

  const tracks = await libraryTracks(page);
  const byTitle = new Map(tracks.map((t) => [t.title ?? "", t.rating]));
  expect(byTitle.get("One")).toBe(8);
  expect(byTitle.get("Two")).toBe(6);
  // Not 0: both sides agree there is no rating, so there is nothing to adopt.
  expect(byTitle.get("Three") ?? null).toBeNull();
});

test("a rating set in the library is patched into the device's index", async ({
  page,
}) => {
  const idxByTitle = await attachDeviceWithRuntime(page, {});
  // First sync establishes the baseline. A device-side edit compared against
  // no baseline takes a different branch entirely.
  await runSync(page);

  const tracks = await libraryTracks(page);
  const three = tracks.find((t) => t.title === "Three");
  expect(three).toBeTruthy();

  const before = await readIndexBytes(page);
  await page.evaluate(
    async (args: { id: number; rating: number }) =>
      (
        window as unknown as {
          api: { invoke(c: string, ...a: unknown[]): Promise<unknown> };
        }
      ).api.invoke("ratings:setTrackRating", args.id, args.rating),
    { id: three!.id, rating: 10 }
  );

  const result = await runSync(page);
  expect(result.errors).toBe(0);

  const after = await readIndexBytes(page);
  const idxId = idxByTitle.get("Three")!;

  // The value landed where Rockbox reads it...
  expect(after.readInt32LE(ratingOffset(idxId))).toBe(10);
  // ...the record is flagged dirty so it survives a database rebuild...
  expect(after.readInt32LE(flagOffset(idxId)) & FLAG_DIRTYNUM).toBe(FLAG_DIRTYNUM);
  // ...the file did not change length, so every absolute offset in it still
  // addresses what it did...
  expect(after.length).toBe(before.length);
  // ...the neighbouring record is untouched...
  const otherIdx = idxByTitle.get("One")!;
  expect(after.readInt32LE(playCountOffset(otherIdx))).toBe(
    before.readInt32LE(playCountOffset(otherIdx))
  );
  // ...and nothing outside the two words this write is allowed to touch moved.
  const changed: number[] = [];
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== after[i]) changed.push(i);
  }
  for (const offset of changed) {
    const inRating =
      offset >= ratingOffset(idxId) && offset < ratingOffset(idxId) + 4;
    const inFlag = offset >= flagOffset(idxId) && offset < flagOffset(idxId) + 4;
    expect(inRating || inFlag, `byte ${offset} should not have changed`).toBe(true);
  }
  expect(changed.length).toBeGreaterThan(0);
});

test("the index is backed up before the first write, and only then", async ({
  page,
}) => {
  await attachDeviceWithRuntime(page, {});
  await runSync(page);

  const backupAfterNoop = await page.evaluate(async (id: number) => {
    const root = await navigator.storage.getDirectory();
    const deviceRoot = await root.getDirectoryHandle(`device-${id}`);
    const rockbox = await deviceRoot.getDirectoryHandle(".rockbox");
    const names: string[] = [];
    for await (const handle of (
      rockbox as unknown as { values(): AsyncIterable<FileSystemHandle> }
    ).values()) {
      names.push(handle.name);
    }
    return names;
  }, deviceId);
  // Nothing was written, so nothing was backed up. The index has no checksum
  // and Chrome rewrites a file wholesale rather than patching, so the backup
  // matters more here than locally — but a copy per sync of a file nobody is
  // changing is just wear on the player.
  expect(backupAfterNoop).not.toContain("database_idx.tcd.ipodrocks-bak");

  const tracks = await libraryTracks(page);
  const one = tracks.find((t) => t.title === "One")!;
  await page.evaluate(
    async (args: { id: number; rating: number }) =>
      (
        window as unknown as {
          api: { invoke(c: string, ...a: unknown[]): Promise<unknown> };
        }
      ).api.invoke("ratings:setTrackRating", args.id, args.rating),
    { id: one.id, rating: 4 }
  );
  await runSync(page);

  const backupAfterWrite = await page.evaluate(async (id: number) => {
    const root = await navigator.storage.getDirectory();
    const deviceRoot = await root.getDirectoryHandle(`device-${id}`);
    const rockbox = await deviceRoot.getDirectoryHandle(".rockbox");
    const names: string[] = [];
    for await (const handle of (
      rockbox as unknown as { values(): AsyncIterable<FileSystemHandle> }
    ).values()) {
      names.push(handle.name);
    }
    return names;
  }, deviceId);
  expect(backupAfterWrite).toContain("database_idx.tcd.ipodrocks-bak");
});

test("a device Rockbox is mid-update is refused, not written to", async ({ page }) => {
  await attachDeviceWithRuntime(page, {});
  await runSync(page);

  const tracks = await libraryTracks(page);
  const two = tracks.find((t) => t.title === "Two")!;
  await page.evaluate(
    async (args: { id: number; rating: number }) =>
      (
        window as unknown as {
          api: { invoke(c: string, ...a: unknown[]): Promise<unknown> };
        }
      ).api.invoke("ratings:setTrackRating", args.id, args.rating),
    { id: two.id, rating: 7 }
  );

  // `dirty` non-zero: Rockbox is writing its own database right now.
  await page.evaluate(async (id: number) => {
    const root = await navigator.storage.getDirectory();
    const deviceRoot = await root.getDirectoryHandle(`device-${id}`);
    const rockbox = await deviceRoot.getDirectoryHandle(".rockbox");
    const handle = await rockbox.getFileHandle("database_idx.tcd");
    const writable = await handle.createWritable({ keepExistingData: true });
    const word = new Uint8Array(4);
    new DataView(word.buffer).setInt32(0, 1, true);
    await writable.write({ type: "write", position: 20, data: word });
    await writable.close();
  }, deviceId);

  const before = await readIndexBytes(page);
  const result = await runSync(page);
  expect(result.errors).toBe(0);
  const after = await readIndexBytes(page);

  // Not one byte. Racing Rockbox's own writer on a checksum-less file is how a
  // database gets corrupted, and the rating is simply retried next sync.
  expect(after.equals(before)).toBe(true);
});
