/**
 * `DeviceFs` over the local filesystem — what the desktop app has always done.
 *
 * Every method here is the call the sync used to make inline, so this file is
 * where to look when asking "did the refactor change anything". The answers
 * that are *not* a straight `fs` call are all marked.
 */
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";

import type { DiskSpace } from "../../../shared/types";
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

const NODE_CAPABILITIES: DeviceFsCapabilities = {
  setMtime: true,
  freeSpace: true,
  eject: true,
};

export class NodeDeviceFs implements DeviceFs {
  readonly root: string;
  readonly capabilities = NODE_CAPABILITIES;

  constructor(root: string) {
    this.root = root;
  }

  /**
   * Refuse a path belonging to a browser-held device.
   *
   * Its synthetic root is an ordinary-looking absolute path, so `fs` would
   * happily act on it: a missed thread-through in web mode would create
   * `/ipodrocks-web/3/Music/…` on the *server* and report a successful sync to
   * a user whose iPod never received a byte. Loud beats silent.
   */
  private guard(p: string): string {
    if (isWebDevicePath(p)) {
      throw new Error(
        `NodeDeviceFs refuses ${p}: that path belongs to a browser-held device, ` +
          "so this call reached the local filesystem instead of the device."
      );
    }
    return p;
  }

  async exists(p: string): Promise<boolean> {
    return fs.existsSync(this.guard(p));
  }

  async stat(p: string): Promise<DeviceStat | null> {
    try {
      const s = await fsp.stat(this.guard(p));
      return { size: s.size, mtimeMs: s.mtimeMs, isDirectory: s.isDirectory() };
    } catch {
      return null;
    }
  }

  async readdir(p: string): Promise<DeviceDirent[]> {
    try {
      const entries = await fsp.readdir(this.guard(p), { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
    } catch {
      return [];
    }
  }

  async listTree(dir: string, opts: ListTreeOptions = {}): Promise<DeviceTreeEntry[]> {
    this.guard(dir);
    const { signal, onEntry, includeDirectories = true } = opts;
    const out: DeviceTreeEntry[] = [];

    const walk = async (current: string): Promise<void> => {
      if (signal?.aborted) return;

      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(current, { withFileTypes: true });
      } catch {
        // An unreadable directory is skipped, exactly as each of the walks
        // this replaced did. One bad folder must not abort a sync.
        return;
      }

      for (const entry of entries) {
        if (signal?.aborted) return;
        const full = path.join(current, entry.name);

        if (entry.isDirectory()) {
          const dirEntry: DeviceTreeEntry = {
            path: full,
            name: entry.name,
            isDirectory: true,
            size: 0,
          };
          if (includeDirectories) {
            out.push(dirEntry);
            onEntry?.(dirEntry);
          }
          await walk(full);
          continue;
        }

        // mtime stays undefined when the stat fails: the comparison in
        // `name-size-sync.ts` reads "no mtime" and "mtime 0" differently.
        let size = 0;
        let mtimeMs: number | undefined;
        try {
          const s = await fsp.stat(full);
          size = s.size;
          mtimeMs = s.mtimeMs;
        } catch {
          /* keep 0 / undefined */
        }

        const fileEntry: DeviceTreeEntry = {
          path: full,
          name: entry.name,
          isDirectory: false,
          size,
          mtimeMs,
        };
        out.push(fileEntry);
        onEntry?.(fileEntry);
      }
    };

    if (!fs.existsSync(dir)) return out;
    await walk(dir);
    return out;
  }

  async readFile(p: string): Promise<Buffer> {
    return fsp.readFile(this.guard(p));
  }

  async readRange(p: string, offset: number, length: number): Promise<Buffer> {
    const handle = await fsp.open(this.guard(p), "r");
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, offset);
      return buf.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async writeFile(p: string, data: Uint8Array): Promise<void> {
    await fsp.writeFile(this.guard(p), data);
  }

  /**
   * Rewrite the named ranges of an existing file and fsync.
   *
   * `r+` rather than `w`: the file is opened in place, so nothing outside the
   * ranges is touched and the file's length never changes. The Rockbox index
   * this exists for carries no checksum, so a truncating write would be
   * unrecoverable.
   */
  async patch(p: string, ranges: DevicePatchRange[]): Promise<void> {
    if (ranges.length === 0) return;
    const handle = await fsp.open(this.guard(p), "r+");
    try {
      for (const range of ranges) {
        await handle.write(range.bytes, 0, range.bytes.length, range.offset);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async copyFromLocal(localSrc: string, dest: string): Promise<void> {
    await fsp.copyFile(localSrc, this.guard(dest));
  }

  async mkdir(p: string, opts: { recursive?: boolean } = {}): Promise<void> {
    await fsp.mkdir(this.guard(p), { recursive: opts.recursive ?? false });
  }

  async unlink(p: string): Promise<void> {
    await fsp.unlink(this.guard(p));
  }

  async rmdir(p: string): Promise<void> {
    await fsp.rmdir(this.guard(p));
  }

  async rm(
    p: string,
    opts: { recursive?: boolean; force?: boolean } = {}
  ): Promise<void> {
    await fsp.rm(this.guard(p), {
      recursive: opts.recursive ?? false,
      force: opts.force ?? false,
    });
  }

  async rename(from: string, to: string): Promise<void> {
    await fsp.rename(this.guard(from), this.guard(to));
  }

  async setMtime(p: string, atime: Date, mtime: Date): Promise<void> {
    await fsp.utimes(this.guard(p), atime, mtime);
  }

  async freeSpace(): Promise<DiskSpace | null> {
    if (!this.root || !fs.existsSync(this.guard(this.root))) return null;
    try {
      const stats = fs.statfsSync(this.root);
      const totalBytes = stats.bsize * stats.blocks;
      const freeBytes = stats.bsize * stats.bavail;
      return {
        totalBytes,
        freeBytes,
        totalGb: totalBytes / 1024 ** 3,
        freeGb: freeBytes / 1024 ** 3,
      };
    } catch {
      return null;
    }
  }
}
