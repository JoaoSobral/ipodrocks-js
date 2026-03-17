# Changelog

## [1.1.0] — 2026-03-17

### Security

#### API key encryption

- **Encrypted API key at rest** — The OpenRouter API key is now encrypted using Electron's `safeStorage` (OS keychain) before writing to the prefs file. Stored as a base64-encoded `_encApiKey` field; decrypted transparently on read. Falls back to plaintext with a console warning if OS encryption is unavailable.

#### Path traversal hardening

- **Real prefix allowlist** — The old path traversal check (`split(sep).includes("..")`) was dead code after `path.resolve()`. Replaced with a platform-aware allowlist that validates resolved paths against the user's home directory, macOS `/Volumes`, Linux `/media`/`/mnt`/`/run/media`, and Windows drive letters A–Z.

#### LLM prompt-injection mitigation

- **Playlist rule ID validation** — When the Music Assistant creates Smart or Genius playlists, every `targetId` returned by the LLM is now validated against the database (`SELECT 1 FROM genres/artists/albums WHERE id = ?`). Invalid or hallucinated IDs are filtered out before the playlist is created.

#### Rate limiting

- **Per-channel LLM rate limiter** — All IPC channels that call OpenRouter (`savant:chat:*`, `savant:playlistChat:*`, `assistant:chat`) are now gated by a sliding-window rate limiter (10 calls per 60 seconds per channel). Exceeding the limit returns an error instead of making the API call.

#### IPC session hygiene

- **Tighter session cap & cleanup** — Chat session cap reduced from 50 to 20. A 5-minute interval timer evicts sessions older than 30 minutes. Prevents unbounded memory growth from abandoned sessions.

### Performance

#### Sync engine

- **Pre-loaded mtimes from DB** — The `sync:start` handler now bulk-loads all `content_hashes` mtimes into a Map before syncing. `analyzeContentType` and `buildLibraryDestMap` check the Map first, falling back to `fs.statSync` only on cache miss. Eliminates thousands of per-track stat calls for unchanged files.
- **Async file I/O in copy workers** — `copyFileToDevice` and `runParallelCopies` converted from synchronous `fs.*Sync` to `fs.promises.*`. The 4 parallel copy workers now perform truly concurrent I/O instead of blocking the event loop.
- **O(1) codec-mismatch dedup** — `name-size-sync.ts` now uses a `Set` alongside the mismatch array, replacing O(n) `.includes()` checks with O(1) `.has()` lookups.

#### Library scanner

- **Mtime-only skip detection** — Removed the secondary hash-based skip check (`shouldScanFile`) that computed a full SHA-256 just to decide whether to re-scan. The mtime check is sufficient; the content hash is now computed once after metadata extraction.
- **Eliminated redundant DB query** — Removed the `loadExistingHashes` query (tracks table) used only by the removed `shouldScanFile`. Removed-file detection now uses a lightweight path-only query against the tracks table.
- **Efficient genre round-robin sampling** — `sampleTracksByGenre` replaced `indexOf`+`splice` on an ID array with a small `activeGenres` array of `[genreId, tracks[]]` entries, avoiding O(n) scans on large track lists.

#### Assistant context caching

- **Library context cache with TTL** — Building assistant context (6+ large queries) is now cached for 5 minutes. Cache is invalidated on library scan completion and playlist create/delete.

### Hardening

#### Database migrations

- **Atomic content-type migration** — `migrateContentTypeAudiobook` (which drops and recreates core tables) is now wrapped in a transaction. `PRAGMA foreign_keys = OFF` stays outside the transaction per SQLite spec; a `try/finally` ensures foreign keys are always re-enabled.
- **Dropped redundant indexes** — Removed explicit indexes on `content_hashes.file_path` and `app_settings.key` — both columns are `UNIQUE NOT NULL`, so SQLite already maintains implicit unique indexes.

#### Type safety

- **Typed IPC filters** — `library:getTracks` filter and `library:addFolder` content type are now typed with union types instead of `as any`.
- **Typed conversion settings** — `perTrackConversion` in `sync-core.ts` changed from `Record<string, Record<string, unknown>>` to `Record<string, ConversionSettings>`, removing an `as any` cast.

#### Network resilience

- **OpenRouter request timeout** — LLM fetch calls now use `AbortSignal.timeout(30_000)`. Catches `TimeoutError`/`AbortError` and throws a clear `"OpenRouter request timed out after 30s"` message instead of hanging indefinitely.

---

## [1.0.5] — 2026-03-16

### User-friendly / Dev

#### MPC (Musepack) tagging

- **APEv2 tag writer overhaul** — Replaced the previous minimal tag writer with a full, spec-compliant implementation. No external native or WASM dependencies (taglib-wasm removed). Pure TypeScript, zero-dependency core.
- **Robust tag handling** — Writes APEv2 with header + items + footer. Strips existing APEv2 and ID3v1 before writing. Detects SV7 vs SV8 from file magic. Atomic writes (tmp file + rename) to avoid corruption.
- **Cover art in MPC files** — When building a shadow library with MPC, cover art from the source album folder (`cover.jpg`, `cover.jpeg`, `cover.png`) is embedded into each MPC file as an APEv2 binary item, in addition to the external copy in the folder.
- **Key validation** — APEv2 keys are validated (2–255 chars, printable ASCII). Typed errors (`MpcFormatError`, `ApeTagError`, `ApeKeyError`) for clearer diagnostics.

#### Shadow libraries

