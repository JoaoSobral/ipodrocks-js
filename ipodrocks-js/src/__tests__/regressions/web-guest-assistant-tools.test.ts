/**
 * Regression — a Rocksy tool answers the client that asked, and gives a web
 * client no more than the channel it mirrors would.
 *
 * `assistant:confirmAction` runs `getToolByName(action.tool).run(action.args,
 * ctx)` on an object the *client* supplies, so each tool is a front door in its
 * own right. Three of them were not behaving like one (2026-09-28 review):
 *
 * - `library_scan`, `shadow_rebuild` and `device_sync` pushed their renderer
 *   trigger to `BrowserWindow.getAllWindows()[0]`. With the desktop app hosting
 *   the web server that is the *owner's* window, so a guest could navigate the
 *   owner's screen and start full scans and rebuilds there under modal
 *   progress dialogs. They now push to `ctx.sender` — the caller's own
 *   transport — and a web caller without one is refused.
 * - `usb_device_list` enumerated the server's USB bus for anyone, while
 *   `device:listUsb` has always shown a web client nothing.
 * - `ratings_set_tag_priority` wrote the server-wide pref that
 *   `settings:setRatingPrefs` now owner-gates.
 *
 * The electron mock's window is a spy, so "nothing reached the desktop" is an
 * assertion rather than an absence.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setHost, createNodeHost, resetHost } from "../../main/host";
import type { AiToolContext } from "../../main/assistant/tools";

const desktopSends: Array<{ channel: string; args: unknown[] }> = [];
const listUsbDevices = vi.fn(async () => ({
  available: true,
  devices: [{ vendorId: "05ac", productId: "1209", serial: "HOST-SERIAL-0001" }],
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        webContents: {
          send: (channel: string, ...args: unknown[]) => desktopSends.push({ channel, args }),
        },
      },
    ],
  },
}));

vi.mock("../../main/devices/usb-devices", () => ({
  listUsbDevices: () => listUsbDevices(),
}));

let dataDir: string;
let db: typeof import("../../server/db");
let identities: typeof import("../../server/auth/identities");
let tools: typeof import("../../main/assistant/tools");
let prefs: typeof import("../../main/utils/prefs");

function putSession(sid: string, identityId: number) {
  db.getServerDb()
    .prepare("INSERT INTO server_sessions (sid, data, expires_at) VALUES (?, ?, ?)")
    .run(sid, JSON.stringify({ identityId }), Date.now() + 60_000);
}

function recordingSender() {
  const sent: Array<{ channel: string; args: unknown[] }> = [];
  return {
    sent,
    sender: {
      send: (channel: string, ...args: unknown[]) => sent.push({ channel, args }),
      isDestroyed: () => false,
    },
  };
}

/** Just enough of a context for the trigger tools: one remote device with no
 *  owner recorded (the gate admits it), and one shadow library. */
function ctxFor(sessionId: string | undefined, sender?: AiToolContext["sender"]): AiToolContext {
  return {
    sessionId,
    sender,
    getDevicesCore: () => ({
      getDeviceById: (id: number) =>
        id === 7 ? { profile: { id: 7, name: "Guest iPod", transport: "web" } } : null,
    }),
    getLibrary: () => ({
      getShadowLibraries: () => [{ id: 3, name: "Opus shadow", codecConfigMissing: false }],
    }),
  } as unknown as AiToolContext;
}

async function run(name: string, args: Record<string, unknown>, ctx: AiToolContext) {
  const tool = tools.getToolByName(name);
  expect(tool, `${name} is registered`).toBeTruthy();
  return (await tool!.run(args, ctx)) as Record<string, unknown>;
}

beforeEach(async () => {
  desktopSends.length = 0;
  listUsbDevices.mockClear();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-guest-tools-"));
  process.env.IPODROCKS_DATA_DIR = dataDir;
  setHost(createNodeHost());
  db = await import("../../server/db");
  db.closeServerDb();
  identities = await import("../../server/auth/identities");
  tools = await import("../../main/assistant/tools");
  prefs = await import("../../main/utils/prefs");
});

