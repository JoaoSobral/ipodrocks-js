import * as fs from "fs";
import * as path from "path";

import type { DeviceFs } from "../devices/fs/device-fs";

import {
  FLAG,
  MASTER_HEADER_SIZE,
  TAG,
  TcdFormatError,
  decodeIndex,
  decodeMasterHeader,
  decodeTagFile,
  planRatingEdits,
  planRatingProbe,
  type MasterHeader,
} from "./tcd-format";

/**
 * Reads (and narrowly writes) Rockbox's runtime data in ``.rockbox``.
 *
 * This is the only place in the app that touches ``.tcd`` bytes. Everything
 * downstream works with ``RockboxRuntimeEntry``.
 */

const INDEX_FILE = "database_idx.tcd";
const FILENAME_TAG_FILE = `database_${TAG.filename}.tcd`;
const BACKUP_SUFFIX = ".ipodrocks-bak";

function indexPath(mountPath: string): string {
  return path.join(mountPath, ".rockbox", INDEX_FILE);
}

function filenameTagPath(mountPath: string): string {
  return path.join(mountPath, ".rockbox", FILENAME_TAG_FILE);
}

export interface RockboxRuntimeEntry {
  /**
   * Position in ``database_idx.tcd``.
   *
   * Valid only within the snapshot it came from — a "Database -> Initialize
   * Now" on the device renumbers every entry. Read, match and write inside one
   * pass; never persist this.
   */
  idxId: number;
  /** Device-absolute path as Rockbox stores it, e.g. ``/<HDD0>/Music/a/b.mp3``. */
  devicePath: string;
  playCount: number;
  playTimeMs: number;
  /** 0-10, where 0 means unrated (Rockbox has no null). */
  rating: number;
  /** Ordering only — a global counter, not a date. See ``serial`` below. */
  lastPlayedSerial: number;
  lengthMs: number;
  flags: number;
}

export interface RockboxRuntimeSnapshot {
  entries: RockboxRuntimeEntry[];
  /**
   * ``master_header.serial``: one past the highest ``lastPlayedSerial`` ever
   * written. A reset to 0 means the database was rebuilt, which is a far more
   * reliable rebuild signal than inferring one from mass-zeroed ratings.
   */
  serial: number;
  commitId: number;
  entryCount: number;
}

export type RuntimeDataState =
  /** Index present and carrying at least one recorded play. */
  | { kind: "ok"; entryCount: number; tracksWithPlays: number }
  /** No ``database_idx.tcd`` — Rockbox has never built its database. */
  | { kind: "no-database"; message: string }
  /** Rockbox is mid-update; writing now would race it. */
  | { kind: "busy"; message: string }
  /** Database built, but nothing recorded yet. Not an error. */
  | { kind: "no-runtime-data"; message: string }
  /** Present but unreadable — corrupt, truncated, or an unsupported version. */
  | { kind: "unreadable"; message: string };

const MSG_NO_DATABASE =
  "Rockbox hasn't built its database yet. On the device: Settings → " +
  "Database → Initialize Now.";

const MSG_BUSY =
  "The device is still writing its database. Reconnect once Rockbox has " +
  "finished.";

const MSG_NO_RUNTIME_DATA =
  "No runtime data recorded yet. On the device, turn on Settings → " +
  "Playback Settings → Gather Runtime Data, then play a track for at " +
  "least 15 seconds.";

/**
 * The index file as read once: its bytes and decoded header, or why neither is
 * available.
 *
 * Reading it is deliberately separated from deciding what it means, because
 * the same read answers two questions — "what can this device offer" and "what
 * does it currently say" — and used to be performed once per question. A sync
 * read ``database_idx.tcd`` three times and ``database_4.tcd`` twice.
 */
type IndexRead =
  | { kind: "missing" }
  | { kind: "unreadable"; error: unknown }
  | { kind: "ok"; buf: Buffer; header: MasterHeader };

