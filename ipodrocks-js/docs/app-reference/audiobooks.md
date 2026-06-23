# Extra Audiobooks

The **Extra Audiobooks** panel lets you browse and subscribe to free, public-domain audiobooks from [LibriVox](https://librivox.org) and have their chapters downloaded and synced to your devices automatically.

No account, API key, or credentials are required — LibriVox is free and open.

## What it does

- **Search & Add** — Search the LibriVox catalog by title or author and subscribe in one click.
- **Cover grid** — Subscribed books appear as a cover grid, each tagged **Extra**, showing chapter count and total runtime.
- **Download-on-sync** — Chapters are not pre-downloaded. They are fetched on demand the first time you sync a device that includes the book, keeping disk use to what you actually transfer.
- **Device sync** — Chapters (and the book cover) are copied into each device's Audiobooks folder, organised one folder per book.
- **Cover artwork** — LibriVox feeds rarely include artwork, so covers are looked up automatically from Google Books / Open Library, with a manual picker if you want a different one.

## How it works

### Subscribing

1. Open the **Extra Audiobooks** tab in the sidebar.
2. Click **Search & Add**.
3. Type a title or author. Author searches also retry on the last word, so "Philip K. Dick" matches even though LibriVox only indexes authors by last name.
4. Click a result to subscribe. The book's chapter list is pulled from its LibriVox RSS feed and the cover is fetched in the background — it swaps in live once ready, no manual refresh needed.

### Chapter download states

Open a book to see its detail modal with per-chapter state:

| State | Meaning |
|-------|---------|
| `pending` (○) | Not yet downloaded. |
| `downloading` (…) | Currently being fetched. |
| `ready` (✓) | Downloaded and available for device sync. |
| `failed` (✕) | Download was attempted but errored. |
| `skipped` (−) | Will not be downloaded or synced. |

Because audiobooks use **download-on-sync**, most chapters stay `pending` until the first sync that includes the book, at which point they download and become `ready`.

### Device sync

Audiobooks sync through the normal **Sync** panel, just like podcasts:

- **Full sync** — Include audiobooks via the Audiobooks content toggle.
- **Custom sync** — Tick specific books in the Audiobooks category box, in either Include or Exclude mode.

On the device, chapters land at:

```
<device root>/<Audiobooks folder>/<Author - Title>/NN <Chapter Title>.ext
```

with the book cover copied alongside as `cover.<ext>`. The `NN` prefix preserves chapter order in players that sort by filename. Chapters already on the device are skipped on subsequent syncs (tracked in a `device_audiobook_synced` table); if a destination path changes, the old file is cleaned up and the chapter re-copied.

### Covers

After you subscribe, iPodRocks resolves a cover automatically from Google Books / Open Library and stores it locally. If the automatic match is wrong or missing, open the book and click **Search cover** to pick a different cover from candidate results.

## How to work with it

1. **Subscribe** to a few books from the LibriVox catalog.
2. **Enable audiobooks** for the target device (Full sync content toggle, or tick the books in Custom sync).
3. **Sync** — Chapters download on demand and copy to the device's Audiobooks folder.
4. **Remove a book** — Open it and click **Remove Book** to unsubscribe and delete its local chapter files.

## Rocksy

Rocksy can manage Extra Audiobooks for you from the chat:

- "Find audiobooks by Jules Verne" → `audiobook_search`
- "Subscribe to Pride and Prejudice" → `audiobook_subscribe`
- "What audiobooks do I have?" → `audiobook_list_subscriptions`
- "Remove that book" → `audiobook_unsubscribe` (asks you to confirm first)
- "Find a better cover for it" → `audiobook_refresh_cover`

## Tips

- Audiobooks are free and public-domain — there is no quota or login.
- If a chapter shows `failed`, sync again to retry the download.
- Because chapters download on sync, the first sync of a long book can take a while; subsequent syncs only copy what's new.
- Use **Custom sync → Exclude** to sync your whole library minus a specific audiobook box set.
