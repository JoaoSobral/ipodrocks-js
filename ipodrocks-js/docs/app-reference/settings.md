# Settings — Overview

Settings is a modal opened from the gear icon (top right). It has sections for **OpenRouter API**, **Harmonic Analysis**, **Ratings**, **Maintenance** and **Auto Podcasts**.

## What it does

- **OpenRouter API** — API key and model for Savant playlists and Rocksy. Test connection before saving.
- **Harmonic Analysis** — Key/BPM extraction on scan, Essentia analysis, backfill percentage. Affects Library and Savant.
- **Ratings** — "Library tags always win", which makes a scan take each track's rating from the file's own tag. See [Ratings](/app-reference/ratings).
- **Maintenance** — One-time repairs for files iPodRocks has already written. See below.
- **Auto Podcasts** — Podcast Index API credentials, auto-refresh and the download folder. See [Auto Podcasts](/app-reference/autopodcasts).

## Maintenance

### Repair Musepack tags

Versions before 2.3.2 wrote the cover art into Musepack (`.mpc`) files with the wrong APEv2 item type. Two things follow from that:

- Tag editors such as MP3tag and foobar2000 show the artwork as **hundreds of empty "Cover Art" fields**, because they read the image as text and split it on the zero bytes inside it.
- **Rockbox stops reading the ReplayGain tags** on those files — the artwork filled its tag buffer before it reached them.

Click **Repair Musepack tags** to fix the files you already have. It checks every `.mpc` file in your shadow libraries and on connected devices and rewrites the tag in place:

- The audio is never re-encoded — only the tag block at the end of the file is rewritten.
- Files keep their size and timestamp, so nothing is re-transcoded and your next sync copies nothing extra.
- It is safe to run more than once; a second run reports nothing left to repair.

Files transcoded from 2.3.2 onward are written correctly, so this is a one-time catch-up. Rocksy can run it for you — just ask.

## How to work with it

1. Click the **gear icon** in the top-right of the app to open Settings.
2. Configure **OpenRouter** if you use Savant or Rocksy.
3. Configure **Harmonic Analysis** if you want key-aware mixing and Savant harmonic ordering.
4. Click **Save** to apply. **Cancel** discards changes. (Maintenance actions run immediately and are not affected by Save/Cancel.)

See the subsections for details:

- [OpenRouter API](/app-reference/settings-openrouter)
- [Harmonic Analysis](/app-reference/settings-harmonic)
