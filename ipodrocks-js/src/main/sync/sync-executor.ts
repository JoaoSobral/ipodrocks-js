import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";

import type { CopyOptions, DeviceFs } from "../devices/fs";
import { findOnDisk } from "../utils/normalize-path";

import { ConversionSettings, convertWithCodec, convertWithFfmpeg, updateExtension } from "./sync-conversion";
import { appendSyncError } from "./sync-error-log";
import { devLog } from "../utils/dev-log";
import { isDeviceUnplugged, type DevicePresence } from "./device-presence";
import {
  AdaptiveConcurrency,
  isDeviceGone,
  isTransientDeviceError,
  withTransientRetry,
} from "./transient-retry";

const MAX_COPY_WORKERS = 4;

export type CopyStatus = "copied" | "converted" | "error" | "missing" | "skipped";

export interface CopyProgress {
  srcPath: string;
  destPath: string | null;
  status: CopyStatus;
  /** Size of the file that was put on the device, when known. */
  bytes?: number;
}

/** A copy about to be retried after a link failure. */
export interface CopyRetryInfo {
  srcPath: string;
  attempt: number;
  error: string;
  delayMs: number;
}

export interface CopyToDeviceOptions {
  convert?: boolean;
  profile?: string;
  preserveStructure?: boolean;
  perTrackConversion?: Record<string, ConversionSettings>;
  customDestinations?: Record<string, string>;
  progressCallback?: (progress: CopyProgress) => void;
  logCallback?: (line: string) => void;
  cancelSignal?: AbortSignal;
  /**
   * Bytes moved since the last call, plus where that copy now stands, so a
   * caller can show each file in flight. `total` is null until known.
   */
  bytesCallback?: (deltaBytes: number, srcPath: string, done: number, total: number | null) => void;
  /**
   * A file was picked up by a worker. Without it a slow link shows nothing
   * at all until a whole file lands: four large files sharing a few MB/s can
   * take a minute before the first `progressCallback`.
   */
  startCallback?: (srcPath: string, size: number | null) => void;
  /** A copy is about to be retried after a link failure. */
  retryCallback?: (info: CopyRetryInfo) => void;
  /**
   * Tells a failed file apart from an unplugged device. Without it an iPod
   * dropping off USB mid-sync is recorded as one error per remaining file.
   */
  presence?: DevicePresence;
  /** Files written at once; capped at {@link MAX_COPY_WORKERS}. */
  maxWorkers?: number;
}

/**
 * The browser holding the device is gone, past its reconnect grace. Thrown
 * out of the copy loop rather than recorded per file: every remaining file
 * would fail the same way, and a sync that reports "4,000 errors" for one
 * closed tab is worse than one that says the tab closed.
 */
export class DeviceGoneError extends Error {
  readonly code = "EDEVICEDETACHED";
  constructor(cause: unknown) {
    super(
      `The browser holding the device disconnected and did not come back: ${
        (cause as Error)?.message ?? String(cause)
      }`
    );
    this.name = "DeviceGoneError";
  }
}

/**
 * Put one library file on the device, with the source's mtime where that is
 * possible.
 *
 * `deviceFs` is first and required. Both the source and the destination are
 * plain absolute paths and look alike, and a copy that silently went to the
 * server's own disk in web mode would report a successful sync for a player
 * that received nothing.
 *
 * The `EPERM` handling is the original behaviour and matters on FAT volumes
 * mounted without ownership: the copy or the mtime write fails with `EPERM`
 * although the bytes did land, so both catches fall back to comparing sizes and
 * report success when they match.
 */
export async function copyFileToDevice(
  deviceFs: DeviceFs,
  src: string,
  dest: string,
  copyOpts?: CopyOptions
): Promise<boolean> {
  await deviceFs.mkdir(path.dirname(dest), { recursive: true });

  /** Did the bytes arrive anyway? The only thing an `EPERM` can still tell us. */
  const sizesMatch = async (): Promise<boolean> => {
    try {
      const [destStat, srcStat] = await Promise.all([
        deviceFs.stat(dest),
        fsp.stat(src),
      ]);
      return destStat != null && destStat.size === srcStat.size;
    } catch {
      return false;
    }
  };

  try {
    await deviceFs.copyFromLocal(src, dest, copyOpts);

    // A device that cannot set mtimes is not an error: `name-size-sync.ts`
    // compares by size first whenever it knows one, and for a lossy transcode
    // (where it does not) a just-written file satisfies the mtime test anyway.
    if (!deviceFs.capabilities.setMtime) return true;

    try {
      const srcStat = await fsp.stat(src);
      await deviceFs.setMtime(dest, srcStat.atime, srcStat.mtime);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" && (await sizesMatch())) return true;
      throw err;
    }
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" && (await sizesMatch())) return true;
    throw err;
  }
}

