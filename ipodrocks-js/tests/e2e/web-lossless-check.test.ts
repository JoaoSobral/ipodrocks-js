/**
 * Playwright E2E — the lossless check over the web server.
 *
 * Against the real daemon (Node host, no desktop):
 *
 * - The owner runs the check through `/api/invoke`, which outlives the
 *   invoke defer deadline and so goes through the 202/long-poll path, and gets
 *   the same verdicts the desktop does.
 * - **A signed-in guest is refused** every mutation — start, overrule, delete —
 *   while reading the report stays open, like every library read. Control: the
 *   guest's ordinary channel works, so the refusals are not blanket.
 * - **The daemon has no Trash**: `lossless:hostHasTrash` says so (the modal words
 *   its confirm on it) and a delete is permanent — the file is gone from disk.
 *
 * The rendered modal and the background chip are covered by the electron
 * project's `lossless-check.test.ts`; the guards in isolation by
 * `regressions/lossless-ipc-guards.test.ts`.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { test, expect, request as playwrightRequest } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { WEB_ORIGIN, invoke, signIn } from "./web-harness";

test.describe.configure({ mode: "serial" });

const GUEST_USERNAME = "e2e-lossless-guest";
const GUEST_PASSWORD = "a-perfectly-fine-lossless-password";
const FOLDER_NAME = "E2E Web Lossless";

interface Identity {
  id: number;
  subject: string;
}
interface ReportRow {
  trackId: number;
  title: string;
  path: string;
  verdict: string;
  source: string | null;
}

let libraryDir = "";
let fixturesOk = false;
let guest: APIRequestContext;

function ffmpeg(args: string[]): boolean {
  return spawnSync("ffmpeg", ["-y", "-v", "error", ...args], { encoding: "utf8" }).status === 0;
}

const NOISE = "anoisesrc=color=pink:r=44100:a=0.3:d=22,volume='0.6+0.4*sin(2*PI*t*0.5)':eval=frame";

async function removeGuest(owner: APIRequestContext): Promise<void> {
  const res = await invoke<{ identities?: Identity[] }>(owner, "server:listIdentities");
  const found = (res.identities ?? []).find((i) => i.subject === GUEST_USERNAME);
  if (found) await invoke(owner, "server:revokeIdentity", found.id);
}

async function removeFolder(owner: APIRequestContext): Promise<void> {
  const folders = await invoke<{ id: number; name: string }[]>(owner, "library:getFolders");
  for (const f of folders ?? []) {
    if (f.name === FOLDER_NAME) await invoke(owner, "library:removeFolder", f.id);
  }
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(180_000);
  libraryDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-web-lossless-"));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-e2e-web-lossless-src-"));
  try {
    const mp3 = path.join(scratch, "t.mp3");
    fixturesOk =
      ffmpeg(["-f", "lavfi", "-i", NOISE, "-ac", "2", "-metadata", "title=Web Genuine", path.join(libraryDir, "web-genuine.flac")]) &&
      ffmpeg(["-i", path.join(libraryDir, "web-genuine.flac"), "-c:a", "libmp3lame", "-b:a", "128k", mp3]) &&
      ffmpeg(["-i", mp3, "-metadata", "title=Web Fake", "-metadata", "album=Web Fake Album", path.join(libraryDir, "web-fake.flac")]);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  await signIn(request);
  await removeGuest(request);
  await invoke(request, "server:allowIdentity", {
    provider: "local",
    subject: GUEST_USERNAME,
    displayName: "E2E Lossless Guest",
    password: GUEST_PASSWORD,
  });
  guest = await playwrightRequest.newContext({ baseURL: WEB_ORIGIN });
  const login = await guest.post("/api/auth/local/login", {
    data: { username: GUEST_USERNAME, password: GUEST_PASSWORD },
  });
  expect(login.ok()).toBe(true);

  if (fixturesOk) {
    await invoke(request, "library:addFolder", { name: FOLDER_NAME, path: libraryDir, contentType: "music" });
    await invoke(request, "library:scan", {
      folders: [{ name: FOLDER_NAME, path: libraryDir, contentType: "music" }],
    });
  }
});

test.afterAll(async ({ request }) => {
  await guest?.dispose();
  await signIn(request);
  await removeGuest(request);
  // Every spec shares one daemon: leave no folder or tracks behind.
  await removeFolder(request);
  if (libraryDir) fs.rmSync(libraryDir, { recursive: true, force: true });
});

function mine(rows: ReportRow[]): ReportRow[] {
  return rows.filter((r) => r.path.startsWith(libraryDir));
}

test("the owner's check flags the MP3-sourced FLAC and passes the genuine one", async ({ request }) => {
  test.setTimeout(180_000);
  test.skip(!fixturesOk, "ffmpeg with libmp3lame unavailable — cannot make the fixtures");
  await signIn(request);
  const result = await invoke<{ checked: number; error?: string }>(request, "lossless:scan", { scope: "all" });
  expect(result.error).toBeUndefined();
  expect(result.checked).toBeGreaterThanOrEqual(2);

  const report = mine(await invoke<ReportRow[]>(request, "lossless:report"));
  expect(report.find((r) => r.title === "Web Fake")?.verdict).toBe("lossy_strong");
  expect(report.find((r) => r.title === "Web Fake")?.source).toMatch(/MP3/);
  expect(report.find((r) => r.title === "Web Genuine")?.verdict).toBe("genuine");
});

test("a guest reads the report but cannot start, overrule or delete", async ({ request }) => {
  test.skip(!fixturesOk, "ffmpeg with libmp3lame unavailable — cannot make the fixtures");
  await signIn(request);
  // Control: an ordinary channel works for this guest.
  expect((await invoke<{ error?: string }>(guest, "library:getStats")).error).toBeUndefined();

  const report = mine(await invoke<ReportRow[]>(guest, "lossless:report"));
  const fake = report.find((r) => r.title === "Web Fake")!;
  expect(fake).toBeDefined();

  for (const [channel, arg] of [
    ["lossless:scan", { scope: "all" }],
    ["lossless:cancel", undefined],
    ["lossless:setOverride", { trackIds: [fake.trackId], ok: true }],
    ["lossless:clear", undefined],
    ["lossless:deleteFlagged", { trackIds: [fake.trackId] }],
  ] as const) {
    const res = await invoke<{ error?: string }>(guest, channel, arg);
    expect(res?.error, channel).toMatch(/owner/i);
  }
  expect(fs.existsSync(fake.path)).toBe(true);
  const after = mine(await invoke<ReportRow[]>(request, "lossless:report"));
  expect(after.find((r) => r.title === "Web Fake")?.verdict).toBe("lossy_strong");
});

test("the daemon has no Trash, so the owner's delete is permanent", async ({ request }) => {
  test.skip(!fixturesOk, "ffmpeg with libmp3lame unavailable — cannot make the fixtures");
  await signIn(request);
  expect(await invoke<{ hasTrash: boolean }>(request, "lossless:hostHasTrash")).toEqual({ hasTrash: false });

  const report = mine(await invoke<ReportRow[]>(request, "lossless:report"));
  const fake = report.find((r) => r.title === "Web Fake")!;
  const genuine = report.find((r) => r.title === "Web Genuine")!;
  // The genuine id rides along and must survive.
  const res = await invoke<{ deleted: number; trashed: number; permanent: number; failed: unknown[] }>(
    request,
    "lossless:deleteFlagged",
    { trackIds: [fake.trackId, genuine.trackId] }
  );
  expect(res).toMatchObject({ deleted: 1, trashed: 0, permanent: 1, failed: [] });
  expect(fs.existsSync(fake.path)).toBe(false);
  expect(fs.existsSync(genuine.path)).toBe(true);
  const titles = mine(await invoke<ReportRow[]>(request, "lossless:report")).map((r) => r.title);
  expect(titles).toEqual(["Web Genuine"]);
});
