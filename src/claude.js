/**
 * Claude Code Agent SDK 集成
 *
 * 使用 @anthropic-ai/claude-agent-sdk 替代 CLI 子进程调用，
 * 实现同一进程内的 Claude Code 集成。
 * 支持流式输出显示思考过程和文本响应。
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { DATA_DIR } from './paths.js';

const CLAUDE_TIMEOUT = parseInt(process.env.CLAUDE_TIMEOUT || '120000', 10);

const BORDER = chalk.dim('│');

export function createSessionId() {
  return crypto.randomUUID();
}

export function isResetCommand(text) {
  const keywords = ['reset', '重置', '新对话', '重新开始', 'clear', 'restart'];
  return keywords.includes(text.trim().toLowerCase());
}

export function isHelpCommand(text) {
  return /^\/(help|start|命令|帮助)\b/i.test(text.trim());
}

export function isStatusCommand(text) {
  return /^\/(status|状态)\b/i.test(text.trim());
}

// ---- 模型管理（从环境变量 CLAUDE_MODELS 读取） ----

/**
 * 从 CLAUDE_MODELS 环境变量获取可用模型列表（逗号分隔）。
 * @returns {Array<{id: string, name: string}>}
 */
export function fetchModels() {
  const raw = process.env.CLAUDE_MODELS;
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean).map(id => ({ id, name: id }));
}

/**
 * 判断是否是 /model 命令
 */
export function isModelCommand(text) {
  return /^\/model/i.test(text.trim());
}

/**
 * 解析 /model 命令
 * @param {string} text
 * @param {Array} models - fetchModels() 返回的模型列表
 * @returns {string|null} 目标模型 ID 或 null（仅列出列表）
 */
export function parseModelCommand(text, models) {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 2 || parts[0].toLowerCase() !== '/model') return null;

  const arg = parts.slice(1).join(' ').toLowerCase();
  // 支持简写: /model opus → claude-opus-4-8
  const found = models.find(m =>
    m.id === arg ||
    m.id.includes(arg) ||
    m.name.toLowerCase().includes(arg)
  );
  return found ? found.id : null;
}

/**
 * 格式化模型列表文本
 */
export function formatModelList(models, currentModel) {
  const lines = ['可用模型：'];
  for (const m of models) {
    const marker = m.id === currentModel ? ' ← 当前' : '';
    lines.push(`  ${m.id}${marker}`);
  }
  lines.push('');
  const defaultModel = process.env.CLAUDE_MODEL || '(未设置)';
  lines.push(`默认: ${defaultModel}`);
  lines.push('切换: /model <模型名>');
  return lines.join('\n');
}

// ---- Bot 工作目录隔离 ----

const BOT_CWD_BASE = path.join(DATA_DIR, 'bot-cwd');

function ensureBotCwd(botId) {
  const dir = path.join(BOT_CWD_BASE, botId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    // 复制 CLAUDE.md 到 Bot 工作目录，让 Claude 仍能读取项目指令
    const srcClaudeMd = path.join(process.cwd(), 'CLAUDE.md');
    const dstClaudeMd = path.join(dir, 'CLAUDE.md');
    if (fs.existsSync(srcClaudeMd)) {
      fs.copyFileSync(srcClaudeMd, dstClaudeMd);
    }
    // 创建空的 .claude/ 目录，阻止 Claude 回溯到上级目录的配置
    const dotClaudeDir = path.join(dir, '.claude');
    if (!fs.existsSync(dotClaudeDir)) {
      fs.mkdirSync(dotClaudeDir, { recursive: true });
    }
  }
  return dir;
}

/**
 * 调用 Claude Agent SDK 生成回复，带流式输出
 *
 * 使用 includePartialMessages 获取实时流式事件，
 * 在控制台展示 Claude 的思考过程和文本生成。
 *
 * @param {string} sessionId
 * @param {string} userMessage
 * @param {object} [options]
 * @param {object} [options.botConfig] - 传入 { id } 则为该 Bot 创建独立 cwd，隔离 auto-memory
 */
