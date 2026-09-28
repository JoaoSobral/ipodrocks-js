import * as fs from "fs";
import * as path from "path";
import { getUserDataPath } from "../host";
import { getPodcastDownloadDir } from "../utils/prefs";

export function getPodcastsRoot(): string {
  const custom = getPodcastDownloadDir();
  return custom ?? path.join(getUserDataPath(), "auto-podcasts");
}

export function getDefaultPodcastsRoot(): string {
  return path.join(getUserDataPath(), "auto-podcasts");
}

/**
 * A podcast feed id is the one path component every episode file is built
 * from, and on `podcast:subscribe` it arrives over IPC as whatever JSON the
 * client sent. `feed_id INTEGER NOT NULL UNIQUE` does not coerce it — SQLite's
 * INTEGER affinity stores a value that is not a well-formed integer literal as
 * TEXT, so `"1/../../../tmp/x"` round-trips unchanged and `path.join` resolves
 * it straight out of the podcasts root. Same bug class, same fix, as
 * `assertLibrivoxId()` in `audiobooks/audiobook-storage.ts`.
 *
 * Nonzero, not positive: an RSS subscription's id is the *negative* value
 * `stableRssFeedId()` derives from its URL, so that it can never collide with a
 * Podcast Index id. `subscribe()` (the Podcast Index path) additionally
 * requires it to be positive.
 */
export function assertPodcastFeedId(feedId: unknown): number {
  // A string is refused outright rather than `Number()`-coerced: "1e3" or
  // " 42 " would pass as integers here and then be stored as TEXT by the
  // caller that passed the raw value on.
  if (typeof feedId !== "number" || !Number.isSafeInteger(feedId) || feedId === 0) {
    throw new Error(`invalid podcast feed id: ${String(feedId)}`);
  }
  return feedId;
}

export function getEpisodeDir(feedId: number): string {
  return path.join(getPodcastsRoot(), String(assertPodcastFeedId(feedId)));
}

export function getEpisodePath(feedId: number, episodeId: number, ext: string): string {
  if (!Number.isSafeInteger(episodeId) || episodeId <= 0) {
    throw new Error(`invalid podcast episode id: ${String(episodeId)}`);
  }
  const cleanExt = ext.startsWith(".") ? ext : `.${ext}`;
  return path.join(getEpisodeDir(feedId), `${episodeId}${cleanExt}`);
}

export function ensureEpisodeDir(feedId: number): void {
  fs.mkdirSync(getEpisodeDir(feedId), { recursive: true });
}

/**
 * Resolve a `device_podcast_synced.device_relative_path` against a device, or
 * return null when it does not land strictly inside that device's podcast
 * folder.
 *
 * Both halves come from places a client can reach: `podcast_folder` is a
 * device-profile field, and the relative path is built from a show and episode
 * title the feed author chose. `sanitizeDevicePathComponent` only replaces the
 * FAT-invalid characters, so this is the containment, and every caller that
 * turns a stored relative path back into something it deletes goes through it.
 * The podcast folder itself must also be strictly under the mount: a folder of
 * `.` or `""` would otherwise make "inside the podcast folder" mean "anywhere
 * on the device".
 */
export function containPodcastDevicePath(
  mountPath: string,
  podcastFolder: string | null | undefined,
  relativePath: string
): string | null {
  if (!mountPath || typeof relativePath !== "string" || !relativePath) return null;
  if (path.isAbsolute(relativePath)) return null;
  const mount = path.resolve(mountPath);
  const folder = path.resolve(mount, podcastFolder ?? "Podcasts");
  if (!isStrictlyInside(mount, folder)) return null;
  const target = path.resolve(mount, relativePath);
  if (!isStrictlyInside(folder, target)) return null;
  return target;
}

/**
 * `path.relative`, not `startsWith(base + sep)`: a Windows device mounts at a
 * drive root (`E:\`), which already ends in a separator, and the doubled
 * separator never matches — issue #112's lesson in `utils/device-path.ts`.
 */
function isStrictlyInside(base: string, candidate: string): boolean {
  const rel = path.relative(base, candidate);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(".." + path.sep) &&
    !path.isAbsolute(rel)
  );
}
