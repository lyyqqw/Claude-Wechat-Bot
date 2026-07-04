/**
 * 对话会话管理
 *
 * 每个微信用户对应一个独立的 Claude Code 会话，映射关系:
 *   WeChat user_id → Claude Code session_uuid
 *
 * 首次消息使用 --session-id，后续使用 --resume 续传上下文。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createSessionId } from './claude.js';
import { SESSIONS_DIR, ensureDataDirs } from './paths.js';

// 会话空闲过期时间（2 小时）
const TTL_MS = 2 * 60 * 60 * 1000;

ensureDataDirs();

function sanitizeId(rawId) {
  return rawId.replace(/[^a-zA-Z0-9_@.-]/g, '_');
}

function sessionPath(userId) {
  return path.join(SESSIONS_DIR, `${sanitizeId(userId)}.json`);
}

/**
 * 获取或创建用户会话
 * @param {string} userId
 * @returns {{ userId: string, claudeSessionId: string, messageCount: number, createdAt: number, updatedAt: number }}
 */
export function getOrCreateSession(userId) {
  const sp = sessionPath(userId);
  try {
    const raw = fs.readFileSync(sp, 'utf-8');
    const session = JSON.parse(raw);
    if (Date.now() - session.updatedAt > TTL_MS) {
      return createNewSession(userId, sp);
    }
    return session;
  } catch {
    return createNewSession(userId, sp);
  }
}

function createNewSession(userId, sp) {
  const session = {
    userId,
    claudeSessionId: createSessionId(),
    messageCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  fs.writeFileSync(sp, JSON.stringify(session, null, 2));
  return session;
}

/**
 * 标记已发送一条消息
 */
export function incrementMessageCount(userId) {
  const sp = sessionPath(userId);
  try {
    const raw = fs.readFileSync(sp, 'utf-8');
    const session = JSON.parse(raw);
    session.messageCount = (session.messageCount || 0) + 1;
    session.updatedAt = Date.now();
    fs.writeFileSync(sp, JSON.stringify(session, null, 2));
    return session;
  } catch {
    return getOrCreateSession(userId);
  }
}

/**
 * 重置会话（生成新的 Claude session ID）
 */
export function resetSession(userId) {
  const sp = sessionPath(userId);
  const session = {
    userId,
    claudeSessionId: createSessionId(),
    messageCount: 0,
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
