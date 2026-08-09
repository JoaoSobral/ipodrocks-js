# All Playlists

The All tab shows every playlist in your library and lets you manage them.

## What it does

- **List** — All playlists with name, track count, and type (Classic, Smart, Genius, Savant).
- **Select** — Click **View** on a playlist to see its tracks.
- **Create** — Button to create a new Classic, Smart, Genius, or Savant playlist (opens the create flow).
- **Edit** — Classic playlists get an **Edit tracks** button in their detail view. Other types can't be edited.
- **Delete** — Remove a playlist (tracks stay in the library).
- **Export** — Export as M3U8 for use in other players.

## How it works

Playlists are stored in the database. Each playlist has a type (classic, smart, genius, savant) and an ordered list of track IDs. Smart playlists also store their rules and track limit, Genius stores its config, and Savant stores the AI config. Classic playlists store nothing but the songs you picked. Export writes a standard M3U8 file with paths.

Playlist names carry a type prefix in storage (`classic_`, `smart_`, `genius_`, `savant_`), which is why you see it in the list.

## How to work with it

1. Use **Create** to add a Classic playlist (pick songs yourself), a Smart playlist (rules), or a Genius playlist (from device history).
2. Savant playlists are created from the Savant tab, then appear here.
3. **Export** when you need a playlist file for a player that does not use iPodRocks.
4. **Delete** only removes the playlist; it does not delete files from the library or device.

Playlists clean themselves up when your library changes — see [Playlists — Overview](./playlists.md#playlists-stay-in-sync-with-your-library).