function readIndexFile(mountPath: string): IndexRead {
  const idxFile = indexPath(mountPath);
  if (!fs.existsSync(idxFile)) return { kind: "missing" };

  try {
    const buf = fs.readFileSync(idxFile);
    return { kind: "ok", buf, header: decodeMasterHeader(buf, buf.length) };
  } catch (error) {
    return { kind: "unreadable", error };
  }
}

/**
 * Build a snapshot from bytes already read. Pure.
 *
 * Shared by the local path and the browser-held one: only the two reads differ —
 * everything downstream is the same decoding of the same bytes.
 */

/**
 * Rockbox ratings are 0-10 and the index carries no checksum, so a word
 * outside that range is a corrupt or hostile record rather than an opinion:
 * read it as unrated.
 *
 * Every other writer of `tracks.rating` already bounds it — `ratings:
 * setTrackRating` clamps, `writeRating()` throws outside 0-10, and a fresh
 * `SCHEMA_SQL` declares a CHECK — but the decoder that *introduces* the value
 * did not, and this is the one function both the local and the `DeviceFs`
 * read paths share. Unbounded, a single bad record either tripped the CHECK
 * and rolled back the whole sync's rating merge (fresh install) or became the
 * library's canonical rating on a database upgraded by `migrateRatings()`,
 * which omits the CHECK — at which point `writeRating()` refused it forever
 * and that track's rating could never reach any player again.
 */
function sanitizeDeviceRating(raw: number): number {
  return Number.isInteger(raw) && raw >= 0 && raw <= 10 ? raw : 0;
}

function decodeSnapshotFrom(
  idxBuf: Buffer,
  header: MasterHeader,
  tagBuf: Buffer
): RockboxRuntimeSnapshot | null {
  let paths: Map<number, string>;
  try {
    paths = decodeTagFile(tagBuf, header.swapped);
  } catch (err) {
    console.error("[tagcache-index] failed to read filename tags:", err);
    return null;
  }

  const entries: RockboxRuntimeEntry[] = [];
  for (const entry of decodeIndex(idxBuf, header)) {
    const devicePath = paths.get(entry.idxId);
    // No filename means nothing we could ever match a library track against.
    if (!devicePath) continue;
    entries.push({
      idxId: entry.idxId,
      devicePath,
      playCount: entry.tagSeek[TAG.playcount],
      playTimeMs: entry.tagSeek[TAG.playtime],
      rating: sanitizeDeviceRating(entry.tagSeek[TAG.rating]),
      lastPlayedSerial: entry.tagSeek[TAG.lastplayed],
      lengthMs: entry.tagSeek[TAG.length],
      flags: entry.flag,
    });
  }

  return {
    entries,
    serial: header.serial,
    commitId: header.commitId,
    entryCount: header.entryCount,
  };
}

/**
 * Join the index records to the filename tag file, reading it locally.
 *
 * Returns null when the tag file cannot be read, which is reported the same
 * way a malformed index is: one bad device must not abort a sync.
 */
function decodeSnapshot(
  mountPath: string,
  idxBuf: Buffer,
  header: MasterHeader
): RockboxRuntimeSnapshot | null {
  let tagBuf: Buffer;
  try {
    tagBuf = fs.readFileSync(filenameTagPath(mountPath));
  } catch (err) {
    console.error("[tagcache-index] failed to read filename tags:", err);
    return null;
  }
  return decodeSnapshotFrom(idxBuf, header, tagBuf);
}

/**
 * What the index read alone already settles, or null when the answer needs the
 * snapshot. Pure, and shared by both read paths.
 */
function classifyIndexRead(idx: IndexRead): RuntimeRead | null {
  if (idx.kind === "missing") {
    return {
      state: { kind: "no-database", message: MSG_NO_DATABASE },
      snapshot: null,
    };
  }
  if (idx.kind === "unreadable") {
    const message =
      idx.error instanceof TcdFormatError
        ? `Rockbox database could not be read: ${idx.error.message}`
        : "Rockbox database could not be read.";
    return { state: { kind: "unreadable", message }, snapshot: null };
  }
  // The filename tag file is not even opened for a database Rockbox is still
  // updating: the answer is "busy" whatever it holds.
  if (idx.header.dirty !== 0) {
    return { state: { kind: "busy", message: MSG_BUSY }, snapshot: null };
  }
  return null;
}

