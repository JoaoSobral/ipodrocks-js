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

let launched: LaunchedApp;
let rootDir: string;
let shadowDir: string;

interface ApiWindow {
  api: {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    on: (channel: string, cb: (...args: unknown[]) => void) => () => void;
  };
}

/** "MP+" SV7 magic plus filler, so the file is a plausible Musepack. */
const AUDIO = Buffer.concat([
  Buffer.from([0x4d, 0x50, 0x2b, 0x07]),
  Buffer.alloc(2048, 0xa5),
]);

/** JPEG-ish, riddled with the NUL bytes that made one item read as thousands. */
const COVER = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(96, 0x00),
  Buffer.from([0x11, 0x22, 0x00, 0x33]),
]);

function textItem(key: string, value: string): Buffer {
  const val = Buffer.from(value, "utf8");
  const head = Buffer.alloc(8);
  head.writeUInt32LE(val.byteLength, 0);
  head.writeUInt32LE(0, 4); // UTF-8 text
  return Buffer.concat([head, Buffer.from(key, "ascii"), Buffer.alloc(1, 0), val]);
}

/** The cover item exactly as the buggy writer emitted it: flags = 1. */
function legacyCoverItem(): Buffer {
  const val = Buffer.concat([Buffer.from("cover.jpg", "utf8"), Buffer.alloc(1, 0), COVER]);
  const head = Buffer.alloc(8);
  head.writeUInt32LE(val.byteLength, 0);
  head.writeUInt32LE(1, 4); // <- the defect: read-only TEXT, not binary
  return Buffer.concat([
    head,
    Buffer.from("Cover Art (Front)", "ascii"),
    Buffer.alloc(1, 0),
    val,
  ]);
}

/** Write an .mpc with the pre-fix tag: artwork ahead of the ReplayGain items. */
function writeLegacyMpc(filePath: string): void {
  const items = [
    textItem("Title", "Legacy Track"),
    legacyCoverItem(),
    textItem("REPLAYGAIN_TRACK_GAIN", "-3.38 dB"),
    textItem("REPLAYGAIN_ALBUM_GAIN", "-4.10 dB"),
  ];
  const body = Buffer.concat(items);
  const tagSize = body.byteLength + 32;

  const head = (isHeader: boolean): Buffer => {
    const buf = Buffer.alloc(32, 0);
    buf.write("APETAGEX", 0, "ascii");
    buf.writeUInt32LE(2000, 8);
    buf.writeUInt32LE(tagSize, 12);
    buf.writeUInt32LE(items.length, 16);
    let flags = (1 << 31) | (1 << 30);
    if (isHeader) flags |= 1 << 29;
    buf.writeUInt32LE(flags >>> 0, 20);
    return buf;
  };

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.concat([AUDIO, head(true), body, head(false)]));
}

/** Byte offset of an APEv2 item's key, and the flags word that precedes it. */
function itemFlags(file: Buffer, key: string): number {
  const at = file.indexOf(Buffer.from(`${key}\0`, "ascii"));
  if (at < 0) throw new Error(`item "${key}" not found`);
  return file.readUInt32LE(at - 4);
}

function itemOffset(file: Buffer, key: string): number {
  const at = file.indexOf(Buffer.from(`${key}\0`, "ascii"));
  if (at < 0) throw new Error(`item "${key}" not found`);
  return at;
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

  // The defect is gone: the artwork is a binary item, and never read-only.
  expect(itemFlags(after, "Cover Art (Front)")).toBe(2);

  // ReplayGain now sits ahead of the artwork, where a bounded reader reaches it.
  expect(itemOffset(after, "REPLAYGAIN_TRACK_GAIN")).toBeLessThan(
    itemOffset(after, "Cover Art (Front)")
  );

  // The image survives byte for byte, and so does the audio.
  expect(after.includes(COVER)).toBe(true);
  expect(after.subarray(0, AUDIO.byteLength).equals(AUDIO)).toBe(true);

  // Same size and same mtime, so nothing re-transcodes or re-syncs. Compared
  // at whole-millisecond resolution because that is what reads it:
  // `shadow_tracks.mtime` stores `Math.floor(mtimeMs)`, and restoring through
  // `utimes` drops any fractional millisecond the original had.
  const afterStat = fs.statSync(broken);
  expect(afterStat.size).toBe(beforeStat.size);
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
