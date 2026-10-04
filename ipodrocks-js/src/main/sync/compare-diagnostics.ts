/**
 * Explains a library-vs-device comparison to the developer log.
 *
 * `compareLibraries()` answers with counts, and a count cannot tell "the file
 * is not on the device" from "the file is there and was refused on size" — the
 * difference between a sync that has never run and one that re-copies the
 * library forever. This re-derives, for a sample of the tracks it wants to
 * copy, what was at the expected path and why it did not count.
 *
 * Diagnostics only: nothing here decides anything, and it runs only while
 * `IPODROCKS_DEV_LOGS=1`.
 */
import { devLog, isDevLogEnabled } from "../utils/dev-log";
import { SIZE_TOLERANCE, type CompareResult } from "./name-size-sync";

const SAMPLE = 10;

interface DeviceFileStats {
  file_size: number;
  mtime?: number;
}

export interface CompareDiagnosticsInput {
  /** "check" or "sync", plus the content type — the log line's scope. */
  label: string;
  destMap: Record<string, string>;
  expectedSizes: Record<string, number>;
  expectedMtimes: Record<string, number>;
  deviceContentPath: string;
  deviceFilesMap: Record<string, DeviceFileStats>;
  result: Pick<CompareResult, "missingTracks" | "tracksToSkip" | "extras" | "codecMismatchPaths">;
  profileCodecExt: string | null;
}

function relUnder(devicePath: string, contentPath: string): string | null {
  const d = devicePath.replace(/\\/g, "/");
  const c = contentPath.replace(/\\/g, "/").replace(/\/$/, "");
  return d.startsWith(c + "/") ? d.slice(c.length + 1) : null;
}

/** The same folding the compare's exact tier uses, near enough to explain it. */
function fold(rel: string): string {
  return rel.normalize("NFC").toLowerCase();
}

function stem(rel: string): string {
  const dot = rel.lastIndexOf(".");
  const slash = rel.lastIndexOf("/");
  return fold(dot > slash ? rel.slice(0, dot) : rel);
}

function fmtTime(ms: number | undefined): string {
  return ms == null ? "none" : new Date(ms).toISOString();
}

export function logCompareDiagnostics(input: CompareDiagnosticsInput): void {
  if (!isDevLogEnabled()) return;
  const {
    label,
    destMap,
    expectedSizes,
    expectedMtimes,
    deviceContentPath,
    deviceFilesMap,
    result,
    profileCodecExt,
  } = input;

  const deviceEntries = Object.entries(deviceFilesMap);
  const outside = deviceEntries.filter(([p]) => relUnder(p, deviceContentPath) === null);

  devLog(
    label,
    `library ${Object.keys(destMap).length}, device ${deviceEntries.length} audio file(s) ` +
      `under ${deviceContentPath} → synced ${result.tracksToSkip.length}, ` +
      `to sync ${result.missingTracks.size}, codec mismatch ${result.codecMismatchPaths.length}, ` +
      `orphans ${result.extras.length}; profile ext ${profileCodecExt ?? "(direct copy)"}`
  );

  if (outside.length > 0) {
    // Every one of these is invisible to the compare: neither matched nor an
    // orphan. A path-flavour or folder-spelling mismatch shows up here.
    devLog(
      label,
      () =>
        `${outside.length} device path(s) are not under the content folder and were ignored, e.g. ` +
        outside.slice(0, 3).map(([p]) => JSON.stringify(p)).join(", ")
    );
  }

  if (result.missingTracks.size === 0) return;

  const byRel = new Map<string, [string, DeviceFileStats]>();
  const byStem = new Map<string, [string, DeviceFileStats]>();
  for (const [p, stats] of deviceEntries) {
    const rel = relUnder(p, deviceContentPath);
    if (rel === null) continue;
    byRel.set(fold(rel), [p, stats]);
    byStem.set(stem(rel), [p, stats]);
  }

  const reasons = new Map<string, number>();
  const samples: string[] = [];
  for (const libPath of result.missingTracks) {
    const rel = destMap[libPath];
    if (rel === undefined) continue;
    const expectedSize = expectedSizes[libPath] ?? 0;
    const libMtime = expectedMtimes[libPath];
    const hit = byRel.get(fold(rel)) ?? byStem.get(stem(rel));

    let reason: string;
    let detail: string;
    if (!hit) {
      reason = "not on device";
      detail = `expected at ${JSON.stringify(rel)}`;
    } else {
      const [devPath, stats] = hit;
      const sizeOk = expectedSize > 0 && Math.abs(stats.file_size - expectedSize) <= SIZE_TOLERANCE;
      const delta =
        libMtime != null && stats.mtime != null ? Math.round(stats.mtime - libMtime) : null;
      if (expectedSize > 0 && !sizeOk) {
        reason = "found, size differs";
      } else if (expectedSize === 0) {
        reason = "found, lossy profile and library newer than device";
      } else {
        // Size matches, so the compare refused it on something else — most
        // often the extension (a codec mismatch it will re-encode).
        reason = "found, size matches but not accepted";
      }
      detail =
        `device ${JSON.stringify(relUnder(devPath, deviceContentPath))} ` +
        `size ${stats.file_size} vs expected ${expectedSize}; ` +
        `mtime device ${fmtTime(stats.mtime)} vs library ${fmtTime(libMtime)}` +
        (delta === null ? "" : ` (device ${delta >= 0 ? "+" : ""}${delta} ms)`);
    }
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    if (samples.length < SAMPLE) samples.push(`${reason}: ${libPath} → ${detail}`);
  }

  devLog(
    label,
    `to-sync reasons: ` +
      [...reasons].map(([r, n]) => `${r} ×${n}`).join(", ")
  );
  for (const s of samples) devLog(label, s);

  if (result.extras.length > 0) {
    devLog(
      label,
      () =>
        `orphans, e.g. ` +
        result.extras
          .slice(0, 5)
          .map((p) => JSON.stringify(relUnder(p, deviceContentPath) ?? p))
          .join(", ")
    );
  }
}
