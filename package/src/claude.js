/**
 * Claude Code CLI 集成
 *
 * 通过子进程调用 claude CLI。
 * 首次消息: --session-id <uuid> -p   (新建会话)
 * 后续消息: --resume <uuid> -p        (续传上下文)
 *
 * Windows 上 claude 是 bash 脚本，需要经由 bash 执行。
 * CLAUDE_BIN 和 CLAUDE_SHELL 环境变量在 index.js 启动时自动解析。
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import chalk from 'chalk';

// 可执行路径（index.js 启动时解析并注入环境变量）
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
// bash 路径（Windows 上需要，index.js 启动时解析）
const CLAUDE_SHELL = process.env.CLAUDE_SHELL || undefined;

// 每个 claude 调用的超时（毫秒）
const CLAUDE_TIMEOUT = parseInt(process.env.CLAUDE_TIMEOUT || '60000', 10);

/**
 * 调用 Claude Code CLI 生成回复
 *
 * @param {string} sessionId - Claude Code 会话 UUID
 * @param {string} userMessage - 用户消息文本
 * @param {object} options
 * @param {string} [options.systemPrompt] - 附加系统提示词（仅首次生效）
 * @param {boolean} [options.isNew] - 是否新会话
 * @returns {Promise<{ reply: string, sessionId: string }>}
 */
export function askClaude(sessionId, userMessage, options = {}) {
  return new Promise((resolve, reject) => {
    const isNew = options.isNew === true;
    const resumeFlag = isNew ? '--session-id' : '--resume';
    const modeLabel = isNew ? 'NEW' : 'RESUME';

    const args = [
      resumeFlag, sessionId,
      '-p',
      '--input-format', 'text',
      '--permission-mode', 'bypassPermissions',
      '--output-format', 'json',
    ];

    if (options.systemPrompt && isNew) {
      args.push('--append-system-prompt', options.systemPrompt);
    }

    console.log(chalk.dim(`  🤖 请求 Claude Code [${modeLabel}] (session: ${sessionId.slice(0, 8)})...`));
    const startTime = Date.now();

    const execOpts = {
      timeout: CLAUDE_TIMEOUT,
      maxBuffer: 1024 * 1024 * 4,
      cwd: options.cwd || process.cwd(),
    };

    // Windows 上 claude 是 bash 脚本，需通过 bash 执行
    if (CLAUDE_SHELL) {
      execOpts.shell = CLAUDE_SHELL;
    } else {
      execOpts.shell = true;
    }

    const child = execFile(CLAUDE_BIN, args, execOpts, (err, stdout, stderr) => {
      if (err) {
        if (err.killed) {
          return reject(new Error(`Claude Code 超时 (${CLAUDE_TIMEOUT}ms)`));
        }
        return reject(new Error(`Claude Code 执行失败: ${err.message}`));
      }

      try {
        const result = parseClaudeOutput(stdout);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(chalk.dim(`  ✅ Claude 回复完成 (${elapsed}s)`));
        resolve({
          reply: result.reply,
          sessionId: result.sessionId || sessionId,
        });
      } catch (parseErr) {
        console.error(chalk.red('解析 Claude 输出失败:'), parseErr.message);
        console.error(chalk.dim('stdout:'), stdout?.slice(0, 500));
        console.error(chalk.dim('stderr:'), stderr?.slice(0, 500));
        reject(new Error(`解析 Claude 响应失败: ${parseErr.message}`));
      }
    });

    child.stdin.write(userMessage);
    child.stdin.end();
  });
}

/**
 * 从 JSON 输出中提取回复
 */
function parseClaudeOutput(stdout) {
  const lines = stdout.trim().split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.type === 'result' && parsed.result !== undefined) {
        return {
          reply: parsed.result,
          sessionId: parsed.session_id,
          isError: parsed.is_error,
          stopReason: parsed.stop_reason,
        };
      }
    } catch { /* skip non-JSON lines */ }
  }
  if (stdout.trim()) return { reply: stdout.trim(), sessionId: '' };
  throw new Error('未找到有效输出');
}

export function createSessionId() {
  return crypto.randomUUID();
}

export function isResetCommand(text) {
  const keywords = ['reset', '重置', '新对话', '重新开始', 'clear', 'restart'];
  return keywords.includes(text.trim().toLowerCase());
}
