# Ratings

iPodRocks syncs star ratings between your library and your Rockbox device in both directions. Ratings you set on the device appear in the library, and ratings you set in the library are written back to the device on the next sync.

## How ratings work

Ratings use the **Rockbox 0–10 scale** internally and are displayed as **0–5 stars** with half-star precision in the UI.

| Stars | Rockbox value |
|---|---|
| ★★★★★ (5) | 10 |
| ★★★★½ (4.5) | 9 |
| ★★★★ (4) | 8 |
| … | … |
| ☆ (0 / unrated) | `NULL` |

## Setting a rating in the library

Open the **Library** panel. The **Rating** column shows stars for every track.

- **Click** a star to set a whole-star rating.
- **Shift-click** a star to set a half-star rating.
- **Click the currently filled star** to clear the rating (set to unrated).

Changes are saved immediately and will be written to the device during the next sync.

## Rating sync with your device

Ratings are synced in two phases that run automatically as part of the normal sync flow.

### Phase 1 — Ingest (device → library)

When a sync starts, iPodRocks reads `database_changelog.txt` from the device mount and compares every device rating against the last known baseline using a **3-way merge**:

| Situation | Outcome |
|---|---|
| Device has a new rating, library has none | Device rating is adopted into the library |
| Only the library changed since last sync | Library rating will be pushed to device (Phase 3) |
| Both sides changed to the same value | Silently converged — no conflict |
| Both sides changed but differ by ≤ 1 unit | Half-step tolerance — higher value wins, no conflict |
| Both sides changed significantly | A **conflict** is recorded for manual resolution |

### Phase 2 — File sync

Normal file copy / transcode / remove step (unchanged).

### Phase 3 — Propagate (library → device)

After file sync, iPodRocks writes canonical library ratings back to `database_changelog.txt` on the device for any track where the library value differs from what was last pushed. Tracks with unresolved conflicts are excluded.

> **Device step required:** After sync completes, go to **Settings → General → Database → Initialize Now** on your iPod to apply the new ratings file.

## Resolving conflicts

When the 3-way merge cannot decide automatically, a conflict is recorded. The Library panel shows a warning banner:

> ⚠ N rating conflicts need resolution  **Resolve →**

Click **Resolve →** to open the conflict resolution panel. For each conflict you can see:

- The **track** and **artist** name
- The **device** that reported the change
- The **device rating** and the **library rating** side by side

Then choose one of three actions:

| Action | Effect |
|---|---|
| **Keep Library** | Discards the device's rating; library value becomes canonical |
| **Use Device** | Adopts the device's rating as the new canonical value |
| **Set Manually** | Opens a star picker so you can enter a third value |

Resolved conflicts no longer appear in the list. The banner disappears once all conflicts are cleared.

## Star badges in the track table

The **Rating** column in the Library panel may show small badges next to the stars:

| Badge | Meaning |
|---|---|
| `⊕` (blue) | This rating was last set by a device, not manually in the library |
| `●` (orange) | There is an unresolved conflict on this track |

## Database tables

The ratings system uses three tables in `library.db`:

| Table | Purpose |
|---|---|
| `tracks.rating` | Canonical 0–10 rating for each track |
| `device_track_ratings` | Per-device baseline — what was last seen and last pushed |
| `rating_conflicts` | Unresolved divergences awaiting user resolution |
| `rating_events` | Full audit log of every rating change (source, old value, new value) |
