/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { normalizeUsbIdentity } from "../main/devices/devices-core";
import {
  parseIoregOutput,
  parsePnpJson,
  readSysfsUsbDevices,
  normalizeUsbId,
  usbDeviceMatches,
  type UsbDeviceInfo,
} from "../main/devices/usb-devices";

/**
 * Trimmed from real `ioreg -r -c IOUSBHostDevice -d 2 -l` output on macOS.
 * Formatting (indentation, decimal ids, quoting) is preserved verbatim.
 *
 * Covers the three cases that matter: a device with a serial, a hub that
 * reports none, and a mass-storage device (bInterfaceClass 8).
 */
const IOREG_FIXTURE = `+-o IOUSBHostDevice@00100000  <class IOUSBHostDevice, id 0x10030c48c, registered, matched, active, busy 0 (138 ms), retain 37>
  {
    "Device Speed" = 2
    "USB Serial Number" = "6E060851DFF2"
    "idProduct" = 33858
    "idVendor" = 1105
    "IOObjectClass" = "IOUSBHostDevice"
  }

+-o USB2.0 Hub@00110000  <class IOUSBHostDevice, id 0x10030c4ac, registered, matched, active, busy 0 (77 ms), retain 31>
  {
    "USB Product Name" = "USB2.0 Hub"
    "idProduct" = 1544
    "idVendor" = 1507
    "bInterfaceClass" = 9
  }

+-o iPod@00120000  <class IOUSBHostDevice, id 0x10030c502, registered, matched, active, busy 0 (16 ms), retain 30>
  {
    "USB Product Name" = "iPod"
    "USB Vendor Name" = "Apple Inc."
    "USB Serial Number" = "000A2700174C1B2E"
    "idProduct" = 4705
    "idVendor" = 1452
    "bInterfaceClass" = 8
  }

+-o Logitech BRIO@00130000  <class IOUSBHostDevice, id 0x10030c503, registered, matched, active, busy 0 (16 ms), retain 30>
  {
    "USB Product Name" = "Logitech BRIO"
    "USB Serial Number" = "53CF164A"
    "idProduct" = 2142
    "idVendor" = 1133
    "bInterfaceClass" = 14
  }
`;

function byProduct(devices: UsbDeviceInfo[], productId: string): UsbDeviceInfo {
  const found = devices.find((d) => d.productId === productId);
  if (!found) throw new Error(`no device with productId ${productId}`);
  return found;
}

describe("normalizeUsbId", () => {
  it("converts ioreg's decimal ids to 4-digit hex", () => {
    expect(normalizeUsbId(1452)).toBe("05ac"); // Apple
    expect(normalizeUsbId(1133)).toBe("046d"); // Logitech
  });

  it("keeps leading zeros when parsing hex", () => {
    expect(normalizeUsbId("05AC", true)).toBe("05ac");
    expect(normalizeUsbId("5ac", true)).toBe("05ac");
    expect(normalizeUsbId("0x05ac", true)).toBe("05ac");
  });

  it("rejects empty, out-of-range and non-numeric values", () => {
    expect(normalizeUsbId("")).toBeNull();
    expect(normalizeUsbId(null)).toBeNull();
    expect(normalizeUsbId(0x10000)).toBeNull();
    expect(normalizeUsbId("zz", true)).toBeNull();
  });
});

