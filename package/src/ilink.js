/**
 * iLink Bot API 客户端
 * 实现腾讯微信 ClawBot 官方的 iLink 协议
 *
 * 核心 API:
 *   - getUpdates   长轮询接收消息
 *   - sendMessage  发送消息
 *   - sendTyping   发送"正在输入"状态
 *   - sendImage    上传并发送图片
 *   - sendFile     上传并发送文件
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import chalk from 'chalk';
import { loadConfig } from './auth.js';

const API_BASE = 'https://ilinkai.weixin.qq.com';
const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

function getHeaders() {
  const config = loadConfig();
  // X-WECHAT-UIN: 随机 uint32，防重放攻击
  const uin = crypto.randomBytes(4).readUint32LE(0);
  const uinB64 = Buffer.from(String(uin)).toString('base64');

  return {
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'X-WECHAT-UIN': uinB64,
    'Authorization': `Bearer ${config.bot_token}`,
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

/** 媒体类型（用于 getUploadUrl） */
export const MEDIA_TYPE = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4,
};

// ---- 消息轮询 ----

/**
 * 长轮询获取新消息（类似 Telegram getUpdates）
 * @param {string} updatesBuf - 上游游标，首次为空字符串
 * @param {number} timeout - 长轮询超时（秒）
 * @returns {{ msgs: Array, updatesBuf: string }}
 */
export async function getUpdates(updatesBuf = '', timeout = 35, externalSignal) {
  const config = loadConfig();
  const baseUrl = config.bot_base_url || API_BASE;

  const body = {
    get_updates_buf: updatesBuf,
    base_info: { channel_version: '1.0.2' },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), (timeout + 5) * 1000);

  // 外部关闭信号（如 Ctrl+C）也触发请求取消
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
    const resp = await fetch(`${baseUrl}/ilink/bot/getupdates`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await resp.json();

    // ret 不存在或为 0 表示成功，存在且非 0 表示错误
    if (data.ret !== undefined && data.ret !== 0) {
      if (data.ret === 100012 || data.ret === 100013) {
        throw Object.assign(new Error('Bot token 已过期，请重新登录'), { code: 'AUTH_EXPIRED' });
      }
      throw new Error(`getUpdates 失败: ${JSON.stringify(data)}`);
    }

    return {
      msgs: data.msgs || [],
      updatesBuf: data.get_updates_buf || '',
    };
  } catch (err) {
    if (err.name === 'AbortError') {
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
 * @param {object} opts
 * @param {string} opts.toUserId  - 接收者 (from_user_id)
 * @param {string} opts.contextToken - 从 inbound 消息中获取的 context_token
 * @param {Array}  opts.items     - item_list 内容
 */
export async function sendMessage({ toUserId, contextToken, items }) {
  const config = loadConfig();
  const baseUrl = config.bot_base_url || API_BASE;

  // 随机 client_id，用于服务端消息去重 / 路由
  const clientId = `ccb-${crypto.randomUUID()}`;

  // message_type: 2 = 机器人发出的消息（1 = 用户发来的消息）
  // 这与 item_list[].type（表示内容类型）不同
  const BOT_MESSAGE_TYPE = 2;

  const body = {
    msg: {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: clientId,
      message_type: BOT_MESSAGE_TYPE,
      message_state: 2,
      context_token: contextToken,
      item_list: items,
    },
  };

  const resp = await fetch(`${baseUrl}/ilink/bot/sendmessage`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  });

  const text = await resp.text();
  console.log(`  [sendMessage HTTP ${resp.status}] body: ${text.slice(0, 100)}`);
  // 成功时可能返回空 {} 或空字符串
  if (!text || text === '{}') return { ret: 0 };

  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error(`sendMessage 非 JSON 响应 [${resp.status}]: ${text.slice(0, 200)}`);
  }

  if (data.ret !== undefined && data.ret !== 0) {
    throw new Error(`sendMessage 失败 [${resp.status}]: ${JSON.stringify(data)}`);
  }

  return data;
}

/**
 * 发送文本消息
 */
export async function sendText(toUserId, contextToken, text) {
  return sendMessage({
    toUserId,
    contextToken,
    items: [{ type: 1, text_item: { text } }],
  });
}

/**
 * 发送"正在输入..."状态
 */
export async function sendTyping(toUserId, contextToken, isTyping = true) {
  const config = loadConfig();
  const baseUrl = config.bot_base_url || API_BASE;

  const body = {
    to_user_id: toUserId,
    context_token: contextToken,
    action: isTyping ? 'Typing' : 'Cancel',
  };

  const resp = await fetch(`${baseUrl}/ilink/bot/sendtyping`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  });
  return resp.json();
}

