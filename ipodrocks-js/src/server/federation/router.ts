import * as fs from "fs";
import * as path from "path";
import express, { type Request, type Response } from "express";
import type Database from "better-sqlite3";
import { isServableMediaPath } from "../../main/player/media-path";
import { folderRelativePath } from "../../main/utils/device-path";
import { logActivity } from "../../main/activity/activity-logger";
import { bucketsFor, clearFailures, reserveAttempt } from "../auth/rate-limit";
import { contentTypeFor, parseRange } from "../media-route";
import { federationRateLimiter } from "../rate-limits";
import {
  acceptInvite,
  bytesServedToday,
  peerKeyForShare,
  recordBytesServed,
  refsForTracks,
  resolveScopeTrackIds,
  shareRow,
  touchShare,
  trackIdForRef,
  trackInScope,
} from "./shares";
import {
  getServerKeyPair,
  HDR_NONCE,
  HDR_RESPONSE_SIGNATURE,
  keyFingerprint,
  signResponse,
  verifyRequest,
} from "./signing";

/**
 * `/api/federation` — the only surface a peer server can reach.
 *
 * Read-only and fixed: pair, info, catalogue, media. Nothing here touches a
 * session, `/api/invoke`, an IPC handler or Rocksy, and nothing a peer sends
 * becomes a filesystem path — a track is named by an opaque per-share ref and
 * resolved from the database, then re-checked against the share's *current*
 * scope and `isServableMediaPath()` on every request.
 *
 * Every failure before a signature verifies is the same 404, so a scanner
 * cannot tell "no such route" from "bad signature" from "unknown share". A
 * revoked share gets 410, but only in answer to a request its own key signed.
 */

export const CATALOG_MAX_PAGE = 1000;
export const CATALOG_DEFAULT_PAGE = 500;

export interface FederationRouterOptions {
  libraryDb: () => Database.Database;
}

/** Concurrent media responses per share. In memory: a restart ends them all. */
const activeStreams = new Map<string, number>();

export function resetFederationState(): void {
  activeStreams.clear();
}

function notFound(res: Response): void {
  res.status(404).json({ error: "Not found" });
}

interface CatalogRow {
  id: number;
  path: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  album_artist: string | null;
  genre: string | null;
  track_number: number | null;
  disc_number: number | null;
  year: number | null;
  duration: number | null;
  bitrate: number | null;
  file_size: number | null;
  content_type: string;
  codec: string | null;
  file_hash: string | null;
  library_folder_id: number | null;
}

export interface CatalogItem {
  ref: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  albumArtist: string | null;
  genre: string | null;
  trackNumber: number | null;
  discNumber: number | null;
  year: number | null;
  duration: number | null;
  bitrate: number | null;
  fileSize: number | null;
  contentType: string;
  codec: string | null;
  hash: string | null;
  /** POSIX, relative, every component sanitized. Never absolute. */
  relPath: string;
}

function folderPaths(db: Database.Database): Map<number, string> {
  const rows = db.prepare("SELECT id, path FROM library_folders").all() as {
    id: number;
    path: string;
  }[];
  return new Map(rows.map((r) => [r.id, r.path]));
}

function catalogRows(db: Database.Database, ids: number[]): CatalogRow[] {
  if (ids.length === 0) return [];
  return db
    .prepare(
      `SELECT t.id, t.path, t.title, a.name AS artist, al.title AS album,
              COALESCE(aa.name, a.name) AS album_artist, g.name AS genre,
              t.track_number, t.disc_number, COALESCE(t.year, al.year) AS year,
              t.duration, t.bitrate, t.file_size, t.content_type,
              c.name AS codec, t.file_hash, t.library_folder_id
         FROM tracks t
         LEFT JOIN artists a ON t.artist_id = a.id
         LEFT JOIN albums al ON t.album_id = al.id
         LEFT JOIN artists aa ON al.artist_id = aa.id
         LEFT JOIN genres g ON t.genre_id = g.id
         LEFT JOIN codecs c ON t.codec_id = c.id
        WHERE t.id IN (${ids.map(() => "?").join(",")})
        ORDER BY t.id`
    )
    .all(...ids) as CatalogRow[];
}

