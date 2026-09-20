/**
 * The device RPC protocol, shared by the server and the browser that holds the
 * device.
 *
 * In web-server mode the library, the database and the encoders are on the
 * server, and the iPod is plugged into whatever laptop the user is sitting at.
 * Every `DeviceFs` call therefore has to cross to that browser. The split is
 * deliberate and is what keeps a multi-gigabyte sync off the WebSocket:
 *
 * - **Control plane** — small JSON frames on the existing `/api/events`
 *   socket. Listings, stats, directory creation, deletes, renames, and the
 *   short reads and writes the Rockbox database needs.
 * - **Data plane** — plain HTTP at `/api/device-io/…`. When a track has to go
 *   onto the device the server does not send its bytes down the socket; it
 *   tells the browser to `fetch` a one-shot URL and pipe the response straight
 *   into a `FileSystemWritableFileStream`. Reading a whole file back is the
 *   mirror. That buys real streaming, real backpressure and range support for
 *   free.
 *
 * **Every path in this file is relative to the device root and POSIX.** The
 * server converts at this boundary and nowhere else — inside the server a
 * device path stays absolute and in the host's own flavour, because six
 * containment guards do host `path` arithmetic on them. See
 * `src/main/devices/fs/device-fs.ts`.
 */

/** Frames the server sends down to the browser holding a device. */
export const DEVICE_RPC_REQUEST = "device-rpc";
/** Frames the browser sends back. */
export const DEVICE_RPC_RESULT = "device-rpc-result";
/** The browser announcing it now holds a device's directory handle. */
export const DEVICE_ATTACH = "device-attach";
/** The browser giving a device up — tab closing, or the user disconnecting it. */
export const DEVICE_DETACH = "device-detach";

/**
 * The verbs.
 *
 * `pull` and `push` are the data plane: their payload is a one-shot URL, not
 * bytes. Everything else is a control-plane call whose result is small.
 */
export type DeviceRpcVerb =
  | "stat"
  | "readdir"
  | "listTree"
  | "readFile"
  | "readRange"
  | "writeFile"
  | "patch"
  | "mkdir"
  | "unlink"
  | "rmdir"
  | "rm"
  | "rename"
  | "freeSpace"
  | "pull"
  | "push";

export interface DeviceRpcRequestFrame {
  type: typeof DEVICE_RPC_REQUEST;
  /** Correlates the reply. Unique per attachment. */
  id: number;
  deviceId: number;
  verb: DeviceRpcVerb;
  args: unknown[];
}

export interface DeviceRpcResultFrame {
  type: typeof DEVICE_RPC_RESULT;
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
  /**
   * A `NodeJS.ErrnoException`-style code where one is meaningful.
   *
   * `copyFileToDevice`'s `EPERM` fallback and `removeExtraTracks`'s `ENOENT`
   * skip both switch on this, so the browser maps the DOMExceptions it sees
   * onto the same names rather than making the server special-case two
   * vocabularies.
   */
  code?: string;
}

export interface DeviceAttachFrame {
  type: typeof DEVICE_ATTACH;
  deviceId: number;
  /**
   * `Date.now()` in the browser, read as close to sending as possible.
   *
   * The server subtracts its own clock to get the skew, and normalises every
   * mtime the device reports into server time. Without it the lossy-transcode
   * branch of `name-size-sync.ts` (`libMtime <= devMtime + 2500ms`) fails on
   * any machine whose clock differs by more than 2.5 seconds, and the sync
   * re-copies the entire library on every single run.
   */
  clientNow: number;
  /** The picked folder's name, for the UI. Never used as a path. */
  rootName: string;
  /** False when the browser only has read permission — the sync must refuse. */
  writable: boolean;
}

export interface DeviceDetachFrame {
  type: typeof DEVICE_DETACH;
  deviceId: number;
}

/** What the browser reports for one directory entry. */
export interface RpcDirent {
  name: string;
  isDirectory: boolean;
}

/** What the browser reports for one file, with the facts a walk needs. */
export interface RpcTreeEntry {
  /** POSIX, relative to the directory that was listed. */
  relPath: string;
  name: string;
  isDirectory: boolean;
  size: number;
  /** Absent when the entry could not be read; not the same as 0. */
  mtimeMs?: number;
}

export interface RpcStat {
  size: number;
  mtimeMs: number;
  isDirectory: boolean;
}

export interface RpcFreeSpace {
  totalBytes: number;
  freeBytes: number;
}

/**
 * How long the server waits for one control-plane reply.
 *
 * Generous, because the browser may be walking a folder of ten thousand files
 * on a USB 2.0 iPod. The data plane is not bounded by this at all — it is an
 * HTTP transfer with its own lifetime.
 */
export const DEVICE_RPC_TIMEOUT_MS = 120_000;

/** Bytes the server will accept from a single control-plane `readFile`. The
 *  Rockbox index is the big one and is a few megabytes; anything larger should
 *  be going through the data plane. */
export const MAX_RPC_READ_BYTES = 64 * 1024 * 1024;
