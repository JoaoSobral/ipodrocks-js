/**
 * `DeviceFs` over a folder held open in someone's browser.
 *
 * Every call becomes a frame on the `/api/events` socket, except the two that
 * move a whole file, which go over plain HTTP so a multi-gigabyte sync gets
 * real streaming and real backpressure.
 *
 * Three things here are not simply "the same call, remoted", and each exists
 * because the File System Access API is not a filesystem:
 *
 * 1. **Name resolution.** `getDirectoryHandle("Album")` matches one exact
 *    name. macOS and Windows resolve NFC and NFD for you; this does not. Ask
 *    in NFC for a folder stored as NFD and you get `NotFoundError`, the sync
 *    creates a *second* folder, and from then on the device holds two folders
 *    for one album — at which point `buildDevicePathResolver`'s ambiguity
 *    guard plants its `-1` marker and every runtime record and rating for that
 *    album silently stops matching. So this class implements `findOnDisk`
 *    semantics itself: enumerate, NFC-fold, match, and pass the name back
 *    through **exactly as the browser spelled it**.
 * 2. **A directory cache.** Resolving a four-segment path would otherwise be
 *    four round trips per file. The enumeration that name resolution needs
 *    gives the cache for free, so it costs nothing extra.
 * 3. **Clock skew.** Every mtime the device reports is shifted into server
 *    time. Without it the lossy-transcode branch of `name-size-sync.ts`
 *    (`libMtime <= devMtime + 2500ms`) fails on any laptop whose clock differs
 *    by more than 2.5 seconds, and the sync re-copies the whole library every
 *    run.
 */
import * as path from "path";

import type { DiskSpace } from "../../../shared/types";
import type {
  RpcDirent,
  RpcFreeSpace,
  RpcStat,
  RpcTreeEntry,
} from "../../../shared/device-rpc";
import { toMountRelative } from "../../rockbox/device-path-match";

import {
  isWebDevicePath,
  type DeviceDirent,
  type DeviceFs,
  type DeviceFsCapabilities,
  type DevicePatchRange,
  type DeviceStat,
  type DeviceTreeEntry,
  type ListTreeOptions,
} from "./device-fs";
import type { DeviceRpcTransport } from "./device-transport";

/**
 * What a browser-held device cannot do.
 *
 * `setMtime` is the load-bearing one: the File System Access API has no way to
 * stamp a written file, so `copyFileToDevice` skips it and the comparison in
 * `name-size-sync.ts` falls back to its size-first path — which it already
 * tries first whenever a size is known, and which for a lossy transcode
 * (where it is not) a just-written file satisfies naturally.
 */
const REMOTE_CAPABILITIES: DeviceFsCapabilities = {
  setMtime: false,
  freeSpace: true,
  eject: false,
};

/** An error carrying the `code` the browser mapped its DOMException onto, so
 *  `copyFileToDevice`'s EPERM fallback and `removeExtraTracks`'s ENOENT skip
 *  keep working across the wire. */
class RemoteFsError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "RemoteFsError";
  }
}

export class RemoteDeviceFs implements DeviceFs {
  readonly capabilities = REMOTE_CAPABILITIES;

  /**
   * `parentRel` -> (NFC-folded name -> the name as the browser spelled it).
   *
   * Populated by every listing this instance performs. One instance lives for
   * one operation (a sync, a check), which is also how long the cache may be
   * trusted: the user can unplug and replug between them.
   */
  private readonly dirCache = new Map<string, Map<string, string>>();

  constructor(
    readonly root: string,
    private readonly transport: DeviceRpcTransport
  ) {}

  // ---------------------------------------------------------------- paths --

  /**
   * Absolute host path -> device-relative POSIX.
   *
   * Refuses anything outside this device's root. `toMountRelative` returns its
   * input unchanged when the path escapes, which is the signal used here — a
   * path that is not ours must never be silently reinterpreted as relative,
   * because a sync that did would write a library folder's contents into the
   * player's root.
   */
  private rel(absPath: string): string {
    if (!isWebDevicePath(absPath)) {
      throw new RemoteFsError(
        `RemoteDeviceFs refuses ${absPath}: it is not on a browser-held device.`
      );
    }
    const resolvedRoot = path.resolve(this.root);
    const resolved = path.resolve(absPath);
    if (resolved === resolvedRoot) return "";
    const rel = toMountRelative(resolved, resolvedRoot);
    if (rel === resolved) {
      throw new RemoteFsError(
        `RemoteDeviceFs refuses ${absPath}: it is outside ${this.root}.`
      );
    }
    return rel;
  }

