import fs from "fs";
import path from "path";
import {
  ContentStats,
  ContentType,
  DeviceProfile,
  DeviceTrackInfo,
  DiskSpace,
  FitCheck,
} from "../../shared/types";
import { AUDIO_EXTENSIONS } from "../utils/audio-extensions";

interface GetTracksOptions {
  cancelSignal?: AbortSignal;
  progressCallback?: (filePath: string, count: number) => void;
}

export class Device {
  readonly profile: DeviceProfile;
  readonly name: string;
  readonly mountPath: string;

  constructor(deviceProfile: DeviceProfile) {
    this.profile = deviceProfile;
    this.name = deviceProfile.name ?? "Unknown Device";
    this.mountPath = deviceProfile.mountPath ?? "";
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

  getAvailableSpace(): DiskSpace {
    if (!this.mountPath || !fs.existsSync(this.mountPath)) {
      return { totalBytes: 0, freeBytes: 0, totalGb: 0, freeGb: 0 };
    }

    try {
      const stats = fs.statfsSync(this.mountPath);
      const totalBytes = stats.bsize * stats.blocks;
      const freeBytes = stats.bsize * stats.bavail;
      return {
        totalBytes,
        freeBytes,
        totalGb: totalBytes / 1024 ** 3,
        freeGb: freeBytes / 1024 ** 3,
      };
    } catch {
      return { totalBytes: 0, freeBytes: 0, totalGb: 0, freeGb: 0 };
    }
  }

  // Walks the device's content folder asynchronously so the main process
  // event loop stays free for IPC progress messages and cancel signals.
  // The signal is checked before every readdir and stat — on abort, the
  // walk returns the partial map immediately rather than continuing.
  async getTracks(
    contentType: ContentType = "music",
    options?: GetTracksOptions
  ): Promise<Map<string, DeviceTrackInfo>> {
    const contentPath = this.getContentPath(contentType);
    const tracks = new Map<string, DeviceTrackInfo>();

    if (!contentPath || !fs.existsSync(contentPath)) return tracks;

    const signal = options?.cancelSignal;
    const progress = options?.progressCallback;
    let count = 0;
    let examined = 0;

    const walk = async (dir: string): Promise<void> => {
      if (signal?.aborted) return;

      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (signal?.aborted) return;

        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          await walk(fullPath);
          continue;
        }

        examined++;
        const ext = path.extname(entry.name).toLowerCase();
        if (AUDIO_EXTENSIONS.has(ext)) {
          let fileSize = 0;
          let mtimeMs: number | undefined;
          try {
            const stat = await fs.promises.stat(fullPath);
            fileSize = stat.size;
            mtimeMs = stat.mtimeMs;
          } catch {
            // keep 0
          }
          tracks.set(fullPath, {
            filename: path.parse(entry.name).name,
            fileSize,
            exists: true,
            mtimeMs,
          });
          count++;
          if (progress) progress(fullPath, count);
        } else if (progress && examined % 200 === 0) {
          progress(fullPath, count);
        }
      }
    };

    await walk(contentPath);
    return tracks;
  }

  async getContentStats(
    contentType: ContentType = "music",
    options?: { cancelSignal?: AbortSignal }
  ): Promise<ContentStats> {
    const contentPath = this.getContentPath(contentType);
    if (!contentPath || !fs.existsSync(contentPath)) {
      return { fileCount: 0, totalGb: 0 };
    }

    const signal = options?.cancelSignal;
    let totalSize = 0;
    let fileCount = 0;

    const walk = async (dir: string): Promise<void> => {
      if (signal?.aborted) return;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (signal?.aborted) return;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else {
          try {
            totalSize += (await fs.promises.stat(fullPath)).size;
            fileCount++;
          } catch {
            // skip inaccessible
          }
        }
      }
    };

    try {
      await walk(contentPath);
    } catch {
      return { fileCount: 0, totalGb: 0 };
    }

    return { fileCount, totalGb: totalSize / 1024 ** 3 };
  }

  canFitContent(
    requiredBytes: number,
    contentType: ContentType = "music"
  ): FitCheck {
    void contentType;
    const space = this.getAvailableSpace();
    const requiredGb = requiredBytes / 1024 ** 3;
    const availableGb = space.freeGb;
    const canFit = requiredGb <= availableGb;

    return {
      canFit,
      requiredGb,
      availableGb,
      remainingGb: canFit ? availableGb - requiredGb : 0,
    };
  }
}
