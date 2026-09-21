import * as path from "path";
import { handle as bridgeHandle } from "../host/bridge";
import {
  safe,
  blockWrongAdmin,
  blockWrongDeviceOwner,
  blockWrongLocality,
  getLibrary,
  getPlaylistCore,
  getDevicesCore,
  buildLibraryTrackMaps,
  remapTrackMapToShadow,
} from "./common";
import { isDeviceOnline, isDeviceMountPathOnline } from "../devices/device-online";
import { ejectDevice, isEjectSupported } from "../devices/device-eject";
import { isSyncActive } from "./sync";
import { refreshUsbSnapshot, listUsbDevices } from "../devices/usb-devices";
import { getDeviceSyncPreferences } from "../sync/device-sync-preferences";
import {
  buildLibraryDestMap,
  getProfileCodecExt,
  type LayoutOptions,
} from "../sync/sync-core";
import { compareLibraries } from "../sync/name-size-sync";
import {
  devicePlaylistStem,
  findOrphanPlaylistFiles,
} from "../sync/playlist-sync";
import { toMountRelative } from "../rockbox/device-path-match";
import { ingestRuntimeDataForDevice } from "../rockbox/runtime-ingest";
import {
  buildAnalysisSummaryFromDb,
  getArtistsFromPlaybackStats,
} from "../playlists/genius-engine";
import { logActivity } from "../activity/activity-logger";
import { invalidateAssistantCache } from "../assistant/assistantChat";
import type { AddDeviceConfig } from "../../shared/types";
import { subjectForSessionId } from "../../server/auth/sessions";

