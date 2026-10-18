/**
 * @vitest-environment node
 *
 * Year, composer, comment and grouping — stored for the Rockbox database the
 * sync writes. Three things must hold on an upgrade:
 *
 *  - a database from before the columns opens, gains them and gains the opt-in
 *    `device_sync_preferences.build_rockbox_db` (off) without losing rows;
 *  - tracks scanned before then get the four tags from the one-shot backfill,
 *    since the scan's mtime skip would otherwise never re-read them;
 *  - the backfill only ever fills, never clears.
 *
 * The migration fixture is an initialized database with the columns stripped
 * back out, for the `migrateContentTypeAudiobook()` reason in CLAUDE.md.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

vi.mock("electron", () => ({ app: { getPath: () => os.tmpdir() } }));

import { AppDatabase } from "../../main/database/database";
import {
  backfillTagFields,
  isTagFieldsBackfillDone,
} from "../../main/library/tag-fields-backfill";
import {
  parseYear,
  tagFieldsFromCommon,
  tagFieldsFromTagMap,
  type MetadataExtractor,
  type TagFields,
} from "../../main/library/metadata-extractor";

const COLUMNS = ["year", "composer", "comment", "grouping"];

function columns(dbPath: string, table: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  db.close();
  return rows.map((r) => r.name);
}

describe("tag-field columns on an older database", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-tagfields-migration-"));
    dbPath = path.join(dir, "ipodrock.db");
    const app = new AppDatabase(dbPath);
    app.initialize();
    app.close();
    const db = new Database(dbPath);
    for (const c of COLUMNS) db.prepare(`ALTER TABLE tracks DROP COLUMN ${c}`).run();
    db.prepare("ALTER TABLE device_sync_preferences DROP COLUMN build_rockbox_db").run();
    db.prepare(
      "INSERT INTO tracks (path, filename, title, content_type) VALUES ('/m/a.flac', 'a.flac', 'A', 'music')"
    ).run();
    db.close();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("opens without throwing, adds the columns and keeps the rows", () => {
    const app = new AppDatabase(dbPath);
    expect(() => app.initialize()).not.toThrow();
    app.close();

    for (const c of COLUMNS) expect(columns(dbPath, "tracks")).toContain(c);
    expect(columns(dbPath, "device_sync_preferences")).toContain("build_rockbox_db");
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT title, year FROM tracks WHERE path = '/m/a.flac'").get();
    db.close();
    expect(row).toEqual({ title: "A", year: null });
  });
});

describe("tag-field backfill", () => {
  let dir: string;
  let db: Database.Database;
  let tagged: string;
  let untagged: string;
  let alreadyDone: string;

  function stub(fields: Map<string, TagFields | null>): MetadataExtractor {
    return {
      async extractTagFields(p: string) {
        return fields.get(p) ?? null;
      },
    } as unknown as MetadataExtractor;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-tagfields-backfill-"));
    const dbPath = path.join(dir, "ipodrock.db");
    const app = new AppDatabase(dbPath);
    app.initialize();
    app.close();
    db = new Database(dbPath);

    tagged = path.join(dir, "tagged.flac");
    untagged = path.join(dir, "untagged.flac");
    alreadyDone = path.join(dir, "done.flac");
    for (const p of [tagged, untagged, alreadyDone]) fs.writeFileSync(p, "x");

    db.prepare("INSERT INTO artists (id, name) VALUES (1, 'A')").run();
    db.prepare("INSERT INTO albums (id, title, artist_id) VALUES (1, 'Alb', 1)").run();
    const ins = db.prepare(
      "INSERT INTO tracks (path, filename, title, content_type, album_id, composer) VALUES (?, ?, 't', 'music', 1, ?)"
    );
    ins.run(tagged, "tagged.flac", null);
    ins.run(untagged, "untagged.flac", null);
    ins.run(alreadyDone, "done.flac", "Kept");
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fills only tracks with none of the four, and names the album's year", async () => {
    const fields = new Map<string, TagFields | null>([
      [tagged, { year: 1994, composer: "Comp", comment: "Hi", grouping: "G" }],
      [untagged, { year: null, composer: null, comment: null, grouping: null }],
      [alreadyDone, { year: 2000, composer: "Other", comment: null, grouping: null }],
    ]);
    const result = await backfillTagFields(db, stub(fields));
    expect(result).toMatchObject({ processed: 2, updated: 1, skipped: false });

    const get = (p: string) =>
      db.prepare("SELECT year, composer, comment, grouping FROM tracks WHERE path = ?").get(p);
    expect(get(tagged)).toEqual({ year: 1994, composer: "Comp", comment: "Hi", grouping: "G" });
    expect(get(untagged)).toEqual({ year: null, composer: null, comment: null, grouping: null });
    expect(get(alreadyDone)).toEqual({ year: null, composer: "Kept", comment: null, grouping: null });
    expect(db.prepare("SELECT year FROM albums WHERE id = 1").get()).toEqual({ year: 1994 });

    expect(isTagFieldsBackfillDone(db)).toBe(true);
    expect((await backfillTagFields(db, stub(fields))).skipped).toBe(true);
  });
});

describe("tag-field extraction", () => {
  it("reads music-metadata's common block, with either comment shape", () => {
    expect(
      tagFieldsFromCommon({
        year: 1994,
        composer: ["Bach"],
        comment: [{ text: "Live" }],
        grouping: "Suite",
      })
    ).toEqual({ year: 1994, composer: "Bach", comment: "Live", grouping: "Suite" });
    expect(
      tagFieldsFromCommon({ date: "2003-05-01", comment: ["plain"] } as never)
    ).toMatchObject({ year: 2003, comment: "plain", composer: null, grouping: null });
  });

  it("reads an ffprobe tag map case-insensitively", () => {
    expect(tagFieldsFromTagMap({ DATE: "1999", COMPOSER: "X", Grouping: "Y" })).toEqual({
      year: 1999,
      composer: "X",
      comment: null,
      grouping: "Y",
    });
  });

  it("accepts only a leading four-digit year", () => {
    expect(parseYear("1987-02-03")).toBe(1987);
    expect(parseYear("circa 1987")).toBeNull();
    expect(parseYear(0)).toBeNull();
  });
});
