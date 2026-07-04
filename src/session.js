/**
 * 对话会话管理
 *
 * 每个 (Bot, 微信用户) 对对应一个独立的 Claude Code 会话：
 *   botId + from_user_id → Claude Code session_uuid
 *
 * 首次消息使用 --session-id，后续使用 --resume 续传上下文。
 * botId 保证了不同微信 Bot 收到同一用户的消息时上下文隔离。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createSessionId } from './claude.js';
import { SESSIONS_DIR, ensureDataDirs } from './paths.js';
export { SESSIONS_DIR };

// 会话空闲过期时间（2 小时）
const TTL_MS = 2 * 60 * 60 * 1000;

ensureDataDirs();

function sanitizeId(rawId) {
  return rawId.replace(/[^a-zA-Z0-9_@.-]/g, '_');
}

function sessionPath(botId, userId) {
  const safeBot = sanitizeId(botId);
  const safeUser = sanitizeId(userId);
  return path.join(SESSIONS_DIR, `${safeBot}__${safeUser}.json`);
}

/**
 * 获取或创建用户会话
 * @param {string} userId
 * @param {string} botId - Bot 标识，同一用户经不同 Bot 发消息时隔离会话
 * @returns {{ userId: string, botId: string, claudeSessionId: string, messageCount: number, createdAt: number, updatedAt: number }}
 */
export function getOrCreateSession(userId, botId) {
  const sp = sessionPath(botId, userId);
  try {
    const raw = fs.readFileSync(sp, 'utf-8');
    const session = JSON.parse(raw);
    if (Date.now() - session.updatedAt > TTL_MS) {
      return createNewSession(userId, botId, sp);
    }
    return session;
  } catch {
    return createNewSession(userId, botId, sp);
  }
}

function createNewSession(userId, botId, sp) {
  const session = {
    userId,
    botId,
    claudeSessionId: createSessionId(),
    messageCount: 0,
    pendingMedia: [],
    selectedModel: undefined,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  fs.writeFileSync(sp, JSON.stringify(session, null, 2));
  return session;
}

export function saveSession(userId, botId, updates) {
  const sp = sessionPath(botId, userId);
  try {
    const raw = fs.readFileSync(sp, 'utf-8');
    const session = JSON.parse(raw);
    Object.assign(session, updates, { updatedAt: Date.now() });
    fs.writeFileSync(sp, JSON.stringify(session, null, 2));
    return session;
  } catch {
    return getOrCreateSession(userId, botId);
  }
}

/**
 * 标记已发送一条消息
 */
export function incrementMessageCount(userId, botId) {
  const sp = sessionPath(botId, userId);
  try {
    const raw = fs.readFileSync(sp, 'utf-8');
    const session = JSON.parse(raw);
    session.messageCount = (session.messageCount || 0) + 1;
    session.updatedAt = Date.now();
    fs.writeFileSync(sp, JSON.stringify(session, null, 2));
    return session;
  } catch {
    return getOrCreateSession(userId, botId);
  }
}

/**
 * 重置会话（生成新的 Claude session ID）
 */
export function resetSession(userId, botId) {
  const sp = sessionPath(botId, userId);
  // 保留用户的模型选择
  let selectedModel;
  try {
    const raw = fs.readFileSync(sp, 'utf-8');
    selectedModel = JSON.parse(raw).selectedModel;
  } catch {}
  const session = {
    userId,
    botId,
    claudeSessionId: createSessionId(),
    messageCount: 0,
    pendingMedia: [],
    selectedModel,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  fs.writeFileSync(sp, JSON.stringify(session, null, 2));
  return session;
}

/**
 * 清理过期会话
 */
export function cleanExpiredSessions() {
  const now = Date.now();
  for (const file of fs.readdirSync(SESSIONS_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf-8');
      const session = JSON.parse(raw);
      if (now - session.updatedAt > TTL_MS) {
        fs.unlinkSync(path.join(SESSIONS_DIR, file));
      }
    } catch {
      // ignore
    }
  }
}

/**
 * 获取总 session 数
 */
export function getSessionCount() {
  try {
    return fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

/**
 * 获取指定 Bot 的 session 数
 */
export function getBotSessionCount(botId) {
  const prefix = `${sanitizeId(botId)}__`;
  try {
    return fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json') && f.startsWith(prefix)).length;
  } catch {
    return 0;
  }
}
