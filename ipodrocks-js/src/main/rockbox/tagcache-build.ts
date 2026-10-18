/**
 * Rockbox tagcache — a pure *encoder* for the whole database, and the full
 * decoder it is checked against. No filesystem access; see `tagcache-sync.ts`
 * for where the bytes come from and go to.
 *
 * Rockbox builds this database on the player ("Database → Initialize now"),
 * which takes minutes on a full iPod and has to happen again after every sync
 * before the new music is browsable. iPodRocks already knows every tag of every
 * file it just copied, so it writes the finished database itself.
 *
 * **Everything here mirrors `apps/tagcache.c` (Rockbox 4.x, magic 0x54434810)
 * and must keep mirroring it.** Rockbox does not repair a database it did not
 * write; anything it disagrees with fails the load, and the player then shows
 * no database at all until the user initializes it on the device. The rules,
 * each cited where it is applied below:
 *
 *  - every file is native-endian; iPods are little-endian, so LE throughout
 *  - string tags live in one file each, numeric tags inline in the index
 *  - "unique" tags are deduplicated case-insensitively and carry idx_id -1;
 *    title is sorted but one entry per track; filename is neither
 *  - sorted files are ordered `<Untagged>` first, then `strncasecmp`
 *  - sorted entries are padded with 'X' so header + data is a multiple of 8
 *  - the master header's datasize is the RAM the device allocates to load it
 *
 * Pinned in `src/__tests__/regressions/tagcache-encoder.test.ts`, including a
 * hand-assembled fixture: a round trip through our own decoder would pass for
 * an encoder and decoder that share the same misreading of the format.
 */

import {
  FLAG,
  INDEX_ENTRY_SIZE,
  MASTER_HEADER_SIZE,
  TAG,
  TAG_COUNT,
  TAG_HEADER_SIZE,
  TAGCACHE_MAGIC,
  TcdFormatError,
  decodeIndex,
  decodeMasterHeader,
  type MasterHeader,
} from "./tcd-format";

/** `UNTAGGED` in tagcache.h — what an empty or missing string tag becomes. */
export const UNTAGGED = "<Untagged>";

/** `TAG_MAXLEN` = `MAX_PATH * 2` (tagcache.h:56), in bytes, excluding the NUL. */
export const TAG_MAXLEN = 520;

/** `MAX_PATH`. `add_tagcache` refuses a longer path outright (tagcache.c:2285). */
export const MAX_PATH = 260;

/** `TAGFILE_ENTRY_CHUNK_LENGTH`: sorted entries are padded to this (tagcache.c:2587). */
const CHUNK = 8;

/** Bytes of `struct tagfile_entry` before the data: tag_length + idx_id. */
const TAGFILE_ENTRY_HEADER = 8;

/** The string tags, in the order their files are numbered. */
export const STRING_TAGS = [
  TAG.artist,
  TAG.album,
  TAG.genre,
  TAG.title,
  TAG.filename,
  TAG.composer,
  TAG.comment,
  TAG.albumartist,
  TAG.grouping,
  TAG.canonicalartist,
] as const;

/** `TAGCACHE_UNIQUE_TAGS` (tagcache.c:208). */
const UNIQUE_TAGS = new Set<number>([
  TAG.artist,
  TAG.album,
  TAG.genre,
  TAG.composer,
  TAG.comment,
  TAG.albumartist,
  TAG.grouping,
  TAG.canonicalartist,
]);

/** The file name Rockbox opens for a string tag (`open_tag_fd`). */
export function tagFileName(tag: number): string {
  return `database_${tag}.tcd`;
}

export const INDEX_FILE_NAME = "database_idx.tcd";

/** The play statistics Rockbox keeps per track and must survive a rebuild. */
export interface TagcacheRuntime {
  playcount: number;
  rating: number;
  playtime: number;
  lastplayed: number;
  commitid: number;
  lastelapsed: number;
  lastoffset: number;
}

