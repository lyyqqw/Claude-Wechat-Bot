/**
 * 微信 CDN 媒体文件处理
 *
 * 腾讯 iLink 协议中，所有图片/文件/语音/视频均通过 CDN 传输，
 * 并使用 AES-128-ECB 加密存储。
 *
 * 上传流程:
 *   1. 生成随机 AES-128 密钥
 *   2. 使用 AES-128-ECB + PKCS7 填充加密文件
 *   3. 调用 getUploadUrl 获取 CDN 预签名上传地址
 *   4. POST 加密数据到 CDN
 *   5. 将 aes_key + CDN 引用加入 sendMessage
 *
 * CDN 域名: https://novac2c.cdn.weixin.qq.com/c2c
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';

// 从 ilink 引入 API 调用函数（运行时按需导入，避免启动时强制校验 token）
let _ilink;
async function getIlink() {
  if (!_ilink) _ilink = await import('./ilink.js');
  return _ilink;
}

// ---- 文件类型检测 ----

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.3gp', '.flv', '.wmv']);

function isImageFile(filePath) {
  return IMAGE_EXT.has(path.extname(filePath).toLowerCase());
}

function isVideoFile(filePath) {
  return VIDEO_EXT.has(path.extname(filePath).toLowerCase());
}

// ---- 统一媒体类型配置 ----

const MEDIA_KINDS = {
  image: {
    label: 'image',
    mediaType: 1,   // getUploadUrl media_type
    itemType: 2,    // sendMessage item type
    itemKey: 'image_item',
    noNeedThumb: true,
    isImage: true,
    isVideo: false,
  },
  video: {
    label: 'video',
    mediaType: 2,
    itemType: 5,
    itemKey: 'video_item',
    noNeedThumb: true,
    isImage: false,
    isVideo: true,
  },
  file: {
    label: 'file',
    mediaType: 3,
    itemType: 4,
    itemKey: 'file_item',
    noNeedThumb: false,
    isImage: false,
    isVideo: false,
  },
};

function detectMediaKind(filePath) {
  if (isImageFile(filePath)) return MEDIA_KINDS.image;
  if (isVideoFile(filePath)) return MEDIA_KINDS.video;
  return MEDIA_KINDS.file;
}

// ---- AES 加密/解密 ----

/**
 * AES-128-ECB 解密（PKCS7 填充）
 * 用于解密从 CDN 下载的媒体文件
 */
function decryptAesEcb(ciphertext, key) {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * 从 Base64 编码的 aes_key 解析出原始密钥
 * 兼容两种格式:
 *   - 新格式: base64(hex_string) → 解码后 32 字节 ASCII hex
 *   - 旧格式: base64(raw_key) → 直接 16 字节
 */
function parseAesKey(aesKeyB64) {
  const decoded = Buffer.from(aesKeyB64, 'base64');
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  if (decoded.length === 16) {
    return decoded;
  }
  throw new Error(`AES key length unexpected: ${decoded.length} bytes`);
}

/**
 * 生成文件 MD5（用于 CDN 上传验证）
 */
function fileMD5(data) {
  return crypto.createHash('md5').update(data).digest('hex');
}

// ---- CDN 上传/下载 ----

function buildUploadUrl(uploadResult, fileKey) {
  if (uploadResult.upload_full_url) {
    return uploadResult.upload_full_url;
  }
  if (!uploadResult.upload_param) {
    throw new Error(`getUploadUrl missing upload url: ${JSON.stringify(uploadResult).slice(0, 200)}`);
  }
  const query = new URLSearchParams({
    encrypted_query_param: uploadResult.upload_param,
    filekey: fileKey,
  });
  return `https://novac2c.cdn.weixin.qq.com/c2c/upload?${query.toString()}`;
}

/**
 * 上传加密文件到微信 CDN
 * @returns {Promise<string>} x-encrypted-param (download credential)
 */
async function uploadToCDN(uploadResult, ciphertext, fileKey) {
  const cdnUrl = buildUploadUrl(uploadResult, fileKey);

  const resp = await fetch(cdnUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Accept-Encoding': 'identity',
    },
    body: ciphertext,
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`CDN upload failed: HTTP ${resp.status} — ${body.slice(0, 200)}`);
  }

  const downloadParam = resp.headers.get('x-encrypted-param');
  if (!downloadParam) {
    throw new Error('CDN response missing x-encrypted-param header');
  }
  return downloadParam;
}

/**
 * 从微信 CDN 下载加密文件
 *
 * 必须发送 Accept-Encoding: identity 阻止 CDN 返回 gzip 压缩数据，
 * 否则 fetch 自动解密会破坏加密二进制内容。
 */
async function downloadFromCDN(cdnKey) {
  const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';
  let url;

  if (typeof cdnKey === 'string' && cdnKey.length > 64) {
    url = `${CDN_BASE}/download?encrypted_query_param=${encodeURIComponent(cdnKey)}`;
  } else if (typeof cdnKey === 'string') {
    url = `${CDN_BASE}/${cdnKey}`;
  } else if (cdnKey?.fullUrl) {
    url = cdnKey.fullUrl;
  } else {
    throw new Error('downloadFromCDN: invalid args');
  }

  const resp = await fetch(url, {
    method: 'GET',
    headers: { 'Accept-Encoding': 'identity' },
  });
  if (!resp.ok) {
    throw new Error(`CDN download failed: HTTP ${resp.status} — ${url.slice(0, 100)}`);
  }

  return Buffer.from(await resp.arrayBuffer());
}

