# iPodRocks — Claude Notes

## Testing Policy

Every time a feature or functionality is added or changed, the corresponding end-to-end tests **must** be created or updated in the same change. No feature work ships without end-to-end coverage of the new/modified behavior. Prefer E2E tests (Playwright, `npm run test:e2e`) over unit/integration tests.

## AI Assistant (Rocksy) Tool Policy

Every new user-facing action or feature **must** have a corresponding tool in `src/main/assistant/tools.ts` so Rocksy can perform it on the user's behalf. Tool tiers:
- `read` — safe reads, run inline
- `write-safe` — non-destructive mutations, run inline
- `write-destructive` — deletions, syncs, scans, folder changes; always require a confirm gate

Also update the system prompt rules in `assistantChat.ts` (`ASSISTANT_SYSTEM_PROMPT`) with an explicit directive so Rocksy calls the new tool instead of saying it can't do something.

## Known Technical Debt (from simplify/security review, 2026-04-21)

These are confirmed reuse/efficiency issues found during `src/main/` review. Address in a dedicated refactor pass.

| Area | File | Issue |
|---|---|---|
| Reuse | `ipc/devices.ts` + `ipc/sync.ts` | Device track map building (music/podcast/audiobook) repeated 3× |
| Reuse | `library-scanner.ts` / `library-core.ts` | `get-or-create` pattern for artist/album/genre duplicated |
| Efficiency | `library-scanner.ts:641` | `INSERT OR IGNORE` then `SELECT` — reverse to `SELECT` first |
| Efficiency | `metadata-extractor.ts:141` | `parseFile()` called twice per track |
| GitHub Actions | `.github/dependabot.yml` | `package-ecosystem: ""` — Dependabot is disabled |
| GitHub Actions | All workflows | Actions pinned to floating `@vN` tags instead of commit SHAs |

### From the PR #116 review (2026-08-22)

All five items found in that review were fixed in the same PR. Kept here as the
reasoning behind the current shape of the code:

| Area | File | Resolution |
|---|---|---|
| Blocking I/O | `library/shadow-library.ts` — `pruneOrphanedFiles()` | Now `async`: walks with `fs/promises` and yields every `PRUNE_YIELD_EVERY` files, so the window keeps painting. Its directory cleanup no longer re-sweeps the whole tree — `removeEmptiedDirs()` climbs only from the directories a deletion actually emptied (same for `deleteOrphanedShadowFiles`, via `removeEmptiedDirsSync`). |
| Data loss | `library/shadow-prune.ts` — `decidePrune()` | Bounded by `isPrunableName()`: the prune only deletes what the shadow builder can write — a transcode, or the `cover.jpg` generated beside it. Anything else survives regardless of its directory, so a shadow library pointed at a folder holding unrelated data cannot destroy it. **Adding a new file kind to the shadow build means adding its name to `SHADOW_ARTWORK_NAMES` or it will never be pruned.** |
| Altitude | `sync/sync-core.ts` | The optional tails collapsed into `LayoutOptions` / `RunOptions` and the per-function `…Options` interfaces that extend them. `runSync` builds one `layout` object and hands the same one to compare, copy and artwork — which is the point: those three passes must agree on where a track lands or every sync re-copies the library. |
| Robustness | `devices/devices-core.ts` | `normalizeUsbIdentity()` throws on a serial with no ids behind it instead of reading it as "clear the binding". Only all-three-absent clears. The dead `usb_*` entries are gone from `FIELD_MAP`/`ALLOWED_UPDATE_FIELDS`; `USB_IDENTITY_KEYS` is the single list the update loop skips. |
| Dead param | `devices/usb-devices.ts` | `refreshUsbSnapshot()` no longer takes `force`. The one caller that must bypass the cache (`device:listUsb`) calls `listUsbDevices()` directly, which a `force` flag could not have achieved anyway — it would still return an in-flight pre-plug enumeration. |

> Note: `src/main/ipc.ts` was split into per-domain modules under `src/main/ipc/` (one `registerXHandlers()` per channel prefix, shared helpers in `ipc/common.ts`). Add new handlers to the matching domain module.

## Hazard: an index in `SCHEMA_SQL` over a column added by a migration

`db.exec(SCHEMA_SQL)` runs at the top of `AppDatabase.initialize()`, **before any
migration**. On an existing database `CREATE TABLE IF NOT EXISTS` is a no-op, so a
column added by an `ALTER TABLE` migration does not exist yet at that point. A
`CREATE INDEX ... ON t(new_column)` in `SCHEMA_SQL` therefore throws and takes the
whole of `initialize()` — and the app launch — down with it, for every upgrading
user while working perfectly on a fresh install.

