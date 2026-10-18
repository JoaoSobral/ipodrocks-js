/**
 * @vitest-environment node
 *
 * "Scan library at startup" and the 10-day "scan your library?" reminder.
 *
 *  - The last-scan time lives in `app_settings`, because `activity_log` is
 *    pruned; an upgraded database is seeded once from its newest scan row.
 *  - The reminder is due after 10 days, never with the startup scan on, never
 *    for a library with no folders, and "No" quiets it for another 10 days.
 *  - Over the web it is the owner's question alone, and only the owner may
 *    change the setting or snooze it.
 *  - A scan that finishes records the time; a cancelled one does not.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installElectronMock, setupIpcSession } from "../harness/ipc-harness";
import type { IpcSession } from "../harness/ipc-harness";
import { canRunDbTests } from "../harness";
import {
  LAST_SCAN_KEY,
  SCAN_REMINDER_INTERVAL_MS,
  getLastLibraryScanAt,
  recordLibraryScan,
  scanReminder,
} from "../../main/library/scan-schedule";

installElectronMock();

const DAY = 24 * 60 * 60 * 1000;

function schedDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE activity_log (id INTEGER PRIMARY KEY, operation TEXT, detail TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE library_folders (id INTEGER PRIMARY KEY, name TEXT, path TEXT, content_type TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
  `);
  return db;
}

describe.skipIf(!canRunDbTests)("scan schedule", () => {
  it("is quiet with no folders, and due for a library never scanned once it is 10 days old", () => {
    const db = schedDb();
    expect(scanReminder(db, {}).due).toBe(false);
    // Just added: its first scan is under way, not overdue. Asking here raced
    // that scan and put the dialog over whatever the user was doing.
    db.prepare("INSERT INTO library_folders (name, path, content_type) VALUES ('m', '/m', 'music')").run();
    expect(scanReminder(db, {})).toEqual({ due: false, lastScanAt: null });
    db.prepare("UPDATE library_folders SET created_at = datetime('now', '-11 days')").run();
    expect(scanReminder(db, {})).toEqual({ due: true, lastScanAt: null });
  });

  it("is due after 10 days, not before, and never with the startup scan on", () => {
    const db = schedDb();
    db.prepare("INSERT INTO library_folders (name, path, content_type) VALUES ('m', '/m', 'music')").run();
    const now = Date.UTC(2026, 9, 18);
    recordLibraryScan(db, now - 9 * DAY);
    expect(scanReminder(db, {}, now).due).toBe(false);
    recordLibraryScan(db, now - SCAN_REMINDER_INTERVAL_MS);
    const r = scanReminder(db, {}, now);
    expect(r.due).toBe(true);
    expect(r.lastScanAt).toBe(new Date(now - 10 * DAY).toISOString());
    expect(scanReminder(db, { scanOnStartup: true }, now).due).toBe(false);
    // "No": quiet until the snooze runs out.
    expect(scanReminder(db, { scanReminderSnoozeUntil: now + DAY }, now).due).toBe(false);
    expect(scanReminder(db, { scanReminderSnoozeUntil: now - 1 }, now).due).toBe(true);
  });

  it("seeds an upgraded database from its newest scan in the activity log, once", () => {
    const db = schedDb();
    db.prepare(
      "INSERT INTO activity_log (operation, created_at) VALUES ('library_scan', '2026-09-01 10:00:00'), ('library_scan', '2026-09-20 08:30:00'), ('sync', '2026-10-01 00:00:00')"
    ).run();
    expect(getLastLibraryScanAt(db)).toBe(Date.UTC(2026, 8, 20, 8, 30));
    // Stored now, so pruning the log can no longer lose it.
    db.prepare("DELETE FROM activity_log").run();
    expect(getLastLibraryScanAt(db)).toBe(Date.UTC(2026, 8, 20, 8, 30));
    const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(LAST_SCAN_KEY);
    expect(row).toBeDefined();
  });
});

describe.skipIf(!canRunDbTests)("scan reminder over IPC", () => {
  let dir: string;
  let session: IpcSession;
  let bridge: typeof import("../../main/host/bridge");
  let identities: typeof import("../../server/auth/identities");
  let serverDb: typeof import("../../server/db");
  let common: typeof import("../../main/ipc/common");
  let prefs: typeof import("../../main/utils/prefs");
  let sched: typeof import("../../main/library/scan-schedule");
  const sender = { send: () => {}, isDestroyed: () => false };

  async function call<T = unknown>(channel: string, ctx: { sessionId?: string }, ...args: unknown[]) {
    const handler = bridge.getHandler(channel);
    if (!handler) throw new Error(`${channel} not registered`);
    return (await handler({ sender, ...ctx }, ...args)) as T;
  }

  function putSession(sid: string, identityId: number) {
    serverDb
      .getServerDb()
      .prepare("INSERT INTO server_sessions (sid, data, expires_at) VALUES (?, ?, ?)")
      .run(sid, JSON.stringify({ identityId }), Date.now() + 60_000);
  }

  let music: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-scan-reminder-"));
    fs.mkdirSync(path.join(dir, "userData"), { recursive: true });
    music = fs.mkdtempSync(path.join(os.homedir(), ".ipr-scan-reminder-lib-"));
    session = await setupIpcSession({ userDataDir: dir });
    bridge = await import("../../main/host/bridge");
    identities = await import("../../server/auth/identities");
    serverDb = await import("../../server/db");
    common = await import("../../main/ipc/common");
    prefs = await import("../../main/utils/prefs");
    sched = await import("../../main/library/scan-schedule");
    const owner = identities.addIdentity({ provider: "local", subject: "owner", isOwner: true });
    const guest = identities.addIdentity({ provider: "local", subject: "guest" });
    putSession("sid-owner", owner.id);
    putSession("sid-guest", guest.id);
    await session.invoke("library:addFolder", { name: "Music", path: music, contentType: "music" });
  });

  afterEach(() => {
    session.cleanup();
    try {
      serverDb.closeServerDb();
    } catch {
      /* ignore */
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(music, { recursive: true, force: true });
  });

  it("asks the owner and nobody else, and only the owner can snooze it", async () => {
    const db = common.getLibrary().getConnection();
    sched.recordLibraryScan(db, Date.now() - 11 * DAY);

    expect((await call<{ due: boolean }>("library:getScanReminder", {})).due).toBe(true);
    expect((await call<{ due: boolean }>("library:getScanReminder", { sessionId: "sid-owner" })).due).toBe(true);
    expect((await call<{ due: boolean }>("library:getScanReminder", { sessionId: "sid-guest" })).due).toBe(false);

    const refused = await call<{ error?: string }>("library:snoozeScanReminder", { sessionId: "sid-guest" });
    expect(refused.error).toMatch(/owner/i);
    expect(prefs.getLibraryPrefs().scanReminderSnoozeUntil).toBeUndefined();

    await call("library:snoozeScanReminder", { sessionId: "sid-owner" });
    const until = prefs.getLibraryPrefs().scanReminderSnoozeUntil!;
    expect(until).toBeGreaterThan(Date.now() + 9.9 * DAY);
    expect((await call<{ due: boolean }>("library:getScanReminder", {})).due).toBe(false);
  });

  it("the startup-scan switch is off by default and owner-only to change", async () => {
    expect(await call("settings:getLibraryPrefs", { sessionId: "sid-guest" })).toEqual({
      scanOnStartup: false,
    });
    const refused = await call<{ error?: string }>(
      "settings:setLibraryPrefs",
      { sessionId: "sid-guest" },
      { scanOnStartup: true }
    );
    expect(refused.error).toMatch(/owner/i);
    expect(prefs.getLibraryPrefs().scanOnStartup).toBe(false);

    await call("settings:setLibraryPrefs", { sessionId: "sid-owner" }, { scanOnStartup: true });
    expect(prefs.getLibraryPrefs().scanOnStartup).toBe(true);
    expect((await call<{ due: boolean }>("library:getScanReminder", {})).due).toBe(false);
  });

  it("a finished scan records the time; a scan that never ran does not", async () => {
    const db = common.getLibrary().getConnection();
    expect(sched.getLastLibraryScanAt(db)).toBeNull();
    const before = Date.now();
    const res = await session.invoke<{ cancelled?: boolean; error?: string }>("library:scan", {
      folders: [{ name: "Music", path: music, contentType: "music" }],
    });
    expect(res.error).toBeUndefined();
    expect(sched.getLastLibraryScanAt(db)).toBeGreaterThanOrEqual(before - 1000);
    expect((await call<{ due: boolean }>("library:getScanReminder", {})).due).toBe(false);
  });

  it("Rocksy reads and changes the switch, owner-gated", async () => {
    const { getToolByName } = await import("../../main/assistant/tools");
    const tool = getToolByName("library_set_scan_on_startup")!;
    expect(tool.kind).toBe("write-safe");
    const ctx = { db: common.getLibrary().getConnection() } as Parameters<typeof tool.run>[1];
    expect(await tool.run({}, ctx)).toMatchObject({ scanOnStartup: false, lastLibraryScan: null });
    const refused = (await tool.run({ enabled: true }, { ...ctx, sessionId: "sid-guest" })) as {
      error?: string;
    };
    expect(refused.error).toMatch(/owner/i);
    expect(await tool.run({ enabled: true }, ctx)).toMatchObject({ ok: true, scanOnStartup: true });
    expect(prefs.getLibraryPrefs().scanOnStartup).toBe(true);
  });

  it("Rocksy reads and changes the harmonic analysis switches, owner-gated", async () => {
    const { getToolByName } = await import("../../main/assistant/tools");
    const tool = getToolByName("library_set_harmonic_analysis")!;
    expect(tool.kind).toBe("write-safe");
    const ctx = { db: common.getLibrary().getConnection() } as Parameters<typeof tool.run>[1];
    expect(await tool.run({}, ctx)).toMatchObject({ analyzeWithEssentia: false, musicTracks: 0 });
    const refused = (await tool.run({ analyze_with_essentia: true }, { ...ctx, sessionId: "sid-guest" })) as {
      error?: string;
    };
    expect(refused.error).toMatch(/owner/i);
    expect(prefs.getHarmonicPrefs().analyzeWithEssentia).toBe(false);
    expect(await tool.run({ analyze_with_essentia: true, analyze_percent: 100 }, ctx)).toMatchObject({
      ok: true,
      analyzeWithEssentia: true,
      analyzePercent: 100,
    });
    expect((await tool.run({ analyze_percent: 0 }, ctx)) as { error?: string }).toMatchObject({
      error: expect.stringMatching(/1-100/),
    });
  });
});
