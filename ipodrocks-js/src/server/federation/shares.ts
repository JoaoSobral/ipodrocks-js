import * as crypto from "crypto";
import type Database from "better-sqlite3";
import { getServerDb } from "../db";
import { keyFingerprint, parsePeerPublicKey } from "./signing";

/**
 * Library shares — the sharer's side of federation.
 *
 * A share names folders and playlists of *this* library and is bound, once,
 * to one peer server's Ed25519 public key through a single-use invite. Nothing
 * here creates a session or an identity: the only thing a share opens is the
 * read-only `/api/federation` router.
 *
 * Scope is re-resolved from the library database on every request rather than
 * snapshotted at pairing time. Taking a track out of a shared playlist, or a
 * folder out of the share, must close it to the peer on the next request — a
 * snapshot would keep serving it until something remembered to refresh.
 */

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_LABEL_LENGTH = 80;
export const MAX_PEER_NAME_LENGTH = 80;
export const DEFAULT_MAX_STREAMS = 3;

export interface ShareScope {
  folderIds: number[];
  playlistIds: number[];
}

export interface LibraryShare {
  id: string;
  label: string;
  allowDownload: boolean;
  byteBudgetDaily: number | null;
  maxStreams: number;
  scope: ShareScope;
  status: "pending" | "expired" | "active" | "revoked";
  inviteExpiresAt: number | null;
  peerName: string | null;
  peerFingerprint: string | null;
  acceptedAt: number | null;
  revokedAt: number | null;
  lastSeenAt: number | null;
  bytesServed: number;
  createdAt: number;
}

interface ShareRow {
  id: string;
  label: string;
  allow_download: number;
  byte_budget_daily: number | null;
  max_streams: number;
  invite_hash: string | null;
  invite_expires_at: number | null;
  peer_public_key: string | null;
  peer_name: string | null;
  accepted_at: number | null;
  revoked_at: number | null;
  last_seen_at: number | null;
  bytes_served: number;
  created_at: number;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** A UI- and log-safe string: control characters gone, length bounded. */
export function cleanLabel(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}

function cleanIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<number>();
  for (const v of raw) {
    if (typeof v === "number" && Number.isSafeInteger(v) && v > 0) out.add(v);
  }
  return [...out];
}

function statusOf(row: ShareRow, now: number): LibraryShare["status"] {
  if (row.revoked_at !== null) return "revoked";
  if (row.peer_public_key) return "active";
  if (row.invite_expires_at !== null && row.invite_expires_at < now) return "expired";
  return "pending";
}

function scopeOf(shareId: string): ShareScope {
  const rows = getServerDb()
    .prepare("SELECT kind, target_id FROM federation_share_scope WHERE share_id = ?")
    .all(shareId) as { kind: "folder" | "playlist"; target_id: number }[];
  return {
    folderIds: rows.filter((r) => r.kind === "folder").map((r) => r.target_id),
    playlistIds: rows.filter((r) => r.kind === "playlist").map((r) => r.target_id),
  };
}

function rowToShare(row: ShareRow, now = Date.now()): LibraryShare {
  return {
    id: row.id,
    label: row.label,
    allowDownload: row.allow_download === 1,
    byteBudgetDaily: row.byte_budget_daily,
    maxStreams: row.max_streams,
    scope: scopeOf(row.id),
    status: statusOf(row, now),
    inviteExpiresAt: row.peer_public_key ? null : row.invite_expires_at,
    peerName: row.peer_name,
    peerFingerprint: row.peer_public_key ? keyFingerprint(row.peer_public_key) : null,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
    lastSeenAt: row.last_seen_at,
    bytesServed: row.bytes_served,
    createdAt: row.created_at,
  };
}

function getRow(id: string): ShareRow | undefined {
  return getServerDb().prepare("SELECT * FROM federation_shares WHERE id = ?").get(id) as
    | ShareRow
    | undefined;
}

function writeScope(shareId: string, scope: ShareScope): void {
  const db = getServerDb();
  db.prepare("DELETE FROM federation_share_scope WHERE share_id = ?").run(shareId);
  const insert = db.prepare(
    "INSERT INTO federation_share_scope (share_id, kind, target_id) VALUES (?, ?, ?)"
  );
  for (const id of scope.folderIds) insert.run(shareId, "folder", id);
  for (const id of scope.playlistIds) insert.run(shareId, "playlist", id);
}

