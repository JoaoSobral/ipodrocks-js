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
| Efficiency | `playback-log-ingest.ts:90` | Full library aggregation on every ingest — should be incremental |
| GitHub Actions | `.github/dependabot.yml` | `package-ecosystem: ""` — Dependabot is disabled |
| GitHub Actions | All workflows | Actions pinned to floating `@vN` tags instead of commit SHAs |

### From the PR #116 review (2026-08-22)

| Area | File | Issue |
|---|---|---|
| Blocking I/O | `library/shadow-library.ts` — `pruneOrphanedFiles()` | Recursive `readdirSync`/`statSync`/`unlinkSync` over the whole shadow tree runs on the main process. A large shadow library freezes the UI for the duration; the "Pruning…" spinner cannot even animate. Move to `fs/promises` and yield. |
| Data loss | `library/shadow-prune.ts` — `decidePrune()` | A non-audio file is deleted whenever its directory holds no *claimed* audio. Nothing checks that the shadow root is a tree the app created, so a shadow library pointed at a folder that also holds unrelated data will have that data deleted. Consider refusing a root whose top level contains no `shadow_tracks`-claimed file. |
| Altitude | `sync/sync-core.ts` | `analyzeContentType()` (13 params), `copyAlbumArtworkToDevice()` (11) and `copyMissingTracks()` (10) grew another trailing positional flag for `albumGrouping`, on top of `preserveFolderStructure`. Call sites are now walls of `undefined`. Convert the tail to a single options object. |
| Robustness | `devices/devices-core.ts` — `updateDevice()` | `{ usbSerial: "X" }` with no vendor/product silently clears all three USB columns, while `createDevice` throws for the same partial input. Make the update path throw too. Also: the `usb_*` entries added to `FIELD_MAP`/`ALLOWED_UPDATE_FIELDS` are dead — the generic loop `continue`s past those keys. |
| Dead param | `devices/usb-devices.ts` — `refreshUsbSnapshot(force)` | No caller passes `force`, and when one does an in-flight non-forced enumeration is returned instead of a fresh one. Drop the parameter or make it bypass `inFlight`. |

> Note: `src/main/ipc.ts` was split into per-domain modules under `src/main/ipc/` (one `registerXHandlers()` per channel prefix, shared helpers in `ipc/common.ts`). Add new handlers to the matching domain module.

## Hazard: `foreign_keys = OFF` during track deletion

`LibraryScanner.deleteRemovedTracks()` (`src/main/library/library-scanner.ts`) wraps its deletes in `PRAGMA foreign_keys = OFF`, so **no `ON DELETE CASCADE` declared in the schema fires there**. Every dependent table must be deleted by hand inside that transaction (`playback_logs`, `playback_stats`, `shadow_tracks`, `content_hashes`, `playlist_items`). The same applies to `cleanupOrphanedEntities()` in the same file.

**Deleting the row is not always enough.** `shadow_tracks.shadow_path` is the only record of where a transcode lives on disk, so it must be *captured before* the row is deleted — `deleteRemovedTracks()` returns it as `removedShadowPaths` and the scan hands it to `ShadowLibraryManager.deleteOrphanedShadowFiles()`. Deleting the row first is what let renamed album folders leave their old transcodes behind forever. Any dependent table that points at a file on disk needs the same treatment.

This has already caused three shipped bugs — orphaned `codec_configurations` (issue #105), orphaned `playlist_items` (playlists holding deleted songs), and orphaned shadow transcodes (shadow libraries accumulating a copy of every renamed album). **When adding a table that references `tracks(id)`, add its delete to `deleteRemovedTracks()` too**, and cover it with a regression test that deletes with FKs off (see `src/__tests__/regressions/playlist-reconcile.test.ts`).

