/**
 * Unit tests for audiobook cover resolution and download.
 *
 * Mocks global fetch so no real HTTP calls are made.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";

// ---- cover-client tests ----

import { resolveCoverUrl, setCoverApiBaseUrls } from "@main/audiobooks/cover-client";

const GOOGLE_URL = "https://fake-gb.example.com";
const OL_URL = "https://fake-ol.example.com";
const OL_COVERS_URL = "https://fake-ol-covers.example.com";

beforeEach(() => {
  setCoverApiBaseUrls({ googleBooks: GOOGLE_URL, openLibrary: OL_URL, openLibraryCovers: OL_COVERS_URL });
});

function mockFetch(handler: (url: string) => Response) {
  vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(handler(url))));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveCoverUrl", () => {
  it("returns Google Books thumbnail when found", async () => {
    mockFetch((url) => {
      if (url.includes(GOOGLE_URL)) {
        return new Response(
          JSON.stringify({ items: [{ volumeInfo: { imageLinks: { thumbnail: "http://books.google.com/img.jpg" } } }] }),
          { status: 200 }
        );
      }
      throw new Error("unexpected fetch: " + url);
    });

    const result = await resolveCoverUrl("Pride and Prejudice", "Jane Austen");
    expect(result).toBe("https://books.google.com/img.jpg"); // http → https
  });

  it("falls back to Open Library when Google Books returns no items", async () => {
    mockFetch((url) => {
      if (url.includes(GOOGLE_URL)) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (url.includes(OL_URL)) {
        return new Response(JSON.stringify({ docs: [{ cover_i: 9999 }] }), { status: 200 });
      }
      throw new Error("unexpected fetch: " + url);
    });

    const result = await resolveCoverUrl("Pride and Prejudice", "Jane Austen");
    expect(result).toBe(`${OL_COVERS_URL}/b/id/9999-L.jpg`);
  });

  it("returns null when both sources have no match", async () => {
    mockFetch(() => new Response(JSON.stringify({}), { status: 200 }));

    const result = await resolveCoverUrl("Nonexistent Book XYZ", null);
    expect(result).toBeNull();
  });

  it("returns null when Google Books fetch fails (network error)", async () => {
    mockFetch((url) => {
      if (url.includes(GOOGLE_URL)) throw new Error("network error");
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const result = await resolveCoverUrl("Some Book", "Some Author");
    expect(result).toBeNull();
  });
});

// ---- downloadCover integration test ----

import { downloadCover } from "@main/audiobooks/audiobook-cover";
import { getAudiobooksRoot } from "@main/audiobooks/audiobook-storage";

// audiobook-storage uses electron.app — stub it before importing
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn((key: string) => {
      if (key === "userData") return _testUserData;
      throw new Error("unexpected getPath: " + key);
    }),
  },
}));

let _testUserData = "";

describe("downloadCover", () => {
  let userDataDir: string;

  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-cover-test-"));
    _testUserData = userDataDir;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("downloads cover and stores local path in DB", async () => {
    // Stub fetch: Google Books returns thumbnail URL, image fetch returns PNG bytes
    const imageBytes = Buffer.from("FAKEIMGDATA");
    mockFetch((url) => {
      if (url.includes(GOOGLE_URL)) {
        return new Response(
          JSON.stringify({ items: [{ volumeInfo: { imageLinks: { thumbnail: "https://img.example.com/cover.jpg" } } }] }),
          { status: 200 }
        );
      }
      if (url.includes("img.example.com")) {
        return new Response(imageBytes, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      throw new Error("unexpected fetch: " + url);
    });

    // Minimal in-memory SQLite DB
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE audiobook_subscriptions (
        id INTEGER PRIMARY KEY,
        librivox_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        author TEXT,
        image_url TEXT
      );
      INSERT INTO audiobook_subscriptions (id, librivox_id, title, author)
      VALUES (1, 42, 'Pride and Prejudice', 'Jane Austen');
    `);

    const localPath = await downloadCover(db, 1);
    expect(localPath).not.toBeNull();
    expect(fs.existsSync(localPath!)).toBe(true);
    expect(fs.readFileSync(localPath!)).toEqual(imageBytes);

    const row = db.prepare("SELECT image_url FROM audiobook_subscriptions WHERE id = 1").get() as { image_url: string };
    expect(row.image_url).toBe(localPath);
    expect(localPath).toContain(path.join("auto-audiobooks", "42", "cover"));

    db.close();
  });

  it("returns null when cover resolution finds nothing", async () => {
    mockFetch(() => new Response(JSON.stringify({}), { status: 200 }));

    const Database = (await import("better-sqlite3")).default;
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE audiobook_subscriptions (
        id INTEGER PRIMARY KEY,
        librivox_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        author TEXT,
        image_url TEXT
      );
      INSERT INTO audiobook_subscriptions (id, librivox_id, title, author)
      VALUES (1, 99, 'Unknown Book', null);
    `);

    const result = await downloadCover(db, 1);
    expect(result).toBeNull();
    const row = db.prepare("SELECT image_url FROM audiobook_subscriptions WHERE id = 1").get() as { image_url: string | null };
    expect(row.image_url).toBeNull();
    db.close();
  });
});
