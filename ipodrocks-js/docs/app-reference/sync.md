# Sync

The Sync panel copies music, podcasts, audiobooks, and playlists from your library (or shadow library) to a device.

## What it does

- **Device** — Select which device to sync.
- **Sync type** — Full (everything) or Custom (pick albums, artists, genres, playlists).
- **Full sync options** — Include/exclude music, podcasts, audiobooks, playlists. Orphan & Reset Policy (keep, remove orphans, delete all, prompt). Skip album artwork.
- **Custom sync** — Select specific albums, artists, genres, podcasts, audiobooks, and playlists. Choose **Include** (sync only the ticked items) or **Exclude** (sync everything *except* the ticked items). The Audiobooks box includes **Extra Audiobooks** subscribed from LibriVox (see [Extra Audiobooks](./audiobooks.md)).
- **Mirror library folder structure** — On by default. Reproduces your library's folder tree on the device 1:1, keeping album folder names exactly as they are (including the year, e.g. `Levels (2011)`). Turn it off to rebuild device paths from tags instead, as `Artist/Album/track.ext`.
- **Group albums by** — Which artist identifies an album: **Album artist** (default) or **Track artist**. See below.
- **Build Rockbox database** — Off by default, remembered per device. At the end of the sync, iPodRocks writes the player's Rockbox database itself, so the new music is browsable the moment you unplug — no **Database → Update now** on the device. See [Building the Rockbox database](#building-the-rockbox-database).
- **Start Sync** — Runs the sync. Progress modal shows files copied, converted, and removed, the amount transferred and the current speed (KB/s or MB/s) with an estimate of the time left. A sync keeps running on its own if you leave the Sync panel or reload the page; coming back re-opens its progress.
- **Results** — After sync, a summary card shows success, warnings, or errors.

## How it works

- **Source** — Uses the primary library or the device's configured shadow library. If shadow, files are copied as-is (no transcoding during sync).
- **Transcoding** — When using the primary library and the device needs a different codec, FFmpeg converts on the fly. Metadata (tags, artwork) is preserved.
- **Shadow library vs. sync-time transcoding** — Both end up with the right codec on the device, but the work happens at different times:
  - **Shadow library** — Transcode the whole library once, up front, into a separate folder. Sync then just copies those pre-converted files to the device. Trade: uses extra disk space on your computer, but subsequent syncs are fast and can be reused across multiple devices that share the same codec.
  - **Sync in another format** — No pre-built mirror. The device profile specifies a target codec, and FFmpeg converts each missing track on the fly during the sync. Trade: no extra disk space, but every sync that adds tracks pays the conversion cost again.
- **What sync does and does not propagate** — Sync is a **one-way file copy** from computer to device. It only transfers audio files and album artwork; it does not write play counts, ratings, or any other library metadata to the device. This also applies to shadow libraries: they hold pre-transcoded audio files only — no play counts, ratings, or listening history. Play counts flow the *other* direction: iPodRocks imports them from the counters Rockbox keeps on the device (see Devices → "Play history"). Ratings are the one exception to the one-way rule — they travel both ways, and a rating you set in iPodRocks is written into Rockbox's own database on the next sync.
- **Orphan & Reset Policy** (called "Orphan Policy" before 2.3.2, and "Extra Track Policy" in some earlier versions) — Controls what happens to content that exists **on the device but is not part of the sync**:
  - **Keep** — Leave it alone. Useful if you manually copy files to the device outside of iPodRocks.
  - **Remove orphans** — Delete anything the sync selection does not account for, so the device mirrors the library. This covers **songs, podcasts and audiobooks alike**, including content types the current sync has nothing to copy to. (Before 2.3.2 those were skipped, so a device full of podcasts survived "remove" untouched if your selection had no podcasts.)
  - **Delete all** — Erase the device's **Music**, **Podcasts** and **Audiobooks** folders outright, then rebuild them from the library in the same sync. Everything in those folders goes, including files iPodRocks did not put there, and auto-podcast episodes are downloaded again. The **Playlists** folder is left alone, and so are the ratings and listening history stored on the device. iPodRocks asks you to confirm before anything is deleted. On a device plugged into this computer the old folders are moved aside instantly and deleted while the new files copy; on a remote device they are deleted in batches, with progress in the log.
  - **Prompt** — Report what was found instead of deleting it.

  If a device had the retired **Remove all** option saved, it loads as **Remove orphans** — upgrading never turns an old setting into a wipe.
- **Codec mismatches** — When a device has files in a codec that no longer matches its profile (e.g. old Musepack files after switching the profile to Opus) and you sync with **Orphan & Reset Policy = "Remove orphans"** (or "Delete all"), those old-codec files are removed and replaced by the new codec during sync.
- **Album artwork** — Copied by default (`cover.jpg`, `folder.png`, etc.). The **Skip album artwork** option is a per-device setting (Devices panel), not a per-sync toggle.
- **Extra Audiobooks** — LibriVox audiobooks are downloaded on demand during the sync (not pre-fetched). Each book's chapters and cover are copied to `<device>/<Audiobooks folder>/<Author - Title>/`. See [Extra Audiobooks](./audiobooks.md).
- **Rockbox tagnavi (per-device option)** — If the device profile has "Rockbox smart playlists (tagnavi)" enabled, smart playlists are written to `<device>/.rockbox/tagnavi_custom.config` instead of `Playlists/<name>.m3u`. See [Devices](./devices.md) and [Smart Playlists](./playlists-smart.md).

## How to work with it

1. **Select the device** and ensure it is mounted.
2. **Full sync** — Use for a complete mirror. Set Orphan & Reset Policy to "Remove orphans" if you want the device to match the library exactly.
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

