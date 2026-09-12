/**
 * E2E — a shadow library rebuild repairs the tags it used to skip (issue #130).
 *
 * After the #125 fix shipped, the reporter was told to re-scan the library and
 * then rebuild the shadow library. Neither could have worked: `_transcodeTrack`
 * returns "skipped" whenever a `synced` row and the file both exist, and the
 * reconcile pass trusts an existing file's stored size+mtime without ever
 * parsing it — so a file was never re-opened, let alone re-tagged. A rebuild
 * now checks the tag block itself before it encodes anything.
 *
 * Drives the real built app end to end: registers a shadow library, plants an
 * .mpc carrying the legacy broken tag inside it, and calls `shadow:rebuild`.
 * The tag surgery itself is pure and covered in
 * src/__tests__/regressions/mpc-cover-art-item-flags.test.ts.
 *
 * Run: npm run build && npx playwright test tests/e2e/shadow-rebuild-tag-repair.test.ts
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { test, expect, type Page } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./electron-launcher";
import { AUDIO, COVER, itemFlags, itemOffset, writeLegacyMpc } from "../../src/__tests__/harness/legacy-mpc";

let launched: LaunchedApp;
let rootDir: string;
let shadowDir: string;

interface ApiWindow {
  api: {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    on: (channel: string, cb: (...args: unknown[]) => void) => () => void;
  };
}

test.beforeEach(async () => {
  // Under the home directory: `shadow:create` enforces a path allowlist.
  rootDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-rebuildtag-"));
  shadowDir = path.join(rootDir, "shadow");
  fs.mkdirSync(shadowDir, { recursive: true });
  launched = await launchApp();
});

test.afterEach(async () => {
  await launched.cleanup();
  try {
    fs.rmSync(rootDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

async function readyWindow(): Promise<Page> {
  const window = await launched.app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await window.waitForFunction(
    () =>
      typeof (window as unknown as { api?: { invoke?: unknown } }).api?.invoke ===
      "function",
    null,
    { timeout: 15_000 }
  );
  return window;
}

/**
 * Register a shadow library over `shadowPath` and wait for its first build.
 *
 * The codec is MP3, not Musepack: the verify pass walks the folder for `.mpc`
 * whatever the library encodes to, and an MP3 configuration needs no `mpcenc`
 * binary on the machine running the suite. A real library that later changes
 * codec is in exactly this shape too.
 */
async function createShadowLib(window: Page, shadowPath: string): Promise<number> {
  return window.evaluate(async (p) => {
    const api = (window as unknown as ApiWindow).api;

    let done: () => void;
    const finished = new Promise<void>((resolve) => (done = resolve));
    const unsub = api.on("shadow:buildProgress", (...args: unknown[]) => {
      const ev = args[args.length - 1] as { status: string };
      if (ev.status === "complete" || ev.status === "error" || ev.status === "paused") {
        done();
      }
    });

    const configs = (await api.invoke("device:getCodecConfigs")) as Array<{
      id: number;
      codec_name: string;
    }>;
    const mp3 = configs.find((c) => (c.codec_name ?? "").toUpperCase() === "MP3");
    if (!mp3) throw new Error("no MP3 codec configuration");

    const created = (await api.invoke("shadow:create", {
      name: `Rebuild ${Date.now()}`,
      path: p,
      codecConfigId: mp3.id,
      vbrEnabled: false,
    })) as { id?: number; error?: string };
    if (created.error) throw new Error(`shadow:create failed: ${created.error}`);

    await finished;
    unsub();
    return created.id as number;
  }, shadowPath);
}

/** Run `shadow:rebuild` and resolve with the log lines the build emitted. */
async function rebuild(window: Page, shadowLibId: number): Promise<string[]> {
  return window.evaluate(async (id) => {
    const api = (window as unknown as ApiWindow).api;

    const logs: string[] = [];
    let done: () => void;
    const finished = new Promise<void>((resolve) => (done = resolve));
    const unsub = api.on("shadow:buildProgress", (...args: unknown[]) => {
      const ev = args[args.length - 1] as { status: string; logMessage?: string };
      if (ev.logMessage) logs.push(ev.logMessage);
      if (ev.status === "complete" || ev.status === "error" || ev.status === "paused") {
        done();
      }
    });

    const started = (await api.invoke("shadow:rebuild", id)) as { error?: string };
    if (started.error) throw new Error(`shadow:rebuild failed: ${started.error}`);

    await finished;
    unsub();
    return logs;
  }, shadowLibId);
}

test("a rebuild repairs a legacy Musepack tag already in the shadow folder", async () => {
  const window = await readyWindow();
  const shadowLibId = await createShadowLib(window, shadowDir);

  const broken = path.join(shadowDir, "Artist", "Album", "01 - Legacy.mpc");
  writeLegacyMpc(broken);
  // A file the rebuild has no business touching.
  const untouched = path.join(shadowDir, "Artist", "Album", "notes.txt");
  fs.writeFileSync(untouched, "leave me alone");

  const before = fs.readFileSync(broken);
  const beforeStat = fs.statSync(broken);
  expect(itemFlags(before, "Cover Art (Front)")).toBe(1);

  const logs = await rebuild(window, shadowLibId);

  const after = fs.readFileSync(broken);

  // The artwork is gone outright — nothing embeds any now (#130).
  expect(after.includes(COVER)).toBe(false);
  expect(() => itemOffset(after, "Cover Art (Front)")).toThrow();

  // ReplayGain and the audio survive.
  expect(itemOffset(after, "REPLAYGAIN_TRACK_GAIN")).toBeGreaterThan(0);
  expect(after.subarray(0, AUDIO.byteLength).equals(AUDIO)).toBe(true);

  // Smaller, because the image came out — but the floored mtime is unchanged,
  // which is what `shadow_tracks.mtime` stores and compares, so the rebuild
  // does not cascade into re-encoding the track it just repaired.
  const afterStat = fs.statSync(broken);
  expect(afterStat.size).toBeLessThan(beforeStat.size);
  expect(Math.floor(afterStat.mtimeMs)).toBe(Math.floor(beforeStat.mtimeMs));

  // Nothing else in the folder was touched.
  expect(fs.readFileSync(untouched, "utf8")).toBe("leave me alone");

  // The build log says what happened, and points at the one place that can fix
  // the copies already sitting on a device.
  expect(logs.some((l) => /1 repaired/.test(l))).toBe(true);
  expect(logs.some((l) => /Repair Musepack tags/.test(l))).toBe(true);
});

test("a second rebuild finds nothing left to repair", async () => {
  const window = await readyWindow();
  const shadowLibId = await createShadowLib(window, shadowDir);
  const broken = path.join(shadowDir, "Artist", "Album", "01 - Legacy.mpc");
  writeLegacyMpc(broken);

  expect((await rebuild(window, shadowLibId)).some((l) => /1 repaired/.test(l))).toBe(true);

  const settled = fs.readFileSync(broken);
  const logs = await rebuild(window, shadowLibId);

  expect(logs.some((l) => /repaired/.test(l))).toBe(false);
  // Idempotent to the byte: a clean file is read, judged fine and left closed.
  expect(fs.readFileSync(broken).equals(settled)).toBe(true);
});
