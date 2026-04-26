# Changelog

## [1.2.0] — 2026-04

### Features

#### Multi-select smart playlist creation

- **Single-step, 3-column modal** — "Create Smart Playlist" now presents Genres, Artists, and Albums side-by-side in one step instead of requiring the user to pick a strategy first and then pick within it. Any combination can be mixed freely.
- **Cross-type AND, within-type OR** — Selecting two genres matches tracks in *either* genre; adding an artist then restricts to tracks that also belong to that artist. The backend already implemented this logic; the UI now exposes the full power of it.
- **Live track-count preview** — As the user ticks and unticks items, the modal debounces (200 ms) a `playlist:previewSmartTracks` IPC call and shows "Will include ~N tracks". An empty intersection is immediately obvious before clicking Create.
- **Green / yellow highlighting** — Checked rows are highlighted green (`bg-success/20 text-success`). Rows that would appear in the result set due to *other* selections (forward derivation) go yellow (`bg-warning/20 text-warning`), matching the SyncPanel custom-sync visual language.
- **Per-column search and Select All / Clear** — Each column has a live search input and ghost "All · Clear" buttons with a selected-count badge, making large libraries navigable.
- **`playlist:previewSmartTracks` IPC handler** — New handler (backed by `PlaylistCore.previewSmartTracks`) runs rule resolution without saving and returns `{ count, affectedArtistIds, affectedGenreIds, affectedAlbumIds }`.

### UI

#### Device icons

- **Per-device icons replace the generic green square** — Devices in the Devices panel and Dashboard now render a real icon for iPod Classic, iPod Nano (any generation), and iPod Mini. All other devices (Rockbox-native ports, iriver, iAudio, FiiO, AGPTek, etc.) get one of six generic `rockbox_gen` icons.
- **Distinct-then-cycling assignment** — The first six generic devices each receive a different `rockbox_gen` icon in a fixed shuffled order so two devices never look identical until all six have been used; the seventh onward cycles. The assignment is stable across reloads and remains unchanged when a new device is added.
- **Larger connection-status dot** — The green/red availability indicator on each device card grew from 10 px to 16 px and now sits on the corner of the icon instead of overlapping it, making at-a-glance status much easier to read.

### Code quality

- **Removed dead `SmartPlaylistGenerator` import** — `playlist-core.ts` imported `SmartPlaylistGenerator` but never used it; import removed.

#### Rockbox-native smart playlists (tagnavi)

- **Per-device opt-in flag** — A new "Rockbox smart playlists (tagnavi)" toggle on the device profile (Devices → Edit) switches smart-playlist sync from static `.m3u` snapshots to live, auto-updating Rockbox tagtree entries.
- **`.rockbox/tagnavi_user.config` writer** — Smart playlists translate to a single config file that overrides the firmware default `tagnavi.config`; entries are inlined directly into the main Database menu. Multiple values within a rule type use the `@` "one of" operator with pipe-separated values inside a single quoted string (`tag @ "v1|v2"`, per Rockbox `str_oneof()`); different rule types are joined with `|` (OR) to match the desktop's smart-playlist track query semantics.
- **Sanitisation** — Quotes, control characters, and whitespace in playlist names and rule labels are sanitised before quoting; UTF-8 is passed through unchanged.
- **Sync integration** — When the flag is on, smart playlists no longer produce `.m3u` files; orphan cleanup detects any stale `.m3u` left over from prior syncs and removes them under the existing Orphan Policy. When the flag is off (or the smart-playlist set is empty), any pre-existing `tagnavi_custom.config` is removed so the device does not show stale entries.
- **Schema migration** — `devices.rockbox_smart_playlists` column added with `DEFAULT 0`; existing devices keep the previous behaviour automatically.

#### Star ratings in playlist generation