**Changing it moves files.** The grouping decides where tracks are written, so switching it (or switching **Mirror library folder structure**) means the next sync copies tracks to their new locations. Set the Orphan & Reset Policy to **Remove orphans** on that sync if you want the old folders cleaned up in the same pass; with **Keep** they stay behind until you remove them yourself.

**Upgrading from an earlier version.** Libraries scanned before v2.3.0 never had their `albumartist` tags read, so their compilations are still split per track artist. The next library scan re-reads those tags once and merges the duplicate album entries; it does not re-hash files or re-transcode shadow libraries, so it is quick. Album selections you had already saved keep working — the old labels are still matched, and the picker moves them onto the new ones for you.

## Building the Rockbox database

Rockbox only lists a file in its database browser (Artists, Albums, Genres, Year, Composer…) after it has scanned it. Normally that means running **Database → Update now** (or **Initialize now**) on the player after every sync and waiting while it reads every file — minutes on a full iPod.

Tick **Build Rockbox database** and iPodRocks does that step at the end of the sync instead. It already knows every tag of every file it copied, so it writes the finished database (`.rockbox/database_idx.tcd` and the `database_*.tcd` tag files) straight onto the player. Unplug, and the player is ready.

- **Off by default, remembered per device.** Tick it once for a player and every later sync of that player builds the database, until you untick it.
- **Your statistics are kept.** Play counts, listening time, last-played order and ratings already in the player's database are carried into the new one, track by track.
- **New tracks get their ratings straight away.** A track copied in this sync is in the database with its library rating, so you no longer have to update the database and sync a second time for the rating to arrive (see [Ratings](./ratings.md)).
- **Everything on the player is included**, not just what iPodRocks copied — music, podcasts, audiobooks and files you put there by hand, exactly as Rockbox's own scan would find them. Folders holding a `database.ignore` file are skipped, as Rockbox skips them. A hand-copied file that iPodRocks does not have in its library is read from the player for its tags; on a **remote** (browser-held) player that is not possible, so such a file is left out until you run **Database → Update now** once — the sync log says how many.
- **Year, composer, comment and grouping** come from your files' tags. iPodRocks started storing these in 3.2.0; the first library scan after upgrading reads them once for tracks scanned by an older version.
- **Needs Rockbox 4.0 or later.** The player must have a `.rockbox` folder. If its database was written by an older Rockbox, iPodRocks leaves it alone and says so in the log. A player that is not running Rockbox is never touched.
- **Safe to interrupt.** The previous index is kept beside the new one as `database_idx.tcd.ipodrocks-bak`, the new files are written in full before they replace the old ones, and a failed build leaves the previous database in place. A failed build never fails the sync.
- **Restart the player** if it was already running when you synced. Rockbox reads its database when it starts.
- **"Auto update" on the player** still works. It only re-reads a file whose timestamp changed, and iPodRocks records the timestamp the way Rockbox does.

## Per-Device Sync Preferences

Selecting a device in the Sync panel automatically restores that device's last-used sync configuration: sync type, content toggles (music/podcasts/audiobooks/playlists), orphan & reset policy, **Mirror library folder structure**, **Group albums by**, **Build Rockbox database**, **the custom-sync Include/Exclude mode**, and any custom selections of albums, artists, genres, playlists, podcasts, and audiobooks.

The state is saved every time you click **Sync** for that device — even if the sync errors partway through, because the saved state captures your intent, not the outcome.

Devices that have never been synced through this panel fall back to the panel defaults: full sync, all content types enabled, keep-orphans policy, mirror library folder structure = on, group albums by = Album artist, build Rockbox database = off, custom-sync mode = Include.

When you switch between devices, the panel live-swaps to that device's saved configuration. Removing a device from the Devices panel also clears its saved preferences.

## When the device disconnects mid-sync

Old iPods with a hard drive sometimes drop off USB during a long sync. macOS
shows "Disk Not Ejected Properly". iPodRocks notices that the *device* is gone,
rather than failing every remaining file:

- The sync window says **The device disconnected. Plug it back in**, and copies
  nothing more while it waits.
- Plug the iPod back in. The sync carries on from the file it was on, and that
  file is copied again. For a remote device, if it does not resume by itself,
  press **Reconnect iPod** in the sync window and pick the same folder.
- If the device is not back within 15 minutes, the sync stops with one message
  saying how many files were copied. Run it again: files already on the device
  are skipped.

**To make it less likely:**

- Lower **Parallel copies** in the device's settings. It sets how many files are
  written at once. A remote device defaults to 1, the gentlest on a hard drive; a
  local device defaults to 4. Use 1 for an iPod that keeps dropping off.
- Plug the iPod straight into the computer, not into a hub or a front-panel
  port, which often cannot supply a spinning drive.
- iPodRocks writes an empty `.metadata_never_index` file to the device root so
  macOS Spotlight does not index every new file during the sync. It is hidden,
  and harmless on other systems.

## Rocksy

[Rocksy](./assistant.md) can run a sync for you from the chat:

- "Check what would sync to my player" → `device_check` *(asks you to confirm first)*
- "Sync my player" → `device_sync` *(asks you to confirm first)*
- "Which player is plugged in right now?" → `usb_device_list`
- "Build the Rockbox database when I sync" / "stop building it" → `device_set_sync_preferences` with `build_rockbox_database` *(runs straight away; it is a setting, the next sync does the work)*

Checking and syncing are destructive operations, so Rocksy pauses for a **Confirm / Cancel** prompt before running. See [Devices → Rocksy](./devices.md#rocksy).
