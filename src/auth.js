import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import chalk from 'chalk';

import { CONFIG_PATH, QR_IMAGE_PATH, ensureDataDirs } from './paths.js';

const API_BASE = 'https://ilinkai.weixin.qq.com';

function section(label) {
  return chalk.cyan(`[${label}]`);
}

// ---- 配置持久化 ----

/**
 * 加载配置。自动迁移旧版单 Bot 格式到多 Bot 格式。
 * 返回: { bots: [{ id, bot_token, bot_base_url, nickname, createdAt }] }
 */
export function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    // 迁移旧格式: { bot_token, bot_base_url, ... } → { bots: [...] }
    if (raw.bot_token && !raw.bots) {
      const migrated = {
        bots: [{
          id: 'bot_1',
          bot_token: raw.bot_token,
          bot_base_url: raw.bot_base_url || API_BASE,
          nickname: '默认',
          createdAt: raw.createdAt || Date.now(),
        }],
      };
      saveConfig(migrated);
      return migrated;
    }
    return raw.bots ? raw : { bots: [] };
  } catch {
    return { bots: [] };
  }
}

export function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

/**
 * 获取所有 Bot 列表
 */
export function getBots() {
  const config = loadConfig();
  return config.bots || [];
}

/**
 * 获取指定 Bot 的配置
 * @param {string} botId
 * @returns {{ id, bot_token, bot_base_url, nickname }|undefined}
 */
export function getBotConfig(botId) {
  return getBots().find(b => b.id === botId);
}

/**
 * 删除指定 Bot
 */
export function removeBot(botId) {
  const config = loadConfig();
  config.bots = (config.bots || []).filter(b => b.id !== botId);
  saveConfig(config);
}

// ---- iLink 鉴权流程 ----

export async function getQRCode() {
  const url = `${API_BASE}/ilink/bot/get_bot_qrcode?bot_type=3`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await resp.json();
  if (data.ret !== 0) {
    throw new Error(`get_bot_qrcode failed: ${JSON.stringify(data)}`);
  }
  return data;
}

function ensureQRSource(data) {
  const url = data.qrcode_img_content || data.url || data.qrcode_url;
  if (url) return url;

  if (data.qrcode_base64 || data.qr_base64) {
    const b64 = data.qrcode_base64 || data.qr_base64;
    return `data:image/png;base64,${b64}`;
  }

  throw new Error(`Cannot parse QR code data: ${JSON.stringify(data).slice(0, 200)}`);
}

export async function pollQRStatus(qrcode, timeoutMs = 120_000) {
  const url = `${API_BASE}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    const data = await resp.json();
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 扫码登录，添加一个新的 Bot
 * @param {string} [nickname] - 可选昵称，默认 "Bot N"
 * @param {string} [botId] - 可选 ID，默认自动生成
 * @returns {Promise<{ id, bot_token, bot_base_url, nickname }>}
 */
export async function login(nickname, botId) {
  console.log(`\n ${section('LOGIN')} Obtaining WeChat QR code...\n`);

  // 1. 获取二维码
  const qrData = await getQRCode();
  const qrcode = qrData.qrcode;

  if (!qrcode) {
    throw new Error(`QR code fetch failed: missing qrcode field — ${JSON.stringify(qrData).slice(0, 200)}`);
  }

  const qrUrl = ensureQRSource(qrData);

  console.log(` Scan the QR code with WeChat within 120s:\n`);

  const { default: QRCode } = await import('qrcode');
  console.log(await QRCode.toString(qrUrl, { type: 'terminal', small: true }));

  const expireSec = qrData.expired_time || qrData.expire_seconds || 120;
  console.log(chalk.dim(` QR code expires in ${expireSec}s\n`));

  ensureDataDirs();
  await QRCode.toFile(QR_IMAGE_PATH, qrUrl);
  console.log(chalk.dim(` QR code saved to: ${QR_IMAGE_PATH}\n`));

  // 2. 轮询等待扫码
  console.log(` ${section('LOGIN')} Waiting for scan confirmation...`);
  const result = await pollQRStatus(qrcode);

  if (result.ret !== 0) {
    throw new Error(`Login failed: ${JSON.stringify(result)}`);
  }

  if (!result.bot_token) {
    throw new Error(`Login failed: no bot_token received — ${JSON.stringify(result)}`);
  }

  // 3. 持久化 token（追加或更新）
  ensureDataDirs();
  const config = loadConfig();
  let bots = config.bots || [];
  const id = botId || `bot_${bots.length + 1}`;
  const name = nickname || `Bot ${bots.length + 1}`;
  const newBot = {
    id,
    bot_token: result.bot_token,
    bot_base_url: result.baseurl || API_BASE,
    nickname: name,
    createdAt: Date.now(),
  };

  // 如果 botId 已存在（重新登录），替换它
  const existingIdx = bots.findIndex(b => b.id === id);
  if (existingIdx >= 0) {
    bots[existingIdx] = newBot;
  } else {
    bots.push(newBot);
  }
  config.bots = bots;
  saveConfig(config);

  console.log(`\n ${section('LOGIN')} WeChat login successful — ${name}`);
  console.log(chalk.dim(`   Bot ID:   ${id}`));
  console.log(chalk.dim(`   Token:    ${result.bot_token.slice(0, 16)}...`));
  console.log(chalk.dim(`   Base URL: ${newBot.bot_base_url}\n`));

  return newBot;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const nickname = process.argv.find(a => a.startsWith('--name='))?.split('=')[1];
  login(nickname).catch(err => {
    console.error(` ${section('ERROR')} ${err.message}`);
    process.exit(1);
  });
}
