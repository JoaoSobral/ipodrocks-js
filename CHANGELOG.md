# Changelog

## [1.0.3a] — Unreleased

### Features

#### Device Check — Codec Mismatch Clarity

- **Clearer metrics** — "Check Device" now shows synced, codec mismatch, to sync, and orphans separately. When device files use a different codec than the profile (e.g. MP3 on device, OPUS profile), they appear as "codec mismatch" instead of "orphans".
- **Explanatory note** — When codec mismatches exist, a note explains that files will be re-encoded to the profile codec on next sync. Applies to any codec-to-codec mismatch (MP3↔OPUS, AAC↔MPC, etc.).

#### Album Artwork Sync

- **Artwork for all sync types** — Album artwork (`*.jpg`, `*.png`) is now copied for both direct copy and transcoding sync, regardless of filename (e.g. `cover.jpg`, `folder.png`).
- **"Not syncing album artwork" option** — New checkbox in the sync menu to skip artwork sync (default: unchecked).

#### Music Assistant (formerly "Assistant")

- **Persistent memory** — The assistant remembers important things you tell it across sessions. Up to 40 pinned memories survive app restarts. Say "always remember my name is Pedro" or "don't forget I love jazz" and it will carry that context every time you open the app.
- **Rolling conversation history** — Keeps the last 100 exchanges as hidden context so the assistant stays informed without cluttering your chat.
- **Create playlists by talking** — Ask the assistant to make a Smart or Genius playlist in plain English. Examples: "Make me a rock playlist with 30 tracks" or "Create a late night favorites playlist from my listening history" — it handles the rest.
- **Smart memory management** — Say "forget about that" or "actually my name is X" to update or remove memories. Pinned memories persist; rolling history is trimmed automatically.

#### Playlists

- **Via Assistant** — Create Smart and Genius playlists directly through the floating chat. The assistant knows your genres, artists, albums, and listening history and builds the playlist instantly.

---

### Bug fixes

- **Empty directories after orphan removal** — When removing orphan or codec-mismatch files, empty folders are now cleaned up instead of being left behind.
- **Codec replacement files in wrong folder** — When transcoding to a different codec (e.g. MP3→OPUS), replacement files are now placed in the same folder as the originals instead of creating duplicate folders with slightly different names (e.g. `Album (20th _ Deluxe)` vs `Album (20th - Deluxe)`).
- **Album cover art not copied during sync** — Common cover files (`cover.jpg`, `cover.jpeg`, `folder.jpg`, `front.png`, etc.) in album folders are now copied to the device alongside audio files. Previously, only audio was synced, so album art was missing on the device (e.g. when using Musepack).
- **False "codec mismatch" forcing full resync** — Sync no longer incorrectly reports a codec mismatch and triggers a full resync when the device already has correctly synced files (e.g. MPC). Detection now uses file extensions instead of size ratios.
- **Playlist orphans not detected during sync** — Orphan playlist files (`.m3u`) on the device were only detected when using "Check Device", not during sync. They are now detected on every sync regardless of whether playlists are being written, so you can use the Orphan Policy to remove them.
- **Sync modal stuck when only orphans removed** — When a sync only removed orphan files (no copies), the progress modal stayed on "Waiting for sync..." instead of completing. It now shows a completion summary and the "Close" button.
- **Sync results missing removed count** — The sync results card now correctly shows how many files were removed when using the Orphan Policy.
