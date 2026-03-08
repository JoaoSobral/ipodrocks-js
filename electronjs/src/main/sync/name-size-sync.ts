import * as path from "path";

/** Bytes: allow device/filesystem size differences (e.g. padding, metadata) without re-sync. */
export const SIZE_TOLERANCE = 128;

/** Ms: consider mtime equal within this (e.g. FAT32 has 2s resolution). */
export const MTIME_TOLERANCE_MS = 2500;

export interface DeviceFileStats {
  file_size: number;
  mtime?: number;
}

export interface SkippedTrack {
  library_path: string;
  device_path: string;
  reason: string;
}

export interface CompareResult {
  missingTracks: Set<string>;
  tracksToSkip: SkippedTrack[];
  extras: string[];
  codecMismatchPaths: string[];
}

export interface CompareOptions {
  cancelCallback?: () => boolean;
  profileCodecExt?: string | null;
  progressCallback?: (current: number, total: number) => void;
  debugCallback?: (message: string) => void;
  /** Library path -> mtime in ms; skip if device mtime matches within MTIME_TOLERANCE_MS. */
  libraryExpectedMtimes?: Record<string, number>;
}

/**
 * Canonicalize path segment for matching: normalize characters that often
 * differ between device paths and library metadata (smart quotes, ligatures,
 * hyphen/underscore/space), then collapse separator runs so "Play The" and
 * "Play_ The" match.
 */
function canonicalizePathSegment(segment: string): string {
  return segment
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'") // curly apostrophes → ASCII
    .replace(/\u201C|\u201D|\u201E|\u2033/g, '"')
    .replace(/_/g, "-")
    .replace(/[\u2013\u2014\u2015]/g, "-") // en/em dash → hyphen
    .replace(/\u00C6/g, "AE")
    .replace(/\u00E6/g, "ae")
    .replace(/\u00D8/g, "O")
    .replace(/\u00F8/g, "o")
    .replace(/\u0152/g, "OE")
    .replace(/\u0153/g, "oe")
    .replace(/[\s\-]+/g, "-") // collapse space/hyphen runs so "Play The" ≈ "Play_ The"
    .replace(/^-+|-+$/g, "") // trim leading/trailing hyphens from collapse
    .normalize("NFC")
    .toLowerCase();
}

function normalizeKey(s: string): string {
  const out = canonicalizePathSegment(s);
  return out || "_";
}

function normalizeRelPathForMatch(relPath: string): string {
  const parts = relPath.replace(/\\/g, "/").split("/");
  const normalized: string[] = [];
  for (const p of parts) {
    const stripped = p.replace(/^[\s.]+|[\s.]+$/g, "");
    normalized.push(stripped ? normalizeKey(stripped) : "_");
  }
  return normalized.join("/");
}

function pathStemKey(relPath: string): string {
  const parsed = path.posix.parse(relPath.replace(/\\/g, "/"));
  const stemPath = parsed.dir ? `${parsed.dir}/${parsed.name}` : parsed.name;
  return normalizeRelPathForMatch(stemPath);
}

function extOf(filePath: string): string {
  return path.posix.extname(filePath.replace(/\\/g, "/"));
}

function relativeFromDevice(
  devicePath: string,
  deviceContentPath: string
): string | null {
  const normDevice = devicePath.replace(/\\/g, "/");
  const normContent = deviceContentPath.replace(/\\/g, "/").replace(/\/$/, "");
  if (!normDevice.startsWith(normContent + "/")) return null;
  return normDevice.slice(normContent.length + 1);
}

