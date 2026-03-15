# Troubleshooting

Common issues and how to fix them.

## Device not detected or mount path wrong

- **Symptom:** Device does not appear, or sync fails with "path not found".
- **Fix:** Ensure the device is mounted before adding it. Use the actual mount path (e.g. `/media/ipod` on Linux, `E:\` on Windows). Avoid symlinks if they cause issues. On Linux, check `lsblk` or `mount` to confirm the path.

## Sync fails or hangs

- **Symptom:** Sync progress modal stalls or shows errors.
- **Fix:** Check that the device has enough free space. Use "Check Device" in Devices first to see synced vs to-sync counts. If transcoding, ensure FFmpeg is available (it is bundled). For Musepack, ensure `mpcenc` is on PATH. Cancel and retry; if it persists, try a smaller custom sync (e.g. one album) to isolate the problem.

## Genius playlists: "No playback history"

- **Symptom:** Genius tab says no playback data or no matched plays.
- **Fix:** Connect the device and enable "Read playback log" in Devices. Click **Recheck device for playback.log** to read `playback.log` from the device. Rockbox must have written this file by playing tracks. If you already synced, try **Load from Database** instead.

## Savant or Assistant not working

- **Symptom:** Savant playlists or Music Assistant fail or return errors.
- **Fix:** Add your OpenRouter API key in **Settings** → OpenRouter API. Test the connection before saving. Ensure you have credits and the selected model is available. Check your network for API errors.

## Harmonic analysis fails after many tracks

- **Symptom:** Essentia backfill stops or crashes after ~100 tracks.
- **Fix:** This was fixed in v1.0.3.1. Update to the latest version. The engine now frees memory correctly and resets periodically.

## Album artwork not on device

- **Symptom:** Covers missing on the device after sync.
- **Fix:** Ensure "Skip album artwork" is unchecked in the Sync panel. iPodRocks copies `cover.jpg`, `folder.png`, and similar files. If your files use different names, they may not be detected. Check that the library folder has artwork in the same folder as the audio files.

## Musepack (mpcenc) not found

- **Symptom:** Prompt when selecting Musepack as codec.
- **Fix:** Install `musepack-tools` (or equivalent) for your platform. See [Installation](/guide/installation#musepack-mpcenc). Add `mpcenc` to your PATH. You can use other codecs (MP3, AAC, Opus) without it.

## Database or config location

iPodRocks stores its database and preferences in the app's user data directory:

- **Linux:** `~/.config/iPodRocks/` or `~/.config/ipodrocks/`
- **macOS:** `~/Library/Application Support/iPodRocks/`
- **Windows:** `%APPDATA%\iPodRocks\`

The main database file is `ipodrock.db`. Backing up this folder preserves your library catalog, playlists, devices, and preferences.
