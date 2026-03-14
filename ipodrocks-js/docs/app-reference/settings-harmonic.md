# Settings — Harmonic Analysis

Harmonic Analysis controls how iPodRocks detects musical key and BPM. This data powers Savant's harmonic ordering and the Library/Savant info banners.

## What it does

- **Coverage stat** — Shows how many tracks have key data vs BPM-only vs none.
- **Extract harmonic data on scan** — Read key and BPM from file tags (TKEY, TBPM) during library scan.
- **Analyze with Essentia** — Use Essentia.js to detect key/BPM from the audio waveform. Slower but works when tags are missing.
- **Backfill %** — When using tag extraction only, percentage of library to process in one backfill run.
- **Analyze %** — When using Essentia, percentage of library to analyze per backfill run (genre-sampled).

## How it works

- **Tag extraction** — Reads TKEY and TBPM from ID3/native tags. Fast, but many files lack these tags.
- **Essentia** — Decodes audio, runs KeyExtractor and RhythmExtractor2013. More accurate, but CPU-intensive. A single WASM instance is reused to avoid memory leaks.
- **Backfill** — Processes tracks that do not yet have key data. Skips already-processed tracks. Run from Settings or the Savant tab.
- **Camelot** — Keys are converted to Camelot notation (e.g. 8B) for harmonic mixing. Savant uses this to order tracks.

## How to work with it

1. **Enable "Extract harmonic data"** — Always recommended. Re-scan the library to pick up tags.
2. **Enable "Analyze with Essentia"** — When many files lack key tags. Set Analyze % (e.g. 10% per run). Run Backfill from the Savant tab or Settings.
3. **Re-scan** — After changing "Extract harmonic data", run a full library scan so new scans use the setting.
4. **Backfill** — Run when you have BPM-only or no key data. It only processes tracks that need it; already-done tracks are skipped.
5. **Library/Savant banners** — Show coverage and link to Settings when coverage is low.
