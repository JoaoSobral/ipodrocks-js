import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { identifyIpodModel } from "./usb-ipod-models";

/**
 * USB hardware identity for devices.
 *
 * A device row can optionally be pinned to a physical USB unit instead of
 * relying on its mount path alone. Two iPods that both mount at /Volumes/IPOD
 * are indistinguishable by path; their USB serial numbers are not.
 *
 * Deliberately dependency-free: every platform exposes this through a built-in
 * facility, so we avoid a native module (libusb) that would need rebuilding for
 * three platforms on every Electron bump.
 */

/** USB class code for mass storage (bInterfaceClass). */
const USB_CLASS_MASS_STORAGE = 8;

/** How long an enumeration result stays fresh. */
const SNAPSHOT_TTL_MS = 2000;

/** Hard ceiling on how long a backend may take before we give up. */
const ENUMERATION_TIMEOUT_MS = 5000;

export interface UsbDeviceInfo {
  /** Lowercase 4-digit hex, e.g. "05ac". */
  vendorId: string;
  /** Lowercase 4-digit hex, e.g. "1261". */
  productId: string;
  /** Empty string when the device reports no serial — never null. */
  serial: string;
  productName: string;
  vendorName: string;
  isStorage: boolean;
  /** Set when the VID:PID is a recognized iPod model, else null. */
  ipodModel: string | null;
}

/**
 * `available: false` means the platform backend failed (missing binary, locked
 * down PowerShell policy, confined /sys). That is NOT the same as "no devices
 * are plugged in", and callers must treat it differently — see
 * `isDeviceOnline` in device-online.ts.
 */
export interface UsbSnapshot {
  available: boolean;
  devices: UsbDeviceInfo[];
}

const EMPTY_SNAPSHOT: UsbSnapshot = { available: false, devices: [] };

/** Coerce a decimal or hex id into canonical lowercase 4-digit hex. */
export function normalizeUsbId(value: string | number | null | undefined, isHex = false): string | null {
  if (value == null || value === "") return null;
  const raw = String(value).trim().replace(/^0x/i, "");
  if (raw === "") return null;
  const n = isHex ? parseInt(raw, 16) : Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null;
  return n.toString(16).toLowerCase().padStart(4, "0");
}

/** Human-readable identity, e.g. "05ac:1261". */
export function formatUsbIdentity(vendorId: string, productId: string): string {
  return `${vendorId}:${productId}`;
}

/**
 * Does a connected USB device satisfy a stored identity?
 *
 * An empty stored serial means the OS never reported one, so the identity is
 * only model-level (VID+PID) and cannot tell two identical units apart.
 */
export function usbDeviceMatches(
  info: UsbDeviceInfo,
  vendorId: string,
  productId: string,
  serial: string,
): boolean {
  if (info.vendorId !== vendorId || info.productId !== productId) return false;
  if (serial) return info.serial === serial;
  return true;
}

// ---------------------------------------------------------------------------
// Parsers — pure, exported separately from process spawning so they can be
// unit-tested against captured fixtures with no hardware attached.
// ---------------------------------------------------------------------------

/**
 * Parse `ioreg -r -c IOUSBHostDevice -d 2 -l` output (macOS).
 *
 * Depth 2 includes each device's interface nubs, which is what carries
 * `bInterfaceClass` for storage detection, while still emitting exactly one
 * `+-o` root per physical device.
 *
 * Note `system_profiler SPUSBDataType` is NOT used: it returns an empty list on
 * Apple Silicon even with devices attached.
 */
