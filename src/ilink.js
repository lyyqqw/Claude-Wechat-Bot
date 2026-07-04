/**
 * iLink Bot API 客户端
 * 实现腾讯微信 ClawBot 官方的 iLink 协议
 *
 * 协议文档: https://github.com/Tencent/openclaw-weixin
 */
import crypto from 'node:crypto';
import chalk from 'chalk';
import { getBots, getBotConfig } from './auth.js';

const API_BASE = 'https://ilinkai.weixin.qq.com';

/**
 * 解析 bot 配置：支持传入 botConfig 对象、botId 字符串、或 undefined（用第一个 Bot）
 * @param {object|string} [bot]
 * @returns {{ bot_token: string, bot_base_url: string, id: string }}
 */
function resolveBot(bot) {
  if (bot && typeof bot === 'object' && bot.bot_token) return bot;
  if (typeof bot === 'string') {
    const found = getBotConfig(bot);
    if (found) return found;
  }
  // 默认取第一个 Bot
  const bots = getBots();
  if (bots.length > 0) return bots[0];
  throw Object.assign(new Error('No bot configured, please login first'), { code: 'AUTH_MISSING' });
}

/**
 * 生成 iLink API 请求头
 * @param {object} botConfig - { bot_token, bot_base_url }
 */
function getHeaders(botConfig) {
  if (!botConfig || !botConfig.bot_token) {
    throw Object.assign(new Error('Bot token not configured, please login first'), { code: 'AUTH_MISSING' });
  }

  const uin = crypto.randomBytes(4).readUint32LE(0);
  const uinB64 = Buffer.from(String(uin)).toString('base64');

  return {
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'X-WECHAT-UIN': uinB64,
    'Authorization': `Bearer ${botConfig.bot_token}`,
  };
}

// ---- 消息类型常量 ----

export const MESSAGE_TYPE = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
};

/** 媒体类型（用于 getUploadUrl 的 media_type） */
export const MEDIA_TYPE = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4,
};

// ---- 通用请求 ----