- **Album artwork in shadow libraries** — Builds and propagation now copy album artwork (`cover.jpg`, `cover.jpeg`, `cover.png`) from source library folders into the shadow library, mirroring folder structure. Artwork is copied after a full build and when new tracks are propagated to existing shadow libraries.
- **FOREIGN KEY fix** — Deleting a shadow library no longer fails with "FOREIGN KEY constraint failed" when a device is still using it. Device references are cleared before the shadow library row is removed.
- **Cover copy logging** — When copying album artwork into shadow libraries, the app now logs if an album directory cannot be read or if no cover file is found, so you can tell "path bug" from "no source artwork".
- **Metadata passed to conversion** — Track metadata (title, artist, album, genre, track/disc number) is now passed into the conversion step so that MPC and other codecs that support tag write-back get proper tags in the output files.

#### IPC & diagnostics

- **Handler name in errors** — IPC errors are now logged with the channel name (e.g. `[ipc] shadow:create — FOREIGN KEY constraint failed`), making it easier to see which operation failed.

#### Artwork

- **`.jpeg` support** — Album artwork files with extension `.jpeg` are now recognized in addition to `.jpg` and `.png` for both device sync and shadow library artwork copy.

#### Testing

- **Tagging tests** — Unit tests for APEv2 items, block, strip, and detect; integration round-trip with `music-metadata` to verify written tags are readable.

---

## [1.0.4] — 2026-03-15

### Features

#### Documentation

- **VitePress docs site** — Full documentation at [joaosobral.github.io/ipodrocks-js](https://joaosobral.github.io/ipodrocks-js/). Guide (Getting Started, Installation, Troubleshooting), App Reference, and screenshots.
- **GitHub Pages deployment** — Docs workflow builds and deploys on push to `main` when `ipodrocks-js/docs/**` changes.
- **README link** — README and Welcome panel link to the full documentation.

#### Harmonic Analysis (Essentia)

- **WASM memory fix** — Essentia.js VectorFloat is now explicitly freed after each track. Fixes analysis failing after ~97 tracks due to heap growth.
- **Reusable engine** — Single WASM instance reused across tracks with periodic reset (every 500 tracks).
- **Output suppression** — Module.print/printErr and stdout/stderr suppressed during analysis.

### Bug fixes

- **Backfill progress** — BackfillProgressModal updated for the new Essentia engine lifecycle.

---

## [1.0.3] — 2026-03-14

### Features

#### Harmonic Mixing & Savant AI

- **AI-driven harmonic selection** — Savant playlists now send Camelot key data to the LLM and instruct it to prefer harmonically compatible tracks (Camelot ±1 or same-number A/B swap) for smooth transitions, similar to Apple Genius. The existing post-processing reorder is retained for final polish.
- **Harmonic info banners** — Library panel and Playlist Savant tab now show harmonic coverage stats (key data count, BPM-only count, percentage) with guidance on enabling extraction in Settings.
- **Settings redesign** — Settings panel split into "OpenRouter API" and "Harmonic Analysis" card sections with shadcn-style layout, toggle switches, field descriptions, and BPM-only count display.

#### Library Panel Layout

- **Compact layout** — Library Folders and Shadow Libraries now sit side-by-side in a two-column grid with tighter padding. The harmonic data banner is a slim inline alert instead of a full card. Action buttons (remove, rebuild, delete) appear only on hover. The track list starts much higher on screen.

#### Look & Feel

- **Updated UI across the app** — Panels, modals, buttons, inputs, and forms have been refreshed with a more consistent shadcn-inspired design. Improved spacing, typography, and component styling for a cleaner, more polished experience.

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

- **Backfill reported false success** — Backfill counted tracks with BPM-only as "with key/BPM", but Savant only uses Camelot data. Backfill now only counts tracks where Camelot key was actually extracted.
- **Backfill re-processed already-analyzed tracks** — Tag-based backfill retried BPM-only tracks every run (they'll never have key tags). Essentia backfill sampled from the entire library including tracks that already had Camelot data. Both methods now skip already-processed tracks, so cancelling and re-running only processes what's left.
- **Empty directories after orphan removal** — When removing orphan or codec-mismatch files, empty folders are now cleaned up instead of being left behind.
- **Codec replacement files in wrong folder** — When transcoding to a different codec (e.g. MP3→OPUS), replacement files are now placed in the same folder as the originals instead of creating duplicate folders with slightly different names (e.g. `Album (20th _ Deluxe)` vs `Album (20th - Deluxe)`).
- **Album cover art not copied during sync** — Common cover files (`cover.jpg`, `cover.jpeg`, `folder.jpg`, `front.png`, etc.) in album folders are now copied to the device alongside audio files. Previously, only audio was synced, so album art was missing on the device (e.g. when using Musepack).
- **False "codec mismatch" forcing full resync** — Sync no longer incorrectly reports a codec mismatch and triggers a full resync when the device already has correctly synced files (e.g. MPC). Detection now uses file extensions instead of size ratios.
- **Playlist orphans not detected during sync** — Orphan playlist files (`.m3u`) on the device were only detected when using "Check Device", not during sync. They are now detected on every sync regardless of whether playlists are being written, so you can use the Orphan Policy to remove them.
- **Sync modal stuck when only orphans removed** — When a sync only removed orphan files (no copies), the progress modal stayed on "Waiting for sync..." instead of completing. It now shows a completion summary and the "Close" button.
- **Sync results missing removed count** — The sync results card now correctly shows how many files were removed when using the Orphan Policy.
