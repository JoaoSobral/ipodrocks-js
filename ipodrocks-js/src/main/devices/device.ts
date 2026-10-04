import path from "path";
import {
  ContentStats,
  ContentType,
  DeviceProfile,
  DeviceTrackInfo,
  DiskSpace,
} from "../../shared/types";
import { AUDIO_EXTENSIONS, isMacosMetadataFile } from "../utils/audio-extensions";
import { createDeviceFs, type DeviceFs } from "./fs";

/** The app's GB everywhere: `formatGb()`, `DiskSpace.totalGb`, the capacity field. */
const GIB = 1024 ** 3;

interface GetTracksOptions {
  cancelSignal?: AbortSignal;
  progressCallback?: (filePath: string, count: number) => void;
}

export class Device {
  readonly profile: DeviceProfile;
  readonly name: string;
  readonly mountPath: string;
  /**
   * Every read and write this device's files receive.
   *
   * It belongs to the device rather than being passed around beside it,
   * because "which filesystem is this path on" is a fact about the device and
   * nothing else. Callers that need it hand `device.fs` down; they never build
   * one of their own.
   */
  readonly fs: DeviceFs;

  constructor(deviceProfile: DeviceProfile, deviceFs?: DeviceFs) {
    this.profile = deviceProfile;
    this.name = deviceProfile.name ?? "Unknown Device";
    this.mountPath = deviceProfile.mountPath ?? "";
    this.fs = deviceFs ?? createDeviceFs(deviceProfile);
  }

  get musicFolder(): string {
    return this.profile.musicFolder ?? "Music";
  }

  get podcastFolder(): string {
    return this.profile.podcastFolder ?? "Podcasts";
  }

  get audiobookFolder(): string {
    return this.profile.audiobookFolder ?? "Audiobooks";
  }

  get playlistFolder(): string {
    return this.profile.playlistFolder ?? "Playlists";
  }

  getContentPath(contentType: ContentType): string {
    let folder: string;
    switch (contentType) {
      case "music":
        folder = this.musicFolder;
        break;
      case "podcast":
        folder = this.podcastFolder;
        break;
      case "audiobook":
        folder = this.audiobookFolder;
        break;
      case "playlist":
        folder = this.playlistFolder;
        break;
      default:
        folder = (contentType as string).charAt(0).toUpperCase() +
          (contentType as string).slice(1);
        break;
    }
    return this.mountPath ? path.join(this.mountPath, folder) : folder;
  }

  /**
   * Total, free and used bytes.
   *
   * A local mount asks the filesystem. A browser-held device has no
   * equivalent of `statfs` — the File System Access API cannot read a disk's
   * size at all — so used space is *measured* by summing every file on it, and
   * the total is the capacity the user entered in the device profile. Without
   * one the result is used-only. Never `navigator.storage.estimate()`: that is
   * the browser's own origin quota, not the device.
   *
   * A UI label and nothing more — no decision anywhere depends on it — so a
   * failure degrades to zeroes rather than making the device unusable.
   */
  async getAvailableSpace(): Promise<DiskSpace> {
    const empty: DiskSpace = { totalBytes: 0, freeBytes: 0, totalGb: 0, freeGb: 0 };
    if (this.fs.capabilities.freeSpace) {
      const s = await this.fs.freeSpace();
      if (!s) return empty;
      const usedBytes = Math.max(0, s.totalBytes - s.freeBytes);
      return { ...s, usedBytes, usedGb: usedBytes / GIB, source: "filesystem" };
    }

    let usedBytes = 0;
    try {
      await this.fs.listTree(this.mountPath, {
        includeDirectories: false,
        onEntry: (entry) => {
          usedBytes += entry.size;
        },
      });
    } catch (err) {
      // "The tab went away" is not an answer about the device, here or in any
      // other reader.
      if ((err as { code?: string })?.code === "EDEVICEDETACHED") throw err;
      return empty;
    }

    const capacityGb = this.profile.capacityGb;
    if (capacityGb == null || !(capacityGb > 0)) {
      return { ...empty, usedBytes, usedGb: usedBytes / GIB, source: "used-only" };
    }
    const totalBytes = Math.round(capacityGb * GIB);
    const freeBytes = Math.max(0, totalBytes - usedBytes);
    return {
      totalBytes,
      freeBytes,
      totalGb: totalBytes / GIB,
      freeGb: freeBytes / GIB,
      usedBytes,
      usedGb: usedBytes / GIB,
      source: "estimated",
    };
  }

  // Walks the device's content folder through the device filesystem so the main
  // process event loop stays free for IPC progress messages and cancel signals.
  // The signal is checked before every directory read and every entry — on
  // abort, the walk returns the partial map immediately rather than continuing.
  async getTracks(
    contentType: ContentType = "music",
    options?: GetTracksOptions
  ): Promise<Map<string, DeviceTrackInfo>> {
    const contentPath = this.getContentPath(contentType);
    const tracks = new Map<string, DeviceTrackInfo>();
    if (!contentPath) return tracks;

    const progress = options?.progressCallback;
    let count = 0;
    let examined = 0;

    await this.fs.listTree(contentPath, {
      signal: options?.cancelSignal,
      includeDirectories: false,
      onEntry: (entry) => {
        if (isMacosMetadataFile(entry.name)) return;

        examined++;
        const ext = path.extname(entry.name).toLowerCase();
        if (AUDIO_EXTENSIONS.has(ext)) {
          tracks.set(entry.path, {
            filename: path.parse(entry.name).name,
            fileSize: entry.size,
            exists: true,
            mtimeMs: entry.mtimeMs,
          });
          count++;
          if (progress) progress(entry.path, count);
        } else if (progress && examined % 200 === 0) {
          progress(entry.path, count);
        }
      },
    });

    return tracks;
  }

  async getContentStats(
    contentType: ContentType = "music",
    options?: { cancelSignal?: AbortSignal }
  ): Promise<ContentStats> {
    const contentPath = this.getContentPath(contentType);
    if (!contentPath) return { fileCount: 0, totalGb: 0 };

    let totalSize = 0;
    let fileCount = 0;

    try {
      await this.fs.listTree(contentPath, {
        signal: options?.cancelSignal,
        includeDirectories: false,
        onEntry: (entry) => {
          // An undefined mtime is `listTree`'s marker for a stat that failed;
          // the walk this replaced skipped those rather than counting a
          // zero-byte file.
          if (entry.mtimeMs === undefined) return;
          totalSize += entry.size;
          fileCount++;
        },
      });
    } catch {
      return { fileCount: 0, totalGb: 0 };
    }

    return { fileCount, totalGb: totalSize / 1024 ** 3 };
  }
}
