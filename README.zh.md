 # Claude Code WeChat Bot

 [English](README.md) | **中文**

 通过腾讯 iLink Bot API 将你的微信个人账号接入 Claude AI。用户向微信机器人发送消息，机器人将请求转发给 Claude Agent SDK 并回复。

 ## 功能特性

 - **微信 ↔ Claude** — 微信用户与 Claude AI 实时对话
 - **流式回复** — Claude 回复通过 Agent SDK 流式传输回微信
 - **多 Bot 支持** — 同时运行多个微信账号，各自独立轮询
 - **媒体处理** — 发送和接收图片、视频、语音消息和文件
 - **管理面板** — Web 仪表盘，实时监控、日志与会话管理
 - **多模型切换** — 通过微信内命令动态切换 Claude 模型
 - **会话持久化** — 每个用户自动管理对话历史
 - **聊天命令** — 直接在微信中控制 Bot 行为
 - **对话浏览** — 在 Web 面板中查看和发送消息
 - **CDN 媒体** — 通过腾讯 CDN 加密上传/下载媒体文件

 ## 前置要求

 - **Node.js** >= 18
 - 一个**微信个人账号**（非企业微信）
 - 一个**腾讯 iLink Bot Token**（通过二维码扫码流程获取）
 - 一个 **Anthropic API Key** 或兼容的代理（DeepSeek 等）
 - Claude Agent SDK 登录（或设置 ANTHROPIC_API_KEY 环境变量）

 ## 快速开始

 ```bash
 # 1. 克隆并安装
 git clone https://github.com/lyyqqw/Claude-Wechat-Bot.git
 cd Claude-Wechat-Bot
 npm install

 # 2. 安装并构建管理面板
 npm run setup

 # 3. 配置环境变量
 cp .env.example .env
 # 编辑 .env，填入 ANTHROPIC_API_KEY、PANEL_USERNAME、PANEL_PASSWORD

 # 4. 登录微信 Bot
 npm run login
 # 用微信扫描二维码

 # 5. 启动
 npm start
 ```

 ## 配置说明

 将 `.env.example` 复制到数据目录下的 `.env` 并编辑：

 | 变量 | 必填 | 说明 |
 |---|---|---|
 | `ANTHROPIC_API_KEY` | 是 | Anthropic API Key 或兼容代理的 Key |
 | `ANTHROPIC_BASE_URL` | 否 | API 地址（用于代理/DeepSeek）；默认为 Anthropic |
 | `CLAUDE_MODEL` | 否 | 默认 Claude 模型（默认：`claude-sonnet-4-20250514`） |
 | `CLAUDE_MODELS` | 否 | 可用模型列表（逗号分隔，用于 `/model` 命令） |
 | `CLAUDE_TIMEOUT` | 否 | 请求超时毫秒数（默认：120000） |
 | `POLL_TIMEOUT` | 否 | 长轮询超时秒数（默认：60） |
 | `PANEL_PORT` | 否 | 管理面板端口（默认：3000） |
 | `PANEL_USERNAME` | 是 | 管理面板登录用户名 |
 | `PANEL_PASSWORD` | 是 | 管理面板登录密码 |
 | `CLAUDE_WECHAT_DATA_DIR` | 否 | 自定义数据目录路径 |

 `.env` 文件及所有持久化数据存储在平台特定目录：
 - **Windows:** `%APPDATA%/claude-wechat-bot`
 - **Linux/macOS:** `~/.local/share/claude-wechat-bot` 或 `$XDG_DATA_HOME/claude-wechat-bot`

 可通过 `CLAUDE_WECHAT_DATA_DIR` 环境变量覆盖。

 ## 命令

 ```bash
 npm start              # 启动 Bot + 管理面板
 npm run login          # 交互式二维码登录 (src/auth.js)
 npm run add-bot        # 绑定另一个微信账号（同 login）
 npm run setup          # 安装 + 构建管理面板前端
 npm run panel:install  # 安装管理面板依赖
 npm run panel:build    # 构建管理面板前端
 npm run panel:dev      # 启动面板开发服务器（Vite HMR :5173）
 ```

 ## 管理面板

 Web 仪表盘，访问 `http://localhost:3000`（可通过 `PANEL_PORT` 配置）。

 | 路径 | 页面 | 说明 |
 |---|---|---|
 | `/` | 仪表盘 | Bot 状态、会话、实时指标、活动记录 |
 | `/chat` | 对话 | 浏览和发送对话消息 |
 | `/bots` | Bot 管理 | 列出、添加、删除微信 Bot 账号 |
 | `/sessions` | 会话 | 浏览活跃用户会话 |
 | `/logs` | 日志 | 实时日志流，支持过滤 |

 **技术栈：** Express（进程内）+ Vite + React + GSAP。

 ## 微信内命令

 向 Bot 发送以下命令：

 | 命令 | 作用 |
 |---|---|
 | `/help` | 显示可用命令 |
 | `/status` | 显示 Bot 运行状态（Bot 数、会话数、运行时间、内存） |
 | `/stats` | 显示你自己的对话统计 |
 | `/model` | 列出可用模型 |
 | `/model <名称>` | 切换模型（如 `/model claude-sonnet-4-6`） |
 | `/reset` | 重置对话 |

 ## 多 Bot 支持

 多个微信账号可同时运行，各自独立轮询：

 ```bash
 npm run add-bot  # 扫码添加更多微信账号
 ```

 每个 Bot 完全隔离：
 - **API 调用** — 每条 iLink API 请求携带正确的 Bot Token
 - **会话** — 聊天会话按微信用户 ID 关联（全局唯一）
 - **故障隔离** — 一个 Bot 失效（认证过期、网络错误）不影响其他 Bot

 Bot 配置存储在数据目录的 `config.json` 中。旧版单 Bot 配置会在首次加载时自动迁移。

 ## 架构

 ```
 微信用户 ←→ iLink Bot API ←→ src/index.js ←→ Claude Agent SDK (进程内)
                                     │
                                     ├── src/ilink.js    — iLink API 客户端
                                     ├── src/cdn.js      — CDN 媒体加密/上传/下载
                                     ├── src/claude.js   — Claude Agent SDK 封装（流式）
                                     ├── src/session.js  — 用户会话持久化
                                     ├── src/auth.js     — 二维码登录 + Token 持久化
                                     ├── src/paths.js    — 跨平台数据目录路径
                                     └── src/panel/      — Web 管理面板 (Express + React)
 ```

 ### 数据流

 **收消息：** `getUpdates` → `extractText`/`extractMedia` → 无文本则缓存媒体 → 拼装提示词 → `askClaude` → 解析 `[FILE:...]` 标记 → 逐个 `sendFileToUser` → `sendLongText` 发送其余内容。

 **发媒体：** 所有文件类型（图片、视频、普通文件）统一走 `sendFileToUser`，自动按扩展名判断类型。

 ## API 接口

 管理面板提供的 REST API（所有路由需登录认证）：

 | 方法 | 路径 | 说明 |
 |---|---|---|
 | `POST` | `/api/login` | 用户登录 |
 | `GET` | `/api/status` | Bot 运行状态 |
 | `GET` | `/api/bots` | 列出 Bot 账号 |
 | `DELETE` | `/api/bots/:id` | 删除 Bot 账号 |
 | `GET` | `/api/sessions` | 列出活跃会话 |
 | `GET` | `/api/conversations` | 列出对话 |
 | `GET` | `/api/conversations/:userId` | 获取完整对话消息 |
 | `POST` | `/api/conversations/:userId/send` | 通过面板发送消息 |
 | `GET` | `/api/conversations/:userId/stream` | SSE 对话实时流 |
 | `GET` | `/api/logs` | SSE 日志流 |
 | `GET` | `/api/version` | Bot 版本号 |

 ## 两套代码

 - **`src/`** — 生产代码（v2.x）。使用 `@anthropic-ai/claude-agent-sdk` 进行进程内 Claude 查询（流式输出）。`npm start` 运行此版本。
 - **`package/src/`** — 独立 npm 包（v1.x）。使用 CLI 子进程而非 Agent SDK。共享同一套 iLink 协议。

 ## 数据存储

 所有持久化数据存储在数据目录中：

 - `config.json` — 多 Bot 配置
 - `sessions/<user_id>.json` — 每个用户的 Claude 会话数据
 - `media/incoming/` — 下载的收消息媒体文件
 - `.env` — 环境变量配置

 ## 项目结构

 ```
 claude-wechat-bot/
 ├── src/               # Bot 生产代码
 │   ├── index.js       # 入口，消息路由
 │   ├── ilink.js       # iLink API 客户端
 │   ├── cdn.js         # 媒体加密/上传/下载
 │   ├── claude.js      # Claude Agent SDK 封装
 │   ├── session.js     # 会话持久化
 │   ├── auth.js        # 二维码登录
 │   ├── paths.js       # 数据目录管理
 │   ├── conversations.js  # 对话存储 + SSE
 │   └── panel/         # Web 管理面板
 │       ├── server.js  # Express API 服务
 │       └── auth.js    # 面板认证 (JWT)
 ├── panel-ui/          # React 前端
 │   └── src/           # React 组件和页面
 ├── package/src/       # 旧版 v1.x 包
 └── package.json
 ```

 ## 版本号规范

 本项目遵循结构化版本号（`major.minor.patch`）：

 - **Major (+1)** — 增加重要新功能或破坏性变更
 - **Minor (+1)** — 增加小功能、增强或非破坏性改进
 - **Patch (+1)** — 修复 Bug

 ## 编码规范

 - 代码、注释、日志和用户消息中不使用 emoji。
 - 简洁优先 — 用最少的代码解决问题，不做过度抽象。
 - 精准修改 — 只触碰必要部分，与现有风格保持一致。
 - 所有文件/图片/视频发送统一走 `cdn.js:sendFileToUser`，不另建媒体发送函数。
 - AES Key 编码方式：`Buffer.from(hexString, 'ascii').toString('base64')`。

 ## 许可证

 MIT
