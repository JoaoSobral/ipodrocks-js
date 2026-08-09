# Classic Playlists

Classic playlists are the straightforward kind: **you pick the songs**. No rules, no algorithm, no AI — just your library, a set of checkboxes, and a name.

## What it does

- **Hand-picked** — Tick the songs you want from your full music library.
- **Your order** — Songs play in the order you ticked them, not in artist/album order.
- **Up to 500 songs** — The counter shows how much room is left.
- **Editable** — Reopen the picker any time to add or remove songs. Classic is the only playlist type you can edit after creating it.

## How to work with it

1. Go to **Playlists → + Create Playlist → Classic**.
2. Give the playlist a name.
3. Find your songs and tick them:
   - **Search** by title, artist, or album. Matching is partial and case-insensitive, so `uror` finds "Aurora". Typing several words narrows further and each word can match a different field — `bowie heroes` finds the track even though no single field contains both.
   - **Filter** by artist, album, or genre with the dropdowns.
   - **Sort** by clicking any column heading.
   - **Select all shown** adds every currently visible song (up to the remaining room); **Clear** starts over.
4. Click **Create playlist**.

### Your selection survives filtering

This is the part that makes the picker useful. Searching or filtering only changes **which rows you can see** — it never unticks anything. So you can search "Bowie", tick three songs, clear the search, filter to the Jazz genre, tick four more, and end up with all seven. The counter at the bottom always shows your real total.

**Reset filters** clears the search box and all three dropdowns at once, without touching your selection.

### Editing an existing playlist

Open the playlist from the **All** or **Classic** tab, click **View**, then **Edit tracks**. The picker reopens with your current songs already ticked. Change what you like and click **Save changes**.

Editing **replaces** the whole track list with whatever is ticked when you save. Unticking a song removes it; there is no separate delete step.

## What it can and can't hold

- **Music only.** Podcasts and audiobooks aren't offered in the picker — they sync through their own panels, and mixing them into a music playlist produces `.m3u` paths a device won't resolve.
- **500 songs maximum.** At the cap, unticked rows grey out and the counter turns amber. Untick something to swap a different song in.
- Songs that disappear from your library are removed automatically — see below.

## Syncing to a device

Classic playlists sync as `.m3u` files into the device's Playlists folder, like Genius and Savant playlists. They are static track selections, so they never become live Rockbox tagnavi queries even when that option is enabled on the device — see [why](./playlists-smart.md#why-only-smart-playlists-become-tagnavi).

You can also export one to a file with **Export M3U** from the playlist's detail view.

## Keeping up with your library

If you delete a song's file, it is removed from your Classic playlists on the next library scan and the remaining track numbers close up. Nothing is added back automatically — a hand-picked playlist has no rules to re-derive it from, so what goes in is always your call. See [Playlists — Overview](./playlists.md#playlists-stay-in-sync-with-your-library).

## Rocksy

[Rocksy](./assistant.md) can build and edit Classic playlists for you:

- "Make me a playlist called Road Trip with Heroes, Starman and Life on Mars" → finds each track, then `playlist_create_classic`
- "Add Ashes to Ashes to Road Trip" → `playlist_update_classic` *(asks you to confirm first)*
- "Rename Road Trip to Long Drive" → `playlist_update_classic`

Editing asks for confirmation because it replaces the entire track list — the same gate a delete gets. Rocksy resolves song titles to tracks first, so tell it the names and it will do the lookup.
