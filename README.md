# iPodRocks — Electron Edition

**The smart sync manager for Rockbox and any mountable device.** Built with Electron, React, and TypeScript.

📖 **[Full documentation →](https://ipodrocks.dev)**

<p align="center">
<img src="https://github.com/JoaoSobral/ipodrocks-js/blob/main/ipodrocks-js/assets/ipodRocks_transp.png?raw=true" width="20%">
</p>

---

## ✨ Why iPodRocks?

iPodRocks is a sync manager for Rockbox devices — and any mountable player. Multiple libraries, shadow transcoding, auto-downloading podcasts, AI-powered playlists, harmonic mixing, and AI assistant Rocksy that knows your entire collection. All in one desktop app.

### What is not!

iPodRocks is NOT a library manager. I strongly advise you to use beets and beets-flask as proper library managers (there are other alternatives). Once you library is ready then iPodRocks can sync to multiple RockBox devices.

---

## Screenshots

### Dashboard
<img src="https://github.com/JoaoSobral/ipodrocks-js/blob/main/ipodrocks-js/docs/screenshots/dashboard.png?raw=true" width="70%">

### Library
<img src="https://github.com/JoaoSobral/ipodrocks-js/blob/main/ipodrocks-js/docs/screenshots/library.png?raw=true" width="70%">

### Devices
<img src="https://github.com/JoaoSobral/ipodrocks-js/blob/main/ipodrocks-js/docs/screenshots/devices.png?raw=true" width="70%">

### Auto-Podcasts
<img src="https://github.com/JoaoSobral/ipodrocks-js/blob/main/ipodrocks-js/docs/screenshots/autopodcasts.png?raw=true" width="70%">

### Playlists
<img src="https://github.com/JoaoSobral/ipodrocks-js/blob/main/ipodrocks-js/docs/screenshots/playlist-genius.png?raw=true" width="70%">

### Sync
<img src="https://github.com/JoaoSobral/ipodrocks-js/blob/main/ipodrocks-js/docs/screenshots/sync.png?raw=true" width="70%">

### Rocksy — create playlists by chat
<img src="https://github.com/JoaoSobral/ipodrocks-js/blob/main/ipodrocks-js/docs/screenshots/assistant-chat.png?raw=true" width="70%">

### Light & Dark themes
<img src="https://github.com/JoaoSobral/ipodrocks-js/blob/main/ipodrocks-js/docs/screenshots/welcome-light.png?raw=true" width="45%"> <img src="https://github.com/JoaoSobral/ipodrocks-js/blob/main/ipodrocks-js/docs/screenshots/welcome-dark.png?raw=true" width="45%">

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
- **Per-device icons** — iPod Classic, Nano, and Mini get their own artwork; other devices each get a distinct generic Rockbox icon so cards are easy to tell apart at a glance
- **Live connection indicator** — A prominent green/red dot on each device card shows whether the mount path is currently reachable

### Smart & Genius Playlists
- **Multi-select Smart playlist builder** — Pick any combination of genres, artists, and albums in a single 3-column modal. Cross-type AND, within-type OR. Live "~N tracks" preview updates as you tick.
- **Star-rated playlists** — Both Smart and Genius support a `top_rated` strategy that surfaces tracks rated 4★+ (Rockbox 0–10 ≥ 8). Smart variant works even before any device log is ingested.
- **Genius from playback logs** — Rediscovery, Forgotten Gems, Most Played, Favorites, Deep Dive, and more. Star ratings from your library now flow into every Genius algorithm.
- **Rockbox-native smart playlists (tagnavi)** — Per-device opt-in: Smart playlists are written as live, auto-updating Rockbox tagtree entries in `.rockbox/tagnavi_custom.config` instead of frozen `.m3u` snapshots. Other playlist kinds still write `.m3u`.

### Savant Playlists — AI-Powered
- **Mood Chat** — Describe your vibe in plain English; get a tailored playlist
- **AI-generated playlists** — Powered by OpenRouter (Claude, etc.)
- **Rating-aware curation** — Candidate tracks sent to the LLM include their star rating; Savant is instructed to give extra weight to highly-rated tracks
- Harmonic sequencing — Camelot wheel, key-aware ordering for smooth transitions

### Harmonic Mixing
- **Key & BPM detection** — from existing tags or automatic audio analysis
- Camelot wheel compatibility for DJ-style flow
- Optional backfill with genre-based sampling

### Rocksy
- **Chat** — Ask about your library, playlists, artists, and get recommendations
- **Persistent memory** — The assistant remembers important things you tell it across sessions (up to 40 pinned memories). Say "always remember my name is Pedro" or "don't forget I love jazz" and it will carry that context every time you open the app
- **Rolling conversation history** — Keeps the last 100 exchanges as hidden context so the assistant stays informed without cluttering your chat
- **Create playlists by talking** — Ask the assistant to make a Smart or Genius playlist in plain English: "Make me a rock playlist with 30 tracks" or "Create a late night favorites playlist from my listening history" — it handles the rest
- **Smart memory management** — Up to 40 permanently pinned memories that survive the rolling history limit. Say "forget about that" or "actually my name is X" to update or remove memories
- Markdown rendering, copy-paste friendly

### Auto Podcasts
- **Search & subscribe** — Find any podcast by keyword using the free [Podcast Index](https://podcastindex.org/) API
- **Auto-download** — Keep the last 1–5 episodes per subscription, or switch to manual episode selection (pick up to 5 specific episodes)
- **Background refresh** — Checks feeds automatically while the app is open (every 15 min, 30 min, or 1 hour — your choice)
- **Device sync** — Downloaded episodes are automatically copied to each device that has Auto Podcasts enabled, into its `Podcasts` folder
- **Per-subscription control** — Change the download window or retrigger downloads instantly with "Download now"

### Sync & Conversion
- **Full or custom sync** — Pick albums, artists, genres, playlists
- FFmpeg conversion with metadata preserved
- Live progress feedback

### More
- **M3U8 export** — Playlists for any player
- **Dark & light themes** — Gmail-like light mode
- **Library scanning** — MP3, FLAC, AAC, OGG, Opus, WavPack, Musepack, WAV, AIFF, and more

---

## Installation

### Download (recommended)

Download the installer for your platform from the [Releases](https://github.com/JoaoSobral/ipodrocks-js/releases/) page:

- **Linux** — AppImage
- **macOS** — `.zip`
- **Windows** — `.exe` (portable)

### Build from source

**Requirements:**

- Node.js 18+
- npm

```bash
cd ipodrocks-js
npm install
npm run build
npm run preview    # run in production mode
```

#### FFmpeg

FFmpeg is bundled automatically. No separate installation is required.

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

1. **Add library folder** — Open **Library**, click **Add Folder**, and choose your music root folder (for example, `/home/user/Music`). iPodRocks scans all subfolders recursively for audio files. Important to have your audio with tags
2. **Add device** — Open **Devices**, click **+ Add Device**, and pick the **root mount path of the device** (for example, `/media/ipod`). The app will automatically create `music`, `podcasts`, and `audiobooks` folders on the device if they do not exist.
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
- Check device status: synced tracks, orphan files, and sync history

### Playlists

- **Smart** — Rule-based (genre, artist, album) with track limits, multi-select 3-column builder, and a `top_rated` strategy for 4★+ tracks
- **Genius** — From Rockbox playback logs; analyze device first. Includes a `top_rated` Genius type that works without any play history
- **Savant** — AI-generated from mood (requires OpenRouter API key in Settings); rating-aware curation
- **Tagnavi mode** — Enable "Rockbox smart playlists (tagnavi)" on a device to sync Smart playlists as live, auto-updating Rockbox tagtree entries instead of static `.m3u` files
- **Via Rocksy** — Ask the chat to create a Smart or Genius playlist for you in plain English. Rocksy knows your genres, artists, albums, and listening history and builds the playlist instantly

### Auto Podcasts

- Subscribe to any podcast via the **Search & Subscribe** modal (powered by Podcast Index — free API key required)
- Set each subscription to auto-download the last 1–5 episodes, or pick episodes manually
- Background scheduler refreshes feeds and downloads new episodes automatically
- Enable Auto Podcasts on a device (in its settings) to have ready episodes copied there on every refresh cycle
- Get credentials at [api.podcastindex.org/signup](https://api.podcastindex.org/signup), then configure in **Settings → Auto Podcasts**

### Sync

- **Full sync** — Music, podcasts, audiobooks, playlists
- **Custom sync** — Pick albums, artists, genres, playlists
- Live progress feedback

### Settings

- **OpenRouter API key** — required for AI features (Savant playlists and Rocksy). Add your key and test the connection before saving.
- **Harmonic analysis** — configure key/BPM detection from tags or audio analysis

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
| Shell    | Electron 35                   |
| Frontend | React 19, Tailwind CSS 4, Zustand 5 |
| Backend  | TypeScript, better-sqlite3, music-metadata, Essentia.js |
| Tooling  | Vite 6, Vitest, electron-builder |

---

## Contributing

Development happens on the **dev** branch. All PRs to **main** must pass CI (tests + build). See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

---

## License

This project is licensed under the GNU General Public License v3.0 (GPL-3.0). See [LICENSE](LICENSE) for the full text.