// ---- 发送媒体到用户 ----

/**
 * 上传本地文件并构建发送用的 media item
 */
async function uploadMedia(toUserId, filepath, kind, botConfig) {
  const fileData = await fs.readFile(filepath);
  const fileName = path.basename(filepath);
  const plaintextSize = fileData.length;

  const ilink = await getIlink();
  const aesKeyRaw = crypto.randomBytes(16);
  const aesKeyHex = aesKeyRaw.toString('hex');
  const ciphertext = ilink.encryptAesEcb(fileData, aesKeyRaw);
  const fileKey = crypto.randomBytes(16).toString('hex');

  const uploadResult = await ilink.getUploadUrl({
    fileKey,
    mediaType: kind.mediaType,
    toUserId,
    rawSize: plaintextSize,
    rawFileMd5: fileMD5(fileData),
    fileSize: ciphertext.length,
    aesKeyHex,
    noNeedThumb: kind.noNeedThumb,
    botConfig,
  });

  const downloadParam = await uploadToCDN(uploadResult, ciphertext, fileKey);

  return {
    fileName,
    fileSize: plaintextSize,
    downloadParam,
    aesKeyBase64: Buffer.from(aesKeyHex, 'ascii').toString('base64'),
  };
}

/**
 * 构建 sendMessage 用的 media item
 */
function buildMediaItem(kind, uploaded) {
  const mediaRef = {
    encrypt_query_param: uploaded.downloadParam,
    aes_key: uploaded.aesKeyBase64,
    encrypt_type: 1,
  };

  const payload = { media: mediaRef };
  if (kind.itemKey === 'file_item') {
    payload.file_name = uploaded.fileName;
    payload.len = String(uploaded.fileSize);
  } else if (kind.itemKey === 'video_item') {
    payload.file_name = uploaded.fileName;
    payload.file_size = String(uploaded.fileSize);
  }

  return {
    type: kind.itemType,
    [kind.itemKey]: payload,
  };
}

/**
 * 将本地文件加密上传到微信 CDN 并发送给用户
 *
 * 自动识别文件类型，使用对应的 media_type 和消息 type：
 *   - 图片 (.jpg/.png/.gif/.webp/...) → media_type=1, type=2 (image_item)
 *   - 视频 (.mp4/.mov/.avi/.mkv/...)  → media_type=2, type=5 (video_item)
 *   - 其他文件                        → media_type=3, type=4 (file_item)
 *
 * @param {string} toUserId
 * @param {string} contextToken
 * @param {string} filepath - 本地文件绝对路径
 */
export async function sendFileToUser(toUserId, contextToken, filepath, botConfig) {
  const kind = detectMediaKind(filepath);
  const uploaded = await uploadMedia(toUserId, filepath, kind, botConfig);
  const item = buildMediaItem(kind, uploaded);

  const ilink = await getIlink();
  await ilink.sendMessage({ toUserId, contextToken, items: [item], botConfig });

  return {
    fileName: uploaded.fileName,
    fileSize: uploaded.fileSize,
    isImage: kind.isImage,
    isVideo: kind.isVideo,
    type: kind.label,
  };
}

// ---- 处理收到的媒体 ----

/**
 * 将消息中的附件下载解密并保存到本地
 *
 * 兼容所有媒体类型：图片 (type=2)、文件 (type=4)、视频 (type=5)
 *
 * @param {object} mediaItem - extractMedia() 返回的媒体项
 * @param {string} userId - 微信用户 ID（用于文件名前缀）
 * @param {string} destDir - 保存目录
 * @returns {{ filepath: string, isImage: boolean, isVideo: boolean, size: number }}
 */
export async function processIncomingMedia(mediaItem, userId, destDir) {
  const item = mediaItem.image_item || mediaItem.file_item || mediaItem.video_item;
  if (!item) throw new Error(`Media item missing image_item/file_item/video_item (type=${mediaItem.type})`);

  const media = item.media || item;
  const cdnKey = media.cdn_key || media.encrypt_query_param;
  const aesKey = media.aes_key;
  if (!cdnKey || !aesKey) {
    throw new Error(`CDN data incomplete: topKeys=[${Object.keys(item)}] mediaKeys=[${Object.keys(item.media || {})}]`);
  }

  const encrypted = await downloadFromCDN(media.full_url ? { fullUrl: media.full_url } : cdnKey);
  const decrypted = decryptAesEcb(encrypted, parseAesKey(aesKey));

  if (mediaItem.type === 2) {
    console.log(chalk.dim(`  ${chalk.dim('│')}   CDN download: ${encrypted.length} bytes, decrypted: ${decrypted.length} bytes`));
  }

  let ext;
  if (mediaItem.type === 2) {
    ext = '.jpg';
  } else if (item.file_name) {
    ext = path.extname(item.file_name) || '.bin';
  } else {
    ext = '.bin';
  }

  const timestamp = Date.now();
  const safeUser = userId.split('@')[0].replace(/[^a-zA-Z0-9_-]/g, '');
  const filename = `${safeUser}_${timestamp}${ext}`;
  const filepath = path.join(destDir, filename);

  await fs.writeFile(filepath, decrypted);
  return {
    filepath,
    isImage: mediaItem.type === 2,
    isVideo: mediaItem.type === 5,
    size: decrypted.length,
  };
}
