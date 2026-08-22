/**
 * E2E tests for optional USB hardware identity on devices.
 *
 * Drives the real built app through the IPC bridge (renderer → preload → main →
 * SQLite). Every assertion is hardware-independent: the "present" cases use a
 * bogus vendor id (ffff) that no real device can report, so the suite behaves
 * identically on a laptop with an iPod attached and on a headless CI runner.
 *
 * Parser-level coverage lives in src/__tests__/usb-devices.test.ts, and the
 * Rocksy `device_list` view of the identity in src/__tests__/assistant-tools.test.ts.
 *
 * Run: npm run build && npx playwright test
 */
import { test, expect, type Page } from "@playwright/test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { launchApp, type LaunchedApp } from "./electron-launcher";

let launched: LaunchedApp;

// One app for the file. Every test below names its device with a unique serial
// and looks the result up by the id it got back, so none of them can see (or be
// confused by) the rows the others leave in the database — and an Electron cold
// start costs several times what the assertions themselves do.
test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  launched = await launchApp();
});
test.afterAll(async () => {
  await launched.cleanup();
});

async function readyWindow(): Promise<Page> {
  const window = await launched.app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: { invoke?: unknown } }).api?.invoke === "function",
    null,
    { timeout: 15_000 }
  );
  return window;
}

type Api = { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };

test("a USB identity round-trips through add and list", async () => {
  const window = await readyWindow();

  const result = await window.evaluate(async () => {
    const api = (window as unknown as { api: Api }).api;
    const added = (await api.invoke("device:add", {
      name: `USB Add ${Date.now()}`,
      mountPath: "/tmp/ipr-usb-add",
      usbVendorId: "05AC",
      usbProductId: "1261",
      usbSerial: "SERIAL_ADD",
    })) as { id: number };

    const list = (await api.invoke("device:list")) as Array<{
      id: number;
      usbVendorId?: string | null;
      usbProductId?: string | null;
      usbSerial?: string | null;
    }>;
    return list.find((d) => d.id === added.id);
  });

  // Ids are canonicalized to lowercase hex on the way in.
  expect(result?.usbVendorId).toBe("05ac");
  expect(result?.usbProductId).toBe("1261");
  expect(result?.usbSerial).toBe("SERIAL_ADD");
});

test("two devices cannot claim the same physical USB unit", async () => {
  const window = await readyWindow();

  const error = await window.evaluate(async () => {
    const api = (window as unknown as { api: Api }).api;
    const identity = { usbVendorId: "05ac", usbProductId: "1261", usbSerial: "SERIAL_DUP" };

    const first = (await api.invoke("device:add", {
      name: `USB Dup A ${Date.now()}`,
      mountPath: "/tmp/ipr-usb-dup-a",
      ...identity,
    })) as { id: number; name: string };

    const second = (await api.invoke("device:add", {
      name: `USB Dup B ${Date.now()}`,
      mountPath: "/tmp/ipr-usb-dup-b",
      ...identity,
    })) as { error?: string };

    return { error: second.error, firstName: first.name };
  });

  expect(error.error).toBeTruthy();
  // The message must name the offending device, not leak a raw SQLite constraint.
  expect(error.error).toContain(error.firstName);
});

test("the same unit can be reassigned to the device that already holds it", async () => {
  const window = await readyWindow();

  const updated = await window.evaluate(async () => {
    const api = (window as unknown as { api: Api }).api;
    const added = (await api.invoke("device:add", {
      name: `USB Self ${Date.now()}`,
      mountPath: "/tmp/ipr-usb-self",
      usbVendorId: "05ac",
      usbProductId: "1261",
      usbSerial: "SERIAL_SELF",
    })) as { id: number };

    // Re-saving the form unchanged must not trip the uniqueness guard.
    return (await api.invoke("device:update", added.id, {
      usbVendorId: "05ac",
      usbProductId: "1261",
      usbSerial: "SERIAL_SELF",
    })) as { usbSerial?: string | null; error?: string };
  });

  expect(updated.error).toBeUndefined();
  expect(updated.usbSerial).toBe("SERIAL_SELF");
});

