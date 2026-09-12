/**
 * E2E — Settings → Maintenance → Repair Musepack tags (issue #125).
 *
 * Versions before 2.3.2 wrote the APEv2 cover-art item with the type bits
 * spelling "read-only UTF-8 text". Tag editors split the JPEG on its NUL bytes
 * into hundreds of empty "Cover Art" values, and Rockbox's bounded tag buffer
 * was consumed before it reached the REPLAYGAIN_* items that followed. The
 * Settings action is the one-shot repair for files already on disk.
 *
 * Drives the real built app: creates a shadow library, plants .mpc files
 * carrying the legacy broken tag in its folder, opens the gear and clicks the
 * button, then reads the bytes back off disk.
 *
 * Only what needs the real app lives here — the Settings card, the progress
 * modal and the renderer → preload → main round trip. The tag surgery itself is
 * pure and is covered in
 * src/__tests__/regressions/mpc-cover-art-item-flags.test.ts.
 *
 * Run: npm run build && npx playwright test tests/e2e/mpc-tag-repair.test.ts
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
  rootDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-mpcrepair-"));
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

/** Register a shadow library over `shadowPath` so the repair pass walks it. */
async function createShadowLib(window: Page, shadowPath: string): Promise<void> {
  await window.evaluate(async (p) => {
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
      name: `Repair ${Date.now()}`,
      path: p,
      codecConfigId: mp3.id,
      vbrEnabled: false,
    })) as { id?: number; error?: string };
    if (created.error) throw new Error(`shadow:create failed: ${created.error}`);

    await finished;
    unsub();
  }, shadowPath);
}

test("the Settings action repairs Musepack files already in a shadow library", async () => {
  const window = await readyWindow();
  await createShadowLib(window, shadowDir);

  const broken = path.join(shadowDir, "Artist", "Album", "01 - Legacy.mpc");
  writeLegacyMpc(broken);
  // A file the repair has no business touching.
  const untouched = path.join(shadowDir, "Artist", "Album", "notes.txt");
  fs.writeFileSync(untouched, "leave me alone");

  const before = fs.readFileSync(broken);
  const beforeStat = fs.statSync(broken);
  expect(itemFlags(before, "Cover Art (Front)")).toBe(1);

  // Drive the real affordance: the gear, the Maintenance card, the modal.
  await window.getByRole("button", { name: "Settings" }).click();
  await window
    .getByRole("button", { name: "Repair Musepack tags" })
    .click({ timeout: 10_000 });

  // The modal is not dismissable while running; Done appears when it finishes.
  const done = window.getByRole("button", { name: "Done" });
  await done.waitFor({ timeout: 30_000 });

  await expect(window.getByTestId("mpc-repair-repaired")).toHaveText("1 repaired");
  await expect(window.getByTestId("mpc-repair-scanned")).toHaveText("1 checked");
  await done.click();

  const after = fs.readFileSync(broken);

  // The artwork is gone outright — iPodRocks no longer embeds any, so the
  // repair removes what earlier versions put there (#130). That is what the
  // reporter's 1500x1500 covers inside every track became.
  expect(after.includes(COVER)).toBe(false);
  expect(() => itemOffset(after, "Cover Art (Front)")).toThrow();

  // ReplayGain and the ordinary tags survive, and so does the audio.
  expect(itemOffset(after, "REPLAYGAIN_TRACK_GAIN")).toBeGreaterThan(0);
  expect(itemOffset(after, "Title")).toBeGreaterThan(0);
  expect(after.subarray(0, AUDIO.byteLength).equals(AUDIO)).toBe(true);

  // The file is smaller — the image came out — but the mtime is unchanged.
  // Compared at whole-millisecond resolution because that is what reads it:
  // `shadow_tracks.mtime` stores `Math.floor(mtimeMs)`, and restoring through
  // `utimes` drops any fractional millisecond the original had.
  const afterStat = fs.statSync(broken);
  expect(afterStat.size).toBeLessThan(beforeStat.size);
  expect(Math.floor(afterStat.mtimeMs)).toBe(Math.floor(beforeStat.mtimeMs));

  // Nothing else in the folder was touched.
  expect(fs.readFileSync(untouched, "utf8")).toBe("leave me alone");
});

test("a second run reports nothing left to repair", async () => {
  const window = await readyWindow();
  await createShadowLib(window, shadowDir);
  writeLegacyMpc(path.join(shadowDir, "Artist", "Album", "01 - Legacy.mpc"));

  const runRepair = () =>
    window.evaluate(
      async () =>
        (await (window as unknown as ApiWindow).api.invoke(
          "maintenance:repairMpcTags"
        )) as { scanned: number; repaired: number; failed: number }
    );

  expect(await runRepair()).toMatchObject({ scanned: 1, repaired: 1, failed: 0 });
  expect(await runRepair()).toMatchObject({ scanned: 1, repaired: 0, failed: 0 });
});
