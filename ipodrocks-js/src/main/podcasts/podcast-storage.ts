import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { getPodcastDownloadDir } from "../utils/prefs";

export function getPodcastsRoot(): string {
  const custom = getPodcastDownloadDir();
  return custom ?? path.join(app.getPath("userData"), "auto-podcasts");
}

export function getDefaultPodcastsRoot(): string {
  return path.join(app.getPath("userData"), "auto-podcasts");
}

export function getEpisodeDir(feedId: number): string {
  return path.join(getPodcastsRoot(), String(feedId));
}

export function getEpisodePath(feedId: number, episodeId: number, ext: string): string {
  const cleanExt = ext.startsWith(".") ? ext : `.${ext}`;
  return path.join(getEpisodeDir(feedId), `${episodeId}${cleanExt}`);
}

export function ensureEpisodeDir(feedId: number): void {
  fs.mkdirSync(getEpisodeDir(feedId), { recursive: true });
}
