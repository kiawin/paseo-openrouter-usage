OpenRouter usage adds an OpenRouter card to Paseo's Usage panel. It shows your account's remaining credit, your API key's spending limit, and what the key has spent today, this week, this month and in total.

## Setup

Give the Paseo daemon one or both OpenRouter keys. The easiest way is Settings, Plugins, OpenRouter keys, also reachable from the Command Center as **Set OpenRouter usage keys**. It works from any connected device: the screen checks each key with OpenRouter and saves it to the file below on the daemon host. It never shows a saved key again.

You can also set the keys on the daemon host yourself. For each key, the plugin uses the environment variable if it is set, and the file otherwise.

| Key            | Environment variable        | File                                  |
| -------------- | --------------------------- | ------------------------------------- |
| API key        | `OPENROUTER_API_KEY`        | `~/.config/openrouter/api-key`        |
| Management key | `OPENROUTER_MANAGEMENT_KEY` | `~/.config/openrouter/management-key` |

A file holds only the key. `XDG_CONFIG_HOME` replaces `~/.config` when it is set. Environment variables are read from the daemon's own environment, so set them where the daemon starts. A file works without restarting the daemon. While a key's environment variable is set, the settings screen shows that and cannot replace it.

- The API key shows its spending limit and its spend. Any OpenRouter API key works.
- The management key shows the account's credits, which are total purchased, total used and remaining. OpenRouter serves account credits only to management keys, which you create in your OpenRouter account settings.

Requires Paseo 0.11 or later.

## What it shows

- **Credits:** total purchased against total used, from the management key.
- **Key limit:** the API key's spending limit. A limit that resets daily, weekly or monthly appears as a window that you can pin to the sidebar, with its reset time. A limit that never resets appears as a balance.
- **Spend:** the API key's spend today, this week and this month in UTC, and since it was created.

An agent's usage popover shows the card when that agent sends the same API key to OpenRouter. This covers Codex and other OpenAI-compatible providers with `OPENAI_BASE_URL` set to OpenRouter, Claude Code with `ANTHROPIC_BASE_URL` set to OpenRouter, and harnesses running an `openrouter/` model.

## What it reads and sends

The plugin reads the keys above on the daemon host and sends them only to `openrouter.ai`, to `GET /api/v1/key` and `GET /api/v1/credits`. It never logs them, and stores them only in the key files above. Paseo refreshes the card at most every five minutes unless you refresh it.

## Limits

- Spend covers only the API key that is configured. Other keys on the account are counted in the account's credits but not in the spend rows.
- When OpenRouter rejects either key, the whole card shows the rejection.
