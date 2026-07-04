# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Code WeChat Bot — bridges WeChat personal accounts to Claude via Tencent's iLink Bot API. Users message a WeChat bot, which forwards to Claude Agent SDK and replies back.

## Commands

```bash
npm start              # Start the bot + management panel
npm run login          # Interactive QR code login (src/auth.js)
npm run add-bot        # Bind another WeChat account (same as login)
npm run setup          # Install + build frontend for the management panel
npm run panel:install  # Install management panel dependencies
npm run panel:build    # Build management panel frontend
npm run panel:dev      # Start panel dev server (with Vite HMR)
```

No test suite, no build step for the bot itself. Pure ESM (`"type": "module"`), runs directly with Node.js ≥18.

## Management Panel

A Web dashboard at `http://localhost:3000` (configurable via `PANEL_PORT` in `.env`).

| Path | Page | Description |
|---|---|---|
| `/` | Dashboard | Bot status, sessions, real-time metrics, activity feed |
| `/bots` | Bot Management | List/add/delete WeChat bot accounts |
| `/sessions` | Sessions | Browse active user sessions |
| `/logs` | Logs | Real-time log stream with filtering |

Requires login — set `PANEL_USERNAME` and `PANEL_PASSWORD` in `.env`.

**Tech stack:** Express (in-process) + Vite + React + GSAP + SSR-compatible static build.

**First-time setup:**
```bash
npm run setup          # builds the panel frontend
npm start              # starts bot + panel
```

The frontend lives in `panel-ui/`. During development:
```bash
npm run panel:dev      # Vite dev server with HMR on :5173 → proxies /api to :3000
npm start              # bot + API backend on :3000

## In-Chat Commands

Users can send these commands to the bot via WeChat:

| Command | Action |
|---|---|
| `/help` | Show available commands |
| `/status` | Show bot runtime status (bots, sessions, uptime, memory) |
| `/stats` | Show your own conversation stats |
| `/model` | List available models |
| `/model <name>` | Switch to a model (e.g. `/model v4-flash`) |
| `/reset` | Reset your conversation |

## Architecture

```
WeChat user ←→ iLink Bot API ←→ src/index.js ←→ Claude Agent SDK (in-process)
                                    │
                                    ├── src/ilink.js    — iLink API client (getUpdates, sendMessage, sendTyping)
                                    ├── src/cdn.js      — CDN media encrypt/upload/download/send
                                    ├── src/claude.js   — Claude Agent SDK wrapper (streaming)
                                    ├── src/session.js  — per-user Claude session persistence
                                    ├── src/auth.js     — QR login + token persistence
                                    └── src/paths.js    — cross-platform data directory paths
