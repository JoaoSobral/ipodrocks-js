/**
 * The seam between `RemoteDeviceFs` and whatever is carrying its calls.
 *
 * `src/main/` must not import `src/server/` — the desktop build has no server
 * in it, and the daemon is the same `src/main/` code with a different host. So
 * the server does not hand a transport to the device layer; it *registers* one
 * here, keyed by device id, and `createDeviceFs` looks it up.
 *
 * That also gives "is this device connected" an honest answer for a web
 * device: a mounted volume is a fact about the filesystem, but a browser-held
 * one is connected exactly while a tab has its directory handle open, which is
 * exactly while a transport is registered.
 */
import type { DeviceRpcVerb } from "../../../shared/device-rpc";

export interface DeviceRpcTransport {
  /**
   * Milliseconds to add to a device-reported mtime to put it in server time
   * (`clientNow - serverNow`, measured when the browser attached).
   *
   * The sync's comparison for a lossy transcode is
   * `libMtime <= devMtime + 2500ms`, so a laptop whose clock is a minute fast
   * or slow re-copies the entire library on every run without this.
   */
  readonly clockSkewMs: number;
  /** The picked folder's name. UI only; never used to build a path. */
  readonly rootName: string;
  /** False when the browser holds only read permission. */
  readonly writable: boolean;

  /** One control-plane call. Rejects on timeout or a detached device. */
  call<T>(verb: DeviceRpcVerb, args: unknown[]): Promise<T>;

  /**
   * Data plane: tell the browser to stream a server-local file into `destRel`.
   *
   * Separate from `call("writeFile")` because the payload is a whole audio
   * file — framing one through the WebSocket would buffer it twice in memory
   * and lose backpressure entirely.
   */
  pull(localSrc: string, destRel: string): Promise<void>;

  /**
   * Data plane: have the browser POST `srcRel`'s bytes back, into a
   * server-local file.
   */
  push(srcRel: string, localDest: string): Promise<void>;
}

const transports = new Map<number, DeviceRpcTransport>();
type Listener = (deviceId: number, attached: boolean) => void;
const listeners = new Set<Listener>();

/** Registers the browser attachment for a device. Returns the detach function. */
export function registerDeviceTransport(
  deviceId: number,
  transport: DeviceRpcTransport
): () => void {
  transports.set(deviceId, transport);
  for (const l of listeners) l(deviceId, true);
  return () => {
    if (transports.get(deviceId) === transport) {
      transports.delete(deviceId);
      for (const l of listeners) l(deviceId, false);
    }
  };
}

export function getDeviceTransport(deviceId: number): DeviceRpcTransport | null {
  return transports.get(deviceId) ?? null;
}

/** Is a browser holding this device right now? */
export function isDeviceAttached(deviceId: number): boolean {
  return transports.has(deviceId);
}

export function onDeviceAttachmentChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tests, and a server restart. */
export function resetDeviceTransports(): void {
  transports.clear();
  listeners.clear();
}

/**
 * Thrown when a web device is reached while no browser holds it.
 *
 * A distinct error rather than an `ENOENT`, because "the tab is closed" is a
 * thing the user can fix and every other filesystem failure is not.
 */
export class DeviceDetachedError extends Error {
  readonly code = "EDEVICEDETACHED";
  constructor(deviceId: number) {
    super(
      `Device ${deviceId} is not connected. Open iPodRocks in the browser ` +
        "where the player is plugged in and reconnect it."
    );
    this.name = "DeviceDetachedError";
  }
}
