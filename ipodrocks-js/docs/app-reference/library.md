# Library

The Library panel manages your music catalog: folders, scans, shadow libraries, and the track list.

## What it does

- **Add Folder** — Add a root folder for music, podcasts, or audiobooks. iPodRocks scans it recursively.
- **Scan Library** — Re-scan all folders to pick up new or changed files. Uses content hashes to skip unchanged files.
- **Clear scan cache** — Reset content hashes so the next scan re-processes all files (use when tags or files changed externally).
- **Harmonic data banner** — Shows how many tracks have key/BPM data. Links to Settings to enable extraction and Essentia analysis.
- **Library Folders** — Compact list of added folders with remove option.
- **Shadow Libraries** — Pre-transcoded mirrors (e.g. FLAC → MPC). Create, rebuild, or delete them.
- **Tracks / Playlists** — Switch between the track list and library playlists. Search, sort, and filter by device, type, and sync status.

## How it works

- **Scan** reads file tags (artist, album, title, genre, etc.) and optionally key/BPM via metadata or Essentia. It stores content hashes to skip unchanged files on the next scan.
- **Shadow libraries** are built once; devices can use them as the source instead of the primary library for faster sync (no on-the-fly transcoding). A shadow library is a **file-only mirror** — it contains the transcoded audio files and copied album artwork, nothing else. Play counts, ratings, and listening history are **not** stored in or synced through shadow libraries; they live in the primary library database and are updated by ingesting `playback.log` from the device. When the primary library changes, shadow libraries are kept in sync automatically (adds, updates, and removes propagate).
- The track list is virtualized for large libraries. Filters (device, type, on device) apply in memory.

## How to work with it

1. **Before scanning:** Enable "Extract harmonic data" and "Analyze with Essentia" in Settings if you want key/BPM for Savant and harmonic mixing. Then add folders and scan.
2. **After adding a folder:** A scan runs automatically. Wait for it to finish before syncing.
3. **Shadow libraries:** Create one if you sync to a device that needs a different codec (e.g. MPC). Point the device to the shadow in Devices.
4. **Clear cache:** Only when you know files or tags changed outside iPodRocks and you want a full re-scan.