describe("parseIoregOutput (macOS)", () => {
  const devices = parseIoregOutput(IOREG_FIXTURE);

  it("returns one entry per registry root", () => {
    expect(devices).toHaveLength(4);
  });

  it("converts decimal vendor/product ids to hex", () => {
    const ipod = byProduct(devices, "1261");
    expect(ipod.vendorId).toBe("05ac");
  });

  it("recognizes a known iPod model from its VID:PID", () => {
    expect(byProduct(devices, "1261").ipodModel).toBe("iPod classic (6th generation)");
  });

  it("leaves ipodModel null for non-Apple devices", () => {
    expect(byProduct(devices, "085e").ipodModel).toBeNull();
  });

  it("reads serial numbers", () => {
    expect(byProduct(devices, "1261").serial).toBe("000A2700174C1B2E");
  });

  it("uses an empty string, not null, when no serial is reported", () => {
    expect(byProduct(devices, "0608").serial).toBe("");
  });

  it("flags mass-storage devices via bInterfaceClass 8", () => {
    expect(byProduct(devices, "1261").isStorage).toBe(true);
    expect(byProduct(devices, "0608").isStorage).toBe(false); // hub, class 9
    expect(byProduct(devices, "085e").isStorage).toBe(false); // webcam, class 14
  });

  it("does not leak the generic registry class name as a product name", () => {
    // The first fixture entry has no "USB Product Name" and its registry entry
    // is the bare class name — that must not surface in the dropdown.
    expect(byProduct(devices, "8442").productName).toBe("");
  });

  it("falls back to the registry entry name when it is meaningful", () => {
    expect(byProduct(devices, "085e").productName).toBe("Logitech BRIO");
  });

  it("returns nothing for empty or unrelated input", () => {
    expect(parseIoregOutput("")).toEqual([]);
    expect(parseIoregOutput("not ioreg output")).toEqual([]);
  });
});

describe("parsePnpJson (Windows)", () => {
  it("splits VID, PID and serial out of a PNPDeviceID", () => {
    const devices = parsePnpJson(
      JSON.stringify([
        {
          PNPDeviceID: "USB\\VID_05AC&PID_1261\\000A2700174C1B2E",
          Name: "Apple iPod USB Device",
          Service: "USBSTOR",
        },
      ])
    );
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      vendorId: "05ac",
      productId: "1261",
      serial: "000A2700174C1B2E",
      isStorage: true,
      ipodModel: "iPod classic (6th generation)",
    });
  });

  it("discards Windows' synthetic instance ids, which are not serials", () => {
    // When a device reports no serial, Windows substitutes "<port>&<hub>".
    const devices = parsePnpJson(
      JSON.stringify([{ PNPDeviceID: "USB\\VID_05E3&PID_0608\\6&1a2b3c4d&0&1" }])
    );
    expect(devices[0].serial).toBe("");
  });

  it("accepts a bare object, which ConvertTo-Json emits for a single match", () => {
    const devices = parsePnpJson(
      JSON.stringify({ PNPDeviceID: "USB\\VID_046D&PID_085E\\53CF164A" })
    );
    expect(devices).toHaveLength(1);
    expect(devices[0].vendorId).toBe("046d");
  });

  it("collapses the multiple PNP entities a single unit reports", () => {
    const id = "USB\\VID_05AC&PID_1261\\000A2700174C1B2E";
    const devices = parsePnpJson(
      JSON.stringify([{ PNPDeviceID: id }, { PNPDeviceID: id }])
    );
    expect(devices).toHaveLength(1);
  });

  it("ignores non-USB entries and malformed JSON", () => {
    expect(parsePnpJson(JSON.stringify([{ PNPDeviceID: "PCI\\VEN_8086" }]))).toEqual([]);
    expect(parsePnpJson("<not json>")).toEqual([]);
  });
});

describe("readSysfsUsbDevices (Linux)", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-sysfs-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeDevice(
    name: string,
    attrs: Record<string, string>,
    interfaces: Record<string, string> = {}
  ) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    for (const [k, v] of Object.entries(attrs)) fs.writeFileSync(path.join(dir, k), `${v}\n`);
    for (const [iface, cls] of Object.entries(interfaces)) {
      const idir = path.join(dir, iface);
      fs.mkdirSync(idir, { recursive: true });
      fs.writeFileSync(path.join(idir, "bInterfaceClass"), `${cls}\n`);
    }
  }

  it("reads hex ids, serial and names, and detects storage interfaces", () => {
    writeDevice(
      "1-1",
      { idVendor: "05ac", idProduct: "1261", serial: "000A2700174C1B2E", product: "iPod", manufacturer: "Apple" },
      { "1-1:1.0": "08" }
    );
    const devices = readSysfsUsbDevices(root);
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      vendorId: "05ac",
      productId: "1261",
      serial: "000A2700174C1B2E",
      productName: "iPod",
      isStorage: true,
      ipodModel: "iPod classic (6th generation)",
    });
  });

  it("skips interface nodes, which have no idVendor", () => {
    writeDevice("1-1", { idVendor: "05ac", idProduct: "1261" });
    writeDevice("1-1:1.0", { bInterfaceClass: "08" });
    expect(readSysfsUsbDevices(root)).toHaveLength(1);
  });

  it("uses an empty serial when the device reports none", () => {
    writeDevice("1-2", { idVendor: "05e3", idProduct: "0608" }, { "1-2:1.0": "09" });
    const devices = readSysfsUsbDevices(root);
    expect(devices[0].serial).toBe("");
    expect(devices[0].isStorage).toBe(false);
  });

  it("returns nothing when sysfs is unreadable", () => {
    expect(readSysfsUsbDevices(path.join(root, "does-not-exist"))).toEqual([]);
  });
});

