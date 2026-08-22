# Sync

The Sync panel copies music, podcasts, audiobooks, and playlists from your library (or shadow library) to a device.

## What it does

- **Device** — Select which device to sync.
- **Sync type** — Full (everything) or Custom (pick albums, artists, genres, playlists).
- **Full sync options** — Include/exclude music, podcasts, audiobooks, playlists. Orphan Policy (keep, remove, prompt). Skip album artwork.
- **Custom sync** — Select specific albums, artists, genres, podcasts, audiobooks, and playlists. Choose **Include** (sync only the ticked items) or **Exclude** (sync everything *except* the ticked items). The Audiobooks box includes **Extra Audiobooks** subscribed from LibriVox (see [Extra Audiobooks](./audiobooks.md)).
- **Mirror library folder structure** — On by default. Reproduces your library's folder tree on the device 1:1, keeping album folder names exactly as they are (including the year, e.g. `Levels (2011)`). Turn it off to rebuild device paths from tags instead, as `Artist/Album/track.ext`.
- **Group albums by** — Which artist identifies an album: **Album artist** (default) or **Track artist**. See below.
- **Start Sync** — Runs the sync. Progress modal shows files copied, converted, and removed.
- **Results** — After sync, a summary card shows success, warnings, or errors.

## How it works

- **Source** — Uses the primary library or the device's configured shadow library. If shadow, files are copied as-is (no transcoding during sync).
- **Transcoding** — When using the primary library and the device needs a different codec, FFmpeg converts on the fly. Metadata (tags, artwork) is preserved.
- **Shadow library vs. sync-time transcoding** — Both end up with the right codec on the device, but the work happens at different times:
  - **Shadow library** — Transcode the whole library once, up front, into a separate folder. Sync then just copies those pre-converted files to the device. Trade: uses extra disk space on your computer, but subsequent syncs are fast and can be reused across multiple devices that share the same codec.
  - **Sync in another format** — No pre-built mirror. The device profile specifies a target codec, and FFmpeg converts each missing track on the fly during the sync. Trade: no extra disk space, but every sync that adds tracks pays the conversion cost again.
- **What sync does and does not propagate** — Sync is a **one-way file copy** from computer to device. It only transfers audio files and album artwork; it does not write play counts, ratings, or any other library metadata to the device. This also applies to shadow libraries: they hold pre-transcoded audio files only — no play counts, ratings, or listening history. Play counts flow the *other* direction: iPodRocks imports them from the counters Rockbox keeps on the device (see Devices → "Play history"). Ratings are the one exception to the one-way rule — they travel both ways, and a rating you set in iPodRocks is written into Rockbox's own database on the next sync.
- **Orphan Policy** (labeled "Extra Track Policy" in some earlier versions) — Controls what happens to files that exist **on the device but are not in the library** (orphans):
  - **Remove** — Delete them during sync so the device mirrors the library.
  - **Keep** — Leave them alone. Useful if you manually copy files to the device outside of iPodRocks.
  - **Prompt** — Ask you each time orphans are found.
- **Codec mismatches** — When a device has files in a codec that no longer matches its profile (e.g. old Musepack files after switching the profile to Opus) and you sync with **Orphan Policy = "Remove"**, those old-codec files are removed and replaced by the new codec during sync.
- **Album artwork** — Copied by default (`cover.jpg`, `folder.png`, etc.). The **Skip album artwork** option is a per-device setting (Devices panel), not a per-sync toggle.
- **Extra Audiobooks** — LibriVox audiobooks are downloaded on demand during the sync (not pre-fetched). Each book's chapters and cover are copied to `<device>/<Audiobooks folder>/<Author - Title>/`. See [Extra Audiobooks](./audiobooks.md).
- **Rockbox tagnavi (per-device option)** — If the device profile has "Rockbox smart playlists (tagnavi)" enabled, smart playlists are written to `<device>/.rockbox/tagnavi_custom.config` instead of `Playlists/<name>.m3u`. See [Devices](./devices.md) and [Smart Playlists](./playlists-smart.md).

## How to work with it

1. **Select the device** and ensure it is mounted.
2. **Full sync** — Use for a complete mirror. Set Orphan Policy to "Remove" if you want the device to match the library exactly.
3. **Custom sync** — Use when you want only certain albums, artists, or playlists. Pick the **Mode** (Include or Exclude), tick items in the category boxes, and click Start Sync.
4. **Check Device** first (in Devices) to see synced vs to-sync vs orphans before syncing.

## Custom Sync — Include vs. Exclude

Custom sync has two polarities controlled by the **Mode** radio at the top of the "Choose what to sync" card:

