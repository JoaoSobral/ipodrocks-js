---
layout: home

hero:
  name: iPodRocks
  text: Sync your iPod from anywhere
  tagline: A sync manager for Rockbox and any mountable player. Keep the library on one machine, plug the player into another, and sync over the web. Multiple libraries, shadow transcoding, podcasts, audiobooks, playlists and ratings.
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

iPodRocks is a **sync manager** for [Rockbox devices](https://www.rockbox.org/) and any mountable player. It is **not** a library manager — use [beets](https://beets.io/) or similar to manage your collection. Once your library is ready, iPodRocks keeps as many players as you own in step with it: transcoding, playlists, album art, podcasts, audiobooks, star ratings and play history.

## Sync from anywhere

Your player no longer has to be plugged into the machine holding your music.

Run iPodRocks as a **server** — on a NAS, a home server, an old desktop in a
cupboard — and open it in a **browser wherever you happen to be**. Plug the iPod
into *that* laptop, point the browser at its folder, and sync it to the library
at home. Nothing is copied to the laptop in between: the same app, the same
database, the same ratings and play history, reached over HTTPS behind a login
you control.

```
  the machine with your music            the machine you are sitting at
  ───────────────────────────            ──────────────────────────────
  library + SQLite + ffmpeg   ──HTTPS──▶  a browser tab   ──USB──▶  your iPod
  the sync engine             ◀──WS────   holds the device
```

It runs headless too — a plain daemon with no Electron, shipped with a
`Dockerfile`, a `docker-compose.yml` and a systemd unit — and it is built to sit
behind a Cloudflare Tunnel that opens no inbound port at all.

→ [Setting up the server, end to end](/guide/server-setup)

## Key features

- **Multiple library folders** — Music, podcasts, audiobooks in one catalog
- **Multiple devices** — iPods, Rockbox players, any FAT32/exFAT-mounted drive, each with its own codec, folder layout and artwork settings. Pin a device to its USB hardware so two identical iPods never get confused for each other
- **Remote devices** — A player plugged into the machine running your *browser*, synced from the library on the server. Chrome, Edge or another Chromium browser, over HTTPS
- **Shadow libraries** — Pre-transcoded mirrors (e.g. FLAC → MPC) for fast sync, and a faithful one: rename or delete an album and the shadow follows
- **Mirror library folder structure** — A per-device sync toggle (on by default) that copies your music to the device using the *exact* source folder layout — album folders keep their original names, year and all (`Avicii/Levels (2011)/…`). With it off, the device path is rebuilt from the artist/album tags (so `Levels (2011)` becomes `Levels`). Keep it on if you export M3U playlists from Plex, beets, or similar and need the device paths to match 1:1.
- **Classic, Smart and Genius playlists** — Hand-picked, rule-based, or built from the play counts and listening time Rockbox records itself. All of them drop deleted songs automatically on the next library scan
- **Star ratings, both ways** — Rate a track in iPodRocks and it appears on the player; rate it on the player and it appears in your library, with real conflict resolution rather than a last-writer-wins guess
- **Listening stats** — Top tracks, artists and total listening time, imported from the device's own playback history
- **Auto Podcasts** — Subscribe by keyword or RSS/website URL, auto-download episodes, and sync to devices in the background
- **Extra Audiobooks** — Subscribe to free public-domain audiobooks from LibriVox; chapters download on sync
- **Harmonic mixing** — Key and BPM detection, Camelot wheel compatibility
- **Rockbox-native smart playlists** — Per-device opt-in: live, auto-updating tagnavi entries instead of frozen `.m3u` snapshots

**All of the above works offline, with no account and no API key.**

## Optional: the AI extras

Two features, both off until you supply an [OpenRouter](https://openrouter.ai/keys)
key of your own. Leave it blank and nothing else changes.

- **Savant playlists** — Describe a mood and get a playlist back, harmonically
  sequenced and weighted toward your highly-rated tracks. One extra playlist
  type; Classic, Smart and Genius need no key.
- **[Rocksy](/app-reference/assistant)** — A chat assistant that can act rather
  than only answer: build playlists, subscribe to podcasts, check and sync
  devices, manage the web server's allowlist. Convenient, never required —
  everything it does has a button somewhere.

## Next steps

- [Getting Started](/guide/getting-started) — Install, add a library folder and device, run your first sync
- [Setting up the server](/guide/server-setup) — Run iPodRocks for a browser, and sync a player plugged into another machine
- [Architecture](/guide/architecture) — How the Electron main/renderer processes, IPC, and modules fit together
- [App Reference](/app-reference/welcome) — Tab-by-tab documentation of every feature
- [Troubleshooting](/guide/troubleshooting) — Common issues and fixes
