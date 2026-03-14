export interface Track {
  id: number;
  path: string;
  filename: string;
  title: string;
  artist: string;
  album: string;
  genre: string;
  codec: string;
  duration: number;
  bitrate: number;
  bitsPerSample: number;
  fileSize: number;
  contentType: string;
  libraryFolderId: number;
  fileHash: string;
  metadataHash: string;
  trackNumber: number;
  discNumber: number;
  playCount: number;
}

export interface Device {
  id: number;
  name: string;
  mountPath: string;
  musicFolder: string;
  podcastFolder: string;
  audiobookFolder: string;
  playlistFolder: string;
  modelId: number | null;
  defaultCodecConfigId: number | null;
}

export interface DeviceProfile extends Device {
  description: string | null;
  lastSyncDate: string | null;
  totalSyncedItems: number;
  lastSyncCount: number;
  defaultTransferModeId: number;
  overrideBitrate: number | null;
  overrideQuality: number | null;
  overrideBits: number | null;
  partialSyncEnabled: boolean;
  sourceLibraryType: "primary" | "shadow";
  shadowLibraryId: number | null;
  transferModeName: string | null;
  codecConfigName: string | null;
  codecConfigBitrate: number | null;
  codecConfigQuality: number | null;
  codecConfigBits: number | null;
  codecName: string | null;
  modelName: string | null;
  modelInternalValue: string | null;
  skipPlaybackLog?: boolean;
}

export type ContentType = "music" | "podcast" | "audiobook" | "playlist";

export interface DeviceTrackInfo {
  filename: string;
  fileSize: number;
  exists: boolean;
  /** Modification time in ms (from stat.mtimeMs), if available. */
  mtimeMs?: number;
}

export interface DiskSpace {
  totalBytes: number;
  freeBytes: number;
  totalGb: number;
  freeGb: number;
}

export interface ContentStats {
  fileCount: number;
  totalGb: number;
}

export interface FitCheck {
  canFit: boolean;
  requiredGb: number;
  availableGb: number;
  remainingGb: number;
}

export interface AddDeviceConfig {
  name: string;
  mountPath: string;
  defaultCodecConfigId?: number | null;
  musicFolder?: string;
  podcastFolder?: string;
  audiobookFolder?: string;
  playlistFolder?: string;
  description?: string | null;
  modelId?: number | null;
  sourceLibraryType?: "primary" | "shadow";
  shadowLibraryId?: number | null;
  skipPlaybackLog?: boolean;
}

export interface DeviceValidation {
  valid: boolean;
  error: string | null;
  normalizedPath?: string;
  foldersCreated?: string[];
}

export interface LibraryFolder {
  id: number;
  name: string;
  path: string;
  contentType: string;
}

