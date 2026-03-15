# Savant Playlists (AI)

Savant playlists are AI-generated from your mood and intent. They use OpenRouter (Claude, etc.) and can order tracks harmonically when key data is available.

## What it does

- **Quick mode** — Short mood presets (e.g. "Chill", "Workout", "Focus"). Click to generate.
- **Chat mode** — Describe your vibe in plain English. The AI picks tracks and can discuss options.
- **Harmonic coverage** — Shows how many tracks have key data. Links to Settings and Backfill if coverage is low.
- **Generate** — Creates a playlist. You can regenerate with different prompts.
- **Save** — Save as a playlist with a name.

## How it works

- **OpenRouter** — Requires an API key in Settings. The app sends your library metadata (title, artist, album, genre, BPM, Camelot key) and your prompt to the model.
- **Harmonic mixing** — When tracks have Camelot data, the AI is instructed to prefer compatible keys (same number ±1 or A/B swap). A post-processing step reorders for smooth transitions.
- **Selection** — The AI chooses tracks based on mood, completion rates, and BPM. It avoids tracks you consistently skip (from playback history when available).

## How to work with it

1. **Add OpenRouter API key** in Settings. Test the connection before saving.
2. **Improve harmonic coverage** — Enable "Extract harmonic data" and "Analyze with Essentia" in Settings, then scan or run Backfill. More key data = better harmonic ordering.
3. **Quick mode** — Use for fast playlists with common moods.
4. **Chat mode** — Use for specific requests ("late night jazz", "upbeat indie for a run"). Refine with follow-up messages.
5. **Save** when you are happy with the result. Savant playlists are static once saved; regenerate for a fresh mix.
