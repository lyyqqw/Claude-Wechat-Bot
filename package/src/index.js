#!/usr/bin/env node

/**
 * Claude Code WeChat Bot — 主入口
 *
 * 架构:
 *   微信 ↔ iLink API ↔ 本 Bot ↔ Claude Code CLI (子进程)
 *
 * 每个微信用户拥有独立的 Claude Code 会话
 * (通过 claude --resume <session-id> -p 维持上下文)
 */
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';

import { loadConfig, login } from './auth.js';
import {
  getUpdates, sendText, sendImage, sendFile, sendTyping,
  extractText, extractMediaInfo, formatMessageLog, isGroupMessage,
  MESSAGE_TYPE,
} from './ilink.js';
import { askClaude, isResetCommand } from './claude.js';
import { getOrCreateSession, resetSession, incrementMessageCount, cleanExpiredSessions } from './session.js';
import { CONFIG_PATH, SESSIONS_DIR, DOTENV_PATH, ensureDataDirs } from './paths.js';

// ---- 配置 ----

// 从用户数据目录加载 .env（开发模式下回退到 cwd/.env）
if (fs.existsSync(DOTENV_PATH)) {
  dotenv.config({ path: DOTENV_PATH });
} else {
  dotenv.config();
}

const POLL_TIMEOUT = parseInt(process.env.POLL_TIMEOUT || '35', 10);

// Claude Code WeChat Bot 系统提示词
const WECHAT_SYSTEM_PROMPT = `你正在通过微信与用户对话。

注意:
1. 保持回答简洁清晰，适应手机端阅读
2. 代码用 Markdown 代码块展示
3. 如果用户请求涉及文件操作、代码执行等，直接执行即可（用户信任你）
4. 对于简短的问题，直接给出答案；复杂问题给出思路和方案
5. 用户发送 "reset"、"重置"、"新对话" 时，回复 "✅ 已开启新对话"

当用户发送图片或文件时，消息前缀会标注类型：
- "[图片]" — 用户发了一张图片，你可以描述它或询问用途
- "[文件] filename.ext" — 用户发了一个文件，你可以处理它的内容`;

// ---- 启动前检查 ----

function ensureConfig() {
  const config = loadConfig();
  if (!config.bot_token) {
    console.log(chalk.yellow('⚠️  未检测到 bot_token，需要先扫码登录微信\n'));
    return false;
  }
  console.log(chalk.green(`✅  Bot Token 已存在: ${config.bot_token.slice(0, 16)}...`));
  console.log(chalk.green(`✅  Base URL: ${config.bot_base_url}\n`));
  return true;
}

// ---- 优雅关闭 ----

let isShuttingDown = false;
const shutdownController = new AbortController();

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(chalk.yellow(`\n\n${signal} 收到，正在断开 iLink 连接...`));
  shutdownController.abort();
  // 给 in-flight 请求一点时间响应取消
  await new Promise(r => setTimeout(r, 300));
  console.log(chalk.green('✅ 已断开'));
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGBREAK', () => shutdown('SIGBREAK'));

// ---- 主循环 ----

async function mainLoop() {
  let updatesBuf = '';
  let pollErrors = 0;
  const MAX_POLL_ERRORS = 10;

  // 每小时清理一次过期会话
  setInterval(cleanExpiredSessions, 60 * 60 * 1000);

  console.log(chalk.cyan('📡 开始长轮询微信消息...\n'));

  while (true) {
    try {
      const result = await getUpdates(updatesBuf, POLL_TIMEOUT, shutdownController.signal);
      if (isShuttingDown) return;
      pollErrors = 0;

      updatesBuf = result.updatesBuf;

      for (const msg of result.msgs) {
        await handleMessage(msg);
      }

      // 无消息时打印心跳
      if (result.msgs.length === 0) {
        process.stdout.write(chalk.dim('.'));
      } else {
        process.stdout.write('\n');
      }
    } catch (err) {
      if (isShuttingDown) return;

      if (err.code === 'AUTH_EXPIRED') {
        console.log(chalk.red('\n❌ Bot token 已过期，需要重新登录\n'));
        await login();
        updatesBuf = '';
        continue;
      }

      pollErrors++;
      console.error(chalk.red(`\n❌ 轮询错误 (${pollErrors}/${MAX_POLL_ERRORS}): ${err.message}`));

      if (pollErrors >= MAX_POLL_ERRORS) {
        console.error(chalk.red('错误次数过多，退出'));
        process.exit(1);
      }

      // 渐进式退避
      await new Promise(r => setTimeout(r, Math.min(1000 * pollErrors, 15000)));
    }
  }
}

// ---- 消息处理 ----

