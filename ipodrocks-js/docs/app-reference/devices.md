# Devices

The Devices panel lets you add, edit, and check Rockbox and mountable players.

## What it does

- **Add Device** — Register a new device with name, mount path, model, codec config, folder layout, and (optionally) a USB hardware identity.
- **Edit Device** — Change any device setting.
- **Check Device** — Compare what is on the device with the library. Shows synced, codec mismatch, to sync, and orphans.
- **Recheck** — Re-read the device after changes (e.g. after a sync or manual file changes).
- **Set as default** — Use this device as the default for sync and Genius.

## How it works

- **Mount path** — The root path where the device is mounted (e.g. `/media/ipod`). iPodRocks expects `Music`, `Podcasts`, `Audiobooks`, and `Playlists` subfolders (configurable).
- **USB Device (optional)** — Pin the device to a specific piece of physical hardware instead of relying on its mount path. See [Identifying a device](#identifying-a-device) below.
- **Codec config** — Direct copy (no conversion) or transcode to MP3, AAC, Musepack, Opus, OGG. If you use a shadow library, set the device source to "Shadow" and pick the shadow — no transcoding during sync.
- **Variable bitrate (VBR)** — When transcoding to a lossy codec (MP3, AAC, OGG, Opus), tick this to encode at a quality level derived from the chosen bitrate instead of a fixed bitrate. VBR usually gives better quality per file size. The option only appears for these codecs — it is hidden for lossless formats (FLAC/ALAC), which are always variable, and for Musepack, which is already quality-based.
- **Check Device** — Scans the device filesystem and compares with the library. "Codec mismatch" means files use a different codec than the device profile (e.g. MP3 on device, OPUS profile); when you sync with **Orphan Policy set to "Remove"**, old-codec files are deleted and replaced by the new codec.
- **Orphans** — Files on the device that are not in the library. You can remove them during sync **only when Orphan Policy is set to "Remove"** (the setting lives in the Sync panel); with "Keep" or "Prompt", orphans are not auto-deleted.

## Identifying a device

A device can be identified in one of two ways.

**By mount path (the default).** Leave **USB Device** unset and iPodRocks treats whatever is mounted at the device's path as that device. This is simple and works for most people.

The catch: mount paths are not unique. Two iPods will both mount at `/Volumes/IPOD` (macOS), `/media/ipod` (Linux) or `E:\` (Windows) if you connect them one at a time. iPodRocks cannot tell them apart, so the second one inherits the first one's sync history, ratings, and podcast state.

**By USB device.** Pick your player from the **USB Device** dropdown in the Add/Edit form and iPodRocks records its USB vendor id, product id and serial number. From then on the device is only considered connected when *that exact unit* is plugged in — a different player at the same mount path will not be mistaken for it.

Notes:

- The dropdown lists what is connected **right now**. Plug the player in first, or press **Refresh** after connecting it. Recognized iPod models are named and listed at the top, including ones in DFU or WTF (recovery) mode.
- A USB-bound device shows as **offline** whenever its unit is unplugged, even if something else is mounted at its path. That is the point of the setting.
- Some devices report **no serial number**. iPodRocks will say so, and identification falls back to the model level — enough to tell an iPod classic from an iPod nano, but not two identical classics apart.
- **To fully separate two players that share a mount path, give both of them a USB identity.** An untagged device still matches on mount path alone, so it can still claim a path its tagged sibling has vacated.
- If USB information cannot be read on your system, iPodRocks says so and quietly falls back to mount-path matching rather than reporting every device as offline.
- **Clearing a USB identity** asks for confirmation, because the device drops back to mount-path matching and another drive at the same path could then be mistaken for it. Changing it to a different unit just shows a notice.

## How to work with it

1. **Add a device** only when it is mounted. Use the real mount path (e.g. `/media/ipod`, not a symlink if that causes issues).
2. **Set a USB Device** if you own more than one player, or if you have ever been unsure which device you were about to sync. It costs one dropdown selection and removes a whole class of mix-ups.
3. **Choose codec** based on device support. Rockbox supports many formats; use direct copy for FLAC/MP3 if the device plays them. Use MPC or Opus for smaller files.
4. **Use shadow libraries** when you want to pre-transcode once and sync quickly to multiple devices.
5. **Check Device** before syncing to see what will change. Use "Recheck" after a sync to confirm.
6. **Play history** — Leave enabled if you use Genius playlists or Listening Stats; iPodRocks imports Rockbox's own play counters, listening time and ratings from the device. Requires **Gather Runtime Data** under **Settings → Playback Settings** on the device.
7. **Rockbox smart playlists (tagnavi)** — When enabled, smart playlists sync as live tagnavi query entries (written to `.rockbox/tagnavi_user.config`) instead of static `.m3u` files. Genius, Savant, and Custom playlists always write `.m3u` regardless of this setting. See [Smart Playlists → Rockbox dynamic mode](./playlists-smart.md#rockbox-dynamic-mode-per-device-opt-in).

## Rocksy

[Rocksy](./assistant.md) can inspect and operate your devices from the chat:

- "What devices do I have?" → `device_list`
- "What USB devices are connected?" / "What's my iPod's serial number?" → `usb_device_list`
- "Both my iPods mount at the same path — tell them apart" → `device_set_usb_identity` *(asks you to confirm first)*
- "Stop identifying this device by USB" → `device_set_usb_identity` *(asks you to confirm first)*
- "Check my iPod" → `device_check` *(asks you to confirm first)*
- "Sync my iPod" → `device_sync` *(asks you to confirm first)*
- "Remove the old Nano" → `device_remove` *(asks you to confirm first)*

Listing devices and USB devices runs immediately; checking, syncing, removing a device, and changing a USB identity each pause for a **Confirm / Cancel** prompt before running.