- **`top_rated` Genius playlist** — New Genius type that selects tracks rated 4+ stars (Rockbox 0–10 scale ≥ 8) directly from the library database. No play history is required — works even before any device log has been ingested. Tracks are ordered by rating descending, then by play count.
- **`top_rated` Smart playlist** — Same 4-star threshold available as a Smart playlist strategy. Tracks are ordered by rating descending with a random tiebreak, and the result set respects the track limit option.
- **Rating flows through the Genius pipeline** — `matchEventsToLibrary` now attaches the `rating` field from the library to every matched play event. The rating propagates through `TrackAggregation` and `aggToTrack` so all Genius algorithms (Most Played, Favorites, Deep Dive, etc.) expose it on `PlaylistTrack`. Library query helpers (`getLibraryTracksByArtist`, `getLibraryTracksByAlbum`) also return rating.
- **Rating in Savant AI context** — Candidate tracks sent to the LLM now include the track's rating (0–10). The system prompt instructs Savant to give extra weight to rated tracks when curating mood playlists.
- **`PlaylistTrack.rating` field** — The shared `PlaylistTrack` type gains an optional `rating?: number | null` field, making rating available to the renderer for any playlist type.

### Testing

- **Genius `top_rated` tests** — Covers: works with empty play history, excludes tracks below 4 stars, excludes unrated tracks, correct descending-rating order, `maxTracks` limit.
- **Rating propagation tests** — Verifies that `matchEventsToLibrary` attaches the correct rating (or `null`) from the library row to matched events.
- **Smart playlist `top_rated` tests** — Covers: type registered, 4-star filter, rating populated on returned tracks, empty result when no rated tracks, `limit` option.
- **Tagnavi writer tests** — Cover single/multiple rules per type, multi-type AND/OR composition, sanitisation of quotes/newlines/control chars, empty-rule and unknown-rule-type handling, header structure, deterministic output.
- **Sync integration tests** — Cover flag off (M3U), flag on (tagnavi only, no M3U for smart), flag toggled off→on (M3U cleanup), flag on with no smart playlists (file deletion), write-if-changed, sanitisation.
- **`playlist-core.test.ts`** — New test suite (10 cases) covering `previewSmartTracks` semantics: single genre, multi-genre OR, multi-artist OR, multi-album OR, genre+artist AND, all three combined, empty intersection → 0, `trackLimit` honored, non-music tracks excluded, affected ID sets populated correctly.
- **`device-icon.test.ts`** — New test suite (11 cases) covering icon resolution: classic/nano/mini specific matches by `modelInternalValue` or `modelName`, distinct rockbox_gen assignment for the first six generic devices, cycling on the seventh, position stability when a new device is added, ordering by id regardless of input order, and null-fallback to a generic icon.

---

## [1.1.3.1] — 2026-04-19

### Documentation

- **Shadow library vs. sync-time transcoding** — Clarified the trade-off between pre-built shadow libraries (transcode once, fast syncs, extra disk space) and on-the-fly transcoding per sync. Both produce the correct codec on the device.
- **Shadow library scope** — Explicitly documented that a shadow library is a file-only mirror; play counts, ratings, and listening history are not stored in or propagated through it. Play counts flow the opposite direction via Rockbox's `playback.log`.
- **Orphan Policy** — Named and explained the "Orphan Policy" setting (Keep / Remove / Prompt) across `sync.md` and `devices.md`, consistent with the UI label.

---

## [1.1.3] — 2026-04-18

### Features

#### Encoder PATH resolution

- **`getEncoderEnv()` utility** — Extracted a shared helper (`src/main/utils/encoder-env.ts`) that augments `process.env` with common encoder binary locations (`/opt/homebrew/bin`, `/opt/homebrew/sbin`, `/usr/local/bin`, `/usr/local/sbin`, `~/.local/bin`, etc.). Electron launched from the macOS GUI does not inherit the user's shell PATH, so `mpcenc`, `ffmpeg`, and `ffprobe` were silently missing for Homebrew installs. All encoder invocations now use this helper.

#### ffprobe metadata fallback

- **Duration / bitrate fallback via ffprobe** — When `music-metadata` returns a zero duration or zero bitrate, the scanner now retries using `ffprobe`. This fixes tracks (e.g. certain ALAC, OPUS, or MPC files) that were stored in the library with `duration = 0` and therefore showed as 0:00 in the UI.
- **Full metadata fallback via ffprobe** — If `music-metadata` throws entirely (e.g. unsupported container), `ffprobe` tag extraction is attempted before falling back to filename-based defaults. Title, artist, album, genre, track number, and disc number are read from format tags.

