# Dashboard

The Dashboard gives you an at-a-glance view of your library, devices, shadow libraries, and recent activity.

## What it does

The Dashboard shows four cards:

- **Library** — Total tracks, albums, artists, and total size. Updates when you scan or add folders.
- **Devices** — List of configured devices with their mount paths and status.
- **Shadow Libraries** — Pre-transcoded mirrors (e.g. FLAC → MPC) with track count, size, and sync status.
- **Recent Activity** — Last operations: syncs, library scans, folder adds, device adds, playback log reads, playlist generations.

## How it works

The Dashboard fetches data from the database and device store when you open it. Library stats come from the tracks table; shadow libraries and activity come from their respective tables. No background refresh — switch away and back to reload.

## How to work with it

1. Use the Dashboard as your home base after initial setup. Check that library stats look correct after a scan.
2. Verify devices are listed and mount paths are valid before syncing.
3. If you use shadow libraries, confirm they show "Ready" before pointing a device at them.
4. Use Recent Activity to see what ran recently (e.g. "Sync", "Library scan", "Read playback log").
