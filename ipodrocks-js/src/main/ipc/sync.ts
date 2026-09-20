import * as path from "path";
import { handle as bridgeHandle } from "../host/bridge";
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
import {
  devicePlaylistStem,
  findOrphanPlaylistFiles,
  writePlaylistsToDevice,
} from "../sync/playlist-sync";
import { syncPodcastsToDevice } from "../podcasts/podcast-device-sync";
import { syncAutoAudiobooksToDevice } from "../audiobooks/audiobook-device-sync";
import { listSubscriptions as listAudiobookSubs } from "../audiobooks/audiobook-subscriptions";
import {
  detectRebuiltDatabase,
  ingestDeviceRatings,
  invalidatePushedRatings,
} from "../sync/rating-merge";
import { propagateRatingsForDevice } from "../sync/rating-propagate";
import { ingestRuntimeDataForDevice } from "../rockbox/runtime-ingest";
import { logActivity } from "../activity/activity-logger";
import { resetDeviceContent } from "../sync/device-reset";
import type {
  SyncOptions,
  DeviceSyncPreferences,
  ContentType,
} from "../../shared/types";
import { albumLabelsForTrack } from "../../shared/album-label";

/**
 * The sync running on each device, if any.
 *
 * This was one module-level controller, which was correct for exactly one
 * window and one device. A second `sync:start` overwrote the first's
 * controller, so `sync:cancel` then cancelled the wrong sync and
 * {@link isSyncActive} — which `device:eject` depends on to refuse unmounting
 * under a running copy — answered about whichever sync started last.
 */
const activeSyncAborts = new Map<number, AbortController>();

/**
 * Is a sync running right now — on `deviceId`, or on any device at all?
 *
 * Exposed for `device:eject`, which must refuse mid-sync: unmounting under a
 * running copy leaves half-written files behind, and the OS would fail the
 * unmount with an opaque "Resource busy" anyway. Ejecting one player has no
 * reason to care about a sync running on another, so callers that know which
 * device they mean should say so.
 */
export function isSyncActive(deviceId?: number): boolean {
  if (deviceId === undefined) return activeSyncAborts.size > 0;
  return activeSyncAborts.has(deviceId);
}

