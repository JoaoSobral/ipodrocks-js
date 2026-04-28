# Settings — OpenRouter API

The OpenRouter API connects iPodRocks to AI models (Claude, etc.) for Savant playlists and Rocksy.

## What it does

- **API Key** — Your OpenRouter API key. Get one at [openrouter.ai/keys](https://openrouter.ai/keys).
- **Model** — The model ID (e.g. `anthropic/claude-sonnet-4.6`). Browse models at [openrouter.ai/models](https://openrouter.ai/models).
- **Test Connection** — Verifies the key and model work before you save.

## How it works

OpenRouter is a proxy to multiple AI providers. iPodRocks sends prompts (mood, library metadata) and receives JSON (track IDs). The key is stored locally; it is never sent anywhere except OpenRouter.

## How to work with it

1. Create an account at [openrouter.ai](https://openrouter.ai) and get an API key.
2. Paste the key in Settings. Optionally change the model (default is Claude Sonnet).
3. Click **Test Connection** to confirm it works.
4. Click **Save**. Savant and Rocksy will now work.
5. Without a key, Savant and Rocksy will prompt you to add one.
