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

- During sync, smart playlists are written to `<device>/.rockbox/tagnavi_custom.config` as tagnavi entries that auto-update against the device's tag database.
- Smart-playlist `.m3u` files are no longer written to the device's Playlists folder; any leftover ones from prior syncs are cleaned up under the configured Orphan Policy.
- Other playlist kinds (custom, Genius, Savant) still write `.m3u`.
- Inside Rockbox, the entries appear under **Database → Custom → iPodRocks Smart**.
- For the entries to resolve, the device's tagcache must be initialized (Database → Initialize Now in Rockbox once after enabling).

Only `artist`, `album`, and `genre` rules translate cleanly. Multiple values for the same rule type are OR'd; different rule types are AND'd, mirroring the desktop behaviour.

## How to work with it

1. Choose **By genre**, **By artist**, or **By album**.
2. Pick one or more values from the dropdown (loaded from your library).
3. Set the track limit or check "No limit".
4. Click **Create** and give the playlist a name.
5. The playlist appears in the All tab. Re-create it to refresh when your library changes (Smart playlists are not live-updating).
