/**
 * Static snapshot of the iPodRocks app documentation.
 * Injected into Rocksy's system prompt so she can answer how-to questions.
 * Update this when docs change.
 */
export const APP_DOCS = `
## iPodRocks App Reference

### Getting Started
iPodRocks syncs a managed music library to Rockbox or mountable devices.
Workflow: add library folder → add device → optionally create playlists → sync.
Download from GitHub Releases (Linux AppImage, macOS .zip, Windows .exe portable).

Sidebar navigation: Welcome, Dashboard, Library, Devices, Playlists, Sync.
Gear icon (top right) opens Settings.

Add a library folder: Library → Add Folder → enter name, path, content type (Music/Podcasts/Audiobooks) → Add Folder. A scan runs automatically. Files need proper tags (artist, album, title, genre).

Add a device: connect and mount it first. Devices → Add Device → enter name, mount path, codec config → Add Device.

First sync: Sync → select device → Full or Custom → Start Sync.

---

### Dashboard
At-a-glance view: Library stats (tracks, albums, artists, total size), Devices list, Shadow Libraries status, Recent Activity (syncs, scans, playlist generations, playback log reads).
No background refresh — switch away and back to reload.

---

### Library
Manages music catalog: folders, scans, shadow libraries, track list.

Add Folder — adds a root folder for music, podcasts, or audiobooks. Scans recursively for MP3, FLAC, AAC, M4A, OGG, Opus, WAV, AIFF.
Scan Library — re-scans all folders. Uses content hashes to skip unchanged files.
Clear scan cache — forces a full re-scan next time (use when tags changed outside iPodRocks).
Shadow Libraries — pre-transcoded mirrors (e.g. FLAC → MPC). Create once, sync fast to multiple devices that need a specific codec. Shadow libraries hold audio files and artwork only — no play counts, ratings, or listening history.
Tracks / Playlists — switch between track list and library playlists. Search, sort, filter by device, type, sync status.

Tip: enable "Extract harmonic data" and "Analyze with Essentia" in Settings before scanning if you want key/BPM data for Savant and harmonic mixing.

---

### Devices
Add, edit, and check Rockbox or mountable players.

Add Device — register with name, mount path, model, codec config, folder layout. Always mount the device before adding.
Edit Device — change any setting.
Check Device — compare device vs library. Shows synced, codec mismatch, to-sync, and orphans.
Set as default — used as default device for sync and Genius.

Codec options: Direct Copy (no conversion), MP3, AAC, Musepack (MPC), Opus, OGG.
Use shadow libraries for pre-transcoded sync (faster, avoids on-the-fly conversion).

Playback log — enable "Read playback log" on the device profile to ingest Rockbox's playback.log for Genius playlists and listening stats.

Rockbox smart playlists (tagnavi) — when enabled on a device profile, smart playlists sync as live Rockbox tagnavi database queries instead of static .m3u files. Genius, Savant, and Custom playlists always sync as .m3u. After syncing, reboot the device and run Database → Initialize Now in Rockbox for entries to appear. After the first init, updates are automatic if tagcache_autoupdate is on.

Orphans — files on device not in library. Controlled by Orphan Policy (Remove/Keep/Prompt) in the Sync panel.
Codec mismatches — old-codec files on device are removed and replaced when syncing with Orphan Policy set to Remove.

---

### Sync
Copies music, podcasts, audiobooks, and playlists from library (or shadow library) to device. One-way: computer → device.

Full sync — copies everything. Set Orphan Policy to Remove for an exact mirror of the library.
Custom sync — pick specific albums, artists, genres, podcasts, audiobooks, playlists.
Orphan Policy — Remove (deletes files not in library), Keep (leaves them), Prompt (asks each time).
Album artwork — copied by default (cover.jpg, folder.png, etc.). Uncheck "Skip album artwork" to disable.

Sync does NOT write play counts, ratings, or metadata to the device. Ratings sync separately via Rockbox's database_changelog.txt (see Ratings section).

Shadow library vs sync-time transcoding:
  Shadow — transcode once up front into a separate folder, sync just copies pre-built files. Uses extra disk space but subsequent syncs are fast and reusable across devices.
  Sync-time — no extra disk space, but each sync pays the FFmpeg conversion cost for new tracks.

After sync with tagnavi smart playlists: reboot device and run Database → Initialize Now in Rockbox settings.

---

### Playlists — Overview
Four tabs: All, Smart, Genius, Savant.

All — view, create, delete, and export all playlists. Click a playlist to see its tracks. Export as M3U8.
Smart — rule-based playlists (genre, artist, album + track limit). Syncs as .m3u or live tagnavi.
Genius — from Rockbox playback history (Most Played, Favorites, Late Night, etc.). Syncs as .m3u.
Savant — AI-generated from mood (requires OpenRouter API key). Syncs as .m3u.

---

### Smart Playlists
Filter by genre, artist, or album with a track limit.

How to create: pick rule type (By genre/artist/album) → select values (multi-select supported) → set track limit or check "No limit" → Create → name it.

Smart playlists are not live-updating — recreate to refresh when the library changes.
Multiple values of the same type = OR. Different rule types = AND.

Rockbox dynamic mode (tagnavi): when enabled on the device profile, smart playlists sync as live Rockbox tagnavi entries. After first sync: run Database → Initialize Now in Rockbox, then reboot the device. Only artist, album, and genre rules translate to tagnavi.

---

### Genius Playlists
Built from Rockbox playback history (from playback.log). Requires at least one device with playback log enabled.

Genius types:
  Most Played, Favorites, Skip List, Top Artist, Top Album, Late Night (after midnight plays)
  Recently Discovered, Deep Dive (single artist focus)
  Oldies, Nostalgia, Recent Favorites, Time Capsule, Golden Era (require 12–36+ months of history)

How to use:
1. Add a device and enable "Read playback log" in Devices.
2. Load from Database (if already synced before) or Recheck device for playback.log (reads from device).
3. Wait for analysis. Check the summary (total plays, matched plays).
4. Pick a Genius type and configure options (track limit, min plays, artist, date range, etc.).
5. Generate → preview → Save with a name.

Playback history is stored in the database after first load; you can generate playlists without the device connected afterward.

---

### Savant Playlists (AI)
AI-generated playlists from mood and intent. Requires OpenRouter API key in Settings.

Quick mode — preset moods (Chill, Workout, Focus, etc.). Click to generate instantly.
Chat mode — describe your vibe in plain English ("late night jazz", "upbeat indie for a run"). Refine with follow-up messages.
Harmonic mixing — when tracks have Camelot key data, the AI orders them for smooth transitions.
Rating-aware — candidate tracks include star ratings; Savant gives extra weight to highly-rated tracks.
The AI avoids tracks you consistently skip (from playback history when available).

How to use: add OpenRouter key in Settings → Quick or Chat mode → Generate → Save. Savant playlists are static once saved; regenerate for a fresh mix.
Improve harmonic coverage: enable "Extract harmonic data" and "Analyze with Essentia" in Settings, then scan or run Backfill.

---

### Ratings
5-star (half-star) ratings synced between library and Rockbox device in both directions.

Internally uses Rockbox 0–10 scale: 5 stars = 10, 4 stars = 8, 0 stars = NULL (unrated).

Setting a rating in the library: Library panel → Rating column. Click for whole star, Shift-click for half star, click the filled star again to clear.
Changes save immediately and are written to the device on the next sync.

Sync phases (run automatically during sync):
  Phase 1 — Ingest (device → library): reads database_changelog.txt from device, runs 3-way merge.
    - Device has new rating, library has none → adopt device rating.
    - Only library changed → push library rating to device in Phase 3.
    - Both changed to same value → silently converged.
    - Both changed but differ by 1 unit → half-step tolerance, higher value wins.
    - Both changed significantly → conflict recorded.
  Phase 2 — File sync (normal copy/transcode/remove).
  Phase 3 — Propagate (library → device): writes canonical library ratings back to database_changelog.txt.

After sync with rating changes: on the device go to Settings → General → Database → Initialize Now to apply the new ratings file.

Conflicts: when a conflict is recorded, the Library panel shows a warning banner. Click Resolve → to open the conflict panel. For each conflict: choose Keep Library, Use Device, or Set Manually.

Star badges in track table:
  Blue circle-plus = rating was last set by a device.
  Orange dot = unresolved conflict on this track.

---

### Settings — Overview
Opened from the gear icon (top right). Two sections: OpenRouter API and Harmonic Analysis.
Click Save to apply. Cancel discards changes.

---

### Settings — OpenRouter API
Connects iPodRocks to AI models (Claude, etc.) for Savant playlists and Rocksy.

API Key — get one at openrouter.ai/keys.
Model — e.g. anthropic/claude-sonnet-4-6. Browse at openrouter.ai/models.
Test Connection — verifies key and model before saving.
The key is stored locally; never sent anywhere except OpenRouter.

Without a key, Savant and Rocksy will not work and will prompt you to add one.

---

### Settings — Harmonic Analysis
Controls key/BPM detection for Savant harmonic ordering and Library banners.

Extract harmonic data on scan — reads TKEY/TBPM from file tags. Fast, but requires tags.
Analyze with Essentia — detects key/BPM from the audio waveform. More accurate, CPU-intensive. A single WASM instance is reused to avoid memory leaks.
Backfill % (tag extraction) — percentage of library to process in one run.
Analyze % (Essentia) — percentage to analyze per run (genre-sampled).
Run Backfill from Settings or the Savant tab. Only processes tracks that don't yet have key data.
After enabling "Extract harmonic data", run a full library scan to pick up the setting.

---

### Rocksy (Music Assistant)
Rocksy is a floating chat in the bottom-right corner. Knows your full library, playlists, and listening history.

Requires OpenRouter API key in Settings to work.
Persistent memory: up to 40 pinned memories survive app restarts. Say "always remember my name is Pedro" or "don't forget I love jazz".
Rolling history: last 100 exchanges kept as hidden context.
Create playlists by talking: "Make me a rock playlist with 30 tracks" or "Create a late night favorites playlist from my listening history".
Correct memories: "forget about that" or "actually my name is X" to update or remove memories.
Clear button (trash icon in chat header) wipes the rolling history and pinned memories from the database.

---

### Troubleshooting

Device not detected or mount path wrong
  Ensure device is mounted before adding. Use the actual mount path (e.g. /media/ipod on Linux, E:\\ on Windows). Avoid symlinks if they cause issues. On Linux use lsblk or mount to confirm the path.

Sync fails or hangs
  Check free space on the device. Use "Check Device" in Devices first to see synced vs to-sync counts. FFmpeg is bundled, no install needed. For Musepack, ensure mpcenc is on PATH. Cancel and retry; try a smaller custom sync (e.g. one album) to isolate.

Genius "No playback history"
  Connect the device, enable "Read playback log" in Devices, click Recheck device for playback.log. Rockbox must have played tracks to write the file. If you already synced once, try Load from Database instead.

Savant or Rocksy not working
  Add your OpenRouter API key in Settings → OpenRouter API. Test the connection. Ensure you have credits and the selected model is available. Check your network connection.

Harmonic analysis fails after many tracks
  Fixed in v1.0.4. Update to the latest version.

Album artwork not on device
  Ensure "Skip album artwork" is unchecked in the Sync panel. Artwork files must be in the same folder as audio files (cover.jpg, folder.png, etc.).

Musepack (mpcenc) not found
  Install musepack-tools for your platform (Linux: apt/dnf/pacman, macOS: brew install musepack, Windows: download from musepack.net). Add mpcenc to PATH.

Database and config location
  Linux: ~/.config/iPodRocks/ or ~/.config/ipodrocks/
  macOS: ~/Library/Application Support/iPodRocks/
  Windows: %APPDATA%\\iPodRocks\\
  Main database file: ipodrock.db. Back up this folder to preserve library, playlists, devices, and preferences.
`;