/** The relative path a track is offered under: the folder layout when it
 *  resolves, otherwise just its sanitized filename. */
function relPathFor(row: CatalogRow, folders: Map<number, string>): string {
  const rel = folderRelativePath(row.path, row.content_type, folders, row.library_folder_id ?? undefined);
  if (rel) return rel;
  return folderRelativePath(row.path, row.content_type, new Map([[0, path.dirname(row.path)]]), 0) ??
    "_";
}

/**
 * Verifies the signature and the share's state. Answers the response itself
 * and returns null on any failure.
 */
function authenticate(req: Request, res: Response): string | null {
  const verdict = verifyRequest(
    {
      method: req.method,
      pathWithQuery: req.originalUrl,
      header: (name) => req.get(name),
    },
    peerKeyForShare
  );
  if (!verdict.ok) {
    notFound(res);
    return null;
  }
  const row = shareRow(verdict.shareId);
  if (!row) {
    notFound(res);
    return null;
  }
  // Countersign before any status is chosen, so the revoked and limit answers
  // carry it too: the recipient trusts nothing from this host without it.
  res.setHeader(HDR_RESPONSE_SIGNATURE, signResponse(verdict.shareId, req.get(HDR_NONCE)!));
  if (row.revoked_at !== null) {
    res.status(410).json({ error: "This share has been revoked." });
    return null;
  }
  touchShare(verdict.shareId);
  return verdict.shareId;
}

