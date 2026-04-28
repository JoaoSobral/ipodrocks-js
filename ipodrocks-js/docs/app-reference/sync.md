# Sync

The Sync panel copies music, podcasts, audiobooks, and playlists from your library (or shadow library) to a device.

## What it does

- **Device** — Select which device to sync.
- **Sync type** — Full (everything) or Custom (pick albums, artists, genres, playlists).
- **Full sync options** — Include/exclude music, podcasts, audiobooks, playlists. Orphan Policy (keep, remove, prompt). Skip album artwork.
- **Custom sync** — Select specific albums, artists, genres, podcasts, audiobooks, and playlists.
- **Start Sync** — Runs the sync. Progress modal shows files copied, converted, and removed.
- **Results** — After sync, a summary card shows success, warnings, or errors.

## How it works

- **Source** — Uses the primary library or the device's configured shadow library. If shadow, files are copied as-is (no transcoding during sync).
- **Transcoding** — When using the primary library and the device needs a different codec, FFmpeg converts on the fly. Metadata (tags, artwork) is preserved.
- **Shadow library vs. sync-time transcoding** — Both end up with the right codec on the device, but the work happens at different times:
  - **Shadow library** — Transcode the whole library once, up front, into a separate folder. Sync then just copies those pre-converted files to the device. Trade: uses extra disk space on your computer, but subsequent syncs are fast and can be reused across multiple devices that share the same codec.
  - **Sync in another format** — No pre-built mirror. The device profile specifies a target codec, and FFmpeg converts each missing track on the fly during the sync. Trade: no extra disk space, but every sync that adds tracks pays the conversion cost again.
- **What sync does and does not propagate** — Sync is a **one-way file copy** from computer to device. It only transfers audio files and album artwork; it does not write play counts, ratings, or any other library metadata to the device. This also applies to shadow libraries: they hold pre-transcoded audio files only — no play counts, ratings, or listening history. Play counts flow the *other* direction: iPodRocks ingests them by reading Rockbox's `playback.log` from the device into the library (see Devices → "Playback log").
- **Orphan Policy** (labeled "Extra Track Policy" in some earlier versions) — Controls what happens to files that exist **on the device but are not in the library** (orphans):
  - **Remove** — Delete them during sync so the device mirrors the library.
  - **Keep** — Leave them alone. Useful if you manually copy files to the device outside of iPodRocks.
  - **Prompt** — Ask you each time orphans are found.
- **Codec mismatches** — When a device has files in a codec that no longer matches its profile (e.g. old Musepack files after switching the profile to Opus) and you sync with **Orphan Policy = "Remove"**, those old-codec files are removed and replaced by the new codec during sync.
- **Album artwork** — Copied by default (`cover.jpg`, `folder.png`, etc.). Uncheck "Skip album artwork" to disable.
- **Rockbox tagnavi (per-device option)** — If the device profile has "Rockbox smart playlists (tagnavi)" enabled, smart playlists are written to `<device>/.rockbox/tagnavi_custom.config` instead of `Playlists/<name>.m3u`. See [Devices](./devices.md) and [Smart Playlists](./playlists-smart.md).

## How to work with it

1. **Select the device** and ensure it is mounted.
2. **Full sync** — Use for a complete mirror. Set Orphan Policy to "Remove" if you want the device to match the library exactly.
3. **Custom sync** — Use when you want only certain albums, artists, or playlists. Pick from the lists and click Start Sync.
4. **Check Device** first (in Devices) to see synced vs to-sync vs orphans before syncing.
5. **Ignore space check** — Only if you are sure the device has enough space; normally the app checks.

## Per-Device Sync Preferences

Selecting a device in the Sync panel automatically restores that device's last-used sync configuration: sync type, content toggles (music/podcasts/audiobooks/playlists), orphan policy, space-check setting, artwork-skip setting, and any custom selections of albums, artists, genres, playlists, podcasts, and audiobooks.

The state is saved every time you click **Sync** for that device — even if the sync errors partway through, because the saved state captures your intent, not the outcome.

Devices that have never been synced through this panel fall back to the panel defaults: full sync, all content types enabled, keep-orphans policy, no artwork skip.

When you switch between devices, the panel live-swaps to that device's saved configuration. Removing a device from the Devices panel also clears its saved preferences.
