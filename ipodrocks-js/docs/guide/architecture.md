# Architecture

iPodRocks is an [Electron](https://www.electronjs.org/) desktop app. This page explains how its two processes are structured and how they communicate.

## Overview

```excalidraw
@file:../public/architecture.excalidraw
```

## Main Process

Runs in Node.js. Has full filesystem and OS access.

| Module | Responsibility |
|---|---|
| **IPC Handlers** (`ipc.ts`) | ~60 channels bridged to the renderer. Applies `safe()` wrapper, `sanitizeErrorMessage`, rate limiting. |
| **LibraryCore** | CRUD for tracks, artists, albums, genres, folders. |
| **LibraryScanner** | Walks library folders, extracts metadata via `music-metadata`, writes to DB. |
| **ShadowLibraryManager** | Manages pre-transcoded mirror libraries (e.g. FLAC → MPC). |
| **HashManager** | SHA-256 content hashing for change detection. |
| **SyncCore / SyncExecutor** | Compares library against device; copies, transcodes, or removes files. |
| **SyncConversion** | Transcodes audio via FFmpeg or `mpcenc`. |
| **RatingMerge** | 3-way merge algorithm that reconciles ratings between the device and the library. Detects device changes, resolves conflicts, and computes what to propagate back. |
| **TagcacheIO** | Reads and writes the Rockbox `database_changelog.txt` on the device mount. Handles Phase 1 (ingest) and Phase 3 (propagate) of the ratings sync cycle. |
| **AppDatabase** | Single `better-sqlite3` instance. All reads/writes go through here. |
| **DevicesCore** | Stores and retrieves device profiles. |
| **PlaylistCore** | Smart and Genius playlist creation. |
| **GeniusEngine** | Generates Genius playlists from playback history (graph-based scoring). |
| **OpenRouterClient** | Calls the OpenRouter API with timeout, rate limiting, and prompt injection mitigation. |
| **SavantEngine / AssistantChat** | LLM orchestration for playlist generation and the Music Assistant. |
| **Essentia.js** | WASM module for key and BPM detection (harmonic analysis). |
| **Prefs** | Reads and writes `prefs.json` (settings, encrypted API key via `safeStorage`). |
| **PathAllowlist** | Validates that library and shadow library paths stay within allowed directories. |

## Renderer Process

Runs in a Chromium sandbox. Cannot access the filesystem directly.

| Module | Responsibility |
|---|---|
| **IPC API Layer** (`renderer/ipc/api.ts`) | Thin wrappers around `window.api.invoke()`. One function per IPC channel. |
| **Zustand Stores** | `useLibraryStore`, `useDeviceStore`, `useSyncStore`, `useUIStore`, `useThemeStore`. All server state lives here. |
| **React Panels** | One panel per tab: Dashboard, Library, Devices, Sync, Playlists, Settings. |
| **RatingStars** | 5-star rating input with half-star support. Displays device-source and conflict badges. |
| **RatingConflictsModal** | Lists unresolved rating conflicts and lets the user resolve them (keep library, use device, or set manually). |
| **ScanProgressModal** | Shows file-by-file scan progress; captures `folders` in a ref to prevent restart on re-render. |
| **SyncProgressModal** | Shows copy progress; uses `useRef` counters to avoid stale-closure bugs in the `onComplete` callback. |
| **FloatChat** | Floating Music Assistant chat backed by `AssistantChat` on the main process. |

## IPC communication

The **Preload script** uses Electron's `contextBridge` to expose a strict allowlist of channels as `window.api`. The renderer calls `window.api.invoke(channel, ...args)`; the main process handles it in `ipcMain.handle()` inside a `safe()` wrapper that:

1. Catches all errors and returns `{ error: string }` (never throws across IPC).
2. Strips absolute paths from error messages before they reach the renderer.
3. Enforces per-channel rate limits (10 calls / 60 s for LLM channels).

## Database schema (high-level)

```
tracks          artists         albums          genres
playlists       playlist_tracks
shadow_libraries  shadow_tracks   shadow_files
devices
app_settings
content_hashes  (mtime + SHA-256)
activity_log

-- Ratings
device_track_ratings   (per-device baseline manifest; last_seen / last_pushed)
rating_conflicts       (unresolved divergences awaiting user resolution)
rating_events          (full audit log of every rating change)
```
