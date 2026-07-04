/**
 * 跨平台用户数据目录管理
 *
 * 数据存储路径（按优先级）:
 *   1. CLAUDE_WECHAT_DATA_DIR 环境变量
 *   2. Windows: %APPDATA%/claude-wechat-bot
 *   3. Linux/macOS: $XDG_DATA_HOME/claude-wechat-bot 或 ~/.local/share/claude-wechat-bot
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

function getDataDir() {
  if (process.env.CLAUDE_WECHAT_DATA_DIR) {
    return process.env.CLAUDE_WECHAT_DATA_DIR;
  }

  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'claude-wechat-bot');
  }

  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) {
    return path.join(xdg, 'claude-wechat-bot');
  }

  return path.join(os.homedir(), '.local', 'share', 'claude-wechat-bot');
}

export const DATA_DIR = getDataDir();
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
export const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
export const QR_IMAGE_PATH = path.join(DATA_DIR, 'qrcode.png');
export const DOTENV_PATH = path.join(DATA_DIR, '.env');
export const MEDIA_DIR = path.join(DATA_DIR, 'media');
export const MEDIA_INCOMING_DIR = path.join(MEDIA_DIR, 'incoming');

export function ensureDataDirs() {
  for (const dir of [DATA_DIR, SESSIONS_DIR, MEDIA_DIR, MEDIA_INCOMING_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}
