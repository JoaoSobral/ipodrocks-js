# Smart Playlists

Smart playlists are rule-based: you define filters (genre, artist, album) and a track limit.

## What it does

- **Rules** — Filter by genre, artist, or album. You can pick multiple values (e.g. Rock + Jazz).
- **Track limit** — Cap the number of tracks (e.g. 50) or allow all matching.
- **Create** — Build the playlist from the current library. Results are deterministic based on rules.

## How it works

Smart playlists use the same rule engine as sync custom selection. Rules are stored as JSON. When you create or update a Smart playlist, the app queries the database for tracks matching the rules, applies the limit, and saves the track list.

## How to work with it

1. Choose **By genre**, **By artist**, or **By album**.
2. Pick one or more values from the dropdown (loaded from your library).
3. Set the track limit or check "No limit".
4. Click **Create** and give the playlist a name.
5. The playlist appears in the All tab. Re-create it to refresh when your library changes (Smart playlists are not live-updating).
