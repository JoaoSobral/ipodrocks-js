/**
 * The device filesystem, behind one interface.
 *
 * Every byte iPodRocks puts on a player, and every listing it reads back, goes
 * through a `DeviceFs`. On the desktop the implementation is
 * {@link NodeDeviceFs}, which is `fs` and nothing more. In web-server mode the
 * device is a folder the user picked in their own browser, and the
 * implementation tunnels each call out to that tab.
 *
 * **Paths are absolute and in the host's own flavour.** They are built exactly
 * as they always were — `path.join(device.mountPath, …)` — and a remote
 * implementation converts to device-relative POSIX at the RPC boundary, where
 * `toMountRelative` already does that job and is already tested. Forcing POSIX
 * on this side instead would mean threading a path flavour through the six
 * containment guards that do host `path` arithmetic on device paths
 * (`containUnderFolder`, `resolveResettableFolders`, `toMountRelative`,
 * `computeShadowAlbumRelPath`, `findOrphanedAlbumArt` and `sanitizeMountPath`),
 * and missing one of them collapses every destination to `folder/basename` —
 * the whole library flattens into `Music/` and the next sync sees every track
 * as missing.
 *
 * The library side of a sync is **not** a `DeviceFs`. Source files, the scan
 * cache and every temp file an encoder writes stay on plain `fs`: they are on
 * the machine running the sync whatever the device is.
 */
import * as path from "path";

import type { DiskSpace } from "../../../shared/types";

/**
 * What this device can and cannot do, so a caller degrades rather than fails.
 *
 * None of these are optional extras on a local mount; they are all things the
 * File System Access API simply has no equivalent for.
 */
export interface DeviceFsCapabilities {
  /**
   * Can a copied file be given the source's mtime?
   *
   * When false, `name-size-sync.ts` falls back to its size-first comparison,
   * which is why it must try size *before* mtime whenever a size is known.
   */
  setMtime: boolean;
  /** Can total/free bytes be read? A UI figure only. */
  freeSpace: boolean;
  /** Can the volume be ejected from the machine running the sync? */
  eject: boolean;
}

export interface DeviceStat {
  size: number;
  mtimeMs: number;
  isDirectory: boolean;
}

/** One name in a directory. Deliberately carries no stat — see `listTree`. */
export interface DeviceDirent {
  name: string;
  isDirectory: boolean;
}

/** One entry from a recursive walk, with the file facts already in hand. */
export interface DeviceTreeEntry {
  /** Absolute, host-flavoured. */
  path: string;
  name: string;
  isDirectory: boolean;
  /** 0 for a directory, and for a file whose stat failed. */
  size: number;
  /**
   * Undefined when the file could not be stat'd — which is not the same as 0,
   * and `compareLibraries` treats the two differently.
   */
  mtimeMs?: number;
}

export interface ListTreeOptions {
  /** Checked before every directory read and every entry. */
  signal?: AbortSignal;
  /**
   * Called as each entry is discovered, so a walk of a full player can report
   * progress instead of going silent for a minute.
   */
  onEntry?: (entry: DeviceTreeEntry) => void;
  /** Directories are always walked; false leaves them out of the result. */
  includeDirectories?: boolean;
}

/** One contiguous write into an existing file. */
export interface DevicePatchRange {
  offset: number;
  bytes: Uint8Array;
}

export interface DeviceFs {
  /** The device's mount root, as every path under it is built from. */
  readonly root: string;
  readonly capabilities: DeviceFsCapabilities;

  exists(p: string): Promise<boolean>;
  stat(p: string): Promise<DeviceStat | null>;
  /** Non-recursive, and deliberately without stats: see {@link listTree}. */
  readdir(p: string): Promise<DeviceDirent[]>;
  /**
   * Walk `dir` and report every entry under it, with sizes and mtimes.
   *
   * One call instead of a readdir-plus-stat-per-file storm, because that shape
   * is a few hundred syscalls on a local mount and a few hundred *round trips*
   * on a remote one. A missing directory is an empty list, never a throw.
   */
  listTree(dir: string, opts?: ListTreeOptions): Promise<DeviceTreeEntry[]>;

  readFile(p: string): Promise<Buffer>;
  readRange(p: string, offset: number, length: number): Promise<Buffer>;
  writeFile(p: string, data: Uint8Array): Promise<void>;
  /** Rewrite the named byte ranges in place, leaving the rest of the file alone. */
  patch(p: string, ranges: DevicePatchRange[]): Promise<void>;
  /**
   * Put a file from the machine running the sync onto the device.
   *
   * Separate from `writeFile` because the payload is a multi-megabyte audio
   * file that must never be read into memory whole: locally this is
   * `fs.copyFile`, and remotely it is a streamed HTTP transfer.
   */
  copyFromLocal(localSrc: string, dest: string): Promise<void>;

  mkdir(p: string, opts?: { recursive?: boolean }): Promise<void>;
  unlink(p: string): Promise<void>;
  rmdir(p: string): Promise<void>;
  rm(p: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;

  /**
   * Only ever called when `capabilities.setMtime` is true. Callers must check
   * rather than rely on a silent no-op, because "the mtime was not set" changes
   * how the next sync compares the file.
   */
  setMtime(p: string, atime: Date, mtime: Date): Promise<void>;

  /** Null when `capabilities.freeSpace` is false, or the figure is unavailable. */
  freeSpace(): Promise<DiskSpace | null>;
}

/**
 * The first path segment under which every browser-held device is mounted.
 *
 * A web device has no real mount point, so it is given a synthetic one —
 * `/ipodrocks-web/<id>` on POSIX, `C:\ipodrocks-web\<id>` on Windows. It is
 * host-flavoured on purpose (see this module's header), which means it is also
 * a perfectly valid local path, and a device path that reaches `fs` by mistake
 * would quietly create a directory tree in the filesystem root instead of
 * failing. {@link NodeDeviceFs} refuses these paths for exactly that reason.
 */
export const WEB_DEVICE_ROOT_NAME = "ipodrocks-web";

/** The synthetic mount root for a browser-held device. */
export function webDeviceRoot(deviceId: number): string {
  return path.join(path.sep, WEB_DEVICE_ROOT_NAME, String(deviceId));
}

/** Is this path under the synthetic web-device root? */
export function isWebDevicePath(p: string): boolean {
  if (!p) return false;
  const resolved = path.resolve(p);
  const rest = resolved.slice(path.parse(resolved).root.length);
  return rest.split(path.sep)[0] === WEB_DEVICE_ROOT_NAME;
}