This shipped once already (the 2.3.0 `usb_vendor_id` index, see
`src/__tests__/regressions/device-usb-identity-migration.test.ts`) and was nearly
reintroduced by `idx_device_synced_devpath` in 2.3.0-beta. **Put the column in
`SCHEMA_SQL`, but create its index only inside the migration**, immediately after
the `ALTER TABLE`. Add a regression test that builds a database with the column
stripped back out and asserts `initialize()` does not throw.

## Hazard: the Rockbox runtime matcher must spell paths the way the sync does

`buildDevicePathResolver()` (`src/main/rockbox/device-path-match.ts`) joins Rockbox's
runtime counters to library tracks by rebuilding, from the library side, the path
each file occupies on the device. It is therefore a *second implementation* of the
device layout, and issue #117 is what happens when the two drift: every one of a
reporter's 2411 runtime records went unmatched, silently, while the sync itself
worked perfectly.

Three rules keep them together:

- **Never compare file extensions.** The device holds whatever the codec profile
  produced. Every inexact tier compares through `codecAgnosticKey()`, which strips
  the extension. A tier that matches on a full filename is a bug.
- **Build both sides with `utils/device-path.ts`.** `sanitizeDevicePathComponent`
  and `folderRelativePath` live there (re-exported by `sync/sync-core`) precisely so
  the matcher and the sync layer cannot disagree. **Adding a sanitization rule or a
  new device layout means the matcher picks it up for free only if it goes in that
  module** — put it anywhere else and the matcher stops matching.
- **`device_synced_tracks.library_path` is not always `tracks.path`.** On a device
  whose `source_library_type` is `shadow` it is `shadow_tracks.shadow_path`. The
  exact tier resolves through both; a new source of device files needs adding there
  too.

Every tier refuses an ambiguous key (the `-1` marker in `put`/`pick`) rather than
picking one. Ignoring the extension *widens* what collides — a library holding both
`song.flac` and `song.mp3` in one folder now produces one key — so that guard is
load-bearing, not defensive decoration. Coverage:
`tests/e2e/rockbox-runtime-transcoded.test.ts` (every codec, FAT-invalid names,
shadow devices) and
`src/__tests__/regressions/runtime-shadow-device-match.test.ts` (the shadow join in
isolation from the tiers that mask it).

## Hazard: `foreign_keys = OFF` during track deletion

`LibraryScanner.deleteRemovedTracks()` (`src/main/library/library-scanner.ts`) wraps its deletes in `PRAGMA foreign_keys = OFF`, so **no `ON DELETE CASCADE` declared in the schema fires there**. Every dependent table must be deleted by hand inside that transaction (`playback_logs`, `playback_stats`, `shadow_tracks`, `content_hashes`, `playlist_items`). The same applies to `cleanupOrphanedEntities()` in the same file.

**As of 2.3.0-beta the list is: `playback_logs`, `playback_stats`, `device_runtime_stats`, `runtime_play_deltas`, `device_track_ratings`, `rating_conflicts`, `rating_events`, `shadow_tracks`, `content_hashes`, `playlist_items`.** The three rating tables were being orphaned on every removed track until 2.3.0-beta — they declare `ON DELETE CASCADE`, which is exactly why nobody noticed. `src/__tests__/regressions/runtime-stats-orphan.test.ts` pins the whole set across `deleteRemovedTracks()`, `LibraryCore.deleteTrack()` and `removeLibraryFolder()`.

**Deleting the row is not always enough.** `shadow_tracks.shadow_path` is the only record of where a transcode lives on disk, so it must be *captured before* the row is deleted — `deleteRemovedTracks()` returns it as `removedShadowPaths` and the scan hands it to `ShadowLibraryManager.deleteOrphanedShadowFiles()`. Deleting the row first is what let renamed album folders leave their old transcodes behind forever. Any dependent table that points at a file on disk needs the same treatment.

This has already caused three shipped bugs — orphaned `codec_configurations` (issue #105), orphaned `playlist_items` (playlists holding deleted songs), and orphaned shadow transcodes (shadow libraries accumulating a copy of every renamed album). **When adding a table that references `tracks(id)`, add its delete to `deleteRemovedTracks()` too**, and cover it with a regression test that deletes with FKs off (see `src/__tests__/regressions/playlist-reconcile.test.ts`).

