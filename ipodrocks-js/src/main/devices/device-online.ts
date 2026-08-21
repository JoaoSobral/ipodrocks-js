import * as fs from "fs";
import * as path from "path";
import { getUsbSnapshot, usbDeviceMatches } from "./usb-devices";

/**
 * Detect whether a device mount path points at a real connected volume.
 *
 * On macOS/Linux: a real mounted volume always has a different `dev` than its
 * parent directory (because it's a separate filesystem), while a regular folder
 * on the main filesystem (or an orphan directory left behind after ejection)
 * shares the parent's `dev`.
 *
 * `fs.existsSync` alone is not reliable because:
 *   - macOS/Linux can leave an empty orphan directory after ejection
 *   - a local folder named like a device always exists but is not connected
 *
 * On Windows (no POSIX dev ids in a meaningful way), we fall back to checking
 * that the path exists and is a directory; Windows drive letters are naturally
 * isolated so this is sufficient there.
 */
export function isDeviceMountPathOnline(mountPath: string): boolean {
  if (!mountPath) return false;
  try {
    const resolved = path.resolve(mountPath);
    const pathStat = fs.statSync(resolved);
    if (!pathStat.isDirectory()) return false;
    if (process.platform === "win32") return true;
    const parentStat = fs.statSync(path.dirname(resolved));
    return pathStat.dev !== parentStat.dev;
  } catch {
    return false;
  }
}

/**
 * The minimum a caller must supply to resolve connection state.
 *
 * Structural rather than `DeviceProfile` so raw SQLite rows can be adapted with
 * `deviceRowToOnlineInput` instead of being inflated into a full profile.
 */
export interface DeviceOnlineInput {
  mountPath: string;
  devMode?: boolean | number | null;
  usbVendorId?: string | null;
  usbProductId?: string | null;
  usbSerial?: string | null;
}

/** Snake_case device row, as selected directly from the `devices` table. */
export interface DeviceOnlineRow {
  mount_path?: string | null;
  dev_mode?: number | null;
  usb_vendor_id?: string | null;
  usb_product_id?: string | null;
  usb_serial?: string | null;
}

export function deviceRowToOnlineInput(row: DeviceOnlineRow): DeviceOnlineInput {
  return {
    mountPath: row.mount_path ?? "",
    devMode: row.dev_mode,
    usbVendorId: row.usb_vendor_id,
    usbProductId: row.usb_product_id,
    usbSerial: row.usb_serial,
  };
}

/**
 * Is a device connected right now?
 *
 * Two identification modes:
 *
 *  - **No USB identity** (the default) — mount path alone, exactly as before.
 *  - **USB identity set** — the USB unit must be present *and* the mount path
 *    must be a live volume.
 *
 * The mount check is ANDed in rather than replaced because every write still
 * resolves through the mount path (see `Device.getContentPath`). If the right
 * iPod were plugged in but a stale entry held its path — macOS having mounted
 * it at "/Volumes/IPOD 1" instead — a USB-only check would pass the gate and
 * then sync into the wrong volume.
 *
 * Synchronous by design: callers `await refreshUsbSnapshot()` once at entry,
 * then resolve any number of devices against the cached snapshot.
 */
export function isDeviceOnline(device: DeviceOnlineInput): boolean {
  if (device.devMode) return true;

  const mounted = isDeviceMountPathOnline(device.mountPath);
  const vendorId = device.usbVendorId;
  const productId = device.usbProductId;
  if (!vendorId || !productId) return mounted;

  const snapshot = getUsbSnapshot();
  // A failed backend (locked-down PowerShell policy, confined /sys) is not
  // evidence of absence. Degrade to mount matching rather than reporting every
  // USB-bound device permanently offline with no way to recover.
  if (!snapshot.available) return mounted;

  const present = snapshot.devices.some((d) =>
    usbDeviceMatches(d, vendorId, productId, device.usbSerial ?? ""),
  );
  return present && mounted;
}