export interface ShareSettingsInput {
  label?: unknown;
  folderIds?: unknown;
  playlistIds?: unknown;
  allowDownload?: unknown;
  byteBudgetDaily?: unknown;
  maxStreams?: unknown;
}

function cleanBudget(raw: unknown): number | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  if (raw <= 0) return null;
  return Math.min(Math.floor(raw), Number.MAX_SAFE_INTEGER);
}

function cleanStreams(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  return Math.max(1, Math.min(16, Math.floor(raw)));
}

/**
 * Creates a share and its invite. The invite code is returned exactly once and
 * stored only as a hash — like the claim token, a lost code means a new
 * invite, not a recovered one.
 */
export function createShare(
  input: ShareSettingsInput,
  now = Date.now()
): { share: LibraryShare; inviteCode: string } | { error: string } {
  const label = cleanLabel(input.label, MAX_LABEL_LENGTH);
  if (!label) return { error: "Give the share a name." };
  const scope = { folderIds: cleanIds(input.folderIds), playlistIds: cleanIds(input.playlistIds) };
  if (scope.folderIds.length === 0 && scope.playlistIds.length === 0) {
    return { error: "Choose at least one folder or playlist to share." };
  }
  const id = crypto.randomBytes(12).toString("base64url");
  const inviteCode = crypto.randomBytes(24).toString("base64url");
  const db = getServerDb();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO federation_shares
         (id, label, allow_download, byte_budget_daily, max_streams,
          invite_hash, invite_expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      label,
      input.allowDownload === false ? 0 : 1,
      cleanBudget(input.byteBudgetDaily) ?? null,
      cleanStreams(input.maxStreams) ?? DEFAULT_MAX_STREAMS,
      sha256(inviteCode),
      now + INVITE_TTL_MS,
      now
    );
    writeScope(id, scope);
  })();
  return { share: rowToShare(getRow(id)!, now), inviteCode };
}

export function listShares(now = Date.now()): LibraryShare[] {
  const rows = getServerDb()
    .prepare("SELECT * FROM federation_shares ORDER BY created_at DESC")
    .all() as ShareRow[];
  return rows.map((r) => rowToShare(r, now));
}

export function getShare(id: string): LibraryShare | null {
  const row = getRow(id);
  return row ? rowToShare(row) : null;
}

/** Edits label, scope and limits. Never touches the peer binding. */
export function updateShare(id: unknown, input: ShareSettingsInput): LibraryShare | { error: string } {
  if (typeof id !== "string") return { error: "Share not found." };
  const row = getRow(id);
  if (!row) return { error: "Share not found." };
  const db = getServerDb();
  db.transaction(() => {
    if (input.label !== undefined) {
      const label = cleanLabel(input.label, MAX_LABEL_LENGTH);
      if (label) db.prepare("UPDATE federation_shares SET label = ? WHERE id = ?").run(label, id);
    }
    if (typeof input.allowDownload === "boolean") {
      db.prepare("UPDATE federation_shares SET allow_download = ? WHERE id = ?").run(
        input.allowDownload ? 1 : 0,
        id
      );
    }
    const budget = cleanBudget(input.byteBudgetDaily);
    if (budget !== undefined) {
      db.prepare("UPDATE federation_shares SET byte_budget_daily = ? WHERE id = ?").run(budget, id);
    }
    const streams = cleanStreams(input.maxStreams);
    if (streams !== undefined) {
      db.prepare("UPDATE federation_shares SET max_streams = ? WHERE id = ?").run(streams, id);
    }
    if (input.folderIds !== undefined || input.playlistIds !== undefined) {
      const current = scopeOf(id);
      writeScope(id, {
        folderIds: input.folderIds !== undefined ? cleanIds(input.folderIds) : current.folderIds,
        playlistIds:
          input.playlistIds !== undefined ? cleanIds(input.playlistIds) : current.playlistIds,
      });
    }
  })();
  return rowToShare(getRow(id)!);
}

/**
 * Revokes a share. The peer's key is *kept*, so its next signed request can be
 * told "revoked" (410) rather than an anonymous 404 — that answer is only
 * reachable with a valid signature, so it is no oracle to anyone else.
 */
