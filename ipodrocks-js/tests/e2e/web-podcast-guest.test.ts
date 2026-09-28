/**
 * Playwright E2E — a signed-in guest cannot reconfigure the podcast pipeline
 * or aim it at the server's own files.
 *
 * From the 2026-09-28 findings, driven over a real daemon:
 *
 *  - `podcast:setSettings` was reachable by any allowlisted account with no
 *    validation: `intervalMin: "abc"` put the scheduler on a 1 ms timer, and
 *    `downloadDir` moved the root the downloader writes feed bytes into to any
 *    directory the daemon can write.
 *  - `device:update` let a guest rewrite their own web device's `mount_path`
 *    to a real server directory — which the podcast cleanup then `unlink`ed
 *    under — and turn Auto Podcasts on for it past `autoPodcastBlock()`.
 *  - `podcast:subscribe` stored a string `feedId` that became a path component.
 *
 * The handler-level twins, including the unlink itself, are
 * `src/__tests__/regressions/podcast-settings-scheduler.test.ts` and
 * `src/__tests__/regressions/podcast-device-state-hardening.test.ts`.
 *
 * Run with: `npm run build && npx playwright test --project=web`
 */
import { test, expect, request as playwrightRequest } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { WEB_ORIGIN, invoke, signIn } from "./web-harness";

test.describe.configure({ mode: "serial" });

const GUEST_USERNAME = "e2e-podcast-guest";
const GUEST_PASSWORD = "a-perfectly-fine-podcast-password";

interface Identity {
  id: number;
  subject: string;
}

interface PodcastSettings {
  autoEnabled: boolean;
  intervalMin: number;
  downloadDirCustom: string | null;
}

let guest: APIRequestContext;
let guestDeviceId: number | null = null;

async function removeGuest(owner: APIRequestContext): Promise<void> {
  const res = await invoke<{ identities?: Identity[] }>(owner, "server:listIdentities");
  const found = (res.identities ?? []).find((i) => i.subject === GUEST_USERNAME);
  if (found) await invoke(owner, "server:revokeIdentity", found.id);
}

test.beforeAll(async ({ request }) => {
  await signIn(request);
  await removeGuest(request);
  await invoke(request, "server:allowIdentity", {
    provider: "local",
    subject: GUEST_USERNAME,
    displayName: "E2E Podcast Guest",
    password: GUEST_PASSWORD,
  });
  guest = await playwrightRequest.newContext({ baseURL: WEB_ORIGIN });
  const login = await guest.post("/api/auth/local/login", {
    data: { username: GUEST_USERNAME, password: GUEST_PASSWORD },
  });
  expect(login.ok()).toBe(true);
});

test.afterAll(async ({ request }) => {
  if (guestDeviceId !== null) await invoke(guest, "device:remove", guestDeviceId).catch(() => {});
  await guest?.dispose();
  await signIn(request);
  await removeGuest(request);
});

test("a guest is refused every podcast settings change, and nothing moves", async ({ request }) => {
  await signIn(request);
  const before = await invoke<PodcastSettings>(request, "podcast:getSettings");

  for (const payload of [
    { autoEnabled: true, intervalMin: "abc" },
    { intervalMin: 1e12 },
    { downloadDir: "/tmp" },
    { apiKey: "e2e-attacker-key", apiSecret: "e2e-attacker-secret" },
  ]) {
    const res = await invoke<{ error?: string } | null>(guest, "podcast:setSettings", payload);
    expect(res?.error, JSON.stringify(payload)).toContain("owner");
  }

  const after = await invoke<PodcastSettings>(request, "podcast:getSettings");
  expect(after.autoEnabled).toBe(before.autoEnabled);
  expect(after.intervalMin).toBe(before.intervalMin);
  expect(after.downloadDirCustom).toBe(before.downloadDirCustom);
});

test("the owner's invalid interval is rejected too — validation is not the gate", async ({ request }) => {
  await signIn(request);
  const before = await invoke<PodcastSettings>(request, "podcast:getSettings");
  for (const bad of ["abc", {}, 1e12, -1]) {
    const res = await invoke<{ error?: string } | null>(request, "podcast:setSettings", {
      intervalMin: bad,
    });
    expect(res?.error, String(bad)).toMatch(/interval/i);
  }
  const res = await invoke<{ error?: string } | null>(request, "podcast:setSettings", {
    downloadDir: "/etc",
  });
  expect(res?.error).toBeTruthy();
  const after = await invoke<PodcastSettings>(request, "podcast:getSettings");
  expect(after.intervalMin).toBe(before.intervalMin);
  expect(after.downloadDirCustom).toBe(before.downloadDirCustom);
});

test("a guest cannot rewrite their own web device's mount path or folders", async () => {
  const added = await invoke<{ id: number; mountPath: string; error?: string }>(
    guest,
    "device:add",
    { name: `e2e-podcast-guest-device-${Date.now()}` }
  );
  expect(added.error).toBeUndefined();
  guestDeviceId = added.id;
  const syntheticRoot = added.mountPath;

  // The mount path is silently kept at the synthetic root.
  await invoke(guest, "device:update", added.id, { mountPath: "/tmp" });
  // Folders that leave the device are refused.
  for (const bad of [".", "..", "../x", "/etc"]) {
    const res = await invoke<{ error?: string } | null>(guest, "device:update", added.id, {
      podcastFolder: bad,
    });
    expect(res?.error, bad).toBeTruthy();
  }
  // Auto Podcasts cannot be turned on for a remote device through this door either.
  const auto = await invoke<{ error?: string } | null>(guest, "device:update", added.id, {
    autoPodcastsEnabled: true,
  });
  expect(auto?.error).toContain("Auto Podcasts");

  const devices = await invoke<Array<{ id: number; mountPath: string; podcastFolder: string; autoPodcastsEnabled: boolean }>>(
    guest,
    "device:list"
  );
  const mine = devices.find((d) => d.id === added.id)!;
  expect(mine.mountPath).toBe(syntheticRoot);
  expect(mine.podcastFolder).toBe("Podcasts");
  expect(mine.autoPodcastsEnabled).toBe(false);

  // The control: an ordinary edit still lands.
  const ok = await invoke<{ error?: string; podcastFolder?: string }>(guest, "device:update", added.id, {
    podcastFolder: "iPod_Control/Podcasts",
  });
  expect(ok.error).toBeUndefined();
  expect(ok.podcastFolder).toBe("iPod_Control/Podcasts");
});

test("podcast:subscribe refuses a feedId that is not an integer", async () => {
  for (const bad of ["1/../../../../tmp/x", "920666&id=1", "42"]) {
    const res = await invoke<{ error?: string } | null>(guest, "podcast:subscribe", {
      feedId: bad,
      title: "x",
      feedUrl: "https://example.com/feed.xml",
    });
    expect(res?.error, bad).toMatch(/feed id/i);
  }
  const subs = await invoke<Array<{ title: string; feedUrl: string }>>(guest, "podcast:listSubs");
  expect(subs.some((s) => s.feedUrl === "https://example.com/feed.xml" && s.title === "x")).toBe(false);
});
