/**
 * @vitest-environment node
 *
 * Regressions from the 2026-09-28 security findings: `podcast:setSettings` and
 * the scheduler it restarts.
 *
 *  - Any allowlisted web user could call it, with no validation. An
 *    `intervalMin` of `"abc"`, `{}` or `1e12` reached `setInterval` as NaN or
 *    more than 2^31-1 ms, which Node runs every **1 ms** — a thousand
 *    `refreshAll`s a second, persisted in prefs across restarts.
 *  - The same call moved the podcast download root to any directory the
 *    daemon can write, with no `validateFolderPath()`, and replaced the owner's
 *    Podcast Index credentials.
 *  - Nothing stopped scheduler runs from overlapping, so any short cadence (or
 *    one download that never finishes) stacked them without bound.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installElectronMock, setupIpcSession } from "../harness/ipc-harness";
import type { IpcSession } from "../harness/ipc-harness";

installElectronMock();

// The scheduler is started by `registerIpcHandlers()`; keep its work inert and
// countable. Registered at module scope — see CLAUDE.md on `vi.mock`.
vi.mock("../../main/podcasts/podcast-refresh", () => ({
  refreshAll: vi.fn().mockResolvedValue(undefined),
  refreshSubscription: vi.fn().mockResolvedValue(undefined),
  refreshAllForNewFolder: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../main/devices/usb-devices", () => ({
  refreshUsbSnapshot: vi.fn().mockResolvedValue({ available: false, devices: [] }),
  getUsbSnapshot: vi.fn().mockReturnValue({ available: false, devices: [] }),
  listUsbDevices: vi.fn().mockResolvedValue({ available: false, devices: [] }),
  normalizeUsbId: vi.fn((v) => (v == null || v === "" ? null : String(v).toLowerCase().padStart(4, "0"))),
  usbDeviceMatches: vi.fn().mockReturnValue(false),
}));

let dir: string;
let session: IpcSession;
let bridge: typeof import("../../main/host/bridge");
let identities: typeof import("../../server/auth/identities");
let serverDb: typeof import("../../server/db");
let prefs: typeof import("../../main/utils/prefs");
let scheduler: typeof import("../../main/podcasts/podcast-scheduler");
let refresh: typeof import("../../main/podcasts/podcast-refresh");
let common: typeof import("../../main/ipc/common");

const sender = { send: () => {}, isDestroyed: () => false };

async function call<T = unknown>(
  channel: string,
  ctx: { sessionId?: string },
  ...args: unknown[]
): Promise<T> {
  const handler = bridge.getHandler(channel);
  if (!handler) throw new Error(`${channel} not registered`);
  return (await handler({ sender, ...ctx }, ...args)) as T;
}

function libDb() {
  return common.getLibrary().getConnection();
}

function putSession(sid: string, identityId: number) {
  serverDb
    .getServerDb()
    .prepare("INSERT INTO server_sessions (sid, data, expires_at) VALUES (?, ?, ?)")
    .run(sid, JSON.stringify({ identityId }), Date.now() + 60_000);
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-podcast-settings-"));
  fs.mkdirSync(path.join(dir, "userData"), { recursive: true });
  session = await setupIpcSession({ userDataDir: dir });
  bridge = await import("../../main/host/bridge");
  identities = await import("../../server/auth/identities");
  serverDb = await import("../../server/db");
  prefs = await import("../../main/utils/prefs");
  scheduler = await import("../../main/podcasts/podcast-scheduler");
  refresh = await import("../../main/podcasts/podcast-refresh");
  common = await import("../../main/ipc/common");

  const owner = identities.addIdentity({ provider: "local", subject: "owner", isOwner: true });
  const guest = identities.addIdentity({ provider: "local", subject: "guest" });
  putSession("sid-owner", owner.id);
  putSession("sid-guest", guest.id);
});

afterEach(() => {
  scheduler.stopPodcastScheduler();
  session.cleanup();
  try {
    serverDb.closeServerDb();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("podcast:setSettings is owner-only over the web", () => {
  it("refuses a guest every server-wide change, and nothing moves", async () => {
    await session.invoke("podcast:setSettings", { apiKey: "owner-key", apiSecret: "owner-secret" });
    const before = prefs.getAutoPodcastSettings();

    for (const payload of [
      { autoEnabled: true, intervalMin: "abc" },
      { intervalMin: 30 },
      { autoEnabled: !before.enabled },
      { downloadDir: "/tmp" },
      { apiKey: "attacker-key" },
      { apiSecret: "attacker-secret" },
    ]) {
      const res = await call<{ error?: string } | undefined>(
        "podcast:setSettings",
        { sessionId: "sid-guest" },
        payload
      );
      expect(res?.error, JSON.stringify(payload)).toMatch(/owner/i);
    }
    expect(prefs.getAutoPodcastSettings()).toEqual(before);
    expect(prefs.getPodcastDownloadDir()).toBeNull();
    expect(prefs.getPodcastIndexConfig()).toEqual({ apiKey: "owner-key", apiSecret: "owner-secret" });
  });

  it("lets a guest's no-op save through quietly", async () => {
    // The Settings card saves every section at once, so a guest changing
    // nothing here sends the stored values straight back. Refusing that would
    // put an error on every save a guest ever makes.
    const s = prefs.getAutoPodcastSettings();
    const res = await call("podcast:setSettings", { sessionId: "sid-guest" }, {
      autoEnabled: s.enabled,
      intervalMin: s.refreshIntervalMinutes,
      downloadDir: null,
    });
    expect(res).toBeUndefined();
  });

  it("admits the owner's web session — the control", async () => {
    const res = await call("podcast:setSettings", { sessionId: "sid-owner" }, { intervalMin: 60 });
    expect(res).toBeUndefined();
    expect(prefs.getAutoPodcastSettings().refreshIntervalMinutes).toBe(60);
  });

  it("never returns the Podcast Index credentials", async () => {
    await session.invoke("podcast:setSettings", { apiKey: "owner-key", apiSecret: "owner-secret" });
    const res = await call<Record<string, unknown>>("podcast:getSettings", { sessionId: "sid-guest" });
    expect(JSON.stringify(res)).not.toMatch(/owner-key|owner-secret/);
    expect(res.hasApiKey).toBe(true);
  });
});

describe("podcast:setSettings validates before it writes", () => {
  it("rejects every interval that is not a whole number of minutes in 5..1440", async () => {
    for (const bad of ["abc", {}, [], null, 1e12, -1, 0, 4, 1441, 15.5, NaN, "30"]) {
      const res = await session.invoke<{ error?: string } | undefined>("podcast:setSettings", {
        autoEnabled: true,
        intervalMin: bad,
      });
      expect(res?.error, String(bad)).toMatch(/interval/i);
    }
    // Rejected whole: the `autoEnabled: true` beside the bad interval did not land either.
    expect(prefs.getAutoPodcastSettings()).toEqual({ enabled: false, refreshIntervalMinutes: 15 });
  });

  it("a rejected interval leaves the stored one, and a valid change still works", async () => {
    await session.invoke("podcast:setSettings", { intervalMin: "abc" });
    expect(prefs.getAutoPodcastSettings().refreshIntervalMinutes).toBe(15);
    expect(await session.invoke("podcast:setSettings", { intervalMin: 30 })).toBeUndefined();
    expect(prefs.getAutoPodcastSettings().refreshIntervalMinutes).toBe(30);
  });

  it("rejects a non-boolean autoEnabled", async () => {
    const res = await session.invoke<{ error?: string }>("podcast:setSettings", { autoEnabled: "false" });
    expect(res?.error).toMatch(/autoEnabled/);
    expect(prefs.getAutoPodcastSettings().enabled).toBe(false);
  });

  it("refuses a download folder outside the allowed roots, even to the owner", async () => {
    for (const bad of ["/etc", "/", 42, {}]) {
      const res = await session.invoke<{ error?: string }>("podcast:setSettings", { downloadDir: bad });
      expect(res?.error, String(bad)).toBeTruthy();
    }
    expect(prefs.getPodcastDownloadDir()).toBeNull();
  });

  it("a partial update leaves the other settings alone", async () => {
    await session.invoke("podcast:setSettings", { autoEnabled: true, intervalMin: 60 });
    await session.invoke("podcast:setSettings", { intervalMin: 30 });
    expect(prefs.getAutoPodcastSettings()).toEqual({ enabled: true, refreshIntervalMinutes: 30 });
  });
});

describe("a bad interval already on disk cannot reach setInterval", () => {
  function writeStored(value: unknown) {
    // Straight into the object the getters read, as a hand-edited or older
    // prefs file would load: nothing on this path went through the setter.
    prefs.readPrefs().autoPodcasts = {
      enabled: "yes" as unknown as boolean,
      refreshIntervalMinutes: value as number,
    };
  }

  it("clamps or replaces what it reads", () => {
    writeStored("abc");
    expect(prefs.getAutoPodcastSettings()).toEqual({ enabled: false, refreshIntervalMinutes: 15 });
    writeStored(1e12);
    expect(prefs.getAutoPodcastSettings().refreshIntervalMinutes).toBe(1440);
    writeStored(-1);
    expect(prefs.getAutoPodcastSettings().refreshIntervalMinutes).toBe(5);
    writeStored({});
    expect(prefs.getAutoPodcastSettings().refreshIntervalMinutes).toBe(15);
  });

  it("the scheduler's timer is never shorter than five minutes", () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    try {
      scheduler.stopPodcastScheduler();
      writeStored(1e12);
      scheduler.startPodcastScheduler(libDb());
      writeStored("abc");
      scheduler.stopPodcastScheduler();
      scheduler.startPodcastScheduler(libDb());
      const delays = spy.mock.calls.map((c) => Number(c[1]));
      expect(delays.length).toBeGreaterThan(0);
      for (const d of delays) {
        expect(Number.isFinite(d)).toBe(true);
        expect(d).toBeGreaterThanOrEqual(60_000);
        expect(d).toBeLessThanOrEqual(2 ** 31 - 1);
      }
    } finally {
      scheduler.stopPodcastScheduler();
      spy.mockRestore();
    }
  });
});

describe("scheduler runs never overlap", () => {
  it("coalesces triggers that arrive mid-run into one more run", async () => {
    const refreshAll = vi.mocked(refresh.refreshAll);
    // Let the boot run started by registerIpcHandlers() settle first.
    await scheduler.runRefreshAndSync(libDb());
    refreshAll.mockClear();

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    refreshAll.mockImplementationOnce(() => gate);

    const runs = Array.from({ length: 20 }, () => scheduler.runRefreshAndSync(libDb()));
    expect(refreshAll).toHaveBeenCalledTimes(1);
    expect(scheduler.isPodcastRunInFlight()).toBe(true);
    release();
    await Promise.all(runs);
    // The in-flight run, plus exactly one re-run for the nineteen that waited.
    expect(refreshAll).toHaveBeenCalledTimes(2);
    expect(scheduler.isPodcastRunInFlight()).toBe(false);
  });

  it("a failing refresh does not wedge the guard", async () => {
    const refreshAll = vi.mocked(refresh.refreshAll);
    await scheduler.runRefreshAndSync(libDb());
    refreshAll.mockRejectedValueOnce(new Error("boom"));
    await expect(scheduler.runRefreshAndSync(libDb())).resolves.toBeUndefined();
    expect(scheduler.isPodcastRunInFlight()).toBe(false);
  });
});
