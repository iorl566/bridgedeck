// lib/bridge.mjs —— 调用 bridge CLI（一次一进程，--json 取最后一行）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_TIMEOUT_MS = 120000;
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 从插件位置推导仓库里的 CLI（dsh-plugin/lib -> 仓库根/cli/bridge.mjs）。 */
export function defaultCliPath() {
  const candidates = [
    path.resolve(HERE, '..', '..', 'cli', 'bridge.mjs'),
    path.resolve(HERE, '..', '..', '..', 'cli', 'bridge.mjs'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // 忽略
    }
  }
  return null;
}

/** 选一个能跑 .mjs 的 node：Electron 自带的 exe 不能直接当 node 用。 */
export function resolveNodePath(configured) {
  const explicit = configured || process.env.BB_NODE || '';
  if (explicit) return { node: explicit, electronRunAsNode: false };
  if (!process.versions.electron) return { node: process.execPath, electronRunAsNode: false };
  if (process.env.npm_node_execpath) return { node: process.env.npm_node_execpath, electronRunAsNode: false };
  const bundled = path.resolve(path.dirname(process.execPath), 'resources', 'runtime', 'bin', 'node.exe');
  try {
    if (fs.existsSync(bundled)) return { node: bundled, electronRunAsNode: false };
  } catch {
    // 忽略
  }
  // 最后兜底：Electron 在 ELECTRON_RUN_AS_NODE=1 时按 node 行为运行
  return { node: process.execPath, electronRunAsNode: true };
}

/** 业务错误：带 CLI 错误码。 */
export class BridgeCliError extends Error {
  constructor(code, message, extra) {
    super(code + ': ' + message);
    this.name = 'BridgeCliError';
    this.code = code;
    this.detail = extra || null;
  }
}

/**
 * 创建 run(args, { signal }) 函数：spawn node <cli> ...args --json，
 * 解析 stdout 最后一行的 JSON，失败抛 BridgeCliError。
 */
export function createRunner(options) {
  const config = options || {};
  const cliPath = config.bridgeCli || process.env.BB_CLI || defaultCliPath();
  const resolved = resolveNodePath(config.nodePath);
  const nodePath = resolved.node;
  if (!cliPath) {
    throw new Error('找不到 bridge CLI；请在插件配置里设置 bridgeCli，或设置环境变量 BB_CLI');
  }
  if (!fs.existsSync(cliPath)) {
    throw new Error('bridge CLI 不存在：' + cliPath);
  }
  const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : DEFAULT_TIMEOUT_MS;

  return function run(args, execContext) {
    const argv = [cliPath].concat(args).concat(['--json']);
    const env = Object.assign({}, process.env, config.env || {});
    if (resolved.electronRunAsNode) env.ELECTRON_RUN_AS_NODE = '1';
    if (config.home) env.BB_HOME = config.home;
    // DSH 提供 exec 上下文时，尽量自动映射成会话作用域；显式配置优先。
    if (!env.BB_SESSION_SCOPE && execContext) {
      const scope = execContext.sessionScope || execContext.sessionId || execContext.agentId;
      if (scope) env.BB_SESSION_SCOPE = String(scope);
    }
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(nodePath, argv, {
          cwd: config.cwd || path.dirname(path.dirname(cliPath)),
          env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        reject(new BridgeCliError('E_SPAWN', String((error && error.message) || error)));
        return;
      }
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (execContext && execContext.signal) {
          try {
            execContext.signal.removeEventListener('abort', onAbort);
          } catch {
            // 忽略
          }
        }
        fn(value);
      };
      const onAbort = () => {
        try {
          child.kill();
        } catch {
          // 忽略
        }
        finish(reject, new BridgeCliError('E_ABORTED', '调用方取消了命令'));
      };
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // 忽略
        }
        finish(reject, new BridgeCliError('E_TIMEOUT', 'bridge CLI 超过 ' + timeoutMs + 'ms 未返回'));
      }, timeoutMs);

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', (error) => {
        finish(reject, new BridgeCliError('E_SPAWN', String((error && error.message) || error)));
      });
      child.on('close', (code) => {
        const lines = stdout.split(/\r?\n/).filter((line) => line.trim().startsWith('{'));
        const last = lines.length ? lines[lines.length - 1] : '';
        let parsed = null;
        if (last) {
          try {
            parsed = JSON.parse(last);
          } catch {
            parsed = null;
          }
        }
        if (!parsed) {
          finish(reject, new BridgeCliError('E_OUTPUT', 'bridge 输出不是 JSON（exit ' + code + '）：' + (stderr || stdout).slice(0, 500)));
          return;
        }
        if (parsed.ok === true) {
          finish(resolve, parsed.result === undefined ? {} : parsed.result);
          return;
        }
        const error = parsed.error || {};
        finish(reject, new BridgeCliError(error.code || 'E_INTERNAL', error.message || 'bridge 调用失败', { exitCode: code }));
      });

      if (execContext && execContext.signal) {
        if (execContext.signal.aborted) {
          onAbort();
          return;
        }
        try {
          execContext.signal.addEventListener('abort', onAbort, { once: true });
        } catch {
          // 忽略
        }
      }
    });
  };
}
