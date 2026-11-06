/**
 * Regression — the sharer's side of library sharing (`/api/federation`).
 *
 * A share is a capability handed to another *server*, and the router is the
 * only thing it opens. What this file pins:
 *
 * - the invite is single-use, expires, and is compared without an oracle;
 * - every request is Ed25519-signed by the key bound at pairing, and every
 *   way of getting that wrong — no headers, a foreign key, a stale clock, a
 *   replayed nonce, a path the signature did not cover, an unknown share —
 *   produces the *same* 404, so a scanner learns nothing;
 * - every authenticated answer is countersigned by the sharer, so the
 *   recipient can tell us from a host that merely holds a valid certificate;
 * - scope is re-resolved on every request: a track taken out of a shared
 *   playlist closes to the peer on the next call, not the next refresh;
 * - nothing a peer sees is a library path or a `tracks.id`;
 * - revocation and the daily byte budget are enforced server-side;
 * - managing shares is owner-only, over IPC as over Rocksy.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import Database from "better-sqlite3";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setHost, createNodeHost, resetHost } from "../../main/host";
import { SCHEMA_SQL } from "../../main/database/schema";
import type { ServerKeyPair } from "../../server/federation/signing";

let dataDir: string;
let libDir: string;
let libDb: Database.Database;
let server: http.Server;
let base: string;

let db: typeof import("../../server/db");
let shares: typeof import("../../server/federation/shares");
let signing: typeof import("../../server/federation/signing");
let router: typeof import("../../server/federation/router");

/** The friend's server. */
let peer: ServerKeyPair;
/** Another server that never paired. */
let stranger: ServerKeyPair;

const ids = { folderIn: 0, folderOut: 0, inA: 0, inB: 0, outA: 0, outInPlaylist: 0, playlist: 0 };

function makeKeyPair(): ServerKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
    privateKey,
  };
}

function writeAudio(rel: string, bytes: number): string {
  const p = path.join(libDir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes, 7));
  return p;
}

function seedLibrary(): void {
  libDb = new Database(":memory:");
  libDb.exec(SCHEMA_SQL);
  const folder = (name: string) =>
    Number(
      libDb
        .prepare("INSERT INTO library_folders (name, path, content_type) VALUES (?, ?, 'music')")
        .run(name, path.join(libDir, name)).lastInsertRowid
    );
  ids.folderIn = folder("Shared");
  ids.folderOut = folder("Private");
  const artist = Number(libDb.prepare("INSERT INTO artists (name) VALUES ('Band')").run().lastInsertRowid);
  const album = Number(
    libDb.prepare("INSERT INTO albums (title, artist_id) VALUES ('Record', ?)").run(artist).lastInsertRowid
  );
  const track = (folderId: number, rel: string, title: string, size: number) =>
    Number(
      libDb
        .prepare(
          `INSERT INTO tracks (path, filename, title, file_size, content_type,
                               library_folder_id, artist_id, album_id)
           VALUES (?, ?, ?, ?, 'music', ?, ?, ?)`
        )
        .run(writeAudio(rel, size), path.basename(rel), title, size, folderId, artist, album)
        .lastInsertRowid
    );
  ids.inA = track(ids.folderIn, "Shared/Band/Record/01 One.mp3", "One", 4000);
  ids.inB = track(ids.folderIn, "Shared/Band/Record/02 Two.mp3", "Two", 3000);
  ids.outA = track(ids.folderOut, "Private/Band/Diary/01 Secret.mp3", "Secret", 2000);
  ids.outInPlaylist = track(ids.folderOut, "Private/Band/Diary/02 Shared Single.mp3", "Single", 1000);
  // SCHEMA_SQL seeds the playlist types; any one will do.
  const type = libDb.prepare("SELECT id FROM playlist_types LIMIT 1").get() as { id: number };
  ids.playlist = Number(
    libDb
      .prepare("INSERT INTO playlists (name, playlist_type_id) VALUES ('Mix', ?)")
      .run(type.id).lastInsertRowid
  );
  libDb
    .prepare("INSERT INTO playlist_items (playlist_id, track_id, position) VALUES (?, ?, 1)")
    .run(ids.playlist, ids.outInPlaylist);
}

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-federation-"));
  libDir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-federation-lib-"));
  process.env.IPODROCKS_DATA_DIR = dataDir;
  setHost(createNodeHost());
  db = await import("../../server/db");
  db.closeServerDb();
  shares = await import("../../server/federation/shares");
  signing = await import("../../server/federation/signing");
  router = await import("../../server/federation/router");
  signing.resetServerKeyPair();
  router.resetFederationState();
  peer = makeKeyPair();
  stranger = makeKeyPair();
  seedLibrary();

  const app = express();
  app.use("/api/federation", router.createFederationRouter({ libraryDb: () => libDb }));
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  libDb.close();
  db.closeServerDb();
  resetHost();
  for (const d of [dataDir, libDir]) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function newShare(extra: Record<string, unknown> = {}) {
  const created = shares.createShare({
    label: "Ana",
    folderIds: [ids.folderIn],
    playlistIds: [ids.playlist],
    ...extra,
  });
  if ("error" in created) throw new Error(created.error);
  return created;
}

