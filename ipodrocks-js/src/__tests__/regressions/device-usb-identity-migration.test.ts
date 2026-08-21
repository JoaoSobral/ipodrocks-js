/**
 * @vitest-environment node
 *
 * Regression: v2.3.0 failed to open any pre-existing database with
 * "SqliteError: no such column: usb_vendor_id", so upgrading users could not
 * launch the app at all.
 *
 * Root cause — the partial unique index for the new USB identity columns was
 * added to `SCHEMA_SQL`. That whole script is `exec`'d at the top of
 * `initialize()`, before any migration runs. On a fresh install the columns come
 * from the same script so it worked; on an existing database
 * `CREATE TABLE IF NOT EXISTS devices` is a no-op, the columns are absent, and
 * `CREATE UNIQUE INDEX ... ON devices(usb_vendor_id, ...)` throws and takes the
 * entire initialize() down with it.
 *
 * Fix — the index is created by `migrateDeviceUsbIdentity()` instead, right
 * after the `ALTER TABLE ... ADD COLUMN` statements that make it valid.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

vi.mock("electron", () => ({ app: { getPath: () => os.tmpdir() } }));

import { AppDatabase } from "../../main/database/database";
import { SCHEMA_SQL } from "../../main/database/schema";

/**
 * Build a database that looks like one written by a pre-USB-identity release:
 * the real schema, with the three USB columns stripped back out of `devices`.
 */
function createLegacyDatabase(dbPath: string): void {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA_SQL);
  for (const column of ["usb_vendor_id", "usb_product_id", "usb_serial"]) {
    db.prepare(`ALTER TABLE devices DROP COLUMN ${column}`).run();
  }
  const columns = (db.prepare("PRAGMA table_info(devices)").all() as { name: string }[]).map(
    (r) => r.name
  );
  if (columns.includes("usb_vendor_id")) {
    throw new Error("fixture setup failed: legacy DB still has usb_vendor_id");
  }
  db.close();
}

function deviceColumns(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare("PRAGMA table_info(devices)").all() as { name: string }[];
  db.close();
  return rows.map((r) => r.name);
}

describe("USB identity migration on an existing database", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-usb-migration-"));
    dbPath = path.join(dir, "ipodrock.db");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("opens a pre-USB-identity database without throwing", () => {
    createLegacyDatabase(dbPath);

    const app = new AppDatabase(dbPath);
    // This is the exact call that used to throw "no such column: usb_vendor_id".
    expect(() => app.initialize()).not.toThrow();
    app.close();
  });

  it("adds the three USB columns to an existing devices table", () => {
    createLegacyDatabase(dbPath);

    const app = new AppDatabase(dbPath);
    app.initialize();
    app.close();

    const columns = deviceColumns(dbPath);
    expect(columns).toContain("usb_vendor_id");
    expect(columns).toContain("usb_product_id");
    expect(columns).toContain("usb_serial");
  });

  it("creates the uniqueness index on both upgraded and fresh databases", () => {
    for (const legacy of [true, false]) {
      const p = path.join(dir, `${legacy ? "legacy" : "fresh"}.db`);
      if (legacy) createLegacyDatabase(p);

      const app = new AppDatabase(p);
      app.initialize();
      app.close();

      const db = new Database(p, { readonly: true });
      const index = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get("idx_devices_usb_identity");
      db.close();

      expect(index, `index missing on ${legacy ? "upgraded" : "fresh"} database`).toBeTruthy();
    }
  });

  it("is idempotent across repeated launches", () => {
    createLegacyDatabase(dbPath);

    for (let launch = 0; launch < 3; launch++) {
      const app = new AppDatabase(dbPath);
      expect(() => app.initialize(), `launch ${launch + 1} threw`).not.toThrow();
      app.close();
    }

    expect(deviceColumns(dbPath).filter((c) => c === "usb_vendor_id")).toHaveLength(1);
  });

  it("preserves existing device rows, leaving them on mount-path matching", () => {
    createLegacyDatabase(dbPath);

    const seed = new Database(dbPath);
    // SCHEMA_SQL already seeds the 'copy' transfer mode.
    const modeId = (
      seed.prepare("SELECT id FROM device_transfer_modes WHERE name = 'copy'").get() as {
        id: number;
      }
    ).id;
    seed
      .prepare(
        "INSERT INTO devices (name, mount_path, default_transfer_mode_id) VALUES (?, ?, ?)"
      )
      .run("Legacy iPod", "/Volumes/IPOD", modeId);
    seed.close();

    const app = new AppDatabase(dbPath);
    app.initialize();
    app.close();

    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare("SELECT name, mount_path, usb_vendor_id FROM devices WHERE name = ?")
      .get("Legacy iPod") as { name: string; mount_path: string; usb_vendor_id: string | null };
    db.close();

    expect(row.mount_path).toBe("/Volumes/IPOD");
    // Null identity is what keeps upgraded devices behaving exactly as before.
    expect(row.usb_vendor_id).toBeNull();
  });
});
