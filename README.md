# iPodRocks — Electron Edition

**The smart sync manager for Rockbox and any mountable device.** Built with Electron, React, and TypeScript.

📖 **[Full documentation →](https://ipodrocks.dev)**

<p align="center">
<img src="https://github.com/JoaoSobral/ipodrocks-js/blob/main/ipodrocks-js/assets/ipodRocks_transp.png?raw=true" width="25%">
</p>

---

## ✨ Why iPodRocks?

iPodRocks is a sync manager for [Rockbox devices](https://www.rockbox.org/) — and any mountable player. Multiple libraries, shadow transcoding, auto-downloading podcasts, free public-domain audiobooks, AI-powered playlists, harmonic mixing, and AI assistant Rocksy that knows your entire collection and can act on your behalf. All in one desktop app.

### What is not!

iPodRocks is NOT a library manager. I strongly advise you to use beets and beets-flask as proper library managers (there are other alternatives). Once you library is ready then iPodRocks can sync to multiple RockBox devices.

---

If you really like iPodRocks and want to keep it caffeinated, you can buy me a coffee — every cup helps keep the development going. Thank you! ☕

<p align="center">
  <a href="https://buymeacoffee.com/vador">
    <img src="https://github.com/JoaoSobral/ipodrocks-js/blob/main/ipodrocks-js/assets/buy_me_a_coffee.png?raw=true" alt="Buy me a coffee" width="190">
  </a>
</p>

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
- **Shadow libraries** — Pre-transcoded mirrors (e.g. FLAC → MPC) for lightning-fast sync to devices that need specific codecs. A shadow library is a faithful copy of your library differing only in codec: rename or delete an album and the shadow follows. A **⚙ → Prune orphan files** action clears out anything an older version left behind.
- Build once, sync many — no re-encoding on every sync

### Multiple Devices
- **Add as many devices as you want** — iPods, Rockbox players, any FAT32/exFAT-mounted drive
- Per-device codec configs (direct copy, MP3, AAC, Musepack, Opus, OGG)
- Device check: compare what’s on disk vs library, spot orphans
- **Per-device icons** — iPod Classic, Nano, and Mini get their own artwork; other devices each get a distinct generic Rockbox icon so cards are easy to tell apart at a glance
- **Live connection indicator** — A prominent green/red dot on each device card shows whether the device is currently reachable
- **Identify a device by its USB hardware** — Own two iPods that both mount at `/Volumes/IPOD`? Pick the player from a dropdown of connected USB devices and iPodRocks pins that device row to its vendor id, product id and serial number, so the wrong player can never inherit the right one's sync history and ratings. Recognized iPod models are named automatically. Leave it unset and nothing changes — matching stays on the mount path, exactly as before. Works on macOS, Windows and Linux with no extra software to install.

### Classic, Smart & Genius Playlists
- **Classic playlists — hand-pick your own songs** — Tick songs straight from your library in a virtualized picker with search plus artist/album/genre filters. **Your selection persists across every filter change**, so you can build one playlist out of several different searches. Tick order is play order, up to 500 songs. Classic is also the only playlist type you can **edit** after creating — reopen the picker with your songs already ticked.
- **Multi-select Smart playlist builder** — Pick any combination of genres, artists, and albums in a single 3-column modal. Cross-type AND, within-type OR. Live "~N tracks" preview updates as you tick.
- **Star-rated playlists** — Both Smart and Genius support a `top_rated` strategy that surfaces tracks rated 4★+ (Rockbox 0–10 ≥ 8). Smart variant works before any play history has been imported.
- **Genius from Rockbox's runtime data** — Most Played, Favorites, Never Finished, Forgotten Favorites, Hidden Gems, Top Genre, Finish the Album, Deep Dive, and more, built from the play counts and listening time Rockbox records itself. Ratings sync both ways: rate a track in iPodRocks and it appears on the iPod, rate it on the iPod and it appears in your library.
- **Rockbox-native smart playlists (tagnavi)** — Per-device opt-in: Smart playlists are written as live, auto-updating Rockbox tagtree entries in `.rockbox/tagnavi_custom.config` instead of frozen `.m3u` snapshots. Other playlist kinds still write `.m3u`.

> **One Rockbox setting to enable:** turn on **Settings → Playback Settings → Gather Runtime Data** on your device. Rockbox then records play counts, listening time, play order and ratings itself, and iPodRocks imports them on every sync. **Playback Logging is not used and does not need to be enabled** — turning both on gains you nothing. Note that Rockbox only counts a play once a track has run 15 seconds.
- **Playlists as a library filter** — Filter the Library track list down to any playlist's members with a Playlist `<select>` in the filter row; full playlist management lives in the Playlists panel.
- **Playlists self-heal on every scan** — Delete music from disk and your playlists follow: each library scan (and folder removal) drops songs that no longer exist, closes up the track numbering, and **re-resolves Smart playlists from their rules** so they also pick up newly scanned matches — track limit preserved. A scan that finds no tracks at all is skipped rather than emptying everything. Manual Repair/Rebuild and the sync gate's "Repair all & continue" remain for anything that goes wrong outside a scan.

### Savant Playlists — AI-Powered
- **Mood Chat** — Describe your vibe in plain English; get a tailored playlist
- **AI-generated playlists** — Powered by OpenRouter (Claude, etc.)
- **Rating-aware curation** — Candidate tracks sent to the LLM include their star rating; Savant is instructed to give extra weight to highly-rated tracks
- Harmonic sequencing — Camelot wheel, key-aware ordering for smooth transitions

### Harmonic Mixing
- **Key & BPM detection** — from existing tags or automatic audio analysis
- Camelot wheel compatibility for DJ-style flow
- Optional backfill with genre-based sampling

### Rocksy — AI assistant that acts, not just answers
- **Real tool-calling agency** — Rocksy is backed by a tool-calling loop with 20+ structured tools across library, playlists, podcasts, audiobooks, and devices. Instead of just chatting, it fetches live data on demand and performs operations on your behalf — search and subscribe to a podcast, find and add a LibriVox audiobook, create a playlist, check a device, or repair a broken playlist, all from the chat
- **Confirm gate for destructive actions** — When Rocksy proposes something destructive (deleting episodes, removing a folder, unsubscribing, deleting a playlist) it pauses and shows **Confirm / Cancel** buttons; nothing runs until you approve
- **Chat** — Ask about your library, playlists, artists, and get recommendations
- **Persistent memory** — The assistant remembers important things you tell it across sessions (up to 40 pinned memories). Say "always remember my name is Pedro" or "don't forget I love jazz" and it will carry that context every time you open the app
- **Rolling conversation history** — Keeps the last 100 exchanges as hidden context so the assistant stays informed without cluttering your chat
- **Create playlists by talking** — Ask the assistant to make a playlist in plain English: "Make me a rock playlist with 30 tracks", "Create a late night favorites playlist from my listening history", or name the songs directly — "make me a playlist with Heroes, Starman and Life on Mars" — and Rocksy looks each one up and builds a Classic playlist. It can also add to, remove from, or rename an existing Classic playlist
- **Manage podcasts & audiobooks by talking** — "Subscribe to Syntax", "Add this RSS feed", "Find audiobooks by Jules Verne", "What audiobooks do I have?"
- **Fix broken playlists** — Playlists now repair themselves on every library scan, but you can still ask "Which playlists have missing songs?" and Rocksy will check and fix anything left over
- **Adjust device settings** — "Make my iPod's album art smaller" or "turn off artwork for my iPod" — Rocksy updates the device's artwork size or skip setting for you
- **Smart memory management** — Up to 40 permanently pinned memories that survive the rolling history limit. Say "forget about that" or "actually my name is X" to update or remove memories
- Markdown rendering, copy-paste friendly

### Auto Podcasts
- **Search & subscribe** — Find any podcast by keyword using the free [Podcast Index](https://podcastindex.org/) API
- **Add by URL** — Subscribe by pasting an RSS feed or website URL directly — no API key needed for this path. Website URLs are crawled for their feed; a preview (title, author, artwork, episode count) is shown before you confirm
- **Auto-download** — Keep the last 1–5 episodes per subscription, or switch to manual episode selection (pick up to 5 specific episodes)
- **Background refresh** — Checks feeds automatically while the app is open (every 15 min, 30 min, or 1 hour — your choice)
- **Device sync** — Downloaded episodes are automatically copied to each device that has Auto Podcasts enabled, into its `Podcasts` folder
- **Per-subscription control** — Change the download window or retrigger downloads instantly with "Download now"

### Extra Audiobooks — free public-domain audiobooks (LibriVox)
- **Search & subscribe** — Browse and subscribe to free, public-domain audiobooks from [LibriVox](https://librivox.org). No account, API key, or credentials required
- **Cover grid** — Subscribed books appear as a cover grid tagged **Extra**, with chapter count and total runtime
- **Download-on-sync** — Chapters aren't pre-downloaded; they're fetched on demand the first time you sync a device that includes the book, then copied into the device's `Audiobooks` folder (one folder per book, with cover art alongside)
- **Automatic covers** — LibriVox feeds rarely carry artwork, so covers are resolved automatically from Google Books / Open Library, with a **Search cover** picker if you want a different one
- **Detail modal** — See author, language, runtime, description, and per-chapter download state; **Remove Book** unsubscribes and deletes local files
- **Sync integration** — Audiobooks participate in Full and Custom sync (Include/Exclude) just like podcasts

### Sync & Conversion
- **Full or custom sync** — Pick albums, artists, genres, playlists
- **Albums grouped by album artist** — Compilations show up once, under "Various Artists", instead of once per contributing track artist, so the custom-sync album list stays usable. The same choice decides the on-device folder layout when you are not mirroring your library structure, so a 20-artist compilation lands in one folder rather than twenty. Switch to **Track artist** per device if you prefer the old grouping.
- **Mirror library folder structure** — Reproduce your library's folder tree on the device 1:1, album folder names and all, instead of rebuilding paths from tags
- FFmpeg conversion with metadata preserved
- **Rockbox-compatible album art** — Generates a single baseline-JPEG `cover.jpg` per album folder, resized to a per-device maximum (default 300 px so iPods stay responsive), so artwork loads reliably on Rockbox. Uses folder art or embedded artwork as the source; no extra software required
- Live progress feedback

### Web server & remote players
- **The whole app in a browser** — Turn on **Settings → Web Server** and iPodRocks serves its interface over HTTP: same library, same database, same devices, sync, playlists, ratings and Rocksy. Not a companion view — it is the app.
- **Your iPod does not have to be on the same machine as your library** — The server keeps the library, the database and the encoders; the *player* is plugged into whatever laptop you are sitting at. Your browser hands iPodRocks the player's folder and every file travels server → browser → device. Needs Chrome, Edge or another Chromium browser over HTTPS.
- **Runs headless** — A standalone daemon with no Electron at all, so the machine holding your library needs no screen and no login session. Ships with a `Dockerfile`, a `docker-compose.yml` (with a `cloudflared` sidecar) and a systemd unit.
- **Sign in with Google, GitHub, Facebook or a password** — and **signing in is not the same as being let in**: only accounts on an allowlist you control reach your library, however valid their Google account. The first person to arrive claims the server with a one-time token printed to its log.
- **Built for Cloudflare Tunnel** — The recommended shape opens no inbound port at all. Cloudflare Access is verified at the origin, not merely trusted.

### More
- **M3U8 export** — Playlists for any player
- **Dark & light themes** — Gmail-like light mode
- **Library scanning** — MP3, FLAC, AAC, OGG, Opus, WavPack, Musepack, WAV, AIFF, and more
- **Unicode-safe scanning** — Handles accented and non-Latin filenames consistently, including on SMB/SAMBA network shares

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

## Running the server

iPodRocks can serve its whole interface to a browser, so your library can live
on a machine you never sit at. There are two ways to run it, and they are the
same server — the same handlers, the same database, the same sync engine.

### From the desktop app

**Settings → Web Server → Run the web server.** Set the bind address (`127.0.0.1`
behind a tunnel, `0.0.0.0` for your LAN), the port, and — once you have a real
address — the public URL. The window and a browser can use the library at the
same time.

### As a headless daemon

No Electron, no screen, no login session. Everything is configured by
environment variable, which is container-native and needs no flag parsing.

```bash
cd ipodrocks-js
npm ci --ignore-scripts     # skips Electron's binary download; nothing else needs it
npm run build

IPODROCKS_DATA_DIR=/srv/ipodrocks IPODROCKS_SERVER_HOST=127.0.0.1 IPODROCKS_SERVER_PORT=8780 IPODROCKS_SESSION_SECRET="$(openssl rand -base64 48)" npm run server
```

With Docker:

```bash
cd ipodrocks-js
docker build -t ipodrocks-server .
docker run -d --name ipodrocks   -p 127.0.0.1:8780:8780   -v ipodrocks-data:/data   -v /srv/music:/music:ro   -e IPODROCKS_SESSION_SECRET="$(openssl rand -base64 48)"   ipodrocks-server
```

Or `docker compose up -d`, adding `--profile tunnel` for a `cloudflared`
sidecar. A systemd unit is in `ipodrocks-js/deploy/`.

### First run

The server prints a **one-time claim token** to its log (`docker logs
ipodrocks`, `journalctl -u ipodrocks-server`, or the Settings card). Open the
server in a browser and sign in with it to become the owner. Every later login
is checked against an allowlist only the owner can edit — a valid Google login
by anyone else is refused.

| Variable | Default | Meaning |
|---|---|---|
| `IPODROCKS_DATA_DIR` | platform user-data dir | Database, prefs, sessions. **Set this in a container.** |
| `IPODROCKS_SERVER_HOST` / `_PORT` | `127.0.0.1` / `8780` | Where it listens. |
| `IPODROCKS_PUBLIC_URL` | — | Externally visible origin. Required for any social sign-in. |
| `IPODROCKS_SESSION_SECRET` | random per boot | Set it, or every restart logs everyone out. |
| `IPODROCKS_TLS_CERT` / `_KEY` | — | Terminate TLS in the daemon itself. |
| `IPODROCKS_TRUSTED_PROXIES` | none | Whose `X-Forwarded-*` to believe. A security setting. |
| `IPODROCKS_<PROVIDER>_CLIENT_ID` / `_SECRET` | — | Google / GitHub / Facebook sign-in. |

Full walkthrough, including setting up each sign-in provider end to end:
**[Setting up the server, end to end](https://joaosobral.github.io/ipodrocks-js/guide/server-setup)**.
Deployment reference (Docker, compose, systemd, Cloudflare):
**[Deploying the Server](https://joaosobral.github.io/ipodrocks-js/guide/server-deployment)**.

### Remote players

In a browser, **+ Add Device** adds a *remote player*: one plugged into the
machine you are sitting at rather than the server. There is no mount path to
type — you pick the folder with your own browser's picker, and that tab holds
the device for as long as it is open.

A player belongs to exactly one machine, and iPodRocks refuses to pretend
otherwise: a server-attached player is greyed out in the browser, a remote
player is greyed out in the desktop app. Both are still listed and removable
from either side; only Check, Sync and Eject are refused. Auto Podcasts is
unavailable for a remote player, because the schedule runs on the server and a
remote player is only connected while its tab is open.

Remote players need **Chrome, Edge or another Chromium browser on a desktop,
over HTTPS** — Firefox and Safari do not implement the File System Access API,
and no browser grants folder access on an insecure origin.

---

## Quick Start

1. **Add library folder** — Open **Library**, click **Add Folder**, and choose your music root folder (for example, `/home/user/Music`). iPodRocks scans all subfolders recursively for audio files. Important to have your audio with tags
2. **Add device** — Open **Devices**, click **+ Add Device**, and pick the **root mount path of the device** (for example, `/media/ipod`). The app will automatically create `music`, `podcasts`, and `audiobooks` folders on the device if they do not exist. If you own more than one player, also pick it from the optional **USB Device** dropdown so the two never get confused for each other.
3. **Create playlists** (optional) — Open **Playlists** for Classic (hand-picked), Smart, Genius, or Savant playlists.
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
- Choose the generated album-art size per device (200–750 px; default 300 px keeps iPods responsive), or turn artwork off entirely
- Use shadow libraries for devices that need pre-converted files
- Check device status: synced tracks, orphan files, and sync history

### Playlists

- **Classic** — Hand-picked: tick the songs you want, in the order you want them (max 500). Search and filter by artist/album/genre without losing your selection. The only playlist type you can edit afterwards
- **Smart** — Rule-based (genre, artist, album) with track limits, multi-select 3-column builder, and a `top_rated` strategy for 4★+ tracks
- **Genius** — From Rockbox's runtime data; import from the device first. Includes `top_rated` and `hidden_gems`, which work without any play history
- **Savant** — AI-generated from mood (requires OpenRouter API key in Settings); rating-aware curation
- **Tagnavi mode** — Enable "Rockbox smart playlists (tagnavi)" on a device to sync Smart playlists as live, auto-updating Rockbox tagtree entries instead of static `.m3u` files
- **Via Rocksy** — Ask the chat to create a playlist in plain English. Name specific songs and Rocksy looks each one up and builds a Classic playlist; describe genres or history and it builds a Smart or Genius one. It can edit Classic playlists too
- **Automatic upkeep** — Deleted songs are removed from every playlist on the next library scan, and Smart playlists are re-resolved from their rules. Manual Repair, Rebuild (Smart), and the sync gate's "Repair all & continue" are still available

### Auto Podcasts

- Subscribe to any podcast via the **Search & Subscribe** modal (powered by Podcast Index — free API key required), or use the **Add by URL** tab to paste an RSS feed or website URL directly (no API key needed)
- Set each subscription to auto-download the last 1–5 episodes, or pick episodes manually
- Background scheduler refreshes feeds and downloads new episodes automatically
- Enable Auto Podcasts on a device (in its settings) to have ready episodes copied there on every refresh cycle
- Get credentials at [api.podcastindex.org/signup](https://api.podcastindex.org/signup), then configure in **Settings → Auto Podcasts**

### Extra Audiobooks

- Open the **Extra Audiobooks** tab and click **Search & Add** to find free, public-domain audiobooks on [LibriVox](https://librivox.org) by title or author — no account or API key required
- Subscribe in one click; the chapter list is pulled from the book's RSS feed and a cover is fetched automatically (use **Search cover** to pick a different one)
- Chapters use **download-on-sync** — they're fetched on demand the first time you sync a device that includes the book, then copied to its `Audiobooks` folder as `<Author - Title>/NN <Chapter>.ext` with `cover.<ext>` alongside
- Include audiobooks in **Full sync** via the content toggle, or pick specific books in **Custom sync** (Include or Exclude)
- Open a book to see per-chapter download state; **Remove Book** unsubscribes and deletes its local files

### Sync

- **Full sync** — Music, podcasts, audiobooks, playlists
- **Custom sync** — Pick albums, artists, genres, playlists
- **Mirror library folder structure** — On by default; keeps the device layout identical to your library, including album folders that carry the year (`Levels (2011)`). Turn it off to rebuild paths from tags as `Artist/Album/track.ext`
- **Group albums by** — **Album artist** (default) keeps a compilation as one album in both the picker and the rebuilt folder layout; **Track artist** restores the older per-track-artist behaviour
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
