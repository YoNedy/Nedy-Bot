# Discord Bot

A Discord bot that sends a random message to a specified channel every 5-30 minutes.

## Setup

- **Runtime**: Node.js 20
- **Main file**: `index.js`
- **Dependencies**: `discord.js`

## Environment Variables

- `TOKEN` (secret): Discord bot token
- `CHANNEL_ID` (secret): Discord channel ID to send messages to

## How it works

1. Bot logs in with the provided token
2. On ready, it calls `sendRandomMessage()`
3. Sends "Mici ăn cứt" to the channel
4. Schedules the next message in 5-30 minutes randomly
5. Repeats indefinitely
