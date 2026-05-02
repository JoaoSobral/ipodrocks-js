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

  await fsp.mkdir(playlistFolder, { recursive: true });

  // First pass: determine which m3u playlists actually need to be (re)written
  // and which tagnavi entries should be included. Playlists that already match
  // on disk are silently skipped (matches music-track sync behavior — no
  // counter bump, no event).
  const m3uToWrite: { outPath: string; content: string }[] = [];
  const smartForTagnavi: TagnaviPlaylistInput[] = [];

  for (const pl of playlistsToWrite) {
    if (pl.typeName === "smart" && useTagnavi) {
      const rules = core.getSmartRules(pl.id);
      if (rules.length > 0) smartForTagnavi.push({ playlist: pl, rules });
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
      m3uToWrite.push({ outPath, content });
    }
  }

  const rockboxDir = path.join(mountPath, ".rockbox");
  const configPath = path.join(rockboxDir, "tagnavi_user.config");
  const legacyCustomPath = path.join(rockboxDir, "tagnavi_custom.config");

  // Migration: tagnavi_custom.config was used by older iPodRocks versions but
  // the firmware's %include of it fails silently on some builds. We now own
  // tagnavi_user.config (which fully overrides tagnavi.config) instead.
  await fsp.rm(legacyCustomPath, { force: true });

  let tagnaviContent = "";
  let tagnaviNeedsWrite = false;
  if (useTagnavi && smartForTagnavi.length > 0) {
    tagnaviContent = buildTagnaviConfig(smartForTagnavi);
    let existing: string | null = null;
    try {
      existing = await fsp.readFile(configPath, "utf-8");
    } catch {
      // file doesn't exist yet
    }
    tagnaviNeedsWrite =
      existing === null ||
      normalizeForCompare(existing) !== normalizeForCompare(tagnaviContent);
  }

  // Bump the total counter only for playlists that will actually be written.
  const totalToWrite = m3uToWrite.length + (tagnaviNeedsWrite ? smartForTagnavi.length : 0);
  if (totalToWrite > 0) {
    progressCallback?.({ event: "total_add", path: String(totalToWrite) });
  }

  // Second pass: write what needs writing and emit one progress event per item.
  let playlistsWritten = 0;
  for (const { outPath, content } of m3uToWrite) {
    await fsp.writeFile(outPath, content, "utf-8");
    playlistsWritten += 1;
    progressCallback?.({
      event: "copy",
      path: outPath,
      status: "copied",
      contentType: "playlist",
    });
  }

  let tagnaviCount = 0;
  if (useTagnavi) {
    if (smartForTagnavi.length === 0) {
      await fsp.rm(configPath, { force: true });
    } else if (tagnaviNeedsWrite) {
      await fsp.mkdir(rockboxDir, { recursive: true });
      await fsp.writeFile(configPath, tagnaviContent, "utf-8");
      tagnaviCount = smartForTagnavi.length;
      for (const entry of smartForTagnavi) {
        progressCallback?.({
          event: "copy",
          path: `<tagnavi> ${entry.playlist.name}`,
          status: "copied",
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
