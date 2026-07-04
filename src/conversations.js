/**
 * 对话记录管理
 *
 * 持久化每个 (Bot, 微信用户) 的完整消息历史，
 * 并提供 SSE 推送以便前端实时同步。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';
import { sendText as ilinkSendText } from './ilink.js';

export const CONVERSATIONS_DIR = path.join(DATA_DIR, 'conversations');

function ensureDir() {
  if (!fs.existsSync(CONVERSATIONS_DIR)) {
    fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
  }
}

function convPath(botId, userId) {
  const sb = botId.replace(/[^a-zA-Z0-9_@.-]/g, '_');
  const su = userId.replace(/[^a-zA-Z0-9_@.-]/g, '_');
  return path.join(CONVERSATIONS_DIR, `${sb}__${su}.json`);
}

function loadConv(sp) {
  try {
    return JSON.parse(fs.readFileSync(sp, 'utf-8'));
  } catch {
    return null;
  }
}

// ---- SSE 推送 ----

const convClients = new Map(); // userId → Set<Response>

export function pushConvSSE(userId, data) {
  const clients = convClients.get(userId);
  if (!clients) return;
  const payload = JSON.stringify(data);
  for (const client of clients) {
    try {
      client.write(`data: ${payload}\n\n`);
    } catch {
      clients.delete(client);
    }
  }
}

export function addConvSSEClient(userId, res) {
  if (!convClients.has(userId)) convClients.set(userId, new Set());
  convClients.get(userId).add(res);
  res.on('close', () => {
    convClients.get(userId)?.delete(res);
  });
}

// ---- 消息写入 ----

/**
 * 保存一条消息到对话记录并推送到前端
 */
export function saveMessage(botId, userId, role, text, extra = {}) {
  ensureDir();
  const sp = convPath(botId, userId);
  let conv = loadConv(sp) || { botId, userId, messages: [], messageCount: 0 };
  const entry = { role, text, timestamp: Date.now(), ...extra };
  conv.messages.push(entry);
  conv.messageCount = (conv.messageCount || 0) + 1;
  conv.updatedAt = Date.now();
  fs.writeFileSync(sp, JSON.stringify(conv, null, 2));
  pushConvSSE(userId, { type: 'message', ...entry });
  return entry;
}

/**
 * 保存 context_token（发送回复时需要）
 */
export function saveContextToken(botId, userId, token) {
  ensureDir();
  const sp = convPath(botId, userId);
  let conv = loadConv(sp) || { botId, userId, messages: [], messageCount: 0 };
  conv.contextToken = token;
  conv.botId = botId;
  conv.updatedAt = Date.now();
  fs.writeFileSync(sp, JSON.stringify(conv, null, 2));
}

/**
 * 通过 Bot 向微信用户发送消息，同时保存到对话记录
 */
export async function sendReply(toUserId, contextToken, text, botConfig) {
  await ilinkSendText(toUserId, contextToken, text, botConfig);
  saveMessage(botConfig.id, toUserId, 'assistant', text, { botName: botConfig.nickname });
}

// ---- 读取 ----

export function getConversations() {
  ensureDir();
  const files = fs.readdirSync(CONVERSATIONS_DIR).filter(f => f.endsWith('.json'));
  const list = [];
  for (const file of files) {
    try {
      const conv = JSON.parse(fs.readFileSync(path.join(CONVERSATIONS_DIR, file), 'utf-8'));
      list.push({
        userId: conv.userId,
        botId: conv.botId,
        messageCount: conv.messageCount || 0,
        lastMessage: conv.messages?.[conv.messages.length - 1] || null,
        updatedAt: conv.updatedAt || 0,
      });
    } catch { /* skip */ }
  }
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  return list;
}

/**
 * 更新 claudeSessionId（用于 web 面板直接对话时持久化 session）
 */
export function setClaudeSessionId(userId, sessionId) {
  ensureDir();
  const files = fs.readdirSync(CONVERSATIONS_DIR).filter(f => f.endsWith('.json'));
  for (const file of files) {
    try {
      const sp = path.join(CONVERSATIONS_DIR, file);
      const conv = JSON.parse(fs.readFileSync(sp, 'utf-8'));
      if (conv.userId === userId) {
        conv.claudeSessionId = sessionId;
        conv.updatedAt = Date.now();
        fs.writeFileSync(sp, JSON.stringify(conv, null, 2));
        return true;
      }
    } catch { /* skip */ }
  }
  return false;
}

export function getConversation(userId) {
  ensureDir();
  const files = fs.readdirSync(CONVERSATIONS_DIR).filter(f => f.endsWith('.json'));
  for (const file of files) {
    try {
      const conv = JSON.parse(fs.readFileSync(path.join(CONVERSATIONS_DIR, file), 'utf-8'));
      if (conv.userId === userId) return conv;
    } catch { /* skip */ }
  }
  return null;
}
