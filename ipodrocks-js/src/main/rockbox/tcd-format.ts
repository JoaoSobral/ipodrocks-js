/**
 * Rockbox tagcache binary format — pure decoders, no filesystem access.
 *
 * Rockbox's "Gather Runtime Data" setting makes it record play count, listening
 * time, play ordering and rating directly in its own database, under
 * ``.rockbox/``. Everything we need lives in two files:
 *
 *   database_idx.tcd  the master index: a 24-byte header followed by one
 *                     fixed-size record per track. Numeric tags (playcount,
 *                     rating, playtime, lastplayed, …) are stored *inline* in
 *                     the record; string tags hold a byte offset into a
 *                     per-tag file.
 *   database_4.tcd    the filename tag file, whose entries carry an ``idx_id``
 *                     back-pointer to the index record. This is what makes the
 *                     device-path -> runtime-record mapping exact rather than a
 *                     metadata guess.
 *
 * Layout mirrors ``struct master_header`` / ``struct index_entry`` /
 * ``struct tagfile_entry`` in upstream ``apps/tagcache.c``.
 */

/** ``'T' << 24 | 'C' << 16 | 'H' << 8 | version`` — version 0x10 is current. */
export const TAGCACHE_MAGIC = 0x54434810;

/** Bytes of ``struct master_header``: tagcache_header (3 ints) + 3 ints. */
export const MASTER_HEADER_SIZE = 24;

/** Bytes of ``struct tagcache_header`` at the head of every tag file. */
export const TAG_HEADER_SIZE = 12;

/**
 * Number of real tags in ``struct index_entry.tag_seek``.
 *
 * Do not treat this as gospel when reading: Rockbox bumps the magic's version
 * byte whenever a tag is added, so we derive the true stride from the file and
 * only use this to name the tags we know. See ``decodeMasterHeader``.
 */
export const TAG_COUNT = 23;

/** ``sizeof(struct index_entry)`` for TAG_COUNT tags plus the flag word. */
export const INDEX_ENTRY_SIZE = (TAG_COUNT + 1) * 4;

/** Tag indices into ``index_entry.tag_seek``. */
export const TAG = {
  artist: 0,
  album: 1,
  genre: 2,
  title: 3,
  filename: 4,
  composer: 5,
  comment: 6,
  albumartist: 7,
  grouping: 8,
  year: 9,
  discnumber: 10,
  tracknumber: 11,
  canonicalartist: 12,
  bitrate: 13,
  length: 14,
  playcount: 15,
  rating: 16,
  playtime: 17,
  lastplayed: 18,
  commitid: 19,
  mtime: 20,
  lastelapsed: 21,
  lastoffset: 22,
} as const;

/** ``index_entry.flag`` bits. */
export const FLAG = {
  /** Entry has been removed from the database. */
  DELETED: 0x0001,
  /** Filename is a dircache pointer — memory-only, never on disk. */
  DIRCACHE: 0x0002,
  /** Numeric data has been modified since the last commit. */
  DIRTYNUM: 0x0004,
  /** Track number was generated rather than read from a tag. */
  TRKNUMGEN: 0x0008,
  /** Statistics were carried across a database rebuild. */
  RESURRECTED: 0x0010,
} as const;

export class TcdFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TcdFormatError";
  }
}

export interface MasterHeader {
  /** Format version byte off the magic (0x10 at time of writing). */
  version: number;
  datasize: number;
  entryCount: number;
  /**
   * Global monotonic play counter. Rockbox stamps ``lastplayed`` with the
   * pre-increment value on every play, so this is one past the highest
   * ``lastplayed`` in the file — and ``0`` means nothing has ever been played.
   */
  serial: number;
  commitId: number;
  /** Non-zero while Rockbox is mid-update; the file must not be written then. */
  dirty: number;
  /** True when the file is big-endian and every int32 needs swapping. */
  swapped: boolean;
  /** Bytes per index record, derived from the file rather than assumed. */
  entrySize: number;
}

/** Read one int32 honouring the file's byte order. */
function readInt32(buf: Buffer, offset: number, swapped: boolean): number {
  return swapped ? buf.readInt32BE(offset) : buf.readInt32LE(offset);
}

/**
 * Decode the master header and work out the record stride.
 *
 * ``fileSize`` is checked against the header rather than trusted: a truncated
 * or mis-sized index would otherwise give plausible-looking garbage, and this
 * file has no checksum to fall back on.
 */
