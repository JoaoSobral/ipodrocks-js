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

When a sync starts, iPodRocks reads the ratings out of Rockbox's own database on the device (`.rockbox/database_idx.tcd`, joined to `database_4.tcd` for the filenames) and compares every device rating against the last known baseline using a **3-way merge**:

| Situation | Outcome |
|---|---|
| Device has a new rating, library has none | Device rating is adopted into the library |
| Device reads 0 (Rockbox's "unrated" — it has no null) | No opinion: never adopted, never a conflict |
| Only the library changed since last sync | Library rating will be pushed to device (Phase 3) |
| Both sides changed to the same value | Silently converged — no conflict |
| Both sides changed but differ by ≤ 1 unit | Half-step tolerance — higher value wins, no conflict |
| Both sides changed significantly | A **conflict** is recorded for manual resolution |

### Phase 2 — File sync

Normal file copy / transcode / remove step (unchanged).

### Phase 3 — Propagate (library → device)

After file sync, iPodRocks writes each canonical library rating straight into the record Rockbox reads, exactly as Rockbox writes it itself — the single 32-bit value in `database_idx.tcd`, with the record flagged so the value survives a database rebuild. The index is backed up once per run before the first write. Tracks with unresolved conflicts are excluded, as are tracks whose value the device already holds.

> **Restart Rockbox** for written ratings to show on screen. The values are already saved; the running database is just holding the old ones in memory.

Two cases the sync log calls out, both of them normal:

- **"N rating(s) are waiting for the device's database."** Rockbox only knows about a file once its database has been updated, so an album copied during *this* sync has no record to write a rating into. On the player, run **Database → Update now** (or restart it with Auto Update on) and sync again — the ratings are sent then.
- **"Could not write N rating(s)."** The device's database is missing, or Rockbox was updating it while the sync ran. Nothing is recorded as sent, so the next sync retries.

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
