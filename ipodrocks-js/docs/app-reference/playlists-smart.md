# Smart Playlists

Smart playlists are rule-based: you define filters (genre, artist, album) and a track limit.

## What it does

- **Rules** — Filter by genre, artist, or album. You can pick multiple values (e.g. Rock + Jazz).
- **Track limit** — Cap the number of tracks (e.g. 50) or allow all matching.
- **Create** — Build the playlist from the current library. Results are deterministic based on rules.

## How it works

Smart playlists use the same rule engine as sync custom selection. Rules are stored as JSON. When you create or update a Smart playlist, the app queries the database for tracks matching the rules, applies the limit, and saves the track list.

## Rockbox dynamic mode (per-device opt-in)

If your device runs Rockbox firmware, you can configure it to receive smart playlists as a live tag-tree view instead of static `.m3u` snapshots. Enable **"Rockbox smart playlists (tagnavi)"** on the device profile (Devices → Edit). When this is on:

- During sync, smart playlists are written to `<device>/.rockbox/tagnavi_user.config` as tagnavi query entries that are evaluated live against the device's tag database.
- Smart-playlist `.m3u` files are no longer written to the device's Playlists folder; any leftover ones from prior syncs are cleaned up under the configured Orphan Policy.
- Other playlist kinds (Custom, Genius, Savant) still write `.m3u` — see below for why.
- Inside Rockbox, the entries appear under **Database → Custom menu → iPodRocks Smart**.
- For the entries to resolve, the device's tagcache must be initialized (**Database → Initialize Now** in Rockbox, once after first enabling).

Only `artist`, `album`, and `genre` rules translate cleanly. Multiple values for the same rule type are OR'd; different rule types are AND'd, mirroring the desktop behaviour.

### Why only Smart playlists become tagnavi

Tagnavi entries are **live database queries**, not file lists. A Smart playlist rule like "genre = Rock, limit 50" translates directly to a tagnavi expression that Rockbox evaluates against its tag database every time you open it — so if you add new Rock tracks to the device, the playlist updates automatically.

Genius, Savant, and Custom playlists are **static track selections** made at a point in time. Genius picks tracks based on play history and scoring; Savant uses AI and harmonic sequencing; Custom is hand-curated. None of these have a metadata expression that could reproduce the original selection on the device. The right format for a static track list is `.m3u`, which is an exact record of which files belong. Embedding a 50-track file list inside a tagnavi config line would be strictly worse — same data, harder to read, breaks if any path changes.

## How to work with it

1. Choose **By genre**, **By artist**, or **By album**.
2. Pick one or more values from the dropdown (loaded from your library).
3. Set the track limit or check "No limit".
4. Click **Create** and give the playlist a name.
5. The playlist appears in the All tab. Re-create it to refresh when your library changes (Smart playlists are not live-updating).