/** What the snapshot settles. Pure, and shared by both read paths. */
function classifySnapshot(snapshot: RockboxRuntimeSnapshot | null): RuntimeRead {
  if (!snapshot) {
    return {
      state: {
        kind: "unreadable",
        message: "Rockbox database could not be read.",
      },
      snapshot: null,
    };
  }

  const tracksWithPlays = snapshot.entries.filter((e) => e.playCount > 0).length;
  // serial is bumped on every play, so 0 plays *and* serial 0 means nothing has
  // ever been recorded. This is also the state of a freshly initialized
  // database with the setting already on, hence the "play a track" half of the
  // message.
  if (tracksWithPlays === 0 && snapshot.serial === 0) {
    return {
      state: { kind: "no-runtime-data", message: MSG_NO_RUNTIME_DATA },
      snapshot: null,
    };
  }

  return {
    state: { kind: "ok", entryCount: snapshot.entryCount, tracksWithPlays },
    snapshot,
  };
}

/**
 * What one read of a device's runtime data says, and what it holds.
 *
 * ``snapshot`` is non-null exactly when ``state.kind === "ok"``.
 */
export interface RuntimeRead {
  state: RuntimeDataState;
  snapshot: RockboxRuntimeSnapshot | null;
}

/**
 * Read and classify a device's runtime data in a single pass over the two
 * ``.tcd`` files.
 *
 * A single track with no plays is never an error — it simply has not been
 * played. Only a database with *no* recorded plays at all points at the
 * Gather Runtime Data setting being off.
 */
export function readRuntimeData(mountPath: string): RuntimeRead {
  const idx = readIndexFile(mountPath);
  const settled = classifyIndexRead(idx);
  if (settled) return settled;
  const ok = idx as Extract<IndexRead, { kind: "ok" }>;
  return classifySnapshot(decodeSnapshot(mountPath, ok.buf, ok.header));
}

/**
 * {@link readRuntimeData} for a device reached through a `DeviceFs`.
 *
 * Separate from the local path rather than replacing it, because making the
 * local one async would infect `readAndIngestRuntimeData` and with it the
 * rating regression suites that pin every hazard in CLAUDE.md. Everything
 * below the two reads is the same pure code, so the duplication is two file
 * reads and nothing else.
 */
export async function readRuntimeDataOn(
  deviceFs: DeviceFs,
  mountPath: string
): Promise<RuntimeRead> {
  const idxFile = indexPath(mountPath);
  let idx: IndexRead;
  if (!(await deviceFs.exists(idxFile))) {
    idx = { kind: "missing" };
  } else {
    try {
      const buf = await deviceFs.readFile(idxFile);
      idx = { kind: "ok", buf, header: decodeMasterHeader(buf, buf.length) };
    } catch (error) {
      idx = { kind: "unreadable", error };
    }
  }

  const settled = classifyIndexRead(idx);
  if (settled) return settled;
  const ok = idx as Extract<IndexRead, { kind: "ok" }>;

  let tagBuf: Buffer;
  try {
    tagBuf = await deviceFs.readFile(filenameTagPath(mountPath));
  } catch (err) {
    console.error("[tagcache-index] failed to read filename tags:", err);
    return classifySnapshot(null);
  }
  return classifySnapshot(decodeSnapshotFrom(ok.buf, ok.header, tagBuf));
}

/**
 * Read the runtime snapshot off a mounted device.
 *
 * Returns null when there is no database to read; throws only on genuinely
 * unexpected I/O. A malformed index is reported as null rather than thrown so
 * one bad device cannot abort a sync.
 */