  /** Device-relative POSIX -> absolute host path, for anything handed back. */
  private abs(rel: string): string {
    if (!rel) return this.root;
    return path.join(this.root, ...rel.split("/"));
  }

  private shiftMtime(mtimeMs: number): number {
    return mtimeMs - this.transport.clockSkewMs;
  }

  // ------------------------------------------------------ name resolution --

  private cacheDir(parentRel: string, entries: RpcDirent[]): void {
    const map = new Map<string, string>();
    for (const entry of entries) {
      // Fold only for matching. The value is the browser's own spelling, which
      // is the only one `getDirectoryHandle` will accept.
      map.set(entry.name.normalize("NFC"), entry.name);
    }
    this.dirCache.set(parentRel, map);
  }

  private async namesIn(parentRel: string): Promise<Map<string, string>> {
    const cached = this.dirCache.get(parentRel);
    if (cached) return cached;
    let entries: RpcDirent[] = [];
    try {
      entries = await this.transport.call<RpcDirent[]>("readdir", [parentRel]);
    } catch {
      entries = [];
    }
    this.cacheDir(parentRel, entries);
    return this.dirCache.get(parentRel)!;
  }

  /**
   * The spelling this path actually has on the device.
   *
   * A segment that does not exist is passed through unchanged — that is the
   * "creating it now" case, and the caller's own spelling is then the right
   * one. A segment that exists in a different normal form resolves to the
   * device's form, which is the whole point.
   */
  private async resolveRel(rel: string): Promise<string> {
    if (!rel) return "";
    const segments = rel.split("/");
    const out: string[] = [];
    for (const segment of segments) {
      const parentRel = out.join("/");
      const names = await this.namesIn(parentRel);
      const actual = names.get(segment.normalize("NFC"));
      out.push(actual ?? segment);
    }
    return out.join("/");
  }

  /** Drops a directory's cached listing after something in it changed. */
  private invalidate(rel: string): void {
    const parent = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    this.dirCache.delete(parent);
    this.dirCache.delete(rel);
  }

  private async call<T>(verb: Parameters<DeviceRpcTransport["call"]>[0], args: unknown[]): Promise<T> {
    try {
      return await this.transport.call<T>(verb, args);
    } catch (err) {
      const e = err as { message?: string; code?: string };
      throw new RemoteFsError(e?.message ?? String(err), e?.code);
    }
  }

  // ------------------------------------------------------------- readings --

  async exists(p: string): Promise<boolean> {
    return (await this.stat(p)) !== null;
  }

  async stat(p: string): Promise<DeviceStat | null> {
    const rel = await this.resolveRel(this.rel(p));
    try {
      const s = await this.call<RpcStat | null>("stat", [rel]);
      if (!s) return null;
      return {
        size: s.size,
        mtimeMs: this.shiftMtime(s.mtimeMs),
        isDirectory: s.isDirectory,
      };
    } catch {
      return null;
    }
  }

