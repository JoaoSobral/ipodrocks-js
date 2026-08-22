# Genius Playlists

Genius playlists are built from the play history Rockbox records on your device. They help you rediscover music, find forgotten gems, or replay your most-listened tracks.

## What it does

- **Load from database** — Use play history already imported (from a previous device check or sync).
- **Import Runtime Data** — Read the counters straight off the selected device to refresh history.
- **Analysis summary** — Shows total plays, matched plays, and a brief summary of your listening.
- **Genius types** — Top Rated, Hidden Gems, Most Played, Favorites, Never Finished, Forgotten Favorites, Recently Discovered, Top Artist, Top Album, Top Genre, Deep Dive, and Finish the Album. Each has different rules (rating, play count, average completion, play order).
- **Configure** — Set track limit, minimum plays, or artist pick, depending on the type.
- **Generate** — Build the playlist and preview before saving.
- **Save** — Save as a playlist with a name.

## How it works

- **Runtime data** — With **Gather Runtime Data** enabled, Rockbox records how many times you played each track, how long you spent on it, the order plays happened in, and your rating. iPodRocks imports those counters and matches them to library tracks by their path on the device.
- **Genius types** — Each type uses different filters (play count, average completion, rating, play order) to select tracks.
- **Database** — History is stored locally, so you can generate Genius playlists without the device connected (after at least one import).

> **Enable Gather Runtime Data on the device:** Genius needs Rockbox to record what you play. On the device, go to **Settings → Playback Settings → Gather Runtime Data**. Without it, Rockbox records nothing and Genius has no data to work with.
>
> iPodRocks no longer uses Rockbox's **Playback Logging** feature. You do not need to enable it, and enabling both gains you nothing.

## What runtime data can and cannot tell you

Rockbox's counters are totals, not a diary. Two consequences are worth knowing:

- **No dates or times.** Rockbox records a play-order number, not a timestamp, so there is no "played late at night" playlist — that information does not exist in the data. iPodRocks fills the gap where it honestly can: when an import sees a play count go up, it notes the date *it observed that*, which is what the Dashboard's **This Year** and **This Month** views count. Those views therefore cover the period since iPodRocks started watching, not your whole history. **All Time** always shows everything.
- **A play only counts after 15 seconds.** Skip a track sooner and Rockbox does not record it at all. That is why there is no skip list: a track you always skip is indistinguishable from one you have never played. **Never Finished** covers what remains visible — tracks you start often and rarely reach the end of.

## How to work with it

1. On the device, turn on **Settings → Playback Settings → Gather Runtime Data**, then play some music.
2. **Add a device** in Devices, leaving "Do not import play history from this device" unchecked.
3. **Load from database** if you have already synced or checked the device. Otherwise select the device and click **Import Runtime Data**.
4. Wait for the analysis to finish. Check the summary.
5. Pick a **Genius type** and configure options (track limit, min plays, etc.).
6. **Generate** and preview. Adjust config and regenerate if needed.
7. **Save** with a name. The playlist appears in the All tab.
