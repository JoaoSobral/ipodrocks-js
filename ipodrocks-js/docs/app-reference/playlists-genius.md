# Genius Playlists

Genius playlists are built from your Rockbox playback history. They help you rediscover music, find forgotten gems, or replay your most-listened tracks.

## What it does

- **Load from database** — Use playback history already stored (from a previous device check or sync).
- **Recheck device** — Read `playback.log` from the selected device to refresh history.
- **Analysis summary** — Shows total plays, matched plays, and a brief summary of your listening.
- **Genius types** — Top Rated, Hidden Gems, Most Played, Favorites, Skip List, Recently Discovered, Top Artist, Top Album, Top Genre, Deep Dive, Finish the Album, and Late Night. Each has different rules (rating, play count, completion rate, time of day).
- **Configure** — Set track limit, minimum plays, or artist pick, depending on the type.
- **Generate** — Build the playlist and preview before saving.
- **Save** — Save as a playlist with a name.

## How it works

- **Playback log** — Rockbox writes `playback.log` when you play tracks. iPodRocks reads it and matches entries to library tracks by path.
- **Genius types** — Each type uses different filters (play count, last played, artist, etc.) to select tracks.
- **Database** — History is stored so you can generate Genius playlists without the device connected (after at least one load/recheck).

> **Enable playback logging on the device:** Genius needs Rockbox to log what you play. On the device, go to **Settings → Playback Settings → Logging → Yes**. A reboot is required for the change to take effect. Without this, `playback.log` will not exist on the device and Genius will have no data to work with.

## How to work with it

1. **Add a device** and enable playback log in Devices.
2. **Load from database** if you have already synced or checked the device. Otherwise, select the device and click **Recheck device for playback.log**.
3. Wait for the analysis to finish. Check the summary.
4. Pick a **Genius type** and configure options (track limit, min plays, etc.).
5. **Generate** and preview. Adjust config and regenerate if needed.
6. **Save** with a name. The playlist appears in the All tab.