interface CopyJob {
  src: string;
  dest: string;
}

interface ConvertJob {
  src: string;
  dest: string;
  hasCodec: boolean;
  settings: ConversionSettings | null;
  profile: string;
}

export async function copyToDevice(
  deviceFs: DeviceFs,
  trackPaths: string[],
  deviceFolder: string,
  options: CopyToDeviceOptions = {}
): Promise<void> {
  const {
    convert = false,
    profile = "aac_256",
    preserveStructure = true,
    perTrackConversion,
    customDestinations,
    progressCallback,
    logCallback,
    cancelSignal,
    bytesCallback,
    retryCallback,
    startCallback,
    presence,
    maxWorkers,
  } = options;

  await deviceFs.mkdir(deviceFolder, { recursive: true });

  const copyJobs: CopyJob[] = [];
  const convertJobs: ConvertJob[] = [];

  for (const srcPath of trackPaths) {
    if (cancelSignal?.aborted) return;

    // Track paths are stored NFC-normalized; on normalization-sensitive
    // filesystems the on-disk name may be NFD. Resolve to the readable form
    // for the actual copy/convert, but keep `srcPath` (NFC) for dest naming
    // and progress/DB keys.
    const diskSrc = findOnDisk(srcPath);
    if (!fs.existsSync(diskSrc)) {
      logCallback?.(`Warning: Source file not found: ${srcPath}`);
      progressCallback?.({ srcPath, destPath: null, status: "missing" });
      continue;
    }

    let dest: string;
    if (customDestinations && srcPath in customDestinations) {
      const custom = customDestinations[srcPath];
      // Always resolve relative to deviceFolder; absolute paths are not allowed
      // as they can escape the device mount point.
      const candidate = path.isAbsolute(custom)
        ? path.join(deviceFolder, path.basename(custom))
        : path.join(deviceFolder, custom);
      dest = containUnderFolder(candidate, deviceFolder, srcPath);
    } else if (preserveStructure) {
      dest = getDestinationPath(srcPath, deviceFolder);
    } else {
      dest = path.join(deviceFolder, path.basename(srcPath));
    }

    let shouldConvert = false;
    let conversionSettings: ConversionSettings | null = null;

    if (perTrackConversion && srcPath in perTrackConversion) {
      conversionSettings = perTrackConversion[srcPath];
      shouldConvert = conversionSettings.transfer_mode === "convert";
    } else if (convert) {
      shouldConvert = true;
      conversionSettings = { codec: profile.split("_")[0] };
    }

    if (!shouldConvert) {
      copyJobs.push({ src: diskSrc, dest });
      continue;
    }

    const hasCodec = conversionSettings != null && "codec" in conversionSettings;
    convertJobs.push({ src: diskSrc, dest, hasCodec, settings: conversionSettings, profile });
  }

  if (copyJobs.length > 0) {
    await runParallelCopies(deviceFs, copyJobs, {
      progressCallback,
      logCallback,
      cancelSignal,
      bytesCallback,
      retryCallback,
      startCallback,
      presence,
      maxWorkers,
      probePath: deviceFolder,
    });
  }

  for (const job of convertJobs) {
    if (cancelSignal?.aborted) return;
    // A transcode's output size is unknown until it exists.
    startCallback?.(job.src, null);

    const dest =
      job.hasCodec && job.settings ? updateExtension(job.dest, job.settings.codec!) : job.dest;

    for (;;) {
      const conversionLog: string[] = [];
      const logWithCapture = (line: string): void => {
        conversionLog.push(line);
        logCallback?.(line);
      };

      let failure: string | null = null;
      try {
        if (job.hasCodec && job.settings) {
          const success = await convertWithCodec(
            job.src,
            dest,
            job.settings,
            logWithCapture,
            cancelSignal,
            deviceFs
          );
          if (!success) failure = "Conversion failed";
        } else {
          await convertWithFfmpeg(
            job.src,
            job.dest,
            job.profile,
            logWithCapture,
            cancelSignal,
            deviceFs
          );
        }
      } catch (err) {
        if (isDeviceGone(err)) throw new DeviceGoneError(err);
        failure = String(err);
      }

      if (failure === null) {
        await copyMtimeToDevice(deviceFs, job.src, dest);
        progressCallback?.({ srcPath: job.src, destPath: dest, status: "converted" });
        break;
      }

      // The encode is on the server; only the device can vanish under it.
      // Wait for it and encode this track again rather than failing it and
      // every track after it.
      if (presence && !cancelSignal?.aborted && (await presence.isGone(deviceFolder))) {
        try {
          await presence.waitForReturn(deviceFolder);
        } catch (err) {
          if (isDeviceUnplugged(err)) throw err;
          return; // cancelled while waiting
        }
        continue;
      }

      appendSyncError(job.src, dest, failure, conversionLog);
      if (failure !== "Conversion failed") {
        logCallback?.(`Failed to convert ${path.basename(job.src)}: ${failure}`);
      }
      progressCallback?.({ srcPath: job.src, destPath: dest, status: "error" });
      break;
    }
  }
}

