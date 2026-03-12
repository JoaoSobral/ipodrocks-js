# iPodRocks v1.0.0 — Electron Edition

**The smart sync manager for Rockbox and any mountable device.** Built with Electron, React, and TypeScript.

<p align="center">
<img src="https://github.com/JoaoSobral/ipodrocks-js/blob/main/ipodrocks-js/assets/ipodRocks_transp.png?raw=true" width="20%">
</p>

---

## ✨ Why iPodRocks?

iPodRocks is a sync manager for rockbox devices. Multiple libraries, shadow transcoding, AI-powered playlists, harmonic mixing, and a floating assistant that knows your entire collection. All in one desktop app.

---

## Screenshots


---

## 🎵 Standout Features

### Multiple Libraries & Shadow Libraries
- **Multiple library folders** — Music, podcasts, audiobooks in one catalog
- **Shadow libraries** — Pre-transcoded mirrors (e.g. FLAC → MPC) for lightning-fast sync to devices that need specific codecs
- Build once, sync many — no re-encoding on every sync

### Multiple Devices
- **Add as many devices as you want** — iPods, Rockbox players, any FAT32/exFAT-mounted drive
- Per-device codec configs (direct copy, MP3, AAC, Musepack, Opus, OGG)
- Device check: compare what’s on disk vs library, spot orphans

### Genius Playlists
- **Analyze your Rockbox playback logs** — Rediscovery, Forgotten Gems, Most Played, and more
- Uses real listening data from your device
- Rule-based smart playlists by genre, artist, album, track limits

### Savant Playlists — AI-Powered
- **Mood Chat** — Describe your vibe in plain English; get a tailored playlist
- **AI-generated playlists** — Powered by OpenRouter (Claude, etc.)
- Harmonic sequencing — Camelot wheel, key-aware ordering for smooth transitions

### Harmonic Mixing ("similar to Apple Genius playlists")
- **Key & BPM** — From tags or Essentia.js audio analysis
- Camelot wheel compatibility for DJ-style flow
- Optional backfill with genre-based sampling

### Assistant
- **Floating chat** — Ask about your library, playlists, artists, recommendations
- Full read-only access to your database
- Markdown rendering, copy-paste friendly

### Sync & Conversion
- **Full or custom sync** — Pick albums, artists, genres, playlists
- FFmpeg conversion with metadata preserved
- Progress modal with live feedback

### More
- **M3U8 export** — Playlists for any player
- **Dark & light themes** — Gmail-like light mode
- **Library scanning** — MP3, FLAC, AAC, OGG, Opus, WavPack, Musepack, WAV, AIFF, and more

---

## Installation

### Download (recommended)

Download the installer for your platform from the [Releases](https://github.com/your-username/ipodrocks-js/releases) page:

- **Linux** — AppImage, `.deb`, or `.rpm`
- **macOS** — `.dmg` or `.zip`
- **Windows** — `.exe` (NSIS) or portable

### Build from source

**Requirements:**

- Node.js 18+
- npm
- **OpenRouter API key** — required for AI features (Savant playlists, Assistant chat). Get one at [openrouter.ai/keys](https://openrouter.ai/keys) and add it in Settings
- **Musepack (mpcenc)** — optional, for Musepack (MPC) encoding

```bash
cd ipodrocks-js
npm install
npm run build
npm run preview    # run in production mode
```

#### FFmpeg

FFmpeg is bundled via the `@ffmpeg-installer/ffmpeg` npm package. No separate installation is required for development or packaged builds.

#### OpenRouter API key

Required for Savant playlists and the Assistant chat. Get your API key at [openrouter.ai/keys](https://openrouter.ai/keys), then add it in **Settings** → OpenRouter. You can test the connection before saving.

#### Musepack (mpcenc)

Required only if you use Musepack (MPC) as a codec for devices or shadow libraries.

| Platform | Install |
|----------|---------|
| **Debian / Ubuntu** | `sudo apt install musepack-tools` |
| **Fedora / RHEL** | `sudo dnf install mpc-tools` or `musepack-tools` |
| **Arch** | `sudo pacman -S musepack-tools` |
| **macOS** | `brew install musepack` |
| **Windows** | Download from [musepack.net](https://www.musepack.net/), add `mpcenc.exe` to PATH |

If `mpcenc` is not on your PATH, iPodRocks will prompt when you select Musepack. You can still use other codecs (MP3, AAC, Opus, etc.) without it.

---

## Quick Start

1. **Add library folder** — Open **Library**, click **Add Folder**, choose your music directory, and scan.
2. **Add device** — Open **Devices**, click **+ Add Device**, pick the mount path (e.g. `/media/ipod`).
3. **Create playlists** (optional) — Open **Playlists** for smart, genius, or Savant playlists.
4. **Sync** — Open **Sync**, select your device, choose full or custom sync, and click **Start Sync**.

---

## Usage Guide

### Library

- Add folders for music, podcasts, or audiobooks
- Scan to extract metadata and build the catalog
- View tracks with search, sort, and filters
- Create shadow libraries for pre-transcoded sync

### Devices

- Add multiple devices with custom folder layouts
- Configure codec per device (direct copy, MP3, AAC, Musepack, etc.)
- Use shadow libraries for devices that need pre-converted files
- Check device status, total synced, last sync count, and orphan files

### Playlists

- **Smart** — Rule-based (genre, artist, album) with track limits
- **Genius** — From Rockbox playback logs; analyze device first
- **Savant** — AI-generated from mood (requires OpenRouter API key in Settings)

### Sync

- **Full sync** — Music, podcasts, audiobooks, playlists
- **Custom sync** — Pick albums, artists, genres, playlists
- Progress modal with live feedback

### Settings

- OpenRouter API key for Savant and Assistant
- Harmonic data: tag extraction, Essentia.js analysis, backfill %
- Test connection before saving

---

## Development

| Command       | Description                    |
|---------------|--------------------------------|
| `npm run dev` | Dev server with hot-reload     |
| `npm run build` | Compile main + bundle renderer |
| `npm run test` | Run tests (Vitest)             |
| `npm run dist` | Package for current platform   |

---

## Tech Stack

| Layer    | Technology                    |
|----------|--------------------------------|
| Shell    | Electron 34                   |
| Frontend | React 19, Tailwind CSS 4, Zustand 5 |
| Backend  | TypeScript, better-sqlite3, music-metadata, Essentia.js |
| Tooling  | Vite 6, Vitest, electron-builder |

---

## Contributing

From v1.0.0.1 onward, development uses a **dev** branch. All PRs to **main** must pass CI (tests + build). See [CONTRIBUTING.md](../CONTRIBUTING.md) in the repo root for details.

---

## License

MIT