export function revokeShare(id: unknown, now = Date.now()): { ok: true } | { error: string } {
  if (typeof id !== "string") return { error: "Share not found." };
  const res = getServerDb()
    .prepare(
      "UPDATE federation_shares SET revoked_at = ?, invite_hash = NULL " +
        "WHERE id = ? AND revoked_at IS NULL"
    )
    .run(now, id);
  if (res.changes === 0 && !getRow(id)) return { error: "Share not found." };
  return { ok: true };
}

export function deleteShare(id: unknown): { ok: true } | { error: string } {
  if (typeof id !== "string") return { error: "Share not found." };
  const res = getServerDb().prepare("DELETE FROM federation_shares WHERE id = ?").run(id);
  return res.changes > 0 ? { ok: true } : { error: "Share not found." };
}

/**
 * Exchanges an invite for a peer binding. Single use, constant-time compare,
 * and atomic: the hash is cleared in the same statement that binds the key,
 * so two concurrent pairings cannot both succeed.
 */
export function acceptInvite(
  input: { shareId: unknown; code: unknown; publicKey: unknown; peerName: unknown },
  now = Date.now()
): { share: LibraryShare } | { error: "invalid" } {
  if (typeof input.shareId !== "string" || typeof input.code !== "string") {
    return { error: "invalid" };
  }
  if (input.code.length > 64 || input.shareId.length > 64) return { error: "invalid" };
  if (!parsePeerPublicKey(input.publicKey)) return { error: "invalid" };
  const row = getRow(input.shareId);
  if (!row || !row.invite_hash || row.revoked_at !== null || row.peer_public_key) {
    return { error: "invalid" };
  }
  if (row.invite_expires_at === null || row.invite_expires_at < now) return { error: "invalid" };
  const given = Buffer.from(sha256(input.code), "hex");
  const stored = Buffer.from(row.invite_hash, "hex");
  if (given.length !== stored.length || !crypto.timingSafeEqual(given, stored)) {
    return { error: "invalid" };
  }
  const peerName = cleanLabel(input.peerName, MAX_PEER_NAME_LENGTH) || null;
  const res = getServerDb()
    .prepare(
      `UPDATE federation_shares
          SET peer_public_key = ?, peer_name = ?, accepted_at = ?, last_seen_at = ?,
              invite_hash = NULL, invite_expires_at = NULL
        WHERE id = ? AND invite_hash = ? AND peer_public_key IS NULL AND revoked_at IS NULL`
    )
    .run(input.publicKey as string, peerName, now, now, row.id, row.invite_hash);
  if (res.changes !== 1) return { error: "invalid" };
  return { share: rowToShare(getRow(row.id)!, now) };
}

/**
 * The key bound to a share, for signature verification. Returned for revoked
 * shares too (see `revokeShare`); the router answers those with 410.
 */
export function peerKeyForShare(shareId: string): crypto.KeyObject | null {
  const row = getServerDb()
    .prepare("SELECT peer_public_key FROM federation_shares WHERE id = ?")
    .get(shareId) as { peer_public_key: string | null } | undefined;
  return row?.peer_public_key ? parsePeerPublicKey(row.peer_public_key) : null;
}

export function shareRow(shareId: string): ShareRow | undefined {
  return getRow(shareId);
}

export function touchShare(shareId: string, now = Date.now()): void {
  getServerDb().prepare("UPDATE federation_shares SET last_seen_at = ? WHERE id = ?").run(now, shareId);
}

// ---------------------------------------------------------------------------
// Scope and opaque refs
// ---------------------------------------------------------------------------

/**
 * A friend's tracks kept offline here are theirs, not ours to pass on: every
 * scope query excludes the remote libraries' managed cache folders, whether a
 * share names one directly or reaches its tracks through a playlist.
 */
function notRemoteCache(column: string): string {
  // COALESCE: `NULL NOT IN (…)` is NULL, which would drop a folderless track.
  return `COALESCE(${column}, 0) NOT IN (SELECT cache_folder_id FROM remote_libraries WHERE cache_folder_id IS NOT NULL)`;
}

/**
 * Every library track id this share currently exposes: the tracks of its
 * folders plus the current members of its playlists. Resolved live.
 */
