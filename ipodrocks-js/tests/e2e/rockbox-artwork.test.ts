/**
 * E2E tests for the per-device Rockbox artwork setting.
 *
 * Drives the real built app through the IPC bridge (renderer → preload → main
 * → SQLite) to verify that `artworkMaxDimension` and `skipAlbumArtwork` persist
 * and can be updated. The actual cover.jpg generation (real ffmpeg) is covered
 * by src/__tests__/behaviors/rockbox-artwork.test.ts.
 *
 * Run: npm run build && npx playwright test
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { test, expect, type Page } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./electron-launcher";
import { readImageDimensionsFromFile } from "../../src/main/utils/image-dimensions";

let launched: LaunchedApp;

test.beforeEach(async () => {
  launched = await launchApp();
});
test.afterEach(async () => {
  await launched.cleanup();
});

async function readyWindow(): Promise<Page> {
  const window = await launched.app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: { invoke?: unknown } }).api?.invoke === "function",
    null,
    { timeout: 15_000 }
  );
  return window;
}

test("artwork max dimension defaults to 300 and round-trips through update", async () => {
  const window = await readyWindow();

  const result = await window.evaluate(async () => {
    const api = (window as unknown as {
      api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    }).api;

    const added = (await api.invoke("device:add", {
      name: `Artwork ${Date.now()}`,
      mountPath: "/tmp/ipr-artwork",
    })) as { id: number };

    const listBefore = (await api.invoke("device:list")) as Array<{
      id: number;
      artworkMaxDimension?: number;
    }>;
    const defaultDim = listBefore.find((d) => d.id === added.id)?.artworkMaxDimension;

    // Update to a different allowed size + skip flag.
    await api.invoke("device:update", added.id, {
      artworkMaxDimension: 500,
      skipAlbumArtwork: true,
    });

    const listAfter = (await api.invoke("device:list")) as Array<{
      id: number;
      artworkMaxDimension?: number;
      skipAlbumArtwork?: boolean;
    }>;
    const after = listAfter.find((d) => d.id === added.id);
    return { defaultDim, updatedDim: after?.artworkMaxDimension, skip: after?.skipAlbumArtwork };
  });

  expect(result.defaultDim).toBe(300);
  expect(result.updatedDim).toBe(500);
  expect(result.skip).toBe(true);
});

test("an out-of-range artwork dimension is clamped to the safe default", async () => {
  const window = await readyWindow();

  const dim = await window.evaluate(async () => {
    const api = (window as unknown as {
      api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    }).api;

    const added = (await api.invoke("device:add", {
      name: `Artwork Clamp ${Date.now()}`,
      mountPath: "/tmp/ipr-artwork-clamp",
    })) as { id: number };

    await api.invoke("device:update", added.id, { artworkMaxDimension: 9999 });

    const list = (await api.invoke("device:list")) as Array<{
      id: number;
      artworkMaxDimension?: number;
    }>;
    return list.find((d) => d.id === added.id)?.artworkMaxDimension;
  });

  // 9999 is not an allowed value → clamped to the 300 default.
  expect(dim).toBe(300);
});

/**
 * An 800x800 JPEG whose first image data sits behind a 4 KB comment block, the
 * way real covers carry EXIF/ICC data. ffmpeg probes such a file as `image2`,
 * which the input whitelist refuses, so every one of them used to reach the
 * player at full size via the "copied original" fallback.
 */
function writeRealWorldCover(dest: string): boolean {
  const plain = `${dest}.plain.jpg`;
  const res = spawnSync(
    "ffmpeg",
    ["-y", "-v", "quiet", "-f", "lavfi", "-i", "color=red:s=800x800:d=1", "-frames:v", "1", plain],
    { encoding: "utf8" }
  );
  if (res.status !== 0 || !fs.existsSync(plain)) return false;
  const small = fs.readFileSync(plain);
  const payload = Buffer.alloc(4000, 0x41);
  const com = Buffer.concat([
    Buffer.from([0xff, 0xfe, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]),
    payload,
  ]);
  fs.writeFileSync(dest, Buffer.concat([small.subarray(0, 2), com, small.subarray(2)]));
  fs.unlinkSync(plain);
  return true;
}

function findFile(dir: string, name: string): string | null {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const hit = findFile(p, name);
      if (hit) return hit;
    } else if (e.name === name) return p;
  }
  return null;
}

test("a sync resizes a real-world cover.jpeg instead of copying it at full size", async () => {
  const root = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-cover-"));
  try {
    const album = path.join(root, "library", "Cover Artist", "Cover Album");
    const mount = path.join(root, "device");
    fs.mkdirSync(album, { recursive: true });
    for (const d of ["Music", "Podcasts", "Audiobooks", "Playlists"]) {
      fs.mkdirSync(path.join(mount, d), { recursive: true });
    }
    const track = spawnSync(
      "ffmpeg",
      ["-y", "-v", "quiet", "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono", "-t", "1",
        "-metadata", "title=Cover Track", "-metadata", "album=Cover Album",
        path.join(album, "01 Cover Track.flac")],
      { encoding: "utf8" }
    );
    test.skip(
      track.status !== 0 || !writeRealWorldCover(path.join(album, "cover.jpeg")),
      "ffmpeg unavailable — cannot seed a library"
    );

    const window = await readyWindow();
    const result = await window.evaluate(
      async ({ lib, m }) => {
        const api = (window as unknown as {
          api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
        }).api;
        await api.invoke("library:addFolder", { name: "E2E Cover Lib", path: lib, contentType: "music" });
        await api.invoke("library:scan", {
          folders: [{ name: "E2E Cover Lib", path: lib, contentType: "music" }],
        });
        const dev = (await api.invoke("device:add", { name: `Cover ${Date.now()}`, mountPath: m })) as {
          id: number;
        };
        return (await api.invoke("sync:start", {
          deviceId: dev.id,
          syncType: "full",
          extraTrackPolicy: "keep",
          includeMusic: true,
          includePodcasts: false,
          includeAudiobooks: false,
          includePlaylists: false,
        })) as { errors: number; synced: number };
      },
      { lib: path.join(root, "library"), m: mount }
    );
    expect(result.errors).toBe(0);
    expect(result.synced).toBe(1);

    const cover = findFile(path.join(mount, "Music"), "cover.jpg");
    expect(cover).not.toBeNull();
    const dims = readImageDimensionsFromFile(cover!);
    expect(dims).not.toBeNull();
    expect(Math.max(dims!.width, dims!.height)).toBeLessThanOrEqual(300);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
