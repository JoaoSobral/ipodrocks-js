# Architecture

iPodRocks is an [Electron](https://www.electronjs.org/) desktop app that syncs your music library to Rockbox and other mountable players. Like every Electron app, it runs as two processes — a privileged **main** process that talks to disk, devices, and the network, and a sandboxed **renderer** process that draws the UI. This page is a tour of what lives on each side and how they talk to each other.

## Overview

Here is the bird's-eye view. The main process owns the database and everything that touches the outside world; the renderer is pure React on top of Zustand state.

<img src="/diagrams/excalidraw-ipodrocks-arch-a2f77d266de6bc8709c14078b82c275a.svg" alt="iPodRocks architecture overview" style="width:100%;border-radius:8px;" />

## Main process

Runs in Node.js. Has full filesystem and OS access. Everything that touches the disk, the device, the network, or the database lives here.

To keep the picture manageable, modules are grouped by area below — but they all live under `src/main/` and share a single `better-sqlite3` database instance.

### Library and metadata

This is where your music catalog comes from. Files get walked, tagged, hashed, and (optionally) mirrored into a transcoded shadow library.

| Module | Responsibility |
|---|---|
| **LibraryCore** | CRUD for tracks, artists, albums, genres, and library folders. |
| **LibraryScanner** | Walks library folders, extracts metadata, writes to DB. |
| **MetadataExtractor** | Reads tags via [`music-metadata`](https://github.com/Borewit/music-metadata) — title, artist, album, genre, year, replay gain, embedded art. |
| **HashManager** | SHA-256 content hashing for change detection (mtime + hash). |
| **ShadowLibrary** | Manages pre-transcoded mirror libraries (e.g. FLAC → MPC) so devices can copy without on-the-fly conversion. |
| **Tagging** | APEv2 and MPC tag writers — used when iPodRocks needs to stamp metadata back into files. |

### Devices and sync

Adding a device profile, comparing it against the library, and pushing the right files (transcoded if needed) to the right folders on disk.

| Module | Responsibility |
|---|---|
| **DevicesCore** | Stores and retrieves device profiles, codec configs, transfer modes. |
| **SyncCore** | Compares library against device and produces a sync plan. |
| **SyncExecutor** | Carries out the plan — copies, transcodes, removes files. |
| **SyncConversion** | Transcodes audio via FFmpeg or `mpcenc`. |
| **DeviceSyncPreferences** | Per-device rules: which content types, which playlists, orphan policy. |
| **TagcacheIO** | Reads and writes the Rockbox `database_changelog.txt` on the device mount. Handles Phase 1 (ingest) and Phase 3 (propagate) of the ratings sync cycle. |

### Ratings

A track's rating can change in two places — your library and your device — so reconciling them needs more than a last-write-wins.

| Module | Responsibility |
|---|---|
| **RatingMerge** | 3-way merge that reconciles ratings between device and library. Detects device changes, resolves conflicts, and computes what to propagate back. |

### Playlists

| Module | Responsibility |
|---|---|
| **PlaylistCore** | CRUD for all playlist types; export to Rockbox playlist files. |
| **SmartPlaylists** | Rule-based playlists (genre/artist/album/etc.), with optional Rockbox tagnavi mode. |
| **GeniusEngine** | Builds playlists from playback history using graph-based scoring (Most Played, Forgotten Gems, and others). |
| **PlaybackLogIngest** | Parses Rockbox `playback.log` files off the device into `playback_logs` and `playback_stats`. |

### AI (Savant and Rocksy)

Two LLM-powered surfaces share one OpenRouter client. Savant generates playlists from mood; Rocksy is the floating chat that knows your library.

| Module | Responsibility |
|---|---|
| **OpenRouterClient** | Calls the OpenRouter API with timeout, rate limiting, and prompt-injection mitigation. |
| **SavantEngine** | LLM orchestration for AI playlist generation. |
| **MoodChat** | Conversational mood capture for Savant playlists. |
| **SavantPlaylistChat** | Multi-turn playlist refinement loop. |
| **HarmonicSequencer** | Reorders Savant playlists along the Camelot wheel for harmonic mixing. |
| **AssistantChat** | LLM orchestration for Rocksy, including library-aware tool calls. |

### Podcasts

A full subscribe-and-sync pipeline backed by the [Podcast Index API](https://podcastindex.org/).

| Module | Responsibility |
|---|---|
| **PodcastSubscriptions** | Manages subscribed shows in the database. |
| **PodcastIndexClient** | Talks to the Podcast Index API for search and feed lookup. |
| **PodcastRefresh** | Polls feeds for new episodes and updates the DB. |
| **PodcastDownloader** | Downloads episode audio and writes metadata. |
| **PodcastCoverExtractor** | Extracts and caches episode/show artwork. |
| **PodcastScheduler** | Auto-refresh and auto-download cadence. |
| **PodcastStorage** | On-disk layout for downloaded episodes. |
| **PodcastDeviceSync** | Picks the right episodes per device and copies them during sync. |

### Playback

Lets the renderer play local tracks without exposing filesystem paths.

| Module | Responsibility |
|---|---|
| **PlayerSource** | Resolves a track ID to a streamable source. |
| **MediaProtocol** | Custom Electron protocol that streams audio bytes to the renderer's `<audio>` element. |

### Harmonic analysis

Optional key/BPM analysis that powers Savant's harmonic sequencing.

| Module | Responsibility |
|---|---|
| **Essentia.js** | WASM module for key and BPM detection. |
| **CamelotWheel** | Maps musical keys to Camelot notation and computes compatibility between tracks. |

### Foundation

The plumbing every other module sits on top of.

| Module | Responsibility |
|---|---|
| **IPC Handlers** (`ipc.ts`) | Around 90 channels bridged to the renderer. Applies `safe()` wrapper, `sanitizeErrorMessage`, and rate limiting. |
| **AppDatabase** | Single `better-sqlite3` instance. All reads and writes go through here. |
| **Prefs** | Reads and writes `prefs.json` (settings, encrypted API key via Electron's `safeStorage`). |
| **PathAllowlist** | Validates that library and shadow library paths stay within allowed directories. |
| **ActivityLogger** | Append-only log of significant operations, surfaced in the Dashboard. |
| **UpdateChecker** | Polls GitHub Releases for new versions and prompts the user. |

## Renderer process

Runs in a Chromium sandbox. Cannot touch the filesystem directly — every cross-boundary operation goes through `window.api.invoke()`.

### State (Zustand stores)

Server state lives in stores; React components subscribe.

| Store | Holds |
|---|---|
| **useLibraryStore** | Tracks, artists, albums, genres, library folders. |
| **useDeviceStore** | Device profiles, codec configs, online status. |
| **useSyncStore** | Last sync plan, sync progress, conflicts. |
| **useUIStore** | Active tab, modal stack, transient UI state. |
| **useThemeStore** | Light/dark and accent. |
| **usePlayerStore** | Current track, queue, playback position. |
| **usePodcastsStore** | Subscriptions, episode lists, download progress. |
| **useSavantStore** | Mood chat session, generated playlists, backfill progress. |

### Top-level panels

One per primary tab in the sidebar.

| Panel | Purpose |
|---|---|
| **WelcomePanel** | First-launch overview and quick links. |
| **DashboardPanel** | Library stats, devices, shadow libraries, recent activity. |
| **LibraryPanel** | Folders, scans, track list. |
| **DevicePanel** | Add/edit devices, codec configuration, online checks. |
| **SyncPanel** | Pick what to sync and run it. |
| **PlaylistPanel** | Smart, Genius, Savant tabs. |
| **AutoPodcastsPanel** | Subscribe to shows and configure per-device auto-sync. |
| **SettingsPanel** | OpenRouter, harmonic analysis, codecs, podcasts. |

### Ratings UI

| Component | Purpose |
|---|---|
| **RatingStars** | 5-star input with half-star support. Displays device-source and conflict badges. |
| **RatingConflictsModal** | Lists unresolved rating conflicts and lets the user resolve them (keep library, use device, or set manually). |

### Progress and dialogs

| Modal | Purpose |
|---|---|
| **ScanProgressModal** | File-by-file scan progress; captures `folders` in a ref to prevent restart on re-render. |
| **SyncProgressModal** | Copy progress; uses `useRef` counters to avoid stale-closure bugs in the `onComplete` callback. |
| **BackfillProgressModal** | Harmonic backfill progress. |
| **AddDeviceModal / AddFolderModal** | Forms for new devices and library folders. |
| **PodcastSearchModal / PodcastEpisodeModal** | Discover and inspect podcasts. |
| **MpcUnavailableModal** | Surfaced when `mpcenc` is missing on the host. |
| **UpdateAvailableModal** | Prompts the user when a new release is detected. |
| **ConfirmDialog** | Generic confirm/cancel. |

### AI surfaces

| Component | Purpose |
|---|---|
| **FloatChat** | Floating Rocksy chat, backed by `AssistantChat` on the main process. |
| **SavantInlineChat** | Inline mood chat used inside the Playlists panel. |

### Playback

| Component | Purpose |
|---|---|
| **PlayerBar** | Sticky transport bar at the bottom of the app. Reads from `usePlayerStore` and streams audio via `MediaProtocol`. |

### IPC API layer

`renderer/ipc/api.ts` is a thin wrapper around `window.api.invoke()` — one typed function per IPC channel. No business logic lives here; it exists so React code doesn't have to remember channel names.

## IPC communication

The **preload script** uses Electron's `contextBridge` to expose a strict allowlist of channels as `window.api`. The renderer calls `window.api.invoke(channel, ...args)`; the main process handles it in `ipcMain.handle()` inside a `safe()` wrapper that:

1. Catches all errors and returns `{ error: string }` (it never throws across IPC).
2. Strips absolute paths from error messages before they reach the renderer.
3. Enforces per-channel rate limits — currently 10 calls per 60 seconds for LLM channels.

## Database schema (high-level)

One SQLite file, around 33 tables. They group naturally by feature:

**Library core** — your music catalog itself.

`tracks` · `artists` · `albums` · `genres` · `library_folders`

**Playlists** — all four playlist types share the same join structure.

`playlists` · `playlist_items` · `playlist_types` · `smart_playlist_rules` · `genius_playlist_configs`

**Shadow libraries** — pre-transcoded mirrors of source tracks.

`shadow_libraries` · `shadow_tracks`

**Devices and sync** — device profiles, codec setup, and what is currently on each device.

`devices` · `device_models` · `codecs` · `codec_configurations` · `device_transfer_modes` · `device_synced_tracks` · `device_sync_preferences` · `sync_configurations` · `sync_rules`

**Ratings** — the three tables that make the bi-directional rating sync work.

| Table | Description |
|---|---|
| `device_track_ratings` | Per-device baseline manifest; tracks `last_seen` and `last_pushed`. |
| `rating_conflicts` | Unresolved divergences awaiting user resolution. |
| `rating_events` | Full audit log of every rating change. |

**Podcasts** — subscriptions, episodes, and what has been copied to each device.

`podcast_subscriptions` · `podcast_episodes` · `device_podcast_synced`

**Playback and history** — fuel for the Genius engine.

`playback_logs` · `playback_stats`

**System** — preferences, hashes, audit, chat memory.

`app_settings` · `content_hashes` · `activity_log` · `assistant_chat_history`

The source of truth is [`src/main/database/schema.ts`](https://github.com/JoaoSobral/ipodrocks-js/blob/main/ipodrocks-js/src/main/database/schema.ts) — when in doubt, read it.
