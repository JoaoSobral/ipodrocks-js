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
 * The browser reporting bytes moved on a data-plane call still in flight.
 *
 * Two jobs: it is what the sync's MB/s readout is made of, and it is the
 * heartbeat that keeps a slow transfer alive — `pull`/`push` time out after
 * {@link DEVICE_TRANSFER_IDLE_MS} *without progress*, not after a fixed total.
 */
export const DEVICE_RPC_PROGRESS = "device-rpc-progress";

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
  | "rmMany"
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

export interface DeviceRpcProgressFrame {
  type: typeof DEVICE_RPC_PROGRESS;
  id: number;
  bytes: number;
  total: number | null;
}

/** One path's outcome in an `rmMany`. */
export interface RpcRemoveResult {
  ok: boolean;
  code?: string;
}

export interface DeviceAttachFrame {
  type: typeof DEVICE_ATTACH;
  deviceId: number;
  /**
   * True when this is the *same* tab re-announcing after its socket dropped,
   * with its worker — and therefore any call it was carrying — still alive.
   * The server then hands the new socket the calls the old one was waiting
   * on, and their replies land instead of being retried.
   */
  resumed?: boolean;
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
 * on a USB 2.0 iPod. The data-plane verbs (`pull`, `push`) are *not* bounded
 * by this: they use {@link DEVICE_TRANSFER_IDLE_MS}, reset by every progress
 * frame, so a large file on a slow link is never cut off while it is moving.
 */
export const DEVICE_RPC_TIMEOUT_MS = 120_000;

/** A transfer that reports no progress for this long is considered stalled. */
export const DEVICE_TRANSFER_IDLE_MS = 60_000;

/**
 * How long a device stays attached after the socket that holds it drops.
 *
 * A tunnel blip, a Wi-Fi switch or a laptop lid closed for a minute used to
 * end a sync: the attachment went with the socket, and every remaining call
 * failed even though the tab came straight back. Inside this window a call
 * waits for the tab to re-announce instead.
 */
export const DEVICE_RECONNECT_GRACE_MS = 120_000;

/**
 * Verbs that may be re-sent after a connection loss.
 *
 * Each one either only reads, or leaves the device in the same state however
 * many times it runs (a `pull` rewrites the whole file; a remove that already
 * happened reads as success). **`patch` is deliberately absent**: it is a
 * rating write into the checksum-less Rockbox index, and its caller already
 * wraps each track alone and leaves a failed one unmarked for the next sync.
 * `rename` is absent because it is copy-then-delete underneath. `writeFile`
 * replaces the whole file, so repeating it is harmless.
 */
export const RETRYABLE_DEVICE_VERBS: ReadonlySet<DeviceRpcVerb> = new Set<DeviceRpcVerb>([
  "stat",
  "readdir",
  "listTree",
  "readFile",
  "readRange",
  "writeFile",
  "mkdir",
  "unlink",
  "rmdir",
  "rm",
  "rmMany",
  "freeSpace",
  "pull",
  "push",
]);

/** Paths per `rmMany` frame. Keeps one frame, and one reply, small. */
export const RM_MANY_CHUNK = 500;

/** Bytes the server will accept from a single control-plane `readFile`. The
 *  Rockbox index is the big one and is a few megabytes; anything larger should
 *  be going through the data plane. */
export const MAX_RPC_READ_BYTES = 64 * 1024 * 1024;
