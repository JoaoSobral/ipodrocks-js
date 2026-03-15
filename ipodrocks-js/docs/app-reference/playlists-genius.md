# Genius Playlists

Genius playlists are built from your Rockbox playback history. They help you rediscover music, find forgotten gems, or replay your most-listened tracks.

## What it does

- **Load from database** — Use playback history already stored (from a previous device check or sync).
- **Recheck device** — Read `playback.log` from the selected device to refresh history.
- **Analysis summary** — Shows total plays, matched plays, and a brief summary of your listening.
- **Genius types** — Most Played, Favorites, Skip List, Top Artist, Top Album, Late Night, Recently Discovered, Deep Dive, Oldies, Nostalgia, Recent Favorites, Time Capsule, Golden Era. Each has different rules (play count, completion rate, date range, etc.). Some types (e.g. Oldies, Nostalgia) require enough playback history (12+ or 36+ months).
- **Configure** — Set track limit, minimum plays, artist pick, date range, etc. depending on the type.
- **Generate** — Build the playlist and preview before saving.
- **Save** — Save as a playlist with a name.

## How it works

- **Playback log** — Rockbox writes `playback.log` when you play tracks. iPodRocks reads it and matches entries to library tracks by path.
- **Genius types** — Each type uses different filters (play count, last played, artist, etc.) to select tracks.
- **Database** — History is stored so you can generate Genius playlists without the device connected (after at least one load/recheck).

## How to work with it

1. **Add a device** and enable playback log in Devices.
2. **Load from database** if you have already synced or checked the device. Otherwise, select the device and click **Recheck device for playback.log**.
3. Wait for the analysis to finish. Check the summary.
4. Pick a **Genius type** and configure options (track limit, min plays, etc.).
5. **Generate** and preview. Adjust config and regenerate if needed.
6. **Save** with a name. The playlist appears in the All tab.
