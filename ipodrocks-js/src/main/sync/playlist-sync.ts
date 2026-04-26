import * as fsp from "fs/promises";
import * as path from "path";
import { Playlist } from "../../shared/types";
import { PlaylistCore } from "../playlists/playlist-core";
import { ProgressCallback } from "./sync-core";
import { buildTagnaviConfig, TagnaviPlaylistInput } from "../rockbox/tagnavi-writer";

export interface M3uOptions {
  musicFolder: string;
  codecName: string;
  libraryFolderPaths?: Map<number, string>;
}

export interface WritePlaylistsArgs {
  playlistFolder: string;
  mountPath: string;
  playlistsToWrite: Playlist[];
  core: PlaylistCore;
  m3uOpts: M3uOptions;
  useTagnavi: boolean;
  progressCallback?: ProgressCallback;
}

export interface WritePlaylistsResult {
  playlistsWritten: number;
  tagnaviCount: number;
}

const normalizeForCompare = (s: string) =>
  s.replace(/# Generated: .+/g, "# Generated: <date>");

export async function writePlaylistsToDevice(
  args: WritePlaylistsArgs
): Promise<WritePlaylistsResult> {
  const { playlistFolder, mountPath, playlistsToWrite, core, m3uOpts, useTagnavi, progressCallback } = args;

  let playlistsWritten = 0;
  let tagnaviCount = 0;
  const smartForTagnavi: TagnaviPlaylistInput[] = [];

  await fsp.mkdir(playlistFolder, { recursive: true });

  for (const pl of playlistsToWrite) {
    if (pl.typeName === "smart" && useTagnavi) {
      const rules = core.getSmartRules(pl.id);
      if (rules.length > 0) smartForTagnavi.push({ playlist: pl, rules });
      // Progress for tagnavi playlists is deferred until after we know
      // whether the config file actually needs to be rewritten.
      continue;
    }

    const content = core.buildM3uContentForDevice(pl.id, m3uOpts);
    const safeName = pl.name.replace(/[/\\?*:"<>|]/g, "_").trim() || "Playlist";
    const outPath = path.join(playlistFolder, `${safeName}.m3u`);
    let existingRaw: string | null = null;
    try {
      existingRaw = await fsp.readFile(outPath, "utf-8");
    } catch {
      // file doesn't exist yet
    }
    const needsWrite =
      existingRaw === null ||
      normalizeForCompare(existingRaw) !== normalizeForCompare(content);
    if (needsWrite) {
      await fsp.writeFile(outPath, content, "utf-8");
      playlistsWritten += 1;
    }
    progressCallback?.({
      event: "copy",
      path: outPath,
      status: needsWrite ? "copied" : "skipped",
      contentType: "playlist",
    });
  }

  const rockboxDir = path.join(mountPath, ".rockbox");
  const configPath = path.join(rockboxDir, "tagnavi_user.config");
  const legacyCustomPath = path.join(rockboxDir, "tagnavi_custom.config");

  // Migration: tagnavi_custom.config was used by older iPodRocks versions but
  // the firmware's %include of it fails silently on some builds. We now own
  // tagnavi_user.config (which fully overrides tagnavi.config) instead.
  await fsp.rm(legacyCustomPath, { force: true });

  if (useTagnavi) {
    if (smartForTagnavi.length === 0) {
      await fsp.rm(configPath, { force: true });
    } else {
      const content = buildTagnaviConfig(smartForTagnavi);
      let existing: string | null = null;
      try {
        existing = await fsp.readFile(configPath, "utf-8");
      } catch {
        // file doesn't exist yet
      }
      const needsWrite =
        existing === null || normalizeForCompare(existing) !== normalizeForCompare(content);
      if (needsWrite) {
        await fsp.mkdir(rockboxDir, { recursive: true });
        await fsp.writeFile(configPath, content, "utf-8");
        tagnaviCount = smartForTagnavi.length;
      }
      // Now that we know whether anything changed, emit one progress event per tagnavi playlist.
      const tagnaviStatus = needsWrite ? "copied" : "skipped";
      for (const entry of smartForTagnavi) {
        progressCallback?.({
          event: "copy",
          path: `<tagnavi> ${entry.playlist.name}`,
          status: tagnaviStatus,
          contentType: "playlist",
        });
      }
    }
  } else {
    await fsp.rm(configPath, { force: true });
  }

  if (playlistsWritten > 0 || tagnaviCount > 0) {
    progressCallback?.({
      event: "log",
      message:
        tagnaviCount > 0
          ? `Written ${playlistsWritten} M3U + ${tagnaviCount} tagnavi entry(ies).`
          : `Written ${playlistsWritten} playlist(s) to device.`,
    });
  } else if (playlistsToWrite.length > 0) {
    progressCallback?.({
      event: "log",
      message: "Playlist(s) already up to date.",
    });
  }

  return { playlistsWritten, tagnaviCount };
}
