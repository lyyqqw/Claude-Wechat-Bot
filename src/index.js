#!/usr/bin/env node

/**
 * Claude Code WeChat Bot — 主入口
 *
 * 架构: 微信 <-> iLink API <-> Bot (Claude Agent SDK) <-> Claude Code Agent
 */
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import chalk from 'chalk';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 读取版本号
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));

import { login, getBots } from './auth.js';
import { getUpdates, sendText, sendTyping, extractText, extractMedia, isGroupMessage } from './ilink.js';
import { askClaude, isResetCommand, isHelpCommand, isStatusCommand, isModelCommand, parseModelCommand, formatModelList, fetchModels } from './claude.js';
import { getOrCreateSession, resetSession, incrementMessageCount, saveSession, cleanExpiredSessions, getSessionCount, getBotSessionCount } from './session.js';
import { DOTENV_PATH, MEDIA_INCOMING_DIR, ensureDataDirs } from './paths.js';
import { processIncomingMedia, sendFileToUser } from './cdn.js';
import { saveMessage, saveContextToken, sendReply } from './conversations.js';

// ---- 配置 ----

if (fs.existsSync(DOTENV_PATH)) {
  dotenv.config({ path: DOTENV_PATH });
} else {
  dotenv.config();
}

const POLL_TIMEOUT = parseInt(process.env.POLL_TIMEOUT || '60', 10);

const WECHAT_SYSTEM_PROMPT = `你正在通过微信与用户对话。

注意:
1. 保持回答简洁清晰，适应手机端阅读
2. 代码用 Markdown 代码块展示
3. 如果用户请求涉及文件操作、代码执行等，直接执行即可（用户信任你）
4. 对于简短的问题，直接给出答案；复杂问题给出思路和方案
5. 用户发送 "reset"、"重置"、"新对话" 时，回复 "已开启新对话"
6. 如果用户发送了图片或文件，你可以在本地读取并处理它们
7. 当你需要发送文件、图片或视频给用户时，直接在回复中使用 [FILE:绝对路径] 标记，系统会自动识别类型并发送（例如 [FILE:C:/Users/X1365/Downloads/photo.jpg] 或 [FILE:C:/Users/X1365/Downloads/video.mp4]）
8. 回复时少使用emojy表情，避免过多使用感叹号等非正式符号，保持专业和清晰的语气
9. 发送文件/图片/视频规则（极其重要）：
   - 在回复末尾添加 [FILE:绝对路径] 标记
   - 路径必须使用正斜杠 / 而非反斜杠（反斜杠会导致路径解析失败）
   - 必须是完整绝对路径，例如 [FILE:C:/Users/X1365/Downloads/photo.jpg]
   - 系统自动根据扩展名判断类型：图片(.jpg/.png/...)、视频(.mp4/.mov/...)、文件
   - **禁止复制文件到工作目录**，直接使用文件的原始绝对路径
   - 多个文件用多个 [FILE:...] 标记`;

// 构建环境上下文，自动追加到每条消息末尾
function buildEnvContext() {
  const homeDir = os.homedir();
  return [
    '',
    '[环境信息]',
    `  用户主目录: ${homeDir}`,
    `  下载目录: ${path.join(homeDir, 'Downloads')}`,
    `  工作目录: ${process.cwd()}`,
    '引用本地文件时请使用完整绝对路径。',
  ].join('\n');
}

// ---- 工具: 时间戳 ----

function timestamp() {
  return chalk.dim(new Date().toLocaleTimeString('zh-CN', { hour12: false }));
}

function section(label) {
  return chalk.cyan(`[${label}]`);
}

// ---- 启动前检查 ----

function ensureConfig() {
  const bots = getBots();
  if (bots.length === 0) {
    console.log(` ${section('INIT')} No bot configured, need to scan QR code to login\n`);
    return false;
  }
  for (const bot of bots) {
    console.log(` ${section('INIT')} [${bot.nickname}] Bot token: ${bot.bot_token.slice(0, 16)}...`);
    console.log(` ${section('INIT')} [${bot.nickname}] Base URL:  ${bot.bot_base_url}`);
  }
  console.log('');
  return true;
}