export function readRuntimeIndex(
  mountPath: string
): RockboxRuntimeSnapshot | null {
  const idx = readIndexFile(mountPath);
  if (idx.kind === "missing") return null;
  if (idx.kind === "unreadable") {
    console.error("[tagcache-index] failed to read index:", idx.error);
    return null;
  }
  return decodeSnapshot(mountPath, idx.buf, idx.header);
}

/**
 * Classify what runtime data this device can offer, so the UI can give an
 * actionable instruction instead of an empty list.
 */
export function detectRuntimeCapability(mountPath: string): RuntimeDataState {
  return readRuntimeData(mountPath).state;
}

/**
 * Mount paths whose index this *run* has already backed up.
 *
 * It used to mean "this session", which was true enough for a desktop app that
 * a user quits. In a daemon running for weeks it silently became "once ever":
 * the only backup anyone had was the one taken by the first sync after boot,
 * and every rating write for the next fortnight went in unprotected. Worse on
 * a browser-held device, where the player can be unplugged, rebuilt and
 * reconnected without the server process noticing at all.
 *
 * {@link beginIndexBackupRun} clears the entry at the top of each propagation
 * pass, so the cost is one file copy per sync per device — and only when a
 * write actually happens, because the backup is still taken lazily.
 */
const backedUp = new Set<string>();

/** Starts a fresh backup scope for one device. See {@link backedUp}. */
export function beginIndexBackupRun(mountPath: string): void {
  backedUp.delete(path.resolve(mountPath));
}

/**
 * Copy the index aside once per session, before the first write to it.
 *
 * The index carries no checksum and no redundancy, so a bad write is
 * unrecoverable. Backing up costs one file copy per device per run.
 */
export function backupIndexOnce(mountPath: string): void {
  const key = path.resolve(mountPath);
  if (backedUp.has(key)) return;

  const src = indexPath(mountPath);
  if (!fs.existsSync(src)) return;
  try {
    fs.copyFileSync(src, src + BACKUP_SUFFIX);
    backedUp.add(key);
  } catch (err) {
    console.error("[tagcache-index] failed to back up index:", err);
    throw err;
  }
}

/**
 * {@link backupIndexOnce} for a device reached through a `DeviceFs`.
 *
 * It matters *more* here than locally, not less: Chrome's `createWritable()`
 * copies the file to a `<name>.crswap` sibling and rewrites it wholesale
 * rather than patching in place, so a tab that dies mid-write can leave the
 * index in a state the local path would never produce — and it carries no
 * checksum.
 */
async function backupIndexOnceOn(
  deviceFs: DeviceFs,
  mountPath: string
): Promise<void> {
  const key = path.resolve(mountPath);
  if (backedUp.has(key)) return;

  const src = indexPath(mountPath);
  if (!(await deviceFs.exists(src))) return;
  try {
    await deviceFs.writeFile(src + BACKUP_SUFFIX, await deviceFs.readFile(src));
    backedUp.add(key);
  } catch (err) {
    console.error("[tagcache-index] failed to back up index:", err);
    throw err;
  }
}

/** Reset the backup bookkeeping. Test seam only. */
export function resetBackupState(): void {
  backedUp.clear();
}

/**
 * What a rating write actually did, which the caller has to know apart.
 *
 * This used to be a `boolean`, and that conflated two opposite things: "the
 * device already holds this value" (nothing to do, the rating *is* on the
 * device) and "the index could not be written at all" (the rating is **not** on
 * the device). The sync's Phase 3 recorded both as pushed, so a device whose
 * database Rockbox happened to be updating had every rating marked
 * `last_pushed_rating` without a byte reaching it — and
 * `computeRatingPropagations` then excluded those tracks forever (issue #138).
 */
export type RatingWriteResult =
  /** Bytes changed on the device. */
  | "written"
  /** The device already held this rating; nothing needed writing. */
  | "unchanged"
  /** Nothing could be written: no index, or Rockbox is mid-update. */
  | "unavailable";

