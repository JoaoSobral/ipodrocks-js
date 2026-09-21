/**
 * The device RPC verbs, executed against the File System Access API.
 *
 * This is the only place in the app that touches a `FileSystemDirectoryHandle`.
 * It is deliberately free of any transport: it takes a root handle and a verb,
 * and the worker, the main thread and the e2e tests all drive it the same way —
 * the tests against an OPFS directory, which returns a real
 * `FileSystemDirectoryHandle` with the identical interface, so the picker is
 * the only thing left needing a human.
 *
 * Two API realities shape everything here:
 *
 * - **`getDirectoryHandle(name)` matches one exact name.** There is no NFC/NFD
 *   forgiveness the way macOS and Windows give you. The server resolves
 *   spellings itself (see `RemoteDeviceFs`), which it can only do because
 *   `readdir` and `listTree` below report names *exactly* as the browser
 *   spells them. Do not normalise on the way out.
 * - **`createWritable()` copies the file to a `<name>.crswap` sibling and
 *   rewrites it wholesale.** So `patch` is a read-modify-write, not a seek, and
 *   a tab that dies mid-write leaves `.crswap` junk on the device.
 *   `Device.getTracks` filters on audio extensions so it never sees them, but
 *   Rockbox will.
 */

export interface RpcDirentOut {
  name: string;
  isDirectory: boolean;
}

export interface RpcTreeEntryOut {
  relPath: string;
  name: string;
  isDirectory: boolean;
  size: number;
  mtimeMs?: number;
}

export interface RpcStatOut {
  size: number;
  mtimeMs: number;
  isDirectory: boolean;
}

/** An error the server can switch on, matching Node's `errno` vocabulary. */
export class DeviceOpError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "DeviceOpError";
  }
}

function mapError(err: unknown, fallbackCode = "EIO"): DeviceOpError {
  const name = (err as { name?: string })?.name;
  const message = (err as { message?: string })?.message ?? String(err);
  // The DOMException names the FSA API throws, mapped onto the errno codes the
  // server's EPERM and ENOENT branches already understand.
  if (name === "NotFoundError") return new DeviceOpError(message, "ENOENT");
  if (name === "NotAllowedError") return new DeviceOpError(message, "EPERM");
  if (name === "SecurityError") return new DeviceOpError(message, "EPERM");
  if (name === "TypeMismatchError") return new DeviceOpError(message, "ENOTDIR");
  if (name === "InvalidModificationError") return new DeviceOpError(message, "ENOTEMPTY");
  if (name === "QuotaExceededError") return new DeviceOpError(message, "ENOSPC");
  return new DeviceOpError(message, fallbackCode);
}

function segmentsOf(rel: string): string[] {
  return rel.split("/").filter((s) => s.length > 0 && s !== ".");
}

async function dirAt(
  root: FileSystemDirectoryHandle,
  rel: string,
  create: boolean
): Promise<FileSystemDirectoryHandle> {
  let dir = root;
  for (const segment of segmentsOf(rel)) {
    dir = await dir.getDirectoryHandle(segment, { create });
  }
  return dir;
}

async function fileAt(
  root: FileSystemDirectoryHandle,
  rel: string,
  create: boolean
): Promise<FileSystemFileHandle> {
  const segments = segmentsOf(rel);
  const name = segments.pop();
  if (!name) throw new DeviceOpError(`Not a file path: ${rel}`, "EISDIR");
  const dir = await dirAt(root, segments.join("/"), create);
  return dir.getFileHandle(name, { create });
}

async function entriesOf(
  dir: FileSystemDirectoryHandle
): Promise<RpcDirentOut[]> {
  const out: RpcDirentOut[] = [];
  // `values()` is an async iterator on every implementation that has the API.
  for await (const handle of (
    dir as unknown as { values(): AsyncIterable<FileSystemHandle> }
  ).values()) {
    out.push({ name: handle.name, isDirectory: handle.kind === "directory" });
  }
  return out;
}

