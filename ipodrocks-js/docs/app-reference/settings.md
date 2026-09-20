# Settings — Overview

Settings is a modal opened from the gear icon (top right). It has sections for **OpenRouter API**, **Harmonic Analysis**, **Ratings**, **Auto Podcasts** and **Web Server**.

## What it does

- **OpenRouter API** — API key and model for Savant playlists and Rocksy. Test connection before saving.
- **Harmonic Analysis** — Key/BPM extraction on scan, Essentia analysis, backfill percentage. Affects Library and Savant.
- **Ratings** — "Library tags always win", which makes a scan take each track's rating from the file's own tag. See [Ratings](/app-reference/ratings).
- **Auto Podcasts** — Podcast Index API credentials, auto-refresh and the download folder. See [Auto Podcasts](/app-reference/autopodcasts).
- **Web Server** — Serve iPodRocks to a browser, so your library can live on one machine and your player be plugged into another. See [Web Server](/app-reference/settings-web-server).

## How to work with it

1. Click the **gear icon** in the top-right of the app to open Settings.
2. Configure **OpenRouter** if you use Savant or Rocksy.
3. Configure **Harmonic Analysis** if you want key-aware mixing and Savant harmonic ordering.
4. Click **Save** to apply. **Cancel** discards changes. The **Web Server** card is the exception: it has its own **Apply** button and its own on/off switch, because starting a listener is an action with an immediate result rather than a preference.

See the subsections for details:

- [OpenRouter API](/app-reference/settings-openrouter)
- [Harmonic Analysis](/app-reference/settings-harmonic)
- [Web Server](/app-reference/settings-web-server)