/**
 * Stamp a transcode with its source's mtime, where the device allows it.
 *
 * Non-fatal either way: the next sync falls back to the size comparison.
 */
async function copyMtimeToDevice(
  deviceFs: DeviceFs,
  src: string,
  dest: string
): Promise<void> {
  if (!deviceFs.capabilities.setMtime) return;
  try {
    const srcStat = await fsp.stat(src);
    await deviceFs.setMtime(dest, srcStat.atime, srcStat.mtime);
  } catch {
    /* non-fatal: next sync falls back to size check */
  }
}

async function runParallelCopies(
  deviceFs: DeviceFs,
  jobs: CopyJob[],
  opts: {
    progressCallback?: (progress: CopyProgress) => void;
    logCallback?: (line: string) => void;
    cancelSignal?: AbortSignal;
    bytesCallback?: CopyToDeviceOptions["bytesCallback"];
    retryCallback?: (info: CopyRetryInfo) => void;
    startCallback?: CopyToDeviceOptions["startCallback"];
    presence?: DevicePresence;
    maxWorkers?: number;
    /** A folder that exists while the device is present (the one being copied into). */
    probePath: string;
  }
): Promise<void> {
  const {
    progressCallback,
    logCallback,
    cancelSignal,
    bytesCallback,
    retryCallback,
    startCallback,
    presence,
    maxWorkers,
    probePath,
  } = opts;
  // Over a network the worker count follows how the link is coping; on a
  // local mount it stays where it always was.
  const adaptive = deviceFs.capabilities.overNetwork === true;
  const limiter = new AdaptiveConcurrency(clampWorkers(maxWorkers));
  let deviceGone: unknown = null;
  /** Set when an unplugged device did not come back: thrown once, at the end. */
  let unplugged: unknown = null;
  /** Cancelled while waiting for an unplugged device: stop quietly. */
  let stopped = false;

  const doCopy = async (job: CopyJob): Promise<CopyProgress> => {
    // Progress is reported per attempt as a running total; turning it into
    // deltas here is what lets several copies in flight share one counter.
    let reported = 0;
    let size: number | undefined;
    try {
      size = (await fsp.stat(job.src)).size;
    } catch {
      /* the copy itself will report what went wrong */
    }
    const startedAt = Date.now();
    startCallback?.(job.src, size ?? null);
    if (adaptive) {
      devLog(
        "copy",
        () =>
          `start ${path.basename(job.src)} (${size ?? "?"} B), ` +
          // By now `start()` has added this task to `running`.
          `${running.size} in flight of limit ${limiter.limit}`
      );
    }
    const copyOpts: CopyOptions = {
      onProgress: (bytes, total) => {
        if (total !== null) size = total;
        if (bytes > reported) {
          bytesCallback?.(bytes - reported, job.src, bytes, size ?? null);
          reported = bytes;
        }
      },
    };
    for (;;) {
    try {
      const ok = await withTransientRetry(
        () => {
          reported = 0;
          return copyFileToDevice(deviceFs, job.src, job.dest, copyOpts);
        },
        {
          signal: cancelSignal,
          onRetry: (attempt, err, delayMs) => {
            if (adaptive) limiter.onTransientFailure();
            const error = (err as Error)?.message ?? String(err);
            logCallback?.(
              `Retrying ${path.basename(job.src)} in ${Math.round(delayMs / 1000)}s ` +
                `(attempt ${attempt + 1}): ${error}`
            );
            retryCallback?.({ srcPath: job.src, attempt, error, delayMs });
          },
        }
      );
      if (adaptive) limiter.onSuccess();
      // A finished copy accounts for every byte of it. Progress is advisory —
      // frames the browser sent while its socket was down are not replayed —
      // and a direct copy is exactly the size of its source.
      if (size === undefined) {
        try {
          size = (await fsp.stat(job.src)).size;
        } catch {
          size = reported;
        }
      }
      if (size > reported) {
        bytesCallback?.(size - reported, job.src, size, size);
        reported = size;
      }
      if (adaptive) {
        devLog(
          "copy",
          () =>
            `done ${path.basename(job.src)} (${size} B) in ${Date.now() - startedAt} ms` +
            (ok ? "" : " — skipped")
        );
      }
      return {
        srcPath: job.src,
        destPath: job.dest,
        status: ok ? "copied" : "skipped",
        bytes: size,
      };
    } catch (err) {
      if (isDeviceGone(err)) {
        deviceGone = err;
        return { srcPath: job.src, destPath: job.dest, status: "error" };
      }
      // Not this file's fault if the device itself has gone: wait for it,
      // then try the same file again. Nothing is recorded as an error.
      if (presence && !cancelSignal?.aborted && (await presence.isGone(probePath))) {
        const outcome = await waitOutUnplug(job);
        if (outcome === "retry") continue;
        return { srcPath: job.src, destPath: job.dest, status: "error" };
      }
      if (adaptive && isTransientDeviceError(err)) limiter.onTransientFailure();
      const msg = String(err);
      if (adaptive) {
        devLog("copy", () => `failed ${path.basename(job.src)} after ${Date.now() - startedAt} ms: ${msg}`);
      }
      appendSyncError(job.src, job.dest, msg);
      logCallback?.(`Failed to copy ${path.basename(job.src)}: ${msg}`);
      return { srcPath: job.src, destPath: job.dest, status: "error" };
    }
    }
  };

  /** Waits for an unplugged device. "retry" when it is back; "stop" otherwise. */
  const waitOutUnplug = async (job: CopyJob): Promise<"retry" | "stop"> => {
    try {
      await presence!.waitForReturn(probePath);
    } catch (err) {
      if (isDeviceUnplugged(err)) unplugged = err;
      else stopped = true;
      return "stop";
    }
    // An interrupted browser write leaves `<name>.crswap` beside the file.
    if (deviceFs.capabilities.overNetwork) {
      try {
        await deviceFs.unlink(`${job.dest}.crswap`);
      } catch {
        /* usually not there */
      }
    }
    return "retry";
  };

  let nextIndex = 0;
  const running = new Set<Promise<void>>();

  const start = (job: CopyJob): void => {
    const task = doCopy(job).then((result) => {
      running.delete(task);
      if (deviceGone || unplugged || stopped) return;
      if (result.status === "error") {
        logCallback?.(`Failed to copy ${path.basename(result.srcPath)}`);
      }
      progressCallback?.(result);
    });
    running.add(task);
  };

  while (nextIndex < jobs.length || running.size > 0) {
    while (
      nextIndex < jobs.length &&
      running.size < limiter.limit &&
      !cancelSignal?.aborted &&
      !deviceGone &&
      !unplugged &&
      !stopped
    ) {
      start(jobs[nextIndex++]);
    }
    if (running.size === 0) break;
    await Promise.race(running);
  }

  if (deviceGone) throw new DeviceGoneError(deviceGone);
  if (unplugged) throw unplugged;
}

