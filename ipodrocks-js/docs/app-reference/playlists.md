# Playlists — Overview

The Playlists panel has four tabs: **All**, **Smart**, **Genius**, and **Savant**. Each serves a different purpose.

## What each tab does

| Tab | Purpose |
|-----|---------|
| **All** | View, create, delete, and export all playlists. See tracks in any playlist. |
| **Smart** | Create rule-based playlists (genre, artist, album) with a track limit. |
| **Genius** | Create playlists from Rockbox playback history (Rediscovery, Forgotten Gems, Most Played, etc.). |
| **Savant** | AI-generated playlists from mood. Requires OpenRouter API key. Uses harmonic data when available. |

## When to use which

- **Smart** — When you want a fixed set of rules (e.g. "Rock genre, 50 tracks").
- **Genius** — When you want playlists based on what you actually listen to. Connect a device, load/recheck playback log, then generate.
- **Savant** — When you want a playlist that matches a mood or intent ("chill evening", "workout mix"). The AI picks tracks and can order them harmonically.

## How to work with it

1. Start with **All** to see existing playlists and create new ones (Smart or Genius from the Create button).
2. For **Genius**, add a device and enable playback log. Load from database or recheck the device before generating.
3. For **Savant**, add your OpenRouter API key in Settings first. Enable harmonic extraction in Library for better key-aware mixing.
