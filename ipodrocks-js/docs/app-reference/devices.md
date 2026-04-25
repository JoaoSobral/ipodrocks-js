# Devices

The Devices panel lets you add, edit, and check Rockbox and mountable players.

## What it does

- **Add Device** — Register a new device with name, mount path, model, codec config, and folder layout.
- **Edit Device** — Change any device setting.
- **Check Device** — Compare what is on the device with the library. Shows synced, codec mismatch, to sync, and orphans.
- **Recheck** — Re-read the device after changes (e.g. after a sync or manual file changes).
- **Set as default** — Use this device as the default for sync and Genius.

## How it works

- **Mount path** — The root path where the device is mounted (e.g. `/media/ipod`). iPodRocks expects `Music`, `Podcasts`, `Audiobooks`, and `Playlists` subfolders (configurable).
- **Codec config** — Direct copy (no conversion) or transcode to MP3, AAC, Musepack, Opus, OGG. If you use a shadow library, set the device source to "Shadow" and pick the shadow — no transcoding during sync.
- **Check Device** — Scans the device filesystem and compares with the library. "Codec mismatch" means files use a different codec than the device profile (e.g. MP3 on device, OPUS profile); when you sync with **Orphan Policy set to "Remove"**, old-codec files are deleted and replaced by the new codec.
- **Orphans** — Files on the device that are not in the library. You can remove them during sync **only when Orphan Policy is set to "Remove"** (the setting lives in the Sync panel); with "Keep" or "Prompt", orphans are not auto-deleted.

## How to work with it

1. **Add a device** only when it is mounted. Use the real mount path (e.g. `/media/ipod`, not a symlink if that causes issues).
2. **Choose codec** based on device support. Rockbox supports many formats; use direct copy for FLAC/MP3 if the device plays them. Use MPC or Opus for smaller files.
3. **Use shadow libraries** when you want to pre-transcode once and sync quickly to multiple devices.
4. **Check Device** before syncing to see what will change. Use "Recheck" after a sync to confirm.
5. **Playback log** — Enable if you use Genius playlists; iPodRocks reads `playback.log` from the device for listening history.
6. **Rockbox smart playlists (tagnavi)** — When enabled, smart playlists sync as live tagnavi query entries (written to `.rockbox/tagnavi_user.config`) instead of static `.m3u` files. Genius, Savant, and Custom playlists always write `.m3u` regardless of this setting. See [Smart Playlists → Rockbox dynamic mode](./playlists-smart.md#rockbox-dynamic-mode-per-device-opt-in).