export async function opStat(
  root: FileSystemDirectoryHandle,
  rel: string
): Promise<RpcStatOut | null> {
  if (!segmentsOf(rel).length) return { size: 0, mtimeMs: 0, isDirectory: true };
  const segments = segmentsOf(rel);
  const name = segments[segments.length - 1];
  let parent: FileSystemDirectoryHandle;
  try {
    parent = await dirAt(root, segments.slice(0, -1).join("/"), false);
  } catch {
    return null;
  }
  try {
    const fh = await parent.getFileHandle(name);
    const file = await fh.getFile();
    return { size: file.size, mtimeMs: file.lastModified, isDirectory: false };
  } catch {
    /* not a file — try a directory */
  }
  try {
    await parent.getDirectoryHandle(name);
    return { size: 0, mtimeMs: 0, isDirectory: true };
  } catch {
    return null;
  }
}

export async function opReaddir(
  root: FileSystemDirectoryHandle,
  rel: string
): Promise<RpcDirentOut[]> {
  try {
    return await entriesOf(await dirAt(root, rel, false));
  } catch {
    // A missing directory is an empty listing, exactly as the local walks it
    // replaced treated an unreadable one. One bad folder must not abort a sync.
    return [];
  }
}

/**
 * The whole tree under `rel`, with sizes and mtimes in hand.
 *
 * One frame instead of a readdir-and-stat per file. On a local mount that
 * difference is syscalls; here it is network round trips, and a player with
 * four thousand tracks would otherwise take minutes to enumerate.
 */
export async function opListTree(
  root: FileSystemDirectoryHandle,
  rel: string
): Promise<RpcTreeEntryOut[]> {
  let base: FileSystemDirectoryHandle;
  try {
    base = await dirAt(root, rel, false);
  } catch {
    return [];
  }

  const out: RpcTreeEntryOut[] = [];
  const walk = async (dir: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
    let entries: RpcDirentOut[];
    try {
      entries = await entriesOf(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        out.push({ relPath, name: entry.name, isDirectory: true, size: 0 });
        try {
          await walk(await dir.getDirectoryHandle(entry.name), relPath);
        } catch {
          /* skip an unreadable subtree */
        }
        continue;
      }
      // An mtime left undefined is the marker for "could not be read", which
      // the server treats differently from 0.
      let size = 0;
      let mtimeMs: number | undefined;
      try {
        const file = await (await dir.getFileHandle(entry.name)).getFile();
        size = file.size;
        mtimeMs = file.lastModified;
      } catch {
        /* keep 0 / undefined */
      }
      out.push({ relPath, name: entry.name, isDirectory: false, size, mtimeMs });
    }
  };

  await walk(base, "");
  return out;
}

export async function opReadFile(
  root: FileSystemDirectoryHandle,
  rel: string
): Promise<ArrayBuffer> {
  try {
    return await (await (await fileAt(root, rel, false)).getFile()).arrayBuffer();
  } catch (err) {
    throw mapError(err);
  }
}

export async function opReadRange(
  root: FileSystemDirectoryHandle,
  rel: string,
  offset: number,
  length: number
): Promise<ArrayBuffer> {
  try {
    const file = await (await fileAt(root, rel, false)).getFile();
    // `slice` clamps at the end of the file, which is what the local
    // `readRange` does too — the image-header probe relies on getting back
    // whatever is there rather than an error or padding.
    return await file.slice(offset, offset + length).arrayBuffer();
  } catch (err) {
    throw mapError(err);
  }
}

export async function opWriteFile(
  root: FileSystemDirectoryHandle,
  rel: string,
  data: ArrayBuffer | Uint8Array
): Promise<void> {
  try {
    const handle = await fileAt(root, rel, true);
    const writable = await handle.createWritable();
    await writable.write(data as BufferSource);
    await writable.close();
  } catch (err) {
    throw mapError(err);
  }
}

/**
 * Rewrite byte ranges in place.
 *
 * `createWritable({ keepExistingData: true })` is what makes this a patch
 * rather than a truncate: without it the swap file starts empty and everything
 * outside the written ranges is lost. The Rockbox index has no checksum, so
 * that would be unrecoverable — which is also why the server takes a backup
 * before its first rating write.
 */
export async function opPatch(
  root: FileSystemDirectoryHandle,
  rel: string,
  ranges: { offset: number; bytes: ArrayBuffer | Uint8Array }[]
): Promise<void> {
  if (ranges.length === 0) return;
  try {
    const handle = await fileAt(root, rel, false);
    const writable = await handle.createWritable({ keepExistingData: true });
    for (const range of ranges) {
      await writable.write({
        type: "write",
        position: range.offset,
        data: range.bytes as BufferSource,
      });
    }
    await writable.close();
  } catch (err) {
    throw mapError(err);
  }
}

