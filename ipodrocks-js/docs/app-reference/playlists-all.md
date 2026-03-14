# All Playlists

The All tab shows every playlist in your library and lets you manage them.

## What it does

- **List** — All playlists with name, track count, and type (Smart, Genius, Savant, Custom).
- **Select** — Click a playlist to see its tracks in the right panel.
- **Create** — Button to create a new Smart or Genius playlist (opens the create flow).
- **Delete** — Remove a playlist (tracks stay in the library).
- **Export** — Export as M3U8 for use in other players.

## How it works

Playlists are stored in the database. Each playlist has a type (smart, genius, savant, custom) and a list of track IDs. Smart and Genius playlists also store rules or config; Savant playlists store the AI config. Export writes a standard M3U8 file with paths.

## How to work with it

1. Use **Create** to add a Smart playlist (rules) or Genius playlist (from device history).
2. Savant playlists are created from the Savant tab, then appear here.
3. **Export** when you need a playlist file for a player that does not use iPodRocks.
4. **Delete** only removes the playlist; it does not delete files from the library or device.
