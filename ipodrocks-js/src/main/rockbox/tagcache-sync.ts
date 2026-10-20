/**
 * Write Rockbox's database onto a device at the end of a sync.
 *
 * Without this, every sync leaves the player knowing nothing about the files
 * it just received: the user has to run "Database → Update now" (minutes on a
 * full iPod) before any of it is browsable, and a rating for a track copied
 * this sync has no record to go into (issue #138). The encoder is
 * `tagcache-build.ts`; this module decides *what* goes in it and puts the
 * bytes on the device through its `DeviceFs`.
 *
 * Opt-in per device — `DeviceSyncPreferences.buildRockboxDatabase`.
 *
 * The rules this depends on:
 *
 *  - **It runs after Phase 3**, so the ratings Phase 3 just wrote into the old
 *    index are what get carried over. Running it first would also invalidate
 *    the index ids Phase 3 was handed.
 *  - **Every runtime statistic is carried by filename** from the old database,
 *    the same key Rockbox's own changelog import uses. A rebuild that dropped
 *    them would read as "the device was wiped" to `detectRebuiltDatabase()` on
 *    the next sync.
 *  - **The file list is the device's, not the library's.** Rockbox's scan
 *    indexes every audio file under its scan root, so a database holding only
 *    what iPodRocks copied would hide the user's own files until they ran an
 *    update anyway. A file the library does not know falls back to the old
 *    database's entry, then to reading its tags locally; a browser-held device
 *    cannot be read file by file, so those are left out (and counted).
 *  - **Filenames keep the volume prefix the device already uses**
 *    (`/<HDD0>/Music/…` on a multi-volume build). It is part of the key every
 *    lookup — playback, auto-update, the changelog — matches on.
 *  - **Only magic 0x10 (Rockbox 4.0+) is written.** Any other version makes the
 *    player reject the database, so an older firmware is left alone.
 */

import * as nodeFs from "fs";
import * as path from "path";

import type { ClientPlatform } from "../../shared/device-rpc";
import type { DeviceFs } from "../devices/fs/device-fs";
import { NodeDeviceFs } from "../devices/fs/node-device-fs";
import { RemoteDeviceFs } from "../devices/fs/remote-device-fs";
import { MetadataExtractor } from "../library/metadata-extractor";
import { codecAgnosticKey, normalizeDevicePath } from "./device-path-match";
import {
  INDEX_FILE_NAME,
  MAX_PATH,
  NO_RUNTIME,
  STRING_TAGS,
  decodeTagcache,
  encodeTagcache,
  tagFileName,
  untag,
  type DecodedTagcacheEntry,
  type TagcacheEntry,
} from "./tagcache-build";
import { TAGCACHE_MAGIC, decodeMasterHeader } from "./tcd-format";

/**
 * Every extension Rockbox's `probe_file_format()` recognises
 * (`lib/rbcodec/metadata/metadata.c`, the `audio_formats` table). Its scan
 * indexes exactly these, so the database must hold exactly these too: one it
 * would never index is a stale row, and one it would is a file the next
 * auto-update adds back.
 */
export const ROCKBOX_AUDIO_EXTENSIONS = new Set(
  (
    "mpa mp2 mp3 mp1 aiff aif wav at3 ogg oga flac mpc a52 ac3 wv m4a m4b mp4 " +
    "shn sid adx nsf nsfe spx spc ape mac wma wmv asf mod sap rm ra rmvb cmc " +
    "cm3 cmr cms dmc dlt mpt mpd rmt tmc tm8 tm2 oma aa3 mmf au snd vox w64 " +
    "tta ay vtx gbs hes sgc vgm vgz kss opus aac dsf dff iso"
  )
    .split(" ")
    .map((e) => `.${e}`)
);

/** Leftovers of an interrupted Rockbox scan, which would be committed over ours at boot. */
const STALE_SCAN_FILES = ["database_tmp.tcd", "database_state.tcd"];

