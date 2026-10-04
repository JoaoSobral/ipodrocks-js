/**
 * Playwright E2E — a browser-held device that syncs from a shadow library.
 *
 * Reported in the field: a device check on a remote player said "0 synced,
 * N to sync" for a device that already held the tracks. The device was
 * sourcing from a shadow library, and `remapTrackMapToShadow()` kept the
 * *source* file's size on every record. A shadow sync is a direct copy, so the
 * compare took that size as exact, no transcode ever matched it, and the
 * fallback was mtime — which a local copy stamps and a browser cannot set. So
 * on a remote device every transcoded track read as missing on every check
 * and was re-copied on every sync, with nothing saying why.
 *
 * The local desktop never showed it: there the copy stamps the mtime and the
 * fallback quietly succeeds. That is why this spec has to be a web one.
 *
 * Run with: `npm run build && npx playwright test --project=web web-device-shadow-sync`
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { test, expect, type Page } from "@playwright/test";
import { invoke, signIn } from "./web-harness";

const TRACKS = ["01 Sine Low.flac", "02 Sine Mid.flac", "03 Sine High.flac"];
const ALBUM = path.join("Shadow Artist", "Shadow Album");

let rootDir: string;
let libraryDir: string;
let shadowDir: string;
let folderId: number;
let shadowId: number;
let deviceId: number;

function ffmpegAvailable(): boolean {
  try {
    return spawnSync("ffmpeg", ["-version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

test.skip(!ffmpegAvailable(), "requires ffmpeg to generate and transcode fixtures");
test.describe.configure({ mode: "serial" });

interface ShadowRow {
  id: number;
  path: string;
  status: string;
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(120_000);
  await signIn(request);

  // `shadow:create` and `library:addFolder` enforce a path allowlist ($HOME).
  rootDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-webshadow-"));
  libraryDir = path.join(rootDir, "library");
  shadowDir = path.join(rootDir, "shadow");
  fs.mkdirSync(path.join(libraryDir, ALBUM), { recursive: true });
  fs.mkdirSync(shadowDir, { recursive: true });
  TRACKS.forEach((name, i) => {
    // Real FLAC, so the shadow is a real transcode whose size differs from
    // the source's — which is the whole of the bug.
    const r = spawnSync(
      "ffmpeg",
      [
        "-y", "-f", "lavfi",
        "-i", `sine=frequency=${300 + i * 200}:duration=2`,
        "-c:a", "flac", path.join(libraryDir, ALBUM, name),
      ],
      { encoding: "utf8" }
    );
    if (r.status !== 0) throw new Error(`ffmpeg failed for ${name}: ${r.stderr}`);
  });

  folderId = await invoke<number>(request, "library:addFolder", {
    name: "WebShadowLib",
    path: libraryDir,
    contentType: "music",
  });
  await invoke(request, "library:scan", {
    folders: [{ name: "WebShadowLib", path: libraryDir, contentType: "music" }],
  });

  const configs = await invoke<Array<{ id: number; codec_name: string }>>(
    request,
    "device:getCodecConfigs"
  );
  const mp3 = configs.find((c) => (c.codec_name ?? "").toUpperCase() === "MP3");
  if (!mp3) throw new Error("no MP3 codec configuration");

  const created = await invoke<{ id?: number; error?: string }>(request, "shadow:create", {
    name: `Web Shadow ${Date.now()}`,
    path: shadowDir,
    codecConfigId: mp3.id,
    vbrEnabled: false,
  });
  if (created.error || created.id == null) {
    throw new Error(`shadow:create failed: ${created.error}`);
  }
  shadowId = created.id;

  // The build runs in the background; wait for every one of *our* transcodes
  // to exist rather than for the row's status, which also covers whatever
  // other specs left in the shared daemon's library.
  await expect
    .poll(
      async () => {
        const rows = await invoke<ShadowRow[]>(request, "shadow:getAll");
        const row = rows.find((r) => r.id === shadowId);
        if (!row || row.status === "building" || row.status === "pending") return -1;
        return TRACKS.filter((t) =>
          fs.existsSync(path.join(shadowDir, ALBUM, t.replace(/\.flac$/, ".mp3")))
        ).length;
      },
      { timeout: 90_000 }
    )
    .toBe(TRACKS.length);

  // The two preconditions the bug needs. The transcode is not the source's
  // size, and it is old: a shadow built seconds before the sync sits inside the
  // mtime fallback's 2.5 s tolerance of the copy and hides the whole defect.
  // A real shadow library was built days before anyone syncs from it.
  const lastWeek = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  for (const t of TRACKS) {
    const src = fs.statSync(path.join(libraryDir, ALBUM, t)).size;
    const shadowFile = path.join(shadowDir, ALBUM, t.replace(/\.flac$/, ".mp3"));
    expect(fs.statSync(shadowFile).size).not.toBe(src);
    fs.utimesSync(shadowFile, lastWeek, lastWeek);
  }

  const device = await invoke<{ id: number }>(request, "device:add", {
    name: `Web Shadow Player ${Date.now()}`,
    transport: "web",
    modelId: null,
    sourceLibraryType: "shadow",
    shadowLibraryId: shadowId,
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
    if (shadowId) await invoke(request, "shadow:delete", shadowId, false);
    if (folderId) await invoke(request, "library:removeFolder", folderId);
  } catch {
    /* the scratch daemon is thrown away anyway */
  }
  try {
    fs.rmSync(rootDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** Same OPFS-as-device trick as `web-device-sync.test.ts`. */
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
    const deviceRoot = await root.getDirectoryHandle(`device-${targetId}`, {
      create: true,
    });
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

async function pageInvoke<T>(page: Page, channel: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    async ({ channel, args }) =>
      (await (
        window as unknown as {
          api: { invoke(c: string, ...a: unknown[]): Promise<unknown> };
        }
      ).api.invoke(channel, ...args)) as T,
    { channel, args }
  );
}

interface CheckResult {
  musicSyncedWithLibrary: number;
  musicToSync: number;
  musicOrphans: number;
}

interface SyncResult {
  synced: number;
  errors: number;
}

function syncPayload(id: number): Record<string, unknown> {
  return {
    deviceId: id,
    syncType: "full",
    extraTrackPolicy: "keep",
    includeMusic: true,
    includePodcasts: false,
    includeAudiobooks: false,
    includePlaylists: false,
  };
}

test("a check after a shadow sync counts the transcodes as synced", async ({ page }) => {
  test.setTimeout(120_000);
  await attachOpfsDevice(page, deviceId);

  const first = await pageInvoke<SyncResult>(page, "sync:start", syncPayload(deviceId));
  expect(first.synced).toBeGreaterThanOrEqual(TRACKS.length);

  const check = await pageInvoke<CheckResult>(page, "device:check", deviceId);
  // Before the fix: 0 synced, every track "to sync", and no orphans — the
  // files were found by path and then refused on size.
  expect(check.musicToSync).toBe(0);
  expect(check.musicSyncedWithLibrary).toBeGreaterThanOrEqual(TRACKS.length);
  expect(check.musicOrphans).toBe(0);
});

test("a second shadow sync copies nothing", async ({ page }) => {
  test.setTimeout(120_000);
  await attachOpfsDevice(page, deviceId);

  await pageInvoke<SyncResult>(page, "sync:start", syncPayload(deviceId));
  const second = await pageInvoke<SyncResult>(page, "sync:start", syncPayload(deviceId));
  // Before the fix this re-uploaded every transcode through the browser, on
  // every run, for ever.
  expect(second.synced).toBe(0);
  expect(second.errors).toBe(0);
});
