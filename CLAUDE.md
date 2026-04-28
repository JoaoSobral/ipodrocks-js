# iPodRocks — Claude Notes

## Testing Policy

Every time a feature or functionality is added or changed, the corresponding tests **must** be created or updated in the same change. No feature work ships without test coverage for the new/modified behavior.

## Known Technical Debt (from simplify/security review, 2026-04-21)

These are confirmed reuse/efficiency issues found during `src/main/` review. Address in a dedicated refactor pass.

| Area | File | Issue |
|---|---|---|
| Reuse | `ipc.ts` | `remapForCheck()` / `remapTracks()` are identical — extract one helper |
| Reuse | `ipc.ts` | Device track map building (music/podcast/audiobook) repeated 3× |
| Reuse | `ipc.ts` / `library-core.ts` | `get-or-create` pattern for artist/album/genre duplicated |
| Reuse | `database.ts` + `library-scanner.ts` | Track deduplication logic lives in both |
| Efficiency | `library-scanner.ts:641` | `INSERT OR IGNORE` then `SELECT` — reverse to `SELECT` first |
| Efficiency | `metadata-extractor.ts:141` | `parseFile()` called twice per track |
| Efficiency | `playback-log-ingest.ts:90` | Full library aggregation on every ingest — should be incremental |
| GitHub Actions | `.github/dependabot.yml` | `package-ecosystem: ""` — Dependabot is disabled |
| GitHub Actions | All workflows | Actions pinned to floating `@vN` tags instead of commit SHAs |

## Additional Tech Debt (from PR 62 simplify review, 2026-04-28)

Items surfaced during the PR 62 review that need broader refactoring than fits the PR's scope.

| Area | File | Issue |
|---|---|---|
| Reuse | `player-source.ts` + `library-scanner.ts` + `devices/device.ts` | `AUDIO_EXTENSIONS` set duplicated 3×; extract a shared constant |
| Reuse | `player-store.ts` + `theme-store.ts` | Both stores reimplement `safeLocalStorage()`; extract `renderer/utils/storage.ts` |
| Reuse | `player-store.ts` | `playTrack()` and `retryAsTranscode()` share the same prepare/set/error logic — extract a `runPrepare(track, queue, force)` helper |
| Efficiency | `assistantChat.ts:650` | `APP_DOCS` (~13 KB) is concatenated mid-prompt every turn; move static text to its own leading system message so prompt caching can hit |
| Efficiency | `LibraryPanel.tsx:736` | `onDoubleClick` passes the entire `filtered` array as the queue — store track IDs (or a bounded window) instead of full track objects |
| Efficiency | `SyncPanel.tsx:312-351` | Effect fires 9 sequential `setState` calls on every device switch; consolidate into one `useReducer` update |
| Efficiency | `PlayerBar.tsx` `onTimeUpdate` | Store update fires ~4×/sec unconditionally; gate with a 0.25s threshold so the seek-sync effect doesn't re-run every tick |
| Efficiency | `player-source.ts` `cleanupPlayerTemp` | Only runs on `before-quit`; long-running sessions can leak temp files if renderer crashes mid-prepare |
| Quality | `ProgressBar.tsx:14-32` | `?? VARIANT_COLORS.default` fallback is unreachable given the `variant` union — drop the fallback or drop the `Record<string, …>` typing |
