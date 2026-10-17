/**
 * @vitest-environment node
 *
 * The lossless check's columns on a database written by 3.1.0 — the
 * `SCHEMA_SQL` index hazard (CLAUDE.md): `idx_tracks_lossless_verdict` must be
 * created by `migrateLosslessCheck()` after its ALTERs, never in `SCHEMA_SQL`,
 * or every upgrading user's launch dies in `initialize()`.
 *
 * The fixture is a fully initialized database with the new columns stripped
 * back out, not bare `SCHEMA_SQL` — the latter would trip
 * `migrateContentTypeAudiobook()`'s column-list rebuild first (see the debt
 * table in CLAUDE.md).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

vi.mock("electron", () => ({ app: { getPath: () => os.tmpdir() } }));

import { AppDatabase } from "../../main/database/database";

const COLUMNS = [
  "lossless_verdict",
  "lossless_confidence",
  "lossless_cutoff_hz",
  "lossless_source",
  "lossless_stage",
  "lossless_details",
  "lossless_checked_at",
  "lossless_override",
];

function trackColumns(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare("PRAGMA table_info(tracks)").all() as { name: string }[];
  db.close();
  return rows.map((r) => r.name);
}

describe("lossless check migration on a 3.1.0 database", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-lossless-migration-"));
    dbPath = path.join(dir, "ipodrock.db");
    const app = new AppDatabase(dbPath);
    app.initialize();
    app.close();
    const db = new Database(dbPath);
    db.prepare("DROP INDEX IF EXISTS idx_tracks_lossless_verdict").run();
    for (const c of COLUMNS) db.prepare(`ALTER TABLE tracks DROP COLUMN ${c}`).run();
    db.prepare(
      "INSERT INTO tracks (path, filename, title, content_type) VALUES ('/m/a.flac', 'a.flac', 'A', 'music')"
    ).run();
    db.close();
    expect(trackColumns(dbPath)).not.toContain("lossless_verdict");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("opens without throwing, adds every column and the index, and keeps the rows", () => {
    const app = new AppDatabase(dbPath);
    expect(() => app.initialize()).not.toThrow();
    app.close();

    const columns = trackColumns(dbPath);
    for (const c of COLUMNS) expect(columns).toContain(c);
    const db = new Database(dbPath, { readonly: true });
    const index = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_tracks_lossless_verdict'")
      .get();
    const row = db.prepare("SELECT lossless_verdict, lossless_override FROM tracks WHERE path = '/m/a.flac'").get() as {
      lossless_verdict: string | null;
      lossless_override: number;
    };
    db.close();
    expect(index).toBeDefined();
    expect(row).toEqual({ lossless_verdict: null, lossless_override: 0 });
  });

  it("a second launch is a no-op", () => {
    for (let i = 0; i < 2; i++) {
      const app = new AppDatabase(dbPath);
      expect(() => app.initialize()).not.toThrow();
      app.close();
    }
  });
});