export function decodeMasterHeader(buf: Buffer, fileSize: number): MasterHeader {
  if (buf.length < MASTER_HEADER_SIZE) {
    throw new TcdFormatError(
      `index header truncated: ${buf.length} bytes, need ${MASTER_HEADER_SIZE}`
    );
  }

  const le = buf.readInt32LE(0);
  const be = buf.readInt32BE(0);
  let swapped: boolean;
  let magic: number;
  if ((le & ~0xff) === (TAGCACHE_MAGIC & ~0xff)) {
    swapped = false;
    magic = le;
  } else if ((be & ~0xff) === (TAGCACHE_MAGIC & ~0xff)) {
    swapped = true;
    magic = be;
  } else {
    throw new TcdFormatError(
      `not a Rockbox tagcache file (magic 0x${(le >>> 0).toString(16)})`
    );
  }

  const entryCount = readInt32(buf, 8, swapped);
  if (entryCount < 0) {
    throw new TcdFormatError(`negative entry count: ${entryCount}`);
  }

  // Rockbox bumps the version byte when tags are added, which changes the
  // record stride. Derive it instead of assuming, then refuse anything we
  // cannot address safely.
  const body = fileSize - MASTER_HEADER_SIZE;
  if (entryCount === 0) {
    if (body !== 0) {
      throw new TcdFormatError(
        `index claims 0 entries but carries ${body} bytes of records`
      );
    }
  } else if (body !== entryCount * INDEX_ENTRY_SIZE) {
    throw new TcdFormatError(
      `index size mismatch: ${body} bytes of records for ${entryCount} entries ` +
        `(expected ${entryCount * INDEX_ENTRY_SIZE}; unsupported tagcache version?)`
    );
  }

  return {
    version: magic & 0xff,
    datasize: readInt32(buf, 4, swapped),
    entryCount,
    serial: readInt32(buf, 12, swapped),
    commitId: readInt32(buf, 16, swapped),
    dirty: readInt32(buf, 20, swapped),
    swapped,
    entrySize: INDEX_ENTRY_SIZE,
  };
}

export interface IndexEntry {
  idxId: number;
  tagSeek: number[];
  flag: number;
}

/** Byte offset of one index record's numeric tag, for a targeted read/write. */
export function numericTagOffset(idxId: number, tag: number): number {
  return MASTER_HEADER_SIZE + idxId * INDEX_ENTRY_SIZE + tag * 4;
}

/** Byte offset of one index record's flag word. */
export function flagOffset(idxId: number): number {
  return MASTER_HEADER_SIZE + idxId * INDEX_ENTRY_SIZE + TAG_COUNT * 4;
}

/** Decode a single index record. */
export function decodeIndexEntry(
  buf: Buffer,
  idxId: number,
  header: MasterHeader
): IndexEntry {
  const base = MASTER_HEADER_SIZE + idxId * INDEX_ENTRY_SIZE;
  if (base + INDEX_ENTRY_SIZE > buf.length) {
    throw new TcdFormatError(`index entry ${idxId} runs past end of file`);
  }
  const tagSeek: number[] = new Array(TAG_COUNT);
  for (let t = 0; t < TAG_COUNT; t++) {
    tagSeek[t] = readInt32(buf, base + t * 4, header.swapped);
  }
  return {
    idxId,
    tagSeek,
    flag: readInt32(buf, base + TAG_COUNT * 4, header.swapped),
  };
}

/** Decode every index record, skipping deleted ones. */
export function decodeIndex(buf: Buffer, header: MasterHeader): IndexEntry[] {
  const out: IndexEntry[] = [];
  for (let i = 0; i < header.entryCount; i++) {
    const entry = decodeIndexEntry(buf, i, header);
    if (entry.flag & FLAG.DELETED) continue;
    out.push(entry);
  }
  return out;
}

/**
 * Decode a string tag file into ``idx_id -> value``.
 *
 * Rockbox NUL-terminates each string and then pads with ``'X'`` up to 4-byte
 * alignment, counting the padding in ``tag_length`` — the device holds
 * ``"3 Doors Down\0XXX"``. Reading the full length would leave that padding on
 * every value and make every path comparison fail while looking like a
 * matching bug, so the value is truncated at the first NUL.
 */
export function decodeTagFile(
  buf: Buffer,
  swapped: boolean
): Map<number, string> {
  const out = new Map<number, string>();
  if (buf.length < TAG_HEADER_SIZE) {
    throw new TcdFormatError(
      `tag file truncated: ${buf.length} bytes, need ${TAG_HEADER_SIZE}`
    );
  }
  const entryCount = readInt32(buf, 8, swapped);
  let pos = TAG_HEADER_SIZE;

  for (let i = 0; i < entryCount; i++) {
    if (pos + 8 > buf.length) {
      throw new TcdFormatError(`tag entry ${i} header runs past end of file`);
    }
    const tagLength = readInt32(buf, pos, swapped);
    const idxId = readInt32(buf, pos + 4, swapped);
    const dataStart = pos + 8;
    const dataEnd = dataStart + tagLength;
    if (tagLength < 0 || dataEnd > buf.length) {
      throw new TcdFormatError(`tag entry ${i} data runs past end of file`);
    }

    // idx_id is -1 on non-unique tags (artist, album, …) where one string is
    // shared by many tracks. Only unique tags such as filename point back.
    if (idxId >= 0) {
      let nul = buf.indexOf(0, dataStart);
      if (nul < 0 || nul > dataEnd) nul = dataEnd;
      out.set(idxId, buf.toString("utf8", dataStart, nul));
    }

    pos = dataEnd;
  }

  return out;
}
