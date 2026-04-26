# Nedy Bot

Vietnamese-speaking Discord bot powered by Gemini (or OpenAI). Replies to mentions/replies, has tool calling (web search + persistent memory), tracks server members and custom emoji, and can view images.

## Requirements

- Node.js 20+ and npm
- A Discord bot token
- A Gemini API key (free at https://aistudio.google.com/apikey) **or** an OpenAI API key

## Local setup

```bash
npm install
mkdir -p data
node index.js
```

Required env vars (use a `.env` file or your host's secret manager):

```
TOKEN=your_discord_bot_token
CHANNEL_ID=main_channel_id
GEMINI_API_KEY=your_gemini_key
```

If `GEMINI_API_KEY` is missing, the bot falls back to `OPENAI_API_KEY` automatically.

---

## Deploy on Render.com (free tier, 24/7)

1. Push this folder to a GitHub repo (private is fine).
2. On https://render.com → **New** → **Web Service** → connect the repo.
3. Configure the service:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node index.js`
   - **Instance Type**: Free
4. Under **Environment** → add these env vars:
   - `TOKEN` = your Discord bot token
   - `CHANNEL_ID` = main channel id
   - `GEMINI_API_KEY` = your Gemini key
5. Click **Create Web Service**.

The bot ships with a tiny health-check HTTP server that activates automatically when Render sets the `PORT` env var, so Render will see the service as "live" and keep it running.

> **Heads-up about Render's free tier**: free Web Services sleep after ~15 minutes of inactivity and the cold start takes ~30s. To keep the bot alive 24/7, point a free uptime monitor (https://uptimerobot.com or https://cron-job.org) at the service's `https://your-app.onrender.com/` URL with a 5-minute ping interval. Or upgrade to Render's $7/mo Background Worker tier (no HTTP needed, no sleeping).

---

## Discord Developer Portal setup

1. https://discord.com/developers/applications → New Application → Bot.
2. Under **Bot** → enable these **Privileged Gateway Intents**:
   - Server Members Intent
   - Message Content Intent
3. Copy the bot token into the `TOKEN` env var.
4. Invite the bot with at least: View Channels, Send Messages, Read Message History, Use External Emojis, Add Reactions.

## Persistent data

Memorized facts live in `data/facts.json`. Render's free tier has ephemeral disk — the file resets on every redeploy. If you want persistent memory there, either:
- Upgrade to a paid Render plan with a persistent disk, or
- Swap the `loadFacts/saveFacts` functions for an external store (e.g. Replit DB, Supabase, MongoDB Atlas free tier).

## Customizing the special users

The "sếp" and "chị Callisto" IDs are hardcoded in `index.js`. Search for `NEDY_ID` and the Callisto ID and replace with your own.
