# Devices

The Devices panel lets you add, edit, and check Rockbox and mountable players.

## What it does

- **Add Device** — Register a new device with name, mount path, model, codec config, folder layout, and (optionally) a USB hardware identity.
- **Edit Device** — Change any device setting.
- **Check Device** — Compare what is on the device with the library. Shows synced, codec mismatch, to sync, and orphans.
- **Recheck** — Re-read the device after changes (e.g. after a sync or manual file changes).
- **Set as default** — Use this device as the default for sync and Genius.
- **Eject** (the ⏏ button) — Unmount the device from inside iPodRocks so you can unplug it, instead of switching to Finder. It asks you to confirm first. The button is greyed out when it cannot be used — on Windows, and whenever the device is not connected — and hovering it says which of the two it is.

## How it works

- **Mount path** — The root path where the device is mounted (e.g. `/media/ipod`). iPodRocks expects `Music`, `Podcasts`, `Audiobooks`, and `Playlists` subfolders (configurable).
- **USB Device (optional)** — Pin the device to a specific piece of physical hardware instead of relying on its mount path. See [Identifying a device](#identifying-a-device) below.
- **Codec config** — Direct copy (no conversion) or transcode to MP3, AAC, Musepack, Opus, OGG. If you use a shadow library, set the device source to "Shadow" and pick the shadow — no transcoding during sync.
- **Variable bitrate (VBR)** — When transcoding to a lossy codec (MP3, AAC, OGG, Opus), tick this to encode at a quality level derived from the chosen bitrate instead of a fixed bitrate. VBR usually gives better quality per file size. The option only appears for these codecs — it is hidden for lossless formats (FLAC/ALAC), which are always variable, and for Musepack, which is already quality-based.
- **Check Device** — Scans the device filesystem and compares with the library. "Codec mismatch" means files use a different codec than the device profile (e.g. MP3 on device, OPUS profile); when you sync with **Orphan & Reset Policy set to "Remove orphans"**, old-codec files are deleted and replaced by the new codec.
- **Orphans** — Files on the device that are not in the library. You can remove them during sync **only when Orphan & Reset Policy is set to "Remove orphans"** (the setting lives in the Sync panel), which sweeps songs, podcasts and audiobooks alike; with "Keep" or "Prompt", orphans are not auto-deleted. "Delete all" goes further and rebuilds the content folders from scratch.

### Ejecting

Eject unmounts the device's volume — on macOS via `diskutil eject` (the same
thing Finder's eject button does), on Linux via `udisksctl`, falling back to
`umount`. Nothing is deleted and no files are written. It asks you to confirm
before unmounting.

The ⏏ button is greyed out rather than hidden when it is unavailable, so you can
hover it and find out why:

- **On Windows**, where there is no dependable command-line eject — use
  Explorer's Safely Remove Hardware there.
- **When the device is not connected.** If a device you have plugged in still
  shows as disconnected, see [Identifying a device](#identifying-a-device): a
  device with a USB identity is only online when *that exact unit* is plugged in
  and its mount path is a live volume.

It is refused, with an explanation, in three cases: a sync is running (unmounting
mid-copy would leave half-written files), the device is in dev mode (its mount
path is an ordinary folder, so there is no volume to eject), or the path is not
actually a mounted volume. That last check is also what stops an eject being
aimed at the empty folder macOS sometimes leaves behind after a previous eject.

Rocksy can eject for you too, via `device_eject` — it confirms first.

## Remote devices

When you reach iPodRocks through the [web server](./settings-web-server.md), the
player does **not** have to be plugged into the machine holding your library. It
is plugged into the machine you are sitting at, and your browser hands iPodRocks
access to it. That is a **remote device**.

So there are two kinds of device, and which one a device is is a fact about
where the thing is physically plugged in, not a preference:

| | Local player | Remote device |
|---|---|---|
| Plugged into | the machine running iPodRocks | the machine running your browser |
| Added from | the desktop app | the browser |
| Mount path | a folder on that machine | none — you pick the folder in your browser |
| Synced by | the desktop app | that browser tab |
| Auto Podcasts | yes | no |
| Eject from iPodRocks | macOS/Linux | no — use your own file manager |

**Each one is only usable from its own side.** In the browser, a player attached
to the server is listed but greyed out, with a line saying why; in the desktop
app, a remote device is listed but greyed out the same way. Both are still
yours: you can rename them, change their settings and remove them from either
side. Only the things that touch the player's filesystem — Check Device, Sync,
Eject — are refused, and they are refused by the app itself, not just hidden
from the buttons.

### Adding one

In the browser, **+ Add Device** always adds a remote device. There is no mount
path to type and no Browse button, because there is no folder on the server to
point at — the picker you want is your own browser's, and it comes later.

Fill in the name and model, save, then press **Connect this player** on the
device's card. Your browser opens its own folder picker; choose the root of the
player — the folder holding `Music` and `.rockbox` — and grant access. From then
on that tab *is* the device.

### What to expect, and why

- **It needs Chrome, Edge or another Chromium browser, on a desktop, over
  HTTPS.** Granting a page access to a folder needs the File System Access API,
  which Firefox and Safari do not implement and iOS does not have at all. (A
  Firefox-derived browser such as Zen, LibreWolf or Floorp is Firefox for this
  purpose and will not work.) iPodRocks checks for the API itself rather than
  sniffing the browser's name, so a Chromium browser it has never heard of works
  and a Firefox fork claiming to be Chrome does not. If yours cannot do it, the
  Add Device form says so before you fill it in.
- **No browser will do it over plain HTTP.** You need a real HTTPS address; a
  Cloudflare Tunnel is the easiest way to get one — see
  [Deploying the Server](/guide/server-deployment).
- **The tab has to stay open.** Close it and the player goes offline. Next time
  you press Connect again, because a browser deliberately does not let a page
  keep silent access to your disk across visits.
- **Only one tab at a time.** Opening the same player in a second tab detaches
  the first. Two tabs writing into Rockbox's index — which has no checksum —
  would corrupt it.
- **If the folder opens read-only**, the card says so and nothing is written.
  Disconnect and connect again, granting write access this time.
- **Every byte crosses the network twice.** A first full sync of a large library
  over a slow link takes as long as that implies, and the card says so before
  you start. Transcode once into a [shadow library](./library.md) on the server
  and sync a selection rather than everything; a player pointed at a shadow
  copies files as they already are.
- **Auto Podcasts is unavailable**, and the checkbox says why. The schedule is a
  timer in the server, and a remote device is connected only while its tab is
  open — so it would either do nothing or start pushing gigabytes through a
  browser nobody is watching. Episodes still download on schedule; they reach
  the player on your next sync.
- **Eject is greyed out.** The volume belongs to your computer, not the server,
  so nothing iPodRocks runs can unmount it. Use your own file manager.
- **The USB Device dropdown is empty**, and is meant to be. That list is the
  *server's* USB bus, which says nothing about the player in your hand.
- **Modification times are not set on the player.** The File System Access API
  cannot set them, so the sync compares file sizes instead — which it already
  tried first. iPodRocks also measures the difference between your browser's
  clock and the server's and corrects for it, because a clock a few seconds out
  would otherwise make every sync recopy the whole library.

Everything else — codec profiles, folder layout, orphan policy, playlists,
ratings, runtime data — behaves exactly as it does on the desktop. A device is a
device; only the filesystem underneath it changed.

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

Rocksy cannot pick the folder for a browser-held device. That picker has to be
opened by your own click — a page is not allowed to ask for a folder on its own,
which is exactly the protection you want.
