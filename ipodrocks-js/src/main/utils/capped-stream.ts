import { Transform } from "stream";

/**
 * Hard ceiling on a single media download. Podcast episodes and audiobook
 * chapters come from feed-controlled URLs, so without a cap a hostile or
 * broken feed could stream unbounded data and fill the user's disk. 2 GiB is
 * far above any real spoken-word file.
 */
export const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * A pass-through stream that aborts the pipeline once more than `maxBytes`
 * have flowed through it. Insert it between the network body and the file
 * sink: `pipeline(body, byteCapTransform(), dest)`.
 */
export function byteCapTransform(maxBytes: number = MAX_DOWNLOAD_BYTES): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      total += chunk.length;
      if (total > maxBytes) {
        cb(new Error(`Download exceeded maximum size of ${maxBytes} bytes`));
        return;
      }
      cb(null, chunk);
    },
  });
}

export class ResponseTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Response exceeded the maximum size of ${maxBytes} bytes`);
    this.name = "ResponseTooLargeError";
  }
}

/**
 * Reads a response body into memory, never holding more than `maxBytes`.
 *
 * `res.text()` has no ceiling, and the body `safeFetch` hands back is already
 * *decoded*: a few megabytes of gzip or brotli on the wire can be hundreds of
 * megabytes here. So the count is of decoded bytes, the read is incremental,
 * and the stream is cancelled — which tears the socket down — the moment the
 * limit is crossed, rather than after the whole thing has been buffered.
 *
 * `"reject"` throws {@link ResponseTooLargeError}; `"truncate"` returns the
 * first `maxBytes` and stops reading, for callers that only need a prefix.
 */
export async function readBodyCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  onOverflow: "reject" | "truncate" = "reject"
): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > maxBytes) {
        await reader.cancel().catch(() => undefined);
        if (onOverflow === "reject") throw new ResponseTooLargeError(maxBytes);
        chunks.push(Buffer.from(value.buffer, value.byteOffset, maxBytes - total));
        total = maxBytes;
        break;
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

/**
 * Time bounds on a media download. Byte caps say nothing about time: a server
 * that sends its headers and then one byte a minute keeps a download — and the
 * strictly serial podcast refresh, and any device sync waiting on a chapter —
 * pending for as long as it likes. `safeFetch`'s socket idle timeout catches a
 * server that goes silent; it cannot catch one that trickles.
 *
 * - `stallWindowMs` / `minBytesPerWindow`: fewer than this many bytes in any
 *   window aborts. 16 KiB a minute is ~270 bytes a second — a dial-up line
 *   clears it hundreds of times over, a trickle never does. The window starts
 *   at the request, so a server that never sends headers trips it too.
 * - `maxDurationMs`: the overall ceiling. Generous on purpose — a 2 GiB file on
 *   a slow line is a legitimate, hours-long download.
 */
export interface DownloadLimits {
  stallWindowMs: number;
  minBytesPerWindow: number;
  maxDurationMs: number;
}

export const DEFAULT_DOWNLOAD_LIMITS: Readonly<DownloadLimits> = Object.freeze({
  stallWindowMs: 60_000,
  minBytesPerWindow: 16 * 1024,
  maxDurationMs: 6 * 60 * 60_000,
});

let downloadLimits: DownloadLimits = { ...DEFAULT_DOWNLOAD_LIMITS };

/** Test seam: shrink the windows so a stall test runs in milliseconds. `null` restores. */
export function setDownloadLimitsForTests(limits: Partial<DownloadLimits> | null): DownloadLimits {
  const previous = downloadLimits;
  downloadLimits = limits ? { ...downloadLimits, ...limits } : { ...DEFAULT_DOWNLOAD_LIMITS };
  return previous;
}

export class DownloadStalledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DownloadStalledError";
  }
}

export interface DownloadWatchdog {
  /** Pass to `safeFetch`; aborts on a stall, the overall deadline, or the caller's signal. */
  signal: AbortSignal;
  /** Insert into the body pipeline so the watchdog sees every byte. */
  meter: Transform;
  /** Always call, success or failure — it clears the timers. */
  dispose(): void;
}

/**
 * The time bounds for one download, combined with an optional caller signal
 * (a device sync's cancel). Every download of a feed-controlled URL goes
 * through one of these; there is deliberately no way to ask for "no limit".
 */
export function downloadWatchdog(callerSignal?: AbortSignal): DownloadWatchdog {
  const { stallWindowMs, minBytesPerWindow, maxDurationMs } = downloadLimits;
  const stall = new AbortController();
  let windowBytes = 0;
  const interval = setInterval(() => {
    if (windowBytes < minBytesPerWindow) {
      stall.abort(
        new DownloadStalledError(
          `Download stalled: ${windowBytes} bytes in ${Math.round(stallWindowMs / 1000)}s`
        )
      );
      clearInterval(interval);
    }
    windowBytes = 0;
  }, stallWindowMs);
  interval.unref?.();
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(() => {
    deadline.abort(
      new DownloadStalledError(
        `Download did not finish within ${Math.round(maxDurationMs / 60_000)} minutes`
      )
    );
  }, maxDurationMs);
  deadlineTimer.unref?.();

  const signals = [stall.signal, deadline.signal];
  if (callerSignal) signals.push(callerSignal);

  return {
    signal: AbortSignal.any(signals),
    meter: new Transform({
      transform(chunk: Buffer, _enc, cb) {
        windowBytes += chunk.length;
        cb(null, chunk);
      },
    }),
    dispose() {
      clearInterval(interval);
      clearTimeout(deadlineTimer);
    },
  };
}

/** The message to record for a failed download: the abort's reason when there was one. */
export function downloadErrorMessage(err: unknown, signal: AbortSignal): string {
  if (signal.aborted) {
    const r: unknown = signal.reason;
    if (r instanceof Error) return r.message;
    if (typeof r === "string") return r;
    return "Download cancelled";
  }
  return err instanceof Error ? err.message : String(err);
}
