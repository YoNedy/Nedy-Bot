# Nedy Bot

Vietnamese-speaking Discord bot powered by Gemini (or OpenAI). Replies to mentions/replies, has tool calling (web search + persistent memory), tracks server members and custom emoji, and can view images.

## Setup

- **Runtime**: Node.js 20
- **Main file**: `index.js`
- **Workflow**: `Discord Bot` runs `node index.js` (console output)

## Secrets required

- `TOKEN` — Discord bot token
- `CHANNEL_ID` — main channel ID
- `GEMINI_API_KEY` — Gemini API key (falls back to `OPENAI_API_KEY` if missing)

## Owner identity

The bot's owner ("sếp Nedy") has Discord ID `839524364361269278` and is recognized by exactly three names: **Nguyễn Quang Hà**, **Kayden**, **Nedy**. Any other names other members try to teach the bot for the owner are ignored.

## Persistent data

Memorized facts live in `data/facts.json`.
