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

## Hazard: Rockbox has no null rating

Rockbox stores a rating of `0` for a track nobody has rated *and* for one rated
zero — the format has no null. Anything that reads a device rating must decide
which it is from the baseline in `device_track_ratings.last_seen_rating`, never
from the value alone. Reading `0` as an assertion is what made a first sync queue
one conflict per track the user had rated only in iPodRocks, and write `rating =
0` over every unrated track in the library (issue #117).

- `mergeRating()` (`src/main/sync/rating-merge.ts`) treats `deviceVal === 0` with
  no baseline as *no opinion*: never adopted, never a conflict.
- Anything selecting "rated" tracks wants `rating > 0`, not `rating IS NOT NULL`
  — see `generateStarred()`.
- **`detectRebuiltDatabase()` must be called before `ingestDeviceRatings()`, not
  after it.** The merge is not reversible, so a verdict reached afterwards cannot
  protect anything — the old code printed "ratings were skipped" over a merge
  that had already happened. A rebuild is measured as *loss* (tracks this device
  was last seen rating that now read 0), never as the share of zeros: a normal
  library is nearly all zeros and would trip any such test on every sync.
- **A rebuild verdict must also invalidate what Phase 3 believes it already
  pushed.** `computeRatingPropagations()` only re-sends a track when
  `device_track_ratings.last_pushed_rating` disagrees with `tracks.rating` — it
  has no idea the device was just wiped. Left alone, any track pushed *before*
  the rebuild stayed permanently unrepaired: `last_seen_rating` never gets
  refreshed either (Phase 1 ingest is skipped whole on a rebuild verdict), so the
  next sync saw the same wiped device against the same stale baseline — a
  self-sustaining "looks rebuilt" loop with no user action that escaped it
  (issue #117 follow-up: the reporter rebuilt his device on purpose expecting his
  library's ratings to sync back down, and they never did, on any later sync).
  `invalidatePushedRatings()` clears `last_pushed_rating` for the device — so
  Phase 3 re-sends every currently-rated track in the *same* sync — and closes
  any of that device's open `rating_conflicts` as `canonical_wins`, since the
  disputed device value no longer exists to disagree with anything. It
  deliberately leaves `last_seen_rating` alone: once Phase 3 repairs the device
  this sync, the next sync's fresh reading matches it and the verdict clears on
  its own.

Pinned in `src/__tests__/regressions/rating-zero-and-rebuild.test.ts` and
`tests/e2e/rating-conflicts.test.ts`.

## Hazard: a third rating source — the file's own tag — must only ever seed, never fight

Issue #118: a library manager (Swinsian, in the report) can write a star rating
into a file's own tag (ID3 POPM, a Vorbis `RATING` comment, …). iPodRocks reads
that tag during a library scan, via `ratingFromCommonTags()`
(`src/main/library/metadata-extractor.ts`) normalizing music-metadata's
already-format-agnostic `common.rating` (0..1) onto the same 0-10 scale
Rockbox and iPodRocks share. **iPodRocks does not write ratings back to the
file** — the maintainer's stated principle on the issue — so this is a
one-directional seed, not a sync participant:

- `LibraryScanner`'s upsert only ever adopts the tag when the track has no
  rating yet (`rating = CASE WHEN rating IS NULL THEN excluded.rating ELSE
  rating END`). Once a device sync or an in-app edit has an opinion, the file
  tag never gets a second say — unlike the device/library pair, there is no
  3-way merge here, because there is no baseline to merge from.
- **A plain rescan does not reach tracks a prior version of iPodRocks already
  scanned**, because the mtime-skip means their tags are never re-read. Fixed
  the same way issue #113's album-artist tags were: a one-shot backfill
  (`rating-tag-backfill.ts`, sentinel `rating_tag_backfill_done` in
  `app_settings`) that re-reads only the rating tag for currently-unrated
  tracks, run once at the top of every `scanFolder()`.
- No tag convention is special-cased. If a library manager's rating tag
  doesn't match what music-metadata already normalizes, it simply never
  seeds — that is by design, not a bug to chase per-tool.

Pinned in `src/__tests__/regressions/rating-tag-import.test.ts`,
`src/__tests__/regressions/rating-tag-backfill.test.ts`, and
`tests/e2e/rating-tag-import.test.ts`.

**The escape hatch is opt-in and off by default: `RatingPrefs.tagRatingAlwaysWins`**
(`prefs.ts`, Settings → Ratings → "Library tags always win"). With it on, a scan
reverses the rule above on purpose — `rating-tag-overwrite.ts`'s
`overwriteRatingsFromTags()` makes the tag authoritative for every track in the
scanned folder, including *clearing* a rating when the file is untagged, and
closes out any open `rating_conflicts` on a touched track as `canonical_wins`.
This is a deliberate "reset iPodRocks to match my library manager" action, not
a mode meant to stay on: it runs on every scan while enabled, with no sentinel,
and a rating set on a device or in-app survives only until the next scan. It
does not attempt to clear a rating on-device — Rockbox's tagcache has no null
(see the hazard above), so there is nothing today that can push "unrated" out
to a player; only non-null overwrites propagate via the existing
`computeRatingPropagations()`. Rocksy can flip it via `ratings_set_tag_priority`
(`write-safe` — the setting alone changes nothing; the actual overwrite runs
through the already-gated `library_scan`). Pinned in
`src/__tests__/regressions/rating-tag-overwrite.test.ts` and
`src/__tests__/regressions/rating-tag-always-wins.test.ts`.

## Hazard: `foreign_keys = OFF` during track deletion

`LibraryScanner.deleteRemovedTracks()` (`src/main/library/library-scanner.ts`) wraps its deletes in `PRAGMA foreign_keys = OFF`, so **no `ON DELETE CASCADE` declared in the schema fires there**. Every dependent table must be deleted by hand inside that transaction (`playback_logs`, `playback_stats`, `shadow_tracks`, `content_hashes`, `playlist_items`). The same applies to `cleanupOrphanedEntities()` in the same file.

**As of 2.3.0-beta the list is: `playback_logs`, `playback_stats`, `device_runtime_stats`, `runtime_play_deltas`, `device_track_ratings`, `rating_conflicts`, `rating_events`, `shadow_tracks`, `content_hashes`, `playlist_items`.** The three rating tables were being orphaned on every removed track until 2.3.0-beta — they declare `ON DELETE CASCADE`, which is exactly why nobody noticed. `src/__tests__/regressions/runtime-stats-orphan.test.ts` pins the whole set across `deleteRemovedTracks()`, `LibraryCore.deleteTrack()` and `removeLibraryFolder()`.

**Deleting the row is not always enough.** `shadow_tracks.shadow_path` is the only record of where a transcode lives on disk, so it must be *captured before* the row is deleted — `deleteRemovedTracks()` returns it as `removedShadowPaths` and the scan hands it to `ShadowLibraryManager.deleteOrphanedShadowFiles()`. Deleting the row first is what let renamed album folders leave their old transcodes behind forever. Any dependent table that points at a file on disk needs the same treatment.

This has already caused three shipped bugs — orphaned `codec_configurations` (issue #105), orphaned `playlist_items` (playlists holding deleted songs), and orphaned shadow transcodes (shadow libraries accumulating a copy of every renamed album). **When adding a table that references `tracks(id)`, add its delete to `deleteRemovedTracks()` too**, and cover it with a regression test that deletes with FKs off (see `src/__tests__/regressions/playlist-reconcile.test.ts`).

## Hazard: the M4A ReplayGain writer only ever appends to a trailing `moov`

Issue #121 (extended past its filed scope): ffmpeg's own MOV/MP4 muxer silently
drops any metadata key it doesn't recognize as a standard atom — confirmed
empirically, even with an explicit per-stream `-metadata` override — so
AAC/ALAC (`.m4a`) transcodes were losing ReplayGain tags the same way MPC was.
`writeM4aReplayGainTags()` (`src/main/tagging/mp4/replaygain-writer.ts`) fixes
this by appending iTunes-style `----` freeform atoms (`mean` =
`"com.apple.iTunes"`, `name` = the lowercase key, e.g.
`"replaygain_track_gain"` — Rockbox's `mp4.c` matches only on `name`, case-
insensitively, and never reads `mean` at all) into `moov > udta > meta >
ilst`, called from both `convertWithCodec` (codec `aac`/`alac`) and
`convertWithFfmpeg` (profiles `aac_256`/`alac_16`) in `sync-conversion.ts`.

**This is only safe because `moov` sits after every `mdat` in ffmpeg's output**
(confirmed by hex-dumping real output; neither conversion path passes
`-movflags +faststart`). Sample tables (`stco`/`co64`) store absolute byte
offsets *into* `mdat`; since `mdat` is never touched and `moov` is the last
top-level box, growing `moov` is a pure append with nothing else to
renumber. The writer checks this at runtime — every top-level `mdat`'s end
offset must be ≤ `moov`'s start offset — and refuses (returns `false`, leaves
the file untouched) rather than write when that's not true. **If a future
ffmpeg build or flag ever puts `moov` before `mdat`, do not relax that check**
without also rewriting the sample-offset tables; that is real MP4 box
surgery this module deliberately does not attempt.

Pinned in `src/__tests__/mp4-replaygain-writer.test.ts` (including the guard
firing when `moov` precedes `mdat`) and
`src/__tests__/behaviors/m4a-transcode-replaygain.test.ts` (real ffmpeg
pipeline, verified by ffmpeg's own `-i` probe as an independent oracle). The
Musepack side of the same issue is pinned in `src/__tests__/mpc-source-tags.test.ts`
and `src/__tests__/behaviors/mpc-transcode-tags.test.ts`.