function ensureClaudeEnv() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log(` ${section('INIT')} ANTHROPIC_API_KEY not set, will use saved claude login`);
  }
  return true;
}

// ---- 优雅关闭 ----

let isShuttingDown = false;
const shutdownController = new AbortController();

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  fs.writeSync(process.stdout.fd, `\n ${section('EXIT')} ${signal} received, disconnecting iLink...\n`);
  shutdownController.abort();
  fs.writeSync(process.stdout.fd, ` ${section('EXIT')} Disconnected\n`);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGBREAK', () => shutdown('SIGBREAK'));

// ---- 主循环 ----

async function botPollLoop(botConfig) {
  let updatesBuf = '';
  let pollErrors = 0;
  let pollFrame = 0;
  const MAX_POLL_ERRORS = 10;
  const botTag = chalk.magenta(`[${botConfig.nickname}]`);

  console.log(` ${section('POLL')} ${botTag} Long-polling for messages...`);

  while (true) {
    try {
      const result = await getUpdates(updatesBuf, POLL_TIMEOUT, shutdownController.signal, botConfig);
      if (isShuttingDown) return;
      pollErrors = 0;

      updatesBuf = result.updatesBuf;

      for (const msg of result.msgs) {
        await handleMessage(msg, botConfig);
      }

      if (result.msgs.length === 0) {
        // 静默等待，不输出任何提示
      } else {
        process.stdout.write('\n');
      }
    } catch (err) {
      if (isShuttingDown) return;

      if (err.code === 'AUTH_EXPIRED') {
        console.log(`\n ${section('AUTH')} ${botTag} Bot token expired, re-authenticating...\n`);
        await login(botConfig.nickname, botConfig.id);
        updatesBuf = '';
        continue;
      }

      pollErrors++;
      console.error(`\n ${section('ERROR')} ${botTag} Poll error (${pollErrors}/${MAX_POLL_ERRORS}): ${err.message}`);

      if (pollErrors >= MAX_POLL_ERRORS) {
        console.error(` ${section('FATAL')} ${botTag} Too many errors, stopping this bot`);
        return;
      }

      await new Promise(r => setTimeout(r, Math.min(1000 * pollErrors, 15000)));
    }
  }
}

async function mainLoop() {
  const bots = getBots();

  setInterval(cleanExpiredSessions, 60 * 60 * 1000);

  if (bots.length === 0) {
    console.log(` ${section('POLL')} No bots configured.\n`);
    return;
  }

  console.log(` ${section('POLL')} Starting ${bots.length} bot polling loop(s)...\n`);

  // 每个 Bot 独立轮询，一个 Bot 挂掉不影响其他
  const loops = bots.map(bot => botPollLoop(bot));
  await Promise.all(loops);
}

// ---- 消息处理 ----