async function handleMessage(msg) {
  const text = extractText(msg);
  if (!text) return;

  // 忽略群消息
  if (isGroupMessage(msg)) return;

  const fromUserId = msg.from_user_id;
  const contextToken = msg.context_token;
  const hasMedia = extractMediaInfo(msg) !== null;

  console.log('\n' + chalk.green('📩 收到消息: ') + formatMessageLog(msg));

  // 检测消息类型并记录详细信息
  if (hasMedia) {
    const mediaInfo = extractMediaInfo(msg);
    if (mediaInfo.type === MESSAGE_TYPE.IMAGE) {
      console.log(chalk.cyan(`  📷 图片消息`));
    } else if (mediaInfo.type === MESSAGE_TYPE.FILE) {
      console.log(chalk.cyan(`  📎 文件消息: ${mediaInfo.fileName} (${mediaInfo.fileSize} bytes)`));
    } else if (mediaInfo.type === MESSAGE_TYPE.VOICE) {
      console.log(chalk.cyan(`  🎤 语音消息`));
    } else if (mediaInfo.type === MESSAGE_TYPE.VIDEO) {
      console.log(chalk.cyan(`  🎬 视频消息`));
    }
  }

  try {
    // 发送"正在输入"状态
    await sendTyping(fromUserId, contextToken, true).catch(() => {});

    // 检查是否是重置命令
    if (isResetCommand(text)) {
      resetSession(fromUserId);
      await sendText(fromUserId, contextToken, '✅ 已开启新对话');
      return;
    }

    // 获取或创建 Claude Code 会话
    const session = getOrCreateSession(fromUserId);
    const isNew = session.messageCount === 0;

    // 调用 Claude Code CLI（首次用 --session-id，后续用 --resume）
    console.log(chalk.dim(`   用户会话: ${session.claudeSessionId.slice(0, 8)} (第 ${session.messageCount + 1} 条消息)`));

    let reply;
    let sessionId;

    try {
      ({ reply, sessionId } = await askClaude(
        session.claudeSessionId,
        text,
        { systemPrompt: WECHAT_SYSTEM_PROMPT, isNew },
      ));
    } catch (claudeErr) {
      // 断线恢复：--resume 找不到会话时，自动新建
      if (!isNew && (claudeErr.message.includes('No conversation found') || claudeErr.message.includes('already in use'))) {
        console.log(chalk.yellow('  ⚠️  Claude 会话丢失，自动创建新会话'));
        const newSession = resetSession(fromUserId);
        ({ reply, sessionId } = await askClaude(
          newSession.claudeSessionId,
          text,
          { systemPrompt: WECHAT_SYSTEM_PROMPT, isNew: true },
        ));
      } else {
        throw claudeErr;
      }
    }

    // 更新会话记录
    if (sessionId && sessionId !== session.claudeSessionId) {
      session.claudeSessionId = sessionId;
    }
    incrementMessageCount(fromUserId);

    // 分段发送回复
    console.log(chalk.dim(`  📤 发送回复 (${reply.length} 字符) 到 ${fromUserId.split('@')[0]}...`));
    await sendLongText(fromUserId, contextToken, reply);
    console.log(chalk.green('  ✅ 回复已发送'));
  } catch (err) {
    console.error(chalk.red(`❌ 处理消息失败: ${err.message}`));
    await sendText(fromUserId, contextToken, `😅 处理消息时出错了: ${err.message.slice(0, 100)}`).catch(() => {});
  }
}

/**
 * 分段发送长文本
 */
