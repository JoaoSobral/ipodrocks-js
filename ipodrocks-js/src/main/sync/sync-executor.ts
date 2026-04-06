import * as fs from "fs";
import * as path from "path";

import { ConversionSettings, convertWithCodec, convertWithFfmpeg, updateExtension } from "./sync-conversion";
import { appendSyncError } from "./sync-error-log";

const MAX_COPY_WORKERS = 4;

export type CopyStatus = "copied" | "converted" | "error" | "missing" | "skipped";

export interface CopyProgress {
  srcPath: string;
  destPath: string | null;
  status: CopyStatus;
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
}

export async function copyFileToDevice(src: string, dest: string): Promise<boolean> {
  const destDir = path.dirname(dest);
  await fs.promises.mkdir(destDir, { recursive: true });

  try {
    await fs.promises.copyFile(src, dest);

    try {
      const srcStat = await fs.promises.stat(src);
      await fs.promises.utimes(dest, srcStat.atime, srcStat.mtime);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM") {
        try {
          const [destStat, srcStat] = await Promise.all([
            fs.promises.stat(dest),
            fs.promises.stat(src),
          ]);
          if (destStat.size === srcStat.size) return true;
        } catch { /* fall through */ }
      }
      throw err;
    }
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") {
      try {
        const [destStat, srcStat] = await Promise.all([
          fs.promises.stat(dest),
          fs.promises.stat(src),
        ]);
        if (destStat.size === srcStat.size) return true;
      } catch { /* fall through */ }
    }
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
  } = options;

  await fs.promises.mkdir(deviceFolder, { recursive: true });

  const copyJobs: CopyJob[] = [];
  const convertJobs: ConvertJob[] = [];

  for (const srcPath of trackPaths) {
    if (cancelSignal?.aborted) return;

    if (!fs.existsSync(srcPath)) {
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
      copyJobs.push({ src: srcPath, dest });
      continue;
    }

    const hasCodec = conversionSettings != null && "codec" in conversionSettings;
    convertJobs.push({ src: srcPath, dest, hasCodec, settings: conversionSettings, profile });
  }

  if (copyJobs.length > 0) {
    await runParallelCopies(copyJobs, { progressCallback, logCallback, cancelSignal });
  }

  for (const job of convertJobs) {
    if (cancelSignal?.aborted) return;

    const conversionLog: string[] = [];
    const logWithCapture = (line: string): void => {
      conversionLog.push(line);
      logCallback?.(line);
    };

    if (job.hasCodec && job.settings) {
      const dest = updateExtension(job.dest, job.settings.codec!);
      try {
        const success = await convertWithCodec(job.src, dest, job.settings, logWithCapture, cancelSignal);
        if (!success) {
          appendSyncError(job.src, dest, "Conversion failed", conversionLog);
          progressCallback?.({ srcPath: job.src, destPath: dest, status: "error" });
        } else {
          progressCallback?.({ srcPath: job.src, destPath: dest, status: "converted" });
        }
      } catch (err) {
        const msg = String(err);
        appendSyncError(job.src, dest, msg, conversionLog);
        logCallback?.(`Failed to convert ${path.basename(job.src)}: ${msg}`);
        progressCallback?.({ srcPath: job.src, destPath: dest, status: "error" });
      }
    } else {
      try {
        await convertWithFfmpeg(job.src, job.dest, job.profile, logWithCapture, cancelSignal);
        progressCallback?.({ srcPath: job.src, destPath: job.dest, status: "converted" });
      } catch (err) {
        const msg = String(err);
        appendSyncError(job.src, job.dest, msg, conversionLog);
        logCallback?.(`Failed to convert ${path.basename(job.src)}: ${msg}`);
        progressCallback?.({ srcPath: job.src, destPath: job.dest, status: "error" });
      }
    }
  }
}

async function runParallelCopies(
  jobs: CopyJob[],
  opts: {
    progressCallback?: (progress: CopyProgress) => void;
    logCallback?: (line: string) => void;
    cancelSignal?: AbortSignal;
  }
): Promise<void> {
  const { progressCallback, logCallback, cancelSignal } = opts;

  const doCopy = async (job: CopyJob): Promise<CopyProgress> => {
    try {
      const ok = await copyFileToDevice(job.src, job.dest);
      return { srcPath: job.src, destPath: job.dest, status: ok ? "copied" : "skipped" };
    } catch (err) {
      const msg = String(err);
      appendSyncError(job.src, job.dest, msg);
      logCallback?.(`Failed to copy ${path.basename(job.src)}: ${msg}`);
      return { srcPath: job.src, destPath: job.dest, status: "error" };
    }
  };

  const concurrency = Math.min(jobs.length, MAX_COPY_WORKERS);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < jobs.length) {
      if (cancelSignal?.aborted) return;
      const idx = nextIndex++;
      if (idx >= jobs.length) return;
      const result = await doCopy(jobs[idx]);
      if (result.status === "error") {
        logCallback?.(`Failed to copy ${path.basename(result.srcPath)}`);
      } else {
        logCallback?.(`Copied: ${path.basename(result.srcPath)}`);
      }
      progressCallback?.(result);
    }
  };

  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
}

/**
 * Ensures `dest` is under `folder`. If it escapes (via `..` segments or an
 * absolute custom path), falls back to placing the source basename directly
 * inside `folder`. This prevents path-traversal writes to arbitrary locations.
 */
function containUnderFolder(dest: string, folder: string, srcPath: string): string {
  const resolvedDest = path.resolve(dest);
  const resolvedFolder = path.resolve(folder);
  if (
    resolvedDest === resolvedFolder ||
    resolvedDest.startsWith(resolvedFolder + path.sep)
  ) {
    return resolvedDest;
  }
  return path.join(resolvedFolder, path.basename(srcPath));
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