export function compareLibraries(
  libraryDestMap: Record<string, string>,
  libraryExpectedSizes: Record<string, number>,
  deviceContentPath: string,
  deviceFilesMap: Record<string, DeviceFileStats>,
  options: CompareOptions = {}
): CompareResult {
  const {
    cancelCallback,
    profileCodecExt,
    progressCallback,
    debugCallback,
    libraryExpectedMtimes = {},
  } = options;

  // Build device lookups
  const deviceByRel = new Map<string, [string, number]>();
  const deviceByRelNorm = new Map<string, [string, number, string]>();
  const deviceByStem = new Map<string, [string, number, string][]>();

  const deviceEntries = Object.entries(deviceFilesMap);
  for (let i = 0; i < deviceEntries.length; i++) {
    if (cancelCallback && i % 500 === 499 && cancelCallback()) {
      throw new Error("Cancelled");
    }
    const [devicePath, stats] = deviceEntries[i];
    const relStr = relativeFromDevice(devicePath, deviceContentPath);
    if (relStr === null) continue;

    const size = stats.file_size ?? 0;
    deviceByRel.set(relStr, [devicePath, size]);

    const relNorm = normalizeRelPathForMatch(relStr);
    deviceByRelNorm.set(relNorm, [devicePath, size, relStr]);

    const stemKey = pathStemKey(relStr);
    if (!deviceByStem.has(stemKey)) {
      deviceByStem.set(stemKey, []);
    }
    deviceByStem.get(stemKey)!.push([devicePath, size, relStr]);
  }

  const missingTracks = new Set<string>();
  const tracksToSkip: SkippedTrack[] = [];
  const matchedDevicePaths = new Set<string>();
  const codecMismatchPaths: string[] = [];

  const profileExtNorm = profileCodecExt
    ? normalizeKey(profileCodecExt)
    : null;

  const libEntries = Object.entries(libraryDestMap);
  const totalLib = libEntries.length;
  if (progressCallback && totalLib > 0) progressCallback(0, totalLib);

  for (let i = 0; i < libEntries.length; i++) {
    if (cancelCallback && i % 200 === 199 && cancelCallback()) {
      throw new Error("Cancelled");
    }
    if (progressCallback && i % 200 === 0 && totalLib > 0) {
      progressCallback(i + 1, totalLib);
    }

    const [libPath, relPath] = libEntries[i];
    const expectedSize = libraryExpectedSizes[libPath] ?? 0;
    const relPathNorm = normalizeRelPathForMatch(relPath);
    const stemKey = pathStemKey(relPath);

    let matched = false;
    let devicePath: string | null = null;
    let deviceSize = 0;
    let skipNotOverwrite = false;

    // Rule 2: Exact path match (codec match)
    const normEntry = deviceByRelNorm.get(relPathNorm);
    if (normEntry) {
      [devicePath, deviceSize] = normEntry;
      const deviceExtNorm = normalizeKey(extOf(devicePath));

      if (profileExtNorm === null || deviceExtNorm === profileExtNorm) {
        matched = true;
        if (expectedSize > 0) {
          if (Math.abs(deviceSize - expectedSize) <= SIZE_TOLERANCE) {
            skipNotOverwrite = true;
          }
        }
        if (!skipNotOverwrite) {
          const libMtime = libraryExpectedMtimes[libPath];
          const devStats = devicePath ? deviceFilesMap[devicePath] : undefined;
          const devMtime = devStats?.mtime;
          if (
            libMtime != null &&
            devMtime != null &&
            Math.abs(devMtime - libMtime) <= MTIME_TOLERANCE_MS
          ) {
            skipNotOverwrite = true;
          }
        }
        if (expectedSize === 0 && !skipNotOverwrite) {
          skipNotOverwrite = true;
        }
      }
    }

    // Rule 1: Stem match for codec mismatch (old format on device)
    if (!matched) {
      const stemEntries = deviceByStem.get(stemKey);
      if (stemEntries) {
        const libDestExtNorm = normalizeKey(extOf(relPath));
        for (const [dp] of stemEntries) {
          const devExtNorm = normalizeKey(extOf(dp));
          if (devExtNorm !== libDestExtNorm) {
            devicePath = dp;
            matched = true;
            skipNotOverwrite = false;
            break;
          }
        }
      }
    }

    if (matched && devicePath) {
      matchedDevicePaths.add(devicePath);

      // Mark other device files with same stem but different ext as matched
      if (profileExtNorm) {
        const stemEntries = deviceByStem.get(stemKey);
        if (stemEntries) {
          const libDestExt = normalizeKey(extOf(relPath));
          for (const [dp] of stemEntries) {
            const dpExt = normalizeKey(extOf(dp));
            if (dpExt !== libDestExt) {
              matchedDevicePaths.add(dp);
              if (!codecMismatchPaths.includes(dp)) {
                codecMismatchPaths.push(dp);
              }
            }
          }
        }
      }

      if (skipNotOverwrite) {
        tracksToSkip.push({
          library_path: libPath,
          device_path: devicePath,
          reason: "name_size_match",
        });
      } else {
        missingTracks.add(libPath);
        if (debugCallback) {
          debugCallback(
            `[SYNC-DIAG] RESYNC (matched but not skipped): ${path.basename(libPath)}\n` +
              `  lib_path:      ${libPath}\n` +
              `  rel_path:      ${relPath}\n` +
              `  norm_key:      ${relPathNorm}\n` +
              `  device_path:   ${devicePath}\n` +
              `  expected_size: ${expectedSize}\n` +
              `  device_size:   ${deviceSize}\n` +
              `  size_diff:     ${Math.abs(deviceSize - expectedSize)}\n` +
              `  profile_ext:   ${profileExtNorm}\n` +
              `  device_ext:    ${normalizeKey(extOf(devicePath))}`
          );
        }
      }
    } else {
      missingTracks.add(libPath);
      if (debugCallback) {
        const fnameLower = path.basename(relPath).toLowerCase();
        const close: string[] = [];
        for (const [r, [dp, sz]] of deviceByRel) {
          if (path.basename(r).toLowerCase() === fnameLower) {
            close.push(`    ${r} (size=${sz})`);
            if (close.length >= 5) break;
          }
        }
        debugCallback(
          `[SYNC-DIAG] MISSING (no path match): ${path.basename(libPath)}\n` +
            `  lib_path:      ${libPath}\n` +
            `  rel_path:      ${relPath}\n` +
            `  norm_key:      ${relPathNorm}\n` +
            `  expected_size: ${expectedSize}\n` +
            `  stem_key:      ${stemKey}\n` +
            `  Same filename on device:\n${close.length ? close.join("\n") : "    (none)"}`
        );
      }
    }
  }

  if (progressCallback && totalLib > 0) progressCallback(totalLib, totalLib);

  const libraryNormKeys = new Set<string>();
  for (const relPath of Object.values(libraryDestMap)) {
    libraryNormKeys.add(normalizeRelPathForMatch(relPath));
  }

  const extras: string[] = [];
  for (const [relStr, [dp]] of deviceByRel) {
    if (!matchedDevicePaths.has(dp)) {
      extras.push(dp);
      if (debugCallback) {
        const relNorm = normalizeRelPathForMatch(relStr);
        const inLibrary = libraryNormKeys.has(relNorm);
        const fname = path.basename(relStr).toLowerCase();
        const sameNameInLibrary: string[] = [];
        for (const libRel of Object.values(libraryDestMap)) {
          if (path.basename(libRel).toLowerCase() === fname) {
            sameNameInLibrary.push(libRel);
            if (sameNameInLibrary.length >= 3) break;
          }
        }
        debugCallback(
          `[ORPHAN-DIAG] ${path.basename(dp)}\n` +
            `  device_rel:   ${relStr}\n` +
            `  norm_key:     ${relNorm}\n` +
            `  in_library:   ${inLibrary}\n` +
            (sameNameInLibrary.length > 0
              ? `  same_filename_in_library: ${sameNameInLibrary.join(" | ")}\n` +
                `  note:         likely same track; path differs by apostrophe/hyphen/ligature (device vs library metadata). Re-sync to match.\n`
              : "  (no library track with same filename)\n")
        );
      }
    }
  }

  return {
    missingTracks,
    tracksToSkip,
    extras: extras.sort(),
    codecMismatchPaths: codecMismatchPaths.sort(),
  };
}

export function getSyncSummary(
  missingTracks: Set<string>,
  tracksToSkip: SkippedTrack[],
  extras: string[]
): { tracksToSync: number; tracksToSkip: number; extras: number; totalLibrary: number } {
  return {
    tracksToSync: missingTracks.size,
    tracksToSkip: tracksToSkip.length,
    extras: extras.length,
    totalLibrary: missingTracks.size + tracksToSkip.length,
  };
}