async function pair(shareId: string, code: string, key = peer) {
  return fetch(`${base}/api/federation/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ shareId, code, publicKey: key.publicKey, peerName: "Pedro's server" }),
  });
}

async function paired(extra: Record<string, unknown> = {}) {
  const { share, inviteCode } = newShare(extra);
  const res = await pair(share.id, inviteCode);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { sharerPublicKey: string };
  return { shareId: share.id, sharerPublicKey: body.sharerPublicKey };
}

async function signedGet(
  shareId: string,
  urlPath: string,
  opts: { key?: ServerKeyPair; now?: number; headers?: Record<string, string>; signPath?: string } = {}
) {
  const headers = signing.signRequest(
    "GET",
    opts.signPath ?? urlPath,
    shareId,
    opts.now ?? Date.now(),
    opts.key ?? peer
  );
  return fetch(`${base}${urlPath}`, { headers: { ...headers, ...opts.headers } });
}

async function catalog(shareId: string) {
  const res = await signedGet(shareId, "/api/federation/catalog");
  expect(res.status).toBe(200);
  return (await res.json()) as {
    total: number;
    items: { ref: string; title: string; relPath: string }[];
  };
}

describe("pairing", () => {
  it("binds the peer's key once, and refuses the same invite a second time", async () => {
    const { share, inviteCode } = newShare();
    expect((await pair(share.id, inviteCode)).status).toBe(200);
    expect(shares.getShare(share.id)?.status).toBe("active");
    expect(shares.getShare(share.id)?.peerFingerprint).toBe(signing.keyFingerprint(peer.publicKey));

    // Same code again, even with the same key: the invite is spent.
    expect((await pair(share.id, inviteCode)).status).toBe(404);
    // And nobody else's key replaces the binding.
    expect((await pair(share.id, inviteCode, stranger)).status).toBe(404);
    expect(shares.getShare(share.id)?.peerFingerprint).toBe(signing.keyFingerprint(peer.publicKey));
  });

  it("refuses a wrong code and an expired invite with the same 404", async () => {
    const { share, inviteCode } = newShare();
    const wrong = await pair(share.id, inviteCode.slice(0, -2) + "xx");
    expect(wrong.status).toBe(404);

    const late = shares.createShare({ label: "Old", folderIds: [ids.folderIn] }, Date.now() - shares.INVITE_TTL_MS - 1);
    if ("error" in late) throw new Error(late.error);
    const expired = await pair(late.share.id, late.inviteCode);
    expect(expired.status).toBe(404);
    expect(await expired.json()).toEqual(await wrong.json());
  });

  it("refuses a public key that is not Ed25519", async () => {
    const { share, inviteCode } = newShare();
    const rsa = crypto
      .generateKeyPairSync("rsa", { modulusLength: 1024 })
      .publicKey.export({ format: "der", type: "spki" })
      .toString("base64url");
    const res = await fetch(`${base}/api/federation/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shareId: share.id, code: inviteCode, publicKey: rsa }),
    });
    expect(res.status).toBe(404);
    // The invite was not consumed by the refusal.
    expect((await pair(share.id, inviteCode)).status).toBe(200);
  });

  it("locks a share's invite after ten wrong codes", async () => {
    const { share, inviteCode } = newShare();
    for (let i = 0; i < 10; i++) await pair(share.id, `wrong-${i}`);
    const res = await pair(share.id, inviteCode);
    expect(res.status).toBe(429);
  });
});

