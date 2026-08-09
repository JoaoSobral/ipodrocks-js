# Playlists — Overview

The Playlists panel has five tabs: **All**, **Classic**, **Smart**, **Genius**, and **Savant**. Each serves a different purpose.

## What each tab does

| Tab | Purpose | Syncs as |
|-----|---------|----------|
| **All** | View, create, delete, and export all playlists. See tracks in any playlist. | — |
| **Classic** | Hand-pick the songs yourself, in the order you want them. Up to 500 songs. | `.m3u` |
| **Smart** | Create rule-based playlists (genre, artist, album) with a track limit. | `.m3u` or tagnavi¹ |
| **Genius** | Create playlists from Rockbox playback history (Most Played, Hidden Gems, Top Genre, etc.). | `.m3u` |
| **Savant** | AI-generated playlists from mood. Requires OpenRouter API key. Uses harmonic data when available. | `.m3u` |

¹ Smart playlists write as live tagnavi queries when **Rockbox smart playlists (tagnavi)** is enabled on the device profile. Classic, Genius, and Savant are always `.m3u` because they are static track selections — see [why](./playlists-smart.md#why-only-smart-playlists-become-tagnavi).

## When to use which

- **Classic** — When you know exactly which songs you want. See [Classic Playlists](./playlists-classic.md).
- **Smart** — When you want a fixed set of rules (e.g. "Rock genre, 50 tracks").
- **Genius** — When you want playlists based on what you actually listen to. Connect a device, load/recheck playback log, then generate.
- **Savant** — When you want a playlist that matches a mood or intent ("chill evening", "workout mix"). The AI picks tracks and can order them harmonically.

## Playlists stay in sync with your library

You never have to clean up after deleting music. **After every library scan — and after removing a library folder — every playlist is reconciled automatically:**

- Songs whose files no longer exist are removed from every playlist, and the remaining track numbers are closed up.
- **Smart** playlists are re-resolved from their rules, so they also pick up newly scanned tracks that match. Their saved track limit is preserved.
- **Classic**, **Genius**, and **Savant** playlists are pruned only. Their contents were hand-picked or generated from a snapshot, so there is nothing to recompute — adding songs back is up to you.

The scan summary tells you what changed ("Playlists updated automatically — removed 3 missing songs from 2 playlists"). If the library scan finds no tracks at all — usually a failed scan or an unplugged drive — reconciliation is skipped rather than emptying every playlist.

The manual **Repair** button is still there for anything that goes wrong outside a scan.

## How to work with it

1. Start with **All** to see existing playlists and create new ones.
2. For **Classic**, just pick your songs — no setup needed beyond a scanned library.
3. For **Genius**, add a device and enable playback log. Load from database or recheck the device before generating.
4. For **Savant**, add your OpenRouter API key in Settings first. Enable harmonic extraction in Library for better key-aware mixing.

## Rocksy

[Rocksy](./assistant.md) can create and triage playlists from the chat:

- "Make me a playlist with Song A, Song B and Song C" → `library_search_tracks` then `playlist_create_classic`
- "Add Song D to my Road Trip playlist" → `playlist_update_classic` *(asks you to confirm first)*
- "Make a Smart playlist of my 4-star Rock tracks" → `playlist_create_smart`
- "Build a Genius playlist from my most played, 25 tracks" → `playlist_create_genius`
- "Which playlists have missing songs?" → `playlist_list_broken`
- "Repair that playlist" → `playlist_repair`
- "Delete the Workout playlist" → `playlist_delete` *(asks you to confirm first)*

Creation and repair run immediately; deleting a playlist and editing a Classic playlist's tracks pause for a **Confirm / Cancel** prompt — editing replaces the whole track list, so it gets the same gate as a delete. Rocksy creates playlists through the same backend as the Playlists panel (the legacy `<SMART_PLAYLIST>` / `<GENIUS_PLAYLIST>` tags remain as a fallback). Savant playlists are not created via Rocksy — use the Savant tab.
