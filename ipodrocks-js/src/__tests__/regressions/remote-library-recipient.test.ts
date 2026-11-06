/**
 * Regression — the recipient's side of library sharing, against a peer that
 * is not to be trusted.
 *
 * The peer here is a stand-in with a valid countersigning key (so every
 * answer is "from the server we paired with") that sends what a hostile or
 * broken sharer could: traversal in a relative path, a non-audio file behind
 * an audio name, more bytes than asked for, a revocation. What is pinned:
 *
 * - a catalogue row's path cannot leave the cache root, and a row that tries
 *   is dropped rather than repaired into something else;
 * - "Keep offline" accepts a file only when its *bytes* are audio and its size
 *   matches, and the kept copy becomes an ordinary library track;
 * - a revocation purges the cache, the catalogue and the library tracks;
 * - turning downloads off on the sharer purges the cache on the next refresh;
 * - a friend's tracks kept offline here are never re-shared onward, by folder
 *   or through a playlist;
 * - the managed cache folder cannot be removed out from under its library.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setHost, createNodeHost, resetHost } from "../../main/host";

let dataDir: string;
let server: http.Server;
let origin: string;

let store: typeof import("../../main/remote-library/store");
let sync: typeof import("../../main/remote-library/catalog-sync");
let cache: typeof import("../../main/remote-library/cache");
let common: typeof import("../../main/ipc/common");
let shares: typeof import("../../server/federation/shares");
let serverDb: typeof import("../../server/db");

const SHARE_ID = "R".repeat(16);
const sharer = crypto.generateKeyPairSync("ed25519");
const sharerPublic = sharer.publicKey.export({ format: "der", type: "spki" }).toString("base64url");

/** A minimal MP3: one MPEG-1 Layer III frame header and padding. */
const MP3 = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(4000, 0)]);
const HTML = Buffer.from("<html><script>alert(1)</script></html>".padEnd(4004, " "));

interface FakeState {
  revoked: boolean;
  allowDownload: boolean;
  items: Record<string, unknown>[];
  files: Record<string, Buffer>;
  /** Extra bytes appended to every media response. */
  overflow: number;
}
let peer: FakeState;

function countersign(req: express.Request, res: express.Response): void {
  const nonce = String(req.headers["x-ipodrocks-nonce"] ?? "");
  res.setHeader(
    "x-ipodrocks-response-sig",
    crypto
      .sign(null, Buffer.from(["ipodrocks-federation-response-v1", SHARE_ID, nonce].join("\n")), sharer.privateKey)
      .toString("base64url")
  );
}