/** The configured worker count, within 1..{@link MAX_COPY_WORKERS}. */
function clampWorkers(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return MAX_COPY_WORKERS;
  return Math.max(1, Math.min(MAX_COPY_WORKERS, Math.floor(n)));
}

/**
 * Ensures `dest` is under `folder`. If it escapes (via `..` segments or an
 * absolute custom path), falls back to placing the source basename directly
 * inside `folder`. This prevents path-traversal writes to arbitrary locations.
 */
/**
 * The same guard against an explicit path flavour, so it can be tested on a
 * host of the other kind.
 *
 * Exported for that test alone, and it is worth having: this function falling
 * through is the single most expensive failure in the sync. It does not return
 * an error — it quietly returns `folder/basename`, so the whole library
 * flattens into `Music/`, the runtime matcher goes ambiguous across thousands
 * of keys, and the next sync reports every track as missing. A web device's
 * synthetic root is host-flavoured precisely so this arithmetic keeps working
 * unchanged on Windows.
 */
export function containUnderFolderOn(
  dest: string,
  folder: string,
  srcPath: string,
  impl: typeof path = path
): string {
  const resolvedDest = impl.resolve(dest);
  const resolvedFolder = impl.resolve(folder);
  if (
    resolvedDest === resolvedFolder ||
    resolvedDest.startsWith(resolvedFolder + impl.sep)
  ) {
    return resolvedDest;
  }
  return impl.join(resolvedFolder, impl.basename(srcPath));
}

function containUnderFolder(dest: string, folder: string, srcPath: string): string {
  return containUnderFolderOn(dest, folder, srcPath);
}

function getDestinationPath(src: string, deviceFolder: string): string {
  const parts = src.replace(/\\/g, "/").split("/");
  const musicIndicators = ["Music", "music", "MUSIC", "Audio", "audio", "AUDIO"];

  const libRootIndex = parts.findIndex((p) => musicIndicators.includes(p));
  if (libRootIndex >= 0) {
    const relativeParts = parts.slice(libRootIndex + 1).filter((p) => p.trim());
    if (relativeParts.length > 0) {
      const filename = relativeParts[relativeParts.length - 1];
      const folders = relativeParts.slice(0, -1);
      const candidate = path.join(deviceFolder, ...folders, filename);
      return containUnderFolder(candidate, deviceFolder, src);
    }
  }
  return path.join(deviceFolder, path.basename(src));
}
