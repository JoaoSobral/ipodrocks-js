# Rocksy

Rocksy is a floating chat that knows your library, playlists, and listening history. You can ask questions and create playlists by talking.

## What it does

- **Floating chat** — Open from the sidebar or a button. Stays on top while you use other panels.
- **Persistent memory** — Up to 40 pinned memories survive app restarts. Say "always remember my name is Pedro" or "don't forget I love jazz".
- **Rolling history** — Last 100 exchanges as hidden context. The assistant stays informed without cluttering the chat.
- **Create playlists** — Ask "Make me a rock playlist with 30 tracks" or "Create a late night favorites playlist from my listening history". It creates Smart or Genius playlists.
- **Forget / correct** — Say "forget about that" or "actually my name is X" to update or remove memories.

## How it works

- **OpenRouter** — Uses the same API key as Savant. Sends your message and context (library metadata, playlists, memories) to the model.
- **Memories** — Stored in the database. Pinned memories are always included; rolling history is trimmed.
- **Playlist creation** — The assistant calls the same backend as Smart and Genius. It knows your genres, artists, albums, and can use playback history for Genius-style playlists.

## How to work with it

1. **Add OpenRouter API key** in Settings. The Assistant will not work without it.
2. **Tell it about yourself** — "Remember I prefer jazz and blues" or "I'm Pedro". It uses this in future replies.
3. **Ask questions** — "What artists do I have in Rock?" or "Suggest something for a road trip."
4. **Create playlists** — Be specific: "Smart playlist, genre Rock, 50 tracks" or "Genius playlist from my most played, 25 tracks."
5. **Correct memories** — "Forget I said that" or "Actually I don't like country" to keep context accurate.
