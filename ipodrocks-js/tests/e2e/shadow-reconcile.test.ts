/**
 * E2E — shadow library adopts transcoded files that are already on disk.
 *
 * The reported scenario: a shadow library's DB row is lost (profile reset,
 * reinstall) while every transcoded file survives on disk. Recreating the
 * library with the same path and codec used to re-encode the entire thing,
 * because the skip test in `_transcodeTrack` is keyed on a `shadow_tracks` row
 * that the new library id does not have.
 *
 * `shadow:delete(id, keepFilesOnDisk = true)` reproduces that exactly through
 * the real IPC surface: the library row goes, ON DELETE CASCADE takes the
 * shadow_tracks rows, the files stay. The definitive assertion is that the
 * output files' mtimes are unchanged after the second create — a re-encode
 * would necessarily rewrite them.
 *
 * Run: npm run build && npx playwright test tests/e2e/shadow-reconcile.test.ts
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { test, expect, type Page } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./electron-launcher";

let launched: LaunchedApp;
let rootDir: string;
let libraryDir: string;
let shadowDir: string;

/** `shadow:create` and `library:addFolder` enforce a path allowlist. */
function makeDirs(): void {
  rootDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-shadow-recon-"));
  libraryDir = path.join(rootDir, "library");
  shadowDir = path.join(rootDir, "shadow");
  fs.mkdirSync(libraryDir, { recursive: true });
  fs.mkdirSync(shadowDir, { recursive: true });
}

