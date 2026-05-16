/**
 * Builds a tmp directory shaped like a mounted device (Music/Podcasts/
 * Audiobooks/Playlists folders) for behavioral/regression tests.
 */
import * as fs from "fs";
import * as path from "path";

export interface FakeDevice {
  mountPath: string;
  musicDir: string;
  podcastsDir: string;
  audiobooksDir: string;
  playlistsDir: string;
}

export function createFakeDevice(rootTmp: string, subdir = "device"): FakeDevice {
  const mountPath = path.join(rootTmp, subdir);
  const musicDir = path.join(mountPath, "Music");
  const podcastsDir = path.join(mountPath, "Podcasts");
  const audiobooksDir = path.join(mountPath, "Audiobooks");
  const playlistsDir = path.join(mountPath, "Playlists");

  for (const dir of [musicDir, podcastsDir, audiobooksDir, playlistsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  return { mountPath, musicDir, podcastsDir, audiobooksDir, playlistsDir };
}
