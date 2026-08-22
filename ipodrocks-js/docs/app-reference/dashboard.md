# Dashboard

The Dashboard gives you an at-a-glance view of your library, devices, shadow libraries, listening habits, and recent activity.

## What it does

The Dashboard shows five cards:

- **Library** — Total tracks, albums, artists, and total size. Updates when you scan or add folders.
- **Devices** — List of configured devices with their mount paths and status. Devices pinned to a specific piece of hardware also show a `USB vvvv:pppp` badge.
- **Shadow Libraries** — Pre-transcoded mirrors (e.g. FLAC → MPC) with track count, size, and sync status.
- **Listening Stats** — Your top tracks, top artists, top genre, total plays, and total listening time, built from the counters Rockbox records on your device and iPodRocks imports during sync. A toggle in the card's top-right switches the period between **All Time**, **This Year**, and **This Month**.
- **Recent Activity** — Last operations: syncs, library scans, folder adds, device adds, play history imports, playlist generations.

### Why This Year and This Month can show less than All Time

Rockbox does not date the plays it records — it keeps running totals and a play-order number, and nothing else. **All Time** reads those totals, so it always reflects everything Rockbox has ever counted.

**This Year** and **This Month** need dates, and the only honest ones available come from iPodRocks itself: each time an import sees a track's play count go up, it records the date it saw that happen, using this computer's clock. So the scoped views cover the period since iPodRocks started watching, not your entire listening history. A library with thousands of plays can legitimately show zero for this month — the card says so rather than claiming you have no listening data.

Two other things follow from how Rockbox counts. A play only registers once a track has run 15 seconds, so tracks you skip immediately never appear at all. And your device's clock is irrelevant to any of this — an unset RTC no longer affects your statistics, which it did when iPodRocks read the playback log.

## How it works

The Dashboard fetches data from the database and device store when you open it. Library stats come from the tracks table; shadow libraries and activity come from their respective tables; Listening Stats reads the all-time roll-up in `playback_stats` for **All Time**, and the dated observations in `runtime_play_deltas` for **This Year** and **This Month**. No background refresh — switch away and back, or change the Listening Stats period, to reload.

## How to work with it

1. Use the Dashboard as your home base after initial setup. Check that library stats look correct after a scan.
2. Verify devices are listed and mount paths are valid before syncing.
3. If you use shadow libraries, confirm they show "Ready" before pointing a device at them.
4. If Listening Stats is empty, check **Gather Runtime Data** is on under **Settings → Playback Settings** on the device, then sync.
5. Use Recent Activity to see what ran recently (e.g. "Sync", "Library scan", "Imported play history").
