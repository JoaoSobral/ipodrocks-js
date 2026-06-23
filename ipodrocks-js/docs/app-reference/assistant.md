# Rocksy

Rocksy is a floating chat that knows your library, playlists, and listening history. Rocksy can **act on your behalf** — not just answer questions, but actually perform tasks in the app through tool calls.

## What it does

- **Floating chat** — Open from the sidebar or a button. Stays on top while you use other panels.
- **Takes actions, not just answers** — Rocksy calls structured tools to fetch live data and run operations: search the library, create playlists, manage podcasts and audiobooks, check and sync devices, and more.
- **Persistent memory** — Up to 40 pinned memories survive app restarts. Say "always remember my name is Pedro" or "don't forget I love jazz".
- **Rolling history** — Last 100 exchanges as hidden context. The assistant stays informed without cluttering the chat.
- **Create playlists** — Ask "Make me a rock playlist with 30 tracks" or "Create a late night favorites playlist from my listening history". It creates Smart or Genius playlists.
- **Forget / correct** — Say "forget about that" or "actually my name is X" to update or remove memories.

## What Rocksy can do for you

Rocksy's tools are grouped into three tiers by how risky they are:

- **Read** *(run immediately)* — Look up data: search tracks, list albums / artists / genres, search and list podcasts and their episodes, search and list audiobooks, list devices.
- **Write-safe** *(run immediately)* — Non-destructive changes: create Smart and Genius playlists, repair a broken playlist, subscribe to a podcast (by search **or by URL**), subscribe to a LibriVox audiobook, refresh an audiobook cover.
- **Write-destructive** *(ask before running)* — Anything that deletes, syncs, scans, or changes folders: delete or repair playlists, download or delete podcast episodes, unsubscribe from an audiobook, add or remove library folders, scan the library, check or sync a device. Rocksy pauses and shows **Confirm / Cancel** buttons before these run.

### Examples

- "What artists do I have in Rock?" → searches the library
- "Make a Smart playlist of my 4-star tracks" → creates the playlist
- "Subscribe to this podcast: `https://…/feed.xml`" → adds it by URL
- "Find audiobooks by Jules Verne and subscribe to one" → searches and subscribes via LibriVox
- "Which playlists have missing songs? Repair them." → lists broken playlists, then repairs
- "Sync my iPod" → asks you to confirm, then runs the sync

## How it works

- **Tool-calling loop** — Each message runs up to 5 rounds of tool calls. Rocksy fetches what it needs, acts, and feeds the results back to itself before replying, so multi-step requests ("search → subscribe", "list → create") finish in one turn.
- **Confirm gate** — Destructive tools never run silently. The chat shows Confirm / Cancel and the input is locked until you choose.
- **OpenRouter** — Uses the same API key as Savant. Rocksy calls tools to fetch data on demand instead of receiving a full library dump on every message.
- **Memories** — Stored in the database. Pinned memories are always included; rolling history is trimmed.

## How to work with it

1. **Add OpenRouter API key** in Settings. The Assistant will not work without it.
2. **Tell it about yourself** — "Remember I prefer jazz and blues" or "I'm Pedro". It uses this in future replies.
3. **Ask questions** — "What artists do I have in Rock?" or "Suggest something for a road trip."
4. **Create playlists** — Be specific: "Smart playlist, genre Rock, 50 tracks" or "Genius playlist from my most played, 25 tracks."
5. **Correct memories** — "Forget I said that" or "Actually I don't like country" to keep context accurate.
