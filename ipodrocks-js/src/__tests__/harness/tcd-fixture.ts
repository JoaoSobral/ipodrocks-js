import * as fs from "fs";
import * as path from "path";

/**
 * Builds a valid pair of Rockbox tagcache files.
 *
 * The playback.log path could never be exercised end to end — there was no way
 * to produce a device that had actually recorded plays. Runtime data lives in a
 * fixed-layout binary file, so it *can* be generated, which is what makes the
 * whole import and rating write-back loop testable without a real iPod.
 *
 * Layout mirrors src/main/rockbox/tcd-format.ts; see that file for the format.
 */

const MAGIC = 0x54434810;
const MASTER_HEADER_SIZE = 24;
const TAG_HEADER_SIZE = 12;
const TAG_COUNT = 23;
const INDEX_ENTRY_SIZE = (TAG_COUNT + 1) * 4;
const TAG_FILENAME = 4;
const TAG_LENGTH = 14;
const TAG_PLAYCOUNT = 15;
const TAG_RATING = 16;
const TAG_PLAYTIME = 17;
const TAG_LASTPLAYED = 18;

export interface TcdFixtureTrack {
  /** Device-absolute path as Rockbox stores it, e.g. "/<HDD0>/Music/a/b.mp3". */
  path: string;
  playCount?: number;
  playTimeMs?: number;
  /** 0-10; 0 means unrated. */
  rating?: number;
  lastPlayedSerial?: number;
  lengthMs?: number;
  /** Raw flag word — set FLAG_DELETED (0x1) or FLAG_DIRTYNUM (0x4) directly. */
  flag?: number;
}

export interface TcdFixtureOptions {
  /**
   * master_header.serial. Defaults to one past the highest lastPlayedSerial,
   * which is what Rockbox itself leaves behind. Pass 0 explicitly to model a
   * database that has never recorded a play.
   */
  serial?: number;
  commitId?: number;
  dirty?: number;
  /** Write the files big-endian, as Rockbox does on some targets. */
  bigEndian?: boolean;
}

function writeInt32(buf: Buffer, value: number, offset: number, be: boolean): void {
  if (be) buf.writeInt32BE(value, offset);
  else buf.writeInt32LE(value, offset);
}

/**
 * Write database_idx.tcd and database_4.tcd into `<mountPath>/.rockbox`.
 *
 * Returns each track's idxId, in the order given, so a test can address a
 * single record's bytes afterwards.
 */
export function writeTcdFixture(
  mountPath: string,
  tracks: TcdFixtureTrack[],
  options: TcdFixtureOptions = {}
): number[] {
  const be = options.bigEndian ?? false;
  const rockboxDir = path.join(mountPath, ".rockbox");
  fs.mkdirSync(rockboxDir, { recursive: true });

  const highestSerial = tracks.reduce(
    (max, t) => Math.max(max, t.lastPlayedSerial ?? 0),
    -1
  );
  const serial = options.serial ?? highestSerial + 1;

  // --- master index -------------------------------------------------------
  const idx = Buffer.alloc(MASTER_HEADER_SIZE + tracks.length * INDEX_ENTRY_SIZE);
  writeInt32(idx, MAGIC, 0, be);
  writeInt32(idx, 0, 4, be); // datasize — Rockbox recomputes it, nothing reads it
  writeInt32(idx, tracks.length, 8, be);
  writeInt32(idx, serial, 12, be);
  writeInt32(idx, options.commitId ?? 1, 16, be);
  writeInt32(idx, options.dirty ?? 0, 20, be);

  // --- filename tag file --------------------------------------------------
  // Each entry is {int32 tag_length, int32 idx_id, char data[tag_length]},
  // where the data is NUL-terminated and then padded with 'X' to a 4-byte
  // boundary — padding that tag_length counts.
  const tagEntries: Buffer[] = [];
  let tagOffset = TAG_HEADER_SIZE;
  const idxIds: number[] = [];

  tracks.forEach((track, i) => {
    const base = MASTER_HEADER_SIZE + i * INDEX_ENTRY_SIZE;
    writeInt32(idx, tagOffset, base + TAG_FILENAME * 4, be);
    writeInt32(idx, track.lengthMs ?? 200_000, base + TAG_LENGTH * 4, be);
    writeInt32(idx, track.playCount ?? 0, base + TAG_PLAYCOUNT * 4, be);
    writeInt32(idx, track.rating ?? 0, base + TAG_RATING * 4, be);
    writeInt32(idx, track.playTimeMs ?? 0, base + TAG_PLAYTIME * 4, be);
    writeInt32(idx, track.lastPlayedSerial ?? 0, base + TAG_LASTPLAYED * 4, be);
    writeInt32(idx, track.flag ?? 0, base + TAG_COUNT * 4, be);

    const raw = Buffer.from(track.path, "utf8");
    const withNul = raw.length + 1;
    const padded = Math.ceil(withNul / 4) * 4;
    const data = Buffer.alloc(padded, 0x58 /* 'X' */);
    raw.copy(data, 0);
    data[raw.length] = 0;

    const entry = Buffer.alloc(8 + padded);
    writeInt32(entry, padded, 0, be);
    writeInt32(entry, i, 4, be);
    data.copy(entry, 8);
    tagEntries.push(entry);

    tagOffset += entry.length;
    idxIds.push(i);
  });

  const tagBody = Buffer.concat(tagEntries);
  const tagFile = Buffer.alloc(TAG_HEADER_SIZE + tagBody.length);
  writeInt32(tagFile, MAGIC, 0, be);
  writeInt32(tagFile, tagBody.length, 4, be);
  writeInt32(tagFile, tracks.length, 8, be);
  tagBody.copy(tagFile, TAG_HEADER_SIZE);

  fs.writeFileSync(path.join(rockboxDir, "database_idx.tcd"), idx);
  fs.writeFileSync(
    path.join(rockboxDir, `database_${TAG_FILENAME}.tcd`),
    tagFile
  );

  return idxIds;
}

/** Read one numeric tag straight out of a fixture, for byte-level assertions. */
export function readTcdNumericTag(
  mountPath: string,
  idxId: number,
  tag: number,
  bigEndian = false
): number {
  const buf = fs.readFileSync(
    path.join(mountPath, ".rockbox", "database_idx.tcd")
  );
  const at = MASTER_HEADER_SIZE + idxId * INDEX_ENTRY_SIZE + tag * 4;
  return bigEndian ? buf.readInt32BE(at) : buf.readInt32LE(at);
}

export const TCD_TAG = {
  length: TAG_LENGTH,
  playcount: TAG_PLAYCOUNT,
  rating: TAG_RATING,
  playtime: TAG_PLAYTIME,
  lastplayed: TAG_LASTPLAYED,
  flag: TAG_COUNT,
} as const;
