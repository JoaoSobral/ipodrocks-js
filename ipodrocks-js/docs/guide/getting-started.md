# Getting Started

This guide walks you through installing iPodRocks, adding your library and a device, and running your first sync.

## Install

### Download (recommended)

Download the installer for your platform from the [Releases](https://github.com/JoaoSobral/ipodrocks-js/releases/) page:

- **Linux** — AppImage
- **macOS** — `.zip`
- **Windows** — `.exe` (portable)

### Build from source

See [Installation](/guide/installation) for build instructions.

## First launch

When you open iPodRocks, you land on the **Welcome** screen. Use the sidebar to move between panels:

- **Welcome** — Overview and quick links
- **Dashboard** — Library stats, devices, shadow libraries, recent activity
- **Library** — Your music catalog
- **Devices** — Connected players
- **Playlists** — Smart, Genius, and Savant playlists
- **Sync** — Copy music to a device

Click the gear icon (top right) to open **Settings** when you need to configure the OpenRouter API or harmonic analysis.

## Add a library folder

1. Open **Library** from the sidebar.
2. Click **+ Add Folder**.
3. Enter a name (e.g. "My Music") and choose the path to your music root (e.g. `/home/user/Music`).
4. Select the content type: Music, Podcasts, or Audiobooks.
5. Click **Add Folder**.

iPodRocks scans all subfolders recursively for audio files (MP3, FLAC, AAC, OGG, Opus, WAV, AIFF, and more). **Your files should have proper tags** (artist, album, title, etc.) — iPodRocks reads them to build the catalog.

After adding, a scan runs automatically. You can run **Scan Library** again anytime to pick up new or changed files.

## Add a device

1. Connect your Rockbox or mountable device and ensure it is mounted (e.g. `/media/ipod`).
2. Open **Devices** from the sidebar.
3. Click **+ Add Device**.
4. Enter a name and the **root mount path** of the device.
5. Choose a codec configuration (Direct Copy, MP3, AAC, Musepack, Opus, etc.).
6. Click **Add Device**.

The app creates `Music`, `Podcasts`, `Audiobooks`, and `Playlists` folders on the device if they do not exist.

## Run your first sync

1. Open **Sync** from the sidebar.
2. Select your device from the dropdown.
3. Choose **Full sync** (music, podcasts, audiobooks, playlists) or **Custom sync** (pick albums, artists, genres, playlists).
4. Click **Start Sync**.

Progress is shown in a modal. When it finishes, your device is ready to use.

## Next steps

- [Library](/app-reference/library) — Add folders, scan, create shadow libraries
- [Devices](/app-reference/devices) — Configure codecs, check device status
- [Playlists](/app-reference/playlists) — Create Smart, Genius, or Savant playlists
- [Settings](/app-reference/settings) — OpenRouter API (for Savant and Assistant), harmonic analysis
