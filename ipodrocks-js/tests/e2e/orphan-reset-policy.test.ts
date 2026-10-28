/**
 * E2E — the Sync tab's "Orphan & Reset Policy" and its confirmation gate.
 *
 * The section used to be called "Orphan Policy" and its most destructive option
 * "Remove all", which only swept orphans and unlinked the auto-podcast and
 * extra-audiobook files iPodRocks had recorded. "Delete all" replaces it and is
 * genuinely destructive — it erases the device's Music, Podcasts and Audiobooks
 * folders and rebuilds them — so nothing may reach a sync without the user
 * confirming it first. That gate is what this test exists to prove.
 *
 * The sweeping and erasing behaviour itself runs against a real tmp device in
 * src/__tests__/behaviors/orphan-reset-policy.test.ts, and the folder guard in
 * src/__tests__/regressions/delete-all-path-guard.test.ts. Here: the
 * affordance, and one confirmed reset end to end — the local reset swaps each
 * folder aside and deletes it in the background, and the sync must not report
 * done while that trash is still on the device.
 *
 * Run: npm run build && npx playwright test tests/e2e/orphan-reset-policy.test.ts
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { test, expect, type Page } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./electron-launcher";

let launched: LaunchedApp;
let rootDir: string;
let mountPath: string;
let libraryDir: string;

interface ApiWindow {
  api: {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  };
}

/** A real 1-second FLAC, so the library scan has something to index. */
function seedTrack(fileName: string): boolean {
  const out = path.join(libraryDir, fileName);
  const res = spawnSync(
    "ffmpeg",
    [
      "-y", "-v", "quiet", "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono", "-t", "1",
      "-metadata", "title=E2E Orphan Policy Track",
      "-metadata", "artist=E2E Orphan Artist",
      "-metadata", "album=E2E Orphan Album",
      out,
    ],
    { encoding: "utf8" }
  );
  return res.status === 0 && fs.existsSync(out);
}

