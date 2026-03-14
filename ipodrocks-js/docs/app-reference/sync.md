# Sync

The Sync panel copies music, podcasts, audiobooks, and playlists from your library (or shadow library) to a device.

## What it does

- **Device** — Select which device to sync.
- **Sync type** — Full (everything) or Custom (pick albums, artists, genres, playlists).
- **Full sync options** — Include/exclude music, podcasts, audiobooks, playlists. Extra track policy (keep, remove, prompt). Skip album artwork.
- **Custom sync** — Select specific albums, artists, genres, podcasts, audiobooks, and playlists.
- **Start Sync** — Runs the sync. Progress modal shows files copied, converted, and removed.
- **Results** — After sync, a summary card shows success, warnings, or errors.

## How it works

- **Source** — Uses the primary library or the device's configured shadow library. If shadow, files are copied as-is (no transcoding during sync).
- **Transcoding** — When using the primary library and the device needs a different codec, FFmpeg converts on the fly. Metadata (tags, artwork) is preserved.
- **Extra track policy** — "Keep" leaves device-only files. "Remove" deletes them. "Prompt" asks you.
- **Orphans** — Files on the device not in the library. Handled by the extra track policy.
- **Album artwork** — Copied by default (`cover.jpg`, `folder.png`, etc.). Uncheck "Skip album artwork" to disable.

## How to work with it

1. **Select the device** and ensure it is mounted.
2. **Full sync** — Use for a complete mirror. Set extra track policy to "Remove" if you want the device to match the library exactly.
3. **Custom sync** — Use when you want only certain albums, artists, or playlists. Pick from the lists and click Start Sync.
4. **Check Device** first (in Devices) to see synced vs to-sync vs orphans before syncing.
5. **Ignore space check** — Only if you are sure the device has enough space; normally the app checks.
