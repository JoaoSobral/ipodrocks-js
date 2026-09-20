/**
 * Regression — a native dialog belongs to whoever is sitting at the host, and a
 * browser is not.
 *
 * Reported from a real setup: adding a device in the browser and pressing
 * **Browse** opened a **Finder window on the server's Mac**, while the browser
 * sat there waiting. The desktop app was hosting the web server, so the host
 * genuinely *did* have dialogs — `app:hasNativeDialogs` asked the host, got
 * `true`, and `pickFolder()` duly invoked `dialog:pickFolder`.
 *
 * Two things make that worse than a cosmetic wrong answer:
 *
 *  - the remote user's click resolves only if somebody physically at the server
 *    dismisses the sheet, so the browser hangs indefinitely; and
 *  - the sheet is **modal**, so any authenticated remote client could freeze
 *    the host's window at will, over and over.
 *
 * The capability belongs to the *client*, not the host, and `ctx.sessionId` is
 * the only honest way to tell them apart — the web transport sets it, Electron
 * IPC does not.
 *
 * **`tests/e2e/web-parity.test.ts` cannot catch this and never could.** The
 * `web` Playwright project boots the headless daemon, whose host reports no
 * dialogs at all, so both the broken and the fixed code answer `false` there.
 * Only a host that *has* dialogs — an Electron one — exposes it, which is what
 * the harness registers (`dialogs.available: true`).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installElectronMock, setupIpcSession } from "../harness/ipc-harness";
import type { IpcSession } from "../harness/ipc-harness";

installElectronMock();

let dir: string;
let session: IpcSession;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-native-dialogs-"));
  // The harness maps `app.getPath("userData")` to `<dir>/userData`, and the
  // database opens there the first time a handler touches the library.
  fs.mkdirSync(path.join(dir, "userData"), { recursive: true });
  session = await setupIpcSession({ userDataDir: dir });
});

afterEach(() => {
  session.cleanup();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("app:hasNativeDialogs", () => {
  it("is true for the desktop window on a host that has them", async () => {
    // The control. The harness host sets `dialogs.available: true`, which is
    // the Electron case — so a false here would mean the fix had simply turned
    // the feature off for everyone.
    const res = await session.invoke<{ available: boolean }>("app:hasNativeDialogs");
    expect(res.available).toBe(true);
  });

  it("is false for a web client even when the host has them", async () => {
    const res = await session.invokeAsWebClient<{ available: boolean }>(
      "app:hasNativeDialogs"
    );
    expect(res.available).toBe(false);
  });
});

describe("dialog:pickFolder", () => {
  it("refuses a web client rather than opening a sheet on the server", async () => {
    const res = await session.invokeAsWebClient<{ error?: string }>(
      "dialog:pickFolder"
    );
    expect(res?.error).toBeTruthy();
    // It has to point at what the browser should do instead, or the user's
    // conclusion is "the Browse button is broken".
    expect(res!.error).toMatch(/browser/i);
  });

  it("still answers the desktop window", async () => {
    // The harness host's `pickFolder` resolves to null (the user cancelled),
    // which is a perfectly ordinary answer and — crucially — not an `{ error }`.
    const res = await session.invoke<string | null | { error?: string }>(
      "dialog:pickFolder"
    );
    expect(res).toBeNull();
  });
});