  async readdir(p: string): Promise<DeviceDirent[]> {
    const rel = await this.resolveRel(this.rel(p));
    try {
      const entries = await this.call<RpcDirent[]>("readdir", [rel]);
      this.cacheDir(rel, entries);
      return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory }));
    } catch {
      return [];
    }
  }

  async listTree(dir: string, opts: ListTreeOptions = {}): Promise<DeviceTreeEntry[]> {
    const { signal, onEntry, includeDirectories = true } = opts;
    const baseRel = await this.resolveRel(this.rel(dir));
    if (signal?.aborted) return [];

    let entries: RpcTreeEntry[];
    try {
      // One call for the whole tree. Four hundred files is four hundred round
      // trips done one at a time and one frame done properly.
      entries = await this.call<RpcTreeEntry[]>("listTree", [baseRel]);
    } catch {
      return [];
    }

    const out: DeviceTreeEntry[] = [];
    // The listing doubles as a cache fill, so the resolver does not have to
    // re-ask for any directory under here.
    const byParent = new Map<string, RpcDirent[]>();
    for (const entry of entries) {
      const full = baseRel ? `${baseRel}/${entry.relPath}` : entry.relPath;
      const parent = full.includes("/") ? full.slice(0, full.lastIndexOf("/")) : "";
      let bucket = byParent.get(parent);
      if (!bucket) {
        bucket = [];
        byParent.set(parent, bucket);
      }
      bucket.push({ name: entry.name, isDirectory: entry.isDirectory });
    }
    for (const [parent, dirents] of byParent) this.cacheDir(parent, dirents);

    for (const entry of entries) {
      if (signal?.aborted) return out;
      if (entry.isDirectory && !includeDirectories) continue;
      const item: DeviceTreeEntry = {
        path: this.abs(baseRel ? `${baseRel}/${entry.relPath}` : entry.relPath),
        name: entry.name,
        isDirectory: entry.isDirectory,
        size: entry.size,
        mtimeMs: entry.mtimeMs === undefined ? undefined : this.shiftMtime(entry.mtimeMs),
      };
      out.push(item);
      onEntry?.(item);
    }
    return out;
  }

  async readFile(p: string): Promise<Buffer> {
    const rel = await this.resolveRel(this.rel(p));
    const base64 = await this.call<string>("readFile", [rel]);
    return Buffer.from(base64, "base64");
  }

  async readRange(p: string, offset: number, length: number): Promise<Buffer> {
    const rel = await this.resolveRel(this.rel(p));
    const base64 = await this.call<string>("readRange", [rel, offset, length]);
    return Buffer.from(base64, "base64");
  }

  // ------------------------------------------------------------- writings --

  async writeFile(p: string, data: Uint8Array): Promise<void> {
    const rel = await this.resolveRel(this.rel(p));
    await this.call<void>("writeFile", [rel, Buffer.from(data).toString("base64")]);
    this.invalidate(rel);
  }

  /**
   * Rewrite byte ranges in place.
   *
   * Chrome's `createWritable()` copies the file to a `<name>.crswap` sibling
   * and rewrites it wholesale rather than patching, so this is not the cheap
   * operation it is locally — and it is why the Rockbox index backup matters
   * *more* here, not less. A tab dying mid-write also leaves `.crswap` junk on
   * the device; `Device.getTracks` filters on `AUDIO_EXTENSIONS` so it never
   * sees them, but Rockbox will.
   */
  async patch(p: string, ranges: DevicePatchRange[]): Promise<void> {
    if (ranges.length === 0) return;
    const rel = await this.resolveRel(this.rel(p));
    await this.call<void>("patch", [
      rel,
      ranges.map((r) => ({
        offset: r.offset,
        bytes: Buffer.from(r.bytes).toString("base64"),
      })),
    ]);
  }

  async copyFromLocal(localSrc: string, dest: string): Promise<void> {
    const rel = await this.resolveRel(this.rel(dest));
    await this.transport.pull(localSrc, rel);
    this.invalidate(rel);
  }

  async mkdir(p: string, opts: { recursive?: boolean } = {}): Promise<void> {
    const rel = await this.resolveRel(this.rel(p));
    if (!rel) return;
    await this.call<void>("mkdir", [rel, { recursive: opts.recursive ?? false }]);
    this.invalidate(rel);
  }

  async unlink(p: string): Promise<void> {
    const rel = await this.resolveRel(this.rel(p));
    await this.call<void>("unlink", [rel]);
    this.invalidate(rel);
  }

  async rmdir(p: string): Promise<void> {
    const rel = await this.resolveRel(this.rel(p));
    await this.call<void>("rmdir", [rel]);
    this.invalidate(rel);
  }

  async rm(
    p: string,
    opts: { recursive?: boolean; force?: boolean } = {}
  ): Promise<void> {
    const rel = await this.resolveRel(this.rel(p));
    await this.call<void>("rm", [
      rel,
      { recursive: opts.recursive ?? false, force: opts.force ?? false },
    ]);
    this.invalidate(rel);
  }

  async rename(from: string, to: string): Promise<void> {
    const fromRel = await this.resolveRel(this.rel(from));
    const toRel = await this.resolveRel(this.rel(to));
    await this.call<void>("rename", [fromRel, toRel]);
    this.invalidate(fromRel);
    this.invalidate(toRel);
  }

  /**
   * Never called: `capabilities.setMtime` is false and every caller checks it.
   *
   * It throws rather than returning quietly so a future caller that forgets
   * the check finds out here, instead of shipping a sync that silently
   * re-copies the library every run because nothing was ever stamped.
   */
  async setMtime(): Promise<void> {
    throw new RemoteFsError(
      "A browser-held device cannot set a file's mtime; check capabilities.setMtime."
    );
  }

  async freeSpace(): Promise<DiskSpace | null> {
    try {
      const s = await this.call<RpcFreeSpace | null>("freeSpace", []);
      if (!s) return null;
      return {
        totalBytes: s.totalBytes,
        freeBytes: s.freeBytes,
        totalGb: s.totalBytes / 1024 ** 3,
        freeGb: s.freeBytes / 1024 ** 3,
      };
    } catch {
      return null;
    }
  }
}
