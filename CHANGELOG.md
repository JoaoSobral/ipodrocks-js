# Changelog

## [1.3.5] — 2026-06

### Features

#### Custom sync — Include/Exclude polarity

- **New "Exclude" mode for custom sync** — The "Choose what to sync" card has a new `Include` / `Exclude` radio toggle at the top. **Include** keeps the existing behaviour (sync only the ticked items). **Exclude** inverts it: tick a few albums, artists, genres, podcasts, audiobooks, or playlists and everything *except* those gets synced — the easy way to do "sync the whole library minus this one box set". An empty Exclude selection is equivalent to a full sync, by design.
- **Red highlighting in Exclude mode** — Selected items render in red (`bg-destructive/20 text-destructive`) instead of include-mode green, so the polarity is immediately obvious. Items transitively pulled in via a selected playlist render in light orange (`bg-orange-400/20 text-orange-500`), distinct from the deeper red of explicitly excluded items.
- **Sticky per-device state for both selections *and* mode** — The selection mode and the selected items now both persist per device profile. Switching devices and coming back, or reopening the app, restores exactly what you had selected last time on that device. Implementation rides inside the existing `device_sync_preferences.custom_selections_json` blob via a new `mode` field on `CustomSelections`, so **no DB migration is needed**.
- **Type-level support** — `src/shared/types.ts` gains a `CustomSelectionMode = "include" | "exclude"` union and a `mode: CustomSelectionMode` field on `CustomSelections`. The main-side sync filter (`src/main/ipc.ts` `sync:start` handler) computes the include-style predicate once and wraps it with three `keepX` inversions when `sel.mode === "exclude"`. The renderer (`src/renderer/components/panels/SyncPanel.tsx`) extends the existing reducer with `customMode` and a `setCustomMode` action; the on-mount `getDeviceSyncPreferences()` call already runs per device, so the new field is restored automatically. Legacy rows whose JSON predates this field parse as `mode: "include"`.

#### "What's New" in the Update modal

- **Release notes embedded in the update modal** — When `UpdateAvailableModal` opens, it now fetches the matching `CHANGELOG.md` section for the latest version from GitHub and renders it inline above the snooze checkbox. Users can read the notes without leaving the app or clicking "Go to Releases".
- **Pure changelog parser** — New `src/main/utils/changelog-parser.ts` exports `extractChangelogSection(markdown, version)`, which finds the `## [<version>]` heading and returns the section body up to the next `## [` heading or `---` separator (heading and separator excluded). Returns `null` when the version isn't found. Handles four-segment versions like `1.1.3.1` and uses an anchored regex so a request for `1.3.5` doesn't match a `## [1.3]` heading.
- **GitHub raw fetch + in-process cache** — `src/main/utils/update-checker.ts` gains `fetchChangelogMarkdown()`, which fetches `https://raw.githubusercontent.com/JoaoSobral/ipodrocks-js/main/CHANGELOG.md` with `AbortSignal.timeout(10_000)`, caches the body in-process so repeated modal opens don't re-hit GitHub, and returns `null` on any failure (network, non-200, timeout). Failures are *not* cached, so a retry can succeed after a transient outage. A `_resetChangelogCacheForTests()` export keeps tests isolated.
- **New IPC handler `app:fetchChangelogSection`** — Registered alongside `app:checkForUpdates` in `src/main/ipc.ts`. Accepts `{ version }`, fetches the markdown, and returns `{ markdown: string | null; error?: "network" | "version" }`. The renderer's `fetchChangelogSection(version)` wrapper lives in `src/renderer/ipc/api.ts`.
- **Markdown rendering** — `UpdateAvailableModal.tsx` uses `react-markdown` + `rehype-sanitize` (both already deps) with custom Tailwind-styled component overrides for headings, paragraphs, lists, bold, inline code, and links — links open in a new tab with `rel="noopener noreferrer"`. The section sits inside a `max-h-[24rem] overflow-y-auto` scrollable container so a long entry never blows up the modal. A small spinner shows while loading; fetch failures and missing sections silently degrade (no "What's New" block renders) so the modal still works without notes. The modal switches to the `wide` `Modal` variant for breathing room.

### Testing