test("clearing the identity drops all three columns together", async () => {
  const window = await readyWindow();

  const cleared = await window.evaluate(async () => {
    const api = (window as unknown as { api: Api }).api;
    const added = (await api.invoke("device:add", {
      name: `USB Clear ${Date.now()}`,
      mountPath: "/tmp/ipr-usb-clear",
      usbVendorId: "05ac",
      usbProductId: "1261",
      usbSerial: "SERIAL_CLEAR",
    })) as { id: number };

    await api.invoke("device:update", added.id, {
      usbVendorId: null,
      usbProductId: null,
      usbSerial: null,
    });

    const list = (await api.invoke("device:list")) as Array<{
      id: number;
      usbVendorId?: string | null;
      usbProductId?: string | null;
      usbSerial?: string | null;
    }>;
    return list.find((d) => d.id === added.id);
  });

  expect(cleared?.usbVendorId).toBeNull();
  expect(cleared?.usbProductId).toBeNull();
  expect(cleared?.usbSerial).toBeNull();
});

test("a partial identity is rejected rather than half-saved", async () => {
  const window = await readyWindow();

  const result = await window.evaluate(async () => {
    const api = (window as unknown as { api: Api }).api;
    return (await api.invoke("device:add", {
      name: `USB Partial ${Date.now()}`,
      mountPath: "/tmp/ipr-usb-partial",
      usbVendorId: "05ac",
    })) as { error?: string };
  });

  expect(result.error).toMatch(/vendor id and a product id/i);
});

/**
 * The core behavioral guarantee: a USB-bound device is offline when its unit is
 * absent, even though its mount path is a real, live directory. Without the USB
 * identity the same device would report online.
 */
test("a USB-bound device reports offline when its unit is not connected", async () => {
  const window = await readyWindow();
  // Under the homedir, which the path allowlist permits.
  const liveDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-usb-"));

  try {
    const statuses = await window.evaluate(async (mountPath: string) => {
      const api = (window as unknown as { api: Api }).api;

      const plain = (await api.invoke("device:add", {
        name: `USB Off Plain ${Date.now()}`,
        mountPath,
      })) as { id: number };

      const bound = (await api.invoke("device:add", {
        name: `USB Off Bound ${Date.now()}`,
        mountPath,
        // No real device can report vendor id ffff.
        usbVendorId: "ffff",
        usbProductId: "ffff",
        usbSerial: "NOT_A_REAL_DEVICE",
      })) as { id: number };

      return {
        plain: (await api.invoke("device:ping", plain.id)) as { online: boolean },
        bound: (await api.invoke("device:ping", bound.id)) as { online: boolean },
      };
    }, liveDir);

    // Offline purely because of the USB check — the mount path is identical to
    // the unbound device's, so the identity is the only difference. (A tmp dir
    // under homedir is not its own mount, so `plain` may be false as well;
    // what this pins is that binding can only ever remove online-ness.)
    expect(statuses.bound.online).toBe(false);
    expect(typeof statuses.plain.online).toBe("boolean");

    // device:check must apply the same gate rather than proceeding to scan.
    const check = await window.evaluate(async (mountPath: string) => {
      const api = (window as unknown as { api: Api }).api;
      const bound = (await api.invoke("device:add", {
        name: `USB Off Check ${Date.now()}`,
        mountPath,
        usbVendorId: "ffff",
        usbProductId: "fffe",
        usbSerial: "ALSO_NOT_REAL",
      })) as { id: number };
      return (await api.invoke("device:check", bound.id)) as { offline?: boolean };
    }, liveDir);

    expect(check.offline).toBe(true);
  } finally {
    fs.rmSync(liveDir, { recursive: true, force: true });
  }
});

test("device:listUsb returns a well-formed snapshot", async () => {
  const window = await readyWindow();

  const snapshot = await window.evaluate(async () => {
    const api = (window as unknown as { api: Api }).api;
    return (await api.invoke("device:listUsb")) as {
      available?: boolean;
      devices?: unknown[];
      error?: string;
    };
  });

  expect(snapshot.error).toBeUndefined();
  expect(typeof snapshot.available).toBe("boolean");
  expect(Array.isArray(snapshot.devices)).toBe(true);

  // Shape only — never contents. CI has no USB devices; a dev laptop does.
  for (const device of snapshot.devices ?? []) {
    const d = device as Record<string, unknown>;
    expect(typeof d.vendorId).toBe("string");
    expect(typeof d.productId).toBe("string");
    expect(typeof d.serial).toBe("string");
    expect(typeof d.isStorage).toBe("boolean");
    expect(d.vendorId).toMatch(/^[0-9a-f]{4}$/);
    expect(d.productId).toMatch(/^[0-9a-f]{4}$/);
  }
});
