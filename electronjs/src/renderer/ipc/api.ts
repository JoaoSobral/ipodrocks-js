import type {
  Track,
  LibraryFolder,
  DeviceProfile,
  AddDeviceConfig,
  ScanResult,
  SyncOptions,
  ScanProgress,
  SyncProgress,
  Playlist,
  PlaylistTrack,
  SmartPlaylistRule,
  GenreInfo,
  ArtistInfo,
  AlbumInfo,
  AnalysisSummary,
  GeniusTypeOption,
  GeniusGenerateOptions,
  PlaylistGenerationResult,
  ShadowLibrary,
  ShadowBuildProgress,
} from "@shared/types";

export type {
  Track,
  LibraryFolder,
  DeviceProfile,
  AddDeviceConfig,
  ScanResult,
  SyncOptions,
  ScanProgress,
  SyncProgress,
  Playlist,
  PlaylistTrack,
  SmartPlaylistRule,
  GenreInfo,
  ArtistInfo,
  AlbumInfo,
  AnalysisSummary,
  GeniusTypeOption,
  GeniusGenerateOptions,
  PlaylistGenerationResult,
  ShadowLibrary,
  ShadowBuildProgress,
};

export interface LibraryStats {
  totalTracks: number;
  totalAlbums: number;
  totalArtists: number;
  totalSizeBytes: number;
  podcastTrackCount?: number;
  audiobookTrackCount?: number;
}

export interface TrackFilter {
  contentType?: string;
  limit?: number;
  offset?: number;
}