export function resolveScopeTrackIds(libraryDb: Database.Database, shareId: string): Set<number> {
  const scope = scopeOf(shareId);
  const ids = new Set<number>();
  const chunk = <T,>(arr: T[], n: number): T[][] =>
    arr.length === 0 ? [] : Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
  for (const part of chunk(scope.folderIds, 500)) {
    const rows = libraryDb
      .prepare(
        `SELECT id FROM tracks WHERE library_folder_id IN (${part.map(() => "?").join(",")})
            AND ${notRemoteCache("library_folder_id")}`
      )
      .all(...part) as { id: number }[];
    for (const r of rows) ids.add(r.id);
  }
  for (const part of chunk(scope.playlistIds, 500)) {
    const rows = libraryDb
      .prepare(
        `SELECT DISTINCT pi.track_id AS id FROM playlist_items pi
           JOIN tracks t ON t.id = pi.track_id
          WHERE pi.playlist_id IN (${part.map(() => "?").join(",")})
            AND ${notRemoteCache("t.library_folder_id")}`
      )
      .all(...part) as { id: number }[];
    for (const r of rows) ids.add(r.id);
  }
  return ids;
}

/** Is this one track inside the share right now? The per-request check. */
export function trackInScope(libraryDb: Database.Database, shareId: string, trackId: number): boolean {
  if (!libraryDb.prepare(`SELECT 1 FROM tracks WHERE id = ? AND ${notRemoteCache("library_folder_id")}`).get(trackId)) {
    return false;
  }
  const scope = scopeOf(shareId);
  if (scope.folderIds.length > 0) {
    const row = libraryDb
      .prepare(
        `SELECT 1 FROM tracks WHERE id = ? AND library_folder_id IN (${scope.folderIds
          .map(() => "?")
          .join(",")})`
      )
      .get(trackId, ...scope.folderIds);
    if (row) return true;
  }
  if (scope.playlistIds.length > 0) {
    const row = libraryDb
      .prepare(
        `SELECT 1 FROM playlist_items WHERE track_id = ? AND playlist_id IN (${scope.playlistIds
          .map(() => "?")
          .join(",")}) LIMIT 1`
      )
      .get(trackId, ...scope.playlistIds);
    if (row) return true;
  }
  return false;
}

/** The opaque ref for each track id, minting any that are missing. */
export function refsForTracks(shareId: string, trackIds: number[]): Map<number, string> {
  const db = getServerDb();
  const out = new Map<number, string>();
  const select = db.prepare(
    "SELECT ref FROM federation_share_refs WHERE share_id = ? AND track_id = ?"
  );
  const insert = db.prepare(
    "INSERT INTO federation_share_refs (share_id, ref, track_id) VALUES (?, ?, ?)"
  );
  db.transaction(() => {
    for (const id of trackIds) {
      const row = select.get(shareId, id) as { ref: string } | undefined;
      if (row) {
        out.set(id, row.ref);
        continue;
      }
      const ref = crypto.randomBytes(12).toString("base64url");
      insert.run(shareId, ref, id);
      out.set(id, ref);
    }
  })();
  return out;
}

export function trackIdForRef(shareId: string, ref: string): number | null {
  if (ref.length > 32) return null;
  const row = getServerDb()
    .prepare("SELECT track_id FROM federation_share_refs WHERE share_id = ? AND ref = ?")
    .get(shareId, ref) as { track_id: number } | undefined;
  return row?.track_id ?? null;
}

// ---------------------------------------------------------------------------
// Usage accounting
// ---------------------------------------------------------------------------

function today(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function bytesServedToday(shareId: string, now = Date.now()): number {
  const row = getServerDb()
    .prepare("SELECT bytes FROM federation_share_usage WHERE share_id = ? AND day = ?")
    .get(shareId, today(now)) as { bytes: number } | undefined;
  return row?.bytes ?? 0;
}

export function recordBytesServed(shareId: string, bytes: number, now = Date.now()): void {
  if (bytes <= 0) return;
  const db = getServerDb();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO federation_share_usage (share_id, day, bytes) VALUES (?, ?, ?)
       ON CONFLICT(share_id, day) DO UPDATE SET bytes = bytes + excluded.bytes`
    ).run(shareId, today(now), bytes);
    db.prepare("UPDATE federation_shares SET bytes_served = bytes_served + ? WHERE id = ?").run(
      bytes,
      shareId
    );
    // Thirty days is plenty for "what did this friend pull this month".
    db.prepare("DELETE FROM federation_share_usage WHERE share_id = ? AND day < ?").run(
      shareId,
      today(now - 30 * 24 * 60 * 60 * 1000)
    );
  })();
}