export function registerSyncHandlers(): void {
  bridgeHandle(
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
        albumGrouping: opts.albumGrouping ?? "album-artist",
        selections: opts.selections ?? emptySelections(),
      } satisfies DeviceSyncPreferences);

      const preserveFolderStructure = opts.preserveFolderStructure !== false;
      const albumGrouping = opts.albumGrouping ?? "album-artist";

      // A second sync of the *same* device would still clobber this entry, but
      // that is already refused upstream; two different devices no longer
      // interfere.
      const syncAbort = new AbortController();
      activeSyncAborts.set(opts.deviceId, syncAbort);
      const syncSignal = syncAbort.signal;

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
          const artist = (String(t.artist ?? "Unknown Artist")).trim();
          const genre = (String(t.genre ?? "Unknown Genre")).trim();
          // Issue #113: check the label for the active grouping *and* the legacy
          // track-artist label, so selections saved before the album-artist
          // change keep matching after an upgrade instead of silently emptying.
          const labels = albumLabelsForTrack(
            {
              album: t.album as string | undefined,
              artist: t.artist as string | undefined,
              albumArtist: t.albumArtist as string | undefined,
            },
            albumGrouping
          );
          return (
            labels.some((label) => albumSet.has(label)) ||
            artistSet.has(artist) ||
            genreSet.has(genre)
          );
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
          profileCodecExtOverride = getProfileCodecExt(shadowLib.codecName ?? "");
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
        artworkMaxDimension: device.profile.artworkMaxDimension,
        preserveFolderStructure,
        albumGrouping,
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
        artworkErrors: number;
      } = { status: "completed", synced: 0, removed: 0, extras: [], missingFiles: [], errors: 0, artworkErrors: 0 };

      // A removing policy has to visit a content type even when this sync has
      // nothing to copy there: an orphan on the device is an orphan whether or
      // not the selection covers podcasts. `runSync` handles an empty library
      // map correctly — no track is "missing", every device file is an extra —
      // so the sweep needs no separate deletion path. Gated on the policy being
      // an explicit user choice, never inferred, so a library that came back
      // empty because a scan failed can't be read as "delete everything".
      const sweepsOrphans =
        opts.extraTrackPolicy === "remove" || opts.extraTrackPolicy === "delete-all";
      const hasFilesOnDevice = async (contentType: ContentType): Promise<boolean> => {
        const contentPath = device.getContentPath(contentType);
        return !!contentPath && (await device.fs.exists(contentPath));
      };

      const willRunMusic =
        Object.keys(musicLibraryTracks).length > 0 ||
        (sweepsOrphans && (await hasFilesOnDevice("music")));
      const willRunPodcast =
        Object.keys(podcastLibraryTracks).length > 0 ||
        (sweepsOrphans && (await hasFilesOnDevice("podcast")));
      const willRunAudiobook =
        Object.keys(audiobookLibraryTracks).length > 0 ||
        (sweepsOrphans && (await hasFilesOnDevice("audiobook")));
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
        activeSyncAborts.delete(opts.deviceId);
        return { error: emptyMessage };
      }

      const deviceMusicPath = device.getContentPath("music");
      try {
        await device.fs.mkdir(deviceMusicPath, { recursive: true });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EACCES") {
          activeSyncAborts.delete(opts.deviceId);
          return {
            error:
              `Permission denied writing to device (${deviceMusicPath}). ` +
              "Ensure the device is mounted with write access and you have permission to create folders. " +
              "On Linux, try ejecting and reconnecting the device, or check mount permissions.",
          };
        }
        throw err;
      }

      // Read Rockbox's runtime data once. It carries the play counters and the
      // ratings together, plus the index position of each record — which is
      // what Phase 3 needs to write a rating back without re-reading the
      // device database.
      let runtimeImport: Awaited<ReturnType<typeof ingestRuntimeDataForDevice>> | null = null;
      try {
        syncOpts.progressCallback?.({
          event: "log",
          message: "Reading runtime data from device...",
        });
        runtimeImport = await ingestRuntimeDataForDevice(
          lib.getConnection(),
          opts.deviceId,
          device,
          device.profile.skipRuntimeData ?? false
        );
        if (runtimeImport.imported > 0) {
          const played = runtimeImport.newPlays > 0
            ? `, ${runtimeImport.newPlays} newly played`
            : "";
          syncOpts.progressCallback?.({
            event: "log",
            message: `Imported runtime data for ${runtimeImport.imported} track(s)${played}.`,
          });
        } else if (
          runtimeImport.state.kind !== "ok" &&
          !device.profile.skipRuntimeData
        ) {
          syncOpts.progressCallback?.({
            event: "log",
            message: runtimeImport.state.message,
          });
        }
        if (runtimeImport.unmatched > 0) {
          syncOpts.progressCallback?.({
            event: "log",
            message: `${runtimeImport.unmatched} runtime record(s) matched no library track.`,
          });
        }
      } catch (err) {
        console.error("[ipc] Runtime data import failed (non-fatal):", err);
      }

      // Set when Phase 1 detects a rebuild, so Phase 3's log describes a
      // repair rather than routine propagation.
      let rebuildRepairPending = false;

      // Phase 1: INGEST — merge the device's ratings into the canonical DB
      try {
        if (runtimeImport && runtimeImport.ratings.size > 0) {
          const db = lib.getConnection();

          // Decided before the merge, not after it. The old order ran the
          // merge and then printed "ratings were skipped", which was never
          // true: on a genuinely rebuilt device the library's ratings had
          // already been overwritten by the time the warning appeared.
          const rebuild = detectRebuiltDatabase(
            db,
            opts.deviceId,
            runtimeImport.ratings,
            runtimeImport.serial
          );

          if (rebuild.looksRebuilt) {
            const repair = invalidatePushedRatings(db, opts.deviceId);
            rebuildRepairPending = true;
            syncOpts.progressCallback?.({
              event: "log",
              message:
                `Warning: ${rebuild.reason} — the device's database looks rebuilt. ` +
                "Its ratings were not imported; your library ratings are unchanged " +
                "and will be re-sent to the device later in this sync.",
            });
            if (repair.conflictsResolved > 0) {
              syncOpts.progressCallback?.({
                event: "log",
                message:
                  `Closed ${repair.conflictsResolved} rating conflict(s) for this device — ` +
                  "the disputed value no longer exists on the rebuilt device.",
              });
            }
          } else {
            const ingestResult = ingestDeviceRatings(
              db,
              opts.deviceId,
              runtimeImport.ratings
            );
            const total =
              ingestResult.adopted + ingestResult.converged + ingestResult.conflicts;
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

      // "Delete all" — erase the content folders BEFORE the device is
      // enumerated. `runSync` compares the library against the listing read
      // from the device, so a wipe after that listing would leave the sync
      // convinced everything is still there and copy nothing back.
      if (opts.extraTrackPolicy === "delete-all") {
        const reset = await resetDeviceContent(device, lib.getConnection(), opts.deviceId, {
          progressCallback: syncOpts.progressCallback,
          cancelSignal: syncSignal,
        });
        if (syncSignal.aborted) throw new SyncCancelled();
        syncOpts.progressCallback?.({
          event: "log",
          message: `Delete all: cleared ${reset.reset.length} content folder(s); rebuilding from the library.`,
        });
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
        result.artworkErrors += musicResult.artworkErrors;
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
        result.artworkErrors += podcastResult.artworkErrors;
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
        result.artworkErrors += audiobookResult.artworkErrors;
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

      if (result.errors > 0 || result.artworkErrors > 0) result.status = "error";

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
              albumGrouping,
            };
            const writeResult = await writePlaylistsToDevice({
              deviceFs: device.fs,
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
      if (playlistFolder && (await device.fs.exists(playlistFolder))) {
        try {
          const core = getPlaylistCore();
          const libraryPlaylists = core.getPlaylists();
          const expectedStems = new Set(
            libraryPlaylists
              .filter((pl) => !(useTagnavi && pl.typeName === "smart"))
              .map((pl) => devicePlaylistStem(pl.name).toLowerCase())
          );
          const orphanPaths = await findOrphanPlaylistFiles(
            device.fs,
            playlistFolder,
            expectedStems
          );
          if (orphanPaths.length > 0) {
            result.extras = [...result.extras, ...orphanPaths];
            syncOpts.progressCallback?.({
              event: "log",
              message: `${orphanPaths.length} orphan playlist(s) on device.`,
            });
            if (sweepsOrphans) {
              const { removed } = await removeExtraTracks(
                device.fs,
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

      // Phase 3: PROPAGATE — push canonical ratings back to the device.
      //
      // The loop itself lives in `sync/rating-propagate.ts` so it can be tested;
      // inline here it never was, and three silent-loss bugs lived in it until
      // issue #138. This side only reports what it did.
      try {
        // `state.kind === "ok"` and not merely a non-null `runtimeImport`:
        // `readAndIngestRuntimeData` returns a fully empty result — `idxIds`
        // included — for a device with runtime data turned off, no `.rockbox`
        // database, an unreadable one, one Rockbox is mid-update, and one that
        // has never recorded a play. Running the loop against an empty `idxIds`
        // cannot write anything, and would count every rated track as "waiting
        // for the device's database" and hand the user an instruction that
        // cannot help. Those states already printed their own message above.
        if (runtimeImport && runtimeImport.state.kind === "ok") {
          // The index positions come from this sync's own read, because a
          // "Database → Initialize Now" on the device renumbers every entry —
          // they are never cached across runs.
          // What this sync actually sent here, so a rating "waiting for the
          // device's database" can be told from one belonging to a track that was
          // never sent at all — a partial selection, or a second, smaller player.
          // Read off the same maps `runSync` copied from, after the shadow remap,
          // which keeps the library track id either way.
          const selectedTrackIds = new Set<number>();
          for (const map of [
            musicLibraryTracks,
            podcastLibraryTracks,
            audiobookLibraryTracks,
          ]) {
            for (const info of Object.values(map)) {
              const id = info.id;
              if (typeof id === "number") selectedTrackIds.add(id);
            }
          }

          const report = await propagateRatingsForDevice(
            lib.getConnection(),
            opts.deviceId,
            device,
            runtimeImport.idxIds,
            selectedTrackIds
          );

          if (report.written > 0) {
            syncOpts.progressCallback?.({
              event: "log",
              message: rebuildRepairPending
                ? `Restored ${report.written} rating(s) to the device after the rebuilt database was repaired.`
                : `Wrote ${report.written} rating(s) to the device. Restart Rockbox for them to show on screen — the values are already saved.`,
            });
          }

          // The reporter's actual complaint: an album copied this sync cannot
          // have its ratings written, because Rockbox does not know the files
          // exist until its database is updated. Saying nothing made that look
          // like ratings being dropped (issue #138).
          if (report.notInDeviceDb > 0) {
            syncOpts.progressCallback?.({
              event: "log",
              message:
                `${report.notInDeviceDb} rating(s) are waiting for the device's database — ` +
                "those tracks aren't in it yet. On the player, run Database → Update now " +
                "(or restart it with Auto Update on), then sync again.",
            });
          }

          if (report.unavailable > 0) {
            syncOpts.progressCallback?.({
              event: "log",
              message:
                `Could not write ${report.unavailable} rating(s): the device's database is ` +
                "missing, or Rockbox is updating it. They'll be re-sent on the next sync.",
            });
          }

          if (report.failed > 0) {
            syncOpts.progressCallback?.({
              event: "log",
              message:
                `Warning: ${report.failed} rating(s) could not be written to the device's ` +
                "database. They'll be retried on the next sync.",
            });
          }
        }
      } catch (err) {
        console.error("[ipc] Rating propagation failed (non-fatal):", err);
      }

      activeSyncAborts.delete(opts.deviceId);

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

  bridgeHandle(
    "sync:cancel",
    // A device id cancels that device's sync; without one every running sync
    // is cancelled, which is what the renderer has always meant by "cancel"
    // when only one could ever be running.
    safe("sync:cancel", async (_event, deviceId?: number) => {
      const targets =
        deviceId === undefined
          ? [...activeSyncAborts.keys()]
          : activeSyncAborts.has(deviceId)
            ? [deviceId]
            : [];
      for (const id of targets) {
        activeSyncAborts.get(id)?.abort();
        activeSyncAborts.delete(id);
      }
      return { cancelled: targets.length > 0 };
    })
  );

  bridgeHandle(
    "sync:getDevicePreferences",
    safe("sync:getDevicePreferences", async (_e, deviceId: number) =>
      getDeviceSyncPreferences(getLibrary().getConnection(), deviceId))
  );
}