const BACKUP_SUFFIX = ".ipodrocks-bak";
const TEMP_SUFFIX = ".ipodrocks-new";

/** What the library knows about one file the sync put on the device. */
export interface LibraryTagSource {
  trackId: number;
  title?: string | null;
  artist?: string | null;
  albumArtist?: string | null;
  album?: string | null;
  genre?: string | null;
  composer?: string | null;
  comment?: string | null;
  grouping?: string | null;
  year?: number | null;
  trackNumber?: number | null;
  discNumber?: number | null;
  /** Seconds, as `tracks.duration` stores it. */
  duration?: number | null;
  /** Canonical rating, 0-10 or null. */
  rating?: number | null;
}

/**
 * Library tracks by the device path the sync gives them, normalised with
 * {@link normalizeDevicePath}. Built by {@link buildLibraryDeviceIndex}.
 */
export interface LibraryDeviceIndex {
  exact: Map<string, LibraryTagSource | null>;
  /** Extension-less, for a device whose codec changed since the last copy. */
  stem: Map<string, LibraryTagSource | null>;
}

/** The library's placeholder strings are its own; Rockbox spells them `<Untagged>`. */
const PLACEHOLDERS = new Set(["Unknown Artist", "Unknown Album", "Unknown Genre"]);

function libString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t && !PLACEHOLDERS.has(t) ? t : null;
}

function libNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** A track record from `buildLibraryTrackMaps()` as tags. */
export function libraryTagSourceFrom(t: Record<string, unknown>): LibraryTagSource | null {
  const id = t.id;
  if (typeof id !== "number") return null;
  return {
    trackId: id,
    title: libString(t.title),
    artist: libString(t.artist),
    albumArtist: libString(t.albumArtist),
    album: libString(t.album),
    genre: libString(t.genre),
    composer: libString(t.composer),
    comment: libString(t.comment),
    grouping: libString(t.grouping),
    year: libNumber(t.year),
    trackNumber: libNumber(t.trackNumber),
    discNumber: libNumber(t.discNumber),
    duration: libNumber(t.duration),
    rating: libNumber(t.rating),
  };
}

/**
 * Index library tracks by where the sync puts them.
 *
 * `placements` gives, per content type, the mount-relative content folder and
 * the `trackPath -> folder-relative device path` map `buildLibraryDestMap()`
 * produced — the sync's own answer, so the two cannot disagree about a name.
 * Two tracks claiming one path mark it ambiguous (null) rather than picking
 * one, the same rule as `buildDevicePathResolver`.
 */
export function buildLibraryDeviceIndex(
  placements: Array<{
    contentFolderRel: string;
    destMap: Record<string, string>;
    tracks: Record<string, Record<string, unknown>>;
  }>
): LibraryDeviceIndex {
  const exact = new Map<string, LibraryTagSource | null>();
  const stem = new Map<string, LibraryTagSource | null>();
  const put = (
    map: Map<string, LibraryTagSource | null>,
    key: string,
    src: LibraryTagSource
  ): void => {
    const prev = map.get(key);
    if (prev === undefined) map.set(key, src);
    else if (prev !== null && prev.trackId !== src.trackId) map.set(key, null);
  };

  for (const { contentFolderRel, destMap, tracks } of placements) {
    for (const [trackPath, rel] of Object.entries(destMap)) {
      const info = tracks[trackPath];
      const src = info ? libraryTagSourceFrom(info) : null;
      if (!src) continue;
      const key = normalizeDevicePath(path.posix.join(contentFolderRel, rel));
      put(exact, key, src);
      put(stem, codecAgnosticKey(key), src);
    }
  }
  return { exact, stem };
}

