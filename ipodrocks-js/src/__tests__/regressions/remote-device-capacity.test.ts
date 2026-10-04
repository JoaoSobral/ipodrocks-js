/**
 * @vitest-environment node
 *
 * A remote device's storage figures.
 *
 * The File System Access API cannot read a disk's size, and the old answer —
 * `navigator.storage.estimate()` — was the browser's own origin quota, so a
 * remote iPod rendered as "0.0 GB / 10.0 GB". Now used space is measured by
 * summing the device's files and the total is a capacity the user entered in
 * the profile (`devices.capacity_gb`, GB = 1024^3, up to 4 decimals).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

vi.mock("electron", () => ({ app: { getPath: () => os.tmpdir() } }));

import { AppDatabase } from "../../main/database/database";
import { SCHEMA_SQL } from "../../main/database/schema";
import { sanitizeCapacityGb } from "../../main/devices/devices-core";
import { Device } from "../../main/devices/device";
import type { DeviceFs, DeviceTreeEntry } from "../../main/devices/fs/device-fs";
import type { DeviceProfile } from "../../shared/types";

const GIB = 1024 ** 3;

describe("sanitizeCapacityGb", () => {
  it("keeps up to four decimals", () => {
    expect(sanitizeCapacityGb(1.2345)).toBe(1.2345);
    expect(sanitizeCapacityGb("74.5341")).toBe(74.5341);
    expect(sanitizeCapacityGb(80)).toBe(80);
  });

  it("rounds anything finer to four decimals", () => {
    expect(sanitizeCapacityGb(1.23456)).toBe(1.2346);
  });

  it("reads empty as cleared", () => {
    expect(sanitizeCapacityGb(null)).toBeNull();
    expect(sanitizeCapacityGb(undefined)).toBeNull();
    expect(sanitizeCapacityGb("")).toBeNull();
    expect(sanitizeCapacityGb("   ")).toBeNull();
  });

  it("refuses what is not a positive size", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "abc", "1,5", 100_001]) {
      expect(() => sanitizeCapacityGb(bad), String(bad)).toThrow(/positive number of GB/);
    }
  });
});

describe("capacity_gb migration on an existing database", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-capacity-migration-"));
    dbPath = path.join(dir, "ipodrock.db");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("adds the column to a database from before it existed", () => {
    const legacy = new Database(dbPath);
    legacy.exec(SCHEMA_SQL);
    legacy.prepare("ALTER TABLE devices DROP COLUMN capacity_gb").run();
    legacy.close();

    const app = new AppDatabase(dbPath);
    expect(() => app.initialize()).not.toThrow();
    app.close();

    const db = new Database(dbPath, { readonly: true });
    const cols = (db.prepare("PRAGMA table_info(devices)").all() as { name: string }[]).map(
      (r) => r.name
    );
    db.close();
    expect(cols).toContain("capacity_gb");
  });
});

describe("max_parallel_copies migration on an existing database", () => {
  it("adds the column to a database from before it existed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-parallel-migration-"));
    const dbPath = path.join(dir, "ipodrock.db");
    try {
      const legacy = new Database(dbPath);
      legacy.exec(SCHEMA_SQL);
      legacy.prepare("ALTER TABLE devices DROP COLUMN max_parallel_copies").run();
      legacy.close();

      const app = new AppDatabase(dbPath);
      expect(() => app.initialize()).not.toThrow();
      app.close();

      const db = new Database(dbPath, { readonly: true });
      const cols = (db.prepare("PRAGMA table_info(devices)").all() as { name: string }[]).map(
        (r) => r.name
      );
      db.close();
      expect(cols).toContain("max_parallel_copies");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** A browser-held device's filesystem, reduced to what the space read uses. */
function remoteFs(files: number[], opts: { detached?: boolean } = {}): DeviceFs {
  return {
    capabilities: { setMtime: false, freeSpace: false, eject: false, overNetwork: true },
    async freeSpace() {
      throw new Error("must not be asked: a browser cannot read a disk's size");
    },
    async listTree(_dir: string, o?: { onEntry?: (e: DeviceTreeEntry) => void }) {
      if (opts.detached) {
        throw Object.assign(new Error("detached"), { code: "EDEVICEDETACHED" });
      }
      const out = files.map((size, i) => ({
        path: `/ipodrocks-web/1/f${i}`,
        name: `f${i}`,
        isDirectory: false,
        size,
        mtimeMs: 0,
      }));
      out.forEach((e) => o?.onEntry?.(e));
      return out;
    },
  } as unknown as DeviceFs;
}

function profile(capacityGb: number | null): DeviceProfile {
  return {
    id: 1,
    name: "Remote",
    mountPath: "/ipodrocks-web/1",
    transport: "web",
    capacityGb,
  } as DeviceProfile;
}

describe("Device.getAvailableSpace on a remote device", () => {
  it("measures used space and reports no total without a capacity", async () => {
    const space = await new Device(profile(null), remoteFs([1000, 2000, 500])).getAvailableSpace();
    expect(space.source).toBe("used-only");
    expect(space.usedBytes).toBe(3500);
    expect(space.totalBytes).toBe(0);
    expect(space.freeBytes).toBe(0);
  });

  it("takes the total from the entered capacity, in the app's GB", async () => {
    const space = await new Device(profile(1.2345), remoteFs([GIB / 2])).getAvailableSpace();
    expect(space.source).toBe("estimated");
    expect(space.totalBytes).toBe(Math.round(1.2345 * GIB));
    expect(space.usedBytes).toBe(GIB / 2);
    expect(space.freeBytes).toBe(Math.round(1.2345 * GIB) - GIB / 2);
  });

  it("never reports negative free space when the capacity is too small", async () => {
    const space = await new Device(profile(1), remoteFs([2 * GIB])).getAvailableSpace();
    expect(space.freeBytes).toBe(0);
    expect(space.usedBytes).toBe(2 * GIB);
  });

  it("does not turn a detached browser into an empty device", async () => {
    await expect(
      new Device(profile(80), remoteFs([], { detached: true })).getAvailableSpace()
    ).rejects.toMatchObject({ code: "EDEVICEDETACHED" });
  });
});