// ---- 消息解析 ----

/**
 * 从消息中提取可读文本，涵盖所有消息类型
 *
 * - 文本消息 → 返回文本内容
 * - 图片消息 → "[图片]"
 * - 文件消息 → "[文件] filename"
 * - 语音消息 → "[语音] 识别文本"
 * - 视频消息 → "[视频]"
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
 * 提取消息中的媒体信息（用于转发/下载）
 * @returns {{ type: number, media: object, fileName?: string } | null}
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
  return chalk.dim(`[${from}]`) + ` ${text}`;
}

// ---- AES 加密工具 ----

/**
 * AES-128-ECB 加密（PKCS7 填充）
 * @param {Buffer} plaintext - 明文数据
 * @param {Buffer} key - 16 字节密钥
 * @returns {Buffer} 密文
 */
export function encryptAesEcb(plaintext, key) {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/**
 * 计算 PKCS7 填充后的密文长度
 * @param {number} plaintextSize
 * @returns {number}
 */
export function aesEcbPaddedSize(plaintextSize) {
  return ((Math.floor(plaintextSize / 16)) + 1) * 16;
}

// ---- CDN 上传流程 ----

/**
 * 获取 CDN 上传地址和参数
 *
 * @param {object} opts
 * @param {string} opts.filekey       - 32 字符随机十六进制字符串
 * @param {number} opts.mediaType     - 1=图片 2=视频 3=文件 4=语音
 * @param {string} opts.toUserId      - 接收者 user_id
 * @param {number} opts.rawsize       - 原始文件大小（字节）
 * @param {string} opts.rawfilemd5    - 原始文件 MD5（十六进制）
 * @param {number} opts.filesize      - PKCS7 填充后密文大小
 * @param {string} opts.aeskeyHex     - AES 密钥十六进制
 * @param {boolean} [opts.noNeedThumb] - 是否需要缩略图（图片建议 true）
 */
export async function getUploadUrl({ filekey, mediaType, toUserId, rawsize, rawfilemd5, filesize, aeskeyHex, noNeedThumb = false }) {
  const config = loadConfig();
  const baseUrl = config.bot_base_url || API_BASE;

  const body = {
    filekey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    aeskey: aeskeyHex,
  };
  if (noNeedThumb) body.no_need_thumb = true;

  const resp = await fetch(`${baseUrl}/ilink/bot/getuploadurl`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  });

  const data = await resp.json();
  if (data.ret !== undefined && data.ret !== 0) {
    throw new Error(`getUploadUrl 失败: ${JSON.stringify(data)}`);
  }
  if (!data.upload_param) {
    throw new Error(`getUploadUrl 未返回 upload_param: ${JSON.stringify(data)}`);
  }
  return data;
}

/**
 * 上传加密数据到微信 CDN
 *
 * @param {Buffer} ciphertext   - AES-128-ECB 加密后的数据
 * @param {string} uploadParam  - 从 getUploadUrl 获取的 upload_param
 * @param {string} filekey      - 32 字符随机十六进制字符串
 * @returns {Promise<string>}   download_param（x-encrypted-param）
 */
export async function uploadToCDN(ciphertext, uploadParam, filekey) {
  const query = new URLSearchParams({
    encrypted_query_param: uploadParam,
    filekey,
  }).toString();
  const url = `${CDN_BASE_URL}/upload?${query}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: ciphertext,
    });

    if (resp.ok) {
      const encryptedParam = resp.headers.get('x-encrypted-param');
      if (!encryptedParam) {
        throw new Error('CDN 上传成功但响应头缺少 x-encrypted-param');
      }
      return encryptedParam;
    }

    // 4xx 不重试
    if (resp.status >= 400 && resp.status < 500) {
      const errBody = await resp.text().catch(() => '');
      throw new Error(`CDN 上传失败 HTTP ${resp.status}: ${errBody.slice(0, 200)}`);
    }

    // 5xx 重试
    console.warn(`  ⚠️ CDN 上传 HTTP ${resp.status}，重试 (${attempt + 1}/3)`);
    await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
  }
  throw new Error('CDN 上传失败：所有重试均已耗尽');
}

// ---- 完整媒体上传（内部） ----

/**
 * 完整媒体上传流程：读文件 → 加密 → 获取上传地址 → CDN 上传
 *
 * @param {object} opts
 * @param {string} opts.toUserId
 * @param {string} opts.filePath    - 本地文件路径
 * @param {number} opts.mediaType   - 1=图片 2=视频 3=文件 4=语音
 * @param {boolean} [opts.noNeedThumb]
 * @returns {Promise<{ downloadParam: string, aeskey: Buffer, fileSize: number, fileName: string }>}
 */
async function uploadMedia({ toUserId, filePath, mediaType, noNeedThumb = false }) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`);
  }

  const plaintext = fs.readFileSync(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash('md5').update(plaintext).digest('hex');
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString('hex'); // 32 hex chars
  const aeskey = crypto.randomBytes(16);

  console.log(`  📤 上传媒体: ${path.basename(filePath)} (${(rawsize / 1024).toFixed(1)} KB, media_type=${mediaType})`);

  const uploadResp = await getUploadUrl({
    filekey,
    mediaType,
    toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    aeskeyHex: aeskey.toString('hex'),
    noNeedThumb,
  });

  const ciphertext = encryptAesEcb(plaintext, aeskey);
  const downloadParam = await uploadToCDN(ciphertext, uploadResp.upload_param, filekey);

  return {
    downloadParam,
    aeskey,
    fileSize: rawsize,
    fileName: path.basename(filePath),
  };
}