#### Zero-duration re-scan

- **Tracks with `duration = 0` are always re-scanned** — The library scanner now loads a set of zero-duration track paths at scan start and forces a full re-read for those files even when the mtime has not changed. Previously these tracks were skipped by the mtime cache and never corrected.

#### Dynamic app version

- **Version read from Electron at runtime** — The sidebar version label and Welcome panel no longer hardcode a version string. A new `app:getVersion` IPC handler returns `app.getVersion()` from the main process; the renderer fetches it once on mount. The version will always match `package.json` without requiring manual updates to UI files.

### UI

#### Select dropdown overflow fix

- **Portal-rendered dropdowns** — The custom `Select` component now renders its dropdown via `createPortal` into `document.body` with computed `top`/`left` coordinates, avoiding clipping by `overflow: hidden` ancestors. The dropdown also checks available space below and flips upward when there is not enough room.

### Dependencies

- **follow-redirects 1.16.0** — Patched from 1.15.11.

---

## [1.1.2] — 2026-04-06

### Security

#### Sync path-traversal hardening

- **`customDestinations` containment** — Custom sync destinations that resolve to absolute paths (or escape the device mount point via `..` segments) are now rejected and silently re-routed to the device folder, preventing any file written outside the target device.
- **`getDestinationPath` containment** — The `preserveStructure` destination path is verified to remain under the device folder after resolution; `..`-based escapes fall back to a safe basename copy.

#### IPC error sanitization

- **Error messages no longer leak host paths** — The `safe()` IPC wrapper now strips Unix and Windows absolute paths (e.g. `EACCES: permission denied, open '/Users/pedro/…'`) from error messages before they reach the renderer. Full errors are still logged on the main process.

#### API key never exposed to renderer

- **OpenRouter key masked at the IPC boundary** — `settings:getOpenRouterConfig` now returns a masked key (`••••••••XXXX`) instead of the plaintext secret. `settings:setOpenRouterConfig` detects the mask sentinel and preserves the stored key instead of overwriting it. `settings:testOpenRouter` uses the stored key directly when the renderer passes a masked value.

### Bug fixes

#### Windows