describe("request signatures", () => {
  it("answers every authentication failure with the identical 404", async () => {
    const { shareId } = await paired();
    const url = "/api/federation/catalog";

    const unsigned = await fetch(`${base}${url}`);
    const foreignKey = await signedGet(shareId, url, { key: stranger });
    const stale = await signedGet(shareId, url, { now: Date.now() - signing.SIGNATURE_MAX_SKEW_MS - 5000 });
    const otherPath = await signedGet(shareId, url, { signPath: "/api/federation/info" });
    const unknownShare = await signedGet("no-such-share", url);
    const unknownRoute = await signedGet(shareId, "/api/federation/admin");

    const bodies = await Promise.all(
      [unsigned, foreignKey, stale, otherPath, unknownShare, unknownRoute].map(async (r) => ({
        status: r.status,
        body: await r.text(),
        countersigned: r.headers.has(signing.HDR_RESPONSE_SIGNATURE),
      }))
    );
    for (const b of bodies.slice(0, 5)) {
      expect(b).toEqual({ status: 404, body: bodies[0].body, countersigned: false });
    }
    // A *valid* signature on an unknown route is still the same 404 body.
    expect(bodies[5].status).toBe(404);
    expect(bodies[5].body).toBe(bodies[0].body);
  });

  it("refuses a replayed request", async () => {
    const { shareId } = await paired();
    const headers = signing.signRequest("GET", "/api/federation/info", shareId, Date.now(), peer);
    expect((await fetch(`${base}/api/federation/info`, { headers })).status).toBe(200);
    expect((await fetch(`${base}/api/federation/info`, { headers })).status).toBe(404);
  });

  it("countersigns every authenticated answer with the key handed over at pairing", async () => {
    const { shareId, sharerPublicKey } = await paired();
    const headers = signing.signRequest("GET", "/api/federation/info", shareId, Date.now(), peer);
    const res = await fetch(`${base}/api/federation/info`, { headers });
    const sharerKey = signing.parsePeerPublicKey(sharerPublicKey)!;
    const sig = res.headers.get(signing.HDR_RESPONSE_SIGNATURE);
    expect(signing.verifyResponse(sharerKey, shareId, headers[signing.HDR_NONCE], sig)).toBe(true);
    // Bound to the request's nonce: it does not verify for any other request.
    expect(signing.verifyResponse(sharerKey, shareId, "another-nonce", sig)).toBe(false);
  });
});

describe("catalogue and media", () => {
  it("lists exactly the share's scope, with no paths and no track ids", async () => {
    const { shareId } = await paired();
    const cat = await catalog(shareId);
    expect(cat.items.map((i) => i.title).sort()).toEqual(["One", "Single", "Two"]);

    const raw = JSON.stringify(cat);
    expect(raw).not.toContain(libDir);
    expect(raw).not.toContain("Secret");
    for (const item of cat.items) {
      expect(path.isAbsolute(item.relPath)).toBe(false);
      expect(item.relPath.split("/")).not.toContain("..");
      expect(item.ref).not.toMatch(/^\d+$/);
    }
    // Relative to the library folder root, the layout the sync already uses.
    expect(cat.items.find((i) => i.title === "One")?.relPath).toBe("Band/Record/01 One.mp3");
  });

  it("serves a track in scope, with Range", async () => {
    const { shareId } = await paired();
    const one = (await catalog(shareId)).items.find((i) => i.title === "One")!;
    const full = await signedGet(shareId, `/api/federation/media/${one.ref}`);
    expect(full.status).toBe(200);
    expect((await full.arrayBuffer()).byteLength).toBe(4000);

    const part = await signedGet(shareId, `/api/federation/media/${one.ref}`, {
      headers: { range: "bytes=100-199" },
    });
    expect(part.status).toBe(206);
    expect((await part.arrayBuffer()).byteLength).toBe(100);
  });

  it("closes a track the moment it leaves a shared playlist", async () => {
    const { shareId } = await paired();
    const single = (await catalog(shareId)).items.find((i) => i.title === "Single")!;
    expect((await signedGet(shareId, `/api/federation/media/${single.ref}`)).status).toBe(200);

    libDb.prepare("DELETE FROM playlist_items WHERE track_id = ?").run(ids.outInPlaylist);
    expect((await signedGet(shareId, `/api/federation/media/${single.ref}`)).status).toBe(404);
  });

  it("does not honour one share's ref on another share", async () => {
    const a = await paired();
    const { share, inviteCode } = newShare({ label: "Other", folderIds: [ids.folderOut], playlistIds: [] });
    const other = makeKeyPair();
    expect((await pair(share.id, inviteCode, other)).status).toBe(200);

    const refInA = (await catalog(a.shareId)).items[0].ref;
    const res = await signedGet(share.id, `/api/federation/media/${refInA}`, { key: other });
    expect(res.status).toBe(404);
  });

  it("does not serve a track id guessed as a ref", async () => {
    const { shareId } = await paired();
    await catalog(shareId);
    for (const id of [ids.inA, ids.outA]) {
      expect((await signedGet(shareId, `/api/federation/media/${id}`)).status).toBe(404);
    }
  });
});

