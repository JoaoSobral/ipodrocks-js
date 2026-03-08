# iPodRocks — Electron Edition

Desktop iPod sync and library manager, built with Electron + React + TypeScript.

## Screenshots

> _Screenshots coming soon._

## Features

- **Library scanning** with metadata extraction (MP3, FLAC, AAC, OGG, Opus, WavPack, Musepack, WAV, AIFF, and more)
- **Device management** — iPod, Rockbox players, any FAT32/exFAT-mounted device
- **Smart sync** with name+size comparison and FAT32-safe path sanitization
- **Audio conversion** via FFmpeg (AAC, MP3, Opus, OGG, Musepack)
- **Parallel direct copy** using OS-level fast copy
- **Smart playlists** — by genre, artist, album, recently added, and more
- **Genius playlists** generated from Rockbox playback logs
- **M3U8 playlist export**
- **Sync error logging**
- **Dark theme UI**

## Tech Stack

| Layer     | Technology                              |
|-----------|-----------------------------------------|
| Shell     | Electron 34                             |
| Frontend  | React 19, Tailwind CSS 4, Zustand 5    |
| Backend   | TypeScript, better-sqlite3, music-metadata |
| Tooling   | Vite 6, Vitest, electron-builder       |

## Prerequisites

- Node.js 18+
- npm
- FFmpeg (required for audio conversion only)

## Getting Started

```bash
cd electronjs
npm install
npm run build
npm run preview    # production mode
npm run dev        # development mode with hot-reload
```

## Project Structure

```
src/
├── main/                  # Electron main process (backend)
│   ├── index.ts           # App entry, window creation
│   ├── preload.ts         # Context bridge
│   ├── ipc.ts             # IPC handler registration
│   ├── database/          # SQLite schema and access
│   ├── library/           # Library scanning, metadata, hashing
│   ├── devices/           # Device detection and management
│   ├── sync/              # Sync engine, conversion, error logging
│   └── playlists/         # Smart, genius, and M3U8 playlists
├── renderer/              # React frontend
│   ├── main.tsx           # React entry
│   ├── App.tsx            # Root component
│   ├── components/
│   │   ├── panels/        # Dashboard, Library, Device, Sync, Playlist
│   │   ├── modals/        # AddDevice, AddFolder, ScanProgress, SyncProgress, Confirm
│   │   └── common/        # Button, Card, Input, Select, Modal, Toast, ProgressBar
│   ├── stores/            # Zustand stores (library, device, sync)
│   └── ipc/               # Renderer-side IPC API
└── shared/
    └── types.ts           # Shared type definitions
```

## Development Commands

| Command           | Description                                  |
|-------------------|----------------------------------------------|
| `npm run dev`     | Start dev server with hot-reload             |
| `npm run build`   | Compile main process + bundle renderer       |
| `npm run preview` | Build and launch in production mode          |
| `npm run test`    | Run tests with Vitest                        |
| `npm run dist`    | Build and package for current platform       |

## Architecture

The app follows Electron's multi-process model:

- **Main process** — Runs the backend: SQLite database, library scanning, device management, sync engine, playlist generation, and FFmpeg conversion. All heavy I/O stays here.
- **Renderer process** — React SPA with Zustand state management and Tailwind styling. Communicates with the main process exclusively through IPC.
- **Preload / IPC bridge** — A typed API exposed via `contextBridge` that serializes calls between renderer and main. The renderer never accesses Node.js APIs directly.

## License

MIT
