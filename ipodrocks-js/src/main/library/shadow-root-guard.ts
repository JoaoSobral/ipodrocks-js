import fs from "fs";
import path from "path";
import type Database from "better-sqlite3";

import { getUserDataPath } from "../host";
import { getAllowedPathPrefixes } from "../path-allowlist";
import { getAudiobooksRoot } from "../audiobooks/audiobook-storage";
import { getDefaultPodcastsRoot, getPodcastsRoot } from "../podcasts/podcast-storage";

/**
 * A folder a shadow library root must stay clear of.
 *
 * `overlap` refuses equal, ancestor and descendant alike: a shadow root that
 * contains a library folder hands every original to the prune as an "orphan",
 * and one inside it does the same to a single album. `contains` refuses only a
 * root that is the folder or sits above it — an allowed root such as `$HOME`
 * is fine to build *under*, never *as*.
 */
export interface ProtectedRoot {
  path: string;
  label: string;
  rule: "overlap" | "contains";
}

/**
 * Resolve symlinks as far as the path exists, then re-append the rest. A
 * shadow root is created on demand, so its tail may not exist yet — and
 * comparing an unresolved tail against a resolved library folder is exactly the
 * mismatch that would let a symlinked spelling slip past.
 */
function canonical(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    const parent = path.dirname(resolved);
    if (parent === resolved) return resolved;
    return path.join(canonical(parent), path.basename(resolved));
  }
}

/**
 * The comparison key. macOS and Windows filesystems are case-insensitive by
 * default, so `~/music` and `~/Music` are one folder there; folding case can
 * only ever over-refuse on a case-sensitive volume, which is the safe side.
 */
function key(p: string, platform: NodeJS.Platform): string {
  const c = canonical(p);
  return platform === "darwin" || platform === "win32" ? c.toLowerCase() : c;
}

function isInside(child: string, parent: string): boolean {
  const withSep = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(withSep);
}

/**
 * Why `root` may not be used as a shadow library root, or null when it may.
 *
 * Every destructive shadow operation — the build (which writes
 * `join(root, <library-relative path>)` and can land on an original), the
 * orphan prune (which deletes every audio file under the root it cannot
 * account for), and the delete-with-files — trusts the root as space the app
 * owns. That trust is only sound for a folder that holds nothing else of the
 * user's, so this is checked at `shadow:create` *and* again before each of
 * those operations, which covers a row created before the check existed.
 */
export function findShadowRootConflict(
  root: string,
  protectedRoots: ProtectedRoot[],
  platform: NodeJS.Platform = process.platform
): string | null {
  const r = key(root, platform);
  if (path.parse(r).root === r) {
    return "A shadow library cannot be the root of a drive — choose a folder of its own.";
  }
  for (const p of protectedRoots) {
    if (!p.path) continue;
    const k = key(p.path, platform);
    if (r === k) {
      return `This folder is ${p.label} — a shadow library needs a dedicated folder of its own.`;
    }
    if (isInside(k, r)) {
      return `This folder contains ${p.label} — a shadow library needs a dedicated folder of its own.`;
    }
    if (p.rule === "overlap" && isInside(r, k)) {
      return `This folder is inside ${p.label} — a shadow library needs a dedicated folder of its own.`;
    }
  }
  return null;
}

/**
 * Everything a shadow root must stay clear of: every configured library
 * folder, every *other* shadow library, the app's own data directory, the
 * podcast and audiobook download roots, and the allowlisted roots themselves.
 */
export function collectProtectedRoots(
  db: Database.Database,
  excludeShadowLibraryId?: number
): ProtectedRoot[] {
  const roots: ProtectedRoot[] = [];
  for (const f of db
    .prepare("SELECT name, path FROM library_folders")
    .all() as { name: string; path: string }[]) {
    roots.push({ path: f.path, label: `the library folder "${f.name}"`, rule: "overlap" });
  }
  for (const s of db
    .prepare("SELECT id, name, path FROM shadow_libraries")
    .all() as { id: number; name: string; path: string }[]) {
    if (s.id === excludeShadowLibraryId) continue;
    roots.push({ path: s.path, label: `the shadow library "${s.name}"`, rule: "overlap" });
  }
  roots.push({ path: getUserDataPath(), label: "iPodRocks' own data folder", rule: "overlap" });
  roots.push({ path: getPodcastsRoot(), label: "the podcast download folder", rule: "overlap" });
  roots.push({ path: getDefaultPodcastsRoot(), label: "the podcast download folder", rule: "overlap" });
  roots.push({ path: getAudiobooksRoot(), label: "the audiobook download folder", rule: "overlap" });
  for (const prefix of getAllowedPathPrefixes()) {
    roots.push({ path: prefix, label: "a top-level folder (such as your home folder)", rule: "contains" });
  }
  return roots;
}