export const NO_RUNTIME: TagcacheRuntime = {
  playcount: 0,
  rating: 0,
  playtime: 0,
  lastplayed: 0,
  commitid: 0,
  lastelapsed: 0,
  lastoffset: 0,
};

/** One track, as Rockbox would have read it off the file. */
export interface TagcacheEntry {
  /** Device-absolute, exactly as Rockbox's own scan spells it: `/Music/A/b.mp3`. */
  filename: string;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  genre?: string | null;
  composer?: string | null;
  comment?: string | null;
  albumartist?: string | null;
  grouping?: string | null;
  /** 0 when missing (`wipe_mp3entry`). */
  year?: number | null;
  discnumber?: number | null;
  /** -1 when missing (tagcache.c:2349). */
  tracknumber?: number | null;
  /** kbps. */
  bitrate?: number | null;
  /** Milliseconds. */
  length?: number | null;
  /** See `rockboxMtime()` in tagcache-sync.ts. */
  mtime?: number | null;
  runtime?: TagcacheRuntime | null;
}

/** Bytes of `s` as UTF-8, cut at a character boundary to at most `max` bytes. */
function utf8Truncated(s: string, max: number): Buffer {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= max) return buf;
  let end = max;
  // Back off continuation bytes so a multi-byte character is never split.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end);
}

/**
 * A string tag as `check_if_empty()` leaves it: `<Untagged>` when empty,
 * otherwise NFC (Rockbox normalizes metadata strings, metadata.c:485) and cut
 * to `TAG_MAXLEN` bytes.
 */
export function tagValue(value: string | null | undefined): Buffer {
  const v = (value ?? "").normalize("NFC");
  if (v === "") return Buffer.from(UNTAGGED, "utf8");
  return utf8Truncated(v, TAG_MAXLEN);
}

function asciiLower(b: number): number {
  return b >= 0x41 && b <= 0x5a ? b + 0x20 : b;
}

const UNTAGGED_BYTES = Buffer.from(UNTAGGED, "utf8");

/**
 * `compare()` in tagcache.c:2507: `<Untagged>` sorts before everything, and
 * the rest by `strncasecmp` — which folds ASCII only, and compares bytes
 * unsigned (ARM `char` is unsigned). UTF-8 therefore sorts after ASCII, by
 * code point, exactly as `Buffer.compare` would after the fold.
 */
