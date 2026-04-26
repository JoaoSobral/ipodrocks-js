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