/**
 * Write one track's rating into the index, exactly as Rockbox does internally:
 * seek to the single int32, write it, and flag the record's numeric data dirty
 * so the value survives a database rebuild.
 *
 * `"unchanged"` is what makes a second sync with no changes write no bytes.
 * `"unavailable"` must never be read as success — see {@link RatingWriteResult}.
 */
export function writeRating(
  mountPath: string,
  idxId: number,
  rating: number
): RatingWriteResult {
  if (!Number.isInteger(rating) || rating < 0 || rating > 10) {
    throw new RangeError(`invalid Rockbox rating: ${rating}`);
  }

  const idxFile = indexPath(mountPath);
  if (!fs.existsSync(idxFile)) return "unavailable";

  const headerBuf = Buffer.alloc(MASTER_HEADER_SIZE);
  const fd = fs.openSync(idxFile, "r+");
  try {
    const size = fs.fstatSync(fd).size;
    fs.readSync(fd, headerBuf, 0, MASTER_HEADER_SIZE, 0);
    const header = decodeMasterHeader(headerBuf, size);

    // Never write into a database Rockbox is still updating.
    if (header.dirty !== 0) return "unavailable";

    // Both words are read before anything is decided, so the whole write is
    // one batched read followed by one batched patch.
    const probe = planRatingProbe(header, idxId);
    const ratingWord = Buffer.alloc(4);
    const flagWord = Buffer.alloc(4);
    fs.readSync(fd, ratingWord, 0, 4, probe.ratingAt);
    fs.readSync(fd, flagWord, 0, 4, probe.flagAt);

    const edits = planRatingEdits(header, probe, rating, { ratingWord, flagWord });
    if (edits.length === 0) return "unchanged";

    // Back up only once we know a write is actually going to happen.
    backupIndexOnce(mountPath);

    for (const edit of edits) {
      fs.writeSync(fd, edit.bytes, 0, edit.bytes.length, edit.offset);
    }

    fs.fsyncSync(fd);
    return "written";
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * {@link writeRating} for a device reached through a `DeviceFs`.
 *
 * Byte-for-byte the same decision — {@link planRatingProbe} and
 * {@link planRatingEdits} are the whole of it, and are shared — over two
 * batched reads and one `patch`. That shape is why they were split out in the
 * first place: locally it saves a couple of syscalls, and here it is the
 * difference between three round trips and a dozen.
 *
 * Kept beside the local version rather than replacing it, because making
 * `writeRating` async infects `propagateRatingsToDevice` and with it
 * `regressions/rating-propagation-gap.test.ts`, which pins issue #138.
 */
export async function writeRatingOn(
  deviceFs: DeviceFs,
  mountPath: string,
  idxId: number,
  rating: number
): Promise<RatingWriteResult> {
  if (!Number.isInteger(rating) || rating < 0 || rating > 10) {
    throw new RangeError(`invalid Rockbox rating: ${rating}`);
  }

  const idxFile = indexPath(mountPath);
  const stat = await deviceFs.stat(idxFile);
  if (!stat || stat.isDirectory) return "unavailable";

  const headerBuf = await deviceFs.readRange(idxFile, 0, MASTER_HEADER_SIZE);
  const header = decodeMasterHeader(headerBuf, stat.size);

  // Never write into a database Rockbox is still updating.
  if (header.dirty !== 0) return "unavailable";

  const probe = planRatingProbe(header, idxId);
  const [ratingWord, flagWord] = await Promise.all([
    deviceFs.readRange(idxFile, probe.ratingAt, 4),
    deviceFs.readRange(idxFile, probe.flagAt, 4),
  ]);

  const edits = planRatingEdits(header, probe, rating, { ratingWord, flagWord });
  if (edits.length === 0) return "unchanged";

  // Back up only once we know a write is actually going to happen.
  await backupIndexOnceOn(deviceFs, mountPath);

  await deviceFs.patch(
    idxFile,
    edits.map((edit) => ({ offset: edit.offset, bytes: edit.bytes }))
  );
  return "written";
}
