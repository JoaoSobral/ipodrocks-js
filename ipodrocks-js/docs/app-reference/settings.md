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

Since 2.3.3 it fixes two more things, both from [#130](https://github.com/JoaoSobral/ipodrocks-js/issues/130):

- **Embedded album artwork is removed.** iPodRocks used to copy the cover into every `.mpc` at its original resolution — often 1500×1500 — on top of the `cover.jpg` it already writes beside the audio, which is the one Rockbox actually reads. Nothing is embedded any more, and the repair strips it from the files you already have.
- **Missing ReplayGain is put back**, read from the library track the file was transcoded from.

Click **Repair Musepack tags** to fix the files you already have. It checks every `.mpc` file in your shadow libraries and on connected devices and rewrites the tag in place:

- The audio is never re-encoded — only the tag block at the end of the file is rewritten.
- Files keep their timestamp. They usually get **smaller**, because the artwork comes out — so your next sync re-copies them, which is how the fix reaches your player.
- Files on a connected device get the artwork stripped, but ReplayGain is restored only in your shadow libraries. The next sync carries the fully-repaired files across.
- It is safe to run more than once; a second run reports nothing left to repair.

Files transcoded from 2.3.2 onward are written correctly, so this is a one-time catch-up. Rocksy can run it for you — just ask.

A [shadow library rebuild](./library.md) runs the same repair over that library's own folder. Use this action instead when files have already been synced to a device: it covers connected devices too, which a rebuild does not reach.

## How to work with it

1. Click the **gear icon** in the top-right of the app to open Settings.
2. Configure **OpenRouter** if you use Savant or Rocksy.
3. Configure **Harmonic Analysis** if you want key-aware mixing and Savant harmonic ordering.
4. Click **Save** to apply. **Cancel** discards changes. (Maintenance actions run immediately and are not affected by Save/Cancel.)

See the subsections for details:

- [OpenRouter API](/app-reference/settings-openrouter)
- [Harmonic Analysis](/app-reference/settings-harmonic)