async function handleMessage(msg, botConfig) {
  const text = extractText(msg);
  const mediaItems = extractMedia(msg);
  if (!text && mediaItems.length === 0) return;

  if (isGroupMessage(msg)) return;

  const fromUserId = msg.from_user_id;
  const contextToken = msg.context_token;
  const shortUser = fromUserId.split('@')[0];
  const botTag = chalk.magenta(`[${botConfig.nickname}]`);

  // 保存到对话记录（供管理面板查看）
  if (text) {
    saveMessage(botConfig.id, fromUserId, 'user', text);
  }
  saveContextToken(botConfig.id, fromUserId, contextToken);

  // 判断是否有用户输入的文字（非自动生成的 "[图片]" 等）
  const hasUserText = msg.item_list?.some(item => item.type === 1);

  // ---- 处理收到的附件 ----
  const incomingMedia = [];
  for (const item of mediaItems) {
    try {
      const result = await processIncomingMedia(item, fromUserId, MEDIA_INCOMING_DIR);
      incomingMedia.push(result);
      console.log(chalk.dim(`  ${chalk.dim('│')} media saved: ${path.relative(process.cwd(), result.filepath)} (${result.isImage ? 'image' : 'file'}, ${result.size} bytes)`));
    } catch (err) {
      console.error(chalk.dim(`  ${chalk.dim('│')} media download failed: ${err.message}`));
    }
  }

  // ---- 纯媒体消息（图片/文件无文字）：下载后缓冲，不触发 Claude ----
  if (!hasUserText && mediaItems.length > 0) {
    const session = getOrCreateSession(fromUserId, botConfig.id);
    session.pendingMedia = session.pendingMedia || [];
    for (const m of incomingMedia) {
      session.pendingMedia.push(m);
    }
    saveSession(fromUserId, botConfig.id, { pendingMedia: session.pendingMedia });
    const okCount = incomingMedia.length;
    const failCount = mediaItems.length - okCount;
    console.log(`  ${chalk.dim('│')} ${chalk.yellow('buffered')} ${okCount} media${failCount > 0 ? chalk.red(` (${failCount} failed)`) : ''}, waiting for text message`);
    console.log(`\n${chalk.dim('───')} ${timestamp()} [${chalk.green(shortUser)}] ${chalk.dim('(media buffered)')}`);
    saveMessage(botConfig.id, fromUserId, 'user', '', { media: incomingMedia.filter(m => m).map(m => ({ filepath: m.filepath, isImage: m.isImage, size: m.size })) });
    return;
  }

  // ---- 有文字的消息：拼接缓冲中的媒体路径 ----
  const session = getOrCreateSession(fromUserId, botConfig.id);
  session.pendingMedia = session.pendingMedia || [];
  const bufferedMedia = session.pendingMedia;
  const allMedia = [...bufferedMedia, ...incomingMedia];

  // 清空缓冲
  if (bufferedMedia.length > 0) {
    saveSession(fromUserId, botConfig.id, { pendingMedia: [] });
  }

  // 构建给 Claude 的完整消息文本
  let fullText = text || '';
  if (allMedia.length > 0) {
    const fileList = allMedia.map(m => `  - ${m.filepath} (${m.isImage ? 'image' : 'file'})`).join('\n');
    const prefix = bufferedMedia.length > 0
      ? `[The user previously sent media, now followed up with text:]\n`
      : `[The user sent the following attachments:]\n`;
    fullText += `\n\n${prefix}${fileList}\n\nYou can read these files to process them.`;
  }
  fullText += buildEnvContext();

  console.log(`\n${chalk.dim('───')} ${timestamp()} ${botTag} [${chalk.green(shortUser)}] ${text ? text.slice(0, 100) : chalk.dim('(media only)')}${bufferedMedia.length > 0 ? chalk.yellow(` +${bufferedMedia.length} buffered media`) : ''}`);

  try {
    await sendTyping(fromUserId, contextToken, true, botConfig);

    if (isResetCommand(text)) {
      resetSession(fromUserId, botConfig.id);
      await sendText(fromUserId, contextToken, 'Conversation reset, start a new session', botConfig);
      console.log(`  ${chalk.dim('│')} session reset`);
      return;
    }

    if (isModelCommand(text)) {
      const models = await fetchModels();
      if (models.length === 0) {
        await sendText(fromUserId, contextToken, '模型列表为空，请在 .env 中配置 CLAUDE_MODELS。', botConfig);
        return;
      }
      const targetModel = parseModelCommand(text, models);
      if (targetModel) {
        // 切换模型
        saveSession(fromUserId, botConfig.id, { selectedModel: targetModel });
        const model = models.find(m => m.id === targetModel);
        await sendText(fromUserId, contextToken, `已切换到 ${model.name}，下次对话生效。`, botConfig);
        console.log(`  ${chalk.dim('│')} model switched: ${targetModel}`);
      } else {
        // 列出模型
        const currentModel = session.selectedModel || process.env.CLAUDE_MODEL || '(未设置)';
        await sendText(fromUserId, contextToken, formatModelList(models, currentModel), botConfig);
      }
      return;
    }

    if (isHelpCommand(text)) {
      const help = [
        '可用命令：',
        '',
        '  /help          — 显示此帮助',
        '  /status        — Bot 运行状态',
        '  /stats         — 你的对话统计',
        '  /model [模型名] — 切换模型（/model 列出可用模型）',
        '  /reset         — 重置对话',
      ].join('\n');
      await sendText(fromUserId, contextToken, help, botConfig);
      console.log(`  ${chalk.dim('│')} help shown`);
      return;
    }

    if (isStatusCommand(text)) {
      const bots = getBots();
      const totalSessions = getSessionCount();
      const uptime = process.uptime();
      const uptimeStr = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s`;
      const mem = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
      const lines = [
        'Bot 状态',
        '',
        `  在线 Bot: ${bots.length}`,
        ...bots.map(b => `  • ${b.nickname} (${getBotSessionCount(b.id)} 个会话)`),
        `  总会话数: ${totalSessions}`,
        `  运行时间: ${uptimeStr}`,
        `  内存占用: ${mem} MB`,
      ];
      await sendText(fromUserId, contextToken, lines.join('\n'), botConfig);
      console.log(`  ${chalk.dim('│')} status shown`);
      return;
    }

    if (/^\/stats\b/i.test(text.trim())) {
      const createdAt = session.createdAt ? new Date(session.createdAt) : null;
      const age = createdAt ? `${Math.round((Date.now() - session.createdAt) / 60000)} 分钟` : '未知';
      const lines = [
        '你的对话统计',
        '',
        `  消息数: ${session.messageCount}`,
        `  当前模型: ${session.selectedModel || process.env.CLAUDE_MODEL || '默认'}`,
        `  会话已创建: ${age}`,
        `  缓冲媒体: ${(session.pendingMedia || []).length} 个`,
      ];
      await sendText(fromUserId, contextToken, lines.join('\n'), botConfig);
      console.log(`  ${chalk.dim('│')} stats shown`);
      return;
    }

    const isNew = session.messageCount === 0;

    console.log(chalk.dim(`  ${chalk.dim('│')} session: ${session.claudeSessionId.slice(0, 8)} (msg #${session.messageCount + 1})`));

    let reply;
    let sessionId;

    try {
      ({ reply, sessionId } = await askClaude(
        session.claudeSessionId,
        fullText,
        { systemPrompt: WECHAT_SYSTEM_PROMPT, isNew, model: session.selectedModel, botConfig },
      ));
    } catch (claudeErr) {
      if (!isNew && claudeErr.message.includes('No conversation found')) {
        console.log(`  ${chalk.dim('│')} session lost, creating new one`);
        const newSession = resetSession(fromUserId, botConfig.id);
        ({ reply, sessionId } = await askClaude(
          newSession.claudeSessionId,
          fullText,
          { systemPrompt: WECHAT_SYSTEM_PROMPT, isNew: true, model: session.selectedModel, botConfig },
        ));
      } else {
        throw claudeErr;
      }
    }

    if (sessionId && sessionId !== session.claudeSessionId) {
      session.claudeSessionId = sessionId;
    }
    incrementMessageCount(fromUserId, botConfig.id);

    // ---- 处理回复中的 [FILE:...] 标记 ----
    const { filePaths, cleanReply } = parseFileMarkers(reply);

    if (filePaths.length > 0) {
      console.log(chalk.dim(`  ${chalk.dim('│')} files to send: ${filePaths.length}`));
      for (const fp of filePaths) {
        try {
          const result = await sendFileToUser(fromUserId, contextToken, fp, botConfig);
          console.log(chalk.dim(`  ${chalk.dim('│')}   sent ${result.fileName} (${result.fileSize} bytes)`));
        } catch (err) {
          console.error(chalk.dim(`  ${chalk.dim('│')}   send file failed: ${err.message}`));
        }
      }
    }

    if (cleanReply) {
      console.log(`  ${chalk.dim('│')} sending ${cleanReply.length} chars to ${shortUser}...`);
      await sendLongText(fromUserId, contextToken, cleanReply, botConfig);
      console.log(`  ${chalk.dim('│')} sent`);
    }
  } catch (err) {
    console.error(`  ${chalk.red('error:')} ${err.message}`);
    await sendText(fromUserId, contextToken, `Error: ${err.message.slice(0, 100)}`, botConfig).catch(() => {});
  }
}

async function sendLongText(toUserId, contextToken, text, botConfig, maxLen = 2000) {
  if (text.length <= maxLen) {
    await sendText(toUserId, contextToken, text, botConfig);
    saveMessage(botConfig.id, toUserId, 'assistant', text, { botName: botConfig.nickname });
    return;
  }

  const parts = splitIntoChunks(text, maxLen);
  for (let i = 0; i < parts.length; i++) {
    const header = parts.length > 1 ? `[${i + 1}/${parts.length}]\n` : '';
    await sendText(toUserId, contextToken, header + parts[i], botConfig);
    if (i < parts.length - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  saveMessage(botConfig.id, toUserId, 'assistant', text, { botName: botConfig.nickname });
}

function splitIntoChunks(text, maxLen) {
  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf('\n\n', maxLen);
    if (splitAt < maxLen / 2) splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen / 2) splitAt = maxLen;

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trim();
  }

  return chunks;
}

/**
 * 从 Claude 回复中解析 [FILE:path] 标记并剥离
 *
 * 要求 Claude 返回绝对路径，此处仅做 resolve 后直接传递。
 */
function parseFileMarkers(text) {
  const regex = /\[FILE:([^\]]+)\]/g;
  const rawPaths = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    rawPaths.push(match[1].trim());
  }
  const cleanReply = text.replace(regex, '').trim();

  // 规范化路径：反斜杠转正斜杠（防止 Claude 输出反斜杠被 JSON/JS 吞掉），
  // 然后 path.normalize 转回当前平台的分隔符
  const filePaths = rawPaths.map(fp => {
    const normalized = fp.replace(/\\/g, '/');
    return path.normalize(normalized);
  });

  // Debug: 打印原始匹配和规范化结果
  if (rawPaths.length > 0) {
    rawPaths.forEach((raw, i) => {
      console.log(chalk.dim(`  ${chalk.dim('│')}   [FILE raw] "${raw}" -> "${filePaths[i]}"`));
    });
  }

  return { filePaths, cleanReply };
}

// ---- 启动 ----

async function main() {
  const divider = chalk.dim('─'.repeat(50));
  console.log(`\n${divider}`);
  console.log(`  Claude Code WeChat Bot v${pkg.version}`);
  console.log(`  Claude Agent SDK + iLink`);
  console.log(`${divider}\n`);

  ensureDataDirs();
  ensureClaudeEnv();

  if (!ensureConfig()) {
    await login();
  }

  // 启动管理面板（不阻塞 Bot 轮询）
  const { createPanel, hookConsole } = await import('./panel/server.js');
  hookConsole();
  const panelApp = createPanel();
  const PANEL_PORT = parseInt(process.env.PANEL_PORT || '3000', 10);
  panelApp.listen(PANEL_PORT, () => {
    console.log(` ${section('PANEL')} Management panel at http://localhost:${PANEL_PORT}`);
  });

  await mainLoop();
}

main().catch(err => {
  console.error(`\n ${section('FATAL')} ${err}`);
  process.exit(1);
});