export function parseIoregOutput(text: string): UsbDeviceInfo[] {
  const devices: UsbDeviceInfo[] = [];
  // Split into one block per registry root. The leading chunk is preamble.
  const blocks = text.split(/^\+-o /m).slice(1);

  for (const block of blocks) {
    // idVendor/idProduct are decimal in ioreg's text output.
    const vendorId = normalizeUsbId(/"idVendor"\s*=\s*(\d+)/.exec(block)?.[1]);
    const productId = normalizeUsbId(/"idProduct"\s*=\s*(\d+)/.exec(block)?.[1]);
    if (!vendorId || !productId) continue;

    // The registry entry name is a useful label ("Elgato Wave:3") except when
    // the device never set one and it degrades to the bare class name.
    const headerName = /^([^@\n]+)@/.exec(block)?.[1]?.trim() ?? "";
    const label = headerName === "IOUSBHostDevice" ? "" : headerName;
    devices.push({
      vendorId,
      productId,
      serial: /"USB Serial Number"\s*=\s*"([^"]*)"/.exec(block)?.[1] ?? "",
      productName: /"USB Product Name"\s*=\s*"([^"]*)"/.exec(block)?.[1] ?? label,
      vendorName: /"USB Vendor Name"\s*=\s*"([^"]*)"/.exec(block)?.[1] ?? "",
      isStorage: hasMassStorageClass(block),
      ipodModel: identifyIpodModel(vendorId, productId),
    });
  }
  return devices;
}

function hasMassStorageClass(block: string): boolean {
  const re = /"bInterfaceClass"\s*=\s*(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    if (Number(m[1]) === USB_CLASS_MASS_STORAGE) return true;
  }
  return false;
}

interface PnpEntity {
  PNPDeviceID?: string;
  Name?: string;
  Service?: string;
  Manufacturer?: string;
}

/**
 * Parse `Get-CimInstance Win32_PnPEntity | ConvertTo-Json` output (Windows).
 *
 * PNPDeviceID looks like `USB\VID_05AC&PID_1261\000A2700174C1B2E`. The trailing
 * segment is the serial only when the device reports one; Windows substitutes a
 * synthetic `<port>&<hub>` token (containing `&`) otherwise, which we discard.
 */
