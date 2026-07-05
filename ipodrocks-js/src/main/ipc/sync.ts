import * as fs from "fs";
import * as path from "path";
import { ipcMain } from "electron";
import {
  safe,
  getLibrary,
  getDevicesCore,
  getPlaylistCore,
  buildLibraryTrackMaps,
  remapTrackMapToShadow,
} from "./common";
import {
  emptySelections,
  getDeviceSyncPreferences,
  saveDeviceSyncPreferences,
} from "../sync/device-sync-preferences";
import {
  runSync,
  RunSyncOptions,
  getProfileCodecExt,
  removeExtraTracks,
  SyncCancelled,
} from "../sync/sync-core";
import { writePlaylistsToDevice } from "../sync/playlist-sync";
import { syncPodcastsToDevice } from "../podcasts/podcast-device-sync";
import { syncAutoAudiobooksToDevice } from "../audiobooks/audiobook-device-sync";
import { listSubscriptions as listAudiobookSubs } from "../audiobooks/audiobook-subscriptions";
import {
  ingestDeviceRatings,
  computeRatingPropagations,
  markRatingsPropagated,
} from "../sync/rating-merge";
import {
  readRockboxRatings,
  writeRockboxRatingsChangelog,
  resolveDevicePathToTrackId,
  hasRockboxChangelog,
  buildDeviceRelativePath,
} from "../rockbox/tagcache";
import { readAndIngestPlaybackLog } from "../playlists/playback-log-ingest";
import { logActivity } from "../activity/activity-logger";
import type {
  SyncOptions,
  DeviceSyncPreferences,
} from "../../shared/types";

let activeSyncAbort: AbortController | null = null;

