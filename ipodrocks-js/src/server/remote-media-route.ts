import * as fs from "fs";
import { Readable } from "stream";
import type { Request, Response } from "express";
import { getLibraryDb } from "../main/ipc/common";
import { PeerClient, PeerError } from "../main/remote-library/peer-client";
import {
  containedCachePath,
  getRemoteLibraryRow,
  remoteTrackById,
  targetFor,
} from "../main/remote-library/store";
import { contentTypeFor, parseRange } from "./media-route";
import { issueMediaToken, verifyMediaToken } from "./media-token";

/**
 * `GET /api/remote-media/:token` — playing a track from a remote library.
 *
 * The browser only ever talks to its own server. The token is the ordinary
 * media token, minted for the string `remote:<remote_tracks.id>` and bound to
 * the session, so the existing `/api/media` route can never honour it
 * (`isServableMediaPath` refuses that string) and this route never honours a
 * file path. The track id resolves server-side to the pinned peer, which is
 * then asked through `PeerClient` — signed, countersigned, no redirects — with
 * the browser's `Range` passed through so seeking works.
 *
 * A kept-offline copy is served from disk instead: no reason to spend the
 * sharer's bandwidth on bytes already here.
 */

const PREFIX = "remote:";

export function remoteMediaUrl(remoteTrackId: number, sessionId: string): string {
  return `/api/remote-media/${issueMediaToken(`${PREFIX}${remoteTrackId}`, sessionId)}`;
}

function serveLocal(req: Request, res: Response, filePath: string, size: number): void {
  res.setHeader("Content-Type", contentTypeFor(filePath));
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "private, max-age=0, no-store");
  const range = parseRange(req.headers.range, size);
  if (range === "unsatisfiable") {
    res.setHeader("Content-Range", `bytes */${size}`);
    res.status(416).end();
    return;
  }
  if (req.method === "HEAD") {
    res.setHeader("Content-Length", String(size));
    res.status(200).end();
    return;
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  if (range) {
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
  } else {
    res.status(200);
  }
  res.setHeader("Content-Length", String(end - start + 1));
  const stream = fs.createReadStream(filePath, { start, end });
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

export async function handleRemoteMediaRequest(req: Request, res: Response): Promise<void> {
  const payload = verifyMediaToken(String(req.params.token ?? ""), req.sessionID ?? null);
  const m = payload ? /^remote:(\d{1,15})$/.exec(payload) : null;
  if (!m) {
    res.status(403).type("text/plain").send("Forbidden");
    return;
  }
  const db = getLibraryDb();
  const track = remoteTrackById(db, Number(m[1]));
  const row = track ? getRemoteLibraryRow(db, track.remote_library_id) : null;
  if (!track || !row || row.status === "revoked") {
    res.status(404).type("text/plain").send("Not found");
    return;
  }

  const local = containedCachePath(row.id, track.cache_path);
  if (local) {
    try {
      const stat = fs.statSync(local);
      if (stat.isFile()) {
        serveLocal(req, res, local, stat.size);
        return;
      }
    } catch {
      /* not kept offline — stream it */
    }
  }

  const abort = new AbortController();
  req.on("close", () => abort.abort());
  const headers: Record<string, string> = {};
  const range = req.headers.range;
  if (typeof range === "string" && /^bytes=\d*-\d*$/.test(range.trim())) headers.range = range.trim();
  let upstream: globalThis.Response;
  try {
    upstream = await new PeerClient(targetFor(row)).request(
      `/api/federation/media/${encodeURIComponent(track.ref)}`,
      { method: req.method === "HEAD" ? "HEAD" : "GET", headers, signal: abort.signal }
    );
  } catch (err) {
    if (err instanceof PeerError && err.kind === "revoked") {
      const { handlePeerFailure } = await import("../main/remote-library/catalog-sync");
      await handlePeerFailure(db, row.id, err);
    }
    if (!res.headersSent) {
      res
        .status(err instanceof PeerError && err.kind === "busy" ? 429 : 502)
        .type("text/plain")
        .send(err instanceof Error ? err.message : "The sharing server could not be reached.");
    }
    return;
  }

  // Only the headers a media element needs, never anything else the peer sent
  // — and never its Content-Type: a sharer answering `text/html` would be
  // serving a page from *our* origin. The type comes from the catalogue path,
  // whose extension `cleanRelPath()` already required to be audio.
  res.status([200, 206, 416].includes(upstream.status) ? upstream.status : 502);
  res.setHeader("Content-Type", contentTypeFor(track.cache_path));
  res.setHeader("Content-Disposition", "inline");
  for (const name of ["content-length", "content-range", "accept-ranges"]) {
    const v = upstream.headers.get(name);
    if (v && /^[\x20-\x7e]{1,200}$/.test(v)) res.setHeader(name, v);
  }
  res.setHeader("Cache-Control", "private, max-age=0, no-store");
  if (!upstream.body || req.method === "HEAD") {
    res.end();
    return;
  }
  const body = Readable.fromWeb(upstream.body as unknown as import("stream/web").ReadableStream);
  body.on("error", () => res.destroy());
  body.pipe(res);
}
