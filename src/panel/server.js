/**
 * 管理面板 —— Express 服务
 *
 * 提供 REST API + SSE 日志流。
 * 由 src/index.js 启动时挂载。
 */
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { loginHandler, authMiddleware } from './auth.js';
import { getBots, removeBot, getBotConfig } from '../auth.js';
import { getSessionCount, getBotSessionCount, SESSIONS_DIR } from '../session.js';
import { askClaude, createSessionId } from '../claude.js';
import {
  getConversations, getConversation, saveMessage, saveContextToken, sendReply,
  setClaudeSessionId, addConvSSEClient,
} from '../conversations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.resolve(__dirname, '../../panel-ui/dist');

// ---- 日志环形缓冲 ----

const MAX_LOG_ENTRIES = 500;
const logBuffer = [];
const logClients = new Set();

// 去除 ANSI 转义码（chalk 样式），用于日志面板显示纯文本
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * 向所有连接的 SSE 客户端推送日志
 */
export function pushLog(level, message) {
  const entry = { time: Date.now(), level, message };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_ENTRIES) logBuffer.shift();

  const payload = JSON.stringify(entry);
  for (const client of logClients) {
    try {
      client.write(`data: ${payload}\n\n`);
    } catch {
      logClients.delete(client);
    }
  }
}

/**
 * 拦截 console.log/error/warn 并将输出同时推送到日志流
 */
export function hookConsole() {
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;

  console.log = function (...args) {
    pushLog('info', stripAnsi(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')));
    return origLog.apply(console, args);
  };

  console.error = function (...args) {
    pushLog('error', stripAnsi(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')));
    return origError.apply(console, args);
  };

  console.warn = function (...args) {
    pushLog('warn', stripAnsi(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')));
    return origWarn.apply(console, args);
  };
}

// ---- 创建 Express 应用 ----

export function createPanel() {
  const app = express();

  app.use(cors());
  app.use(express.json());
  app.use(authMiddleware);

  // ---- API 路由 ----

  // 登录（不需要 authMiddleware 验证）
  app.post('/api/login', loginHandler);

  // 仪表盘
  app.get('/api/status', (req, res) => {
    const bots = getBots();
    const uptime = process.uptime();
    const mem = process.memoryUsage();
    res.json({
      bots: bots.length,
      botList: bots.map(b => ({
        id: b.id,
        nickname: b.nickname,
        sessions: getBotSessionCount(b.id),
      })),
      totalSessions: getSessionCount(),
      uptime,
      uptimeStr: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
      memoryMB: +(mem.rss / 1024 / 1024).toFixed(1),
      heapMB: +(mem.heapUsed / 1024 / 1024).toFixed(1),
    });
  });

  // Bot 列表
  app.get('/api/bots', (req, res) => {
    res.json(getBots());
  });

  // 删除 Bot
  app.delete('/api/bots/:id', (req, res) => {
    removeBot(req.params.id);
    res.json({ ok: true });
  });

  // Session 列表
  app.get('/api/sessions', (req, res) => {
    const userId = req.query.userId;

    const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
    const sessions = [];

    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf-8');
        const s = JSON.parse(raw);
        if (userId && !s.userId?.includes(userId)) continue;
        sessions.push({
          userId: s.userId,
          botId: s.botId,
          messageCount: s.messageCount || 0,
          selectedModel: s.selectedModel,
          pendingMedia: (s.pendingMedia || []).length,
          updatedAt: s.updatedAt,
          age: Date.now() - s.updatedAt,
        });
      } catch { /* skip corrupt */ }
    }

    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    res.json(sessions.slice(0, 200));
  });

  // ---- 对话记录 ----

  // 对话列表
  app.get('/api/conversations', (req, res) => {
    res.json(getConversations());
  });

  // 获取单条对话完整消息
  app.get('/api/conversations/:userId', (req, res) => {
    const conv = getConversation(req.params.userId);
    if (!conv) return res.status(404).json({ error: '对话不存在' });
    res.json(conv);
  });

  // 从管理面板聊天：由 Claude 回复，不转发到微信
  app.post('/api/conversations/:userId/send', async (req, res) => {
    const { text } = req.body || {};
    if (!text) return res.status(400).json({ error: '消息不能为空' });

    const userId = req.params.userId;
    let conv = getConversation(userId);
    if (!conv) return res.status(404).json({ error: '对话不存在' });

    // 保存用户消息
    saveMessage(conv.botId, userId, 'user', text);

    // 控制台日志：格式与微信消息一致
    const ts = chalk.dim(new Date().toLocaleTimeString('zh-CN', { hour12: false }));
    const botCfg = getBotConfig(conv.botId);
    const botTag = chalk.magenta(`[${botCfg?.nickname || '默认'}]`);
    const shortUser = userId.split('@')[0];
    const panelTag = chalk.cyan('[面板]');
    console.log(`\n${chalk.dim('───')} ${ts} ${botTag} ${panelTag} ${text.slice(0, 100)}`);

    // 首次对话创建 Claude session
    const isNew = !conv.claudeSessionId;
    if (isNew) {
      conv.claudeSessionId = createSessionId();
    }

    try {
      const { reply, sessionId } = await askClaude(conv.claudeSessionId, text, { isNew });

      // 更新 sessionId（可能因 resume 失败而新建）
      if (sessionId && sessionId !== conv.claudeSessionId) {
        conv.claudeSessionId = sessionId;
      }

      // 保存 Claude 回复
      saveMessage(conv.botId, userId, 'assistant', reply, { botName: 'Claude' });

      // 控制台日志：格式与微信回复一致
      console.log(chalk.dim(`  ${chalk.dim('│')} sending ${reply.length} chars to ${shortUser}...`));
      console.log(chalk.bold(`  ${chalk.dim('│')} sent success`));

      // 持久化 claudeSessionId
      setClaudeSessionId(userId, conv.claudeSessionId);

      res.json({ ok: true, reply });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 对话 SSE 实时流
  app.get('/api/conversations/:userId/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // 发送历史消息
    const conv = getConversation(req.params.userId);
    if (conv?.messages) {
      for (const msg of conv.messages) {
        res.write(`data: ${JSON.stringify({ type: 'message', ...msg })}\n\n`);
      }
    }

    addConvSSEClient(req.params.userId, res);
  });

  // SSE 日志流
  app.get('/api/logs', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // 发送历史日志
    for (const entry of logBuffer) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }

    logClients.add(res);
    req.on('close', () => logClients.delete(res));
  });

  // ---- 版本号 ----
  app.get("/api/version", (req, res) => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf-8"));
    res.json({ version: pkg.version });
  });
  // ---- 静态文件（前端） ----

  // 如果前端未构建，不影响 API
  if (fs.existsSync(path.join(STATIC_DIR, 'index.html'))) {
    app.use(express.static(STATIC_DIR));

    // SPA fallback
    app.get('/{*path}', (req, res) => {
      if (req.path.startsWith('/api/')) return;
      res.sendFile(path.join(STATIC_DIR, 'index.html'));
    });
  } else {
    // 前端未构建时，根路径显示提示
    app.get('/', (req, res) => {
      res.json({
        message: '管理面板前端未构建',
        hint: '请运行 cd panel-ui && npm install && npm run build',
        api: 'API 接口正常运行',
      });
    });
  }

  return app;
}
