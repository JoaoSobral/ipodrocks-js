# iPodRocks — Claude Notes

## Testing Policy

Every time a feature or functionality is added or changed, the corresponding end-to-end tests **must** be created or updated in the same change. No feature work ships without end-to-end coverage of the new/modified behavior. Prefer E2E tests (Playwright, `npm run test:e2e`) over unit/integration tests.

**`vi.mock` must be written at the top level of its own module.** Vitest hoists
every `vi.mock` to the top of the file it appears in, so one written inside a
function only *looked* scoped — it always applied to the whole file. Vitest 5
(here since Dependabot's `@vitest/mocker` bump) makes writing it there a hard
error that fails the suite at load time, so it took out 43 of them at once. Two
consequences worth keeping:

- `harness/ipc-harness.ts` registers the electron mock at module scope;
  `installElectronMock()` survives as the marker at the top of a test file.
  That is safe only because `harness/index.ts` does **not** re-export it.
- `harness/music-metadata-mock.ts` *is* re-exported from the index, and half the
  suites that import a harness helper want the real parser. So its mock is
  always registered and delegates to the real `parseFile` until
  `installMusicMetadataMock()` flips it. Do not "simplify" that into an
  unconditional mock.

**When CI disagrees with a local run, check the installed version before
anything else** — `node_modules` can sit well behind `package-lock.json`, and
CI's `npm ci` never does. `npm ci` locally reproduces it exactly.

The e2e suite runs the app **hidden**: `tests/e2e/electron-launcher.ts` sets
`IPODROCKS_HEADLESS=1`, which `src/main/index.ts` turns into `show: false` plus
`backgroundThrottling: false` on the `BrowserWindow`, and `app.dock.hide()` on
macOS. Playwright drives the renderer over CDP, so nothing needs the window on
screen — without this a full run is ninety-odd Electron launches stealing focus
for two minutes. **Run `IPODROCKS_HEADLESS=0 npx playwright test <file>` to watch
one happen**, which is the first thing to try when a UI test fails only in CI.
The flag is checked as `=== "1"` and is set nowhere else: an app that never
shows a window is useless to a user, so it must stay opt-in.

## AI Assistant (Rocksy) Tool Policy

Every new user-facing action or feature **must** have a corresponding tool in `src/main/assistant/tools.ts` so Rocksy can perform it on the user's behalf. Tool tiers:
- `read` — safe reads, run inline
- `write-safe` — non-destructive mutations, run inline
- `write-destructive` — deletions, syncs, scans, folder changes, **and anything that changes what the outside world can reach** (`web_server_set_enabled`); always require a confirm gate

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
| Audit trail | `sync/rating-merge.ts` | `markRatingsPropagated()` writes no `rating_events` row, so `source='propagate'` (and `'migration'`) are never emitted — nothing can explain where a device-side value came from |
| Reuse | `ipc/ratings.ts:135` + `assistant/tools.ts:440` | Conflict resolution implemented twice; the assistant copy has no `manual` branch and no test coverage |
| Trap | `database.ts` — `migrateContentTypeAudiobook()` | Rebuilds `tracks` from an **explicit column list** that predates the rating columns. Harmless in production (sentinel-gated, and a database old enough to run it has no ratings) but it silently drops any later column, so a test fixture built from bare `SCHEMA_SQL` — no sentinel — loses every rating before the migration under test is reached. Build such fixtures by running `initialize()` once and then stripping the one column back out (see `regressions/rating-version-baseline.test.ts`) |

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
  no baseline as *no opinion*: never adopted, never a conflict. **`deviceVal ===
  0` against `libraryVal === null` is a noop at *any* baseline** — that guard
  sits above the `baseline === null` arm on purpose. Both sides agree there is no
  rating, so there is nothing to adopt and nothing a conflict could ask (the
  row's `canonical_rating` would be null, leaving the UI to offer "keep 0"
  against "keep nothing"). Without it the divergent branch queued exactly that
  unanswerable conflict, and the "device changed, library didn't" branch wrote 0
  over the null.
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
- **`detectRebuiltDatabase()` measures only tracks the library still rates**
  (`loadRepairableBaselines()` in `rating-merge.ts` — `rating > 0`, not `IS NOT
  NULL`, since a canonical 0 pushes nothing). `last_seen_rating` is a fact about
  the device and is deliberately never rewritten when the library's own rating
  changes, so un-rating a track in the library — `ratings:setTrackRating(id,
  null)`, or wholesale by scanning with `tagRatingAlwaysWins` on — strands a
  baseline above zero over a null canonical. That track then reads 0 on the
  device forever (there is no "unrated" to push), and counting it as loss made
  the verdict permanently true with no user action that cleared it. Both
  consequences of a verdict — skipping the ingest, and re-pushing to repair the
  device — only ever touch tracks the library rates, so that is the sample.
  **Fix this in the measure, never by clearing `last_seen_rating` at the write
  sites**: dropping the baseline makes the next ingest classify the track
  `first_observation`, and `mergeRating` then adopts the device's surviving
  rating straight back into the library, silently undoing the clear. It would
  also have to be repeated at every present and future path that nulls a rating.

Pinned in `src/__tests__/regressions/rating-zero-and-rebuild.test.ts` and
`tests/e2e/rating-conflicts.test.ts`.

## Hazard: a rating can only reach the device through a `device_track_ratings` row

Issue #138: "a new album was synced without the ratings."

`computeRatingPropagations()` (`sync/rating-merge.ts`) joined `device_track_ratings`,
and for a long time that join was an **INNER** one. The only two things that create a
row in that table are `ingestDeviceRatings()` — which needs the *device* to have
reported the track in its runtime data — and `markRatingsPropagated()`, which needs
the track to already be in the propagation set. A rating on a track the device had
never reported was therefore unreachable: a closed loop with no way in, worst on a
rebuilt device, where the ingest is skipped whole and the rows are not created that
sync either.

- **The join must stay a LEFT join.** Nothing is lost by widening it: "is this track
  on the device" is not that query's job. `propagateRatingsToDevice()` resolves every
  candidate against `runtimeImport.idxIds` — the index positions read off the device
  *this* sync — and a track with no record there is skipped and left unmarked for the
  next sync. Those ids are never cached across runs: a "Database → Initialize now"
  renumbers every entry.
- **Phase 3 lives in `sync/rating-propagate.ts`, not in `ipc/sync.ts`.** It was
  inline, so nothing tested it — `behaviors/rating-writeback.test.ts` re-implemented
  the loop in a local helper and tested *that*. All three of this issue's defects
  lived in the untested copy. Do not move it back.
- **`writeRating()` returns a `RatingWriteResult`, not a boolean.** The boolean
  conflated "the device already holds this value" (success) with "no index" and
  "Rockbox is mid-update" (failure), and the caller marked both as pushed —
  `last_pushed_rating` then matched `tracks.rating`, the query excluded the track,
  and the rating never arrived on any later sync. Only `"written"`/`"unchanged"` may
  be marked.
- **Each track's write is wrapped alone.** A `TcdFormatError` used to escape the loop
  before `markRatingsPropagated()` ran, so a single bad record discarded the
  bookkeeping for every rating written before it.
- **A track copied during this sync cannot get a rating, and the log must say so.**
  Rockbox only learns a file exists when its database is updated, so there is no
  record to write into. `notInDeviceDb` counts them and the sync tells the user to
  run Database → Update now and sync again. This is the reporter's actual symptom;
  silence is what made it look like data loss.
- **That count must mean what it says, which is why Phase 3 takes the sync's own
  selection.** Since the join was widened, `computeRatingPropagations()` offers
  every rated track in the library, so a track missing from `idxIds` is ambiguous:
  on the device and not yet indexed (actionable), or never sent here at all
  (nothing to say). Without the split a 20,000-track library syncing a 500-track
  selection announced "19,500 rating(s) are waiting for the device's database" on
  every sync. **`device_synced_tracks` is the wrong source for this** — only the
  `device:check` handler ever writes it, so on a device the user syncs without
  running a check it is empty and every actionable rating is silently filed as
  "not on this device". `ipc/sync.ts` builds the set from the same maps `runSync`
  copied from, after the shadow remap, which keeps the library track id either way
  (`remapTrackMapToShadow`).
- **Phase 3 is gated on `runtimeImport.state.kind === "ok"`, not on a non-null
  `runtimeImport`.** `readAndIngestRuntimeData()` returns a fully empty result —
  `idxIds` included — for runtime data turned off, no `.rockbox` database, an
  unreadable one, one Rockbox is mid-update, and one that has never recorded a
  play. Those cannot write anything, and running the loop against an empty
  `idxIds` counted every rated track as waiting and handed the user an instruction
  that could not help. Each of those states already prints its own message.

Separately, `ingestDeviceRatings()` hardcoded `ratingVersionAtSync = 0` because
nothing stored `tracks.rating_version` as of the last push. Every rating writer does
`rating_version + 1`, so any track ever rated in-app read as "library changed"
forever, and a later device-only edit took the both-sides-changed branch: a conflict
the user had to answer for a change only they had made, or — one step apart — a
silent `converged` to `Math.max`, i.e. their device edit thrown away.
`device_track_ratings.last_pushed_rating_version` records it now.

- **It is written by `markRatingsPropagated()` and cleared by
  `invalidatePushedRatings()`**, always alongside `last_pushed_rating`: the version
  means nothing without the value it belongs to.
- **`adopt_device` must not write when the adopted value already equals
  `tracks.rating`** — guarded exactly like the `converged` arm beside it, and for
  a sharper reason than tidiness. The commonest adoption of all is the device
  reading back a rating Phase 3 pushed to it last sync: baseline 0, device now 8,
  library already 8. Writing that bumps `rating_version` for a value that did not
  change, and Phase 3 then has nothing to propagate, so nothing refreshes
  `last_pushed_rating_version` — it is left one behind for good, `libraryChanged`
  is permanently true again, and the next device-side edit is a spurious conflict.
  The fix below looked complete for exactly one sync without this.
- **A test for any of this must run two syncs before the device-side edit.** A
  single ingest that establishes the baseline with the same value takes the
  `converged` path, which was always guarded, and hides the whole defect.
- **The migration backfills it** where `last_pushed_rating = tracks.rating`, which is
  exactly "the library has not moved since we pushed". Where they differ it stays
  NULL, and `libBaseAtLastSync !== libraryVal` already carries that answer.

Pinned in `src/__tests__/regressions/rating-propagation-gap.test.ts`,
`src/__tests__/regressions/rating-version-baseline.test.ts` (including the migration
on a database built by the previous release) and
`tests/e2e/rating-propagation-new-album.test.ts`.

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

## Hazard: APEv2 item flags put the type in bits 1-2, not bits 0-1

Issue #125. `ITEM_TYPE_BINARY` was `1`. In APEv2 **bit 0 is the read-only flag
and bits 1-2 are the value type**, so `1` does not mean "binary" — it means
"read-only UTF-8 **text**". Every spec-conformant reader (MP3tag, foobar2000,
ffmpeg's `APE_TAG_FLAG_IS_BINARY = 1<<1`, Rockbox's `(flags & 0x06) == 0`) then
parsed the cover art as a text value; APEv2 text values are **NUL-separated
multi-values**, so the NUL bytes inside a JPEG exploded one item into thousands
of mostly-empty "Cover Art" values, and Rockbox's bounded tag buffer was
consumed before it reached the `REPLAYGAIN_*` items the writer emitted *after*
the artwork.

The bug was invisible from inside the app because reader and writer shared the
same wrong mask — `reader.ts` decoded with `(flags & 3)` — so the round-trip
test passed. `items.test.ts` actively pinned `flags === 1`, and no test ever
wrote a cover-art item through the real pipeline: the fixture FLAC in
`behaviors/mpc-transcode-tags.test.ts` had no picture and no `cover.jpg` beside
it, so the binary branch never ran. **A round-trip through your own code is not
a format test.** That fixture now ships a real `cover.jpg` for exactly this
reason.

Three rules:

- **`itemTypeFromFlags()` (`apev2/constants.ts`) is the only place the type bits
  are read.** Never mask with `& 3` — that folds the read-only bit into the type.
- **`reader.ts` must keep treating a `cover art (front)` item as binary however
  its flags read.** Every file iPodRocks wrote before the fix says "text" there.
  Without the compat the fixed reader decodes that JPEG into a garbage string in
  `tags.extra`, and anything that then writes the tags back out destroys it.
  Cover art is the only binary key this writer has ever produced, so keying the
  compat on the name is exact.
- **`tagsToItems()` emits `extra` (ReplayGain) before the artwork.** Insurance
  against any reader with a bounded tag buffer; costs nothing to keep.

**There is no in-place repair for files already on disk.** `tagging/mpc/repair.ts`,
`repair-scan.ts`, `ipc/maintenance.ts` (Settings → Maintenance → "Repair Musepack
tags") and Rocksy's `mpc_repair_tags` were all deleted in 2.3.3: re-encoding is the
better answer, and maintaining a second writer that had to reproduce the transcode's
every decision was the expensive half. The remedy for a badly tagged `.mpc` is to
**delete the shadow library including its files and create it again** — see the
shadow-rebuild hazard below for why a plain `shadow:rebuild` cannot do it. Do not
reintroduce a repair pass; fix the transcode and re-encode.

Pinned in `src/__tests__/regressions/mpc-cover-art-item-flags.test.ts` and
`src/__tests__/behaviors/mpc-transcode-tags.test.ts`.

## Hazard: `readSourceApeTags()` is the only producer of ReplayGain

Issue #130. Every ReplayGain value iPodRocks writes — into a `.mpc` **stream
header** via `maybeWriteMpcReplayGainHeader` (#137), into `.m4a` via
`maybeWriteM4aReplayGain`, and into an APEv2 tag for the files whose header
cannot take it — comes from `readSourceApeTags()` in `sync/sync-conversion.ts`,
and from nowhere else. It used to end in a bare `catch { return {}; }`.

The four key names and their parsing live in `tagging/replaygain-keys.ts`, which
imports nothing: `sync/` may import `tagging/` and never the other way round, so
that is the only place both sides can share them from. A Musepack *source* is
topped up from its own header there too, since we no longer leave a tag copy in
one.

**An empty tag set is indistinguishable from a file that has no tags.** When
that catch fired, the transcode silently fell back to the six fields
`trackToConversionMetadata()` carries (title, artist, album, genre, track,
disc) — no year, no album artist, no ReplayGain — and nothing anywhere said so.
`MetadataExtractor.extractMetadata()` reads the same files and has always
logged and fallen back to ffprobe; this one did not. It does now, and the
shadow build log carries a line per track that ends up with no ReplayGain.

- **Two fallbacks, for two different failures.** A parse that *throws* falls
  back to a full external tag read. A parse that *succeeds but maps no
  ReplayGain* gets a top-up for those four keys only — music-metadata maps them
  through fixed per-container tables, so an unusual spelling reads as "this file
  has none". Keep both; they are not the same bug.
- **The probe tries `ffprobe`, then falls back to scraping `ffmpeg -i`.**
  Only ffmpeg is bundled (`getFfmpegPath()`); `ffprobe` is whatever the user
  happens to have installed, so it must never be the only way to read a tag the
  transcode depends on. `getEncoderEnv()` does not add the bundled directory to
  `PATH`, which is why the ffmpeg call resolves an absolute path and the ffprobe
  one does not.
- **`extractReplayGainTags()` must reject non-finite numbers.** music-metadata's
  `toRatio()` splits on a space, so a value written as `-3.38dB` comes back as
  `{ dB: null }` and used to be written out as the literal string `"null dB"`.
  Dropping it lets the ffprobe top-up supply the real value instead.

## Hazard: Musepack ReplayGain lives in the stream header, and that packet is fixed-size

Issue #137. Musepack was the first format with native ReplayGain and it keeps the
values in the **stream header**, not the tag — the SV8 `RG` packet, which the spec
makes mandatory. Rockbox reads only that packet; `read_ape_tags()` runs afterwards
and `parse_replaygain()` never overwrites a value already set, so the `REPLAYGAIN_*`
items are a fallback for other tools and nothing more.

**`mpcenc` reserves the packet and leaves every field zero.** It has no ReplayGain
option, and the encode is fed a tagless WAV by ffmpeg anyway, so every value in
there is one iPodRocks put there. The head of a real 1.30.1 output, which is also
the fixture in `src/__tests__/harness/sv8-mpc.ts`:

```
MPCK | SH size 14 @4 | RG size 12 @18: 01 0000 0000 0000 0000 | EI @30 | SO @37 | AP @45
                       payload @21: version, then title_gain(s16) title_peak(u16)
                                    album_gain(s16) album_peak(u16), big-endian
```

`gain = round((64.82 - dB) * 256)`, `peak = round(20*log10(linear*32768) * 256)` —
Rockbox's `SV8_TO_SV7_CONVERT_GAIN` (6482) and `SV8_TO_SV7_CONVERT_PEAK` (23119)
are the same two constants. **`0` means "not computed"**, so `encodeGain`/`encodePeak`
(`tagging/mpc/replaygain-header.ts`) never return it for a value we hold.

Three rules, all of them from `lib/rbcodec/metadata/mpc.c`:

- **The `RG` packet must sit immediately after `SH`.** `get_musepack_metadata()`
  reads 32 bytes from offset 6 and jumps `SH_size - 2` to find it. So the writer
  **patches in place and never inserts or moves a packet** — a file whose packet is
  anywhere else is refused (`"unsupported"`) and keeps its tag ReplayGain instead.
  Inserting would also break the `SO` packet's absolute seek-table offset, and would
  move the trailing APEv2 block.
- **A gain whose peak decodes to 0 is ignored entirely** (`if (peak != 0)` in
  `set_replaygain_sv8()`). Gain and peak are therefore written as a pair:
  `computeTargetRaws()` gives a gain that arrives without a peak a full-scale one
  (23119) rather than dropping it. Half a pair makes the file look tagged and does
  nothing.
- **The header wins over the tag**, which is what makes dropping the tag copy safe.

Consequences worth keeping:

- **The strip is authorized by a successful header write, never by the attempt.**
  `writeMpcMetadata()` drops the four `REPLAYGAIN_*` items only on
  `"written"`/`"unchanged"`. **SV7 (`MP+`) is deliberately never written** —
  different layout and scale, nothing the app produces — so those files keep their
  tag copy.
- **The patch is nine bytes inside a fixed-size packet**, so the file's length and
  every absolute offset in it are unchanged. Keep it that way: a caller may compute
  the trailing tag block's position before the patch and write it afterwards.
- **A header write changes neither size nor mtime.** So no sync re-copies a file
  because of it — which also means nothing can carry a header fix out to a copy
  already on a device. The only route to that is re-encoding the shadow library
  (delete with files, create again) so the new files differ and the sync copies
  them.

> **Test-coverage note:** music-metadata parses SV8 but skips the `RG` packet
> outright (`MpcSv8Parser.js`: `case 'RG': … ignore`), so there is no library to
> check this against. The fixture is hand-assembled from the bytes above, for the
> same reason `legacy-mpc.ts` is: a round trip through our own code is not a format
> test.

Pinned in `src/__tests__/regressions/mpc-replaygain-header.test.ts` (the codec
against the spec's own examples and Rockbox's integer arithmetic, the refusals, the
in-place patch) and `src/__tests__/behaviors/mpc-transcode-tags.test.ts` (real
mpcenc, including the control that its own `RG` packet is all zeros).

## Decision: nothing embeds album artwork into a Musepack file

Also issue #130. `writeMpcMetadata()` used to embed the source's own picture,
or the folder `cover.jpg` beside it, **at its original resolution** — a
1500x1500 cover inside every single track. It is gone, and it should stay gone:
Rockbox reads album art from the `cover.jpg` that `copyArtworkToShadowLibrary()`
writes beside the audio, already resized to `DEFAULT_COVER_MAX_DIMENSION`
(300px). Embedding a second copy bought nothing.

`tagging/writer.ts` still knows how to serialize a binary item and
`tagging/reader.ts` still resolves a legacy mis-flagged cover back to binary by
name — both are needed to read and repair the files already out there. Only the
population is gone.

`tagging/writer.ts` writes the trailing APEv2 block whole, so nothing depends on
it keeping a particular size any more. Anything that appends past it — an ID3v1
tag — is the writer's problem to preserve, and the one real trap here.

Pinned in `src/__tests__/regressions/replaygain-source-read.test.ts` (real
ffmpeg-made FLACs, with `parseFile` mocked to throw) and
`src/__tests__/behaviors/mpc-transcode-tags.test.ts`.

> **Test-coverage note:** that behaviour suite is the only real FLAC to Musepack
> coverage there is, and it `describe.skipIf`s itself when `mpcenc` is absent —
> which is every CI runner. It now prints why it skipped. Anything that must
> hold on CI needs an assertion that does not need `mpcenc`.

## Hazard: a shadow rebuild never re-opens a file that already exists

Issue #130. Nothing in a build reads a byte of an already-transcoded shadow
file, so a defect in what an *earlier* version of the transcoder wrote survives
every rebuild, every rescan and every "clear scan cache". Two independent skips
stack up:

- `reconcileShadowLibrary()` classifies a file as `verified` when the stored
  `shadow_tracks.file_size`/`mtime` still match the file on disk, and never
  opens it. For MPC it would not open it anyway — `canSkipProbe()`
  (`library/shadow-reconcile.ts`) returns true because `readAudioOnly()` is a
  synchronous whole-file read.
- `_transcodeTrack()` then returns `"skipped"` on a `synced` row plus an
  existing file. It compares nothing else: not the source mtime, not a content
  hash, not the tag. `propagateAddedOrUpdated()` (the post-scan path) goes
  through the same function, which is why clearing the scan cache does not help
  either.

**So a rebuild cannot fix an existing file, and nothing in the app tries to.**
2.3.3 removed the `_verifyShadowTags()` pass that used to run between the
reconcile and the transcode loop, along with the whole of `tagging/mpc/repair.ts`
(see the APEv2 item-flags hazard above). The remedy for a file an older version
wrote badly is to **delete the shadow library with its files**
(`shadow:delete(id, keepFilesOnDisk = false)`, the "delete the files too" option
in the UI, or Rocksy's `shadow_delete({ keepFiles: false })`) and create it
again — the files are gone, so `_transcodeTrack()` re-encodes every one from the
source and the sync copies them out because their size and mtime changed.

Two things to keep in mind:

- **A plain `shadow:rebuild` is not that.** It adopts what is on disk. When
  someone reports that a rescan and a rebuild did not fix their tags, this is
  why, and the answer is delete-with-files, not another rebuild.
- **Tag *content* drift is not handled either.** Editing an album or title tag in
  the library after the transcode never reaches the shadow, for exactly the
  reason above — `docs/app-reference/library.md` used to claim otherwise. Left
  deliberately unfixed; fixing it means either a comparison pass or a forced
  re-encode. The legacy-tag fixture for anything in this area lives in
  `src/__tests__/harness/legacy-mpc.ts`.

## Hazard: "Delete all" resolves folders that can collapse to the device root

The Sync tab's **Orphan & Reset Policy** (`ExtraTrackPolicy`) gained
`delete-all`, which erases the device's Music, Podcasts and Audiobooks folders
and lets the sync rebuild them (`sync/device-reset.ts`).

- **`resolveResettableFolders()` is the guard and must stay one.**
  `Device.musicFolder` and friends fall back with `?? "Music"`, which does *not*
  catch an **empty string** stored in the profile: `path.join(mount, "")`
  resolves to the mount root, so an empty folder name would turn "clear the
  Music folder" into "erase the device". Only a path strictly inside the mount
  is ever accepted, and the three are deduped in case a profile points two
  content types at one folder.
- **The reset must run before `device.getTracks()`.** `runSync` compares the
  library against the listing read off the device, so a wipe after that listing
  leaves the sync convinced everything is still there — an empty device and a
  "0 synced" report.
- **A stored `remove-all` loads as `remove`, never as `delete-all`**
  (`parseExtraTrackPolicy()` in `sync/device-sync-preferences.ts`). The old
  option swept orphans and unlinked recorded auto-podcast/audiobook files; the
  new one erases folders. Nobody who ticked the old box inherits a wipe.

Related: **`remove` now sweeps every content type.** It used to visit only the
ones this sync had something to copy to (`willRunPodcast` was
`Object.keys(podcastLibraryTracks).length > 0`), so a device full of podcasts
survived "remove orphans" untouched whenever the selection had no podcasts —
silently. The sweep is gated on the policy being an explicit user choice so a
library that came back empty from a failed scan can never be read as "delete
everything".

Pinned in `src/__tests__/regressions/delete-all-path-guard.test.ts`,
`src/__tests__/behaviors/orphan-reset-policy.test.ts` and
`tests/e2e/orphan-reset-policy.test.ts`.

## Hazard: a sandboxed preload cannot `require` one of our own files

`BrowserWindow` runs with `sandbox: true`. A sandboxed preload's `require` is a
polyfill that resolves a short allowlist of Electron and Node built-ins and
**nothing else** — a relative import of our own source throws at load time.

So the moment `preload.ts` imported `src/shared/ipc-channels.ts` (which exists so
the channel allowlist has exactly one copy, shared with the web server's
`/api/invoke` gate), the preload died, `contextBridge.exposeInMainWorld` never
ran, and `window.api` was undefined in every renderer. The visible symptom names
neither the preload nor the import: the renderer's bootstrap falls through to
`isWebMode()`, tries the HTTP transport against a `file://` origin, and the
window renders **"iPodRocks could not start — Failed to fetch"**. Every UI e2e
test failed at once; `smoke.test.ts` did not, which is worth knowing.

- **`scripts/bundle-preload.js` (esbuild) produces what Electron loads.** It runs
  after `tsc` in `build` and in parallel with it under `dev:main`.
- **It emits `preload.bundle.js`, not `preload.js`.** `tsc` also emits a
  `preload.js` from the same source; two tools writing one path makes the winner
  depend on their order, which under `--watch` is a coin flip. The separate name
  keeps tsc typechecking the file — its output is simply unused — and leaves one
  writer for the file `src/main/index.ts` points at.
- **`electron` stays `external`**; that one the sandbox polyfill does resolve.
- Anything else the preload ever imports is inlined for free. Do not "simplify"
  this back to a plain `tsc` output, and do not fix a future version of this
  failure by relaxing `sandbox`.

## Hazard: `playwright.config.ts` is re-imported inside every worker

The `web` Playwright project boots the real daemon against a scratch
`IPODROCKS_DATA_DIR`, which the config wipes so each run starts from an
unclaimed server. Playwright re-imports the config module **in every worker
process**, so an unguarded `fs.rmSync` there deletes the data directory out from
under the running daemon mid-run. It surfaced as `SqliteError: unable to open
database file` thrown from the test harness — nowhere near its cause.

The wipe is guarded on `process.env.TEST_WORKER_INDEX === undefined`, which is
set only in workers. Any other one-time side effect added to that file needs the
same guard, or a `globalSetup`.

## The web server (`src/server/`)

Phase 2 of the web-server plan. The server owns no application logic: it looks
handlers up in `host/bridge.ts`, the same registry `attachElectronTransport()`
attaches to, so the desktop window and a remote browser run against one set of
handlers and one database. Adding an IPC domain gives the web the same channels
for free — provided its prefix is in `src/shared/ipc-channels.ts`.

- **`ALLOWED_CHANNEL_PREFIXES` is shared by the preload and `/api/invoke`.** One
  list, in `src/shared/`, because a second copy drifts the first time a domain is
  added and the symptom is "works on the desktop, 403s over the web".
- **`PUSH_CHANNELS` is a closed set**, unlike Electron IPC where `ipcRenderer.on`
  accepts anything. A server fans frames out to *sessions*, so a client must not
  be able to name a channel and receive another user's frames.
- **OAuth identifies; `authorizeIdentity()` admits.** A successful Google login
  is not authorization — the allowlist is, and the first identity binds against a
  one-time claim token printed to the server log. Identities are matched on the
  provider's `subject`, never the email, which users can change. Pinned in
  `src/__tests__/regressions/web-identity-allowlist.test.ts`.
- **The session cookie is `SameSite=Lax`, not `Strict`.** Strict withholds the
  cookie on the cross-site navigation the provider performs on its way back to
  `/api/auth/<provider>/callback`, so every social login fails.
- **`trust proxy` is set only to configured addresses.** Left at `true`, a direct
  client forges `X-Forwarded-For` and walks past the rate limiter, which keys on
  `req.ip`. The limiter's two buckets have different ceilings on purpose: ten per
  account, sixty per address, because everyone in a household shares an address
  and behind an unconfigured proxy *every* request does.
- **An absent `Origin` on the WebSocket upgrade is refused**, not read as
  same-origin. Browsers always send one; accepting its absence is the usual way
  CSWSH protection is lost.
- **Media URLs are HMAC-signed tokens, checked *and* re-validated against
  `isServableMediaPath()`** — the same function the `media://` handler calls. The
  signature stops a forged URL; the path check stops a genuine token from ever
  having been mintable for something that is not media. A token minted for a
  session is honoured only for that session, because `getPlayerTempDir()` is one
  directory for the whole server.
- **`player-source.ts` keys in-flight transcodes by session.** They were two
  module-level variables: correct for one window, and "the second person to press
  play kills the first person's ffmpeg" for a server.
- **The served `index.html` gets the CSP as a header and a `<base href="/">`.**
  The baked-in `<meta>` policy names the `media:` scheme and has no
  `connect-src`, so it cannot be reused; and Vite's `base: "./"` (which the
  desktop `file://` load needs) makes every asset reference relative, which the
  SPA fallback would break on any path but `/`.
- **The Node host's `userData()` creates its directory.** Electron's
  `app.getPath("userData")` does, and `database.ts` and `prefs.ts` have always
  relied on it; without it a daemon pointed at a fresh `IPODROCKS_DATA_DIR` died
  in `registerIpcHandlers()`.
- **`pickFolder()` gains a fallback at the api layer, not in the panels.** On a
  host with no native dialogs it opens `ServerFolderPicker`, which browses the
  *server's* filesystem through `app:listDirectory` (gated by the same
  `validateFolderPath()` as `library:addFolder`). The three existing call sites
  are unchanged — that is the test. It is **not** the device picker, which is the
  browser's own `showDirectoryPicker()` in Phase 4 and answers the opposite
  question.
- Deployment shape (port, bind, public URL, proxies, TLS) lives in prefs so the
  Settings card can write it. **Third-party OAuth client secrets are
  environment-only**, deliberately: they do not belong in a file the app
  rewrites, and an `_enc*` blob written by Electron's `safeStorage` is
  unreadable to the daemon anyway.

E2E lives in `tests/e2e/web-{auth,parity,media}.test.ts`, run by the `web`
Playwright project (the `electron` project is unchanged and still launches the
app per test). The web project needs a Chromium download — `npx playwright
install chromium` — which the Electron-only suite never did.

## Hazard: the host adapter must never auto-detect its way to the real user data

`src/main/host/` is the electron-free boundary: `app.getPath`, `safeStorage`,
`shell`, `dialog` and `ipcMain` are all reached through a registered
`HostAdapter` so the same `src/main/` code can run under Electron or as the
headless web server. Only `host/electron-host.ts` and `host/electron-bridge.ts`
import `electron`, and only `src/main/index.ts` imports those.

`getHost()` falls back to `detectHost()` when nothing registered one, and
`detectHost()` probes with a **CommonJS `require("electron")`**. It has to —
a static `import` would make the daemon's bundle unloadable under plain Node,
where the `electron` package is a path string at best and absent at worst.

**But vitest's `vi.mock("electron")` cannot intercept a `require`.** So under
test the probe fails, the Node host is selected, and its `userData()` resolves
the *real* application-support directory. This shipped for exactly one test run
and wrote 9 devices, 46 library folders and 96 tracks into the developer's own
`ipodrock.db` — silently, since every insert succeeded. It surfaced only when a
later test reported that its fixture device already existed.

Three guards, and all three must stay:

- **`src/__tests__/setup.ts` sets `IPODROCKS_DATA_DIR` to a fresh temp dir** for
  the whole run, before any test module loads.
- **`detectHost()` throws under `VITEST` when `IPODROCKS_DATA_DIR` is unset**
  rather than falling back. Loud beats silent: the fallback's failure mode is
  data loss in a directory no test ever intended to touch.
- **`harness/ipc-harness.ts` registers a host of its own** in `setupIpcSession`,
  on the module graph `vi.resetModules()` just built and *before* importing
  `src/main/ipc` — the database path is read the first time a handler touches
  the library. Its paths mirror the `app.getPath` mock (`${appPathRoot}/${name}`).

Anything that adds a new host facility inherits this: give the Node
implementation a real directory only via `IPODROCKS_DATA_DIR`, never a
hardcoded home-relative default reachable without it. Pinned in
`src/__tests__/regressions/host-adapter.test.ts`.

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

