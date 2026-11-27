// tools/quality/lib/child.mjs —— 跨进程检查的受控子进程入口。
//
// "跨进程 seed 稳定"必须用真实进程验证：同 seed 的两个独立 node 进程要产出
// 逐字节一致的 fingerprint suite；token 派生也要跨进程一致。
// 这里只做受控 spawn：固定 argv/env、硬超时、退出码与 stdio 结构化返回。

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { sanitizeText } from './result.mjs';

export const CHILD_TIMEOUT_MS = 20000;

/**
 * 同步执行 node 子进程并解析 JSON stdout。
 * @returns {{ok:boolean, code:number|null, json:any, stdout:string, stderr:string, detail:string}}
 */
export function runChildJson(root, scriptRelPath, args = [], options = {}) {
  const script = path.join(root, scriptRelPath);
  const timeout = Math.max(1000, Number(options.timeoutMs) || CHILD_TIMEOUT_MS);
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout,
    env: {
      ...process.env,
      BB_QUALITY_CHILD: '1',
      // 子进程不得受调用方 locale/ICU 影响：确定性哈希不依赖 locale，但输出顺序由代码保证。
      LC_ALL: 'C',
      ...(options.env || {}),
    },
    windowsHide: true,
  });
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  const parsed = { ok: false, code: result.status, json: null, stdout, stderr, detail: '' };
  if (result.error) {
    parsed.detail = '子进程启动/运行失败：' + sanitizeText(result.error.message || result.error);
    return parsed;
  }
  if (result.status !== 0) {
    parsed.detail = '子进程退出码 ' + result.status + '：' + sanitizeText(stderr, { max: 300 });
    return parsed;
  }
  const text = stdout.trim();
  if (!text) {
    parsed.detail = '子进程没有输出 JSON';
    return parsed;
  }
  try {
    parsed.json = JSON.parse(text);
    parsed.ok = true;
  } catch (error) {
    parsed.detail = '子进程 stdout 不是合法 JSON：' + sanitizeText(error.message || error);
  }
  return parsed;
}

/**
 * 同步执行任意 node 脚本并返回原始 stdout/stderr/退出码（不要求 JSON、不要求成功）。
 * 用于验证 CLI 的结构化失败渲染（例如 `bridge --json <坏命令>` 必须退出码 2 + 单行 JSON）。
 */
export function runChildRaw(root, scriptRelPath, args = [], options = {}) {
  const script = path.join(root, scriptRelPath);
  const timeout = Math.max(1000, Number(options.timeoutMs) || CHILD_TIMEOUT_MS);
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout,
    env: { ...process.env, BB_QUALITY_CHILD: '1', ...(options.env || {}) },
    windowsHide: true,
  });
  return {
    ok: !result.error && result.status === 0,
    code: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    detail: result.error ? sanitizeText(result.error.message || result.error) : '',
  };
}

/**
 * 异步 spawn（保留给需要并发的场景；gate 默认用同步版以简化确定性）。
 * @returns {Promise<{ok:boolean, code:number|null, stdout:string, stderr:string, detail:string}>}
 */
export function runChild(root, scriptRelPath, args = [], options = {}) {
  const script = path.join(root, scriptRelPath);
  const timeout = Math.max(1000, Number(options.timeoutMs) || CHILD_TIMEOUT_MS);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: root,
      env: { ...process.env, BB_QUALITY_CHILD: '1', ...(options.env || {}) },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { child.kill('SIGTERM'); } catch { /* 忽略 */ }
      resolve({ ok: false, code: null, stdout, stderr, detail: '子进程超时（' + timeout + 'ms）被终止' });
    }, timeout);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr, detail: '子进程启动失败：' + sanitizeText(error.message || error) });
    });
    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const ok = code === 0;
      resolve({ ok, code, stdout, stderr, detail: ok ? '' : '子进程退出码 ' + code + '：' + sanitizeText(stderr, { max: 300 }) });
    });
  });
}

/** 跨进程 fingerprint suite：两次同 seed 的调用应逐字节一致。 */
export function runFingerprintSuite(root, seed, options = {}) {
  const args = ['--fingerprint-suite', '--json', '--seed', String(seed)];
  if (options.repeats) args.push('--repeats', String(options.repeats));
  return runChildJson(root, 'tools/quality/run.mjs', args, options);
}

/** 跨进程幂等 token：两次调用应一致（token 只由语义输入派生）。 */
export function runTokenFixture(root, seed, options = {}) {
  return runChildJson(root, 'tools/quality/lib/writes.mjs', ['--token-fixture', String(seed)], options);
}
