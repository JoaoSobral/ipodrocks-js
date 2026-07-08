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
| Reuse | `database.ts` + `library-scanner.ts` | Track deduplication logic lives in both |
| Efficiency | `library-scanner.ts:641` | `INSERT OR IGNORE` then `SELECT` — reverse to `SELECT` first |
| Efficiency | `metadata-extractor.ts:141` | `parseFile()` called twice per track |
| Efficiency | `playback-log-ingest.ts:90` | Full library aggregation on every ingest — should be incremental |
| GitHub Actions | `.github/dependabot.yml` | `package-ecosystem: ""` — Dependabot is disabled |
| GitHub Actions | All workflows | Actions pinned to floating `@vN` tags instead of commit SHAs |
| Correctness | `music-metadata` (dep) | Pre-existing library bug: `parseFile()` throws a RangeError on SV8 Musepack files that carry an APEv2 tag (any header/footer form). `mpcenc` output is always SV8, so scanning/reading tags of iPodRocks-generated MPC files fails (extractor swallows it → filename-based defaults). Written tags are correct (ffmpeg reads them). Needs an upstream fix or a fallback reader (e.g. ffprobe) for MPC. Discovered fixing #91 (2026-07-09). |

> Note: `src/main/ipc.ts` was split into per-domain modules under `src/main/ipc/` (one `registerXHandlers()` per channel prefix, shared helpers in `ipc/common.ts`). Add new handlers to the matching domain module.