function fakePeerApp(): express.Express {
  const app = express();
  app.use((req, res, next) => {
    countersign(req, res);
    if (peer.revoked) {
      res.status(410).json({ error: "revoked" });
      return;
    }
    next();
  });
  app.get("/api/federation/info", (_req, res) => {
    res.json({ allowDownload: peer.allowDownload, trackCount: peer.items.length });
  });
  app.get("/api/federation/catalog", (_req, res) => {
    res.json({ total: peer.items.length, offset: 0, items: peer.items, nextOffset: null });
  });
  app.get("/api/federation/media/:ref", (req, res) => {
    const body = peer.files[req.params.ref];
    if (!body) {
      res.status(404).end();
      return;
    }
    const m = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ""));
    const start = m ? Number(m[1]) : 0;
    const end = Math.min(m ? Number(m[2]) : body.length - 1, body.length - 1);
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${body.length}`);
    // Deliberately no Content-Length: the overflow case streams past the range.
    res.end(Buffer.concat([body.subarray(start, end + 1), Buffer.alloc(peer.overflow, 1)]));
  });
  return app;
}

function item(ref: string, relPath: string, extra: Record<string, unknown> = {}) {
  return { ref, relPath, title: ref, album: "Album", artist: "Band", fileSize: 4004, contentType: "music", ...extra };
}

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-remote-recipient-"));
  process.env.IPODROCKS_DATA_DIR = dataDir;
  process.env.IPODROCKS_FEDERATION_ALLOW_LOOPBACK = "1";
  setHost(createNodeHost());
  serverDb = await import("../../server/db");
  serverDb.closeServerDb();
  store = await import("../../main/remote-library/store");
  sync = await import("../../main/remote-library/catalog-sync");
  cache = await import("../../main/remote-library/cache");
  common = await import("../../main/ipc/common");
  shares = await import("../../server/federation/shares");
  const library = await import("../../main/ipc/library");
  cache.setCacheScanRunner((folderPath, name) =>
    library.runLibraryScan([{ name, path: folderPath, contentType: "music" }])
  );

  peer = {
    revoked: false,
    allowDownload: true,
    overflow: 0,
    items: [
      item("good1", "Band/Album/01 Good.mp3"),
      item("good2", "Band/Album/02 Also Good.mp3"),
      item("evil1", "../../../../etc/passwd.mp3"),
      item("evil2", "Band/../../escape.mp3"),
      item("evil3", "/etc/absolute.mp3"),
      item("evil4", "Band\\..\\..\\win.mp3"),
      item("evil5", "Band/Album/not-audio.html"),
      item("html", "Band/Album/03 Disguised.mp3"),
      item("bad ref!", "Band/Album/04 Ref.mp3"),
    ],
    files: { good1: MP3, good2: MP3, html: HTML },
  };
  server = http.createServer(fakePeerApp());
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  delete process.env.IPODROCKS_FEDERATION_ALLOW_LOOPBACK;
  serverDb.closeServerDb();
  resetHost();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function addLibrary(): number {
  const id = store.insertRemoteLibrary(common.getLibraryDb(), {
    name: "Ana",
    target: { origin, shareId: SHARE_ID, sharerPublicKey: sharerPublic, lan: true },
    allowDownload: true,
  });
  if (typeof id !== "number") throw new Error(id.error);
  return id;
}

function remoteIdsByRef(id: number): Map<string, number> {
  const rows = common
    .getLibraryDb()
    .prepare("SELECT id, ref FROM remote_tracks WHERE remote_library_id = ?")
    .all(id) as { id: number; ref: string }[];
  return new Map(rows.map((r) => [r.ref, r.id]));
}

describe("catalogue", () => {
  it("keeps only rows whose path stays inside the cache root", async () => {
    const id = addLibrary();
    expect(await sync.refreshRemoteLibrary(common.getLibraryDb(), id)).toEqual({ ok: true, trackCount: 3 });
    const refs = [...remoteIdsByRef(id).keys()].sort();
    expect(refs).toEqual(["good1", "good2", "html"]);
    const root = store.remoteCacheRoot(id);
    const paths = common
      .getLibraryDb()
      .prepare("SELECT cache_path FROM remote_tracks WHERE remote_library_id = ?")
      .all(id) as { cache_path: string }[];
    for (const { cache_path } of paths) {
      expect(path.relative(root, cache_path).startsWith("..")).toBe(false);
    }
  });

  it("cleans text fields and refuses a relative path that resolves upward", () => {
    expect(store.cleanRelPath("a/../b.mp3")).toBeNull();
    expect(store.cleanRelPath("a/./b.mp3")).toBeNull();
    expect(store.cleanRelPath("a//b.mp3")).toBeNull();
    expect(store.cleanRelPath("a/b.exe")).toBeNull();
    expect(store.cleanRelPath("a/b\u0000.mp3")).toBeNull();
    expect(store.cleanRelPath('A:B/c*d?.mp3')).toBe("A_B/c_d_.mp3");
    const row = store.sanitizeCatalogItem({ ...item("x", "a/b.mp3"), title: "T\u0007itle\n", year: Infinity }, 1);
    expect(row?.title).toBe("Title");
    expect(row?.year).toBeNull();
  });
});

describe("keep offline", () => {
  it("keeps real audio as a library track and refuses bytes that are not audio", async () => {
    const id = addLibrary();
    await sync.refreshRemoteLibrary(common.getLibraryDb(), id);
    const ids = remoteIdsByRef(id);
    const result = await cache.keepOffline(common.getLibraryDb(), id, [ids.get("good1")!, ids.get("html")!]);
    expect(result).toMatchObject({ downloaded: 1, failed: 1 });
    expect((result as { errors: string[] }).errors.join(" ")).toMatch(/not a recognised audio format/);

    const kept = store.listRemoteTracks(common.getLibraryDb(), id, {}).tracks;
    expect(kept.find((t) => t.ref === "good1")?.cached).toBe(true);
    expect(kept.find((t) => t.ref === "html")?.cached).toBe(false);
    // No half-written file is left behind for the HTML one.
    const leftovers: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name));
        else leftovers.push(e.name);
      }
    };
    walk(store.remoteCacheRoot(id));
    expect(leftovers).toEqual(["01 Good.mp3"]);

    const track = common
      .getLibraryDb()
      .prepare("SELECT t.id FROM tracks t JOIN remote_tracks rt ON rt.cache_path = t.path WHERE rt.ref = 'good1'")
      .get();
    expect(track).toBeTruthy();
  });

  it("refuses a body longer than the range it asked for", async () => {
    const id = addLibrary();
    await sync.refreshRemoteLibrary(common.getLibraryDb(), id);
    peer.overflow = 10;
    const result = await cache.keepOffline(common.getLibraryDb(), id, [remoteIdsByRef(id).get("good1")!]);
    expect(result).toMatchObject({ downloaded: 0, failed: 1 });
  });

  it("is refused outright when the sharer has turned downloads off, and purges what was kept", async () => {
    const id = addLibrary();
    await sync.refreshRemoteLibrary(common.getLibraryDb(), id);
    await cache.keepOffline(common.getLibraryDb(), id, [remoteIdsByRef(id).get("good1")!]);

    peer.allowDownload = false;
    await sync.refreshRemoteLibrary(common.getLibraryDb(), id);
    expect(fs.existsSync(store.remoteCacheRoot(id))).toBe(false);
    expect(await cache.keepOffline(common.getLibraryDb(), id, [remoteIdsByRef(id).get("good2")!])).toEqual({
      error: expect.stringMatching(/turned off/),
    });
  });
});

describe("revocation", () => {
  it("purges the cache, the catalogue and the library tracks", async () => {
    const id = addLibrary();
    await sync.refreshRemoteLibrary(common.getLibraryDb(), id);
    await cache.keepOffline(common.getLibraryDb(), id, [remoteIdsByRef(id).get("good1")!]);
    const db = common.getLibraryDb();
    const cacheFolderId = (db.prepare("SELECT cache_folder_id FROM remote_libraries WHERE id = ?").get(id) as {
      cache_folder_id: number;
    }).cache_folder_id;
    expect(db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE library_folder_id = ?").get(cacheFolderId)).toEqual({ n: 1 });

    peer.revoked = true;
    expect(await sync.refreshRemoteLibrary(db, id)).toEqual({ error: expect.stringMatching(/stopped sharing/) });
    expect(store.getRemoteLibraryRow(db, id)?.status).toBe("revoked");
    expect(db.prepare("SELECT COUNT(*) AS n FROM remote_tracks WHERE remote_library_id = ?").get(id)).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE library_folder_id = ?").get(cacheFolderId)).toEqual({ n: 0 });
    expect(fs.existsSync(store.remoteCacheRoot(id))).toBe(false);
  });
});

describe("a friend's tracks are not ours to pass on", () => {
  it("excludes kept-offline tracks from every share, by folder and by playlist", async () => {
    const id = addLibrary();
    await sync.refreshRemoteLibrary(common.getLibraryDb(), id);
    await cache.keepOffline(common.getLibraryDb(), id, [remoteIdsByRef(id).get("good1")!]);
    const db = common.getLibraryDb();
    const cacheFolderId = (db.prepare("SELECT cache_folder_id FROM remote_libraries WHERE id = ?").get(id) as {
      cache_folder_id: number;
    }).cache_folder_id;
    const trackId = (db.prepare("SELECT id FROM tracks WHERE library_folder_id = ?").get(cacheFolderId) as { id: number }).id;
    const type = db.prepare("SELECT id FROM playlist_types LIMIT 1").get() as { id: number };
    const playlistId = Number(
      db.prepare("INSERT INTO playlists (name, playlist_type_id) VALUES ('Mix', ?)").run(type.id).lastInsertRowid
    );
    db.prepare("INSERT INTO playlist_items (playlist_id, track_id, position) VALUES (?, ?, 1)").run(playlistId, trackId);

    const created = shares.createShare({ label: "Onward", folderIds: [cacheFolderId], playlistIds: [playlistId] });
    if ("error" in created) throw new Error(created.error);
    expect(shares.resolveScopeTrackIds(db, created.share.id).size).toBe(0);
    expect(shares.trackInScope(db, created.share.id, trackId)).toBe(false);
  });

  it("does not let the managed cache folder be removed from Library Folders", async () => {
    const id = addLibrary();
    await sync.refreshRemoteLibrary(common.getLibraryDb(), id);
    await cache.keepOffline(common.getLibraryDb(), id, [remoteIdsByRef(id).get("good1")!]);
    const db = common.getLibraryDb();
    const cacheFolderId = (db.prepare("SELECT cache_folder_id FROM remote_libraries WHERE id = ?").get(id) as {
      cache_folder_id: number;
    }).cache_folder_id;
    const bridge = await import("../../main/host/bridge");
    const library = await import("../../main/ipc/library");
    library.registerLibraryHandlers();
    const remove = bridge.getHandler("library:removeFolder")!;
    const ctx = { sender: { send() {}, isDestroyed: () => false } } as never;
    await expect(remove(ctx, cacheFolderId)).resolves.toEqual({
      error: expect.stringMatching(/offline copies from the remote library "Ana"/),
    });
    expect(db.prepare("SELECT id FROM library_folders WHERE id = ?").get(cacheFolderId)).toBeTruthy();
  });
});
