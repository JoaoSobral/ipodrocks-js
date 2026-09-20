/**
 * Playwright E2E — the existing UI works over the HTTP transport, unchanged.
 *
 * The premise the whole web mode rests on is that `window.api` is the only
 * seam: the preload exposes `{ platform, invoke, on, off }`, `ipc/api.ts`
 * holds 119 of the app's 124 references to it, and a transport of the same
 * shape carries the UI across. This spec is what stops that from being an
 * assumption — it drives the real React app in a real browser page, served by
 * the real daemon, with no Electron anywhere.
 *
 * The progress-event half matters most. Over IPC a handler pushes with
 * `event.sender.send`; over the web that has to travel the WebSocket, reach the
 * session that made the call, and arrive at the same `api.on(...)` subscription
 * the desktop uses. Every part of that is new code.
 *
 * Run with: `npm run build && npx playwright test --project=web`
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { test, expect } from "@playwright/test";
import { invoke, signIn } from "./web-harness";

interface ApiWindow {
  api: {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    on: (channel: string, cb: (...args: unknown[]) => void) => () => void;
  };
}

let seedDir: string;

test.beforeAll(() => {
  // Under the home directory, because `validateFolderPath()` gates library
  // folders on the same prefix allowlist over HTTP as it does over IPC.
  seedDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-web-"));
  const album = path.join(seedDir, "Parity Artist", "Parity Album");
  fs.mkdirSync(album, { recursive: true });
  for (const name of ["01 One.mp3", "02 Two.mp3", "03 Three.mp3"]) {
    fs.writeFileSync(path.join(album, name), Buffer.from("not-real-audio-bytes"));
  }
});

test.afterAll(() => {
  try {
    fs.rmSync(seedDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test.beforeEach(async ({ page, request }) => {
  // `page.request` and the standalone `request` fixture are separate contexts
  // with separate cookie jars, and this file uses both — a page for the real
  // React app, and a bare API context for the channel round-trips.
  await signIn(request);
  await signIn(page.request);
});

test("the app boots in a browser against the daemon", async ({ page }) => {
  await page.goto("/");
  // If the transport failed to install, the bootstrap renders the login screen
  // or the startup error instead — so reaching the app shell is the assertion.
  await expect(page.locator("#root")).not.toBeEmpty();
  await expect(page.getByText("iPodRocks could not start")).toHaveCount(0);

  const shape = await page.evaluate(() => {
    const api = (window as unknown as ApiWindow).api as unknown as Record<
      string,
      unknown
    >;
    return {
      hasInvoke: typeof api?.invoke === "function",
      hasOn: typeof api?.on === "function",
      hasOff: typeof api?.off === "function",
      hasPlatform: typeof api?.platform === "string",
    };
  });
  // The same four members the preload exposes. A transport that is missing one
  // fails somewhere far from here, in whichever panel happens to use it.
  expect(shape).toEqual({
    hasInvoke: true,
    hasOn: true,
    hasOff: true,
    hasPlatform: true,
  });
});

test("a library scan runs and reports progress over the WebSocket", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#root")).not.toBeEmpty();

  const outcome = await page.evaluate(async (folderPath) => {
    const api = (window as unknown as ApiWindow).api;
    const frames: unknown[] = [];
    const off = api.on("scan:progress", (...args) => frames.push(args[0]));
    const result = (await api.invoke("library:scan", {
      folders: [
        { name: "E2E Web Parity", path: folderPath, contentType: "music" },
      ],
    })) as { filesAdded?: number; error?: string };
    off();
    return { result, frameCount: frames.length };
  }, seedDir);

  expect(outcome.result.error).toBeUndefined();
  expect(outcome.result.filesAdded).toBe(3);
  // The push channel is the part that is genuinely new; a scan that reports
  // nothing would leave every progress bar in the app frozen.
  expect(outcome.frameCount).toBeGreaterThan(0);
});

test("library reads and playlist CRUD round-trip over /api/invoke", async ({
  request,
}) => {
  const tracks = await invoke<{ id: number; path: string }[]>(
    request,
    "library:getTracks",
    { contentType: "music" }
  );
  expect(tracks.length).toBeGreaterThanOrEqual(3);

  const created = await invoke<{ id: number; trackCount: number; error?: string }>(
    request,
    "playlist:createClassic",
    { name: "Web Parity Playlist", trackIds: tracks.slice(0, 2).map((t) => t.id) }
  );
  expect(created.error).toBeUndefined();
  expect(created.trackCount).toBe(2);

  // Matched by id, not by name: `createClassicPlaylist` stores it prefixed
  // (`classic_…`), and asserting on the display name would be testing the
  // naming convention rather than the transport.
  const playlists = await invoke<{ id: number }[]>(request, "playlist:list");
  expect(playlists.some((p) => p.id === created.id)).toBe(true);

  await invoke(request, "playlist:delete", created.id);
  const after = await invoke<{ id: number }[]>(request, "playlist:list");
  expect(after.some((p) => p.id === created.id)).toBe(false);
});

test("settings written over the web are the same settings the app reads", async ({
  request,
}) => {
  const before = await invoke<{ tagRatingAlwaysWins?: boolean }>(
    request,
    "settings:getRatingPrefs"
  );
  await invoke(request, "settings:setRatingPrefs", {
    tagRatingAlwaysWins: !(before.tagRatingAlwaysWins ?? false),
  });
  const after = await invoke<{ tagRatingAlwaysWins?: boolean }>(
    request,
    "settings:getRatingPrefs"
  );
  expect(after.tagRatingAlwaysWins).toBe(!(before.tagRatingAlwaysWins ?? false));

  // Put it back; the daemon is shared by every spec in this project.
  await invoke(request, "settings:setRatingPrefs", {
    tagRatingAlwaysWins: before.tagRatingAlwaysWins ?? false,
  });
});

test("the server answers dialog:pickFolder with a directory browser instead", async ({
  request,
}) => {
  // There is no screen on the daemon, so the native sheet is unavailable and
  // the web UI browses the *server's* filesystem — library folders genuinely
  // live there, unlike the device, which is the browser's.
  const dialogs = await invoke<{ available: boolean }>(
    request,
    "app:hasNativeDialogs"
  );
  expect(dialogs.available).toBe(false);

  const listing = await invoke<{
    path: string;
    entries: { name: string; path: string }[];
    roots: { name: string; path: string }[];
    error?: string;
  }>(request, "app:listDirectory", seedDir);

  expect(listing.error).toBeUndefined();
  expect(listing.entries.map((e) => e.name)).toContain("Parity Artist");
  expect(listing.roots.length).toBeGreaterThan(0);

  // And it refuses a path the user could not then add as a library folder.
  const refused = await invoke<{ error?: string }>(
    request,
    "app:listDirectory",
    "/etc"
  );
  expect(refused.error).toBeTruthy();
});

test("the web folder picker browses the server and fills the form", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#root")).not.toBeEmpty();

  await page.getByRole("button", { name: "Library" }).first().click();
  await page.getByRole("button", { name: "+ Add Folder" }).first().click();
  await page.getByRole("button", { name: "Browse" }).first().click();

  // `pickFolder()` resolved to the server browser rather than throwing at a
  // native sheet the daemon cannot show. The three panels that call it were
  // not changed for this — the fallback is registered at the api layer.
  const picker = page.getByRole("dialog").filter({
    hasText: "Choose a folder on the server",
  });
  await expect(picker).toBeVisible();
  await expect(picker).toContainText(
    "These are folders on the machine running iPodRocks"
  );

  // It starts at the server's home directory.
  await expect(picker.getByRole("button", { name: "Home" })).toBeVisible();

  // Typed rather than clicked: the listing hides dot-directories, and this
  // spec's fixture is one (the e2e suite keeps its scratch folders hidden).
  // The path field is what a user with a library in a hidden or deeply nested
  // folder uses, so it is worth driving.
  await picker.getByPlaceholder("/path/on/the/server").fill(seedDir);
  await picker.getByRole("button", { name: "Go", exact: true }).click();
  await expect(picker).toContainText("Parity Artist");

  await picker.getByRole("button", { name: "Choose this folder" }).click();
  await expect(picker).toBeHidden();
  await expect(page.locator("#folder-path")).toHaveValue(seedDir);
});