// ---- 媒体发送接口 ----

/**
 * 发送图片消息（自动完成加密上传）
 *
 * @param {string} toUserId
 * @param {string} contextToken
 * @param {string} filePath - 本地图片文件路径
 */
export async function sendImage(toUserId, contextToken, filePath) {
  const { downloadParam, aeskey } = await uploadMedia({
    toUserId,
    filePath,
    mediaType: MEDIA_TYPE.IMAGE,
    noNeedThumb: true,
  });

  // 关键：aes_key 先转 hex 字符串，再 base64 编码
  const aesKeyBase64 = Buffer.from(aeskey.toString('hex'), 'utf-8').toString('base64');

  return sendMessage({
    toUserId,
    contextToken,
    items: [{
      type: MESSAGE_TYPE.IMAGE,
      image_item: {
        media: {
          encrypt_query_param: downloadParam,
          aes_key: aesKeyBase64,
          encrypt_type: 1,
        },
      },
    }],
  });
}

/**
 * 发送文件消息（自动完成加密上传）
 *
 * @param {string} toUserId
 * @param {string} contextToken
 * @param {string} filePath - 本地文件路径
 * @param {object} [opts]
 * @param {string} [opts.text] - 附带文本（iLink 文本与文件需分开发送）
 */
export async function sendFile(toUserId, contextToken, filePath, { text } = {}) {
  const { downloadParam, aeskey, fileSize, fileName } = await uploadMedia({
    toUserId,
    filePath,
    mediaType: MEDIA_TYPE.FILE,
  });

  const aesKeyBase64 = Buffer.from(aeskey.toString('hex'), 'utf-8').toString('base64');

  // iLink 不支持同一 msg 混用 text + file，需分两条发送
  if (text) {
    await sendText(toUserId, contextToken, text);
  }

  return sendMessage({
    toUserId,
    contextToken,
    items: [{
      type: MESSAGE_TYPE.FILE,
      file_item: {
        media: {
          encrypt_query_param: downloadParam,
          aes_key: aesKeyBase64,
          encrypt_type: 1,
        },
        file_name: fileName,
        len: String(fileSize),
      },
    }],
  });
}

// ---- 工具函数 ----

/**
 * 将 URL 内容下载到临时文件
 *
 * @param {string} url
 * @returns {Promise<string>} 临时文件路径
 */
export async function downloadToTempFile(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`下载失败 HTTP ${resp.status}: ${url.slice(0, 100)}`);

  const buffer = Buffer.from(await resp.arrayBuffer());
  const contentType = resp.headers.get('content-type') || '';
  const ext = guessExtension(contentType) || '.bin';

  const tmpDir = path.join(os.tmpdir(), 'claude-wechat');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, `download-${crypto.randomUUID()}${ext}`);
  fs.writeFileSync(tmpPath, buffer);

  return tmpPath;
}

const MIME_EXT_MAP = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/x-msvideo': '.avi',
  'video/x-matroska': '.mkv',
  'video/webm': '.webm',
  'video/3gpp': '.3gp',
  'text/plain': '.txt',
  'text/html': '.html',
  'application/json': '.json',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
};

function guessExtension(mimeType) {
  const base = mimeType.split(';')[0].trim();
  return MIME_EXT_MAP[base] || null;
}