export interface CheckResult {
  deviceId: number;
  name: string;
  music: { fileCount: number; totalGb: number };
  podcasts: { fileCount: number; totalGb: number };
  audiobooks?: { fileCount: number; totalGb: number };
  playlists?: { fileCount: number; totalGb: number };
  disk: { totalBytes: number; freeBytes: number; totalGb: number; freeGb: number };
  musicSyncedWithLibrary?: number;
  musicOrphans?: number;
  podcastSyncedWithLibrary?: number;
  podcastOrphans?: number;
  audiobookSyncedWithLibrary?: number;
  audiobookOrphans?: number;
  orphansMusicPaths?: string[];
  orphansPodcastPaths?: string[];
  orphansAudiobookPaths?: string[];
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

export async function getTracks(filter?: TrackFilter): Promise<Track[]> {
  return window.api.invoke("library:getTracks", filter) as Promise<Track[]>;
}

export async function getLibraryStats(): Promise<LibraryStats> {
  return window.api.invoke("library:getStats") as Promise<LibraryStats>;
}

export async function getLibraryFolders(): Promise<LibraryFolder[]> {
  return window.api.invoke("library:getFolders") as Promise<LibraryFolder[]>;
}

export async function addLibraryFolder(
  name: string,
  path: string,
  contentType: string,
): Promise<LibraryFolder> {
  return window.api.invoke("library:addFolder", { name, path, contentType }) as Promise<LibraryFolder>;
}

export async function scanLibrary(
  folders: Array<{ name: string; path: string; contentType: string }>,
): Promise<ScanResult> {
  return window.api.invoke("library:scan", { folders }) as Promise<ScanResult>;
}

export async function scanCancel(): Promise<{ cancelled: boolean }> {
  return window.api.invoke("scan:cancel") as Promise<{ cancelled: boolean }>;
}

// ---------------------------------------------------------------------------
// App (prefs, tool availability)
// ---------------------------------------------------------------------------

export async function isMpcencAvailable(): Promise<{ available: boolean }> {
  return window.api.invoke("app:isMpcencAvailable") as Promise<{
    available: boolean;
  }>;
}

export async function getMpcRemindDisabled(): Promise<{ disabled: boolean }> {
  return window.api.invoke("app:getMpcRemindDisabled") as Promise<{
    disabled: boolean;
  }>;
}

export async function setMpcRemindDisabled(
  disabled: boolean
): Promise<void> {
  return window.api.invoke("app:setMpcRemindDisabled", disabled) as Promise<
    void
  >;
}

// ---------------------------------------------------------------------------
// Shadow Libraries
// ---------------------------------------------------------------------------

export async function getShadowLibraries(): Promise<ShadowLibrary[]> {
  return window.api.invoke("shadow:getAll") as Promise<ShadowLibrary[]>;
}

export async function createShadowLibrary(
  name: string,
  path: string,
  codecConfigId: number,
): Promise<ShadowLibrary> {
  return window.api.invoke("shadow:create", {
    name,
    path,
    codecConfigId,
  }) as Promise<ShadowLibrary>;
}

export async function deleteShadowLibrary(
  id: number,
  keepFilesOnDisk = false
): Promise<boolean> {
  return window.api.invoke("shadow:delete", id, keepFilesOnDisk) as Promise<
    boolean
  >;
}

export async function rebuildShadowLibrary(id: number): Promise<unknown> {
  return window.api.invoke("shadow:rebuild", id);
}

export async function cancelShadowBuild(): Promise<{ cancelled: boolean }> {
  return window.api.invoke("shadow:cancelBuild") as Promise<{
    cancelled: boolean;
  }>;
}

export function onShadowBuildProgress(
  cb: (progress: ShadowBuildProgress) => void,
): () => void {
  return window.api.on(
    "shadow:buildProgress",
    cb as (...args: unknown[]) => void,
  );
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export interface DeviceModel {
  id: number;
  name: string;
  internal_value: string;
  description: string | null;
}

export interface CodecConfig {
  id: number;
  name: string;
  bitrate_value: number | null;
  quality_value: number | null;
  bits_per_sample: number | null;
  is_default: number;
  codec_name: string;
}

export async function getDevices(): Promise<DeviceProfile[]> {
  return window.api.invoke("device:list") as Promise<DeviceProfile[]>;
}

export async function addDevice(config: AddDeviceConfig): Promise<DeviceProfile> {
  return window.api.invoke("device:add", config) as Promise<DeviceProfile>;
}

export async function updateDevice(
  deviceId: number,
  updates: Record<string, unknown>
): Promise<DeviceProfile | { error: string }> {
  return window.api.invoke("device:update", deviceId, updates) as Promise<
    DeviceProfile | { error: string }
  >;
}

export async function getDeviceModels(): Promise<DeviceModel[]> {
  return window.api.invoke("device:getModels") as Promise<DeviceModel[]>;
}

export async function getCodecConfigs(): Promise<CodecConfig[]> {
  return window.api.invoke("device:getCodecConfigs") as Promise<CodecConfig[]>;
}

export async function setDefaultDevice(deviceId: number | null): Promise<boolean> {
  return window.api.invoke("device:setDefault", deviceId) as Promise<boolean>;
}

export async function getDefaultDeviceId(): Promise<number | null> {
  return window.api.invoke("device:getDefault") as Promise<number | null>;
}

export async function getDeviceSyncedPaths(deviceId: number): Promise<string[]> {
  return window.api.invoke("device:getSyncedPaths", deviceId) as Promise<string[]>;
}

export async function checkDevice(deviceId: number): Promise<CheckResult> {
  return window.api.invoke("device:check", deviceId) as Promise<CheckResult>;
}

export async function removeDevice(deviceId: number): Promise<void> {
  await window.api.invoke("device:remove", deviceId);
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export async function startSync(options: SyncOptions): Promise<unknown> {
  return window.api.invoke("sync:start", options);
}

export async function cancelSync(): Promise<void> {
  await window.api.invoke("sync:cancel");
}

// ---------------------------------------------------------------------------
// Playlists
// ---------------------------------------------------------------------------

export async function removeLibraryFolder(id: number): Promise<void> {
  await window.api.invoke("library:removeFolder", id);
}

/** Clear the content_hashes table (scan cache). Returns number of rows removed. */
export async function clearContentHashes(): Promise<number> {
  return window.api.invoke("library:clearContentHashes") as Promise<number>;
}

export async function pickFolder(): Promise<string | null> {
  return window.api.invoke("dialog:pickFolder") as Promise<string | null>;
}

export async function getPlaylists(): Promise<Playlist[]> {
  return window.api.invoke("playlist:list") as Promise<Playlist[]>;
}

export async function getPlaylistTracks(playlistId: number): Promise<PlaylistTrack[]> {
  return window.api.invoke("playlist:getTracks", playlistId) as Promise<PlaylistTrack[]>;
}

export async function createPlaylist(config: {
  name: string;
  strategy: string;
  trackLimit?: number;
  rules?: SmartPlaylistRule[];
}): Promise<Playlist> {
  return window.api.invoke("playlist:create", config) as Promise<Playlist>;
}

export async function deletePlaylist(id: number): Promise<void> {
  await window.api.invoke("playlist:delete", id);
}

export async function exportPlaylist(id: number, deviceId?: number): Promise<string> {
  return window.api.invoke("playlist:export", id, deviceId) as Promise<string>;
}

export async function getGenres(): Promise<GenreInfo[]> {
  return window.api.invoke("playlist:getGenres") as Promise<GenreInfo[]>;
}

export async function getArtists(): Promise<ArtistInfo[]> {
  return window.api.invoke("playlist:getArtists") as Promise<ArtistInfo[]>;
}

export async function getAlbums(): Promise<AlbumInfo[]> {
  return window.api.invoke("playlist:getAlbums") as Promise<AlbumInfo[]>;
}

// ---------------------------------------------------------------------------
// Genius Playlists
// ---------------------------------------------------------------------------

export interface AnalyzeResult {
  summary: AnalysisSummary;
  artists: Array<{ name: string; playCount: number }>;
  error?: string;
}

export async function analyzeDevicePlayback(
  deviceId: number
): Promise<AnalyzeResult> {
  return window.api.invoke(
    "genius:analyze",
    deviceId
  ) as Promise<AnalyzeResult>;
}

export async function getGeniusTypes(): Promise<GeniusTypeOption[]> {
  return window.api.invoke("genius:types") as Promise<GeniusTypeOption[]>;
}

export async function generateGeniusPlaylist(
  deviceId: number,
  geniusType: string,
  opts: GeniusGenerateOptions
): Promise<PlaylistGenerationResult> {
  return window.api.invoke(
    "genius:generate",
    deviceId,
    geniusType,
    opts
  ) as Promise<PlaylistGenerationResult>;
}

export async function saveGeniusPlaylist(
  name: string,
  geniusType: string,
  deviceId: number,
  trackIds: number[],
  trackLimit: number
): Promise<Playlist> {
  return window.api.invoke(
    "genius:save",
    name,
    geniusType,
    deviceId,
    trackIds,
    trackLimit
  ) as Promise<Playlist>;
}

// ---------------------------------------------------------------------------
// Event subscriptions
// ---------------------------------------------------------------------------

export function onScanProgress(cb: (progress: ScanProgress) => void): () => void {
  return window.api.on("scan:progress", cb as (...args: unknown[]) => void);
}

export function onSyncProgress(cb: (progress: SyncProgress) => void): () => void {
  return window.api.on("sync:progress", cb as (...args: unknown[]) => void);
}