export function registerSyncHandlers(): void {
  ipcMain.handle(
    "sync:start",
    safe("sync:start", async (event, opts: SyncOptions) => {
      const lib = getLibrary();
      const dc = getDevicesCore();
      const device = dc.getDeviceById(opts.deviceId);
      if (!device) return { error: `Device ${opts.deviceId} not found` };

      saveDeviceSyncPreferences(lib.getConnection(), opts.deviceId, {
        syncType: opts.syncType,
        extraTrackPolicy: opts.extraTrackPolicy,
        includeMusic: opts.includeMusic !== false,
        includePodcasts: opts.includePodcasts !== false,
        includeAudiobooks: opts.includeAudiobooks !== false,
        includePlaylists: opts.includePlaylists !== false,
        preserveFolderStructure: opts.preserveFolderStructure !== false,
        selections: opts.selections ?? emptySelections(),
      } satisfies DeviceSyncPreferences);

      const preserveFolderStructure = opts.preserveFolderStructure !== false;

      activeSyncAbort = new AbortController();
      const syncSignal = activeSyncAbort.signal;

      const { music: musicMap, podcast: podcastMap, audiobook: audiobookMap } =
        buildLibraryTrackMaps(lib);

      let musicLibraryTracks: Record<string, Record<string, unknown>> = {};
      let podcastLibraryTracks: Record<string, Record<string, unknown>> = {};
      let audiobookLibraryTracks: Record<string, Record<string, unknown>> = {};

      if (opts.syncType === "custom" && opts.selections) {
        const sel = opts.selections;
        const isExclude = sel.mode === "exclude";
        const albumSet = new Set(sel.albums ?? []);
        const artistSet = new Set(sel.artists ?? []);
        const genreSet = new Set(sel.genres ?? []);
        const podcastSet = new Set(sel.podcasts ?? []);
        const audiobookSet = new Set(sel.audiobooks ?? []);

        // Collect track paths from selected playlists
        const playlistTrackPaths = new Set<string>();
        if (sel.playlists?.length) {
          const playlistCore = getPlaylistCore();
          const selectedPlaylistNames = new Set(sel.playlists);
          const allPlaylists = playlistCore.getPlaylists();
          for (const pl of allPlaylists) {
            if (selectedPlaylistNames.has(pl.name)) {
              for (const track of playlistCore.getPlaylistTracks(pl.id)) {
                playlistTrackPaths.add(track.path);
              }
            }
          }
        }

        const matchMusic = (t: Record<string, unknown>, p: string) => {
          if (playlistTrackPaths.has(p)) return true;
          const album = (String(t.album ?? "Unknown Album")).trim();
          const artist = (String(t.artist ?? "Unknown Artist")).trim();
          const genre = (String(t.genre ?? "Unknown Genre")).trim();
          const albumLabel = `${album} — ${artist}`;
          return albumSet.has(albumLabel) || artistSet.has(artist) || genreSet.has(genre);
        };
        const matchPodcast = (t: Record<string, unknown>, p: string) => {
          if (playlistTrackPaths.has(p)) return true;
          const title = (String(t.title ?? t.filename ?? "Untitled")).trim();
          const artist = (String(t.artist ?? "")).trim();
          const label = artist ? `${title} — ${artist}` : title;
          return podcastSet.has(label) || podcastSet.has(title);
        };
        const matchAudiobook = (t: Record<string, unknown>, p: string) => {
          if (playlistTrackPaths.has(p)) return true;
          const title = (String(t.title ?? t.filename ?? "Untitled")).trim();
          const artist = (String(t.artist ?? "")).trim();
          const label = artist ? `${title} — ${artist}` : title;
          return audiobookSet.has(label) || audiobookSet.has(title);
        };

        // In exclude mode the predicate is inverted: keep tracks that do NOT match.
        const keepMusic = (t: Record<string, unknown>, p: string) =>
          isExclude ? !matchMusic(t, p) : matchMusic(t, p);
        const keepPodcast = (t: Record<string, unknown>, p: string) =>
          isExclude ? !matchPodcast(t, p) : matchPodcast(t, p);
        const keepAudiobook = (t: Record<string, unknown>, p: string) =>
          isExclude ? !matchAudiobook(t, p) : matchAudiobook(t, p);

        for (const [p, t] of Object.entries(musicMap)) {
          if (keepMusic(t, p)) musicLibraryTracks[p] = t;
        }
        for (const [p, t] of Object.entries(podcastMap)) {
          if (keepPodcast(t, p)) podcastLibraryTracks[p] = t;
        }
        for (const [p, t] of Object.entries(audiobookMap)) {
          if (keepAudiobook(t, p)) audiobookLibraryTracks[p] = t;
        }
      } else {
        const includeMusic = opts.syncType === "full" ? opts.includeMusic === true : true;
        const includePodcasts = opts.syncType === "full" ? opts.includePodcasts === true : true;
        const includeAudiobooks = opts.syncType === "full" ? opts.includeAudiobooks === true : true;
        if (includeMusic) musicLibraryTracks = { ...musicMap };
        if (includePodcasts) podcastLibraryTracks = { ...podcastMap };
        if (includeAudiobooks) audiobookLibraryTracks = { ...audiobookMap };
      }

      let codecName = device.profile.codecName ?? "copy";
      let profileCodecExtOverride: string | null = null;
      const folders = lib.getLibraryFolders();
      const libraryFolderPaths = new Map<number, string>();
      for (const f of folders) {
        libraryFolderPaths.set(f.id, f.path);
      }

      if (
        device.profile.sourceLibraryType === "shadow" &&
        device.profile.shadowLibraryId != null
      ) {
        codecName = "DIRECT COPY";
        const shadowLib = lib.getShadowLibraryById(
          device.profile.shadowLibraryId
        );
        const shadowTrackMap = lib.getShadowTrackMap(
          device.profile.shadowLibraryId
        );

        musicLibraryTracks = remapTrackMapToShadow(musicLibraryTracks, shadowTrackMap);
        podcastLibraryTracks = remapTrackMapToShadow(podcastLibraryTracks, shadowTrackMap);
        audiobookLibraryTracks = remapTrackMapToShadow(audiobookLibraryTracks, shadowTrackMap);

        if (shadowLib) {
          for (const [folderId] of libraryFolderPaths) {
            libraryFolderPaths.set(folderId, shadowLib.path);
          }
          profileCodecExtOverride = getProfileCodecExt(shadowLib.codecName);
        }
      }

      // Pre-load all content_hashes mtimes once from DB so analyzeContentType
      // can skip fs.statSync for unchanged files without per-track round-trips.
      const mtimeRows = lib.getConnection()
        .prepare("SELECT file_path, last_modified FROM content_hashes")
        .all() as { file_path: string; last_modified: string }[];
      const preloadedMtimes = new Map<string, number>();
      for (const r of mtimeRows) {
        const ms = new Date(r.last_modified).getTime();
        if (!Number.isNaN(ms)) preloadedMtimes.set(r.file_path, ms);
      }

      const syncOpts: RunSyncOptions = {
        syncType: opts.syncType,
        extraTrackPolicy: opts.extraTrackPolicy,
        cancelSignal: syncSignal,
        skipAlbumArtwork: device.profile.skipAlbumArtwork === true,
        preserveFolderStructure,
        preloadedMtimes,
        profileCodecExtOverride: profileCodecExtOverride ?? undefined,
        progressCallback: (progressEvent) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send("sync:progress", progressEvent);
          }
        },
      };

      let result: {
        status: string;
        synced: number;
        removed: number;
        extras: string[];
        missingFiles: string[];
        errors: number;
      } = { status: "completed", synced: 0, removed: 0, extras: [], missingFiles: [], errors: 0 };

      const willRunMusic = Object.keys(musicLibraryTracks).length > 0;
      const willRunPodcast = Object.keys(podcastLibraryTracks).length > 0;
      const willRunAudiobook = Object.keys(audiobookLibraryTracks).length > 0;
      const hasAutoPodcasts = device.profile.autoPodcastsEnabled === true;
      const hasAutoAudiobooks = listAudiobookSubs(lib.getConnection()).length > 0;
      const isEmptyLibrary = !willRunMusic && !willRunPodcast && !willRunAudiobook;

      if (isEmptyLibrary && !hasAutoPodcasts && !hasAutoAudiobooks) {
        const isShadow = device.profile.sourceLibraryType === "shadow" && device.profile.shadowLibraryId != null;
        const emptyMessage = isShadow
          ? "Shadow library contains no files to sync. Build or select a shadow library that has tracks."
          : "Library contains no music, podcast, or audiobook files to sync. Add library folders and scan first.";
        syncOpts.progressCallback?.({ event: "log", message: emptyMessage });
        syncOpts.progressCallback?.({ event: "total", path: "0" });
        activeSyncAbort = null;
        return { error: emptyMessage };
      }

      const deviceMusicPath = device.getContentPath("music");
      try {
        fs.mkdirSync(deviceMusicPath, { recursive: true });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EACCES") {
          activeSyncAbort = null;
          return {
            error:
              `Permission denied writing to device (${deviceMusicPath}). ` +
              "Ensure the device is mounted with write access and you have permission to create folders. " +
              "On Linux, try ejecting and reconnecting the device, or check mount permissions.",
          };
        }
        throw err;
      }

      if (!device.profile.skipPlaybackLog) {
        syncOpts.progressCallback?.({ event: "log", message: "Reading playback.log..." });
        const ingest = readAndIngestPlaybackLog(
          opts.deviceId,
          lib.getConnection(),
          device.mountPath,
          false,
          device.name
        );
        if (ingest.ingested > 0 || ingest.skipped > 0) {
          syncOpts.progressCallback?.({
            event: "log",
            message: `Ingested ${ingest.ingested} playback events (${ingest.skipped} duplicates skipped).`,
          });
        }
      }

      // Phase 1: INGEST — read device ratings and merge into canonical DB
      try {
        if (hasRockboxChangelog(device.mountPath)) {
          syncOpts.progressCallback?.({ event: "log", message: "Reading device ratings..." });
          const deviceRatingsByPath = readRockboxRatings(device.mountPath);
          const db = lib.getConnection();

          // Resolve device-relative paths to track IDs
          const deviceRatingsByTrackId = new Map<number, number>();
          for (const [devPath, rating] of deviceRatingsByPath) {
            const trackId = resolveDevicePathToTrackId(db, opts.deviceId, devPath, device.mountPath);
            if (trackId !== null) {
              deviceRatingsByTrackId.set(trackId, rating);
            }
          }

          const ingestResult = ingestDeviceRatings(db, opts.deviceId, deviceRatingsByTrackId);

          if (ingestResult.massZeroFraction > 0.25 && deviceRatingsByPath.size > 10) {
            syncOpts.progressCallback?.({
              event: "log",
              message: `Warning: ${Math.round(ingestResult.massZeroFraction * 100)}% of device ratings are 0 — possible Rockbox DB rebuild. Ratings from device skipped pending review.`,
            });
          } else {
            const total = ingestResult.adopted + ingestResult.converged + ingestResult.conflicts;
            if (total > 0) {
              syncOpts.progressCallback?.({
                event: "log",
                message: `Ratings: ${ingestResult.adopted} adopted, ${ingestResult.converged} converged, ${ingestResult.conflicts} conflict(s) queued.`,
              });
            }
          }
        }
      } catch (err) {
        console.error("[ipc] Rating ingest failed (non-fatal):", err);
      }

      if (willRunMusic) {
        const deviceMusicRaw = await device.getTracks("music", { cancelSignal: syncSignal });
        if (syncSignal.aborted) throw new SyncCancelled();
        const deviceMusicMap: Record<string, { file_size: number; mtime?: number }> = {};
        for (const [p, info] of deviceMusicRaw) {
          deviceMusicMap[p] = {
            file_size: info.fileSize,
            ...(info.mtimeMs != null && { mtime: info.mtimeMs }),
          };
        }
        const musicResult = await runSync(
          device,
          musicLibraryTracks,
          codecName,
          "music",
          deviceMusicPath,
          deviceMusicMap,
          syncOpts,
          libraryFolderPaths
        );
        result.synced += musicResult.synced;
        result.removed += musicResult.removed;
        result.errors += musicResult.errors;
        result.extras = [...result.extras, ...musicResult.extras];
        result.missingFiles = [...result.missingFiles, ...musicResult.missingFiles];
      }

      if (willRunPodcast) {
        const devicePodcastPath = device.getContentPath("podcast");
        const devicePodcastRaw = await device.getTracks("podcast", { cancelSignal: syncSignal });
        if (syncSignal.aborted) throw new SyncCancelled();
        const devicePodcastMap: Record<string, { file_size: number; mtime?: number }> = {};
        for (const [p, info] of devicePodcastRaw) {
          devicePodcastMap[p] = {
            file_size: info.fileSize,
            ...(info.mtimeMs != null && { mtime: info.mtimeMs }),
          };
        }
        const podcastResult = await runSync(
          device,
          podcastLibraryTracks,
          codecName,
          "podcast",
          devicePodcastPath,
          devicePodcastMap,
          syncOpts,
          libraryFolderPaths
        );
        result.synced += podcastResult.synced;
        result.removed += podcastResult.removed;
        result.errors += podcastResult.errors;
        result.extras = [...result.extras, ...podcastResult.extras];
        result.missingFiles = [...result.missingFiles, ...podcastResult.missingFiles];
      }

      if (willRunAudiobook) {
        const deviceAudiobookPath = device.getContentPath("audiobook");
        const deviceAudiobookRaw = await device.getTracks("audiobook", { cancelSignal: syncSignal });
        if (syncSignal.aborted) throw new SyncCancelled();
        const deviceAudiobookMap: Record<string, { file_size: number; mtime?: number }> = {};
        for (const [p, info] of deviceAudiobookRaw) {
          deviceAudiobookMap[p] = {
            file_size: info.fileSize,
            ...(info.mtimeMs != null && { mtime: info.mtimeMs }),
          };
        }
        const audiobookResult = await runSync(
          device,
          audiobookLibraryTracks,
          codecName,
          "audiobook",
          deviceAudiobookPath,
          deviceAudiobookMap,
          syncOpts,
          libraryFolderPaths
        );
        result.synced += audiobookResult.synced;
        result.removed += audiobookResult.removed;
        result.errors += audiobookResult.errors;
        result.extras = [...result.extras, ...audiobookResult.extras];
        result.missingFiles = [...result.missingFiles, ...audiobookResult.missingFiles];
      }

      if (hasAutoPodcasts) {
        try {
          const autoPodResult = await syncPodcastsToDevice(lib.getConnection(), opts.deviceId, syncOpts.progressCallback);
          result.synced += autoPodResult.synced;
          result.errors += autoPodResult.errors;
        } catch (err) {
          console.error("[ipc] Auto podcast sync to device failed:", err);
        }
      }

      // Auto Audiobooks: download-on-sync for books in scope
      try {
        const autoAbResult = await syncAutoAudiobooksToDevice(
          lib.getConnection(),
          opts.deviceId,
          {
            syncType: opts.syncType,
            includeAudiobooks: opts.includeAudiobooks !== false,
            selectedLabels: opts.selections?.audiobooks ?? [],
            mode: opts.selections?.mode ?? "include",
          },
          syncOpts.progressCallback
        );
        result.synced += autoAbResult.synced;
        result.errors += autoAbResult.errors;
      } catch (err) {
        console.error("[ipc] Auto audiobook sync to device failed:", err);
      }

      // "Remove all" — wipe auto podcasts and extra audiobooks off the device
      if (opts.extraTrackPolicy === "remove-all") {
        const db = lib.getConnection();
        try {
          const podcastRows = db
            .prepare("SELECT device_relative_path FROM device_podcast_synced WHERE device_id = ?")
            .all(opts.deviceId) as { device_relative_path: string }[];
          for (const row of podcastRows) {
            const abs = path.join(device.profile.mountPath, row.device_relative_path);
            try { fs.unlinkSync(abs); } catch { /* ignore */ }
          }
          db.prepare("DELETE FROM device_podcast_synced WHERE device_id = ?").run(opts.deviceId);
          if (podcastRows.length > 0) {
            syncOpts.progressCallback?.({ event: "log", message: `Remove all: removed ${podcastRows.length} auto-podcast file(s) from device.` });
            result.removed += podcastRows.length;
          }
        } catch (err) {
          console.error("[ipc] remove-all: podcast cleanup failed:", err);
        }
        try {
          const abRows = db
            .prepare("SELECT device_relative_path FROM device_audiobook_synced WHERE device_id = ?")
            .all(opts.deviceId) as { device_relative_path: string }[];
          for (const row of abRows) {
            const abs = path.join(device.profile.mountPath, row.device_relative_path);
            try { fs.unlinkSync(abs); } catch { /* ignore */ }
          }
          db.prepare("DELETE FROM device_audiobook_synced WHERE device_id = ?").run(opts.deviceId);
          if (abRows.length > 0) {
            syncOpts.progressCallback?.({ event: "log", message: `Remove all: removed ${abRows.length} extra-audiobook file(s) from device.` });
            result.removed += abRows.length;
          }
        } catch (err) {
          console.error("[ipc] remove-all: extra audiobook cleanup failed:", err);
        }
      }

      if (result.errors > 0) result.status = "error";

      const shouldWritePlaylists =
        result.errors === 0 &&
        (opts.syncType === "custom"
          ? (opts.selections?.playlists?.length ?? 0) > 0
          : opts.includePlaylists !== false);

      const useTagnavi = device.profile.rockboxSmartPlaylists === true;
      let playlistsWritten = 0;
      if (shouldWritePlaylists) {
        const playlistFolder = device.getContentPath("playlist");
        if (playlistFolder) {
          try {
            const core = getPlaylistCore();
            let playlistsToWrite = core.getPlaylists();
            if (opts.syncType === "custom" && opts.selections?.playlists?.length) {
              const selectedSet = new Set(opts.selections.playlists);
              playlistsToWrite = playlistsToWrite.filter((pl) => selectedSet.has(pl.name));
            }
            const musicFolder = device.profile.musicFolder ?? "Music";
            const m3uOpts = {
              musicFolder,
              codecName,
              libraryFolderPaths,
              preserveFolderStructure,
            };
            const writeResult = await writePlaylistsToDevice({
              playlistFolder,
              mountPath: device.profile.mountPath,
              playlistsToWrite,
              core,
              m3uOpts,
              useTagnavi,
              progressCallback: syncOpts.progressCallback,
            });
            playlistsWritten = writeResult.playlistsWritten;
          } catch (err) {
            console.error("[ipc] Sync playlists to device failed:", err);
          }
        }
      }

      // Always detect and optionally remove playlist orphans when device has playlist folder
      // (runs even when not syncing playlists, e.g. includePlaylists=false or custom with none)
      const playlistFolder = device.getContentPath("playlist");
      if (playlistFolder && fs.existsSync(playlistFolder)) {
        try {
          const core = getPlaylistCore();
          const libraryPlaylists = core.getPlaylists();
          const expectedStems = new Set(
            libraryPlaylists
              .filter((pl) => !(useTagnavi && pl.typeName === "smart"))
              .map((pl) =>
                (pl.name.replace(/[/\\?*:"<>|]/g, "_").trim() || "Playlist").toLowerCase()
              )
          );
          const orphanPaths: string[] = [];
          const walkPlaylists = (dir: string): void => {
            let entries: fs.Dirent[];
            try {
              entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
              return;
            }
            for (const entry of entries) {
              const fullPath = path.join(dir, entry.name);
              if (entry.isDirectory()) {
                walkPlaylists(fullPath);
              } else if (path.extname(entry.name).toLowerCase() === ".m3u") {
                const stem = path.parse(entry.name).name.toLowerCase();
                if (!expectedStems.has(stem)) {
                  orphanPaths.push(fullPath);
                }
              }
            }
          };
          walkPlaylists(playlistFolder);
          if (orphanPaths.length > 0) {
            result.extras = [...result.extras, ...orphanPaths];
            syncOpts.progressCallback?.({
              event: "log",
              message: `${orphanPaths.length} orphan playlist(s) on device.`,
            });
            if (opts.extraTrackPolicy === "remove" || opts.extraTrackPolicy === "remove-all") {
              const { removed } = removeExtraTracks(
                orphanPaths,
                syncOpts.progressCallback,
                syncSignal
              );
              result.removed += removed;
              syncOpts.progressCallback?.({
                event: "log",
                message: `Removed ${removed} orphan playlist(s) from device.`,
              });
            }
          }
        } catch (err) {
          console.error("[ipc] Playlist orphan detection failed:", err);
        }
      }

      result.synced += playlistsWritten;

      // Phase 3: PROPAGATE — push canonical ratings back to the device
      try {
        const db = lib.getConnection();
        const propagations = computeRatingPropagations(db, opts.deviceId);

        if (propagations.size > 0) {
          // Build device-relative paths for the changelog
          const deviceMusicFolder = device.profile.musicFolder ?? "Music";

          // For each track to propagate, we need its device filename
          const trackIds = [...propagations.keys()];
          const placeholders = trackIds.map(() => "?").join(",");
          const trackRows = db
            .prepare(
              `SELECT t.id, t.filename FROM tracks t WHERE t.id IN (${placeholders})`
            )
            .all(...trackIds) as { id: number; filename: string }[];

          const entries: import("../rockbox/tagcache").RockboxRatingEntry[] = [];
          const propagatedIds: number[] = [];

          for (const row of trackRows) {
            const rating = propagations.get(row.id);
            if (rating === undefined) continue;
            entries.push({
              filePath: buildDeviceRelativePath(deviceMusicFolder, row.filename),
              rating,
            });
            propagatedIds.push(row.id);
          }

          writeRockboxRatingsChangelog(device.mountPath, entries);
          markRatingsPropagated(db, opts.deviceId, propagatedIds);

          syncOpts.progressCallback?.({
            event: "log",
            message: `Pushed ${entries.length} rating(s) to device. Run "Database → Initialize Now" on the device to apply.`,
          });
        }
      } catch (err) {
        console.error("[ipc] Rating propagation failed (non-fatal):", err);
      }

      activeSyncAbort = null;

      if (result.synced >= 0) {
        try {
          const device = getDevicesCore().getDeviceById(opts.deviceId);
          const prevTotal = device?.profile?.totalSyncedItems ?? 0;
          const newTotal = Math.max(0, prevTotal + result.synced - result.removed);
          getDevicesCore().updateDevice(opts.deviceId, {
            lastSyncDate: new Date().toISOString(),
            lastSyncCount: result.synced,
            totalSyncedItems: newTotal,
          });
          logActivity(
            getLibrary().getConnection(),
            "sync",
            `${device?.name ?? "Device"}: ${result.synced} synced, ${result.removed} removed`
          );
        } catch (e) {
          console.error("[ipc] Update device last sync failed:", e);
        }
      }

      if (result.removed > 0) {
        syncOpts.progressCallback?.({
          event: "log",
          message: `Sync complete. ${result.removed} file(s) removed from device.`,
        });
      }
      syncOpts.progressCallback?.({ event: "complete", path: "", status: "complete" });

      return result;
    })
  );

  ipcMain.handle(
    "sync:cancel",
    safe("sync:cancel", async () => {
      if (activeSyncAbort) {
        activeSyncAbort.abort();
        activeSyncAbort = null;
        return { cancelled: true };
      }
      return { cancelled: false };
    })
  );

  ipcMain.handle(
    "sync:getDevicePreferences",
    safe("sync:getDevicePreferences", async (_e, deviceId: number) =>
      getDeviceSyncPreferences(getLibrary().getConnection(), deviceId))
  );
}