export interface Playlist {
  id: number;
  name: string;
  description: string;
  typeName: string;
  trackCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PlaylistTrack {
  id: number;
  path: string;
  filename: string;
  title: string;
  artist: string;
  album: string;
  genre: string;
  duration: number;
  libraryFolderId?: number;
  playCount?: number;
  totalPlaytime?: number;
  avgPlaytime?: number;
  avgCompletionRate?: number;
  completionRate?: number;
  rediscoveryScore?: number;
  forgottenGemScore?: number;
}

export interface SmartPlaylistRule {
  id?: number;
  ruleType: string;
  targetId: number | null;
  targetLabel: string;
}

export interface GeniusPlaylistConfig {
  id: number;
  geniusType: string;
  deviceId: number | null;
  trackLimit: number;
  lastGeneratedAt: string | null;
}

export interface PlaylistGenerationResult {
  playlistName: string;
  criteria: string;
  tracks: PlaylistTrack[];
  generatedAt: string;
  type: "smart" | "genius";
  subtype: string;
}

export interface ArtistInfo {
  id: number;
  name: string;
  trackCount: number;
}

export interface AlbumInfo {
  id: number;
  title: string;
  artist: string;
  artistId: number;
  trackCount: number;
}

export interface GenreInfo {
  id: number;
  name: string;
  trackCount: number;
}

export interface GeniusTypeOption {
  value: string;
  label: string;
  description: string;
  icon: string;
  /** Min months of playback data required (time-based types). */
  minMonths?: number;
}

// -- Genius / Rockbox playback log types ----------------------------------

export interface PlayEvent {
  timestamp: number;
  elapsedMs: number;
  totalMs: number;
  filePath: string;
  completionRatio: number;
}

export interface MatchedPlayEvent extends PlayEvent {
  trackId: number;
  artist: string;
  album: string;
  title: string;
  genre: string;
  duration: number;
}

export interface AnalysisSummary {
  totalPlays: number;
  matchedPlays: number;
  unmatchedPlays: number;
  dateRange: { first: string; last: string };
  topArtist: { name: string; playCount: number } | null;
  topAlbum: { name: string; artist: string; playCount: number } | null;
  uniqueTracks: number;
  uniqueArtists: number;
}

export interface GeniusGenerateOptions {
  maxTracks?: number;
  minPlays?: number;
  artist?: string;
  /** For time_capsule: target month (1-12). */
  targetMonth?: number;
  /** For time_capsule: target year. */
  targetYear?: number;
  /** For golden_era: range start (months ago from now). */
  rangeStartMonthsAgo?: number;
  /** For golden_era: range end (months ago from now). */
  rangeEndMonthsAgo?: number;
}

export interface SavantIntent {
  mood: string;
  seedArtist?: string;
  adventureLevel: "conservative" | "mixed" | "adventurous";
  targetCount: number;
  /** Full mood discovery chat history for richer LLM context. */
  moodDiscoveryChat?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface OpenRouterConfig {
  apiKey: string;
  model: string;
  siteUrl?: string;
  siteName?: string;
}

export interface SavantKeyData {
  keyedCount: number;
  totalCount: number;
  coveragePct: number;
  bpmOnlyCount: number;
}

export interface GenerateSavantResult {
  playlistId: number;
  name: string;
  trackCount: number;
  reasoning: string;
}

export interface ScanProgress {
  file: string;
  processed: number;
  total: number;
  status: "scanning" | "added" | "skipped" | "complete" | "error" | "cancelled";
}

export interface SyncProgress {
  event: string;
  path: string;
  destination?: string;
  status: "pending" | "syncing" | "complete" | "error" | "cancelled";
  contentType?: string;
  message?: string;
}

export interface BackfillProgress {
  path: string;
  processed: number;
  total: number;
  success: boolean;
  status: "analyzing" | "complete" | "error" | "cancelled";
  message?: string;
}

export interface CustomSelections {
  albums: string[];
  artists: string[];
  genres: string[];
  podcasts: string[];
  audiobooks: string[];
  playlists: string[];
}

export interface SyncOptions {
  deviceId: number;
  syncType: string;
  extraTrackPolicy: string;
  ignoreSpaceCheck: boolean;
  selections?: CustomSelections;
  /** For full sync: include music tracks (default true). */
  includeMusic?: boolean;
  /** For full sync: include podcast tracks (default true). */
  includePodcasts?: boolean;
  /** For full sync: include audiobook tracks (default true). */
  includeAudiobooks?: boolean;
  /** For full sync: write M3U playlists to device (default true). */
  includePlaylists?: boolean;
  /** When true, do not copy album artwork (*.jpg, *.png) to device (default false). */
  skipAlbumArtwork?: boolean;
}

export interface ScanResult {
  filesAdded: number;
  filesProcessed: number;
  cancelled: boolean;
  errors?: string[];
  addedTrackPaths?: string[];
  removedTrackPaths?: string[];
  updatedTrackPaths?: string[];
}

export interface ShadowLibrary {
  id: number;
  name: string;
  path: string;
  codecConfigId: number;
  codecConfigName: string;
  codecName: string;
  /** Bitrate in kbps (e.g. 320), or null if codec uses quality/bits. */
  codecBitrateValue: number | null;
  /** Quality value (e.g. MPC Q5), or null. */
  codecQualityValue: number | null;
  /** Bits per sample (e.g. FLAC 24), or null. */
  codecBitsPerSample: number | null;
   /** Approximate total size of the shadow library in bytes (from primary track file_size). */
  totalBytes: number;
  status: "pending" | "building" | "ready" | "error";
  trackCount: number;
  createdAt: string;
}

export interface ShadowBuildProgress {
  shadowLibraryId: number;
  processed: number;
  total: number;
  currentFile: string;
  status: "building" | "complete" | "error" | "cancelled";
  logMessage?: string;
  logLevel?: "info" | "success" | "skip" | "error";
}

export interface IpcApi {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(
    channel: string,
    callback: (...args: unknown[]) => void
  ): () => void;
  off(channel: string, callback: (...args: unknown[]) => void): void;
}
