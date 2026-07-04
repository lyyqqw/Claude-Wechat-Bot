 # Claude Code WeChat Bot

 Bridge your WeChat personal account to Claude AI via Tencent's iLink Bot API. Users message a WeChat bot, which forwards requests to the Claude Agent SDK and sends replies back.

 ## Features

 - **WeChat ↔ Claude** — Real-time conversation between WeChat users and Claude AI
 - **Streaming replies** — Claude responses streamed back to WeChat via Agent SDK
 - **Multi-bot support** — Run multiple WeChat accounts simultaneously, each with independent polling
 - **Media handling** — Send and receive images, videos, voice messages, and files
 - **Management panel** — Web dashboard with real-time metrics, logs, and session management
 - **Multi-model** — Switch between Claude models dynamically via in-chat command
 - **Session persistence** — Per-user conversation history with automatic session management
 - **In-chat commands** — Control bot behavior directly from WeChat
 - **Conversation viewer** — Browse and send messages from the web panel
 - **CDN media** — Encrypted media upload/download via Tencent CDN

 ## Prerequisites

 - **Node.js** >= 18
 - A **WeChat personal account** (not WeCom/WeChat Work)
 - A **Tencent iLink Bot token** (obtained via QR code login flow)
 - An **Anthropic API key** or compatible proxy (DeepSeek, etc.)
 - Claude Agent SDK login (or ANTHROPIC_API_KEY environment variable)

 ## Quick Start

 ```bash
 # 1. Clone and install
 git clone https://github.com/your-username/claude-wechat-bot.git
 cd claude-wechat-bot
 npm install

 # 2. Install and build management panel
 npm run setup

 # 3. Configure environment
 cp .env.example .env
 # Edit .env with your ANTHROPIC_API_KEY, PANEL_USERNAME, PANEL_PASSWORD

 # 4. Login to WeChat bot
 npm run login
 # Scan the QR code with your WeChat

 # 5. Start
 npm start
 ```

 ## Configuration

 Copy `.env.example` to `.env` in the data directory and edit:

 | Variable | Required | Description |
 |---|---|---|
 | `ANTHROPIC_API_KEY` | Yes | Anthropic API key or proxy-compatible key |
 | `ANTHROPIC_BASE_URL` | No | API endpoint (for proxy/DeepSeek); defaults to Anthropic |
 | `CLAUDE_MODEL` | No | Default Claude model (default: `claude-sonnet-4-20250514`) |
 | `CLAUDE_MODELS` | No | Comma-separated available models for `/model` command |
 | `CLAUDE_TIMEOUT` | No | Request timeout in ms (default: 120000) |
 | `POLL_TIMEOUT` | No | Long-poll timeout in seconds (default: 60) |
 | `PANEL_PORT` | No | Panel port (default: 3000) |
 | `PANEL_USERNAME` | Yes | Management panel login username |
 | `PANEL_PASSWORD` | Yes | Management panel login password |
 | `CLAUDE_WECHAT_DATA_DIR` | No | Override data directory path |

 The `.env` file and all persistent data are stored in a platform-specific directory:
 - **Windows:** `%APPDATA%/claude-wechat-bot`
 - **Linux/macOS:** `~/.local/share/claude-wechat-bot` or `$XDG_DATA_HOME/claude-wechat-bot`

 Override with the `CLAUDE_WECHAT_DATA_DIR` environment variable.

 ## Commands

 ```bash
 npm start              # Start the bot + management panel
 npm run login          # Interactive QR code login (src/auth.js)
 npm run add-bot        # Bind another WeChat account (same as login)
 npm run setup          # Install + build frontend for the management panel
 npm run panel:install  # Install management panel dependencies
 npm run panel:build    # Build management panel frontend
 npm run panel:dev      # Start panel dev server (with Vite HMR on :5173)
 ```

 ## Management Panel

 A web dashboard at `http://localhost:3000` (configurable via `PANEL_PORT`).

 | Path | Page | Description |
 |---|---|---|
 | `/` | Dashboard | Bot status, sessions, real-time metrics, activity feed |
 | `/chat` | Chat | Browse and send messages in conversations |
 | `/bots` | Bot Management | List, add, delete WeChat bot accounts |
 | `/sessions` | Sessions | Browse active user sessions |
 | `/logs` | Logs | Real-time log stream with filtering |

 **Tech stack:** Express (in-process) + Vite + React + GSAP.

 ## In-Chat Commands

 Send these commands to the bot via WeChat:

 | Command | Action |
 |---|---|
 | `/help` | Show available commands |
 | `/status` | Show bot runtime status (bots, sessions, uptime, memory) |
 | `/stats` | Show your own conversation stats |
 | `/model` | List available models |
 | `/model <name>` | Switch model (e.g. `/model claude-sonnet-4-6`) |
 | `/reset` | Reset your conversation |

 ## Multi-Bot Support

 Multiple WeChat accounts run simultaneously with independent polling loops:

 ```bash
 npm run add-bot  # Scan QR code for additional WeChat accounts
 ```

 Each bot is fully isolated:
 - **API calls** — Every iLink API call carries the correct bot token
 - **Sessions** — Chat sessions are keyed by WeChat user ID (globally unique)
 - **Fault isolation** — One bot failing (auth expired, network error) does not affect others

 Bots are stored in `config.json` within the data directory. Legacy single-bot config auto-migrates on first load.

 ## Architecture

 ```
 WeChat user ←→ iLink Bot API ←→ src/index.js ←→ Claude Agent SDK (in-process)
                                     │
                                     ├── src/ilink.js    — iLink API client
                                     ├── src/cdn.js      — CDN media encrypt/upload/download
                                     ├── src/claude.js   — Claude Agent SDK wrapper (streaming)
                                     ├── src/session.js  — Per-user session persistence
                                     ├── src/auth.js     — QR login + token persistence
                                     ├── src/paths.js    — Cross-platform data directory paths
                                     └── src/panel/      — Web management panel (Express + React)
 ```

 ### Data Flow

 **Incoming message:** `getUpdates` → `extractText`/`extractMedia` → buffer media if no text → assemble prompt → `askClaude` → parse `[FILE:...]` markers → `sendFileToUser` for each → `sendLongText` for the rest.

 **Outgoing media:** All file types (images, videos, generic files) go through `sendFileToUser` which auto-detects type by extension.

 ## API Endpoints

 The management panel exposes a REST API (all routes require authentication):

 | Method | Path | Description |
 |---|---|---|
 | `POST` | `/api/login` | User login |
 | `GET` | `/api/status` | Bot runtime status |
 | `GET` | `/api/bots` | List bot accounts |
 | `DELETE` | `/api/bots/:id` | Remove a bot account |
 | `GET` | `/api/sessions` | List active sessions |
 | `GET` | `/api/conversations` | List conversations |
 | `GET` | `/api/conversations/:userId` | Get full conversation messages |
 | `POST` | `/api/conversations/:userId/send` | Send message via panel |
 | `GET` | `/api/conversations/:userId/stream` | SSE stream for conversation |
 | `GET` | `/api/logs` | SSE log stream |
 | `GET` | `/api/version` | Bot version |

 ## Two Codebases

 - **`src/`** — Production codebase (v2.x). Uses `@anthropic-ai/claude-agent-sdk` for in-process Claude queries with streaming output. What `npm start` runs.
 - **`package/src/`** — Standalone npm package (v1.x). Uses CLI subprocess instead of Agent SDK. Shares the same iLink protocol.

 ## Data Storage

 All persistent data is stored in the data directory:

 - `config.json` — Multi-bot configuration
 - `sessions/<user_id>.json` — Per-user Claude session data
 - `media/incoming/` — Downloaded media from incoming messages
 - `.env` — Environment overrides

 ## Project Structure

 ```
 claude-wechat-bot/
 ├── src/               # Production bot code
 │   ├── index.js       # Entry point, message routing
 │   ├── ilink.js       # iLink API client
 │   ├── cdn.js         # Media encrypt/upload/download
 │   ├── claude.js      # Claude Agent SDK wrapper
 │   ├── session.js     # Session persistence
 │   ├── auth.js        # QR code login
 │   ├── paths.js       # Data directory management
 │   ├── conversations.js  # Conversation storage + SSE
 │   └── panel/         # Web management panel
 │       ├── server.js  # Express API server
 │       └── auth.js    # Panel authentication (JWT)
 ├── panel-ui/          # React frontend
 │   └── src/           # React components and pages
 ├── package/src/       # Legacy v1.x package
 └── package.json
 ```

 ## Versioning

 This project follows structured versioning (`major.minor.patch`):

 - **Major (+1)** — Adding an important new feature or breaking change.
 - **Minor (+1)** — Adding a small feature, enhancement, or non-breaking improvement.
 - **Patch (+1)** — Fixing a bug.

 ## Coding Guidelines

 - No emoji in code, comments, logs, or user-facing messages.
 - Simplicity first — minimum code that solves the problem, no speculative abstractions.
 - Surgical changes — touch only what's needed, match existing style.
 - All file/image/video sending goes through `cdn.js:sendFileToUser` — no separate media functions.
 - AES key encoding: `Buffer.from(hexString, 'ascii').toString('base64')`.

 ## License

 MIT
