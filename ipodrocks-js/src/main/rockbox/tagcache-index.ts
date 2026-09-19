import * as fs from "fs";
import * as path from "path";

import {
  FLAG,
  MASTER_HEADER_SIZE,
  TAG,
  TcdFormatError,
  decodeIndex,
  decodeMasterHeader,
  decodeTagFile,
  flagOffset,
  numericTagOffset,
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
 * Read the runtime snapshot off a mounted device.
 *
 * Returns null when there is no database to read; throws only on genuinely
 * unexpected I/O. A malformed index is reported as null rather than thrown so
 * one bad device cannot abort a sync.
 */
export function readRuntimeIndex(
  mountPath: string
): RockboxRuntimeSnapshot | null {
  const idxFile = indexPath(mountPath);
  if (!fs.existsSync(idxFile)) return null;

  let header: MasterHeader;
  let idxBuf: Buffer;
  try {
    idxBuf = fs.readFileSync(idxFile);
    header = decodeMasterHeader(idxBuf, idxBuf.length);
  } catch (err) {
    console.error("[tagcache-index] failed to read index:", err);
    return null;
  }

  let paths: Map<number, string>;
  try {
    paths = decodeTagFile(fs.readFileSync(filenameTagPath(mountPath)), header.swapped);
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
      rating: entry.tagSeek[TAG.rating],
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
 * Classify what runtime data this device can offer, so the UI can give an
 * actionable instruction instead of an empty list.
 *
 * A single track with no plays is never an error — it simply has not been
 * played. Only a database with *no* recorded plays at all points at the
 * Gather Runtime Data setting being off.
 */
export function detectRuntimeCapability(mountPath: string): RuntimeDataState {
  const idxFile = indexPath(mountPath);
  if (!fs.existsSync(idxFile)) {
    return { kind: "no-database", message: MSG_NO_DATABASE };
  }

  let header: MasterHeader;
  try {
    const buf = fs.readFileSync(idxFile, { flag: "r" });
    header = decodeMasterHeader(buf, buf.length);
  } catch (err) {
    const message =
      err instanceof TcdFormatError
        ? `Rockbox database could not be read: ${err.message}`
        : "Rockbox database could not be read.";
    return { kind: "unreadable", message };
  }

  if (header.dirty !== 0) {
    return { kind: "busy", message: MSG_BUSY };
  }

  const snapshot = readRuntimeIndex(mountPath);
  if (!snapshot) {
    return {
      kind: "unreadable",
      message: "Rockbox database could not be read.",
    };
  }

  const tracksWithPlays = snapshot.entries.filter((e) => e.playCount > 0).length;
  // serial is bumped on every play, so 0 plays *and* serial 0 means nothing has
  // ever been recorded. This is also the state of a freshly initialized
  // database with the setting already on, hence the "play a track" half of the
  // message.
  if (tracksWithPlays === 0 && snapshot.serial === 0) {
    return { kind: "no-runtime-data", message: MSG_NO_RUNTIME_DATA };
  }

  return {
    kind: "ok",
    entryCount: snapshot.entryCount,
    tracksWithPlays,
  };
}

/** Mount paths whose index we have already backed up this session. */
const backedUp = new Set<string>();

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

    // Never write into a database Rockbox is still updating, and never address
    // past the records the header accounts for.
    if (header.dirty !== 0) return "unavailable";
    if (idxId < 0 || idxId >= header.entryCount) {
      throw new TcdFormatError(
        `index id ${idxId} out of range (${header.entryCount} entries)`
      );
    }

    const ratingAt = numericTagOffset(idxId, TAG.rating);
    const flagAt = flagOffset(idxId);
    const word = Buffer.alloc(4);

    fs.readSync(fd, word, 0, 4, ratingAt);
    const current = header.swapped ? word.readInt32BE(0) : word.readInt32LE(0);
    if (current === rating) return "unchanged";

    // Back up only once we know a write is actually going to happen.
    backupIndexOnce(mountPath);

    if (header.swapped) word.writeInt32BE(rating, 0);
    else word.writeInt32LE(rating, 0);
    fs.writeSync(fd, word, 0, 4, ratingAt);

    fs.readSync(fd, word, 0, 4, flagAt);
    const flag = header.swapped ? word.readInt32BE(0) : word.readInt32LE(0);
    const dirtied = flag | FLAG.DIRTYNUM;
    if (dirtied !== flag) {
      if (header.swapped) word.writeInt32BE(dirtied, 0);
      else word.writeInt32LE(dirtied, 0);
      fs.writeSync(fd, word, 0, 4, flagAt);
    }

    fs.fsyncSync(fd);
    return "written";
  } finally {
    fs.closeSync(fd);
  }
}