function ffmpegAvailable(): boolean {
  try {
    return spawnSync("ffmpeg", ["-version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

/** A short real audio file — the app must be able to decode and re-encode it. */
function makeSource(relPath: string, seconds: number, freq: number): void {
  const full = path.join(libraryDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const r = spawnSync(
    "ffmpeg",
    [
      "-y", "-f", "lavfi",
      "-i", `sine=frequency=${freq}:duration=${seconds}`,
      "-c:a", "flac", full,
    ],
    { encoding: "utf8" }
  );
  if (r.status !== 0) throw new Error(`ffmpeg failed for ${relPath}: ${r.stderr}`);
}

test.skip(!ffmpegAvailable(), "requires ffmpeg to generate and transcode fixtures");

test.beforeEach(async () => {
  makeDirs();
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
    () => typeof (window as unknown as { api?: { invoke?: unknown } }).api?.invoke === "function",
    null,
    { timeout: 15_000 }
  );
  return window;
}

interface BuildOutcome {
  libId: number;
  logs: string[];
  finalLog: string;
}

/**
 * Create a shadow library and wait for its build to finish, collecting the
 * progress log page-side.
 */
async function createAndBuild(
  window: Page,
  name: string,
  shadowPath: string,
  codecName: string
): Promise<BuildOutcome> {
  return window.evaluate(
    async ({ name, shadowPath, codecName }) => {
      const api = (window as unknown as {
        api: {
          invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
          on: (channel: string, cb: (...args: unknown[]) => void) => () => void;
        };
      }).api;

      const logs: string[] = [];
      let done: (v: string) => void;
      const finished = new Promise<string>((resolve) => (done = resolve));

      const unsub = api.on("shadow:buildProgress", (...args: unknown[]) => {
        const p = args[args.length - 1] as {
          status: string;
          logMessage?: string;
        };
        if (p.logMessage) logs.push(p.logMessage);
        if (p.status === "complete" || p.status === "error" || p.status === "paused") {
          done(p.logMessage ?? "");
        }
      });

      const configs = (await api.invoke("device:getCodecConfigs")) as Array<{
        id: number;
        codec_name: string;
      }>;
      const cfg = configs.find(
        (c) => (c.codec_name ?? "").toUpperCase() === codecName
      );
      if (!cfg) throw new Error(`no ${codecName} codec configuration`);

      const created = (await api.invoke("shadow:create", {
        name,
        path: shadowPath,
        codecConfigId: cfg.id,
        vbrEnabled: false,
      })) as { id?: number; error?: string };
      if (created.error) throw new Error(`shadow:create failed: ${created.error}`);

      const finalLog = await finished;
      unsub();
      return { libId: created.id as number, logs, finalLog };
    },
    { name, shadowPath, codecName }
  );
}

/** Every file the shadow build produced, with its mtime. */
function shadowFiles(): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else if (entry.endsWith(".mp3")) out[path.relative(shadowDir, full)] = st.mtimeMs;
    }
  };
  walk(shadowDir);
  return out;
}

async function seedLibrary(window: Page): Promise<void> {
  makeSource("Artist/Album/one.flac", 2, 440);
  makeSource("Artist/Album/two.flac", 2, 660);

  await window.evaluate(async (folderPath) => {
    const api = (window as unknown as {
      api: { invoke: (c: string, ...a: unknown[]) => Promise<unknown> };
    }).api;
    const folder = { name: "E2E Recon", path: folderPath, contentType: "music" };
    await api.invoke("library:addFolder", folder);
    const scan = (await api.invoke("library:scan", { folders: [folder] })) as {
      error?: string;
    };
    if (scan?.error) throw new Error(`library:scan failed: ${scan.error}`);
  }, libraryDir);
}

test("recreating a shadow library over intact files adopts them instead of re-encoding", async () => {
  const window = await readyWindow();
  await seedLibrary(window);

  const first = await createAndBuild(window, "Recon A", shadowDir, "MP3");
  expect(first.finalLog).toContain("Build complete");

  const before = shadowFiles();
  expect(Object.keys(before)).toHaveLength(2);

  // Lose the DB rows, keep the files — exactly the reported situation.
  await window.evaluate(
    async (libId) => {
      const api = (window as unknown as {
        api: { invoke: (c: string, ...a: unknown[]) => Promise<unknown> };
      }).api;
      await api.invoke("shadow:delete", libId, /* keepFilesOnDisk */ true);
    },
    first.libId
  );
  expect(Object.keys(shadowFiles())).toHaveLength(2);

  // Recreate: same path, same codec, new name (name is UNIQUE).
  const second = await createAndBuild(window, "Recon B", shadowDir, "MP3");

  expect(second.logs.join("\n")).toMatch(/adopted/i);
  expect(second.finalLog).toContain("0 converted");

  // The proof: a re-encode would have rewritten these files.
  expect(shadowFiles()).toEqual(before);

  const libs = await window.evaluate(async () => {
    const api = (window as unknown as {
      api: { invoke: (c: string, ...a: unknown[]) => Promise<unknown> };
    }).api;
    return (await api.invoke("shadow:getAll")) as Array<{
      id: number;
      status: string;
      trackCount: number;
    }>;
  });
  const rebuilt = libs.find((l) => l.id === second.libId);
  expect(rebuilt?.status).toBe("ready");
  expect(rebuilt?.trackCount).toBe(2);
});

// `safe()` reports failures as data ({ error }), not a rejection, so a rejected
// create used to be discarded silently — the form closed and a build-progress
// modal opened for a build that never started.
test("creating a second shadow library at the same path is refused with a usable message", async () => {
  const window = await readyWindow();
  await seedLibrary(window);

  const first = await createAndBuild(window, "Dup A", shadowDir, "MP3");
  expect(first.finalLog).toContain("Build complete");

  // A real, distinct folder, so the duplicate-name attempt is rejected on the
  // name rather than on path validation.
  const otherDir = path.join(rootDir, "shadow-other");
  fs.mkdirSync(otherDir, { recursive: true });

  const result = await window.evaluate(
    async ({ shadowPath, otherPath, existingName }) => {
      const api = (window as unknown as {
        api: { invoke: (c: string, ...a: unknown[]) => Promise<unknown> };
      }).api;
      const configs = (await api.invoke("device:getCodecConfigs")) as Array<{
        id: number;
        codec_name: string;
      }>;
      const mp3 = configs.find((c) => (c.codec_name ?? "").toUpperCase() === "MP3");

      const samePath = (await api.invoke("shadow:create", {
        name: "Dup B",
        path: shadowPath,
        codecConfigId: mp3!.id,
        vbrEnabled: false,
      })) as { id?: number; error?: string };

      const sameName = (await api.invoke("shadow:create", {
        name: existingName,
        path: otherPath,
        codecConfigId: mp3!.id,
        vbrEnabled: false,
      })) as { id?: number; error?: string };

      const all = (await api.invoke("shadow:getAll")) as Array<{ id: number }>;
      return { samePath, sameName, count: all.length };
    },
    { shadowPath: shadowDir, otherPath: otherDir, existingName: "Dup A" }
  );

  expect(result.samePath.error).toBeTruthy();
  expect(result.samePath.id).toBeUndefined();
  // Names the offender and says what to do — not "UNIQUE constraint failed".
  expect(result.samePath.error).toContain("Dup A");
  expect(result.samePath.error).toMatch(/rebuild/i);
  expect(result.samePath.error).not.toMatch(/UNIQUE constraint/i);

  expect(result.sameName.error).toMatch(/already exists/i);
  expect(result.sameName.error).not.toMatch(/UNIQUE constraint/i);

  // Neither rejected attempt created anything.
  expect(result.count).toBe(1);
});

test("only the missing track is re-encoded when part of the folder is intact", async () => {
  const window = await readyWindow();
  await seedLibrary(window);

  const first = await createAndBuild(window, "Partial A", shadowDir, "MP3");
  expect(first.finalLog).toContain("Build complete");

  const before = shadowFiles();
  const names = Object.keys(before).sort();
  expect(names).toHaveLength(2);

  await window.evaluate(
    async (libId) => {
      const api = (window as unknown as {
        api: { invoke: (c: string, ...a: unknown[]) => Promise<unknown> };
      }).api;
      await api.invoke("shadow:delete", libId, true);
    },
    first.libId
  );

  // Remove one output; the other must still be adopted.
  const removed = names[0];
  const survivor = names[1];
  fs.rmSync(path.join(shadowDir, removed));

  const second = await createAndBuild(window, "Partial B", shadowDir, "MP3");

  expect(second.finalLog).toContain("1 converted");
  expect(second.logs.join("\n")).toMatch(/1 adopted/i);

  const after = shadowFiles();
  // The survivor was adopted untouched...
  expect(after[survivor]).toBe(before[survivor]);
  // ...and the deleted one was regenerated.
  expect(after[removed]).toBeDefined();
});