```

**Data flow for incoming message:** `getUpdates` → `extractText`/`extractMedia` → buffer media if no text → assemble prompt → `askClaude` → parse `[FILE:...]` markers → `sendFileToUser` for each → `sendLongText` for the rest.

**Data flow for outgoing media:** `sendFileToUser` in `cdn.js` handles ALL file types (images, videos, generic files) through a single unified function. It auto-detects the file type by extension and uses the correct `media_type` + message `type` accordingly.

## Two Codebases

- **`src/`** — Production codebase (v2.0). Uses `@anthropic-ai/claude-agent-sdk` for in-process Claude queries with streaming output. This is what `npm start` runs.
- **`package/src/`** — Standalone npm package (v1.0). Uses CLI subprocess (`execFile('claude', ...)`) instead of the Agent SDK. Shares the same iLink protocol but is a separate implementation.

When making changes, work in `src/` unless explicitly targeting the package.

## iLink Protocol Key Details

- **Authentication:** `AuthorizationType: ilink_bot_token` header + `Bearer <bot_token>` + random `X-WECHAT-UIN` (base64 of random uint32).
- **`context_token`:** Must be passed back verbatim from inbound messages in every reply. Without it, messages don't reach the correct chat window.
- **`get_updates_buf`:** Opaque sync cursor. Save it, pass it back unchanged. Never parse or modify.
- **Media upload flow:** Generate 16-byte AES key → `getUploadUrl` (returns `upload_param`) → AES-128-ECB+PKCS7 encrypt → POST to CDN → read `x-encrypted-param` header as download credential → `aes_key` encoding = `base64(hex_string_ascii_bytes)`.
- **Media types:** `media_type` for `getUploadUrl`: 1=image, 2=video, 3=file, 4=voice. Message `item_list[].type`: 1=text, 2=image, 3=voice, 4=file, 5=video.

## Media Sending (cdn.js sendFileToUser)

This is the single entry point for sending any file. It auto-detects type by extension:

| Extensions | media_type | item type | item_key |
|---|---|---|---|
| `.jpg` `.jpeg` `.png` `.gif` `.bmp` `.webp` | 1 | 2 | `image_item` |
| `.mp4` `.mov` `.avi` `.mkv` `.webm` `.3gp` `.flv` `.wmv` | 2 | 5 | `video_item` |
| Everything else | 3 | 4 | `file_item` |

Do NOT create separate `sendImage()`/`sendVideo()` functions — use `sendFileToUser` for all media.

## Claude Integration

`src/claude.js` uses `@anthropic-ai/claude-agent-sdk`'s `query()` with streaming (`includePartialMessages: true`). Sessions are keyed by UUID — first message uses `sessionId`, subsequent use `resume`. If a resumed session is missing, it auto-creates a new one.

Claude's reply may contain `[FILE:absolute/path]` markers. `index.js` parses these, sends each file via `sendFileToUser`, then strips the markers from the text reply.

## Data Storage

All persistent data lives in a platform-specific directory (default: `%APPDATA%/claude-wechat-bot` on Windows):

- `config.json` — multi-bot config: `{ bots: [{ id, bot_token, bot_base_url, nickname }] }`
- `sessions/<user_id>.json` — per-user Claude session mapping + pendingMedia buffer
- `media/incoming/` — downloaded media from incoming messages
- `.env` — environment overrides (ANTHROPIC_API_KEY, CLAUDE_TIMEOUT, POLL_TIMEOUT, CLAUDE_MODEL, CLAUDE_MODELS)

Override with `CLAUDE_WECHAT_DATA_DIR` env var.

## Multi-Bot Support

Multiple WeChat accounts can run simultaneously. Each gets its own polling loop (`botPollLoop`) using separate bot tokens. Two accounts are fully isolated:

- **API calls** — every iLink API call carries the correct `botConfig`, ensuring messages from Bot A reply through Bot A's token
- **Sessions** — chat sessions are keyed by `from_user_id` (WeChat user ID), which is globally unique across accounts
- **One bot failing** (auth expired, network error) does not affect the others — only that bot's polling loop stops

### Adding a Second Bot

```bash
npm run add-bot
```

This runs the same QR-scan flow as `login`. The new bot token is appended to `config.json`'s `bots` array. On next `npm start`, both bots poll concurrently.

### Config Format (`config.json`)

```json
{
  "bots": [
    {
      "id": "bot_1",
      "bot_token": "xxx",
      "bot_base_url": "https://ilinkai.weixin.qq.com",
      "nickname": "默认",
      "createdAt": 1234567890
    },
    {
      "id": "bot_2",
      "bot_token": "yyy",
      "bot_base_url": "https://ilinkai.weixin.qq.com",
      "nickname": "Bot 2",
      "createdAt": 1234567891
    }
  ]
}
```

Legacy single-bot config (`bot_token` at root) auto-migrates on first load.

### iLink botConfig Parameter

All iLink API functions that make HTTP requests accept an optional last parameter `botConfig` (object `{ bot_token, bot_base_url, id }`). If omitted, they fall back to the first bot in the list, preserving backward compatibility for code that doesn't need multi-bot awareness.

## Versioning

This project follows structured versioning (`major.minor.patch`):

- **Major (+1)** — Adding an important new feature or breaking change.
- **Minor (+1)** — Adding a small feature, enhancement, or non-breaking improvement.
- **Patch (+1)** — Fixing a bug.

The current version is defined in `package.json` at the project root. Update it whenever a change is merged that falls into one of the categories above.

## Coding Guidelines

- **No emoji in any output.** Do not use emoji in code, comments, logs, or user-facing messages. Keep all output clean and professional.
- **Simplicity first.** Minimum code that solves the problem. No speculative abstractions.
- **Surgical changes.** Touch only what's needed. Match existing style. Don't refactor unrelated code.
- **No separate media functions.** All file/image/video sending goes through `cdn.js:sendFileToUser`. It handles type detection internally.
- **AES key encoding is specific:** `aes_key` in sendMessage = `Buffer.from(hexString, 'ascii').toString('base64')`. This is NOT the same as `Buffer.from(rawBytes).toString('base64')`.