export function compareTagStrings(a: Buffer, b: Buffer): number {
  const aU = a.equals(UNTAGGED_BYTES);
  const bU = b.equals(UNTAGGED_BYTES);
  if (aU || bU) return aU === bU ? 0 : aU ? -1 : 1;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = asciiLower(a[i]) - asciiLower(b[i]);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/** The case-insensitive identity two unique-tag values are merged on. */
function uniqueKey(value: Buffer): string {
  const folded = Buffer.from(value);
  for (let i = 0; i < folded.length; i++) folded[i] = asciiLower(folded[i]);
  return folded.toString("latin1");
}

/** The string each of a track's ten string tags takes, after Rockbox's fallbacks. */
function stringTagValues(e: TagcacheEntry): Map<number, Buffer> {
  const artist = tagValue(e.artist);
  const albumartist = tagValue(e.albumartist);
  const title = tagValue(e.title);
  const hasArtist = (e.artist ?? "") !== "";
  const hasGrouping = (e.grouping ?? "") !== "";
  return new Map<number, Buffer>([
    [TAG.artist, artist],
    [TAG.album, tagValue(e.album)],
    [TAG.genre, tagValue(e.genre)],
    [TAG.title, title],
    [TAG.composer, tagValue(e.composer)],
    [TAG.comment, tagValue(e.comment)],
    [TAG.albumartist, albumartist],
    // tagcache.c:2380-2395: canonicalartist falls back to the album artist,
    // grouping to the title.
    [TAG.canonicalartist, hasArtist ? artist : albumartist],
    [TAG.grouping, hasGrouping ? tagValue(e.grouping) : title],
  ]);
}

class Writer {
  private chunks: Buffer[] = [];
  length = 0;

  int32(v: number): void {
    const b = Buffer.alloc(4);
    b.writeInt32LE(v | 0, 0);
    this.push(b);
  }

  push(b: Buffer): void {
    this.chunks.push(b);
    this.length += b.length;
  }

  done(): Buffer {
    return Buffer.concat(this.chunks, this.length);
  }
}

/**
 * One `struct tagfile_entry` plus its data. A sorted file's entry is padded
 * with 'X' so that header + data is a whole number of chunks
 * (`tempbuf_sort`, tagcache.c:2583-2606); the filename file is not.
 */
function writeTagEntry(w: Writer, data: Buffer, idxId: number, padded: boolean): void {
  const length = data.length + 1;
  let tagLength = length;
  if (padded && (tagLength + TAGFILE_ENTRY_HEADER) % CHUNK !== 0) {
    tagLength += CHUNK - ((tagLength + TAGFILE_ENTRY_HEADER) % CHUNK);
  }
  w.int32(tagLength);
  w.int32(idxId);
  w.push(data);
  w.push(Buffer.from([0]));
  if (tagLength > length) w.push(Buffer.alloc(tagLength - length, "X"));
}

/** A finished tag file, with the header written last as Rockbox does (tagcache.c:3346). */
function finishTagFile(body: Writer, entryCount: number): Buffer {
  const head = new Writer();
  head.int32(TAGCACHE_MAGIC);
  head.int32(body.length);
  head.int32(entryCount);
  return Buffer.concat([head.done(), body.done()]);
}

export interface EncodeOptions {
  /** `master_header.serial`; must exceed every entry's `lastplayed`. */
  serial?: number;
  /** `master_header.commitid`; Rockbox's own first build leaves 1. */
  commitId?: number;
}

export interface EncodedTagcache {
  /** File name under `.rockbox/` -> bytes. The index is `database_idx.tcd`. */
  files: Map<string, Buffer>;
  entryCount: number;
  serial: number;
  commitId: number;
}

/**
 * Encode a complete database for `entries`, in their given order (which
 * becomes the index order).
 *
 * Throws on a filename Rockbox would refuse, rather than writing a database
 * that names a file the device could never have indexed.
 */
export function encodeTagcache(
  entries: TagcacheEntry[],
  options: EncodeOptions = {}
): EncodedTagcache {
  const n = entries.length;
  const seeks: number[][] = entries.map(() => new Array<number>(TAG_COUNT).fill(0));
  const values = entries.map(stringTagValues);
  const files = new Map<string, Buffer>();
  let tagDataSize = 0;

  for (const tag of STRING_TAGS) {
    const body = new Writer();
    let count = 0;

    if (tag === TAG.filename) {
      // Index order, unpadded, idx_id = index (tagcache.c:3307-3311).
      for (let i = 0; i < n; i++) {
        const name = Buffer.from(entries[i].filename.normalize("NFC"), "utf8");
        if (name.length > MAX_PATH) {
          throw new TcdFormatError(
            `path too long for Rockbox (${name.length} bytes): ${entries[i].filename}`
          );
        }
        seeks[i][tag] = TAG_HEADER_SIZE + body.length;
        writeTagEntry(body, name, i, false);
        count++;
      }
    } else if (UNIQUE_TAGS.has(tag)) {
      // One entry per distinct value, first spelling wins, idx_id -1.
      const groups = new Map<string, { value: Buffer; members: number[] }>();
      for (let i = 0; i < n; i++) {
        const value = values[i].get(tag)!;
        const key = uniqueKey(value);
        const group = groups.get(key);
        if (group) group.members.push(i);
        else groups.set(key, { value, members: [i] });
      }
      const sorted = [...groups.values()].sort((a, b) =>
        compareTagStrings(a.value, b.value)
      );
      for (const group of sorted) {
        const at = TAG_HEADER_SIZE + body.length;
        for (const i of group.members) seeks[i][tag] = at;
        writeTagEntry(body, group.value, -1, true);
        count++;
      }
    } else {
      // Title: sorted, but one entry per track pointing back at it.
      const order = [...Array(n).keys()].sort(
        (a, b) => compareTagStrings(values[a].get(tag)!, values[b].get(tag)!) || a - b
      );
      for (const i of order) {
        seeks[i][tag] = TAG_HEADER_SIZE + body.length;
        writeTagEntry(body, values[i].get(tag)!, i, true);
        count++;
      }
    }

    // The master header counts every tag file's data except the filename's
    // (tagcache.c:3353), and the device sizes its RAM cache from that sum.
    if (tag !== TAG.filename) tagDataSize += body.length;
    files.set(tagFileName(tag), finishTagFile(body, count));
  }

  let maxLastPlayed = 0;
  let maxCommitId = 0;
  for (const e of entries) {
    if (!e.runtime) continue;
    maxLastPlayed = Math.max(maxLastPlayed, e.runtime.lastplayed);
    maxCommitId = Math.max(maxCommitId, e.runtime.commitid);
  }
  // `lastplayed` is stamped with the pre-increment serial, so the serial must
  // stay above all of them or the next play would tie with an old one.
  // A database that has never recorded a play keeps serial 0, as Rockbox's
  // own first build does.
  const serial = Math.max(options.serial ?? 0, maxLastPlayed > 0 ? maxLastPlayed + 1 : 0);
  const commitId = Math.max(options.commitId ?? 1, maxCommitId + 1, 1);

  const idx = new Writer();
  idx.int32(TAGCACHE_MAGIC);
  idx.int32(MASTER_HEADER_SIZE + INDEX_ENTRY_SIZE * n + tagDataSize);
  idx.int32(n);
  idx.int32(serial);
  idx.int32(commitId);
  idx.int32(0); // dirty

  for (let i = 0; i < n; i++) {
    const e = entries[i];
    const s = seeks[i];
    const rt = e.runtime ?? NO_RUNTIME;
    s[TAG.year] = e.year ?? 0;
    s[TAG.discnumber] = e.discnumber ?? 0;
    s[TAG.tracknumber] = e.tracknumber != null && e.tracknumber > 0 ? e.tracknumber : -1;
    s[TAG.bitrate] = e.bitrate ?? 0;
    s[TAG.length] = e.length ?? 0;
    s[TAG.playcount] = rt.playcount;
    s[TAG.rating] = rt.rating;
    s[TAG.playtime] = rt.playtime;
    s[TAG.lastplayed] = rt.lastplayed;
    s[TAG.commitid] = rt.commitid;
    s[TAG.mtime] = e.mtime ?? 0;
    s[TAG.lastelapsed] = rt.lastelapsed;
    s[TAG.lastoffset] = rt.lastoffset;
    for (let t = 0; t < TAG_COUNT; t++) idx.int32(s[t]);
    // DIRTYNUM marks numeric data worth exporting to the changelog and keeping
    // across the device's own rebuilds — exactly what carried statistics are.
    idx.int32(hasRuntime(rt) ? FLAG.DIRTYNUM : 0);
  }

  files.set(INDEX_FILE_NAME, idx.done());
  return { files, entryCount: n, serial, commitId };
}

function hasRuntime(rt: TagcacheRuntime): boolean {
  return (
    rt.playcount > 0 ||
    rt.rating > 0 ||
    rt.playtime > 0 ||
    rt.lastplayed > 0 ||
    rt.lastelapsed > 0 ||
    rt.lastoffset > 0
  );
}

// ---------------------------------------------------------------------------
// Full decode
// ---------------------------------------------------------------------------

/** One decoded track, with every string tag resolved. */
export interface DecodedTagcacheEntry extends TagcacheEntry {
  idxId: number;
  flag: number;
  runtime: TagcacheRuntime;
}

export interface DecodedTagcache {
  header: MasterHeader;
  entries: DecodedTagcacheEntry[];
}

function readInt32(buf: Buffer, offset: number, swapped: boolean): number {
  return swapped ? buf.readInt32BE(offset) : buf.readInt32LE(offset);
}

/**
 * A tag file as `offset -> string`. Unique tags point at an entry by offset
 * only — their idx_id is -1 — so this is the only way to resolve them.
 */
export function decodeTagFileByOffset(buf: Buffer, swapped: boolean): Map<number, string> {
  const out = new Map<number, string>();
  if (buf.length < TAG_HEADER_SIZE) {
    throw new TcdFormatError(`tag file truncated: ${buf.length} bytes`);
  }
  const count = readInt32(buf, 8, swapped);
  let pos = TAG_HEADER_SIZE;
  for (let i = 0; i < count; i++) {
    if (pos + TAGFILE_ENTRY_HEADER > buf.length) {
      throw new TcdFormatError(`tag entry ${i} header runs past end of file`);
    }
    const len = readInt32(buf, pos, swapped);
    const start = pos + TAGFILE_ENTRY_HEADER;
    const end = start + len;
    if (len < 0 || end > buf.length) {
      throw new TcdFormatError(`tag entry ${i} data runs past end of file`);
    }
    let nul = buf.indexOf(0, start);
    if (nul < 0 || nul > end) nul = end;
    out.set(pos, buf.toString("utf8", start, nul));
    pos = end;
  }
  return out;
}

/**
 * Decode a whole database: the index plus every string tag file. Deleted
 * entries are skipped. `tagFiles` is keyed by tag number; a missing file
 * leaves its tag undefined rather than failing, so a partly damaged database
 * still yields what it can (its statistics, chiefly).
 */
export function decodeTagcache(
  idx: Buffer,
  tagFiles: Map<number, Buffer>
): DecodedTagcache {
  const header = decodeMasterHeader(idx, idx.length);
  const strings = new Map<number, Map<number, string>>();
  for (const [tag, buf] of tagFiles) {
    strings.set(tag, decodeTagFileByOffset(buf, header.swapped));
  }
  const str = (tag: number, seek: number): string | undefined =>
    strings.get(tag)?.get(seek);

  const entries: DecodedTagcacheEntry[] = [];
  for (const e of decodeIndex(idx, header)) {
    const s = e.tagSeek;
    const filename = str(TAG.filename, s[TAG.filename]);
    if (filename === undefined) continue;
    entries.push({
      idxId: e.idxId,
      flag: e.flag,
      filename,
      artist: str(TAG.artist, s[TAG.artist]),
      album: str(TAG.album, s[TAG.album]),
      genre: str(TAG.genre, s[TAG.genre]),
      title: str(TAG.title, s[TAG.title]),
      composer: str(TAG.composer, s[TAG.composer]),
      comment: str(TAG.comment, s[TAG.comment]),
      albumartist: str(TAG.albumartist, s[TAG.albumartist]),
      grouping: str(TAG.grouping, s[TAG.grouping]),
      year: s[TAG.year],
      discnumber: s[TAG.discnumber],
      tracknumber: s[TAG.tracknumber],
      bitrate: s[TAG.bitrate],
      length: s[TAG.length],
      mtime: s[TAG.mtime],
      runtime: {
        playcount: s[TAG.playcount],
        rating: s[TAG.rating],
        playtime: s[TAG.playtime],
        lastplayed: s[TAG.lastplayed],
        commitid: s[TAG.commitid],
        lastelapsed: s[TAG.lastelapsed],
        lastoffset: s[TAG.lastoffset],
      },
    });
  }
  return { header, entries };
}

/** A decoded `<Untagged>` back to "no value", so carried entries re-encode the same. */
export function untag(value: string | null | undefined): string | null {
  return value == null || value === UNTAGGED ? null : value;
}
