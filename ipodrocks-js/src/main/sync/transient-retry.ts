/**
 * Retrying the failures a flaky link produces, and only those.
 *
 * A copy to a browser-held device crosses the network twice: the browser
 * fetches the file from the server, then writes it to the player. Either leg
 * can fail for reasons that have nothing to do with the file — a stalled
 * transfer, a reset connection — and a sync of five thousand files used to
 * record each of those as a permanent per-file error. These are retried with
 * backoff; anything else (a full device, a permission error, a bad file) is
 * not, because retrying it changes nothing.
 *
 * **`EDEVICEDETACHED` is deliberately not transient here.** The transport
 * already waits out a dropped socket for its whole reconnect grace before
 * giving up; by the time this error reaches the sync, the tab is gone, and
 * retrying every remaining file against it would just add minutes of waiting
 * to a sync that cannot succeed. See {@link isDeviceGone}.
 */

/** Waits between attempts, in order. Three retries: 2 s, 5 s, 15 s. */
const DEFAULT_DELAYS_MS = [2_000, 5_000, 15_000];

/** Overridable so a test does not wait twenty-two seconds per injected fault. */
function retryDelays(): number[] {
  const raw = process.env.IPODROCKS_SYNC_RETRY_DELAYS;
  if (!raw) return DEFAULT_DELAYS_MS;
  const parsed = raw
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v) && v >= 0 && v <= 600_000);
  return parsed.length > 0 ? parsed : DEFAULT_DELAYS_MS;
}

function codeOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown })?.code;
  return typeof code === "string" ? code : undefined;
}

/** A failure of the link, not of the file or the device. */
export function isTransientDeviceError(err: unknown): boolean {
  const code = codeOf(err);
  if (code === "ETIMEDOUT" || code === "ECONNRESET" || code === "EPIPE") return true;
  // The browser maps "the fetch failed" and "the server answered 5xx" onto EIO
  // with this prefix; other EIOs are the device's own and are not retried.
  if (code === "EIO") {
    const message = (err as { message?: unknown })?.message;
    return typeof message === "string" && message.startsWith("Transfer failed");
  }
  return false;
}

/** The browser holding the device is gone for good: stop, do not retry. */
export function isDeviceGone(err: unknown): boolean {
  return codeOf(err) === "EDEVICEDETACHED";
}

export class RetryCancelled extends Error {
  constructor() {
    super("Cancelled");
    this.name = "RetryCancelled";
  }
}

export interface RetryHooks {
  signal?: AbortSignal;
  /** Called before each wait, with the error that caused it. */
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
}

/** Sleeps, but wakes early (and throws) on cancellation. */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
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

/** Runs `fn`, retrying it after transient failures with backoff. */
export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  hooks: RetryHooks = {}
): Promise<T> {
  const delays = retryDelays();
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientDeviceError(err) || attempt >= delays.length) throw err;
      const delay = delays[attempt];
      hooks.onRetry?.(attempt + 1, err, delay);
      await wait(delay, hooks.signal);
    }
  }
}

/**
 * Additive-increase / multiplicative-decrease over a worker count.
 *
 * A transient failure halves how many copies run at once (never below one);
 * a run of successes adds one back (never above the ceiling). On a healthy
 * link it sits at the ceiling; on a struggling one it backs off to a single
 * transfer instead of four that all time out together.
 */
export class AdaptiveConcurrency {
  private current: number;
  private streak = 0;

  constructor(
    private readonly max: number,
    private readonly successesToGrow = 10
  ) {
    this.current = Math.max(1, max);
  }

  get limit(): number {
    return this.current;
  }

  onSuccess(): void {
    this.streak++;
    if (this.streak >= this.successesToGrow && this.current < this.max) {
      this.current++;
      this.streak = 0;
    }
  }

  onTransientFailure(): void {
    this.streak = 0;
    this.current = Math.max(1, Math.floor(this.current / 2));
  }
}
