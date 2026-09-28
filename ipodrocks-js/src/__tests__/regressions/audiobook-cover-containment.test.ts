/**
 * @vitest-environment node
 *
 * Regression — a relative `imageUrl` copied arbitrary server files onto a
 * guest's device.
 *
 * `subscribe()` refused only an *absolute* client cover, so
 * `../data/ipodrocks-server.db` was stored verbatim in `image_url`. Every
 * `sync:start` then ran `syncAutoAudiobooksToDevice`, which treated any
 * `image_url` that `fs.existsSync` (against the daemon's cwd) as a cover and
 * handed it to `copyFromLocal()` — on a browser-held device, a stream of the
 * server file to the guest's own browser. The session secret, every live sid
 * and every password hash, in two ordinary API calls.
 *
 * Two fixes, pinned separately: the client string never becomes a path, and
 * the sync copies only a cover contained in the audiobooks root after
 * `realpath`. The control is that a real downloaded cover still arrives.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { installElectronMock, setupIpcSession, type IpcSession } from "../harness/ipc-harness";
import { canRunDbTests, createFakeDevice, type FakeDevice } from "../harness";

installElectronMock();

// No network: the feed and the cover lookups would otherwise go out.
vi.mock("../../main/podcasts/podcast-feed-import", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  fetchAndParseFeed: vi.fn(async () => {
    throw new Error("offline");
  }),
}));
vi.mock("../../main/audiobooks/audiobook-cover", () => ({
  downloadCover: vi.fn(async () => null),
}));
vi.mock("../../main/devices/device-online", () => ({
  isDeviceMountPathOnline: vi.fn().mockReturnValue(true),
  isDeviceOnline: vi.fn().mockReturnValue(true),
  deviceRowToOnlineInput: vi.fn((row) => row),
}));
vi.mock("../../main/devices/usb-devices", () => ({
  refreshUsbSnapshot: vi.fn().mockResolvedValue({ available: false, devices: [] }),
  getUsbSnapshot: vi.fn().mockReturnValue({ available: false, devices: [] }),
  listUsbDevices: vi.fn().mockResolvedValue({ available: false, devices: [] }),
  normalizeUsbId: vi.fn((v) => (v == null || v === "" ? null : String(v))),
  usbDeviceMatches: vi.fn().mockReturnValue(false),
}));

const itDb = it.skipIf(!canRunDbTests);

describe("audiobook covers never name a file outside the audiobooks root", () => {
  let session: IpcSession;
  let root: string;
  let device: FakeDevice;
  let secret: string;

  beforeEach(async () => {
    if (!canRunDbTests) return;
    root = fs.mkdtempSync(path.join(os.homedir(), ".ipodrocks-test-"));
    const userDataDir = path.join(root, "userdata");
    fs.mkdirSync(path.join(userDataDir, "userData"), { recursive: true });
    device = createFakeDevice(root);
    secret = path.join(root, "server-secret.db");
    fs.writeFileSync(secret, "session signing secret");
    session = await setupIpcSession({ userDataDir });
  });

  afterEach(() => {
    session?.cleanup();
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  itDb("audiobook:subscribe stores null for a cover that is not an http(s) URL", async () => {
    const relative = path.relative(process.cwd(), secret);
    const cases: Array<[unknown, string | null]> = [
      [relative, null],
      ["../data/ipodrocks-server.db", null],
      [secret, null],
      ["file:///etc/passwd", null],
      ["javascript:alert(1)", null],
      ["https://covers.example/book.jpg", "https://covers.example/book.jpg"],
    ];
    let id = 900_000;
    for (const [imageUrl, expected] of cases) {
      const sub = await session.invokeAsWebClient<{ id: number; error?: string }>(
        "audiobook:subscribe",
        {
          librivoxId: ++id,
          title: `zq9x ${id}`,
          rssUrl: "https://example.invalid/",
          imageUrl,
          numSections: 0,
          totalSeconds: 0,
        }
      );
      expect(sub.error).toBeUndefined();
      const { getLibraryDb } = await import("../../main/ipc/common");
      const row = getLibraryDb()
        .prepare("SELECT image_url FROM audiobook_subscriptions WHERE id = ?")
        .get(sub.id) as { image_url: string | null };
      expect(row.image_url, String(imageUrl)).toBe(expected);
    }
  });

  itDb("the device sync copies only a cover contained in the audiobooks root", async () => {
    const { getLibraryDb } = await import("../../main/ipc/common");
    const { getAudiobooksRoot } = await import("../../main/audiobooks/audiobook-storage");
    const { syncAutoAudiobooksToDevice } = await import(
      "../../main/audiobooks/audiobook-device-sync"
    );
    const db = getLibraryDb();
    const { id: deviceId } = await session.invoke<{ id: number }>("device:add", {
      name: "Guest Player",
      mountPath: device.mountPath,
    });

    // A real cover this app downloaded, and a symlink inside the root that
    // points back out at the secret.
    const bookDir = path.join(getAudiobooksRoot(), "1");
    fs.mkdirSync(bookDir, { recursive: true });
    const realCover = path.join(bookDir, "cover.jpg");
    fs.writeFileSync(realCover, "jpeg bytes");
    const outsideJpg = path.join(root, "outside.jpg");
    fs.writeFileSync(outsideJpg, "not a cover");
    const linkOut = path.join(bookDir, "link.jpg");
    fs.symlinkSync(outsideJpg, linkOut);

    const insert = db.prepare(
      `INSERT INTO audiobook_subscriptions
         (librivox_id, title, author, image_url, rss_url, num_sections, total_seconds)
       VALUES (?, ?, NULL, ?, 'https://example.invalid/', 0, 0)`
    );
    // Written straight into the table, as a pre-fix database would hold them.
    insert.run(1, "Legit Book", realCover);
    insert.run(2, "Relative Secret", path.relative(process.cwd(), secret));
    insert.run(3, "Absolute Secret", secret);
    insert.run(4, "Outside Jpg", outsideJpg);
    insert.run(5, "Symlink Out", linkOut);
    insert.run(6, "Remote Url", "https://covers.example/book.jpg");

    await syncAutoAudiobooksToDevice(db, deviceId, {
      syncType: "full",
      includeAudiobooks: true,
      selectedLabels: [],
      mode: "include",
    });

    const copied = fs
      .readdirSync(device.audiobooksDir, { recursive: true })
      .map(String)
      .filter((p) => fs.statSync(path.join(device.audiobooksDir, p)).isFile());
    // Control: the genuine cover arrived.
    expect(copied).toEqual([path.join("Legit Book", "cover.jpg")]);
  });
});
