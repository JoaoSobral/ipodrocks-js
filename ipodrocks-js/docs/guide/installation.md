# Installation

## Build from source

**Requirements:**

- Node.js 18+
- npm

```bash
cd ipodrocks-js
npm install
npm run build
npm run preview    # run in production mode
```

For development with hot-reload:

```bash
npm run dev
```

## FFmpeg

FFmpeg is bundled automatically. No separate installation is required.

## OpenRouter API key

Required for **Savant playlists** and **Rocksy** chat. Get your API key at [openrouter.ai/keys](https://openrouter.ai/keys), then add it in **Settings** (gear icon) → OpenRouter API. You can test the connection before saving.

## Musepack (mpcenc)

Required only if you use Musepack (MPC) as a codec for devices or shadow libraries.

| Platform | Install |
|----------|---------|
| **Debian / Ubuntu** | `sudo apt install musepack-tools` |
| **Fedora / RHEL** | `sudo dnf install mpc-tools` or `musepack-tools` |
| **Arch** | `sudo pacman -S musepack-tools` |
| **macOS** | `brew install musepack` |
| **Windows** | Download from [musepack.net](https://www.musepack.net/), add `mpcenc.exe` to PATH |

If `mpcenc` is not on your PATH, iPodRocks will prompt when you select Musepack. You can still use other codecs (MP3, AAC, Opus, etc.) without it.

## Supported audio formats

iPodRocks scans and catalogs these formats: MP3, FLAC, AAC, M4A, OGG, Opus, WAV, AIFF. Transcoding output supports MP3, AAC, Musepack (MPC), Opus, and OGG.

## Data location

The app stores its database (`ipodrock.db`) and preferences in the platform user data directory. See [Troubleshooting](/guide/troubleshooting#database-or-config-location) for paths and backup notes.