- **`src/__tests__/changelog-parser.test.ts`** — 6 cases for `extractChangelogSection`: returns the body for a known version, excludes the heading and trailing separator, stops at the next version heading without bleeding into it, returns `null` when the version is absent, parses four-segment versions like `1.1.3.1`, and refuses prefix matches (asking for `1.3.5` does not match a `1.3` heading).
- **`src/__tests__/changelog-fetch.test.ts`** — 5 cases for `fetchChangelogMarkdown` driving an injected `fetch` impl: returns the body on 2xx, returns `null` on a 404 response, returns `null` when fetch throws, caches the body across calls (single fetch on second call), and does *not* cache `null` results so a failing fetch can be retried after the outage clears.
- **`src/__tests__/regressions/device-sync-preferences.test.ts`** — 5 cases against a real `:memory:` SQLite DB through `device-sync-preferences.ts`: `emptySelections()` defaults `mode` to `"include"`, `mode: "exclude"` round-trips through save → load, `mode: "include"` round-trips, legacy rows whose `custom_selections_json` was written without a `mode` field parse as `"include"` (back-compat), and a garbage `mode` value parses as `"include"`.
- **`src/__tests__/behaviors/sync-exclude-mode.test.ts`** — 3 behavioral journey cases driving the real `library:addFolder` → `library:scan` → `device:add` → `sync:start` chain against a tmp library + tmp device mount: exclude mode with one artist selected syncs only the *other* artist's tracks (the excluded artist's files do not land on the device), exclude mode with empty selections syncs everything (no-op exclusion), and include mode with one artist selected syncs only that artist's tracks (regression coverage for the existing path).

---

## [1.3.4] — 2026-05

### Bug fixes