export async function opMkdir(
  root: FileSystemDirectoryHandle,
  rel: string,
  opts: { recursive?: boolean }
): Promise<void> {
  const segments = segmentsOf(rel);
  if (segments.length === 0) return;
  try {
    if (opts.recursive) {
      await dirAt(root, rel, true);
      return;
    }
    const parent = await dirAt(root, segments.slice(0, -1).join("/"), false);
    await parent.getDirectoryHandle(segments[segments.length - 1], { create: true });
  } catch (err) {
    throw mapError(err);
  }
}

export async function opUnlink(
  root: FileSystemDirectoryHandle,
  rel: string
): Promise<void> {
  const segments = segmentsOf(rel);
  const name = segments.pop();
  if (!name) throw new DeviceOpError(`Not a file path: ${rel}`, "EISDIR");
  try {
    const parent = await dirAt(root, segments.join("/"), false);
    await parent.removeEntry(name);
  } catch (err) {
    throw mapError(err);
  }
}

export async function opRmdir(
  root: FileSystemDirectoryHandle,
  rel: string
): Promise<void> {
  return opUnlink(root, rel);
}

export async function opRm(
  root: FileSystemDirectoryHandle,
  rel: string,
  opts: { recursive?: boolean; force?: boolean }
): Promise<void> {
  const segments = segmentsOf(rel);
  const name = segments.pop();
  if (!name) {
    // Clearing the device root itself is never what a caller means; the
    // "Delete all" guard already refuses anything that resolves to it.
    throw new DeviceOpError("Refusing to remove the device root", "EPERM");
  }
  try {
    const parent = await dirAt(root, segments.join("/"), false);
    await parent.removeEntry(name, { recursive: opts.recursive === true });
  } catch (err) {
    const mapped = mapError(err);
    if (opts.force && mapped.code === "ENOENT") return;
    throw mapped;
  }
}

/**
 * Copy-then-delete, because the File System Access API has no rename.
 *
 * Only ever used for small files — the playlist writer's temp swap and the
 * podcast cover sidecar — so reading the source whole is fine. A rename of an
 * audio file would not be.
 */
export async function opRename(
  root: FileSystemDirectoryHandle,
  from: string,
  to: string
): Promise<void> {
  try {
    const data = await opReadFile(root, from);
    await opWriteFile(root, to, data);
    await opUnlink(root, from);
  } catch (err) {
    throw err instanceof DeviceOpError ? err : mapError(err);
  }
}

/**
 * What the browser can say about free space.
 *
 * `navigator.storage.estimate()` describes the *origin's* quota, not the
 * removable volume, so it is only meaningful for an OPFS-backed device. For a
 * real picked folder there is no API at all and the answer is null, which
 * `Device.getAvailableSpace` degrades to zeroes — it is a UI label and nothing
 * decides anything from it.
 */
export async function opFreeSpace(): Promise<{
  totalBytes: number;
  freeBytes: number;
} | null> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (!estimate || estimate.quota === undefined) return null;
    const total = estimate.quota;
    const used = estimate.usage ?? 0;
    return { totalBytes: total, freeBytes: Math.max(0, total - used) };
  } catch {
    return null;
  }
}

/** Streams a server URL straight into a device file. The data plane. */
export async function opPull(
  root: FileSystemDirectoryHandle,
  rel: string,
  url: string
): Promise<void> {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) {
    throw new DeviceOpError(`Transfer failed: HTTP ${res.status}`, "EIO");
  }
  const handle = await fileAt(root, rel, true);
  const writable = await handle.createWritable();
  try {
    if (res.body) {
      // Piped, not buffered: a FLAC is tens of megabytes and this is the whole
      // reason the data plane is HTTP and not socket frames.
      await res.body.pipeTo(writable);
      return;
    }
    await writable.write(await res.arrayBuffer());
    await writable.close();
  } catch (err) {
    try {
      await writable.abort();
    } catch {
      /* already closed */
    }
    throw mapError(err);
  }
}

/** Sends a device file's bytes back to the server. The data plane, inbound. */
export async function opPush(
  root: FileSystemDirectoryHandle,
  rel: string,
  url: string
): Promise<void> {
  const file = await (await fileAt(root, rel, false)).getFile();
  const res = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
  });
  if (!res.ok) {
    throw new DeviceOpError(`Transfer failed: HTTP ${res.status}`, "EIO");
  }
}