- **Library folders on non–C: drives** — Paths on `D:\`, `E:\`, etc. were incorrectly rejected as outside the allowed directory list. Drive-root matching now uses case-insensitive single-backslash comparisons, consistent with standard Windows paths.

#### Sync

- **Sync completion summary** — `onComplete` now receives accurate `skipped`, `copiedItems`, and per-type `skippedBreakdown` values. The previous closure captured stale React state (always zero) from the effect's initial render.
- **ScanProgressModal restart bug** — A parent re-render that passed a new `folders` array reference (from `.map()`) would re-trigger the scan's `useEffect` and restart an in-progress library scan. Folders are now captured in a ref at scan start and excluded from the dependency array.

#### Dashboard / Library

- **Dashboard "No library configured"** — The Library card now shows "No library configured" when no library folders are set up, instead of displaying a spinning skeleton or zeros.
- **Library store errors cleared on success** — `fetchStats` and `fetchFolders` now clear a stale `error` on a successful load, so the dashboard doesn't display an old failure banner after recovering.

### Performance

- **Stack overflow eliminated in playlist generation** — Six `Math.min(...array)` / `Math.max(...array)` spread calls in `genius-engine.ts` are replaced with `reduce` loops. For users with tens of thousands of playback events per track, the previous code would overflow the call stack.

### UI

- **Sync progress — per-content-type skipped breakdown** — The sync completion card now shows a per-type skipped count (songs, podcasts, audiobooks, artwork, playlists).
- **Library panel layout** — Tighter spacing pushes the track list higher on screen. Cards, filters, tabs, and list rows use reduced padding for a more compact layout.

### Code quality

- **Form validation rejects whitespace-only inputs** — Add Folder, Save Device, and Create Playlist handlers now call `.trim()` before the truthy check, so a name or path that is only spaces is correctly rejected.
- **Path allowlist extracted to testable module** — `pathMatchesAllowedPrefix` moved to `src/main/path-allowlist.ts` with 9 unit tests covering Windows drives (case-insensitive), homedir sub-paths, and POSIX prefixes.
- **Sync test profile DRY** — Three identical 25-field device profile literals in `sync-core.test.ts` replaced with a shared `createDirectCopyDeviceProfile()` helper.

### Dependencies

- **Electron 39.8.5** — Patched from 39.8.4.

## [1.1.1] — 2026-03-18

### Security

#### Path validation hardening

- **Symlink-aware folder validation** — Adding a library or shadow library folder now resolves symlinks before checking the allowlist, closing a bypass where a symlink could point outside allowed directories.
- **Shadow library path check** — Creating a shadow library now validates the destination path against the same allowlist used for library folders.

#### Assistant chat sanitization

- **HTML sanitization in chat** — Assistant chat messages are now sanitized before rendering, preventing any embedded HTML from executing in the app.

#### Device & playlist hardening

- **Stricter device updates** — Only explicitly allowed fields can be updated on a device; unknown fields are silently rejected instead of passed through.
- **Safer playlist rule validation** — Playlist rule validation now uses pre-prepared database queries, improving both performance and safety.
- **Unpredictable temp file names** — Harmonic analysis temp files now use cryptographically random names.

### User-friendly / Dev

#### Case-insensitive library matching

- **Artists, albums, and genres are now case-insensitive** — "R&B" and "r&b", "CASE STUDY 01" and "Case Study 01" are treated as the same entry. Existing duplicates that differ only in casing are automatically merged on first launch. No action needed.

#### Automatic duplicate removal

- **Duplicate tracks cleaned up automatically** — Tracks that appear more than once (same artist, album, and title) are deduplicated. Copies found in Trash or recycled folders are removed in favour of the main library version. Orphaned artists, albums, and genres left behind are cleaned up too.

### Performance

- **Faster library stats** — Library statistics (total size, track counts) are now computed from the database instead of walking every folder on disk, making the Library panel load noticeably faster for large libraries.
- **Non-blocking playlist writes** — Playlist file operations during sync no longer block the app while writing to disk.

### Bug fixes

#### Sync

- **Shadow library tracks no longer re-synced unnecessarily** — When syncing via a shadow library in direct-copy mode, tracks already on the device were sometimes misidentified as missing and re-copied. Fixed.
- **Correct codec mismatch detection with shadow libraries** — Codec mismatch detection now correctly uses the shadow library's codec when comparing against device files, preventing false "codec mismatch" reports.

#### Scanner

- **Removed tracks propagated to shadow libraries reliably** — Previously, shadow library cleanup could miss removed tracks due to a timing issue. Removed tracks are now tracked by ID for reliable propagation.
- **Scan results show removed file count** — The scan completion summary now reports how many files were removed, not just added and skipped.

#### Stability

- **Fixed potential file handle leak during hashing** — File handles are now always closed, even if an error occurs mid-read.
- **Better error diagnostics** — Hash computation and storage failures now log the file path and reason instead of failing silently.

### UI

- **Scan modal shows "Removed" count** — The scan completion summary now has four columns: Processed, Added, Removed, and Skipped.
- **Cleaner scan progress list** — The file-by-file list during scanning no longer flickers with transient "scanning" entries.
- **Scan errors displayed properly** — If a scan fails, the error message is now shown in the modal instead of being swallowed.
- **Smoother progress lists** — Progress lists in scan, sync, and backfill modals no longer glitch when older entries are trimmed.
- **Sync log capped** — The sync conversion log is now limited to 200 entries to prevent memory buildup during long syncs.

### Testing

- **Deduplication tests** — New test suite covering duplicate track removal, including Trash-vs-main-library preference and scan-order independence.
- **Scanner removal & shadow propagation tests** — Integration tests verifying that removed tracks are correctly deleted from the database and propagated to shadow libraries.
- **Sync matching tests** — New tests for direct-copy basename matching and codec-mismatch classification during device sync.

---

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
