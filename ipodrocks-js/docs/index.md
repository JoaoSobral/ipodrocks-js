---
layout: home

hero:
  name: iPodRocks
  text: Sync manager for Rockbox and mountable devices
  tagline: Multiple libraries, shadow transcoding, AI playlists, harmonic mixing — all in one desktop app.
  image:
    src: /logo.png
    alt: iPodRocks
  actions:
    - theme: brand
      text: Download iPodRocks
      link: https://github.com/joaosobral/ipodrocks-js/releases/latest
    - theme: alt
      text: Getting Started
      link: /guide/getting-started
    - theme: alt
      text: App Reference
      link: /app-reference/welcome
---

If you really like iPodRocks and want to keep it caffeinated, you can buy me a coffee — every cup helps keep the development going. Thank you! ☕

<p align="center">
  <a href="https://buymeacoffee.com/vador">
    <img src="/buy_me_a_coffee.png" alt="Buy me a coffee" width="190">
  </a>
</p>

## Download

Grab the latest release for macOS or Windows from the [GitHub Releases page](https://github.com/joaosobral/ipodrocks-js/releases/latest). Unzip and run — no installer required.

## What is iPodRocks?

iPodRocks is a **sync manager** for [Rockbox devices](https://www.rockbox.org/) and any mountable player. It is **not** a library manager — use [beets](https://beets.io/) or similar to manage your collection. Once your library is ready, iPodRocks syncs it to multiple devices with transcoding, playlists, and AI-powered features.

## Key features

- **Multiple library folders** — Music, podcasts, audiobooks in one catalog
- **Mirror library folder structure** — A per-device sync toggle (on by default) that copies your music to the device using the *exact* source folder layout — album folders keep their original names, year and all (`Avicii/Levels (2011)/…`). With it off, the device path is rebuilt from the artist/album tags (so `Levels (2011)` becomes `Levels`). Keep it on if you export M3U playlists from Plex, beets, or similar and need the device paths to match 1:1.
- **Shadow libraries** — Pre-transcoded mirrors (e.g. FLAC → MPC) for fast sync
- **Multiple devices** — iPods, Rockbox players, any FAT32/exFAT-mounted drive
- **Auto Podcasts** — Subscribe by keyword or RSS/website URL, auto-download episodes, and sync to devices in the background
- **Extra Audiobooks** — Subscribe to free public-domain audiobooks from LibriVox; chapters download on sync
- **Smart, Genius, and Savant playlists** — Rule-based, playback-history, or AI-generated
- **Harmonic mixing** — Key and BPM detection, Camelot wheel compatibility
- **Rocksy** — Floating AI chat that knows your library and can act on your behalf — create playlists, manage podcasts and audiobooks, check and sync devices

## Next steps

- [Getting Started](/guide/getting-started) — Install, add a library folder and device, run your first sync
- [Architecture](/guide/architecture) — How the Electron main/renderer processes, IPC, and modules fit together
- [App Reference](/app-reference/welcome) — Tab-by-tab documentation of every feature
- [Troubleshooting](/guide/troubleshooting) — Common issues and fixes
