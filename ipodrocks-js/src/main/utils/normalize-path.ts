/**
 * Unicode path normalization for library paths.
 *
 * Filesystems and network shares (SMB/SAMBA in particular, and macOS) can
 * present the same filename in different Unicode normalization forms — NFC
 * (composed, e.g. "é") vs NFD (decomposed, "e" + combining accent). SQLite
 * treats the two byte sequences as distinct strings, so comparing a freshly
 * read `readdir` path against a stored path byte-for-byte can miss, causing the
 * scanner to constantly re-add/re-remove the same files ("did not want to read
 * those files"). We pick NFC as the canonical form for every path stored in or
 * looked up from the database — matching the existing choice in
 * `sync/name-size-sync.ts`.
 *
 * IMPORTANT: the NFC form is used only as the database/comparison KEY. Actual
 * filesystem I/O must use the path exactly as the OS returned it, because on
 * normalization-sensitive filesystems (ext4, some SMB servers) only the
 * on-disk form resolves. Use `findOnDisk` when reading back a stored path.
 */
import fs from "fs";

/** Canonical NFC form used as the identity for DB-stored library paths. */
export function normalizePath(p: string): string {
  return p.normalize("NFC");
}

/**
 * Resolve a stored (NFC) path to a form that exists on disk. On
 * normalization-insensitive filesystems (APFS/HFS+) the NFC path resolves
 * directly; on sensitive ones the on-disk name may be NFD, so fall back to the
 * decomposed variant. Returns the original path if neither exists (caller then
 * surfaces the ENOENT as usual).
 */
export function findOnDisk(p: string): string {
  try {
    if (fs.existsSync(p)) return p;
  } catch {
    /* fall through */
  }
  const nfd = p.normalize("NFD");
  if (nfd !== p) {
    try {
      if (fs.existsSync(nfd)) return nfd;
    } catch {
      /* fall through */
    }
  }
  return p;
}