- **Include** *(default)* — Only the ticked items are synced. Tick "Pink Floyd" and "Bowie" under Artists and only those two artists land on the device. Ticked items highlight in **green**; items pulled in transitively via a selected playlist highlight in **yellow**.
- **Exclude** — Everything *except* the ticked items is synced. Tick "Christmas Carols" under Genres and the entire library minus that genre lands on the device. The natural fit for "sync the whole library minus a few albums" without having to manually tick everything else. Ticked items highlight in **red** (they are being excluded); items pulled in transitively via a selected playlist highlight in **light orange**.
- **Empty Exclude = full sync** — Switching to Exclude mode and ticking nothing is equivalent to a full sync of every content type. There is no hidden gotcha here; nothing matches an empty exclusion set so nothing gets filtered out.
- **Cross-category combination** — Selections across the six category boxes (Albums, Artists, Genres, Podcasts, Audiobooks, Playlists) combine with OR semantics in both modes. In Include mode a track is kept if it matches *any* selection; in Exclude mode a track is dropped if it matches *any* selection.
- **Playlist propagation** — Selecting a playlist pulls in (Include) or pushes out (Exclude) every track in that playlist, regardless of whether their albums/artists/genres are individually ticked. The albums, artists, and genres of those tracks light up in the "transitive" highlight color (yellow in Include, light orange in Exclude) so it's clear *why* they're affected.

## Album Grouping — Album Artist vs. Track Artist

An album is identified by its title *and* an artist. **Group albums by** decides which artist that is, and it affects two things at once: the entries in the Custom sync **Albums** box, and — when **Mirror library folder structure** is off — the folder layout written to the device.

- **Album artist** *(default)* — Uses the `albumartist` tag, falling back to the track artist when a file does not have one. A compilation whose tracks are by twenty different artists but which is tagged `Various Artists` is **one** album: one row in the picker, and one `Various Artists/<album>/` folder on the device. Albums containing a guest feature stay whole for the same reason.
- **Track artist** — Uses each track's own `artist` tag, which is how iPodRocks behaved before v2.3.0. The same compilation becomes twenty separate album entries and twenty folders on the device. Available for libraries that are deliberately organised this way.

The setting is per device and is saved with the rest of that device's sync preferences.

**Album rows show the album name.** The list reads as album titles alone; the artist is appended only when two different albums share a title (e.g. "Greatest Hits — ABBA" and "Greatest Hits — Queen"), where it is the only thing telling them apart. Hover any row to see its full name.

**If the two options look identical**, no album-artist tags are in use in your library and the panel says so. iPodRocks reads that tag **from your files during a library scan**, so this is what you see when the library was last scanned before v2.3.0, or when you tagged album artists after your last scan. The note has a **Scan library** button that runs one; the scan reads the tags and the list changes on your next visit.

**Changing it moves files.** The grouping decides where tracks are written, so switching it (or switching **Mirror library folder structure**) means the next sync copies tracks to their new locations. Set the Orphan Policy to **Remove** on that sync if you want the old folders cleaned up in the same pass; with **Keep** they stay behind until you remove them yourself.

**Upgrading from an earlier version.** Libraries scanned before v2.3.0 never had their `albumartist` tags read, so their compilations are still split per track artist. The next library scan re-reads those tags once and merges the duplicate album entries; it does not re-hash files or re-transcode shadow libraries, so it is quick. Album selections you had already saved keep working — the old labels are still matched, and the picker moves them onto the new ones for you.

## Per-Device Sync Preferences

Selecting a device in the Sync panel automatically restores that device's last-used sync configuration: sync type, content toggles (music/podcasts/audiobooks/playlists), orphan policy, **Mirror library folder structure**, **Group albums by**, **the custom-sync Include/Exclude mode**, and any custom selections of albums, artists, genres, playlists, podcasts, and audiobooks.

The state is saved every time you click **Sync** for that device — even if the sync errors partway through, because the saved state captures your intent, not the outcome.

Devices that have never been synced through this panel fall back to the panel defaults: full sync, all content types enabled, keep-orphans policy, mirror library folder structure = on, group albums by = Album artist, custom-sync mode = Include.

When you switch between devices, the panel live-swaps to that device's saved configuration. Removing a device from the Devices panel also clears its saved preferences.

## Rocksy

[Rocksy](./assistant.md) can run a sync for you from the chat:

- "Check what would sync to my iPod" → `device_check` *(asks you to confirm first)*
- "Sync my iPod" → `device_sync` *(asks you to confirm first)*
- "Which iPod is plugged in right now?" → `usb_device_list`

Both are destructive operations, so Rocksy pauses for a **Confirm / Cancel** prompt before running. See [Devices → Rocksy](./devices.md#rocksy).