- **macOS AppleDouble (`._`) sidecar files no longer appear as tracks or sync to devices** ([#77](https://github.com/JoaoSobral/ipodrocks-js/issues/77)) — When a music library lives on a FAT32/exFAT/network volume (common for Rockbox memory sticks), Finder writes invisible `._<filename>` sidecar files next to every real file to carry HFS+-only metadata. They share the audio extension of their sibling (e.g. `._05 Mirage.ogg` next to `05 Mirage.ogg`), so the library scanner picked them up as additional zero-metadata tracks and the sync engine copied them onto the device. A new `isMacosMetadataFile()` helper in `src/main/utils/audio-extensions.ts` is now consulted by `LibraryScanner.collectAudioFiles()` and `Device.getTracks()` so `._*` entries are excluded from both the library walk and the device-side diff. Existing users who already imported `._` rows get a one-time cleanup: `LibraryCore`'s constructor runs `purgeMacosMetadataTracks()`, which deletes any `tracks` rows whose filename starts with `._` and logs `[library] purged N AppleDouble (._) track row(s)`. Idempotent — subsequent launches find nothing to purge.

### Testing

- **`library-scan.test.ts`** — Two new cases. `skips macOS AppleDouble (._) sidecar files when scanning (issue #77)` seeds a real `.ogg` plus a sibling `._05 Mirage.ogg` written via raw `fs.writeFileSync` and asserts the scan inserts exactly one row. `purges pre-existing AppleDouble (._) track rows when LibraryCore initializes` pre-inserts mixed real-and-`._` track rows directly into the test DB, constructs a fresh `LibraryCore`, and asserts only the real row survives.
- **`device-scan.test.ts`** — New behavioral file covering `Device.getTracks()`. Builds a tmp device layout via `createFakeDevice`, drops `05 Mirage.ogg`, `._05 Mirage.ogg`, and `._.DS_Store` into the Music folder, and asserts the returned map has exactly one entry for the real file.

---

## [1.3.3] — 2026-05

### Testing

- **Test suite refactored from technical units to behavioral journeys** — The previous suite (~54 files / ~440 cases) was dominated by fine-grained tests pinning internal function signatures and shallow-rendered React components with heavy IPC mocking. Maintenance cost was high and the tests didn't actually verify that user-facing workflows worked end-to-end. The suite is now reorganised into three layers: 11 retained pure-utility test files (`format`, `camelotWheel`, `device-icon`, `path-allowlist`, `validate-path`, `encoder-env`, `mpcenc`, `tagging/{block,detect,items,strip}`) covering 86 cases; 6 new behavioral journey files in `src/__tests__/behaviors/` covering 17 cases — `library-scan`, `playlists`, `device-sync`, `podcasts`, `ratings-sync`, `backfill`; and 5 new regression files in `src/__tests__/regressions/` covering 27 cases on historically fragile paths — rating-merge edge cases, podcast cover extraction branches, smart-playlist NULL/duplicate/limit edges, sync idempotency, and rockbox playback log parser quirks. Total: 22 files / 130 cases, full Vitest run completes in ~1.7s. 47 obsolete test files were removed in the same change.
- **Shared test harness** — New `src/__tests__/harness/` directory consolidates infrastructure that was previously duplicated across tests: `db.ts` (in-memory SQLite with schema + post-schema migrations replayed), `tmp-fs.ts` (tmp directory + audio fixture helpers), `music-metadata-mock.ts` (shared `parseFile` registry so multiple tests can declare metadata for fixtures), `fake-device.ts` (Music/Podcasts/Audiobooks/Playlists folder layout), `seed.ts` (library folder / track / playlist / device seeders that resolve artist/album/genre/codec), and `ipc-harness.ts` (mocks Electron's `app` / `BrowserWindow` / `ipcMain` / `dialog` / `shell` / `net` / `protocol` and exposes registered IPC handlers via a callable `invoke()` map). The IPC harness lets `device-sync.test.ts` and `sync-idempotency.test.ts` exercise the real `library:addFolder` → `library:scan` → `device:add` → `sync:start` chain with realistic glue code, not just the underlying sync-core function.
- **Playwright smoke tests** — New `tests/e2e/` directory with `playwright.config.ts`, `electron-launcher.ts` (launches the built app at `dist/main/main/index.js` with a tmp `--user-data-dir`), and `smoke.test.ts` (3 cases: app launches and a window opens, preload exposes the IPC bridge, the body renders some content). Run with `npm run test:e2e`. `@playwright/test` added as a devDependency.

### Continuous integration

- **CI workflow runs the full new suite on every push and PR to `main` and `dev`** — `.github/workflows/ci.yml` gains explicit `npm rebuild better-sqlite3` and `npm run postinstall` steps around the Vitest run so the behavioral/regression tests that use a real `:memory:` DB don't silently skip on CI's Node 25.7 (whose ABI doesn't match what `electron-builder install-app-deps` compiles better-sqlite3 for). A second parallel `e2e` job installs Playwright's Linux system dependencies, builds the app, and runs the smoke suite under `xvfb-run` (Electron on Linux needs a virtual display); failed Playwright reports are uploaded as a 7-day artifact for debugging. `.gitignore` gains entries for `test-results/`, `playwright-report/`, and `.playwright/`.

---

## [1.3.2] — 2026-05

### Bug fixes

- **Settings "Test Connection" no longer shows a misleading "Connected" badge** ([#73](https://github.com/JoaoSobral/ipodrocks-js/issues/73)) — `SettingsPanel` is mounted unconditionally, so its `testStatus` state survived a close→reopen cycle. A user could type a key, click **Test Connection** (success), close the panel without clicking **Save**, then reopen Settings and see an empty key field next to a stale green "Connected" label. The on-open effect now resets `testStatus` / `testError` (and the podcast equivalents), edits to the key or model field clear the badge immediately, and the OpenRouter button refuses to test when the field is empty and nothing is stored (was previously silently testing the stored key via the IPC fallback). When a stored key is tested via the empty-input fallback the badge now reads "Connected (using stored key)"; after testing a freshly typed key it reads "Connected — click Save to persist this key". The podcast Test button — whose IPC has no input override — now refuses to run when the user has typed unsaved values and surfaces "Save first — Test uses stored credentials".

### Features

#### Auto Podcasts

- **Date-prefixed episode filenames on device** — Synced podcast episodes are now written to the device as `YY.MM.DD <Episode Title>.mp3` inside each show folder (e.g. `26.04.21 My Great Episode.mp3`). The date is derived from the episode's `published_at` (UTC) so the iPod's native filename sort puts the newest episodes first when navigating into a show. Episodes with no publish date fall back to the previous `<Episode Title>.mp3` form. The prefix is built by a new exported `buildDatePrefix()` helper in `podcast-device-sync.ts`; only the title is run through `sanitizeDevicePathComponent`, so the prefix's dots are preserved. Episodes synced under the v1.3.1 `<Episode Title>.mp3` scheme are migrated automatically on the next sync: when the stored `device_relative_path` no longer matches the computed destination, the stale row and on-device file are removed and the episode is re-copied under the new dated filename, so existing libraries don't end up with a permanent mix of prefixed and un-prefixed names.
- **Latest-episode activity signal on subscription cards** — Each card on the Auto Podcasts panel now shows a small relative date next to the existing `last N` / `manual` badge (e.g. `today`, `yesterday`, `5d ago`, `3w ago`, `2mo ago`, `1y ago`), with the absolute publish timestamp on hover. This makes it obvious at a glance which subscriptions are still active vs. dormant. `PodcastSubscription` gains a `latestEpisodeAt: string | null` field, populated by a `MAX(published_at)` subquery in `listSubscriptions` / `getSubscriptionById`.

### UI

- **Genius splash screen now explains how to enable Rockbox playback logging** — When a user opens the Genius flow and the device or database has no playback history, the cause is almost always that Rockbox playback logging was never enabled. The splash screen now shows an inline amber hint pointing the user to **Settings → Playback Settings → Logging → Yes** on the device, and notes that a reboot is required for the change to take effect.

### Documentation

- **Genius playlists guide** — `docs/app-reference/playlists-genius.md` gains a callout with the same Rockbox playback-logging instructions, so the requirement is discoverable from the docs site as well as the app.

### Testing

- **`playlists.test.tsx`** — New test asserts the playback-logging hint is rendered on the Genius splash screen and includes the `Settings → Playback Settings → Logging → Yes` menu path and the "reboot required" note.
- **`settings-panel-openrouter.test.tsx`** — New file covers the issue #73 fixes: stale "Connected" no longer leaks across close→reopen, the badge differentiates between testing a stored vs newly typed key, Test refuses when nothing is entered and nothing is stored, the badge clears on key/model edits, the podcast Test refuses with unsaved input and with no stored credentials, and the podcast badge clears on credential edits.
- **`podcast-device-sync.test.ts`** — Two new tests cover the filename date prefix: filename becomes `26.04.21 Dated Episode.mp3` when `published_at` is set, and falls back to the un-prefixed title when `published_at` is null. The `insertEpisode` helper now accepts an optional `publishedAt` argument. A further test covers the v1.3.1 → v1.3.2 filename migration: an episode whose stored `device_relative_path` uses the old un-prefixed name is re-copied under the new dated name, the old on-device file is removed, and the `device_podcast_synced` row points at the new path.
- **`podcast-subscriptions.test.ts`** — New `subscription latestEpisodeAt` describe block: `listSubscriptions` and `getSubscriptionById` return the most recent `published_at` across episodes, and `null` when the subscription has no episodes yet.
- **`podcasts-panel.test.tsx`** — Two new tests for the latest-episode signal: the relative date renders when `latestEpisodeAt` is set, and nothing renders when it is null. `makeSub` helper updated to take an optional `latestEpisodeAt`.
- **`podcast-episode-modal.test.tsx`** — `makeSub` helper updated to satisfy the new required `latestEpisodeAt` field on `PodcastSubscription`.

---

## [1.3.1] — 2026-05

### Bug fixes

- **Podcast episodes synced with numeric filenames** — Episodes were copied to devices as `<id>.mp3` (e.g. `107.mp3`) instead of using the episode title. Episodes now sync as `<Episode Title>.mp3` inside the show folder, making them readable on the device without a tag library.
- **UI freezes during sync on Intel Mac** ([#70](https://github.com/JoaoSobral/ipodrocks-js/issues/70)) — `Device.getTracks` and `Device.getContentStats` walked the device filesystem with synchronous `fs.readdirSync`/`fs.statSync`, blocking the Electron main process event loop. On slow USB hosts (e.g. 2018 Intel Mac Mini) this could freeze the UI for 1–2 minutes per sync — progress events queued up and the Cancel button could not be clicked. Both walks are now fully async; the cancel signal is checked before every directory and stat call, and the sync handler bails out with `SyncCancelled` between content types so cancelling halts the whole queue, not just the in-flight copy.

### Features

#### Auto Podcasts

- **Delete episodes** — The episode modal now has a **Select** button above the episode list. Clicking it enters delete mode: checkboxes appear on every episode, a **Select all / Deselect all** toggle appears, and the footer switches to a **Delete (N)** button. Deleting an episode removes the local downloaded file, removes the copy from every synced device, and marks the episode as `skipped` so it will not be re-downloaded automatically.
- **Unsubscribe cleans up files** — Unsubscribing from a podcast now deletes the local episode files and removes episode copies from all synced devices before clearing the subscription record. Previously, local and device files were left behind.

---

## [1.3.0] — 2026-05

### Features

#### Auto Podcasts

- **Podcast Index integration** — Podcast search is powered by the Podcast Index API. API key and secret are configured in Settings → Auto Podcasts and tested against the live API before saving.
- **Subscribe & manage podcasts** — Search for shows by name, subscribe in one click, and manage all subscriptions from the new Auto Podcasts panel. Each subscription shows the show artwork, author, and whether all target episodes are downloaded.
- **Auto-download modes** — Each subscription can be set to automatically keep the N most recent episodes (1–5) or operate in manual mode, where individual episodes are hand-picked from the episode list.
- **Episode management modal** — Clicking a subscription opens a per-show panel listing all fetched episodes with their download state (pending, downloading, ready, failed, skipped), duration, and publish date. Auto-count and manual selection can be changed at any time; "Download Now" re-triggers a refresh and download for the current target set.
- **Background scheduler** — A boot refresh runs once at startup. A configurable periodic refresh (every 15, 30, or 60 minutes) fetches new episodes and downloads any that are missing. A 1-minute device-connection poller triggers an immediate refresh-and-sync cycle whenever a podcast-enabled device is newly detected as online.
- **Device sync** — Subscribed episodes are synced to each device's `Podcasts/<ShowName>/` folder automatically. Each device has an opt-in "Allow Auto Podcasts" toggle (set at add-device time or via device settings). The sync skips already-transferred episodes using a `device_podcast_synced` tracking table.
- **Configurable download folder** — Episodes are stored in `<userData>/auto-podcasts` by default. A custom folder can be set via Browse in Settings; changing it re-queues all ready episodes for re-download into the new location.
- **Automatic episode pruning** — When auto-count mode is active, episodes beyond the 10 most-recent ready downloads are deleted from disk and marked skipped, keeping storage use bounded.

#### UI

- **Player bar icons** — Playback controls (skip previous/next, play/pause, stop) and the volume indicator now use crisp MDI SVG icons instead of emoji or Unicode glyphs.
- **Theme toggle** — The light/dark mode button now shows animated SVG sun and moon icons with a smooth rotation transition.

Bug fixes and general improvements.

---

## [1.2.1] — 2026-05

### Bug fixes

- **Sync re-copies tracks with Unknown Artist/Album every run** — `computeDeviceRelativePath` passed `sanitizeDevicePathComponent` directly to `Array.prototype.map`, so the array index was forwarded as the function's `maxLen` parameter. This truncated each path segment to N characters, producing destinations like `/P/01` instead of `Black Sabbath/Paranoid/01 - War Pigs.opus`. Files were copied to the wrong place every sync and never matched on subsequent runs. Affected tracks whose metadata fell back to the `libraryFolderId` branch (Unknown Artist/Unknown Album).
- **Converted tracks re-converted on every sync** — `convertWithCodec` and `convertWithFfmpeg` did not preserve the source mtime on the output file, so the mtime fallback in `compareLibraries` never matched and lossless conversions (ALAC/FLAC) were always re-encoded. The conversion path now mirrors `copyFileToDevice` and calls `utimes` after a successful encode.
- **Up-to-date artwork and playlists counted as "processed" items** — Artwork and `.m3u` playlists already on device with matching content emitted `total_add` and `copy{status:"skipped"}` progress events, so a no-op sync showed "2 / 2 items, 0 copied" instead of the empty-state expected by the user. Both code paths now pre-filter to actual writes before bumping counters, matching how unchanged music tracks are silently skipped.

### Features

#### Built-in audio player

- **`media://` custom protocol** — A secure Electron protocol handler (`media-protocol.ts`) serves audio files directly to the renderer via `net.fetch`. Registered as privileged with `secure`, `standard`, `supportFetchAPI`, and `stream` flags so the renderer can use standard `<audio>` / Web Audio APIs against it.
- **Native playback for common codecs** — MP3, AAC, FLAC, OGG, OPUS, PCM, and ALAC are served directly from disk without any conversion step.
- **ffmpeg transcoding for unsupported codecs** — Tracks in formats the browser cannot play natively (MPC, APE, and others) are transcoded on the fly to Ogg Vorbis via ffmpeg and written to a per-session temp file before playback begins. The active ffmpeg process and temp file are tracked so `cancelPrepare()` can abort mid-transcode and clean up.
- **Path security** — The protocol handler only serves files that are inside the player temp directory or have a recognised audio extension. Any other path returns `403 Forbidden`, preventing the renderer from reading arbitrary files from the filesystem.
- **Base64url path encoding** — File paths are encoded as base64url tokens in `media://local/<token>` URLs, keeping special characters and spaces out of the URL while remaining fully reversible.
- **Temp-dir cleanup** — `cleanupPlayerTemp()` removes all transcoded temp files on app quit.

#### Rocksy (renamed from Music Assistant)

- **Music Assistant is now Rocksy** — The floating AI chat panel has been renamed to Rocksy throughout the app.

### Testing

- **`media-protocol.test.ts`** — Tests for scheme registration flags, `400` on bad base64, `403` on path outside temp dir / non-audio, `200` fetches for temp-dir files, valid audio files outside temp dir, and `file://` URL derivation; verifies `net.fetch` is not called on forbidden requests.
- **`player-source.test.ts`** — Tests for `pickStrategy` (native vs. transcode per codec), `isAudioFilePath` (audio and non-audio extensions), `encodePathToUrl`/`decodeUrlToPath` round-trips (spaces, Unicode, special chars), native `prepareTrack` returns correct `media://` URL, and `cancelPrepare` no-ops safely when nothing is active.

---

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