export function registerDeviceHandlers(): void {
  bridgeHandle(
    "device:list",
    safe("device:list", async () => {
      return getDevicesCore().getDevices().map((d) => d.profile);
    })
  );

  bridgeHandle(
    "device:add",
    safe("device:add", async (event, config: AddDeviceConfig) => {
      // **Who may attach a browser-held player is decided here, not by the
      // client.** `device-attach` is otherwise gated only on the row saying
      // `transport = 'web'`, which every allowlisted user can satisfy for
      // every web device — so a second identity could announce someone else's
      // device id, evict them (the per-device mutex detaches the incumbent)
      // and have every subsequent `RemoteDeviceFs` call, and every one-shot
      // data-plane token, routed to a folder of their own choosing. Recording
      // the registering identity is what turns that mutex back into a safety
      // property. Taken from the transport that carried the call, which is the
      // only source a client cannot lie about.
      //
      // A browser may only register a *remote* device. `transport` decides
      // which filesystem every later call uses, and a web client registering
      // `transport: "local"` with a mount path of its choosing would create a
      // row pointing at the server's own disk — which is also how a host
      // volume reached `device:eject`. The renderer already only offers
      // "remote" in a browser; this is the guard behind that courtesy.
      const isWebClient = event.sessionId !== undefined;
      const device = getDevicesCore().addDevice({
        ...config,
        transport: isWebClient ? "web" : config.transport,
        mountPath: isWebClient ? undefined : config.mountPath,
        webOwnerSubject: isWebClient
          ? subjectForSessionId(event.sessionId as string)
          : null,
      });
      logActivity(
        getLibrary().getConnection(),
        "add_device",
        `Added device: ${device.profile.name}`
      );
      invalidateAssistantCache(); // F9: device config changed
      return device.profile;
    })
  );

  bridgeHandle(
    "device:listUsb",
    safe("device:listUsb", async (event) => {
      // A remote browser must never be shown this. The enumeration is of the
      // *server's* USB bus, so over the web it is both nonsense as UX — the
      // user is offered hardware plugged into a machine in another room — and
      // an information leak about the host. A web client gets an empty,
      // explicitly unavailable snapshot, which the picker already knows how to
      // render.
      if (event.sessionId !== undefined) {
        return { available: false, devices: [] };
      }
      // Force a fresh enumeration: the user opens this dropdown precisely when
      // they have just plugged something in, so a cached snapshot is wrong.
      return await listUsbDevices();
    })
  );

  bridgeHandle(
    "device:getModels",
    safe("device:getModels", async () => {
      return getLibrary().getConnection()
        .prepare("SELECT id, name, internal_value, description FROM device_models ORDER BY name")
        .all();
    })
  );

  bridgeHandle(
    "device:getCodecConfigs",
    safe("device:getCodecConfigs", async () => {
      return getLibrary().getConnection().prepare(`
        SELECT cc.id, cc.name, cc.bitrate_value, cc.quality_value,
               cc.bits_per_sample, cc.is_default, c.name as codec_name
        FROM codec_configurations cc
        JOIN codecs c ON cc.codec_id = c.id
        ORDER BY c.name, cc.id
      `).all();
    })
  );

  bridgeHandle(
    "device:setDefault",
    safe("device:setDefault", async (_event, deviceId: number | null) => {
      return getDevicesCore().setDefaultDevice(deviceId);
    })
  );

  bridgeHandle(
    "device:getDefault",
    safe("device:getDefault", async () => {
      return getDevicesCore().getDefaultDeviceId();
    })
  );

  bridgeHandle(
    "device:getSyncedPaths",
    safe("device:getSyncedPaths", async (_event, deviceId: number) => {
      const rows = getLibrary().getConnection()
        .prepare("SELECT library_path FROM device_synced_tracks WHERE device_id = ?")
        .all(deviceId) as { library_path: string }[];
      return rows.map((r) => r.library_path);
    })
  );

  bridgeHandle(
    "device:update",
    safe("device:update", async (event, deviceId: number, updates: Record<string, unknown>) => {
      const existing = getDevicesCore().getDeviceById(deviceId);
      if (!existing) return { error: `Device ${deviceId} not found` };
      const wrongAdmin = blockWrongAdmin(event, existing.profile.transport);
      if (wrongAdmin) return wrongAdmin;
      const notYours = blockWrongDeviceOwner(event, deviceId);
      if (notYours) return notYours;
      const ok = getDevicesCore().updateDevice(deviceId, updates);
      if (!ok) return { error: "Update failed" };
      const device = getDevicesCore().getDeviceById(deviceId)?.profile;
      logActivity(
        getLibrary().getConnection(),
        "update_device",
        `Updated device: ${device?.name ?? deviceId}`
      );
      invalidateAssistantCache(); // F9: device config changed
      return device;
    })
  );

  bridgeHandle(
    "device:remove",
    safe("device:remove", async (event, deviceId: number) => {
      const existing = getDevicesCore().getDeviceById(deviceId);
      if (existing) {
        const wrongAdmin = blockWrongAdmin(event, existing.profile.transport);
        if (wrongAdmin) return wrongAdmin;
        const notYours = blockWrongDeviceOwner(event, deviceId);
        if (notYours) return notYours;
      }
      const result = getDevicesCore().deleteDevice(deviceId);
      invalidateAssistantCache(); // F9: device config changed
      return result;
    })
  );

  bridgeHandle(
    "device:ping",
    safe("device:ping", async (_event, deviceId: number) => {
      const device = getDevicesCore().getDeviceById(deviceId);
      if (!device) return { online: false };
      await refreshUsbSnapshot();
      return { online: isDeviceOnline(device.profile) };
    })
  );

  bridgeHandle(
    "device:eject",
    safe("device:eject", async (event, deviceId: number) => {
      if (!isEjectSupported()) {
        return { error: "Ejecting from iPodRocks is not supported on this platform yet." };
      }
      const device = getDevicesCore().getDeviceById(deviceId);
      if (!device) return { error: "Device not found" };
      // Unmounting is a host-level effect on a volume the caller may not own.
      const wrongMachine = blockWrongLocality(event, device.profile.transport);
      if (wrongMachine) return wrongMachine;
      const notYours = blockWrongDeviceOwner(event, deviceId);
      if (notYours) return notYours;
      const { name, mountPath } = device.profile;

      // Unmounting under a running sync leaves half-copied files behind. The OS
      // would refuse anyway, but "Resource busy" tells the user nothing.
      if (isSyncActive(deviceId)) {
        return { error: "A sync is running. Wait for it to finish before ejecting." };
      }
      // A dev-mode device is an ordinary folder that `isDeviceOnline` reports as
      // online unconditionally — there is no volume to eject.
      if (device.profile.devMode) {
        return { error: `'${name}' is a dev-mode device, so there is nothing to eject.` };
      }
      // Ejecting is something the machine holding the device does, and for a
      // web device that is the user's own browser, not this server. Running
      // `diskutil` here would unmount whatever the server happens to have at
      // that path, which is nothing at all — the root is synthetic.
      if (!device.fs.capabilities.eject) {
        return {
          error:
            `'${name}' is connected through a browser, so it has to be ejected ` +
            "from the computer it is plugged into.",
        };
      }
      // The st_dev check is what separates a live volume from a plain directory
      // or the orphan left behind by a previous eject. Without it we would hand
      // an arbitrary folder to `diskutil eject`.
      if (!isDeviceMountPathOnline(mountPath)) {
        return { error: `'${name}' is not mounted.` };
      }

      const result = await ejectDevice(mountPath);
      if (!result.ok) return { error: result.reason };

      logActivity(
        getLibrary().getConnection(),
        "update_device",
        `Ejected device: ${name}`
      );
      return { ejected: true, name };
    })
  );

  bridgeHandle(
    "device:check",
    safe("device:check", async (event, deviceId: number) => {
      const device = getDevicesCore().getDeviceById(deviceId);
      if (!device) return { error: `Device ${deviceId} not found` };
      const wrongMachine = blockWrongLocality(event, device.profile.transport);
      if (wrongMachine) return wrongMachine;
      const notYours = blockWrongDeviceOwner(event, deviceId);
      if (notYours) return notYours;

      await refreshUsbSnapshot();
      if (!isDeviceOnline(device.profile)) {
        return { offline: true, deviceId, name: device.name };
      }

      const lib = getLibrary();

      const [musicStats, podcastStats, audiobookStats, playlistStats] = await Promise.all([
        device.getContentStats("music"),
        device.getContentStats("podcast"),
        device.getContentStats("audiobook"),
        device.getContentStats("playlist"),
      ]);
      const space = await device.getAvailableSpace();

      const maps = buildLibraryTrackMaps(lib);
      let libraryMusicMap = maps.music;
      let libraryPodcastMap = maps.podcast;
      let libraryAudiobookMap = maps.audiobook;

      let codecName = device.profile.codecName ?? "copy";
      let profileCodecExt: string | null = null;
      const folders = lib.getLibraryFolders();
      const libraryFolderPaths = new Map<number, string>();
      for (const f of folders) {
        libraryFolderPaths.set(f.id, f.path);
      }

      const checkPrefs = getDeviceSyncPreferences(lib.getConnection(), deviceId);
      const preserveFolderStructure = checkPrefs?.preserveFolderStructure !== false;
      const albumGrouping = checkPrefs?.albumGrouping ?? "album-artist";
      // The check must predict the exact paths a sync would write, so it reads
      // the layout from the same object shape the sync itself uses.
      const layout: LayoutOptions = {
        libraryFolderPaths,
        preserveFolderStructure,
        albumGrouping,
      };

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

        libraryMusicMap = remapTrackMapToShadow(libraryMusicMap, shadowTrackMap);
        libraryPodcastMap = remapTrackMapToShadow(libraryPodcastMap, shadowTrackMap);
        libraryAudiobookMap = remapTrackMapToShadow(libraryAudiobookMap, shadowTrackMap);

        if (shadowLib) {
          for (const [folderId] of libraryFolderPaths) {
            libraryFolderPaths.set(folderId, shadowLib.path);
          }
          profileCodecExt = getProfileCodecExt(shadowLib.codecName ?? "");
        }
      }

      if (profileCodecExt === null) {
        profileCodecExt = getProfileCodecExt(codecName);
      }

      const [deviceMusicRaw, devicePodcastRaw, deviceAudiobookRaw] = await Promise.all([
        device.getTracks("music"),
        device.getTracks("podcast"),
        device.getTracks("audiobook"),
      ]);
      const deviceMusicMap: Record<string, { file_size: number; mtime?: number }> = {};
      for (const [p, info] of deviceMusicRaw) {
        deviceMusicMap[p] = {
          file_size: info.fileSize ?? 0,
          ...(info.mtimeMs != null && { mtime: info.mtimeMs }),
        };
      }
      const devicePodcastMap: Record<string, { file_size: number; mtime?: number }> = {};
      for (const [p, info] of devicePodcastRaw) {
        devicePodcastMap[p] = {
          file_size: info.fileSize ?? 0,
          ...(info.mtimeMs != null && { mtime: info.mtimeMs }),
        };
      }
      const deviceAudiobookMap: Record<string, { file_size: number; mtime?: number }> = {};
      for (const [p, info] of deviceAudiobookRaw) {
        deviceAudiobookMap[p] = {
          file_size: info.fileSize ?? 0,
          ...(info.mtimeMs != null && { mtime: info.mtimeMs }),
        };
      }

      const musicDest = buildLibraryDestMap(
        libraryMusicMap,
        "music",
        codecName,
        layout
      );
      const musicCompare = compareLibraries(
        musicDest.destMap,
        musicDest.expectedSizes,
        device.getContentPath("music"),
        deviceMusicMap,
        {
          profileCodecExt,
          libraryExpectedMtimes: musicDest.expectedMtimes,
        }
      );

      const podcastDest = buildLibraryDestMap(
        libraryPodcastMap,
        "podcast",
        codecName,
        layout
      );
      const podcastCompare = compareLibraries(
        podcastDest.destMap,
        podcastDest.expectedSizes,
        device.getContentPath("podcast"),
        devicePodcastMap,
        {
          profileCodecExt,
          libraryExpectedMtimes: podcastDest.expectedMtimes,
        }
      );

      const audiobookDest = buildLibraryDestMap(
        libraryAudiobookMap,
        "audiobook",
        codecName,
        layout
      );
      const audiobookCompare = compareLibraries(
        audiobookDest.destMap,
        audiobookDest.expectedSizes,
        device.getContentPath("audiobook"),
        deviceAudiobookMap,
        {
          profileCodecExt,
          libraryExpectedMtimes: audiobookDest.expectedMtimes,
        }
      );

      const playlistFolder = device.getContentPath("playlist");
      let playlistOrphans: string[] = [];
      if (playlistFolder && (await device.fs.exists(playlistFolder))) {
        const core = getPlaylistCore();
        const libraryPlaylists = core.getPlaylists();
        const expectedStems = new Set(
          libraryPlaylists.map((pl) => devicePlaylistStem(pl.name).toLowerCase())
        );
        playlistOrphans = await findOrphanPlaylistFiles(
          device.fs,
          playlistFolder,
          expectedStems
        );
      }

      // Keep the on-device location alongside the library path. Rockbox
      // reports its runtime counters and ratings against the device path, and
      // this walk is the only place that knows, for certain, where each track
      // actually landed -- deriving it later from the sync layout would only
      // ever be a re-guess.
      const matchedTracks = [
        ...musicCompare.tracksToSkip,
        ...podcastCompare.tracksToSkip,
        ...audiobookCompare.tracksToSkip,
      ];
      const conn = lib.getConnection();
      conn.prepare("DELETE FROM device_synced_tracks WHERE device_id = ?").run(deviceId);
      const insertStmt = conn.prepare(
        "INSERT OR REPLACE INTO device_synced_tracks (device_id, library_path, device_path) VALUES (?, ?, ?)"
      );
      for (const t of matchedTracks) {
        insertStmt.run(
          deviceId,
          t.library_path,
          toMountRelative(t.device_path, device.mountPath)
        );
      }

      const totalOnDevice = matchedTracks.length;
      getDevicesCore().updateDevice(deviceId, {
        totalSyncedItems: totalOnDevice,
      });

      // Import runtime data now rather than at the top of the handler: the walk
      // above has just recorded where every track actually sits on the device,
      // which is what lets Rockbox's records be matched exactly instead of by
      // filename — including on a device being checked for the first time.
      if (!device.profile.skipRuntimeData) {
        const ingest = await ingestRuntimeDataForDevice(conn, deviceId, device, false);
        if (ingest.imported > 0) {
          logActivity(
            conn,
            "read_runtime_data",
            `${device.name} (check): ${ingest.imported} track(s) imported, ${ingest.unmatched} unmatched`
          );
        }
      }

      return {
        deviceId,
        name: device.name,
        music: musicStats,
        podcasts: podcastStats,
        audiobooks: audiobookStats,
        playlists: playlistStats,
        disk: space,
        musicSyncedWithLibrary: musicCompare.tracksToSkip.length,
        musicOrphans: musicCompare.extras.length,
        musicCodecMismatch: musicCompare.codecMismatchPaths.length,
        musicToSync: musicCompare.missingTracks.size,
        podcastSyncedWithLibrary: podcastCompare.tracksToSkip.length,
        podcastOrphans: podcastCompare.extras.length,
        podcastCodecMismatch: podcastCompare.codecMismatchPaths.length,
        podcastToSync: podcastCompare.missingTracks.size,
        audiobookSyncedWithLibrary: audiobookCompare.tracksToSkip.length,
        audiobookOrphans: audiobookCompare.extras.length,
        audiobookCodecMismatch: audiobookCompare.codecMismatchPaths.length,
        audiobookToSync: audiobookCompare.missingTracks.size,
        playlistOrphans: playlistOrphans.length,
        profileCodecName: codecName,
        orphansMusicPaths: musicCompare.extras,
        orphansPodcastPaths: podcastCompare.extras,
        orphansAudiobookPaths: audiobookCompare.extras,
        orphansPlaylistPaths: playlistOrphans,
      };
    })
  );

  bridgeHandle(
    "device:readRuntimeData",
    safe("device:readRuntimeData", async (event, deviceId: number) => {
      const device = getDevicesCore().getDeviceById(deviceId);
      if (!device) return { error: `Device ${deviceId} not found` };
      // Same device.fs surface as `device:check`, which has always been gated.
      const wrongMachine = blockWrongLocality(event, device.profile.transport);
      if (wrongMachine) return wrongMachine;
      const notYours = blockWrongDeviceOwner(event, deviceId);
      if (notYours) return notYours;

      await refreshUsbSnapshot();
      if (!isDeviceOnline(device.profile)) {
        return {
          offline: true,
          error: "Device not connected",
          imported: 0,
          unmatched: 0,
        };
      }

      const lib = getLibrary();
      const db = lib.getConnection();
      const ingest = await ingestRuntimeDataForDevice(
        db,
        deviceId,
        device,
        device.profile.skipRuntimeData ?? false
      );
      logActivity(
        db,
        "read_runtime_data",
        `${device.name}: ${ingest.imported} track(s) imported, ${ingest.unmatched} unmatched`
      );
      return {
        imported: ingest.imported,
        unmatched: ingest.unmatched,
        newPlays: ingest.newPlays,
        // Null when the import succeeded — the UI only needs a reason when it
        // has nothing to show, and "this track was never played" is not one.
        reason: ingest.state.kind === "ok" ? null : ingest.state.message,
        summary: buildAnalysisSummaryFromDb(db),
        artists: getArtistsFromPlaybackStats(db),
      };
    })
  );
}
