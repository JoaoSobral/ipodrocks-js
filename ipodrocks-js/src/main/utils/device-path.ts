import * as path from "path";

/**
 * How a library track's path is spelled once it lands on the device.
 *
 * These are pure string/path functions with no filesystem access, extracted
 * from ``sync/sync-core`` so that the runtime-data matcher can build its
 * lookup keys with *the same* code that writes the files. Deriving the device
 * layout twice is what let issue #117 happen: the matcher rebuilt keys from
 * raw tag values while the sync layer sanitized them, so any track whose
 * artist or title held a FAT-invalid character could never be matched back.
 *
 * ``sync-core`` re-exports both functions, so existing importers are unchanged.
 */

/** Characters FAT32 refuses in a path component. */
const FAT32_INVALID = /[\\/:*?"<>|]/g;

/**
 * The subset of Node's `path` API that {@link folderRelativePath} needs. Lets
 * tests inject `path.win32` so Windows drive-root behaviour (issue #112) can be
 * asserted from POSIX CI.
 */
export type PathFlavor = Pick<
  typeof path,
  "resolve" | "relative" | "isAbsolute" | "basename"
>;

export function sanitizeDevicePathComponent(
  component: string,
  maxLen = 255
): string {
  if (!component) return "_";
  let out = component.replace(FAT32_INVALID, "_");
  out = out.replace(/^[\s.]+|[\s.]+$/g, "");
  if (!out) return "_";
  return out.length > maxLen ? out.slice(0, maxLen) : out;
}

/**
 * Build a device-relative path that mirrors the source library folder structure
 * (relative to the library root), preserving album folder names exactly (incl.
 * the year and parentheses). Returns null when the track does not resolve under
 * a known library folder, so callers can fall back to a tag-based path.
 *
 * Issue #112: containment is computed with `path.relative` rather than a
 * `startsWith(base + sep)` test. When the library root is a filesystem root the
 * resolved base already ends in a separator ("M:\\", "/"), so the old test
 * compared against a doubled separator, never matched, and mirroring silently
 * fell back to tag-based paths. `pathImpl` is injectable so Windows drive-root
 * behaviour can be regression-tested from POSIX CI with `path.win32`.
 */
export function folderRelativePath(
  trackPath: string,
  contentType: string,
  libraryFolderPaths?: Map<number, string>,
  folderId?: number,
  pathImpl: PathFlavor = path
): string | null {
  if (folderId == null || !libraryFolderPaths) return null;
  const basePath = libraryFolderPaths.get(folderId);
  if (!basePath) return null;

  const resolved = pathImpl.resolve(trackPath);
  const baseResolved = pathImpl.resolve(basePath);
  const relRaw = pathImpl.relative(baseResolved, resolved);
  if (!relRaw || relRaw.startsWith("..") || pathImpl.isAbsolute(relRaw)) {
    return null;
  }

  const rel = relRaw.replace(/\\/g, "/");
  const filename = pathImpl.basename(trackPath);
  const parts = rel.split("/");
  const folderNames =
    contentType === "music"
      ? ["Music", "music", "MUSIC"]
      : contentType === "audiobook"
        ? ["Audiobooks", "audiobooks", "AUDIOBOOKS", "Audiobook", "audiobook"]
        : ["Podcasts", "podcasts", "PODCASTS", "Podcast", "podcast"];

  if (parts.length > 1 && folderNames.includes(parts[0])) {
    const safeParts = parts.slice(1).map((p) => sanitizeDevicePathComponent(p));
    return safeParts.join("/");
  }
  if (parts.length === 1 && folderNames.includes(parts[0])) {
    return sanitizeDevicePathComponent(filename);
  }

  if (parts.length <= 2) {
    // Issue #112: a filesystem/drive root ("M:\\", "/") has an empty basename,
    // which would sanitize to "_" and inject a junk folder. Skip the prepend.
    const baseName = pathImpl.basename(baseResolved);
    if (baseName && !folderNames.includes(baseName)) {
      return path.posix.join(
        sanitizeDevicePathComponent(baseName),
        ...parts.map((p) => sanitizeDevicePathComponent(p))
      );
    }
  }
  return parts.map((p) => sanitizeDevicePathComponent(p)).join("/");
}
