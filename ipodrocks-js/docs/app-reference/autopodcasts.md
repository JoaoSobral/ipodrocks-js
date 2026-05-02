# Auto Podcasts

Auto Podcasts lets you subscribe to any podcast, configure how many episodes to keep, and have new episodes downloaded and synced to your devices automatically — no manual intervention required.

## What it does

- **Subscribe** — Search for any podcast by keyword using the Podcast Index catalog. Add as many subscriptions as you like.
- **Auto-download** — For each subscription, choose how many of the latest episodes to keep (1–5), or switch to manual selection (pick up to 5 specific episodes yourself).
- **Background refresh** — iPodRocks periodically checks every subscription's RSS feed for new episodes. The refresh runs while the app is open, on a schedule you control in Settings.
- **Device sync** — Episodes that have been downloaded are automatically copied to each device that has Auto Podcasts enabled, into that device's configured Podcasts folder.

## How it works

### Subscriptions and episode selection

Each subscription has an **auto-download mode**:

| Mode | What it does |
|------|-------------|
| **Last N episodes** (1–5) | Always keeps the N most recent episodes on the device. As new episodes arrive and older ones fall outside the window, they are no longer synced going forward. |
| **Manual selection** | You pick up to 5 specific episodes by checkbox. Only those exact episodes are downloaded and synced. |

The badge on each subscription card reflects the current mode: `last 2`, `last 5`, `manual`, etc.

### Download states

Each episode goes through these states:

| State | Meaning |
|-------|---------|
| `pending` | Queued for download, not yet started. |
| `downloading` | Currently being fetched. |
| `ready` | Downloaded and available for device sync. |
| `failed` | Download was attempted but errored. Shown with a red ✕. |
| `skipped` | Episode was outside the auto-download window and was not fetched. |

### Device sync

Auto Podcasts syncs independently of the main Sync panel. When the background scheduler runs (or when you click **Download now** manually), iPodRocks:

1. Checks each subscription's feed for new episodes.
2. Downloads any episodes that fall within the configured window.
3. Copies `ready` episodes to the Podcasts folder of each device that has Auto Podcasts enabled.

The per-device toggle (`auto_podcasts_enabled`) lives in the device profile. Only devices with that toggle on receive auto-downloaded episodes. The destination folder defaults to `Podcasts` inside the device root (configurable per device in the **Devices** panel).

### Podcast Index API

The search and RSS feed fetching use the [Podcast Index](https://podcastindex.org/) API, which is free for personal use. You need an API key and secret — both are stored locally and never leave your machine except when making API calls to `api.podcastindex.org`.

## How to set it up

### 1. Get a Podcast Index API key

1. Go to [api.podcastindex.org/signup](https://api.podcastindex.org/signup) and create a free account.
2. Copy your **API Key** and **API Secret**.

### 2. Configure credentials in Settings

1. Open **Settings** (gear icon, top right).
2. Scroll to the **Auto Podcasts** section.
3. Enter your API Key and API Secret.
4. Click **Test Connection** — you should see "Connected".
5. Toggle **Enable auto refresh & sync** on if you want background downloads.
6. Set a **Refresh interval** (15 min, 30 min, or 1 hour).
7. Click **Save**.

### 3. Subscribe to podcasts

1. Open the **Auto Podcasts** tab (microphone icon in the sidebar).
2. Click **Search & Subscribe**.
3. Type a keyword — results appear live as you type.
4. Click **+ Add** next to any podcast. It appears in your subscriptions grid immediately, with its artwork.

### 4. Configure each subscription

Click any subscription card to open its episode modal:

- **Auto-download dropdown** — pick how many recent episodes to keep (1–5) or switch to Manual selection.
- **Manual mode** — checkboxes appear next to each episode; tick up to 5 to mark them for download.
- **Download now** — trigger an immediate refresh and download, without waiting for the scheduler.
- **Unsubscribe** — removes the subscription and stops all future downloads for it.

### 5. Enable Auto Podcasts on a device

Open the **Devices** panel, select a device, and enable the **Auto Podcasts** toggle in the device settings. Once enabled, every scheduler cycle copies newly ready episodes to that device.

## Tips

- **Manual selection** is useful for podcasts where you only want specific back-catalogue episodes, not the latest ones.
- **Download now** is handy after subscribing — it immediately fetches the feed so you don't have to wait for the next scheduler cycle.
- If a download shows `failed`, click **Download now** to retry.
- The subscriptions grid shows podcast artwork fetched from the Podcast Index. If artwork doesn't display, check that the URL is reachable.
- Podcast episodes are placed in `<device root>/<Podcasts folder>/<Podcast title>/` on the device. Rockbox and most players recognise them automatically.