describe("the sharer stays in control", () => {
  it("answers a revoked share with 410 to its own key and 404 to everyone else", async () => {
    const { shareId } = await paired();
    expect("ok" in shares.revokeShare(shareId)).toBe(true);

    const own = await signedGet(shareId, "/api/federation/catalog");
    expect(own.status).toBe(410);
    expect(own.headers.has(signing.HDR_RESPONSE_SIGNATURE)).toBe(true);
    expect((await signedGet(shareId, "/api/federation/catalog", { key: stranger })).status).toBe(404);
  });

  it("enforces the daily byte budget", async () => {
    const { shareId } = await paired({ byteBudgetDaily: 5000 });
    const items = (await catalog(shareId)).items;
    const one = items.find((i) => i.title === "One")!; // 4000 bytes
    const two = items.find((i) => i.title === "Two")!; // 3000 bytes

    const first = await signedGet(shareId, `/api/federation/media/${one.ref}`);
    expect(first.status).toBe(200);
    await first.arrayBuffer();
    // Accounting happens on close; give the socket a beat to finish.
    await new Promise((r) => setTimeout(r, 50));
    expect(shares.bytesServedToday(shareId)).toBe(4000);

    const second = await signedGet(shareId, `/api/federation/media/${two.ref}`);
    expect(second.status).toBe(429);
  });
});

describe("managing shares is owner-only", () => {
  it("refuses a guest session on every entry point", async () => {
    const identities = await import("../../server/auth/identities");
    const ipc = await import("../../main/ipc/shares");
    identities.addIdentity({ provider: "local", subject: "owner", isOwner: true });
    const guest = identities.addIdentity({ provider: "local", subject: "guest" });
    db.getServerDb()
      .prepare("INSERT INTO server_sessions (sid, data, expires_at) VALUES (?, ?, ?)")
      .run("sid-guest", JSON.stringify({ identityId: guest.id }), Date.now() + 60_000);

    const ctx = { sessionId: "sid-guest" };
    expect(ipc.listSharesFor(ctx)).toEqual({ error: expect.stringMatching(/owner/i) });
    expect(ipc.createShareFor(ctx, { label: "x", folderIds: [ids.folderIn] })).toEqual({
      error: expect.stringMatching(/owner/i),
    });
    expect(ipc.revokeShareFor(ctx, "anything")).toEqual({ error: expect.stringMatching(/owner/i) });
  });

  it("refuses a guest calling Rocksy's tools directly, as assistant:confirmAction would", async () => {
    const identities = await import("../../server/auth/identities");
    const tools = await import("../../main/assistant/tools");
    identities.addIdentity({ provider: "local", subject: "owner", isOwner: true });
    const guest = identities.addIdentity({ provider: "local", subject: "guest" });
    db.getServerDb()
      .prepare("INSERT INTO server_sessions (sid, data, expires_at) VALUES (?, ?, ?)")
      .run("sid-guest", JSON.stringify({ identityId: guest.id }), Date.now() + 60_000);
    const ctx = { sessionId: "sid-guest" } as never;

    const calls: [string, Record<string, unknown>][] = [
      ["share_list", {}],
      ["share_create", { label: "x", folder_ids: [ids.folderIn] }],
      ["share_revoke", { share_id: "anything" }],
      ["remote_library_add", { invite_link: "https://peer.example/#share=" + "a".repeat(16) + "." + "b".repeat(32) }],
      ["remote_library_remove", { library_id: 1 }],
    ];
    for (const [name, args] of calls) {
      const result = await tools.getToolByName(name)!.run(args, ctx);
      expect(result, name).toEqual({ error: expect.stringMatching(/owner/i) });
    }
    expect(shares.listShares()).toHaveLength(0);
  });
});