async function apiPost(endpoint, body, options = {}, botConfig) {
  const bc = resolveBot(botConfig);
  const baseUrl = bc.bot_base_url || API_BASE;

  const controller = new AbortController();
  const timer = options.timeout
    ? setTimeout(() => controller.abort(), options.timeout)
    : undefined;

  const externalSignal = options.signal;
  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timer);
      throw new Error('Request aborted');
    }
    externalSignal.addEventListener('abort', () => {
      clearTimeout(timer);
      controller.abort();
    }, { once: true });
  }

  try {
    const resp = await fetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers: getHeaders(bc),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await resp.json();

    if (data.ret !== undefined && data.ret !== 0) {
      if (data.ret === 100012 || data.ret === 100013) {
        throw Object.assign(new Error('Bot token expired, please re-login'), { code: 'AUTH_EXPIRED' });
      }
      throw new Error(`${endpoint} failed: ${JSON.stringify(data)}`);
    }

    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`${endpoint} request timed out`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---- 消息轮询 ----

/**
 * 长轮询获取新消息
 *
 * @param {string} updatesBuf - 上游游标
 * @param {number} timeout - 长轮询超时（秒）
 * @param {AbortSignal} externalSignal - 外部关闭信号
 * @returns {{ msgs: Array, updatesBuf: string }}
 */
export async function getUpdates(updatesBuf = '', timeout = 35, externalSignal, botConfig) {
  const body = {
    get_updates_buf: updatesBuf,
    base_info: { channel_version: '1.0.2' },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), (timeout + 5) * 1000);

  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timer);
      return { msgs: [], updatesBuf };
    }
    externalSignal.addEventListener('abort', () => {
      clearTimeout(timer);
      controller.abort();
    }, { once: true });
  }

  try {
    const data = await apiPost('/ilink/bot/getupdates', body, {
      signal: controller.signal,
      timeout: (timeout + 5) * 1000,
    }, botConfig);

    return {
      msgs: data.msgs || [],
      updatesBuf: data.get_updates_buf || '',
    };
  } catch (err) {
    if (err.name === 'AbortError' || err.message.includes('timed out')) {
      return { msgs: [], updatesBuf };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---- 消息发送 ----

/**
 * 发送消息到微信
 */
export async function sendMessage({ toUserId, contextToken, items, botConfig }) {
  const clientId = `ccb-${crypto.randomUUID()}`;

  const body = {
    msg: {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: clientId,
      message_type: 2,
      message_state: 2,
      context_token: contextToken,
      item_list: items,
    },
    base_info: { channel_version: '1.0.2' },
  };

  return apiPost('/ilink/bot/sendmessage', body, {}, botConfig);
}

/**
 * 发送文本消息
 */
export async function sendText(toUserId, contextToken, text, botConfig) {
  return sendMessage({
    toUserId,
    contextToken,
    items: [{ type: MESSAGE_TYPE.TEXT, text_item: { text } }],
    botConfig,
  });
}

/**
 * 发送图片消息
 * 注意：图片需先通过 CDN 加密上传，此处仅发送 media 引用。
 * 完整发图流程请用 cdn.js 的 sendFileToUser()。
 */
export async function sendImage(toUserId, contextToken, mediaRef, botConfig) {
  // mediaRef: { encrypt_query_param, aes_key, encrypt_type }
  return sendMessage({
    toUserId,
    contextToken,
    items: [{
      type: MESSAGE_TYPE.IMAGE,
      image_item: {
        media: {
          encrypt_query_param: mediaRef.encrypt_query_param,
          aes_key: mediaRef.aes_key,
          encrypt_type: mediaRef.encrypt_type ?? 1,
        },
      },
    }],
    botConfig,
  });
}

/**
 * 发送文件消息
 * 注意：文件需先通过 CDN 加密上传，此处仅发送 media 引用。
 * 完整发文件流程请用 cdn.js 的 sendFileToUser()。
 */
export async function sendFile(toUserId, contextToken, fileData, botConfig) {
  // fileData: { encrypt_query_param, aes_key, encrypt_type, file_name, file_size }
  return sendMessage({
    toUserId,
    contextToken,
    items: [{
      type: MESSAGE_TYPE.FILE,
      file_item: {
        media: {
          encrypt_query_param: fileData.encrypt_query_param,
          aes_key: fileData.aes_key,
          encrypt_type: fileData.encrypt_type ?? 1,
        },
        file_name: fileData.file_name,
        len: String(fileData.file_size ?? 0),
      },
    }],
    botConfig,
  });
}

/**
 * 发送视频消息
 * 注意：视频需先通过 CDN 加密上传，此处仅发送 media 引用。
 * 完整发视频流程请用 cdn.js 的 sendFileToUser()。
 */
export async function sendVideo(toUserId, contextToken, videoData, botConfig) {
  // videoData: { encrypt_query_param, aes_key, encrypt_type, file_name, file_size }
  return sendMessage({
    toUserId,
    contextToken,
    items: [{
      type: MESSAGE_TYPE.VIDEO,
      video_item: {
        media: {
          encrypt_query_param: videoData.encrypt_query_param,
          aes_key: videoData.aes_key,
          encrypt_type: videoData.encrypt_type ?? 1,
        },
        file_name: videoData.file_name,
        file_size: String(videoData.file_size ?? 0),
      },
    }],
    botConfig,
  });
}

// ---- Typing 指示器 ----

/**
 * 获取账户配置（获取 typing_ticket）
 */
export async function getConfig(ilinkUserId, contextToken, botConfig) {
  const body = { ilink_user_id: ilinkUserId };
  if (contextToken) body.context_token = contextToken;

  return apiPost('/ilink/bot/getconfig', body, {}, botConfig);
}

// Typing ticket 缓存（5 分钟 TTL）
const typingTicketCache = {
  _map: new Map(),
  _ttl: 5 * 60 * 1000,
  get(uid) {
    const entry = this._map.get(uid);
    if (entry && entry.expiresAt > Date.now()) return entry.ticket;
    this._map.delete(uid);
    return null;
  },
  set(uid, ticket) {
    this._map.set(uid, { ticket, expiresAt: Date.now() + this._ttl });
  },
};

/**
 * 发送"正在输入..."状态
 */
export async function sendTyping(toUserId, contextToken, isTyping = true, botConfig) {
  try {
    let typingTicket = typingTicketCache.get(toUserId);
    if (!typingTicket) {
      try {
        const config = await getConfig(toUserId, contextToken, botConfig);
        if (config.typing_ticket) {
          typingTicket = config.typing_ticket;
          typingTicketCache.set(toUserId, typingTicket);
        }
      } catch {
        // getConfig 失败时静默继续，不带 ticket 尝试
      }
    }

    const body = { ilink_user_id: toUserId, context_token: contextToken, action: isTyping ? 'Typing' : 'Cancel' };
    if (typingTicket) body.typing_ticket = typingTicket;

    await apiPost('/ilink/bot/sendtyping', body, { timeout: 5000 }, botConfig);
  } catch (err) {
    // 静默忽略 sendTyping 失败 — 不影响消息处理流程
    if (!err.message.includes('timed out')) {
      console.error(chalk.dim(`  ${chalk.dim('│')} sendTyping failed: ${err.message}`));
    }
  }
}

// ---- CDN 上传 ----

/**
 * 获取 CDN 预签名上传地址
 */
export async function getUploadUrl({ fileKey, mediaType, toUserId, rawSize, rawFileMd5, fileSize, aesKeyHex, noNeedThumb, botConfig }) {
  const body = {
    filekey: fileKey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize: rawSize,
    rawfilemd5: rawFileMd5,
    filesize: fileSize,
    aeskey: aesKeyHex,
    base_info: { channel_version: '1.0.2' },
  };
  if (noNeedThumb) body.no_need_thumb = true;

  return apiPost('/ilink/bot/getuploadurl', body, {}, botConfig);
}

// ---- AES 加密工具 ----

/**
 * AES-128-ECB 加密（PKCS7 填充）
 * @param {Buffer} plaintext
 * @param {Buffer} key - 16 字节密钥
 * @returns {Buffer} 密文
 */
export function encryptAesEcb(plaintext, key) {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/**
 * 计算 PKCS7 填充后的密文长度
 */
export function aesEcbPaddedSize(plaintextSize) {
  return ((Math.floor(plaintextSize / 16)) + 1) * 16;
}

// ---- 消息解析 ----

/**
 * 从消息中提取可读文本，涵盖所有消息类型
 *
 * - 文本 -> 文本内容
 * - 图片 -> "[图片]"
 * - 文件 -> "[文件] filename"
 * - 语音 -> "[语音] 识别文本"
 * - 视频 -> "[视频]"
 */
export function extractText(message) {
  if (!message.item_list) return '';
  for (const item of message.item_list) {
    const itemType = item.type;
    if (itemType === MESSAGE_TYPE.TEXT && item.text_item?.text) {
      return item.text_item.text;
    }
    if (itemType === MESSAGE_TYPE.VOICE && item.voice_item?.text) {
      return `[语音] ${item.voice_item.text}`;
    }
    if (itemType === MESSAGE_TYPE.IMAGE) {
      return '[图片]';
    }
    if (itemType === MESSAGE_TYPE.FILE) {
      const fileName = item.file_item?.file_name || '';
      return `[文件] ${fileName}`.trim();
    }
    if (itemType === MESSAGE_TYPE.VIDEO) {
      return '[视频]';
    }
  }
  return '[空消息]';
}

/**
 * 从消息中提取媒体附件列表
 */
export function extractMedia(message) {
  if (!message.item_list) return [];
  return message.item_list.filter(item =>
    item.type === MESSAGE_TYPE.IMAGE ||
    item.type === MESSAGE_TYPE.FILE ||
    item.type === MESSAGE_TYPE.VOICE ||
    item.type === MESSAGE_TYPE.VIDEO
  );
}

/**
 * 提取消息中的媒体引用信息（含 CDN 下载参数）
 * @returns {{ type: number, media: object, fileName?: string, fileSize?: string } | null}
 */
export function extractMediaInfo(message) {
  if (!message.item_list) return null;
  for (const item of message.item_list) {
    const itemType = item.type;
    if (itemType === MESSAGE_TYPE.IMAGE && item.image_item?.media) {
      return { type: itemType, media: item.image_item.media };
    }
    if (itemType === MESSAGE_TYPE.FILE && item.file_item?.media) {
      return {
        type: itemType,
        media: item.file_item.media,
        fileName: item.file_item.file_name,
        fileSize: item.file_item.len,
      };
    }
    if (itemType === MESSAGE_TYPE.VOICE && item.voice_item?.media) {
      return { type: itemType, media: item.voice_item.media };
    }
    if (itemType === MESSAGE_TYPE.VIDEO && item.video_item?.media) {
      return { type: itemType, media: item.video_item.media };
    }
  }
  return null;
}

/**
 * 判断消息是否是群聊消息
 */
export function isGroupMessage(message) {
  return message.from_user_id?.endsWith('@chatroom');
}

/**
 * 格式化消息日志
 */
export function formatMessageLog(msg) {
  const from = msg.from_user_id?.split('@')[0] || 'unknown';
  const text = extractText(msg).slice(0, 60);
  const mediaCount = extractMedia(msg).length;
  let suffix = '';
  if (mediaCount > 0) suffix = chalk.dim(` [${mediaCount} media]`);
  return chalk.dim(`[${from}]`) + ` ${text}${suffix}`;
}
