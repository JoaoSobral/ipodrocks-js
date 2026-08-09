/**
 * E2E — a shadow library whose codec configuration was lost (e.g. across a
 * downgrade/upgrade round trip that dropped or renumbered codec_configurations
 * rows) must not vanish from the app or silently block recreation.
 *
 * Before this fix, getShadowLibraries() INNER JOINed against
 * codec_configurations/codecs, so a row whose codec_config_id no longer
 * resolved was invisible everywhere that query was used — the Library panel,
 * and the shadow:create duplicate-name/path check. The row's raw
 * shadow_libraries.name / .path UNIQUE constraints still blocked new
 * libraries though, so recreating one at the same folder or name threw the
 * raw "UNIQUE constraint failed: shadow_libraries.path" (or .name) SQLite
 * error instead of the friendly message added for the ordinary duplicate
 * case (see the reported bug: https://github.com/JoaoSobral/ipodrocks-js/issues/105).
 *
 * This test creates a healthy shadow library through the real IPC surface,
 * then corrupts its codec_config_id directly in the on-disk db (simulating
 * the orphaning) to verify: the row still shows up (flagged), duplicate
 * name/path attempts get the friendly message, rebuild refuses cleanly
 * instead of failing silently, and delete — the actual fix — still works.
 *
 * Run: npm run build && npx playwright test tests/e2e/shadow-orphaned-codec-config.test.ts
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Database from "better-sqlite3";
import { test, expect, type Page } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./electron-launcher";

let launched: LaunchedApp;
let rootDir: string;
let shadowDir: string;

function makeDirs(): void {
  rootDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-shadow-orphan-"));
  shadowDir = path.join(rootDir, "shadow");
  fs.mkdirSync(shadowDir, { recursive: true });
}

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

/** Create a shadow library over an empty (no-track) library and wait for its build to finish. */
async function createEmptyShadowLib(
  window: Page,
  name: string,
  shadowPath: string
): Promise<number> {
  return window.evaluate(
    async ({ name, shadowPath }) => {
      const api = (window as unknown as {
        api: {
          invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
          on: (channel: string, cb: (...args: unknown[]) => void) => () => void;
        };
      }).api;

      let done: () => void;
      const finished = new Promise<void>((resolve) => (done = resolve));
      const unsub = api.on("shadow:buildProgress", (...args: unknown[]) => {
        const p = args[args.length - 1] as { status: string };
        if (p.status === "complete" || p.status === "error" || p.status === "paused") {
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
        name,
        path: shadowPath,
        codecConfigId: mp3.id,
        vbrEnabled: false,
      })) as { id?: number; error?: string };
      if (created.error) throw new Error(`shadow:create failed: ${created.error}`);

      await finished;
      unsub();
      return created.id as number;
    },
    { name, shadowPath }
  );
}

/**
 * Corrupt the row's codec_config_id directly in the on-disk db, the same
 * failure mode a lost/renumbered codec_configurations row produces — the app
 * must be closed to nothing else while the file is open in WAL mode, so a
 * short-lived second connection is safe here.
 */
function orphanCodecConfig(userDataDir: string, shadowLibId: number): void {
  const dbPath = path.join(userDataDir, "ipodrock.db");
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 5000");
  db.prepare("UPDATE shadow_libraries SET codec_config_id = ? WHERE id = ?").run(
    999999,
    shadowLibId
  );
  db.close();
}

interface ShadowLibDto {
  id: number;
  name: string;
  path: string;
  status: string;
  codecConfigMissing: boolean;
  codecConfigName: string | null;
  codecName: string | null;
}

test("a shadow library with a lost codec config stays visible, blocks duplicates cleanly, refuses rebuild, and can still be deleted", async () => {
  const window = await readyWindow();

  const libId = await createEmptyShadowLib(window, "Orphan Source", shadowDir);
  orphanCodecConfig(launched.userDataDir, libId);

  // 1. Still visible — not silently dropped by the codec-config join — and
  //    flagged so the UI/Rocksy can explain what happened.
  const afterOrphan = await window.evaluate(async () => {
    const api = (window as unknown as {
      api: { invoke: (c: string, ...a: unknown[]) => Promise<unknown> };
    }).api;
    return (await api.invoke("shadow:getAll")) as ShadowLibDto[];
  });
  const orphan = afterOrphan.find((l) => l.id === libId);
  expect(orphan).toBeDefined();
  expect(orphan?.codecConfigMissing).toBe(true);
  expect(orphan?.codecConfigName).toBeNull();
  expect(orphan?.codecName).toBeNull();
  expect(orphan?.name).toBe("Orphan Source");

  // 2. A new shadow library at the same folder is refused with a usable
  //    message — not the raw SQLite constraint error the reporter hit.
  const otherDir = path.join(rootDir, "shadow-other");
  fs.mkdirSync(otherDir, { recursive: true });

  const dupResult = await window.evaluate(
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
        name: "Orphan Dup",
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

      return { samePath, sameName };
    },
    { shadowPath: shadowDir, otherPath: otherDir, existingName: "Orphan Source" }
  );

  expect(dupResult.samePath.error).toBeTruthy();
  expect(dupResult.samePath.id).toBeUndefined();
  expect(dupResult.samePath.error).toContain("Orphan Source");
  expect(dupResult.samePath.error).not.toMatch(/UNIQUE constraint/i);

  expect(dupResult.sameName.error).toMatch(/already exists/i);
  expect(dupResult.sameName.error).not.toMatch(/UNIQUE constraint/i);

  // 3. Rebuild refuses up front with a clear reason instead of failing
  //    silently (the promise used to just be console.error'd).
  const rebuildResult = await window.evaluate(async (id) => {
    const api = (window as unknown as {
      api: { invoke: (c: string, ...a: unknown[]) => Promise<unknown> };
    }).api;
    return (await api.invoke("shadow:rebuild", id)) as {
      started?: boolean;
      error?: string;
    };
  }, libId);
  expect(rebuildResult.started).toBeUndefined();
  expect(rebuildResult.error).toMatch(/lost its codec configuration/i);
  expect(rebuildResult.error).toMatch(/can't be rebuilt/i);

  // 4. The actual fix: delete still works, freeing the name/path.
  const deleteResult = await window.evaluate(async (id) => {
    const api = (window as unknown as {
      api: { invoke: (c: string, ...a: unknown[]) => Promise<unknown> };
    }).api;
    return (await api.invoke("shadow:delete", id, /* keepFilesOnDisk */ true)) as boolean;
  }, libId);
  expect(deleteResult).toBe(true);

  const afterDelete = await window.evaluate(async () => {
    const api = (window as unknown as {
      api: { invoke: (c: string, ...a: unknown[]) => Promise<unknown> };
    }).api;
    return (await api.invoke("shadow:getAll")) as ShadowLibDto[];
  });
  expect(afterDelete.find((l) => l.id === libId)).toBeUndefined();

  // 5. And recreating at the same folder now succeeds — the escape hatch
  //    this whole fix exists to restore.
  const recreated = await createEmptyShadowLib(window, "Orphan Source", shadowDir);
  expect(recreated).toBeGreaterThan(0);
});