test.beforeEach(async () => {
  rootDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-orphan-"));
  mountPath = path.join(rootDir, "device");
  libraryDir = path.join(rootDir, "library");
  fs.mkdirSync(libraryDir, { recursive: true });
  for (const dir of ["Music", "Podcasts", "Audiobooks", "Playlists"]) {
    fs.mkdirSync(path.join(mountPath, dir), { recursive: true });
  }
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

/** Add a library folder and scan it, so the pre-sync "empty library" check passes. */
async function scanLibrary(window: Page): Promise<void> {
  await window.evaluate(async (folder) => {
    const api = (window as unknown as ApiWindow).api;
    await api.invoke("library:addFolder", {
      name: "E2E Orphan Seed",
      path: folder,
      contentType: "music",
    });
    await api.invoke("library:scan", {
      folders: [{ name: "E2E Orphan Seed", path: folder, contentType: "music" }],
    });
  }, libraryDir);
}

async function addDevice(window: Page, mount: string): Promise<number> {
  return window.evaluate(async (m) => {
    const created = (await (window as unknown as ApiWindow).api.invoke("device:add", {
      name: "GateDevice",
      mountPath: m,
    })) as { id?: number; error?: string };
    if (created.error) throw new Error(`device:add failed: ${created.error}`);
    return created.id as number;
  }, mount);
}

/**
 * The policy dropdown's trigger. Matched as a direct child of the Select
 * container: the label's InfoTooltip is also a button, but it sits nested
 * inside the <Label>, so `> button` picks out the trigger unambiguously.
 */
function policySelect(window: Page) {
  return window.getByTestId("orphan-reset-policy").locator("> button");
}

test("the section is named Orphan & Reset Policy and offers Delete all", async () => {
  const window = await readyWindow();
  await addDevice(window, mountPath);

  await window.getByRole("button", { name: "Sync", exact: true }).click();
  await expect(
    window.getByText("Orphan & Reset Policy", { exact: true })
  ).toBeVisible({ timeout: 10_000 });

  await policySelect(window).click();
  const options = window.getByRole("option");
  await expect(options).toHaveCount(4);
  await expect(options).toHaveText([
    "Keep",
    "Remove orphans",
    "Delete all",
    "Prompt",
  ]);
});

test("choosing Delete all confirms before anything is erased", async () => {
  // The Start Sync pre-check refuses an empty library before any policy runs,
  // so the gate can only be reached with something actually in the library.
  test.skip(!seedTrack("track.flac"), "ffmpeg unavailable — cannot seed a library");

  const window = await readyWindow();
  await scanLibrary(window);
  await addDevice(window, mountPath);

  // Plant a file that a wipe would take with it, so "nothing was deleted" is a
  // claim about the disk and not just about which modal appeared.
  const planted = path.join(mountPath, "Podcasts", "Show", "episode.mp3");
  fs.mkdirSync(path.dirname(planted), { recursive: true });
  fs.writeFileSync(planted, "keep me until confirmed");

  await window.getByRole("button", { name: "Sync", exact: true }).click();
  await expect(
    window.getByText("Orphan & Reset Policy", { exact: true })
  ).toBeVisible({ timeout: 10_000 });

  await policySelect(window).click();
  await window.getByRole("option", { name: "Delete all" }).click();

  await window.getByRole("button", { name: "Start Sync" }).click();

  // The gate, not the sync.
  await expect(
    window.getByText("Erase and rebuild this device?")
  ).toBeVisible({ timeout: 10_000 });
  expect(fs.existsSync(planted)).toBe(true);

  // Backing out leaves the device exactly as it was.
  await window.getByRole("button", { name: "Cancel" }).click();
  await expect(window.getByText("Erase and rebuild this device?")).toBeHidden();
  expect(fs.readFileSync(planted, "utf8")).toBe("keep me until confirmed");
});

test("confirming Delete all erases the device, rebuilds it, and leaves no trash behind", async () => {
  test.skip(!seedTrack("track.flac"), "ffmpeg unavailable — cannot seed a library");

  const window = await readyWindow();
  await scanLibrary(window);
  await addDevice(window, mountPath);

  // A full folder the reset has to take with it. On a local device the reset
  // renames each content folder aside, recreates it empty at once, and deletes
  // the old one while the copy runs — so a hidden trash folder exists for a
  // while and must be gone by the time the sync says it is done.
  for (let i = 0; i < 50; i++) {
    const p = path.join(mountPath, "Music", `Old ${i % 5}`, `${i}.mp3`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "old");
  }
  const planted = path.join(mountPath, "Podcasts", "Show", "episode.mp3");
  fs.mkdirSync(path.dirname(planted), { recursive: true });
  fs.writeFileSync(planted, "erase me");

  await window.getByRole("button", { name: "Sync", exact: true }).click();
  await expect(
    window.getByText("Orphan & Reset Policy", { exact: true })
  ).toBeVisible({ timeout: 10_000 });
  await policySelect(window).click();
  await window.getByRole("option", { name: "Delete all" }).click();
  await window.getByRole("button", { name: "Start Sync" }).click();
  await window.getByRole("button", { name: "Erase and rebuild" }).click();

  const dialog = window.getByRole("dialog").filter({ hasText: "Syncing to Device" });
  await expect(dialog.getByRole("button", { name: "Close" })).toBeVisible({ timeout: 30_000 });

  expect(fs.existsSync(planted)).toBe(false);
  const music = fs.readdirSync(path.join(mountPath, "Music"), { recursive: true }) as string[];
  expect(music.some((p) => p.startsWith("Old "))).toBe(false);
  expect(music.some((p) => p.endsWith(".flac"))).toBe(true);
  expect(fs.readdirSync(mountPath).filter((n) => n.startsWith(".ipodrocks-trash-"))).toEqual([]);
});

test("a new device defaults to Keep, and Keep syncs with no warning", async () => {
  test.skip(!seedTrack("track.flac"), "ffmpeg unavailable — cannot seed a library");

  const window = await readyWindow();
  await scanLibrary(window);
  const deviceId = await addDevice(window, mountPath);

  // A device that has never synced has no saved preferences, so the panel's
  // own default is what applies — and that must be Keep.
  const stored = (await window.evaluate(async (id) => {
    return (window as unknown as ApiWindow).api.invoke("sync:getDevicePreferences", id);
  }, deviceId)) as { extraTrackPolicy?: string } | null;
  expect(stored?.extraTrackPolicy ?? "keep").toBe("keep");

  await window.getByRole("button", { name: "Sync", exact: true }).click();
  await expect(policySelect(window)).toHaveText(/Keep/, { timeout: 10_000 });

  await window.getByRole("button", { name: "Start Sync" }).click();
  await expect(window.getByTestId("orphan-policy-gate")).toHaveCount(0);
  const dialog = window.getByRole("dialog").filter({ hasText: "Syncing to Device" });
  await expect(dialog.getByRole("button", { name: "Close" })).toBeVisible({ timeout: 30_000 });
});

for (const { option, title, warns } of [
  { option: "Remove orphans", title: "Remove what is not in this sync?", warns: /deleted from the device/ },
  { option: "Prompt", title: "Report what does not match?", warns: /nothing is deleted/ },
]) {
  test(`choosing ${option} warns, and holds OK for two seconds`, async () => {
    test.skip(!seedTrack("track.flac"), "ffmpeg unavailable — cannot seed a library");

    const window = await readyWindow();
    await scanLibrary(window);
    await addDevice(window, mountPath);

    // An orphan the Remove policy would take, so "nothing happened yet" is a
    // claim about the disk.
    const planted = path.join(mountPath, "Music", "Not In Library", "stray.mp3");
    fs.mkdirSync(path.dirname(planted), { recursive: true });
    fs.writeFileSync(planted, "stray");

    await window.getByRole("button", { name: "Sync", exact: true }).click();
    await expect(
      window.getByText("Orphan & Reset Policy", { exact: true })
    ).toBeVisible({ timeout: 10_000 });
    await policySelect(window).click();
    await window.getByRole("option", { name: option }).click();
    await window.getByRole("button", { name: "Start Sync" }).click();

    const gate = window.getByTestId("orphan-policy-gate");
    await expect(gate).toBeVisible({ timeout: 10_000 });
    await expect(window.getByText(title)).toBeVisible();
    await expect(gate).toContainText(warns);

    // The OK is held, then released.
    const confirm = window.getByTestId("orphan-policy-gate-confirm");
    await expect(confirm).toBeDisabled();
    await expect(confirm).toBeEnabled({ timeout: 5_000 });
    expect(fs.existsSync(planted)).toBe(true);

    // Cancel leaves the device alone; reopening restarts the countdown.
    await gate.getByRole("button", { name: "Cancel" }).click();
    await expect(gate).toHaveCount(0);
    await window.getByRole("button", { name: "Start Sync" }).click();
    await expect(confirm).toBeDisabled();
    await expect(confirm).toBeEnabled({ timeout: 5_000 });
    await confirm.click();

    const dialog = window.getByRole("dialog").filter({ hasText: "Syncing to Device" });
    await expect(dialog.getByRole("button", { name: "Close" })).toBeVisible({ timeout: 30_000 });
    expect(fs.existsSync(planted)).toBe(option === "Prompt");
  });
}

test("'do not show this warning again' is remembered per device, and never skips Delete all", async () => {
  test.skip(!seedTrack("track.flac"), "ffmpeg unavailable — cannot seed a library");

  const window = await readyWindow();
  await scanLibrary(window);
  const deviceId = await addDevice(window, mountPath);

  const closeSync = async () => {
    const dialog = window.getByRole("dialog").filter({ hasText: "Syncing to Device" });
    await expect(dialog.getByRole("button", { name: "Close" })).toBeVisible({ timeout: 30_000 });
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toHaveCount(0);
  };

  await window.getByRole("button", { name: "Sync", exact: true }).click();
  await expect(
    window.getByText("Orphan & Reset Policy", { exact: true })
  ).toBeVisible({ timeout: 10_000 });
  await policySelect(window).click();
  await window.getByRole("option", { name: "Prompt" }).click();

  // Tick the box and confirm.
  await window.getByRole("button", { name: "Start Sync" }).click();
  const gate = window.getByTestId("orphan-policy-gate");
  await expect(gate).toBeVisible({ timeout: 10_000 });
  await window.getByTestId("orphan-policy-gate-dont-show").check();
  await window.getByTestId("orphan-policy-gate-confirm").click();
  await closeSync();

  // Stored against the device, not just held in the panel.
  const stored = (await window.evaluate(async (id) => {
    return (window as unknown as ApiWindow).api.invoke("sync:getDevicePreferences", id);
  }, deviceId)) as { hideOrphanWarning?: boolean } | null;
  expect(stored?.hideOrphanWarning).toBe(true);

  // A second device is unaffected.
  const otherMount = path.join(rootDir, "device-2");
  fs.mkdirSync(path.join(otherMount, "Music"), { recursive: true });
  const otherId = await window.evaluate(async (m) => {
    const created = (await (window as unknown as ApiWindow).api.invoke("device:add", {
      name: "OtherDevice",
      mountPath: m,
    })) as { id?: number };
    return created.id as number;
  }, otherMount);
  const otherStored = (await window.evaluate(async (id) => {
    return (window as unknown as ApiWindow).api.invoke("sync:getDevicePreferences", id);
  }, otherId)) as { hideOrphanWarning?: boolean } | null;
  expect(otherStored?.hideOrphanWarning ?? false).toBe(false);

  // Remove orphans now goes straight to the sync for this device.
  await policySelect(window).click();
  await window.getByRole("option", { name: "Remove orphans" }).click();
  await expect(window.getByTestId("orphan-warning-hidden")).toBeVisible();
  await window.getByRole("button", { name: "Start Sync" }).click();
  await expect(gate).toHaveCount(0);
  await closeSync();

  // Delete all is still confirmed, and offers no box.
  await policySelect(window).click();
  await window.getByRole("option", { name: "Delete all" }).click();
  await window.getByRole("button", { name: "Start Sync" }).click();
  await expect(window.getByText("Erase and rebuild this device?")).toBeVisible({ timeout: 10_000 });
  await expect(window.getByTestId("orphan-policy-gate-dont-show")).toHaveCount(0);
  await gate.getByRole("button", { name: "Cancel" }).click();

  // "Show it again" brings the warning back.
  await policySelect(window).click();
  await window.getByRole("option", { name: "Prompt" }).click();
  await window.getByTestId("orphan-warning-hidden").getByRole("button", { name: "Show it again" }).click();
  await expect(window.getByTestId("orphan-warning-hidden")).toHaveCount(0);
  await window.getByRole("button", { name: "Start Sync" }).click();
  await expect(gate).toBeVisible({ timeout: 10_000 });
  const reset = (await window.evaluate(async (id) => {
    return (window as unknown as ApiWindow).api.invoke("sync:getDevicePreferences", id);
  }, deviceId)) as { hideOrphanWarning?: boolean } | null;
  expect(reset?.hideOrphanWarning).toBe(false);
});
