# Dashboard

The Dashboard gives you an at-a-glance view of your library, devices, shadow libraries, listening habits, and recent activity.

## What it does

The Dashboard shows five cards:

- **Library** — Total tracks, albums, artists, and total size. Updates when you scan or add folders.
- **Devices** — List of configured devices with their mount paths and status.
- **Shadow Libraries** — Pre-transcoded mirrors (e.g. FLAC → MPC) with track count, size, and sync status.
- **Listening Stats** — Your top tracks, top artists, top genre, total plays, and total listening time, built from the `playback.log` data your Rockbox devices write and that iPodRocks reads during sync. A toggle in the card's top-right switches the period between **All Time**, **This Year**, and **This Month**.
- **Recent Activity** — Last operations: syncs, library scans, folder adds, device adds, playback log reads, playlist generations.

### Listening Stats and your device's clock

Rockbox timestamps every logged play using the device's own clock. If that clock has never been set — or was reset by a dead battery — Rockbox logs every play as happening in the year 2000. iPodRocks treats a play timestamped before 2010 as untrustworthy and excludes it from every count in this card (the same guard used elsewhere for Genius's "Late Night Mood" playlist).

If iPodRocks finds real logged plays but none of them have a trustworthy timestamp, the card shows a dismissible warning explaining the device's clock isn't set and how to fix it (on the device: **Settings → General → Time & Date**). Once you set the clock, newly logged plays start counting normally. You can dismiss the warning at any time — the choice is remembered, even after restarting the app — but the underlying plays stay excluded from your stats until the device clock is actually fixed and new plays are logged.

## How it works

The Dashboard fetches data from the database and device store when you open it. Library stats come from the tracks table; shadow libraries and activity come from their respective tables; Listening Stats reads `playback_logs` directly (so it can filter by period) rather than the pre-aggregated all-time `playback_stats` table. No background refresh — switch away and back, or change the Listening Stats period, to reload.

## How to work with it

1. Use the Dashboard as your home base after initial setup. Check that library stats look correct after a scan.
2. Verify devices are listed and mount paths are valid before syncing.
3. If you use shadow libraries, confirm they show "Ready" before pointing a device at them.
4. If Listening Stats shows the device-clock warning, set the date and time on the device itself — the fix happens on the device, not in iPodRocks.
5. Use Recent Activity to see what ran recently (e.g. "Sync", "Library scan", "Read playback log").