describe("usbDeviceMatches", () => {
  const ipod: UsbDeviceInfo = {
    vendorId: "05ac",
    productId: "1261",
    serial: "SERIAL_A",
    productName: "iPod",
    vendorName: "Apple",
    isStorage: true,
    ipodModel: "iPod classic (6th generation)",
  };

  it("matches on an exact VID, PID and serial", () => {
    expect(usbDeviceMatches(ipod, "05ac", "1261", "SERIAL_A")).toBe(true);
  });

  it("rejects a different unit of the same model", () => {
    expect(usbDeviceMatches(ipod, "05ac", "1261", "SERIAL_B")).toBe(false);
  });

  it("rejects a different model from the same vendor", () => {
    expect(usbDeviceMatches(ipod, "05ac", "1262", "SERIAL_A")).toBe(false);
  });

  it("falls back to model-level matching when no serial was stored", () => {
    // This is the documented degradation: two identical units would collide.
    expect(usbDeviceMatches(ipod, "05ac", "1261", "")).toBe(true);
  });
});

/**
 * The three columns are one value. A device that is bound to a USB unit is only
 * "connected" when that unit is present, so silently dropping the binding turns
 * a mount-path collision back into a sync aimed at the wrong volume — which is
 * the whole thing the feature exists to prevent.
 */
describe("normalizeUsbIdentity", () => {
  it("canonicalizes both ids to lowercase 4-digit hex", () => {
    expect(normalizeUsbIdentity("05AC", "1261", "SERIAL")).toEqual({
      vendorId: "05ac",
      productId: "1261",
      serial: "SERIAL",
    });
  });

  it("keeps an empty serial as '' so the uniqueness index still applies", () => {
    expect(normalizeUsbIdentity("05ac", "1261", null)?.serial).toBe("");
  });

  it("returns null when all three are absent — the clear-the-binding case", () => {
    expect(normalizeUsbIdentity(null, null, null)).toBeNull();
    expect(normalizeUsbIdentity(undefined, undefined, undefined)).toBeNull();
    expect(normalizeUsbIdentity("", "", "")).toBeNull();
  });

  it("rejects a vendor id with no product id, and the reverse", () => {
    expect(() => normalizeUsbIdentity("05ac", null, "S")).toThrow(
      /vendor id and a product id/i
    );
    expect(() => normalizeUsbIdentity(null, "1261", "S")).toThrow(
      /vendor id and a product id/i
    );
  });

  // A serial on its own reads as an edit to a bound device, not as a request to
  // unbind it. Treating it as a clear is how a binding disappears unannounced.
  it("rejects a serial supplied on its own instead of clearing the binding", () => {
    expect(() => normalizeUsbIdentity(null, null, "SERIAL")).toThrow(
      /cannot be set on its own/i
    );
  });

  it("rejects ids that are not 4-digit hex", () => {
    expect(() => normalizeUsbIdentity("zzzz", "1261", "")).toThrow(/4-digit hex/i);
    expect(() => normalizeUsbIdentity("05ac", "1ffff", "")).toThrow(/4-digit hex/i);
  });
});