async function sendLongText(toUserId, contextToken, text, maxLen = 2000) {
  if (text.length <= maxLen) {
    await sendText(toUserId, contextToken, text);
    return;
  }

  const parts = splitIntoChunks(text, maxLen);
  for (let i = 0; i < parts.length; i++) {
    const header = parts.length > 1 ? `[${i + 1}/${parts.length}]\n` : '';
    await sendText(toUserId, contextToken, header + parts[i]);
    if (i < parts.length - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
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

// ---- 工具函数 ----

/**
 * 解析 claude 可执行文件和 bash 的完整路径
 * 解决 Windows 上 bash 脚本执行问题
 */
async function resolveClaudeBin() {
  let claudePath = null;

  // 1. 环境变量显式指定
  const explicit = process.env.CLAUDE_BIN;
  if (explicit && fs.existsSync(explicit)) {
    claudePath = explicit;
  }

  // 2. 在 npm 全局安装目录查找
  if (!claudePath) {
    const npmPrefixes = [];
    try {
      const { execFileSync } = await import('node:child_process');
      const prefix = execFileSync('npm.cmd', ['config', 'get', 'prefix'], { encoding: 'utf-8', shell: true }).trim();
      if (prefix) npmPrefixes.push(prefix);
    } catch { /* ignore */ }
    npmPrefixes.push(
      path.join(process.env.APPDATA || '', 'npm'),
      path.join(process.env.LOCALAPPDATA || '', 'npm'),
    );

    for (const dir of npmPrefixes) {
      for (const name of ['claude.cmd', 'claude', 'claude.exe']) {
        const full = path.join(dir, name);
        if (fs.existsSync(full)) { claudePath = full; break; }
      }
      if (claudePath) break;
    }
  }

  // 3. 在 PATH 中查找
  if (!claudePath) {
    const pathDirs = (process.env.PATH || '').split(path.delimiter);
    const pathext = (process.env.PATHEXT || '').split(path.delimiter);
    for (const dir of pathDirs) {
      const base = path.join(dir, 'claude');
      if (fs.existsSync(base)) { claudePath = base; break; }
      for (const ext of pathext) {
        const full = base + ext;
        if (fs.existsSync(full)) { claudePath = full; break; }
      }
      if (claudePath) break;
    }
  }

  if (!claudePath) return null;

  // 检测 claude 是否是 bash 脚本（无 .exe / .cmd 扩展名）
  // 如果是，需要找到 bash 来执行它
  const ext = path.extname(claudePath).toLowerCase();
  if (ext !== '.exe' && ext !== '.cmd') {
    // 可能是 bash 脚本，找 bash
    const bashPath = await resolveBash();
    if (bashPath) {
      process.env.CLAUDE_SHELL = bashPath;
    }
  }

  // 如果是 .cmd，shell: true (cmd.exe) 就能处理
  return claudePath;
}

/**
 * 在 Windows 上查找 bash（Git Bash 的 bash.exe）
 */
async function resolveBash() {
  const candidates = [
    'C:/Program Files/Git/bin/bash.exe',
    'C:/Program Files/Git/usr/bin/bash.exe',
    'C:/Program Files (x86)/Git/bin/bash.exe',
    'C:/msys64/usr/bin/bash.exe',
    'C:/cygwin64/bin/bash.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // 最后尝试 PATH 中的 bash
  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of pathDirs) {
    const full = path.join(dir, 'bash.exe');
    if (fs.existsSync(full)) return full;
  }
  return null;
}

/**
 * 迁移旧版数据（项目目录下的 config.json 和 sessions/）到新版用户数据目录
 */
async function migrateLegacyData() {
  const { fileURLToPath } = await import('node:url');
  const oldRoot = path.dirname(fileURLToPath(import.meta.url));
  const oldConfig = path.join(oldRoot, '..', 'config.json');
  const oldSessions = path.join(oldRoot, '..', 'sessions');

  // 迁移 config.json
  if (fs.existsSync(oldConfig) && !fs.existsSync(CONFIG_PATH)) {
    fs.copyFileSync(oldConfig, CONFIG_PATH);
    console.log(chalk.dim(`📦 已迁移配置: ${oldConfig} → ${CONFIG_PATH}`));
  }

  // 迁移 sessions/
  if (fs.existsSync(oldSessions) && fs.readdirSync(oldSessions).length > 0) {
    if (!fs.existsSync(SESSIONS_DIR)) {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    }
    for (const file of fs.readdirSync(oldSessions)) {
      const src = path.join(oldSessions, file);
      const dst = path.join(SESSIONS_DIR, file);
      if (!fs.existsSync(dst)) {
        fs.copyFileSync(src, dst);
      }
    }
    console.log(chalk.dim(`📦 已迁移会话: ${oldSessions} → ${SESSIONS_DIR}`));
  }
}

// ---- 启动 ----

async function main() {
  console.log(chalk.bold.cyan('\n╔══════════════════════════════════╗'));
  console.log(chalk.bold.cyan('║   Claude Code WeChat Bot v1.0   ║'));
  console.log(chalk.bold.cyan('║   基于 iLink Bot API 协议       ║'));
  console.log(chalk.bold.cyan('╚══════════════════════════════════╝\n'));

  // 确保数据目录存在，并迁移旧版数据
  ensureDataDirs();
  await migrateLegacyData();

  // 检查 claude CLI 是否可用
  const claudeBin = await resolveClaudeBin();
  if (!claudeBin) {
    console.error(chalk.red('❌  Claude Code CLI 未找到'));
    console.error(chalk.yellow('   当前 PATH:'));
    process.env.PATH?.split(path.delimiter).forEach(p => console.error(chalk.dim(`   - ${p}`)));
    console.error(chalk.yellow('\n   解决办法:'));
    console.error(chalk.yellow('   选项 1: 设置环境变量 CLAUDE_BIN=claude 再试'));
    console.error(chalk.yellow('   选项 2: npm install -g @anthropic/claude-code'));
    return;
  }
  // 将解析结果注入环境变量，claude.js 会用到
  process.env.CLAUDE_BIN = claudeBin;
  console.log(chalk.green(`✅  Claude Code CLI 已就绪: ${claudeBin}\n`));

  // 检查 token / 登录
  if (!ensureConfig()) {
    await login();
  }

  // 进入主循环
  await mainLoop();
}

main().catch(err => {
  console.error(chalk.red('\n❌ 程序异常退出:'), err);
  process.exit(1);
});