export async function askClaude(sessionId, userMessage, options = {}) {
  const isNew = options.isNew === true;
  const modeLabel = isNew ? 'NEW' : 'RESUME';

  const abortController = new AbortController();
  const timer = setTimeout(() => {
    abortController.abort();
  }, CLAUDE_TIMEOUT);

  console.log(chalk.dim(`  ${BORDER} Claude ${modeLabel} (session: ${sessionId.slice(0, 8)})`));
  const startTime = Date.now();

  try {
    const modelId = options.model || process.env.CLAUDE_MODEL || undefined;
    const realCwd = process.cwd();
    // Bot 专属 cwd：每个 Bot 有独立的 ~/.claude/projects/<hash>/memory/
    const botCwd = options.botConfig?.id ? ensureBotCwd(options.botConfig.id) : realCwd;

    const queryOpts = {
      prompt: userMessage,
      options: {
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        ...(modelId && { model: modelId }),
        effort: 'low',
        cwd: botCwd,
        // 确保 Bot 仍能访问项目目录下的文件
        additionalDirectories: botCwd !== realCwd ? [realCwd] : undefined,
        abortController,
        includePartialMessages: true,
        systemPrompt: options.systemPrompt
          ? { type: 'preset', preset: 'claude_code', append: options.systemPrompt }
          : undefined,
        // 通过 env 直接注入 API 配置，不依赖 CLI 的 settings.json
        env: {
          ...process.env,
          ...(process.env.ANTHROPIC_API_KEY && { ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_API_KEY }),
        },
      },
    };

    if (isNew) {
      queryOpts.options.sessionId = sessionId;
    } else {
      queryOpts.options.resume = sessionId;
    }

    const generator = query(queryOpts);
    let reply = '';
    let resultSessionId = sessionId;
    let hasThinking = false;
    let hasText = false;
    let showedFirstPreview = false;
    let firstPreviewBuffer = '';
    let dotIdx = 0;
    let lastDotTime = 0;

    // 实时显示流式内容
    for await (const message of generator) {
      if (message.type === 'stream_event') {
        const event = message.event;
        if (event.type === 'content_block_delta' && event.delta) {
          const delta = event.delta;

          // ---- 思考过程：滚动 .... 动画，不输出实际思考内容 ----
          if (delta.type === 'thinking_delta' && delta.thinking) {
            if (!hasThinking) {
              console.log(chalk.dim(`  ${BORDER} ${chalk.italic('thinking')}`));
              hasThinking = true;
              dotIdx = 0;
              lastDotTime = Date.now();
              process.stdout.write(chalk.dim(`  ${BORDER}   `));
            }
            // 每 150ms 滚动一帧
            const now = Date.now();
            if (now - lastDotTime > 150) {
              const frames = [
                '·    ', '··   ', '···  ', '···· ',
                '·····', ' ····', '  ···', '   ··', '    ·',
              ];
              process.stdout.write(`\r${chalk.dim(`  ${BORDER}   ${frames[dotIdx]}`)}`);
              dotIdx = (dotIdx + 1) % frames.length;
              lastDotTime = now;
            }
          }

          // ---- 文本输出 ----
          if (delta.type === 'text_delta' && delta.text) {
            if (!hasText) {
              if (hasThinking) {
                // 清除滚动 dots 所在行
                process.stdout.write(`\r${' '.repeat(20)}\r`);
                process.stdout.write(chalk.dim(`  ${BORDER} ${chalk.italic('response')}\n`));
              }
              hasText = true;
            }

            // 首段预览（缓冲至 ~15 字符或换行后输出，避免逐字换行）
            if (!showedFirstPreview) {
              firstPreviewBuffer += delta.text;
              if (firstPreviewBuffer.length >= 15 || firstPreviewBuffer.includes('\n')) {
                const display = firstPreviewBuffer.split('\n')[0].slice(0, 80).trim();
                if (display) {
                  process.stdout.write(chalk.dim(`  ${BORDER}   ${display}\n`));
                }
                showedFirstPreview = true;
              }
            }
          }
        }
      }

      // 结果消息
      if (message.type === 'result') {
        if (message.subtype === 'success') {
          reply = message.result;
          resultSessionId = message.session_id || sessionId;
        } else if (message.subtype === 'error_during_execution') {
          reply = message.result || '';
          resultSessionId = message.session_id || sessionId;
          if (!reply) {
            throw new Error(message.errors?.[0] || 'Claude Agent SDK execution error');
          }
        } else {
          const errMsg = message.errors?.[0] || `Claude execution error: ${message.subtype}`;
          throw new Error(errMsg);
        }
      }
    }

    if (!reply) {
      throw new Error('Claude returned empty response');
    }

    // 如果 thinking 了但最终没有文本输出，清理 dots 行
    if (hasThinking && !hasText) {
      process.stdout.write(`\r${' '.repeat(20)}\r`);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const lines = reply.split('\n').length;
    console.log(chalk.dim(`  ${BORDER} done in ${elapsed}s (${lines} lines, ${reply.length} chars)`));

    return { reply, sessionId: resultSessionId };
  } catch (err) {
    if (err.name === 'AbortError' || (err.message && err.message.toLowerCase().includes('abor'))) {
      throw new Error(`Claude Code timed out (${CLAUDE_TIMEOUT}ms)`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