export function parsePnpJson(json: string): UsbDeviceInfo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  // ConvertTo-Json emits a bare object rather than an array for a single match.
  const entities: PnpEntity[] = Array.isArray(parsed)
    ? (parsed as PnpEntity[])
    : parsed && typeof parsed === "object"
      ? [parsed as PnpEntity]
      : [];

  const devices: UsbDeviceInfo[] = [];
  const seen = new Set<string>();

  for (const entity of entities) {
    const id = entity?.PNPDeviceID;
    if (!id) continue;
    const m = /^USB\\VID_([0-9A-Fa-f]{4})&PID_([0-9A-Fa-f]{4})(?:\\(.*))?$/.exec(id);
    if (!m) continue;

    const vendorId = normalizeUsbId(m[1], true);
    const productId = normalizeUsbId(m[2], true);
    if (!vendorId || !productId) continue;

    // A synthetic instance id (not a real serial) contains an ampersand.
    const instance = m[3] ?? "";
    const serial = instance && !instance.includes("&") ? instance : "";

    // One PNP entity per interface is common; collapse to one per unit.
    const key = `${vendorId}:${productId}:${serial}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const service = (entity.Service ?? "").toLowerCase();
    devices.push({
      vendorId,
      productId,
      serial,
      productName: entity.Name ?? "",
      vendorName: entity.Manufacturer ?? "",
      isStorage: service === "usbstor" || service === "disk",
      ipodModel: identifyIpodModel(vendorId, productId),
    });
  }
  return devices;
}

/**
 * Read USB devices straight out of sysfs (Linux).
 *
 * No shell and no `lsusb` dependency — usbutils is not installed everywhere.
 * Directories that contain an `idVendor` file are whole devices; interface
 * nodes (`1-1:1.0`) do not, so they are skipped naturally.
 */
export function readSysfsUsbDevices(root = "/sys/bus/usb/devices"): UsbDeviceInfo[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }

  const devices: UsbDeviceInfo[] = [];
  for (const entry of entries) {
    const dir = path.join(root, entry);
    const vendorId = normalizeUsbId(readSysfsAttr(dir, "idVendor"), true);
    const productId = normalizeUsbId(readSysfsAttr(dir, "idProduct"), true);
    if (!vendorId || !productId) continue;

    devices.push({
      vendorId,
      productId,
      serial: readSysfsAttr(dir, "serial") ?? "",
      productName: readSysfsAttr(dir, "product") ?? "",
      vendorName: readSysfsAttr(dir, "manufacturer") ?? "",
      isStorage: sysfsHasStorageInterface(dir, entry),
      ipodModel: identifyIpodModel(vendorId, productId),
    });
  }
  return devices;
}

function readSysfsAttr(dir: string, attr: string): string | null {
  try {
    const value = fs.readFileSync(path.join(dir, attr), "utf8").trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

/** An interface child (`1-1:1.0`) with bInterfaceClass 08 means mass storage. */
function sysfsHasStorageInterface(dir: string, deviceName: string): boolean {
  try {
    for (const child of fs.readdirSync(dir)) {
      if (!child.startsWith(`${deviceName}:`)) continue;
      const cls = readSysfsAttr(path.join(dir, child), "bInterfaceClass");
      if (cls != null && parseInt(cls, 16) === USB_CLASS_MASS_STORAGE) return true;
    }
  } catch {
    /* unreadable interface dir — treat as non-storage */
  }
  return false;
}

// ---------------------------------------------------------------------------
// Platform backends
// ---------------------------------------------------------------------------

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: ENUMERATION_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

const POWERSHELL_QUERY =
  "Get-CimInstance Win32_PnPEntity | " +
  "Where-Object { $_.PNPDeviceID -like 'USB\\VID_*' } | " +
  "Select-Object PNPDeviceID,Name,Service,Manufacturer | " +
  "ConvertTo-Json -Compress";

/**
 * Enumerate currently connected USB devices.
 *
 * Never throws: a failed backend resolves to `{ available: false }` so callers
 * can distinguish "cannot tell" from "nothing plugged in".
 */
export async function listUsbDevices(): Promise<UsbSnapshot> {
  try {
    if (process.platform === "darwin") {
      const out = await run("ioreg", ["-r", "-c", "IOUSBHostDevice", "-d", "2", "-l"]);
      return { available: true, devices: parseIoregOutput(out) };
    }
    if (process.platform === "win32") {
      const out = await run("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        POWERSHELL_QUERY,
      ]);
      return { available: true, devices: parsePnpJson(out) };
    }
    if (process.platform === "linux") {
      // Absent sysfs (confined sandbox) is a backend failure, not an empty bus.
      if (!fs.existsSync("/sys/bus/usb/devices")) return EMPTY_SNAPSHOT;
      return { available: true, devices: readSysfsUsbDevices() };
    }
  } catch (err) {
    console.error("[usb] enumeration failed:", err);
  }
  return EMPTY_SNAPSHOT;
}

// ---------------------------------------------------------------------------
// Snapshot cache
//
// DevicePanel pings every device whenever the list changes, so an uncached
// lookup would mean one PowerShell spawn per device per refresh.
// ---------------------------------------------------------------------------

let cached: UsbSnapshot = EMPTY_SNAPSHOT;
let cachedAt = 0;
let inFlight: Promise<UsbSnapshot> | null = null;

/**
 * Refresh the snapshot if stale. Concurrent callers share one enumeration.
 *
 * There is deliberately no `force` flag. The one caller that must not see a
 * cached answer — `device:listUsb`, behind the "Refresh" button, where the user
 * has just plugged something in — calls {@link listUsbDevices} directly, which
 * is both simpler and stronger: a `force` here would still hand back whatever
 * an already-in-flight enumeration returns, which is exactly the pre-plug
 * snapshot the user is trying to get past.
 */
export async function refreshUsbSnapshot(): Promise<UsbSnapshot> {
  if (Date.now() - cachedAt < SNAPSHOT_TTL_MS) return cached;
  if (inFlight) return inFlight;

  inFlight = listUsbDevices()
    .then((snapshot) => {
      cached = snapshot;
      cachedAt = Date.now();
      return snapshot;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * Read the last known snapshot without touching the OS.
 *
 * Lets presence checks stay synchronous — callers `await refreshUsbSnapshot()`
 * once at entry, then resolve any number of devices against the cache.
 */
export function getUsbSnapshot(): UsbSnapshot {
  return cached;
}

/** Test seam: drop the cache so the next refresh re-enumerates. */
export function resetUsbSnapshotCache(): void {
  cached = EMPTY_SNAPSHOT;
  cachedAt = 0;
  inFlight = null;
}
