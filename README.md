# iPodRocks v1.0.0 — Electron Edition

Desktop Rockbox device sync manager for Rockbox and any mountable device inspired by the iPods. Built with Electron, React, and TypeScript.
<p align="center">
<img src="https://github.com/JoaoSobral/ipodrocks-js/blob/main/electronjs/assets/ipodRocks_transp.png?raw=true" width="20%">
</p>
## Screenshots

<!-- Add screenshots to docs/screenshots/ and update the paths below -->

| Dashboard | Library | Devices |
|-----------|---------|---------|
| ![Dashboard](docs/screenshots/dashboard.png) | ![Library](docs/screenshots/library.png) | ![Devices](docs/screenshots/devices.png) |

| Sync | Playlists |
|------|-----------|
| ![Sync](docs/screenshots/sync.png) | ![Playlists](docs/screenshots/playlists.png) |

## Features

- **Library scanning** — Metadata extraction for MP3, FLAC, AAC, OGG, Opus, WavPack, Musepack, WAV, AIFF, and more
- **Device management** — iPod, Rockbox players, any FAT32/exFAT-mounted device
- **Smart sync** — Name+size comparison, FAT32-safe path sanitization
- **Audio conversion** — FFmpeg (AAC, MP3, Opus, OGG, Musepack) with metadata preserved
- **Smart playlists** — By genre, artist, album, recently added, and more
- **Genius playlists** — From Rockbox playback logs (Rediscovery, Forgotten Gems, etc.)
- **Savant playlists** — AI-powered playlists from mood/energy (OpenRouter)
- **Mood Chat** — Conversational playlist creation
- **Harmonic mixing** — Camelot wheel, key-aware sequencing
- **Assistant** — Floating chat for library help
- **Shadow libraries** — Pre-transcoded mirrors for faster sync
- **M3U8 export** — Playlist export for devices
- **Dark & light themes**

## Installation

### Download (recommended)

Download the installer for your platform from the [Releases](https://github.com/your-username/ipodrocks-js/releases) page:

- **Linux** — AppImage, `.deb`, or `.rpm`
- **macOS** — `.dmg` or `.zip`
- **Windows** — `.exe` (NSIS) or portable

### Build from source

**Requirements:** Node.js 18+, npm, FFmpeg (for audio conversion)

```bash
cd electronjs
npm install
npm run build
npm run preview    # run in production mode
```

## Quick Start

1. **Add library folder** — Open **Library**, click **Add Folder**, choose your music directory, and scan.
2. **Add device** — Open **Devices**, click **+ Add Device**, pick the mount path (e.g. `/media/ipod`).
3. **Create playlists** (optional) — Open **Playlists** to create smart, genius, or Savant playlists.
4. **Sync** — Open **Sync**, select your device, choose full or custom sync, and click **Start Sync**.

## Usage Guide

### Library

- Add folders for music, podcasts, or audiobooks
- Scan to extract metadata and build the catalog
- View tracks with search, sort, and filters
- Create shadow libraries for pre-transcoded sync

### Devices

- Add multiple devices with custom folder layouts
- Configure codec per device (direct copy, MP3, AAC, etc.)
- Use shadow libraries for devices that need pre-converted files
- Check device status and orphan files

### Playlists

- **Smart** — Rule-based (genre, artist, album) with track limits
- **Genius** — From Rockbox playback logs; analyze device first
- **Savant** — AI-generated from mood (requires OpenRouter API key in Settings)

### Sync

- **Full sync** — Music, podcasts, audiobooks, playlists
- **Custom sync** — Pick albums, artists, genres, playlists
- Progress and error logging

### Settings

- OpenRouter API key for Savant and Assistant
- Test connection before saving

## Development

| Command       | Description                    |
|---------------|--------------------------------|
| `npm run dev` | Dev server with hot-reload     |
| `npm run build` | Compile main + bundle renderer |
| `npm run test` | Run tests (Vitest)             |
| `npm run dist` | Package for current platform   |

## Tech Stack

| Layer    | Technology                    |
|----------|-------------------------------|
| Shell    | Electron 34                   |
| Frontend | React 19, Tailwind CSS 4, Zustand 5 |
| Backend  | TypeScript, better-sqlite3, music-metadata |
| Tooling  | Vite 6, Vitest, electron-builder |

## Contributing

From v1.0.0.1 onward, development uses a **dev** branch. All PRs to **main** must pass CI (tests + build). See [CONTRIBUTING.md](../CONTRIBUTING.md) in the repo root for details.

## License

MIT