/**
 * How the machine writing a device's files stores FAT timestamps, which have
 * no time zone of their own. Rockbox's `dostime_mktime()` reads the stored
 * fields as if they were UTC, so this decides the `mtime` it records:
 *
 *  - `utc`: the fields hold UTC. Linux with the hardware clock on UTC (the
 *    systemd default: the kernel's `sys_tz` is 0), or a `tz=UTC` mount.
 *  - `fixed`: a constant offset. Linux's `time_offset=` mount option, or the
 *    hardware clock on local time (`sys_tz` is set once, at boot, and does not
 *    follow DST).
 *  - `local`: the zone in force at the file's own time. Windows and macOS.
 */
export type FatClock =
  | { kind: "utc" }
  | { kind: "fixed"; offsetSec: number }
  | { kind: "local" };

/**
 * The `FatClock` of a locally mounted device. Getting this wrong is not
 * cosmetic: Rockbox's auto-update deletes and re-adds every entry whose mtime
 * disagrees with the file, which re-indexes the whole player and drops its
 * play counts, and a restart during that long commit leaves the database
 * dirty — the "Database is not ready, initialize now?" prompt.
 */
export function detectFatClock(
  mountPath: string,
  platform: NodeJS.Platform = process.platform,
  read: (file: string) => string | null = readTextOrNull
): FatClock {
  if (platform !== "linux") return { kind: "local" };
  const mounts = read("/proc/mounts");
  if (mounts) {
    // POSIX on purpose: /proc/mounts is a Linux file, and `path.resolve` on a
    // win32 host would turn "/run/media/x" into "C:\run\media\x".
    const want = path.posix.resolve(mountPath);
    let best: { point: string; opts: string } | null = null;
    for (const line of mounts.split("\n")) {
      const [, rawPoint, type, opts] = line.split(" ");
      if (!rawPoint || !opts || !/^(vfat|msdos|exfat)$/.test(type ?? "")) continue;
      const point = rawPoint.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
      const inside = want === point || want.startsWith(point.endsWith("/") ? point : `${point}/`);
      if (inside && (!best || point.length > best.point.length)) best = { point, opts };
    }
    if (best) {
      const opts = best.opts.split(",");
      if (opts.includes("tz=UTC")) return { kind: "utc" };
      const off = opts.find((o) => o.startsWith("time_offset="));
      if (off) {
        const minutes = Number(off.slice("time_offset=".length));
        if (Number.isFinite(minutes)) return { kind: "fixed", offsetSec: minutes * 60 };
      }
    }
  }
  // Without a mount option the kernel uses sys_tz, which is non-zero only
  // when the hardware clock keeps local time (third line of /etc/adjtime).
  const adjtime = read("/etc/adjtime");
  if (adjtime && adjtime.split("\n")[2]?.trim() === "LOCAL") {
    return { kind: "fixed", offsetSec: -new Date().getTimezoneOffset() * 60 };
  }
  return { kind: "utc" };
}

/**
 * The `FatClock` of a browser-held device, from the OS the browser reported.
 * The server can see neither that machine's mount options nor its hardware
 * clock, so this takes each OS's default: Linux's vfat writes UTC (systemd
 * keeps `sys_tz` at 0), Windows and macOS local time. An OS the browser did
 * not name gets local time, which is what every remote build used to assume —
 * and what put every mtime a time-zone offset out on a Linux browser.
 */
export function browserFatClock(platform: ClientPlatform | undefined): FatClock {
  return platform === "linux" ? { kind: "utc" } : { kind: "local" };
}

