import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';

import { CONFIG_PATH, QR_IMAGE_PATH, ensureDataDirs } from './paths.js';

const API_BASE = 'https://ilinkai.weixin.qq.com';

// ---- 配置持久化 ----

export function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

export function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ---- iLink 鉴权流程 ----

/**
 * 步骤 1：获取登录二维码
 * POST /ilink/bot/get_bot_qrcode
 */
export async function getQRCode() {
  const url = `${API_BASE}/ilink/bot/get_bot_qrcode?bot_type=3`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await resp.json();
  if (data.ret !== 0) {
    throw new Error(`获取二维码失败: ${JSON.stringify(data)}`);
  }
  return data;
}

/** 将 base64 图片数据转为 DataURL */
function ensureQRSource(data) {
  // iLink 实际返回: qrcode_img_content (URL)
  const url = data.qrcode_img_content || data.url || data.qrcode_url;
  if (url) return url;

  // 也可能是 base64 图片
  if (data.qrcode_base64 || data.qr_base64) {
    const b64 = data.qrcode_base64 || data.qr_base64;
    return `data:image/png;base64,${b64}`;
  }

  throw new Error(`无法解析二维码数据: ${JSON.stringify(data).slice(0, 200)}`);
}

/**
 * 步骤 2：轮询扫码状态
 * 会 hold 住连接直到用户扫码确认
 */
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
 * 完整登录流程
 */
export async function login() {
  console.log(chalk.cyan('\n🔑 正在获取微信扫码登录二维码...\n'));

  // 1. 获取二维码
  const qrData = await getQRCode();
  const qrcode = qrData.qrcode;

  if (!qrcode) {
    throw new Error(`获取二维码失败: 字段缺失 — ${JSON.stringify(qrData).slice(0, 200)}`);
  }

  const qrUrl = ensureQRSource(qrData);

  console.log(chalk.yellow('⚠️  请在 120 秒内使用微信扫描下方二维码:\n'));

  // 生成并显示 QR 码
  const { default: QRCode } = await import('qrcode');
  console.log(await QRCode.toString(qrUrl, { type: 'terminal', small: true }));

  const expireSec = qrData.expired_time || qrData.expire_seconds || 120;
  console.log(chalk.dim(`二维码有效期: ${expireSec}s\n`));

  // 也可保存为图片文件方便查看
  ensureDataDirs();
  await QRCode.toFile(QR_IMAGE_PATH, qrUrl);
  console.log(chalk.dim(`二维码已保存至: ${QR_IMAGE_PATH}\n`));

  // 2. 轮询等待扫码
  console.log(chalk.cyan('⏳ 等待扫码确认...'));
  const result = await pollQRStatus(qrcode);

  if (result.ret !== 0) {
    throw new Error(`登录失败: ${JSON.stringify(result)}`);
  }

  if (!result.bot_token) {
    throw new Error(`登录失败: 未获取到 bot_token — ${JSON.stringify(result)}`);
  }

  // 3. 持久化 token
  ensureDataDirs();
  const config = loadConfig();
  config.bot_token = result.bot_token;
  config.bot_base_url = result.baseurl || API_BASE;
  saveConfig(config);

  console.log(chalk.green('\n✅ 微信扫码登录成功!'));
  console.log(chalk.dim(`   Bot Token: ${result.bot_token.slice(0, 16)}...`));
  console.log(chalk.dim(`   Base URL:  ${config.bot_base_url}\n`));

  return config;
}

// 单独运行此文件时执行登录流程
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  login().catch(err => {
    console.error(chalk.red('登录失败:'), err.message);
    process.exit(1);
  });
}
