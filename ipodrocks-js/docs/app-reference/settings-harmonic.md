# Settings — Harmonic Analysis

Harmonic Analysis (in **Settings → Library**) controls how iPodRocks finds each track's musical key and BPM. This data powers Savant's harmonic ordering and the coverage notes in the Library and on the Savant tab.

## What it does

- **Coverage stat** — How many tracks have key data, BPM only, or none.
- **Extract harmonic data on scan** — Read key and BPM from file tags (TKEY, TBPM) during a library scan.
- **Analyze with Essentia.js** — Detect key and BPM from the audio itself, for tracks whose tags have none. It runs as the **last step of every library scan**, and only on tracks still missing key data.
- **Analyze % of tracks missing key data** — How many of those tracks one scan analyses, to control CPU use. 100 analyses all of them; a lower number spreads the work over several scans.

## How it works

- **Tag extraction** — Reads TKEY and TBPM from the file's tags. Fast, but many files (most `.m4a` files, for instance) have no key tag.
- **Essentia** — Decodes the audio and runs KeyExtractor and RhythmExtractor2013. More accurate, but CPU-intensive. In the scan dialog it shows as *Analyzing key/BPM*, after the files have been read, and **Cancel** stops it. The summary says how many tracks it analysed.
- **Only the missing ones** — A scan skips files it has already read, but the Essentia step does not depend on that: it picks every music track still without key data, so a plain rescan fills in tracks an earlier scan could not. A track Essentia cannot decode is marked and not retried.
- **One at a time** — Essentia is shared with the [Lossless Check](./library.md#lossless-check); if that is running, the scan skips the analysis step and says so, and the next scan catches up.
- **Camelot** — Keys are converted to Camelot notation (e.g. 8B) for harmonic mixing. Savant uses this to order tracks.

## How to work with it

1. **Enable "Extract harmonic data"** — Always recommended.
2. **Enable "Analyze with Essentia.js"** if the Library shows tracks without key data, then **Scan Library**. Set the percentage lower if a large library makes that scan too long.
3. **Savant works without key data**, but its playlists will not flow as well. The Savant tab says so when coverage is below 100%.