function readTextOrNull(file: string): string | null {
  try {
    return nodeFs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * The `mtime` Rockbox would record for a file: the FAT timestamp fields read
 * as if they were UTC, at FAT's 2-second resolution. Only consulted by the
 * player's auto-update, which re-adds an entry whose mtime disagrees.
 */
export function rockboxMtime(mtimeMs: number | undefined, clock: FatClock = { kind: "local" }): number {
  if (mtimeMs == null || !Number.isFinite(mtimeMs) || mtimeMs <= 0) return 0;
  const offsetSec =
    clock.kind === "utc"
      ? 0
      : clock.kind === "fixed"
        ? clock.offsetSec
        : -new Date(mtimeMs).getTimezoneOffset() * 60;
  const fields = Math.floor(mtimeMs / 1000) + offsetSec;
  return Math.floor(fields / 2) * 2;
}

/**
 * Which firmware is installed, from `.rockbox/rockbox-info.txt`'s `Version:`
 * line. A release ("4.0", "3.15") or a dev build ("a1b2c3d-240101"); dev
 * builds of the last years are all 4.x-format, and a 3.x release is the only
 * thing this needs to tell apart.
 */
export function firmwareWritesV10(info: string): boolean | null {
  const m = /^Version:\s*(\S+)/m.exec(info);
  if (!m) return null;
  const v = m[1];
  const release = /^v?(\d+)\.(\d+)/.exec(v);
  if (release) return Number(release[1]) >= 4;
  // A dev build names a commit, not a release; the 0x10 format dates from 2021.
  return true;
}

export type TagcacheBuildResult =
  | {
      state: "built";
      entries: number;
      /** Files whose statistics came across from the old database. */
      carried: number;
      /** Files matched to a library track. */
      fromLibrary: number;
      /** Files the library did not know, read off the device directly. */
      parsed: number;
      /** Files left out: unknown to the library and unreadable from here. */
      omitted: number;
      /** Library ratings written for tracks the old database did not have. */
      seededTrackIds: number[];
    }
  | { state: "skipped"; reason: "not-rockbox" | "unsupported-version" | "empty"; message: string };

export interface TagcacheBuildDevice {
  fs: DeviceFs;
  mountPath: string;
}

export interface TagcacheBuildOptions {
  library: LibraryDeviceIndex;
  /** How the device's FAT timestamps are stored; detected when omitted. */
  fatClock?: FatClock;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

class BuildCancelled extends Error {}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new BuildCancelled("cancelled");
}

/** Read the old database, if there is one worth carrying from. */
async function readOldDatabase(
  fs: DeviceFs,
  rbDir: string,
  log: (m: string) => void
): Promise<{ entries: DecodedTagcacheEntry[]; serial: number; commitId: number; version: number } | "missing" | "unreadable"> {
  const idxPath = path.join(rbDir, INDEX_FILE_NAME);
  if (!(await fs.exists(idxPath))) return "missing";
  try {
    const idx = await fs.readFile(idxPath);
    const header = decodeMasterHeader(idx, idx.length);
    if (header.version !== (TAGCACHE_MAGIC & 0xff)) {
      return { entries: [], serial: 0, commitId: 0, version: header.version };
    }
    const tagFiles = new Map<number, Buffer>();
    for (const tag of STRING_TAGS) {
      const p = path.join(rbDir, tagFileName(tag));
      try {
        if (await fs.exists(p)) tagFiles.set(tag, await fs.readFile(p));
      } catch {
        /* a missing or unreadable tag file only loses that tag */
      }
    }
    const decoded = decodeTagcache(idx, tagFiles);
    return {
      entries: decoded.entries,
      serial: decoded.header.serial,
      commitId: decoded.header.commitId,
      version: header.version,
    };
  } catch (err) {
    log(`Rockbox database: the existing one could not be read (${(err as Error).message}); statistics cannot be carried over.`);
    return "unreadable";
  }
}

/** `/<HDD0>/` on a multi-volume build, `/` otherwise — whatever the device already uses. */
function filenamePrefix(old: DecodedTagcacheEntry[]): string {
  for (const e of old) {
    const m = /^\/<[^>/]+>\//.exec(e.filename);
    if (m) return m[0];
    if (e.filename.startsWith("/")) return "/";
  }
  return "/";
}

/**
 * The files Rockbox's scan would index, mount-relative and POSIX. Honours
 * `database.ignore` / `database.unignore` the way `check_dir()` does: the
 * nearest folder holding exactly one of the two decides. Dot-folders are
 * skipped — `.rockbox` itself, `.Trashes`, a "Delete all" sync's
 * `.ipodrocks-trash-*` still being removed — and so are AppleDouble `._`
 * files, which Rockbox fails to read and leaves out anyway.
 */
async function listIndexableFiles(
  fs: DeviceFs,
  mountPath: string,
  signal: AbortSignal | undefined
): Promise<Array<{ rel: string; abs: string; size: number; mtimeMs?: number }>> {
  const tree = await fs.listTree(mountPath, { signal, includeDirectories: false });
  const rel = (abs: string): string =>
    path.relative(mountPath, abs).split(path.sep).join("/");

  const markers = new Map<string, { ignore: boolean; unignore: boolean }>();
  for (const e of tree) {
    const lower = e.name.toLowerCase();
    if (lower !== "database.ignore" && lower !== "database.unignore") continue;
    const dir = path.posix.dirname(rel(e.path));
    const m = markers.get(dir) ?? { ignore: false, unignore: false };
    if (lower === "database.ignore") m.ignore = true;
    else m.unignore = true;
    markers.set(dir, m);
  }
  const ignored = (dir: string): boolean => {
    for (let d = dir; ; d = path.posix.dirname(d)) {
      const m = markers.get(d);
      if (m && m.ignore !== m.unignore) return m.ignore;
      if (d === "." || d === "" || d === "/") return false;
    }
  };

  const out: Array<{ rel: string; abs: string; size: number; mtimeMs?: number }> = [];
  for (const e of tree) {
    if (e.isDirectory) continue;
    const r = rel(e.path);
    if (!r || r.startsWith("..")) continue;
    const parts = r.split("/");
    if (parts.slice(0, -1).some((p) => p.startsWith("."))) continue;
    if (e.name.startsWith("._")) continue;
    if (!ROCKBOX_AUDIO_EXTENSIONS.has(path.extname(e.name).toLowerCase())) continue;
    if (ignored(path.posix.dirname(r))) continue;
    out.push({ rel: r, abs: e.path, size: e.size, mtimeMs: e.mtimeMs });
  }
  // A stable index order, so an unchanged device produces the same bytes.
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

/** Average kbps from the file itself: right for a transcode, which the library's own figure is not. */
function averageKbps(size: number, lengthMs: number): number {
  return lengthMs > 0 && size > 0 ? Math.round((size * 8) / lengthMs) : 0;
}

function fromLibrary(src: LibraryTagSource): Omit<TagcacheEntry, "filename"> {
  return {
    title: src.title,
    artist: src.artist,
    albumartist: src.albumArtist,
    album: src.album,
    genre: src.genre,
    composer: src.composer,
    comment: src.comment,
    grouping: src.grouping,
    year: src.year,
    tracknumber: src.trackNumber,
    discnumber: src.discNumber,
    length: src.duration != null ? Math.round(src.duration * 1000) : 0,
  };
}

function fromOld(old: DecodedTagcacheEntry): Omit<TagcacheEntry, "filename"> {
  return {
    title: untag(old.title),
    artist: untag(old.artist),
    albumartist: untag(old.albumartist),
    album: untag(old.album),
    genre: untag(old.genre),
    composer: untag(old.composer),
    comment: untag(old.comment),
    grouping: untag(old.grouping),
    year: old.year,
    tracknumber: old.tracknumber,
    discnumber: old.discnumber,
    length: old.length,
    bitrate: old.bitrate,
  };
}

let extractor: MetadataExtractor | null = null;

/** Tags for a file nothing else knows, read off a local mount. */
async function fromFile(abs: string): Promise<Omit<TagcacheEntry, "filename"> | null> {
  extractor ??= new MetadataExtractor();
  try {
    const [meta, info] = await Promise.all([
      extractor.extractMetadata(abs, "music"),
      extractor.extractAudioInfo(abs),
    ]);
    const stem = path.basename(abs, path.extname(abs));
    const num = (s: string): number | null => {
      const n = parseInt(s, 10);
      return Number.isFinite(n) ? n : null;
    };
    return {
      // The extractor substitutes the file stem for a missing title; Rockbox
      // does not, and this should read the way the device's own scan would.
      title: meta.title === stem ? null : libString(meta.title),
      artist: libString(meta.artist),
      albumartist: meta.albumArtist === meta.artist ? null : libString(meta.albumArtist),
      album: libString(meta.album),
      genre: libString(meta.genre),
      composer: meta.tagFields?.composer ?? null,
      comment: meta.tagFields?.comment ?? null,
      grouping: meta.tagFields?.grouping ?? null,
      year: meta.tagFields?.year ?? null,
      tracknumber: num(meta.trackNumber),
      discnumber: num(meta.discNumber),
      length: Math.round((info.duration || 0) * 1000),
    };
  } catch {
    return null;
  }
}

/**
 * Put the encoded files in place.
 *
 * Locally each is written beside its target and renamed over it — the tag
 * files first and the index last, because the index is what Rockbox opens
 * first and checks for validity, so a crash part-way leaves either the old
 * index (still pointing at its own data, now partly replaced) or the new one.
 * A browser-held device writes in place: `createWritable()` already stages
 * through a `.crswap` sibling, and its `rename` is a full read + write +
 * delete, which would double every byte over the link.
 */
async function writeDatabase(
  fs: DeviceFs,
  rbDir: string,
  files: Map<string, Buffer>,
  signal: AbortSignal | undefined
): Promise<void> {
  const idxPath = path.join(rbDir, INDEX_FILE_NAME);
  if (await fs.exists(idxPath)) {
    await fs.writeFile(idxPath + BACKUP_SUFFIX, await fs.readFile(idxPath));
  }

  const order = [...files.keys()].sort((a, b) =>
    a === INDEX_FILE_NAME ? 1 : b === INDEX_FILE_NAME ? -1 : 0
  );
  const inPlace = fs.capabilities.overNetwork === true;

  if (inPlace) {
    for (const name of order) {
      checkAbort(signal);
      await fs.writeFile(path.join(rbDir, name), files.get(name)!);
    }
  } else {
    for (const name of order) {
      checkAbort(signal);
      await fs.writeFile(path.join(rbDir, name + TEMP_SUFFIX), files.get(name)!);
    }
    // No abort check from here on: half the files renamed is the one state
    // that is worse than either the old database or the new one.
    for (const name of order) {
      await fs.rename(path.join(rbDir, name + TEMP_SUFFIX), path.join(rbDir, name));
    }
  }

  for (const name of STALE_SCAN_FILES) {
    const p = path.join(rbDir, name);
    try {
      if (await fs.exists(p)) await fs.unlink(p);
    } catch {
      /* best effort: a stale scan only costs the user a commit prompt */
    }
  }
}

/**
 * Build and write the database. Never throws for a device it cannot or should
 * not build for — that is a `skipped` result — but does throw on I/O failure,
 * which the sync reports without failing the copy that already succeeded.
 */
export async function buildDeviceTagcache(
  device: TagcacheBuildDevice,
  options: TagcacheBuildOptions
): Promise<TagcacheBuildResult> {
  const { fs, mountPath } = device;
  const log = options.log ?? (() => {});
  const signal = options.signal;
  const rbDir = path.join(mountPath, ".rockbox");

  const rbStat = await fs.stat(rbDir);
  if (!rbStat?.isDirectory) {
    return {
      state: "skipped",
      reason: "not-rockbox",
      message: "Rockbox database not built: no .rockbox folder on this device.",
    };
  }

  const old = await readOldDatabase(fs, rbDir, log);
  if (typeof old === "object" && old.version !== (TAGCACHE_MAGIC & 0xff)) {
    return {
      state: "skipped",
      reason: "unsupported-version",
      message:
        `Rockbox database not built: the device's database is format 0x${old.version.toString(16)}, ` +
        "written by a Rockbox older than 4.0. Update Rockbox on the player to use this option.",
    };
  }
  if (old === "missing") {
    let info: string | null = null;
    try {
      const infoPath = path.join(rbDir, "rockbox-info.txt");
      if (await fs.exists(infoPath)) info = (await fs.readFile(infoPath)).toString("utf8");
    } catch {
      /* treated as unknown below */
    }
    if (info === null || firmwareWritesV10(info) !== true) {
      return {
        state: "skipped",
        reason: "unsupported-version",
        message:
          "Rockbox database not built: could not confirm this device runs Rockbox 4.0 or later. " +
          "On the player, run Database → Initialize now once, then sync again.",
      };
    }
  }

  const oldEntries = typeof old === "object" ? old.entries : [];
  const oldByKey = new Map<string, DecodedTagcacheEntry>();
  for (const e of oldEntries) oldByKey.set(normalizeDevicePath(e.filename), e);
  const prefix = filenamePrefix(oldEntries);

  checkAbort(signal);
  const files = await listIndexableFiles(fs, mountPath, signal);
  const parseLocally = fs instanceof NodeDeviceFs;
  // A browser-held device is written by the browser's OS, which the server
  // knows only by what the browser reported when it attached.
  const fatClock =
    options.fatClock ??
    (parseLocally
      ? detectFatClock(mountPath)
      : browserFatClock(fs instanceof RemoteDeviceFs ? fs.clientPlatform : undefined));

  const entries: TagcacheEntry[] = [];
  const seededTrackIds: number[] = [];
  let carried = 0;
  let fromLib = 0;
  let parsed = 0;
  let omitted = 0;

  for (const file of files) {
    checkAbort(signal);
    const filename = prefix + file.rel;
    // add_tagcache() refuses these outright, so the device could never have them.
    if (Buffer.byteLength(filename.normalize("NFC"), "utf8") > MAX_PATH) {
      omitted++;
      continue;
    }

    const key = normalizeDevicePath(file.rel);
    const lib =
      options.library.exact.get(key) ?? options.library.stem.get(codecAgnosticKey(key)) ?? null;
    const prev = oldByKey.get(key);

    let tags: Omit<TagcacheEntry, "filename"> | null;
    if (lib) {
      tags = fromLibrary(lib);
      fromLib++;
    } else if (prev) {
      tags = fromOld(prev);
    } else if (parseLocally) {
      tags = await fromFile(file.abs);
      if (tags) parsed++;
    } else {
      tags = null;
    }
    if (!tags) {
      omitted++;
      continue;
    }

    let runtime = prev?.runtime ?? null;
    if (prev) {
      carried++;
    } else if (lib && lib.rating != null && lib.rating > 0) {
      // A track new to the device can be given its rating now, which is the
      // one thing Phase 3 could not do for it.
      runtime = { ...NO_RUNTIME, rating: Math.min(10, Math.round(lib.rating)) };
      seededTrackIds.push(lib.trackId);
    }

    const length = tags.length ?? 0;
    entries.push({
      ...tags,
      filename,
      bitrate: averageKbps(file.size, length) || tags.bitrate || 0,
      mtime: rockboxMtime(file.mtimeMs, fatClock),
      runtime,
    });
  }

  if (entries.length === 0) {
    return {
      state: "skipped",
      reason: "empty",
      message: "Rockbox database not built: no audio files found on the device.",
    };
  }

  const encoded = encodeTagcache(entries, {
    serial: typeof old === "object" ? old.serial : 0,
    commitId: typeof old === "object" ? old.commitId + 1 : 1,
  });
  checkAbort(signal);
  await writeDatabase(fs, rbDir, encoded.files, signal);

  return {
    state: "built",
    entries: entries.length,
    carried,
    fromLibrary: fromLib,
    parsed,
    omitted,
    seededTrackIds,
  };
}

/** True when the build was stopped by the sync's abort signal. */
export function isBuildCancelled(err: unknown): boolean {
  return err instanceof BuildCancelled;
}