afterEach(() => {
  db.closeServerDb();
  resetHost();
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("trigger tools reach the caller, never the desktop window", () => {
  const CASES: Array<[string, Record<string, unknown>, string]> = [
    ["library_scan", {}, "assistant:triggerLibraryScan"],
    ["shadow_rebuild", { shadowLibraryId: 3 }, "assistant:triggerShadowRebuild"],
    ["device_sync", { device_id: 7 }, "assistant:triggerSync"],
  ];

  it("a web caller's trigger goes to its own sender", async () => {
    for (const [name, args, channel] of CASES) {
      const { sent, sender } = recordingSender();
      const res = await run(name, args, ctxFor("sid-guest", sender));
      expect(res.error, `${name} should succeed for its caller`).toBeUndefined();
      expect(sent.map((s) => s.channel)).toEqual([channel]);
    }
    expect(desktopSends, "nothing may reach the owner's window").toEqual([]);
  });

  it("a web caller with no live sender is refused, not routed to the desktop", async () => {
    for (const [name, args] of CASES) {
      const res = await run(name, args, ctxFor("sid-guest"));
      expect(res.error, `${name} must refuse`).toBeTruthy();
    }
    const dead = { send: vi.fn(), isDestroyed: () => true };
    const res = await run("library_scan", {}, ctxFor("sid-guest", dead));
    expect(res.error).toBeTruthy();
    expect(dead.send).not.toHaveBeenCalled();
    expect(desktopSends).toEqual([]);
  });

  it("Electron IPC with no sender still falls back to the desktop window — the control", async () => {
    await run("library_scan", {}, ctxFor(undefined));
    expect(desktopSends.map((s) => s.channel)).toEqual(["assistant:triggerLibraryScan"]);
  });

  it("shadow_rebuild validates its id before pushing anything", async () => {
    const { sent, sender } = recordingSender();
    for (const bad of [undefined, "3", 3.5, -1, 0]) {
      const res = await run("shadow_rebuild", { shadowLibraryId: bad }, ctxFor("sid-guest", sender));
      expect(res.error).toBeTruthy();
    }
    expect(sent).toEqual([]);
  });
});

describe("usb_device_list", () => {
  it("shows a web caller nothing and never enumerates the host", async () => {
    const res = await run("usb_device_list", {}, ctxFor("sid-guest"));
    expect(res.available).toBe(false);
    expect(res.devices).toEqual([]);
    expect(JSON.stringify(res)).not.toContain("HOST-SERIAL");
    expect(listUsbDevices).not.toHaveBeenCalled();
  });

  it("still enumerates for the desktop — the control", async () => {
    const res = await run("usb_device_list", {}, ctxFor(undefined));
    expect(res.available).toBe(true);
    expect(JSON.stringify(res)).toContain("HOST-SERIAL");
  });
});

describe("ratings_set_tag_priority", () => {
  it("refuses a guest's write, lets it read, and lets the owner write", async () => {
    const owner = identities.addIdentity({ provider: "local", subject: "owner", isOwner: true });
    const guest = identities.addIdentity({ provider: "local", subject: "guest" });
    putSession("sid-owner", owner.id);
    putSession("sid-guest", guest.id);
    prefs.setRatingPrefs({ tagRatingAlwaysWins: false });

    const denied = await run("ratings_set_tag_priority", { enabled: true }, ctxFor("sid-guest"));
    expect(denied.error).toMatch(/owner/i);
    expect(prefs.getRatingPrefs().tagRatingAlwaysWins).toBe(false);

    const read = await run("ratings_set_tag_priority", {}, ctxFor("sid-guest"));
    expect(read.tagRatingAlwaysWins).toBe(false);

    const ok = await run("ratings_set_tag_priority", { enabled: true }, ctxFor("sid-owner"));
    expect(ok.ok).toBe(true);
    expect(prefs.getRatingPrefs().tagRatingAlwaysWins).toBe(true);
  });
});
