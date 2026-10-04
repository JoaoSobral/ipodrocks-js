/**
 * Telling "this file failed" apart from "the device is gone".
 *
 * An unmounted volume does not announce itself. Locally every call fails with
 * ENOENT; through a browser every File System Access call throws
 * `NotFoundError`, which maps to ENOENT too. So when an old iPod dropped off
 * USB mid-sync, the copy loop recorded every remaining file as its own
 * failure — 3,059 errors in two minutes for one cable — and the artwork loop
 * did the same per album.
 *
 * After a failure the loops ask {@link DevicePresence.isGone} whether the
 * content folder they just created is still there. If not, they stop
 * recording errors and wait, all of them on the same promise, for the device
 * to come back, then retry the file they were on. If it does not come back in
 * time the sync stops once, with one message.
 */
import type { DeviceFs } from "../devices/fs";
import { devLog } from "../utils/dev-log";
import { RetryCancelled } from "./transient-retry";

/** How long a sync waits for an unplugged device before giving up. */
export const DEFAULT_UNPLUG_WAIT_MS = 15 * 60 * 1000;
const DEFAULT_POLL_MS = 3000;

/** The device stayed unplugged past the wait. Thrown once, out of the sync. */
export class DeviceUnpluggedError extends Error {
  readonly code = "EDEVICEUNPLUGGED";
  constructor(readonly waitedMs: number) {
    super(
      `The device disconnected and did not come back within ${Math.round(waitedMs / 60000)} minute(s).`
    );
    this.name = "DeviceUnpluggedError";
  }
}

export function isDeviceUnplugged(err: unknown): boolean {
  return (err as { code?: unknown })?.code === "EDEVICEUNPLUGGED";
}

export interface DevicePresenceOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  pollMs?: number;
  /** The outage started. Called once per outage, however many workers hit it. */
  onWaiting?: () => void;
  /** The device answered again. */
  onBack?: (outageMs: number) => void;
  /** The wait timed out; the sync is about to stop. */
  onGiveUp?: (waitedMs: number) => void;
}

function unplugWaitFromEnv(): number | undefined {
  const raw = Number(process.env.IPODROCKS_UNPLUG_WAIT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

export class DevicePresence {
  private outage: Promise<void> | null = null;
  private readonly timeoutMs: number;
  private readonly pollMs: number;

  constructor(
    private readonly deviceFs: DeviceFs,
    private readonly opts: DevicePresenceOptions = {}
  ) {
    this.timeoutMs = opts.timeoutMs ?? unplugWaitFromEnv() ?? DEFAULT_UNPLUG_WAIT_MS;
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  }

  /** True while an outage is being waited out. */
  get waiting(): boolean {
    return this.outage !== null;
  }

  /**
   * Is the device unreachable? `probePath` must be a folder that exists on a
   * present device — the content folder a loop has just created. The remote
   * root itself always stats as a directory, so it cannot be the probe.
   *
   * A browser that has gone away (`EDEVICEDETACHED`) is a different failure
   * with its own handling, and is rethrown.
   */
  async isGone(probePath: string): Promise<boolean> {
    if (this.outage) return true;
    try {
      return (await this.deviceFs.stat(probePath)) === null;
    } catch (err) {
      if ((err as { code?: unknown })?.code === "EDEVICEDETACHED") throw err;
      return true;
    }
  }

  /**
   * Resolves when `probePath` answers again. Rejects with
   * {@link DeviceUnpluggedError} after the timeout and with `RetryCancelled`
   * on abort. Every caller during one outage shares one promise.
   */
  waitForReturn(probePath: string): Promise<void> {
    if (!this.outage) {
      const started = Date.now();
      this.opts.onWaiting?.();
      devLog("presence", `device unreachable at ${JSON.stringify(probePath)} — waiting up to ${this.timeoutMs} ms`);
      this.outage = this.poll(probePath, started).finally(() => {
        this.outage = null;
      });
    }
    return this.outage;
  }

  private async poll(probePath: string, started: number): Promise<void> {
    const { signal } = this.opts;
    for (;;) {
      if (signal?.aborted) throw new RetryCancelled();
      const elapsed = Date.now() - started;
      if (elapsed >= this.timeoutMs) {
        devLog("presence", `device did not come back after ${elapsed} ms — stopping`);
        this.opts.onGiveUp?.(elapsed);
        throw new DeviceUnpluggedError(elapsed);
      }
      await this.sleep(Math.min(this.pollMs, this.timeoutMs - elapsed));
      let back = false;
      try {
        back = (await this.deviceFs.stat(probePath)) !== null;
      } catch {
        back = false;
      }
      if (back) {
        const outageMs = Date.now() - started;
        devLog("presence", `device back after ${outageMs} ms — resuming`);
        this.opts.onBack?.(outageMs);
        return;
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    const { signal } = this.opts;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new RetryCancelled());
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new RetryCancelled());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
