# Troubleshooting

Common issues and how to fix them.

## Device not detected or mount path wrong

- **Symptom:** Device does not appear, or sync fails with "path not found".
- **Fix:** Ensure the device is mounted before adding it. Use the actual mount path (e.g. `/media/ipod` on Linux, `E:\` on Windows). Avoid symlinks if they cause issues. On Linux, check `lsblk` or `mount` to confirm the path.

## Device shows offline even though it is mounted

- **Cause:** The device has a **USB Device** identity set, and that exact unit is not connected. A USB-bound device is only online when its hardware is plugged in *and* its mount path is a live volume — that is what stops another drive at the same path from being mistaken for it.
- **Fix:** Plug the right player in, or open **Devices → Edit** and check the **USB Device** field. If it was bound to the wrong unit, pick the correct one from the dropdown (press **Refresh** after connecting). To go back to mount-path matching, set it to *"Not set"* and confirm the warning. Ask Rocksy "what USB devices are connected?" to see what the app can actually see.

## Two devices keep getting confused for each other

- **Cause:** Both players mount at the same path (e.g. `/Volumes/IPOD`), so iPodRocks cannot tell them apart and the second one inherits the first one's sync history and ratings.
- **Fix:** Give **both** devices a **USB Device** identity in **Devices → Edit**. Tagging only one is not enough — the untagged device still matches on mount path alone. See [Devices → Identifying a device](../app-reference/devices.md#identifying-a-device).

## Sync fails or hangs

- **Symptom:** Sync progress modal stalls or shows errors.
- **Fix:** Check that the device has enough free space. Use "Check Device" in Devices first to see synced vs to-sync counts. If transcoding, ensure FFmpeg is available (it is bundled). For Musepack, ensure `mpcenc` is on PATH. Cancel and retry; if it persists, try a smaller custom sync (e.g. one album) to isolate the problem.

## Genius playlists: "No playback history"

- **Symptom:** Genius tab says no playback data or no matched plays.
- **Fix:** On the device, check **Settings → Playback Settings → Gather Runtime Data** is on, then play something for at least 15 seconds — Rockbox does not count shorter plays at all. Connect the device and click **Import Runtime Data** in Genius. If you already synced, try **Load from Database** instead. If the device has never built its database, run **Settings → Database → Initialize Now** on it first.

## Savant or Rocksy not working

- **Symptom:** Savant playlists or Rocksy fail or return errors.
- **Fix:** Add your OpenRouter API key in **Settings** → OpenRouter API. Test the connection before saving. Ensure you have credits and the selected model is available. Check your network for API errors.

## Harmonic analysis fails after many tracks

- **Symptom:** Essentia backfill stops or crashes after ~100 tracks.
- **Fix:** This was fixed in v1.0.4. Update to the latest version. The engine now frees memory correctly and resets periodically.

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