export function createFederationRouter(opts: FederationRouterOptions): express.Router {
  const router = express.Router();
  router.use(federationRateLimiter());

  /**
   * The one unsigned route: it is where a peer's key is first learned. The
   * invite code is the proof, and both buckets of the login limiter guard it —
   * ten tries per share, sixty per address.
   */
  router.post("/pair", express.json({ limit: "4kb", inflate: false }), (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const shareId = typeof body.shareId === "string" ? body.shareId.slice(0, 64) : null;
    const buckets = bucketsFor(req.ip ?? "unknown", shareId ? `share:${shareId}` : null);
    const verdict = reserveAttempt(buckets);
    if (!verdict.allowed) {
      res.setHeader("Retry-After", String(verdict.retryAfterSeconds));
      res.status(429).json({ error: "Too many attempts. Try again later." });
      return;
    }
    const result = acceptInvite({
      shareId: body.shareId,
      code: body.code,
      publicKey: body.publicKey,
      peerName: body.peerName,
    });
    if ("error" in result) {
      notFound(res);
      return;
    }
    clearFailures(buckets);
    try {
      logActivity(
        opts.libraryDb(),
        "library_share_accepted",
        `${result.share.label} — accepted by ${result.share.peerName ?? "a server"} (${result.share.peerFingerprint})`
      );
    } catch {
      /* the pairing stands whether or not the dashboard hears about it */
    }
    // The recipient pins this key: every later response must be countersigned
    // by it (`signResponse`), so a re-pointed hostname cannot impersonate us.
    const { publicKey } = getServerKeyPair();
    res.json({
      shareId: result.share.id,
      label: result.share.label,
      allowDownload: result.share.allowDownload,
      sharerPublicKey: publicKey,
      sharerFingerprint: keyFingerprint(publicKey),
    });
  });

  router.get("/info", (req, res) => {
    const shareId = authenticate(req, res);
    if (!shareId) return;
    const row = shareRow(shareId)!;
    const db = opts.libraryDb();
    const ids = [...resolveScopeTrackIds(db, shareId)];
    let totalBytes = 0;
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      const r = db
        .prepare(
          `SELECT COALESCE(SUM(file_size), 0) AS n FROM tracks WHERE id IN (${part.map(() => "?").join(",")})`
        )
        .get(...part) as { n: number };
      totalBytes += r.n;
    }
    res.json({
      label: row.label,
      allowDownload: row.allow_download === 1,
      trackCount: ids.length,
      totalBytes,
      byteBudgetDaily: row.byte_budget_daily,
      bytesServedToday: bytesServedToday(shareId),
      maxStreams: row.max_streams,
    });
  });

  router.get("/catalog", (req, res) => {
    const shareId = authenticate(req, res);
    if (!shareId) return;
    const offset = Math.max(0, Math.floor(Number(req.query.offset ?? 0)) || 0);
    const limit = Math.max(
      1,
      Math.min(CATALOG_MAX_PAGE, Math.floor(Number(req.query.limit ?? CATALOG_DEFAULT_PAGE)) || CATALOG_DEFAULT_PAGE)
    );
    const db = opts.libraryDb();
    const all = [...resolveScopeTrackIds(db, shareId)].sort((a, b) => a - b);
    const page = all.slice(offset, offset + limit);
    const rows = catalogRows(db, page);
    const refs = refsForTracks(shareId, rows.map((r) => r.id));
    const folders = folderPaths(db);
    const items: CatalogItem[] = rows.map((r) => ({
      ref: refs.get(r.id)!,
      title: r.title,
      artist: r.artist,
      album: r.album,
      albumArtist: r.album_artist,
      genre: r.genre,
      trackNumber: r.track_number,
      discNumber: r.disc_number,
      year: r.year,
      duration: r.duration,
      bitrate: r.bitrate,
      fileSize: r.file_size,
      contentType: r.content_type,
      codec: r.codec,
      hash: r.file_hash,
      relPath: relPathFor(r, folders),
    }));
    res.json({
      total: all.length,
      offset,
      items,
      nextOffset: offset + page.length < all.length ? offset + page.length : null,
    });
  });

  const media = (req: Request, res: Response): void => {
    const shareId = authenticate(req, res);
    if (!shareId) return;
    const ref = String(req.params.ref ?? "");
    const trackId = trackIdForRef(shareId, ref);
    const db = opts.libraryDb();
    if (trackId === null || !trackInScope(db, shareId, trackId)) {
      notFound(res);
      return;
    }
    const row = db.prepare("SELECT path FROM tracks WHERE id = ?").get(trackId) as
      | { path: string }
      | undefined;
    if (!row) {
      notFound(res);
      return;
    }
    const resolved = path.resolve(row.path);
    if (!isServableMediaPath(resolved)) {
      notFound(res);
      return;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
      if (!stat.isFile()) throw new Error("not a file");
    } catch {
      notFound(res);
      return;
    }

    const share = shareRow(shareId)!;
    res.setHeader("Content-Type", contentTypeFor(resolved));
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "private, no-store");

    const range = parseRange(req.headers.range, stat.size);
    if (range === "unsatisfiable") {
      res.setHeader("Content-Range", `bytes */${stat.size}`);
      res.status(416).end();
      return;
    }
    if (req.method === "HEAD") {
      res.setHeader("Content-Length", String(stat.size));
      res.status(200).end();
      return;
    }

    const start = range ? range.start : 0;
    const end = range ? range.end : stat.size - 1;
    const length = end - start + 1;

    if (
      share.byte_budget_daily !== null &&
      bytesServedToday(shareId) + length > share.byte_budget_daily
    ) {
      res.status(429).json({ error: "This share's daily transfer limit has been reached." });
      return;
    }
    const active = activeStreams.get(shareId) ?? 0;
    if (active >= share.max_streams) {
      res.setHeader("Retry-After", "5");
      res.status(429).json({ error: "Too many simultaneous transfers on this share." });
      return;
    }
    activeStreams.set(shareId, active + 1);

    let sent = 0;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const n = (activeStreams.get(shareId) ?? 1) - 1;
      if (n <= 0) activeStreams.delete(shareId);
      else activeStreams.set(shareId, n);
      recordBytesServed(shareId, sent);
    };
    res.on("close", release);

    if (range) {
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    } else {
      res.status(200);
    }
    res.setHeader("Content-Length", String(length));
    const stream = fs.createReadStream(resolved, { start, end });
    stream.on("data", (chunk) => {
      sent += chunk.length;
    });
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  };

  router.get("/media/:ref", media);
  router.head("/media/:ref", media);

  // Unknown federation paths are the same 404 as everything else here.
  router.use((_req, res) => notFound(res));
  return router;
}
