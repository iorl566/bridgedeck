// cli/bridge.mjs — BridgeDeck命令行客户端（零依赖）。
//
// 一次调用 = 解析参数 → 确保 daemon 在跑（必要时 detached 拉起）→ 一次 /rpc → 打印结果。
// 命令面见 docs/PROTOCOL.md §7；退出码：成功 0、业务失败 1、参数错误 2。
// --json 模式下 stdout 只输出一行 JSON，人类可读输出与错误信息走 stderr。

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SKILL_FILES, SKILL_VERSION } from './embedded-skill.mjs';
import { verifyReleaseSignature } from '../lib/release-sign.mjs';
import { buildTraceV3 } from '../lib/trace-v3.mjs';
import { renderTraceHtml } from '../lib/trace-viewer.mjs';
import { applyObservationPatch } from '../lib/observation-delta.mjs';
import { buildDebugEvidence } from '../lib/debug-evidence.mjs';
import { analyzeDebugCapture, filterDebugRequests } from '../lib/debug-analysis.mjs';
import { buildDebugArchive } from '../lib/debug-archive.mjs';
import { buildDebugJournal, formatJournalEvent } from '../lib/debug-journal.mjs';
import { archiveSummary, createArchiveIndex } from '../lib/debug-archive-index.mjs';
import { queryArchive } from '../lib/debug-archive.mjs';
import { describeMethod, listMethods, renderFlagUsage, renderMethodHelp, schemaFlags } from '../lib/schema-info.mjs';
import { updateArchiveIndex } from '../lib/debug-archive-store.mjs';
import { RecipeStoreError, approveRecipe, assertRunnable, listRecipes, readRecipe, recipePath, saveRecipe, substituteParams } from '../lib/recipe-store.mjs';
import { fetchManifest, fetchManifestWithFallback, DOMESTIC_MANIFEST_URL, GITHUB_MANIFEST_URL } from '../lib/update-source.mjs';
import { isControllerInfo } from '../extension/src/lib/controller-info.js';
import { readUpdateState, writeUpdateState } from '../lib/update-state.mjs';

const VERSION = '0.1.2';
const SERVICE = 'browser-bridge';
const DEFAULT_PORT = 52900;
const PORT_CANDIDATES = Array.from({ length: 10 }, (_, i) => DEFAULT_PORT + i);
const DEFAULT_TIMEOUT_MS = 60_000;
// 多 daemon 并存（例如测试）时，可以通过 BB_NO_PROBE=1 关掉“猜孤儿端口”的行为。
const PROBE_ORPHAN = process.env.BB_NO_PROBE !== '1';
const DAEMON_START_WAIT_MS = 10_000;

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const SERVER_PATH = path.join(REPO_ROOT, 'daemon', 'server.mjs');

const HOME_DIR = resolveHomeDir();
const DAEMON_JSON_PATH = path.join(HOME_DIR, 'daemon.json');
const LOG_PATH = path.join(HOME_DIR, 'daemon.log');

/** 参数错误：退出码 2。 */
class ArgError extends Error {}

/** 业务错误：退出码 1。 */
class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

function resolveHomeDir() {
  const fromEnv = process.env.BB_HOME;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return path.join(os.homedir(), '.browser-bridge');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

const BOOL_FLAGS = new Set([
  'json', 'no-focus', 'probe-hover', 'full', 'keep', 'help', 'tail',
  'all', 'mobile', 'reset', 'queue', 'bodies', 'accept', 'dismiss', 'force', 'list', 'stitch', 'no-clear', 'overwrite', 'annotate', 'screenshot', 'incognito', 'with-requests', 'frames', 'release-old', 'by', 'confirm-human', 'closed-shadow', 'trusted', 'window', 'focus', 'enable', 'disable', 'download', 'apply', 'prune', 'wait-navigation', 'screenshots',
]);
const VALUE_FLAGS = new Set([
  'session', 'port', 'timeout', 'out', 'value', 'ref', 'selector',
  'state', 'since', 'scope', 'browser', 'width', 'height',
  'mode', 'format', 'max-rows', 'file', 'to', 'steps', 'delta-y', 'delta-x',
  'alert', 'confirm', 'prompt', 'prompt-text', 'reason', 'filter', 'status', 'method',
  'limit', 'dpr', 'timezone', 'locale', 'geolocation', 'label', 'long-shot', 'id', 'outcome', 'baseline',
  'borrow-confirm', 'allow-help', 'page-guard', 'control-hint', 'name', 'param', 'dir', 'harness',
  'url', 'grep', 'offset', 'tab', 'save-full', 'page', 'query', 'fields-json', 'dx', 'dy', 'hold', 'duration',
  'from-offset-x', 'from-offset-y', 'to-offset-x', 'to-offset-y', 'target', 'text', 'overlap', 'to-window', 'max',
  'context', 'expect', 'observation', 'policy', 'name', 'part', 'output', 'quality',
  'max-tokens', 'cursor', 'match-text', 'context-lines', 'find', 'start-line', 'line-count', 'debug',
  'capture', 'image-x', 'image-y', 'settle', 'depends-on', 'rule', 'rule-file', 'window-ms', 'ms', 'scope', 'ttl', 'label', 'host', 'daemon-url', 'daemon-token', 'operation-id', 'closed-shadow-text', 'until-visible', 'wait-timeout-ms', 'wait-timeout', 'session-scope', 'agent-name', 'project', 'controller-color',
]);
for (const name of ['item-selector', 'max-depth', 'fields', 'tab-id', 'wait-until', 'device', 'ua', 'accept-language', 'max-bytes', 'wait-ms', 'command-id', 'url', 'resource-type', 'state', 'kind', 'max-chars', 'pointer', 'budget']) VALUE_FLAGS.add(name);
for (const name of ['csv-safe', 'touch', 'no-touch', 'full-page', 'debug-surfaces', 'include-controlled', 'embedded', 'vom', 'ax', 'check', 'mcp', 'delta', 'replace', 'auto', 'force']) BOOL_FLAGS.add(name);
for (const name of ['manifest', 'staging', 'backup', 'modifiers', 'key', 'source', 'region', 'interval']) VALUE_FLAGS.add(name);

const REPEATABLE_FLAGS = new Set(['file', 'param']);

function parseArgs(argv) {
  const flags = Object.create(null);
  const pos = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '-h' || arg === '--help') {
      flags.help = true;
      continue;
    }
    if (!arg.startsWith('-')) {
      pos.push(arg);
      continue;
    }
    if (!arg.startsWith('--')) throw new ArgError(`未知选项：${arg}`);
    const eq = arg.indexOf('=');
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
    if (name === 'tail') {
      if (inline !== undefined) {
        flags.tail = /^\d+$/.test(inline) ? Number(inline) : true;
      } else if (i + 1 < argv.length && /^\d+$/.test(argv[i + 1])) {
        flags.tail = Number(argv[i + 1]);
        i += 1;
      } else {
        flags.tail = true;
      }
      continue;
    }
    if (BOOL_FLAGS.has(name)) {
      flags[name] = inline === undefined ? true : !(inline === 'false' || inline === '0');
      continue;
    }
    if (VALUE_FLAGS.has(name)) {
      let value;
      if (inline !== undefined) {
        value = inline;
      } else {
        if (i + 1 >= argv.length) throw new ArgError(`选项 --${name} 需要一个值`);
        value = argv[i + 1];
        i += 1;
      }
      if (REPEATABLE_FLAGS.has(name)) {
        if (!Array.isArray(flags[name])) flags[name] = [];
        flags[name].push(value);
      } else {
        flags[name] = value;
      }
      continue;
    }
    throw new ArgError(`未知选项：--${name}`);
  }
  return { flags, pos };
}

function intFlag(flags, name, { min = 0 } = {}) {
  if (flags[name] === undefined) return undefined;
  const text = String(flags[name]);
  if (!/^-?\d+$/.test(text)) throw new ArgError(`--${name} 需要整数，收到 "${text}"`);
  const value = Number(text);
  if (value < min) throw new ArgError(`--${name} 必须 >= ${min}`);
  return value;
}

function requirePos(pos, index, label) {
  const value = pos[index];
  if (value === undefined || value === '') throw new ArgError(`缺少参数 ${label}`);
  return value;
}

/** 解析 500ms / 20s / 2m 这类时长，返回毫秒。 */
function parseDurationMs(text, fallback) {
  if (text === undefined || text === null || text === '') return fallback;
  const value = String(text).trim();
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(value);
  if (!match) throw new ArgError('时间格式应为 500ms / 20s / 2m，收到 "' + value + '"');
  const amount = Number(match[1]);
  const unit = match[2] || 'ms';
  const factor = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60000 : 3600000;
  return Math.round(amount * factor);
}

function targetOf(value) {
  const text = String(value);
  return text.startsWith('@') ? { ref: text } : { selector: text };
}

function timeoutOf(flags) {
  return parseDurationMs(flags.timeout, DEFAULT_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// HTTP / daemon 发现与自启动
// ---------------------------------------------------------------------------

let jsonMode = false;
let requestedPort = null;
let daemonInfo = null;

function requestJson({ port, method = 'GET', pathname, headers = {}, body, timeoutMs = 3000, tls = false }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const reqHeaders = { ...headers };
    if (payload) {
      reqHeaders['content-type'] = 'application/json';
      reqHeaders['content-length'] = payload.length;
    }
    const transport = tls ? https : http;
    const req = transport.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method,
      agent: false,
      headers: reqHeaders,
      timeout: timeoutMs,
      rejectUnauthorized: tls ? false : undefined,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => { chunks.push(chunk); });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** GET /health；服务不在返回 null。 */
async function getHealth(port, timeoutMs = 1200) {
  for (const tls of [false, true]) {
    try {
      const res = await requestJson({ port, pathname: '/health', timeoutMs, tls });
      if (res.json && res.json.service === SERVICE) return res.json;
    } catch {
      // 换下一种传输再试
    }
  }
  return null;
}

function readDaemonInfo() {
  try {
    const info = JSON.parse(fs.readFileSync(DAEMON_JSON_PATH, 'utf8'));
    if (!info || typeof info.port !== 'number' || typeof info.token !== 'string') return null;
    return info;
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function candidatePorts() {
  const ports = [];
  const envPort = Number(process.env.BB_PORT);
  if (Number.isInteger(envPort) && envPort > 0) ports.push(envPort);
  for (const port of PORT_CANDIDATES) {
    if (!ports.includes(port)) ports.push(port);
  }
  return ports;
}

function removeDaemonJson(info) {
  try {
    const current = readDaemonInfo();
    if (!current || !info || current.pid === info.pid) fs.rmSync(DAEMON_JSON_PATH, { force: true });
  } catch { /* 忽略 */ }
}

/** 找正在运行的 daemon：daemon.json 优先，其次探测候选端口（daemon.json 丢失的兜底）。 */
async function locateDaemon({ probeOrphan = PROBE_ORPHAN } = {}) {
  const info = readDaemonInfo();
  if (info) {
    let health = await getHealth(info.port, 1200);
    if (!health && isPidAlive(info.pid)) {
      for (let i = 0; i < 10 && !health; i += 1) {
        await sleep(200);
        health = await getHealth(info.port, 800);
      }
    }
    if (health) {
      return {
        info: { port: info.port, token: info.token, pid: health.pid ?? info.pid, tls: info.tls === true || health.tls === true },
        health,
      };
    }
    removeDaemonJson(info);
  }
  if (probeOrphan) {
    for (const port of candidatePorts()) {
      const health = await getHealth(port, 150);
      if (health) return { info: null, health };
    }
  }
  return { info: null, health: null };
}

async function postRpc(info, method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  let res;
  try {
    res = await requestJson({
      port: info.port,
      method: 'POST',
      pathname: '/rpc',
      headers: { 'x-bridge-token': info.token },
      body: { method, params, timeoutMs },
      timeoutMs: timeoutMs + 5000,
      tls: info.tls === true,
    });
  } catch (err) {
    throw new BridgeError('E_DAEMON', `无法连接 daemon（127.0.0.1:${info.port}）：${err && err.message ? err.message : err}`);
  }
  if (res.status === 401) {
    throw new BridgeError('E_AUTH', `daemon 拒绝 token；${DAEMON_JSON_PATH} 可能已过期。运行 bridge daemon stop 后重试`);
  }
  if (!res.json) {
    throw new BridgeError('E_DAEMON', `daemon 返回非 JSON 响应（HTTP ${res.status}）`);
  }
  return res.json;
}

/** 后台 detached 拉起 daemon，并轮询等待 /health 就绪。 */
async function spawnDaemon(explicitPort) {
  const env = { ...process.env, BB_HOME: HOME_DIR };
  const args = [SERVER_PATH, '--foreground'];
  if (explicitPort) args.push('--port', String(explicitPort));
  const child = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env,
  });
  child.unref();

  const deadline = Date.now() + DAEMON_START_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(150);
    const info = readDaemonInfo();
    if (info) {
      const health = await getHealth(info.port, 500);
      if (health) {
        return { port: info.port, token: info.token, pid: health.pid ?? info.pid };
      }
    }
    if (child.exitCode !== null) break;
  }
  const orphan = await locateDaemon();
  if (orphan.info) return orphan.info;
  if (orphan.health) {
    throw new BridgeError('E_AUTH', `daemon 已在 port ${orphan.health.port} 运行，但 ${DAEMON_JSON_PATH} 缺失，无法鉴权；请结束该进程后重试`);
  }
  throw new BridgeError('E_DAEMON', `daemon ${DAEMON_START_WAIT_MS / 1000}s 内未就绪；请查看日志 ${LOG_PATH}`);
}

async function ensureDaemon() {
  if (daemonInfo) return daemonInfo;
  const found = await locateDaemon();
  if (found.info) {
    daemonInfo = found.info;
    return daemonInfo;
  }
  if (found.health) {
    throw new BridgeError('E_AUTH', `检测到 daemon 正在运行（pid ${found.health.pid}, port ${found.health.port}），但 ${DAEMON_JSON_PATH} 缺失或损坏，无法取得 token；请先结束该进程后重试`);
  }
  daemonInfo = await spawnDaemon(requestedPort);
  return daemonInfo;
}

async function callRpc(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const info = await ensureDaemon();
  return postRpc(info, method, params, timeoutMs);
}

/** 优雅停止 daemon：内部 RPC daemon.stop → 等 /health 消失 → 清理 daemon.json。 */
async function stopDaemon() {
  const info = readDaemonInfo();
  if (!info) {
    const found = await locateDaemon();
    if (found.health) {
      throw new BridgeError('E_AUTH', `daemon 在 port ${found.health.port} 运行（pid ${found.health.pid}），但 ${DAEMON_JSON_PATH} 缺失，无法鉴权停止；请结束该进程`);
    }
    return { stopped: false, message: 'daemon 未运行' };
  }
  const health = await getHealth(info.port, 1000);
  if (!health) {
    removeDaemonJson(info);
    return { stopped: false, message: 'daemon 未运行（已清理残留 daemon.json）', staleRemoved: true };
  }
  const pid = health.pid;
  try {
    await postRpc({ port: info.port, token: info.token, tls: info.tls === true }, 'daemon.stop', {}, 3000);
  } catch (err) {
    // daemon 可能在回包前就断开连接；继续轮询确认。
  }
  const deadline = Date.now() + 5000;
  let down = false;
  while (Date.now() < deadline) {
    await sleep(150);
    if (!(await getHealth(info.port, 300))) {
      down = true;
      break;
    }
  }
  if (!down) {
    throw new BridgeError('E_DAEMON', `daemon (pid ${pid}) 未在 5s 内退出；请手动结束该进程`);
  }
  removeDaemonJson({ pid });
  return { stopped: true, pid, port: info.port, message: `daemon 已停止 (pid ${pid})` };
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

function emitJson(value) {
  // --json 模式：stdout 只允许一行 JSON，不能混日志。
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function print(text) {
  process.stdout.write(`${text}\n`);
}

function outputFailure(body) {
  const error = body.error || { code: 'E_INTERNAL', message: 'unknown error' };
  if (error.code === 'E_DIALOG_PENDING') {
    const data = error.data || {};
    const dialog = data.dialog || {};
    if (jsonMode) {
      emitJson(body);
      return 6;
    }
    process.stderr.write('对话框待处理 [' + (dialog.type || '?') + '] ' + (dialog.message || '') + '\n');
    process.stderr.write('  dialog id: ' + (dialog.id != null ? dialog.id : '?') +
      (data.operationId ? '   operation: ' + data.operationId : '') + '\n');
    process.stderr.write('  下一步：bridge dialog accept ' + (dialog.id != null ? dialog.id : '<id>') +
      (dialog.type === 'prompt' ? ' --text "输入内容"' : '') +
      '   或 bridge dialog dismiss ' + (dialog.id != null ? dialog.id : '<id>') + '\n');
    if (data.operationId) process.stderr.write('  取回结果：bridge operation await ' + data.operationId + '\n');
    return 6;
  }
  if (jsonMode) {
    emitJson(body);
  } else {
    process.stderr.write(`错误 ${error.code}: ${error.message}\n`);
  }
  return 1;
}

function outputBridgeError(err) {
  if (jsonMode) {
    emitJson({ ok: false, error: { code: err.code || 'E_INTERNAL', message: err.message } });
  } else {
    process.stderr.write(`错误 ${err.code || 'E_INTERNAL'}: ${err.message}\n`);
  }
}

function outputJsonBody(body) {
  emitJson(body);
  return 0;
}

function charWidth(ch) {
  const code = ch.codePointAt(0);
  const wide = code >= 0x1100 && (
    code <= 0x115f
    || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe30 && code <= 0xfe4f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1f9ff)
  );
  return wide ? 2 : 1;
}

function textWidth(text) {
  let width = 0;
  for (const ch of String(text)) width += charWidth(ch);
  return width;
}

function padEndWidth(text, width) {
  return String(text) + ' '.repeat(Math.max(0, width - textWidth(text)));
}

function truncateText(text, max) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** 简单等宽表格（按显示宽度对齐，兼容中文）。 */
function renderTable(headers, rows) {
  if (!rows.length) return '';
  const widths = headers.map((header, index) => Math.max(
    textWidth(header),
    ...rows.map((row) => textWidth(String(row[index] ?? ''))),
  ));
  const renderRow = (cells) => cells.map((cell, index) => padEndWidth(String(cell ?? ''), widths[index])).join('  ').trimEnd();
  const lines = [renderRow(headers), renderRow(headers.map((_, index) => '-'.repeat(widths[index])))];
  for (const row of rows) lines.push(renderRow(row));
  return lines.join('\n');
}

function formatUptime(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days) return `${days}d ${hours}h ${minutes}m`;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatTime(ts) {
  const date = new Date(Number(ts) || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// 命令：status / browsers / doctor
// ---------------------------------------------------------------------------

/** 浏览器表格：有实例名时多一列。 */
function browserTable(browsers) {
  const showLabel = browsers.some((item) => item.label);
  const headers = showLabel
    ? ['instance', 'label', 'browser', 'version', 'ext', 'connected']
    : ['instance', 'browser', 'version', 'ext', 'connected'];
  const rows = browsers.map((item) => {
    const tail = [item.browser, item.browserVersion, item.extVersion, formatTime(item.connectedAt)];
    return showLabel ? [item.instanceId, item.label || '', ...tail] : [item.instanceId, ...tail];
  });
  return renderTable(headers, rows);
}

async function cmdAgent(flags, pos) {
  const sub = pos[1] || 'brief';
  if (sub !== 'brief') throw new ArgError('agent 只支持 brief');
  if (flags.session === undefined) throw new ArgError('agent brief 需要 --session <id>');
  const params = withControl(flags, { maxTokens: 1200, probeHover: false });
  const body = await callRpc('observe', params, timeoutOf(flags));
  if (!body.ok) return outputFailure(body);
  const observation = body.result || {};
  let dialog = null;
  try {
    const dialogBody = await callRpc('dialog.status', withControl(flags, {}), Math.min(timeoutOf(flags), 5000));
    if (dialogBody.ok) dialog = dialogBody.result || null;
  } catch {
    dialog = null;
  }
  const pending = Boolean(dialog && (dialog.pending === true || dialog.armed === true));
  const next = [];
  if (pending) next.push('dialog accept', 'dialog dismiss');
  else next.push('click @eN', 'fill @eN --value <text>', 'observe');
  if (observation.truncated) next.push('observe --cursor <cursor>');
  const brief = {
    session: String(flags.session),
    page: {
      url: observation.url || '',
      title: observation.title || '',
    },
    observation: {
      text: String(observation.observation || ''),
      refs: Number(observation.refs) || 0,
      truncated: observation.truncated === true,
      cursor: observation.cursor || null,
      generation: observation.generation || null,
    },
    dialog: dialog ? { pending, armed: dialog.armed === true, type: dialog.type || null } : null,
    next,
    hint: pending ? '页面有待处理对话框，先 accept/dismiss 再继续。' : '使用 @eN ref 操作；导航后旧 ref 失效，重新 observe。',
  };
  if (jsonMode) {
    emitJson({ ok: true, result: brief });
    return 0;
  }
  print('agent brief · ' + (brief.page.title || '(无标题)'));
  print('  url   ' + brief.page.url);
  print('  refs  ' + brief.observation.refs + (brief.observation.truncated ? '（观察已截断）' : ''));
  if (brief.dialog && brief.dialog.pending) print('  dialog 待处理');
  print('');
  print(brief.observation.text);
  print('');
  print('下一步：' + brief.next.join(' / '));
  return 0;
}

async function cmdStatus(flags) {
  const body = await callRpc('status', {}, timeoutOf(flags));
  if (!body.ok) return outputFailure(body);
  if (jsonMode) return outputJsonBody(body);
  const result = body.result || {};
  const browsers = result.browsers || [];
  const sessions = result.sessions || [];
  const lines = [];
  lines.push(`${result.service} v${result.version}  (protocol ${result.protocol ?? '?'}, pid ${result.pid}, port ${result.port}, uptime ${formatUptime(result.uptimeMs)})`);
  lines.push('');
  lines.push(`browsers (${browsers.length}):`);
  if (browsers.length) {
    lines.push(indent(browserTable(browsers)));
  } else {
    lines.push('  (无已连接浏览器)');
  }
  lines.push('');
  lines.push(`sessions (${sessions.length}):`);
  if (sessions.length) {
    lines.push(indent(renderTable(
      ['session', 'instance', 'tab', 'window', 'url', 'title', 'started'],
      sessions.map((item) => [
        item.sessionId,
        item.instanceId,
        item.tabId,
        item.windowId,
        truncateText(item.url, 48),
        truncateText(item.title, 32),
        formatTime(item.startedAt),
      ]),
    )));
  } else {
    lines.push('  (无活动 session)');
  }
  const inflight = result.inflight || [];
  lines.push('');
  lines.push(`inflight (${inflight.length}):`);
  if (inflight.length) {
    lines.push(indent(renderTable(
      ['method', 'instance', 'tab', 'elapsed'],
      inflight.map((item) => [
        item.method,
        item.instanceId,
        item.tabId == null ? '—' : String(item.tabId),
        item.elapsedMs + 'ms',
      ]),
    )));
  } else {
    lines.push('  (无进行中命令)');
  }
  print(lines.join('\n'));
  return 0;
}

async function cmdCancel(flags, pos) {
  const id = requirePos(pos, 1, '<commandId>');
  const body = await callRpc('command.cancel', { id }, timeoutOf(flags));
  if (!body.ok) return outputFailure(body);
  if (jsonMode) return outputJsonBody(body);
  const result = body.result || {};
  print((result.accepted ? '已取消' : '已转发但命令已结束') + '：' + result.id);
  return 0;
}

async function cmdBrowsers(flags) {
  const body = await callRpc('browsers', {}, timeoutOf(flags));
  if (!body.ok) return outputFailure(body);
  if (jsonMode) return outputJsonBody(body);
  const browsers = (body.result && body.result.browsers) || [];
  if (!browsers.length) {
    print('没有已连接的浏览器；请在 Edge/Chrome 里加载并启用 browser-bridge 扩展');
    return 0;
  }
  print(browserTable(browsers));
  return 0;
}

async function cmdDoctor(flags) {
  const checks = [];
  const add = (status, name, detail) => checks.push({ status, name, detail });
  let hardOk = true;

  add('ok', 'node', process.version);

  try {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    fs.accessSync(HOME_DIR, fs.constants.W_OK);
    add('ok', 'BB_HOME', HOME_DIR);
  } catch (err) {
    hardOk = false;
    add('fail', 'BB_HOME', `${HOME_DIR} 不可写：${err.message}`);
  }

  const info = readDaemonInfo();
  if (info) add('ok', 'daemon.json', `pid ${info.pid}, port ${info.port}`);
  else add('fail', 'daemon.json', `${DAEMON_JSON_PATH} 不存在`);

  const found = await locateDaemon();
  if (found.info) {
    const health = found.health;
    add('ok', 'daemon', `运行中 pid ${health.pid}, port ${health.port}, uptime ${formatUptime(health.uptimeMs)}`);
    try {
      const body = await postRpc(found.info, 'status', {}, 3000);
      if (body.ok) add('ok', 'token', '有效（/rpc status 通）');
      else {
        hardOk = false;
        add('fail', 'token', `/rpc 返回 ${body.error ? body.error.code : 'unknown'}`);
      }
    } catch (err) {
      hardOk = false;
      add('fail', 'token', err.message);
    }
    if (health.browsers > 0) add('ok', 'browsers', `${health.browsers} 个已连接`);
    else add('warn', 'browsers', '0 个已连接（在浏览器里启用扩展）');
    add('ok', 'sessions', `${health.sessions} 个活动`);
  } else {
    hardOk = false;
    add('fail', 'daemon', '未运行（运行 bridge daemon start）');
    if (found.health) {
      add('warn', 'daemon', `pid ${found.health.pid} 在 port ${found.health.port} 监听，但 daemon.json 缺失，无法鉴权`);
    }
  }

  const manifestPath = path.join(REPO_ROOT, 'extension', 'manifest.json');
  if (fs.existsSync(manifestPath)) add('ok', 'extension', manifestPath);
  else add('warn', 'extension', `${manifestPath} 不存在（扩展未加载/未构建）`);

  if (found.info && found.health && found.health.browsers > 0) {
    try {
      const body = await postRpc(found.info, 'diagnostics.ui', {}, 5000);
      if (body.ok && body.result && body.result.ok) {
        const result = body.result;
        add('ok', 'extension-ui', 'popup/options/图标可加载（ext v' + (result.packageVersion || '?') + '）');
      } else {
        hardOk = false;
        add('fail', 'extension-ui', JSON.stringify(body.result || body.error).slice(0, 240));
      }
    } catch (err) {
      hardOk = false;
      add('fail', 'extension-ui', err.message);
    }
  } else {
    add('warn', 'extension-ui', '浏览器未连接，跳过');
  }

  if (!jsonMode) {
    const label = { ok: '[ok]  ', warn: '[warn]', fail: '[fail]' };
    print(checks.map((item) => `${label[item.status] || '[?]   '} ${padEndWidth(item.name, 14)} ${item.detail}`).join('\n'));
  }
  if (jsonMode) {
    const payload = { ok: hardOk, result: { checks, home: HOME_DIR, daemonJson: DAEMON_JSON_PATH, log: LOG_PATH } };
    if (!hardOk) payload.error = { code: 'E_ENV', message: '环境自检未通过' };
    emitJson(payload);
  }
  return hardOk ? 0 : 1;
}

// ---------------------------------------------------------------------------
// 命令：daemon start|stop|status|log | logs [--tail N] | mcp
// ---------------------------------------------------------------------------

async function cmdDaemon(flags, pos) {
  const sub = pos[1];
  if (sub === 'start') {
    const info = await ensureDaemon();
    if (jsonMode) {
      emitJson({ ok: true, result: { running: true, pid: info.pid, port: info.port } });
      return 0;
    }
    print(`daemon 运行中 (pid ${info.pid}, port ${info.port})`);
    return 0;
  }
  if (sub === 'stop') {
    const result = await stopDaemon();
    if (jsonMode) {
      emitJson({ ok: true, result });
      return 0;
    }
    print(result.message);
    return 0;
  }
  if (sub === 'restart') {
    // 重启保留 BB_HOME 下的 sessions.json 与凭据；已连接的浏览器会重新握手。
    const stopped = await stopDaemon();
    const started = await ensureDaemon();
    if (jsonMode) {
      emitJson({ ok: true, result: { restarted: true, stopped: stopped.stopped === true, pid: started.pid, port: started.port } });
      return 0;
    }
    print(`daemon 已重启 (pid ${started.pid}, port ${started.port})`);
    return 0;
  }
  if (sub === 'status') {
    const found = await locateDaemon();
    if (found.info) {
      const health = found.health;
      if (jsonMode) {
        emitJson({
          ok: true,
          result: {
            running: true,
            pid: health.pid,
            port: health.port,
            version: health.version,
            uptimeMs: health.uptimeMs,
            browsers: health.browsers,
            sessions: health.sessions,
          },
        });
        return 0;
      }
      print(`daemon 运行中 (pid ${health.pid}, port ${health.port}, v${health.version}, uptime ${formatUptime(health.uptimeMs)}, browsers ${health.browsers}, sessions ${health.sessions})`);
      return 0;
    }
    if (jsonMode) {
      emitJson({ ok: true, result: { running: false } });
      return 0;
    }
    print('daemon 未运行');
    if (found.health) print(`（检测到 pid ${found.health.pid} 在 port ${found.health.port} 监听，但 daemon.json 缺失）`);
    return 0;
  }
  if (sub === 'devices') {
    const body = await callRpc('pair.list', {}, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    const result = body.result || {};
    print('已配对远程浏览器：' + (result.devices || []).length);
    for (const device of result.devices || []) print('  ' + device.instanceId + '  ' + device.browser + ' v' + (device.browserVersion || '?'));
    print('未使用配对码：' + (result.pairings || []).length);
    return 0;
  }
  if (sub === 'revoke') {
    const code = flags.all === true ? '' : String(pos[2] || '');
    if (!code && flags.all !== true) throw new ArgError('用法：bridge daemon revoke <code> | --all');
    const body = flags.all === true
      ? await (async () => {
        const list = await callRpc('pair.list', {}, timeoutOf(flags));
        let revoked = 0;
        for (const item of (list.result && list.result.pairings) || []) {
          const one = await callRpc('pair.revoke', { code: item.code }, timeoutOf(flags));
          if (one.ok && one.result && one.result.revoked) revoked += 1;
        }
        return { ok: true, result: { revoked, all: true } };
      })()
      : await callRpc('pair.revoke', { code }, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    print('已撤销：' + JSON.stringify(body.result));
    return 0;
  }
  if (sub === 'pair') {
    const params = { replace: flags.replace !== undefined ? String(flags.replace) : '' };
    const body = await callRpc('local.pair', params, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    const result = body.result || {};
    print('本机配对链接：' + result.link);
    print('（5 分钟内有效，粘贴到扩展“连接设置 → 配对链接”）');
    return 0;
  }
  if (sub === 'trust-local') {
    const value = (pos[2] || '').toLowerCase();
    if (value !== 'on' && value !== 'off') throw new ArgError('用法：bridge daemon trust-local on|off');
    const body = await callRpc('local.trust', { strict: value === 'off' }, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    print(value === 'off' ? '本机严格模式已开启：未配对连接会被拒绝' : '本机未配对连接已允许');
    return 0;
  }
  if (sub === 'log') {
    return cmdDaemonLog(flags);
  }
  throw new ArgError('用法：bridge daemon start|stop|status|log|pair|devices|revoke|trust-local on|off [--tail]');
}

/** 原子写：临时文件 + rename，权限尽量收紧到 0600。 */
function writeFileAtomic(file, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  try {
    fs.writeFileSync(temp, content, { encoding: 'utf8', mode });
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* 忽略 */ }
    throw error;
  }
  try { fs.chmodSync(file, mode); } catch { /* Windows 可能不支持 */ }
}

function parseModifiers(value) {
  const map = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
  let bits = 0;
  for (const raw of String(value || '').split(/[+, ]+/).filter(Boolean)) {
    const bit = map[raw.toLowerCase()];
    if (!bit) throw new ArgError('未知修饰键：' + raw + '（可用 alt/ctrl/meta/shift）');
    bits |= bit;
  }
  return bits;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function verifyRelease(manifest, manifestPath) {
  const artifacts = (Array.isArray(manifest.artifacts) ? manifest.artifacts : []).map((item) => {
    const file = path.resolve(REPO_ROOT, String(item.file || path.join('dist', item.name || '')));
    let bytes = null;
    let sha256 = null;
    try {
      const buffer = fs.readFileSync(file);
      bytes = buffer.length;
      sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    } catch {
      // 缺失文件保持 null
    }
    return {
      name: item.name || path.basename(file),
      source: file,
      ok: bytes === item.bytes && sha256 === item.sha256,
      bytes,
      expectedBytes: item.bytes,
      sha256,
      expectedSha256: item.sha256,
    };
  });
  const verified = artifacts.length > 0 && artifacts.every((item) => item.ok);
  return {
    artifacts,
    verified,
    result: {
      version: VERSION,
      latest: typeof manifest.version === 'string' ? manifest.version : null,
      updateAvailable: manifest.version !== VERSION,
      verified,
      manifest: manifestPath,
      artifacts: artifacts.map(({ source, ...rest }) => rest),
    },
  };
}

function cmdUpdate(flags, pos) {
  const sub = pos && pos[1] ? String(pos[1]) : (flags.check === true ? 'check' : '');
  if (sub && !['check', 'verify', 'stage', 'apply', 'rollback', 'fetch', 'state', 'auto'].includes(sub)) {
    throw new ArgError('update 只支持 check|verify|stage|apply|rollback|fetch|state|auto');
  }
  if (sub === 'apply') return cmdUpdateApply(flags);
  if (sub === 'rollback') return cmdUpdateRollback(flags);
  if (sub === 'auto') {
    const state = readUpdateState(UPDATE_STATE_PATH);
    if (flags.disable === true) {
      state.auto = { ...(state.auto || {}), enabled: false, updatedAt: new Date().toISOString() };
      writeUpdateState(UPDATE_STATE_PATH, { auto: state.auto });
      if (jsonMode) { emitJson({ ok: true, result: { auto: state.auto } }); return 0; }
      print('自动更新检查已关闭');
      return 0;
    }
    if (flags.enable === true) {
      if (!flags.source) throw new ArgError('update auto --enable 需要 --source <https URL>');
      const intervalMs = flags.interval !== undefined ? Math.max(60000, parseDurationMs(flags.interval, 6 * 60 * 60 * 1000)) : 6 * 60 * 60 * 1000;
      state.auto = {
        enabled: true,
        source: String(flags.source),
        key: flags.key !== undefined ? path.resolve(process.cwd(), String(flags.key)) : null,
        intervalMs,
        download: flags.download === true,
        apply: flags.apply === true,
        applyTarget: flags.target !== undefined ? path.resolve(process.cwd(), String(flags.target)) : null,
        updatedAt: new Date().toISOString(),
      };
      writeUpdateState(UPDATE_STATE_PATH, { auto: state.auto });
      if (jsonMode) { emitJson({ ok: true, result: { auto: state.auto } }); return 0; }
      print('自动更新检查已开启：' + state.auto.source + '（每 ' + Math.round(intervalMs / 60000) + ' 分钟）');
      return 0;
    }
    if (jsonMode) { emitJson({ ok: true, result: { auto: state.auto || { enabled: false } } }); return 0; }
    print(JSON.stringify(state.auto || { enabled: false }, null, 2));
    return 0;
  }
  if (sub === 'fetch') return cmdUpdateFetch(flags);
  if (sub === 'state') {
    const state = readUpdateState(UPDATE_STATE_PATH);
    if (jsonMode) {
      emitJson({ ok: true, result: { state } });
      return 0;
    }
    print(JSON.stringify(state, null, 2));
    return 0;
  }
  const manifestPath = flags.manifest !== undefined
    ? path.resolve(process.cwd(), String(flags.manifest))
    : path.join(REPO_ROOT, 'dist', 'release.json');
  let manifest = null;
  let parseError = null;
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      parseError = error.message;
    }
  }
  if (!manifest) {
    const result = {
      version: VERSION,
      latest: null,
      updateAvailable: false,
      verified: false,
      manifest: manifestPath,
      note: parseError ? '发布清单解析失败：' + parseError : '未找到发布清单（先运行 node tools/release.mjs）',
    };
    if (jsonMode) {
      emitJson({ ok: true, result });
      return 0;
    }
    print(result.note);
    return 0;
  }
  const { artifacts, verified, result } = verifyRelease(manifest, manifestPath);
  const signKey = flags.key !== undefined
    ? fs.readFileSync(path.resolve(process.cwd(), String(flags.key)), 'utf8').trim()
    : '';
  const signature = { present: Boolean(manifest.signature), valid: null };
  if (manifest.signature && signKey) signature.valid = verifyReleaseSignature(manifest, signKey);
  else if (!manifest.signature && signKey) signature.valid = false;
  result.signature = signature;
  writeUpdateState(UPDATE_STATE_PATH, {
    lastCheck: { manifest: manifestPath, latest: result.latest, verified, signature, at: new Date().toISOString() },
  });

  if (sub === 'stage') {
    if (!verified) throw new BridgeError('E_RELEASE_INVALID', '发布清单校验失败，拒绝 staging');
    if (signature.valid === false) throw new BridgeError('E_RELEASE_INVALID', '发布清单签名无效，拒绝 staging');
    if (flags.dir === undefined) throw new ArgError('update stage 需要 --dir <path>');
    const version = typeof manifest.version === 'string' ? manifest.version : VERSION;
    const target = path.resolve(process.cwd(), String(flags.dir), 'v' + version);
    if (fs.existsSync(target) && fs.readdirSync(target).length && flags.force !== true) {
      throw new BridgeError('E_EXISTS', 'staging 目录已存在非空内容：' + target + '（加 --force 覆盖）');
    }
    fs.mkdirSync(target, { recursive: true });
    const staged = [];
    for (const item of artifacts) {
      const name = path.basename(item.name || item.source);
      const dest = path.join(target, name);
      fs.copyFileSync(item.source, dest);
      const sha256 = sha256File(dest);
      if (sha256 !== item.sha256) throw new BridgeError('E_RELEASE_INVALID', 'staging 后校验失败：' + name);
      staged.push({ name, bytes: item.bytes, sha256 });
    }
    const record = { version, stagedAt: new Date().toISOString(), manifest: manifestPath, artifacts: staged };
    fs.writeFileSync(path.join(target, 'staged.json'), JSON.stringify(record, null, 2) + '\n', 'utf8');
    const stagedResult = { version, dir: target, verified: true, artifacts: staged };
    writeUpdateState(UPDATE_STATE_PATH, {
      lastStage: { version, dir: target, artifacts: staged.length, at: new Date().toISOString() },
    });
    if (jsonMode) {
      emitJson({ ok: true, result: stagedResult });
      return 0;
    }
    print('已 staging v' + version + ' → ' + target);
    for (const item of staged) print('  ' + item.name + '  ' + item.bytes + 'B  ' + item.sha256.slice(0, 16) + '…');
    print('注意：仅落盘 staging，不替换当前安装。');
    return 0;
  }

  if (jsonMode) {
    emitJson({ ok: true, result });
    return verified ? 0 : 1;
  }
  print('当前版本：' + VERSION + '，清单版本：' + (result.latest || '?') + (result.updateAvailable ? '（有差异）' : '（一致）'));
  for (const item of artifacts) print((item.ok ? 'OK   ' : 'FAIL ') + item.name + '  ' + (item.bytes == null ? '缺文件' : item.bytes + 'B'));
  print(verified ? '发布清单校验通过。' : '发布清单校验失败。');
  return verified ? 0 : 1;
}

async function cmdUpdateFetch(flags) {
  let source;
  let manifest;
  if (flags.source !== undefined) {
    source = String(flags.source);
    manifest = await fetchManifest(source);
  } else {
    const picked = await fetchManifestWithFallback([
      { name: '官网国内源', url: DOMESTIC_MANIFEST_URL },
      { name: 'GitHub 回退', url: GITHUB_MANIFEST_URL },
    ]);
    source = picked.source;
    manifest = picked.manifest;
  }
  if (!manifest || typeof manifest !== 'object' || typeof manifest.version !== 'string' || !Array.isArray(manifest.artifacts)) {
    throw new BridgeError('E_RELEASE_INVALID', '发布清单缺少 version/artifacts');
  }
  let signature = { present: Boolean(manifest.signature), valid: null };
  if (flags.key !== undefined) {
    const key = fs.readFileSync(path.resolve(process.cwd(), String(flags.key)), 'utf8').trim();
    signature.valid = verifyReleaseSignature(manifest, key);
    if (!signature.valid) throw new BridgeError('E_RELEASE_INVALID', '远程发布清单签名无效');
  }
  const out = path.resolve(process.cwd(), flags.out !== undefined ? String(flags.out) : path.join(HOME_DIR, 'update-cache', 'release.json'));
  writeFileAtomic(out, JSON.stringify(manifest, null, 2) + '\n');
  writeUpdateState(UPDATE_STATE_PATH, {
    lastFetch: { source, out, version: manifest.version, artifacts: manifest.artifacts.length, signature, at: new Date().toISOString() },
  });
  const result = { source, out, version: manifest.version, artifacts: manifest.artifacts.length, signature };
  if (jsonMode) {
    emitJson({ ok: true, result });
    return 0;
  }
  print('已拉取发布清单：v' + manifest.version + '（' + manifest.artifacts.length + ' 个 artifact）→ ' + out);
  if (signature.present) print('签名：' + (signature.valid === true ? '有效' : signature.valid === false ? '无效' : '未提供 key，未校验'));
  return 0;
}

function cmdUpdateApply(flags) {
  if (flags.staging === undefined) throw new ArgError('update apply 需要 --staging <dir>');
  if (flags.target === undefined) throw new ArgError('update apply 需要 --target <dir>');
  const stagedDir = path.resolve(process.cwd(), String(flags.staging));
  const recordPath = path.join(stagedDir, 'staged.json');
  if (!fs.existsSync(recordPath)) throw new BridgeError('E_NOT_FOUND', 'staging 目录缺少 staged.json：' + recordPath);
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  const target = path.resolve(process.cwd(), String(flags.target));
  fs.mkdirSync(target, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14) + '-' + crypto.randomBytes(2).toString('hex');
  const backupDir = path.join(target, '.backup-' + stamp);
  fs.mkdirSync(backupDir, { recursive: true });
  const files = [];
  for (const item of Array.isArray(record.artifacts) ? record.artifacts : []) {
    if (!item || !item.name) throw new BridgeError('E_RELEASE_INVALID', 'staged.json artifact 缺少 name');
    const src = path.join(stagedDir, item.name);
    if (!fs.existsSync(src)) throw new BridgeError('E_NOT_FOUND', 'staging 缺少文件：' + src);
    const sha256 = sha256File(src);
    if (sha256 !== item.sha256) throw new BridgeError('E_RELEASE_INVALID', 'staging 文件哈希不匹配：' + item.name);
    const dest = path.join(target, item.name);
    const existed = fs.existsSync(dest);
    let backup = null;
    let beforeSha256 = null;
    if (existed) {
      backup = path.relative(target, path.join(backupDir, item.name));
      fs.copyFileSync(dest, path.join(backupDir, item.name));
      beforeSha256 = sha256File(dest);
    }
    fs.copyFileSync(src, dest);
    if (sha256File(dest) !== sha256) throw new BridgeError('E_RELEASE_INVALID', '写入后校验失败：' + item.name);
    files.push({ name: item.name, existed, backup, beforeSha256, bytes: item.bytes, sha256 });
  }
  const backupRecord = { version: record.version, target, backupDir, files, createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(backupDir, 'backup.json'), JSON.stringify(backupRecord, null, 2) + '\n', 'utf8');
  const result = { version: record.version, target, backupDir, files };
  writeUpdateState(UPDATE_STATE_PATH, {
    lastApply: { version: record.version, target, backupDir, files: files.length, at: new Date().toISOString() },
  });
  if (jsonMode) {
    emitJson({ ok: true, result });
    return 0;
  }
  print('已应用 v' + record.version + ' → ' + target);
  for (const item of files) print('  ' + item.name + (item.existed ? '（已备份）' : '（新增）'));
  print('回滚目录：' + backupDir);
  return 0;
}

function cmdUpdateRollback(flags) {
  if (flags.backup === undefined) throw new ArgError('update rollback 需要 --backup <dir>');
  const backupDir = path.resolve(process.cwd(), String(flags.backup));
  const recordPath = path.join(backupDir, 'backup.json');
  if (!fs.existsSync(recordPath)) throw new BridgeError('E_NOT_FOUND', '备份目录缺少 backup.json：' + recordPath);
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  const target = path.resolve(String(record.target || ''));
  const restored = [];
  for (const item of Array.isArray(record.files) ? record.files : []) {
    const dest = path.join(target, item.name);
    if (item.existed) {
      const backupFile = item.backup
        ? path.resolve(target, item.backup)
        : path.join(backupDir, item.name);
      if (!fs.existsSync(backupFile)) throw new BridgeError('E_NOT_FOUND', '备份文件缺失：' + backupFile);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(backupFile, dest);
      if (item.beforeSha256 && sha256File(dest) !== item.beforeSha256) {
        throw new BridgeError('E_RELEASE_INVALID', '回滚后哈希不符：' + item.name);
      }
    } else {
      fs.rmSync(dest, { force: true });
    }
    restored.push({ name: item.name, existed: item.existed });
  }
  const result = { version: record.version || null, target, restored };
  writeUpdateState(UPDATE_STATE_PATH, {
    lastRollback: { version: record.version || null, target, at: new Date().toISOString() },
  });
  if (jsonMode) {
    emitJson({ ok: true, result });
    return 0;
  }
  print('已回滚 v' + (record.version || '?') + ' ← ' + target);
  for (const item of restored) print('  ' + item.name + (item.existed ? '（恢复旧文件）' : '（移除新增文件）'));
  return 0;
}

function cmdMcp() {
  const server = path.join(REPO_ROOT, 'mcp', 'server.mjs');
  if (!fs.existsSync(server)) throw new ArgError('找不到 MCP server：' + server);
  const child = spawn(process.execPath, [server], { stdio: 'inherit', env: { ...process.env } });
  return new Promise((resolve) => {
    child.on('close', (code) => resolve(code || 0));
    child.on('error', () => resolve(1));
  });
}

function cmdDaemonLog(flags) {
  const exists = fs.existsSync(LOG_PATH);
  const size = exists ? fs.statSync(LOG_PATH).size : 0;
  const tailWanted = flags.tail !== undefined ? (typeof flags.tail === 'number' ? flags.tail : 50) : 0;
  let lines = [];
  if (exists && tailWanted > 0) lines = tailFile(LOG_PATH, tailWanted);
  if (jsonMode) {
    emitJson({ ok: true, result: { path: LOG_PATH, exists, size, lines } });
    return 0;
  }
  if (!exists) {
    print(`日志文件不存在：${LOG_PATH}`);
    return 0;
  }
  if (tailWanted > 0) print(lines.join('\n'));
  else print(`日志文件：${LOG_PATH}（${formatBytes(size)}）`);
  return 0;
}

function tailFile(file, count) {
  try {
    const stat = fs.statSync(file);
    const maxBytes = 256 * 1024;
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buffer, 0, length, start); } finally { fs.closeSync(fd); }
    let text = buffer.toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      if (nl >= 0) text = text.slice(nl + 1);
    }
    return text.split(/\r?\n/).filter(Boolean).slice(-count);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 命令：session start|stop|list
// ---------------------------------------------------------------------------

async function cmdSession(flags, pos) {
  const sub = pos[1];
  if (sub === 'start') {
    // 默认把新建的 Agent Window 置前，让用户看得见 Agent 在独立窗口里干活；
    // 只有显式 --no-focus 才在后台开窗（不抢焦点）。
    const params = { noFocus: flags['no-focus'] === true };
    if (flags.incognito === true) params.incognito = true;
    if (flags.browser !== undefined) params.browser = String(flags.browser);
    if (flags['agent-name'] !== undefined) {
      const controller = { name: String(flags['agent-name']) };
      if (flags.project !== undefined) controller.project = String(flags.project);
      if (flags['controller-color'] !== undefined) controller.color = String(flags['controller-color']);
      if (!isControllerInfo(controller)) throw new ArgError('--agent-name/--project/--controller-color 不合法（名称 1-80 字符，项目 1-120 字符，颜色 #rrggbb）');
      params.controller = controller;
    } else if (flags.project !== undefined || flags['controller-color'] !== undefined) {
      throw new ArgError('--project/--controller-color 需要同时提供 --agent-name');
    }
    if (flags.tab !== undefined) {
      const tabId = intFlag(flags, 'tab', { min: 1 });
      params.tab = tabId;
    }
    const body = await callRpc('session.start', params, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    const result = body.result || {};
    print(`session ${result.sessionId} 已创建（instance ${result.instanceId}, tab ${result.tabId}, window ${result.windowId}）`);
    return 0;
  }
  if (sub === 'stop') {
    const sessionId = pos[2] || flags.session;
    if (!sessionId) throw new ArgError('用法：bridge session stop <sessionId> [--keep]');
    const params = { session: String(sessionId), keep: flags.keep === true };
    const body = await callRpc('session.stop', params, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    print(`session ${sessionId} 已停止${flags.keep === true ? '（保留窗口）' : ''}`);
    return 0;
  }
  if (sub === 'pause' || sub === 'resume') {
    const sessionId = pos[2] || flags.session;
    if (!sessionId) throw new ArgError('用法：bridge session pause|resume <sessionId>');
    const pauseParams = { session: String(sessionId), paused: sub === 'pause' };
    if (flags.reason !== undefined) pauseParams.reason = String(flags.reason);
    if (flags.auto === true) pauseParams.auto = true;
    const body = await callRpc('session.pause', pauseParams, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    print('session ' + sessionId + (sub === 'pause' ? ' 已暂停' : ' 已恢复'));
    return 0;
  }
  if (sub === 'rebind') {
    const sessionId = pos[2] || flags.session;
    if (!sessionId) throw new ArgError('用法：bridge session rebind <sessionId> --tab <tabId> [--release-old]');
    const tabId = intFlag(flags, 'tab', { min: 1 });
    if (!tabId) throw new ArgError('session rebind 需要 --tab <tabId>');
    const params = { session: String(sessionId), tab: tabId, releaseOld: flags['release-old'] === true };
    const body = await callRpc('session.rebind', params, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    const result = body.result || {};
    print('session ' + sessionId + ' 已重绑到 tab ' + result.tabId + '（' + (result.url || '') + '）');
    return 0;
  }
  if (sub === 'list') {
    const body = await callRpc('session.list', {}, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    const sessions = (body.result && body.result.sessions) || [];
    if (!sessions.length) {
      print('没有活动 session');
      return 0;
    }
    print(renderTable(
      ['session', 'instance', 'tab', 'window', 'agent / project', 'url', 'title', 'started'],
      sessions.map((item) => [
        item.sessionId,
        item.instanceId,
        item.tabId,
        item.windowId,
        item.controller ? (item.controller.project ? `${item.controller.name} / ${item.controller.project}` : item.controller.name) : '-',
        truncateText(item.url, 48),
        truncateText(item.title, 32),
        formatTime(item.startedAt),
      ]),
    ));
    return 0;
  }
  throw new ArgError('用法：bridge session start|stop|list');
}

// ---------------------------------------------------------------------------
// 命令：tab list|new|close|select  /  window resize
// ---------------------------------------------------------------------------

async function cmdTab(flags, pos) {
  const sub = pos[1];
  const withSession = (params) => {
    if (flags.session !== undefined) params.session = String(flags.session);
    return params;
  };
  if (sub === 'list') {
    const params = withSession({ scope: flags.scope !== undefined ? String(flags.scope) : 'agent' });
    const body = await callRpc('tab.list', params, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    const tabs = (body.result && body.result.tabs) || [];
    if (!tabs.length) {
      print('(没有 tab)');
      return 0;
    }
    print(renderTable(
      ['tab', 'window', 'url', 'title', 'active'],
      tabs.map((item) => [item.tabId, item.windowId, truncateText(item.url, 56), truncateText(item.title, 28), item.active ? 'yes' : '']),
    ));
    return 0;
  }
  if (sub === 'new') {
    const params = withSession({ noFocus: flags['no-focus'] === true });
    if (pos[2]) params.url = pos[2];
    if (flags.window === true) params.newWindow = true;
    const body = await callRpc('tab.new', params, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    const result = body.result || {};
    print(`tab ${result.tabId} 已创建（window ${result.windowId}）`);
    return 0;
  }
  if (sub === 'borrow' || sub === 'return') {
    const tabId = requirePos(pos, 2, '<tabId>');
    if (!/^\d+$/.test(tabId)) throw new ArgError('<tabId> 需要整数，收到 "' + tabId + '"');
    const body = await callRpc('tab.' + sub, { tabId: Number(tabId) }, Math.max(timeoutOf(flags), 45000));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    if (sub === 'borrow') {
      const result = body.result || {};
      print('已借用 tab ' + result.tabId + '（window ' + result.windowId + '）：' + truncateText(result.url || '', 60));
    } else {
      print('已归还 tab ' + tabId + '（标签页保持打开）');
    }
    return 0;
  }
  if (sub === 'close' || sub === 'select') {
    const tabId = requirePos(pos, 2, '<tabId>');
    if (!/^\d+$/.test(tabId)) throw new ArgError(`<tabId> 需要整数，收到 "${tabId}"`);
    const params = withSession({ tabId: Number(tabId) });
    const body = await callRpc(`tab.${sub}`, params, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    print('ok');
    return 0;
  }
  if (sub === 'move') {
    const tabId = requirePos(pos, 2, '<tabId>');
    if (!/^\d+$/.test(tabId)) throw new ArgError('<tabId> 需要整数');
    if (flags['to-window'] === undefined) throw new ArgError('tab move 需要 --to-window <windowId>');
    const windowId = Number(flags['to-window']);
    if (!Number.isInteger(windowId)) throw new ArgError('--to-window 需要整数');
    const body = await callRpc('tab.move', { tabId: Number(tabId), windowId }, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    print('tab ' + tabId + ' 已移动到 window ' + windowId);
    return 0;
  }
  throw new ArgError('用法：bridge tab list|new|close|select|move');
}

async function cmdWindow(flags, pos) {
  const sub = pos[1];
  if (sub === 'list') {
    const body = await callRpc('window.list', {}, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    const windows = (body.result && body.result.windows) || [];
    if (!windows.length) return print('(没有窗口)');
    print(renderTable(['window', 'focused', 'type', 'tabs'], windows.map((win) => [
      String(win.windowId), win.focused ? 'yes' : 'no', win.type, String((win.tabs || []).length),
    ])));
    return 0;
  }
  if (sub === 'focus') {
    const windowId = Number(requirePos(pos, 2, '<windowId>'));
    if (!Number.isInteger(windowId)) throw new ArgError('<windowId> 需要整数');
    const body = await callRpc('window.focus', { windowId }, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    print('已聚焦 window ' + windowId);
    return 0;
  }
  if (sub === 'ensure') {
    const params = {};
    if (flags.session !== undefined) params.session = String(flags.session);
    const body = await callRpc('window.ensureAgent', params, Math.max(timeoutOf(flags), 30000));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    const result = body.result || {};
    print('Agent 窗口：window ' + result.windowId + '，tab ' + result.tabId + '（' + (result.created ? '新建' : '复用') + '）');
    return 0;
  }
  if (sub !== 'resize') throw new ArgError('用法：bridge window list|focus <windowId>|ensure|resize --width <n> --height <n>');
  const width = intFlag(flags, 'width', { min: 1 });
  const height = intFlag(flags, 'height', { min: 1 });
  if (width === undefined || height === undefined) throw new ArgError('window resize 需要 --width 与 --height');
  const params = { width, height };
  if (flags.session !== undefined) params.session = String(flags.session);
  const body = await callRpc('window.resize', params, timeoutOf(flags));
  if (!body.ok) return outputFailure(body);
  if (jsonMode) return outputJsonBody(body);
  print('ok');
  return 0;
}

// ---------------------------------------------------------------------------
// 命令：页面方法
// ---------------------------------------------------------------------------

const PAGE_COMMANDS = new Set([
  'navigate', 'reload', 'back', 'forward', 'navigate-back', 'navigate-forward', 'observe', 'snapshot',
  'get-html', 'screenshot', 'click', 'hover', 'fill', 'press',
  'select', 'focus', 'scroll-to', 'evaluate',
  'wait-for-element', 'wait-for-navigation', 'wait-ms', 'console', 'actionable',
]);

async function cmdPage(command, flags, pos) {
  if (!PAGE_COMMANDS.has(command)) throw new ArgError(`未知命令：${command}（运行 bridge -h 查看用法）`);

  switch (command) {
    case 'navigate': {
      const url = requirePos(pos, 1, '<url>');
      // PROTOCOL §5.2 的 navigate 没有 noFocus 参数；窗口聚焦由 session start --no-focus 决定。
      const body = await callRpc('navigate', withControl(flags, { url }), timeoutOf(flags));
      return renderPageBody(body, (result) => {
        const title = result && result.title ? `（${result.title}）` : '';
        print(`已导航：${(result && result.url) || url}${title}`);
      });
    }
    case 'reload':
    case 'back':
    case 'forward':
    case 'navigate-back':
    case 'navigate-forward': {
      const method = command === 'navigate-back' || command === 'back' ? 'navigate-back' : (command === 'navigate-forward' || command === 'forward' ? 'navigate-forward' : 'reload');
      const body = await callRpc(method, withControl(flags, {}), timeoutOf(flags));
      return renderPageBody(body, () => print('ok'));
    }
    case 'observe': {
      if (flags.frames === true) {
        const params = withControl(flags, {});
        if (flags['probe-hover'] === true) params.probeHover = true;
        const body = await callRpc('observe-frames', params, timeoutOf(flags));
        if (!body.ok) return outputFailure(body);
        if (jsonMode) return outputJsonBody(body);
        const result = body.result || {};
        print(String(result.text || '').trim() || '(没有可观察的 frame)');
        print('');
        if (result.downgraded) print('（该扩展未声明 frames 能力，已降级为主文档观察）');
        print('frames: ' + (result.frames || []).length + '  refs: ' + (result.refs || 0));
        return 0;
      }
      const params = withControl(flags, {});
      if (flags['probe-hover'] === true) params.probeHover = true;
      if (flags['closed-shadow'] === true) params.closedShadow = true;
      if (flags['max-tokens'] !== undefined) params.maxTokens = intFlag(flags, 'max-tokens', { min: 1 });
      if (flags['max-depth'] !== undefined) params.maxDepth = intFlag(flags, 'max-depth', { min: 1 });
      if (flags['debug-surfaces'] === true) params.debugSurfaces = true;
      if (flags.vom === true) params.vom = true;
      if (flags.ax === true) params.ax = true;
      if (flags.cursor !== undefined) params.cursor = String(flags.cursor);
      if (flags.delta === true || flags.baseline !== undefined) {
        const baseline = flags.baseline !== undefined ? String(flags.baseline) : '';
        params.delta = true;
        if (baseline) params.baseline = baseline;
      }
      const body = await callRpc('observe', params, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (body.result && body.result.delta === true) {
        const baseline = String(params.baseline);
        const merged = applyCachedObservation(baseline, body.result.patch);
        if (merged == null) {
          // 本地没有基线缓存：退回整页观察，避免凭空合并
          const fresh = await callRpc('observe', withControl(flags, {}), timeoutOf(flags));
          if (!fresh.ok) return outputFailure(fresh);
          body.result = fresh.result;
        } else {
          saveObservationCache(body.result.observationId, merged);
          if (jsonMode) {
            emitJson({ ok: true, result: { ...body.result, mergedChars: merged.length } });
            return 0;
          }
          print(`delta: ${body.result.changes} 行变化（基线 ${baseline}）`);
          for (const entry of body.result.patch || []) {
            print(`  L${Number(entry.line) + 1}: ${String(entry.value).slice(0, 200)}`);
          }
          if (flags.out !== undefined) {
            const file = path.resolve(process.cwd(), String(flags.out));
            writeFileAtomic(file, merged, 0o600);
            print('已写出合并结果：' + file);
          }
          return 0;
        }
      }
      if (body.result && body.result.observationId) {
        saveObservationCache(body.result.observationId, String(body.result.observation || ''));
      }
      const savedPath = flags['save-full'];
      if (savedPath !== undefined && body.result) {
        const file = path.resolve(process.cwd(), String(savedPath));
        writeFileAtomic(file, String(body.result.observation || ''), 0o600);
        body.result.savedTo = file;
      }
      if (jsonMode) {
        emitJson(body);
        return 0;
      }
      const result = body.result || {};
      const lines = [
        `url: ${result.url || ''}`,
        `title: ${result.title || ''}`,
        '',
        result.observation || '',
      ];
      if (typeof result.refs === 'number') lines.push('', `refs: ${result.refs}`);
      if (result.observationId) lines.push(`observation: ${result.observationId}（用于 --delta --baseline）`);
      if (result.baselineReason) lines.push(`baseline: 结构性变化（${result.baselineReason}），已返回整页`);
      if (Array.isArray(result.nodes)) lines.push(`vom nodes: ${result.nodes.length}（--json 查看结构化字段）`);
      if (Array.isArray(result.axNodes)) lines.push(`ax nodes: ${result.axNodes.length}（--json 查看 AX 字段）`);
      if (result.axJoin) lines.push(`ax join: matched ${result.axJoin.matched} / unmatched ${result.axJoin.unmatched}`);
      if (result.savedTo) lines.push(`已保存完整观察：${result.savedTo}`);
      if (result.cursor) lines.push('', '@more ' + result.cursor);
      print(lines.join('\n'));
      return 0;
    }
    case 'snapshot': {
      const body = await callRpc('snapshot', withControl(flags, {}), timeoutOf(flags));
      return renderPageBody(body, (result) => print(result.text ?? ''));
    }
    case 'actionable': {
      const t = resolveTarget(flags, pos, 1, { required: true });
      const body = await callRpc('actionable', withControl(flags, { ...(t || {}) }), timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (jsonMode) return outputJsonBody(body);
      const r = body.result || {};
      print(r.ok ? 'actionable: ok' : 'actionable: ' + (r.reason || 'unknown'));
      return r.ok ? 0 : 1;
    }
    case 'get-html': {
      const target = resolveTarget(flags, pos, 1, { required: false });
      const body = await callRpc('get-html', withControl(flags, { ...(target || {}) }), timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      const result = body.result || {};
      const html = typeof result.html === 'string' ? result.html : '';
      const bytes = Buffer.byteLength(html);
      if (flags.out !== undefined) {
        const file = path.resolve(process.cwd(), String(flags.out));
        writeFileAtomic(file, html, 0o600);
        if (jsonMode) {
          emitJson({
            ok: true,
            result: {
              tab_id: result.tabId !== undefined ? result.tabId : null,
              path: file,
              written_bytes: bytes,
              byte_size: bytes,
              truncated: result.truncated === true,
              ...(result.dialogs ? { dialogs: result.dialogs } : {}),
            },
          });
          return 0;
        }
        print('已保存 HTML：' + file + '（' + formatBytes(bytes) + (result.truncated === true ? '，已截断' : '') + '）');
        return 0;
      }
      if (jsonMode) {
        emitJson(body);
        return 0;
      }
      print(html);
      return 0;
    }
    case 'screenshot': {
      const out = flags.out;
      const mode = flags.mode === undefined ? (flags.full === true ? 'auto' : 'visible') : String(flags.mode);
      if (flags['full-page'] === true && mode === undefined) mode = 'auto';
      if (!['visible', 'auto', 'manual'].includes(mode)) throw new ArgError('--mode 需要 visible|auto|manual');

      if (flags.stitch === true) {
        if (!out) throw new ArgError('screenshot --stitch 需要 --out <path>');
        const body = await callRpc('screenshot.manual.save', withControl(flags, {}), Math.max(timeoutOf(flags), 120000));
        if (!body.ok) return outputFailure(body);
        const result = body.result || {};
        const written = writeDataUrl(out, result.dataUrl);
        if (jsonMode) {
          emitJson({ ok: true, result: { path: written.target, width: result.width, height: result.height, frames: result.frames, bytes: written.buffer.length } });
          return 0;
        }
        print('已保存拼接长图：' + written.target + '（' + result.width + 'x' + result.height + '，' + (result.frames || 0) + ' 帧，' + formatBytes(written.buffer.length) + '）');
        return 0;
      }

      if (mode === 'manual') {
        // 每次只追加一帧；帧由扩展按 tabId 保存，直到 --stitch 拼接后清空。
        const body = await callRpc('screenshot.manual.frame', withControl(flags, {}), timeoutOf(flags));
        if (!body.ok) return outputFailure(body);
        const frame = body.result || {};
        if (jsonMode) {
          emitJson({ ok: true, result: { frames: frame.frames, width: frame.width, height: frame.height } });
          return 0;
        }
        print('已拍第 ' + frame.frames + ' 帧（' + frame.width + 'x' + frame.height + '）：滚动页面后重复执行，最后用 --stitch --out <path> 保存');
        return 0;
      }

      if (!out) throw new ArgError('screenshot 需要 --out <path>');
      const params = withControl(flags, { fullPage: mode === 'auto' });
      if (flags.annotate === true) params.annotate = true;
      if (flags.overlap !== undefined) {
        const overlap = Number(flags.overlap);
        if (!Number.isFinite(overlap) || overlap < 0) throw new ArgError('--overlap 需要非负数');
        params.overlap = overlap;
      }
      if (flags.scope !== undefined) {
        const scope = String(flags.scope);
        if (!['viewport', 'document', 'follow', 'current'].includes(scope)) throw new ArgError('--scope 只能是 viewport|document|follow|current');
        params.scope = scope;
        if (scope === 'viewport') params.fullPage = false;
        if (scope === 'follow') { params.fullPage = true; params.growth = true; }
        if (scope === 'current') { params.fullPage = true; params.growth = false; }
      }
      const target = resolveTarget(flags, pos, 1, { required: false });
      if (target) Object.assign(params, target);
      if (flags.region !== undefined) {
        const parts = String(flags.region).split(',').map((item) => Number(item.trim()));
        if (parts.length !== 4 || parts.some((item) => !Number.isFinite(item) || item < 0) || parts[2] <= 0 || parts[3] <= 0) {
          throw new ArgError('--region 需要 x,y,w,h 四个非负数，且宽高大于 0');
        }
        params.region = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
      }
      const body = await callRpc('screenshot', params, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      const result = body.result || {};
      const written = writeDataUrl(out, result.dataUrl);
      if (jsonMode) {
        // --json 不输出 dataUrl（数 MB base64 会撑爆调用方行缓冲，且已落盘）
        const summary = {
          path: written.target,
          width: result.width ?? null,
          height: result.height ?? null,
          bytes: written.buffer.length,
        };
        if (result.capture_id) summary.capture_id = result.capture_id;
        if (Array.isArray(result.visual_refs)) summary.visual_refs = result.visual_refs;
        emitJson({ ok: true, result: summary });
        return 0;
      }
      print('已保存：' + written.target + '（' + (result.width || '?') + 'x' + (result.height || '?') + '，' + formatBytes(written.buffer.length) + '）');
      if (result.capture_id) print('capture_id: ' + result.capture_id + '（视觉坐标点击：bridge click --capture <id> --image-x X --image-y Y）');
      if (Array.isArray(result.visual_refs)) print('视觉引用：' + result.visual_refs.length + ' 个');
      return 0;
    }
    case 'click':
    case 'hover':
    case 'focus':
    case 'scroll-to': {
      if (command === 'click' && flags['closed-shadow-text'] !== undefined) {
        const params = withControl(flags, { text: String(flags['closed-shadow-text']) });
        const body = await callRpc('shadow.click', params, timeoutOf(flags));
        if (!body.ok) return outputFailure(body);
        if (jsonMode) return outputJsonBody(body);
        const result = body.result || {};
        print('已在 closed shadow 内点击「' + (result.matched || '') + '」（' + (result.tag || '') + '，' + result.via + '）');
        return 0;
      }
      if (command === 'click' && flags.capture !== undefined) {
        if (flags['image-x'] === undefined || flags['image-y'] === undefined) {
          throw new ArgError('click --capture 需要同时给 --image-x 与 --image-y');
        }
        const params = withControl(flags, {
          capture: String(flags.capture),
          imageX: Number(flags['image-x']),
          imageY: Number(flags['image-y']),
        });
        const body = await callRpc('click-point', params, timeoutOf(flags));
        if (!body.ok) return outputFailure(body);
        if (jsonMode) return outputJsonBody(body);
        const result = body.result || {};
        print('已按图坐标点击（' + result.via + '）：页面 (' + result.x + ', ' + result.y + ')' + (result.tag ? ' <' + result.tag + '>' : ''));
        return 0;
      }
      const target = resolveTarget(flags, pos, 1, { required: true });
      const params = withControl(flags, { ...target });
      if (flags.trusted === true) params.trusted = true;
      if (flags.force === true) params.force = true;
      let beforeUrl = null;
      if (command === 'click' && flags['wait-navigation'] === true) {
        const probe = await callRpc('evaluate', withNavigationProbe(flags, 'location.href'), Math.max(timeoutOf(flags), 5000));
        if (probe.ok) beforeUrl = String((probe.result || {}).value || '');
      }
      const body = await callRpc(command, params, timeoutOf(flags));
      if (body.ok && command === 'click' && beforeUrl) {
        const navigation = await waitForNavigationAfterClick(flags, beforeUrl);
        if (!body.result) body.result = {};
        body.result.navigation = navigation;
        if (!jsonMode && navigation.navigated) print('已导航到：' + navigation.url);
      }
      if (command === 'scroll-to' && body.ok && !jsonMode) {
        const result = body.result || {};
        const bounds = result.bounds || {};
        const viewport = result.viewport || {};
        print('已滚动到目标（元素边界 ' + bounds.x + ',' + bounds.y + ' ' + bounds.width + 'x' + bounds.height +
          '，视口 ' + viewport.width + 'x' + viewport.height + '，scroll ' + (result.scroll && result.scroll.y) + '）');
        return 0;
      }
      return renderPageBody(body, () => print('ok'));
    }
    case 'fill': {
      const target = resolveTarget(flags, pos, 1, { required: true });
      if (flags.value === undefined) throw new ArgError('fill 需要 --value <text>');
      const params = { ...target, value: String(flags.value) };
      if (flags['no-clear'] === true) params.noClear = true;
      if (flags.trusted === true) params.trusted = true;
      if (flags.force === true) params.force = true;
      const body = await callRpc('fill', withControl(flags, params), timeoutOf(flags));
      return renderPageBody(body, () => print('ok'));
    }
    case 'press': {
      const key = requirePos(pos, 1, '<key>');
      const params = { key };
      if (flags.trusted === true) params.trusted = true;
      if (flags.force === true) params.force = true;
      const target = resolveTarget(flags, pos, 2, { required: false });
      if (target) Object.assign(params, target);
      const body = await callRpc('press', withControl(flags, params), timeoutOf(flags));
      return renderPageBody(body, () => print('ok'));
    }
    case 'select': {
      const target = resolveTarget(flags, pos, 1, { required: true });
      if (flags.value === undefined) throw new ArgError('select 需要 --value <value>');
      const params = { ...target, value: String(flags.value) };
      const body = await callRpc('select', withControl(flags, params), timeoutOf(flags));
      return renderPageBody(body, () => print('ok'));
    }
    case 'evaluate': {
      const expression = requirePos(pos, 1, '<expression>');
      const body = await callRpc('evaluate', withControl(flags, { expression }), timeoutOf(flags));
      return renderPageBody(body, (result) => {
        if (typeof result.value === 'string') print(result.value);
        else print(JSON.stringify(result.value ?? null, null, 2));
        if (result.note) process.stderr.write(`(${result.note})\n`);
      });
    }
    case 'wait-for-element': {
      const target = resolveTarget(flags, pos, 1, { required: true });
      const state = flags.state !== undefined ? String(flags.state) : 'visible';
      const timeoutMs = parseDurationMs(flags.timeout, 10_000);
      const params = { ...target, state, timeoutMs };
      if (flags['operation-id'] !== undefined) params.operationId = String(flags['operation-id']);
      const body = await callRpc('wait-for-element', withControl(flags, params), Math.max(timeoutOf(flags), timeoutMs + 5000));
      if (!body.ok) return outputFailure(body);
      if (jsonMode) {
        emitJson(body);
        return 0;
      }
      const result = body.result || {};
      print(
        (result.cancelled ? '已取消' : result.satisfied ? '已满足' : '未满足') + '：' + state +
        '（' + (result.elapsedMs || 0) + 'ms，attached=' + Boolean(result.attached) +
        ' visible=' + Boolean(result.visible) + '）',
      );
      if (result.operationId) print('operation: ' + result.operationId + '（bridge operation cancel <id> 可中止）');
      return 0;
    }
    case 'wait-for-navigation': {
      const params = withControl(flags, { waitUntil: flags['wait-until'] !== undefined ? String(flags['wait-until']) : 'load' });
      params.timeoutMs = parseDurationMs(flags.timeout, 30000);
      const body = await callRpc('wait-for-navigation', params, timeoutOf(flags));
      return renderPageBody(body, (result) => print('已等待导航：' + ((result && result.url) || '') + '（' + ((result && result.phase) || 'load') + '）'));
    }
    case 'wait-ms': {
      const ms = requirePos(pos, 1, '<ms>');
      if (!/^\d+$/.test(ms)) throw new ArgError(`<ms> 需要整数，收到 "${ms}"`);
      const value = Number(ms);
      const body = await callRpc('wait-ms', withControl(flags, { ms: value }), Math.max(timeoutOf(flags), value + 5000));
      return renderPageBody(body, () => print('ok'));
    }
    case 'console': {
      const since = intFlag(flags, 'since', { min: 0 });
      const limit = intFlag(flags, 'limit', { min: 1 });
      const cursor = intFlag(flags, 'cursor', { min: 0 });
      const params = {};
      if (cursor !== undefined) params.since = cursor;
      else if (since !== undefined) params.since = since;
      if (limit !== undefined) params.limit = limit;
      const body = await callRpc('console', withControl(flags, params), timeoutOf(flags));
      return renderPageBody(body, (result) => {
        const entries = (result && result.entries) || [];
        if (!entries.length) {
          print('(无 console 输出)');
          return;
        }
        print(entries.map((entry) => `[${entry.level || 'log'} ${formatTime(entry.ts)}] ${entry.text ?? ''}`).join('\n'));
        if (result && result.nextCursor != null) print('\n@more ' + result.nextCursor);
      });
    }
    default:
      throw new ArgError(`未知命令：${command}`);
  }
}

/**
 * 给页面命令补上 session：--session > --session-scope > BB_SESSION > daemon 单会话默认。
 * --session-scope 交给 daemon 按 controller.name/project 解析唯一会话。
 */
function withSession(flags, params) {
  if (flags.session !== undefined) {
    params.session = String(flags.session);
  } else if (flags['session-scope'] !== undefined) {
    params.sessionScope = String(flags['session-scope']);
  } else if (process.env.BB_SESSION && process.env.BB_SESSION.trim()) {
    params.session = process.env.BB_SESSION.trim();
  }
  return params;
}

/** 导航探针只带 session/tab，不携带 --expect/--context 等动作约束。 */
function withNavigationProbe(flags, expression) {
  const params = withSession(flags, { expression: String(expression) });
  if (flags['tab-id'] !== undefined) {
    const tabId = Number(flags['tab-id']);
    if (!Number.isInteger(tabId)) throw new ArgError('--tab-id 需要整数');
    params.tabId = tabId;
  }
  return params;
}

/** 页面动作的公共参数：session + context/expect/observation。 */
async function waitForNavigationAfterClick(flags, beforeUrl, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const body = await callRpc('evaluate', withNavigationProbe(flags, "JSON.stringify({ href: location.href, ready: document.readyState })"), 5000).catch(() => null);
    if (body && body.ok) {
      let info = null;
      try {
        info = JSON.parse(String((body.result || {}).value || ''));
      } catch {
        info = null;
      }
      if (info && info.href && info.href !== beforeUrl && info.ready === 'complete') {
        return { navigated: true, url: info.href, waitedMs: Date.now() - started };
      }
    }
    await sleep(120);
  }
  return { navigated: false, url: beforeUrl, waitedMs: Date.now() - started };
}

function withControl(flags, params) {
  const out = withSession(flags, params);
  if (flags['tab-id'] !== undefined) {
    const tabId = Number(flags['tab-id']);
    if (!Number.isInteger(tabId)) throw new ArgError('--tab-id 需要整数');
    out.tabId = tabId;
  }
  if (flags.context !== undefined) out.context = String(flags.context);
  if (flags.observation !== undefined) out.observation = String(flags.observation);
  if (flags.expect !== undefined) {
    let expect;
    try {
      expect = JSON.parse(String(flags.expect));
    } catch (error) {
      throw new ArgError('--expect 不是合法 JSON：' + error.message);
    }
    if (!Array.isArray(expect)) throw new ArgError('--expect 需要数组');
    out.expect = expect;
  }
  if (flags['depends-on'] !== undefined) {
    let dependsOn;
    try {
      dependsOn = JSON.parse(String(flags['depends-on']));
    } catch (error) {
      throw new ArgError('--depends-on 不是合法 JSON：' + error.message);
    }
    if (!Array.isArray(dependsOn)) throw new ArgError('--depends-on 需要数组');
    out.dependsOn = dependsOn;
  }
  if (flags.settle !== undefined) {
    out.settleMs = parseDurationMs(flags.settle, 0);
  }
  if (flags['wait-timeout'] !== undefined) {
    const waitMs = parseDurationMs(flags['wait-timeout'], 0);
    if (!Number.isFinite(waitMs) || waitMs < 0) throw new ArgError('--wait-timeout 需要非负毫秒数');
    out.waitTimeoutMs = waitMs;
  }
  return out;
}

/** 解析 <ref|selector> 位置参数或 --ref/--selector 选项。 */
function resolveTarget(flags, pos, index, { required }) {
  const hasRef = flags.ref !== undefined;
  const hasSelector = flags.selector !== undefined;
  if (hasRef && hasSelector) throw new ArgError('--ref 与 --selector 只能给一个');
  if (hasRef) return { ref: String(flags.ref) };
  if (hasSelector) return { selector: String(flags.selector) };
  const value = pos[index];
  if (value === undefined || value === '') {
    if (required) throw new ArgError('缺少参数 <ref|selector>');
    return null;
  }
  return value.startsWith('@') ? { ref: value } : { selector: value };
}

/** 写 dataUrl 到文件，返回路径与字节数。 */
function writeDataUrl(out, dataUrl) {
  const match = /^data:image\/[a-z0-9.+-]+;base64,(.*)$/is.exec(String(dataUrl || ''));
  if (!match) throw new BridgeError('E_INTERNAL', '扩展返回的截图数据不是 base64 dataUrl');
  const buffer = Buffer.from(match[1], 'base64');
  const target = path.resolve(process.cwd(), String(out));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buffer);
  return { target, buffer };
}

/** 断言 RPC 结果 ok，否则抛出对应业务错误（给不能走 renderPageBody 的流程用）。 */
function expectOkBody(body, what) {
  if (!body || body.ok !== true) {
    const error = (body && body.error) || {};
    throw new BridgeError(error.code || 'E_INTERNAL', what + ' 失败：' + (error.message || 'unknown'));
  }
  return body.result;
}

/** 统一处理页面命令回包：失败走 outputFailure，成功按 --json 或 human 渲染。 */
function renderPageBody(body, humanRender) {
  if (!body.ok) return outputFailure(body);
  if (jsonMode) {
    emitJson(body);
    return 0;
  }
  humanRender(body.result || {});
  return 0;
}

// ---------------------------------------------------------------------------
// v0.2：读取 / 导出 / 拖拽 / 滚轮 / 失焦 / 上传 / 下载
// ---------------------------------------------------------------------------

function fieldFlags(field) {
  const flags = [];
  if (field.disabled) flags.push('disabled');
  if (field.readonly) flags.push('readonly');
  if (field.required) flags.push('required');
  if (field.checked === true) flags.push('checked');
  return flags.join(',');
}

function maskFieldValue(field) {
  if (field.type === 'password') return '********';
  if (Array.isArray(field.selectedOptions) && field.selectedOptions.length) {
    return field.selectedOptions.map((item) => item.label || item.value).join(' | ');
  }
  if (Array.isArray(field.files) && field.files.length) return field.files.join(' | ');
  return truncateText(String(field.value == null ? '' : field.value), 60);
}

function toCsv(result, csvSafe) {
  const columns = Array.isArray(result.columns) ? result.columns : [];
  const rows = Array.isArray(result.rows) ? result.rows : [];
  const escape = (raw) => {
    let text = raw == null ? '' : String(raw);
    if (csvSafe && /^[=+\-@]/.test(text)) text = "'" + text;
    return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  };
  const lines = [];
  lines.push(columns.map((column) => escape(column.label || column.key)).join(','));
  for (const row of rows) {
    lines.push(columns.map((column) => escape(row[column.key])).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

const MIME_BY_EXT = {
  '.txt': 'text/plain', '.json': 'application/json', '.csv': 'text/csv',
  '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.zip': 'application/zip',
};

function guessMime(filePath) {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

async function cmdRead(flags, pos) {
  if (flags['closed-shadow-text'] !== undefined) {
    const body = await callRpc('shadow.read', withControl(flags, { text: String(flags['closed-shadow-text']) }), timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    print((body.result && body.result.matched) || '');
    return 0;
  }
  const params = withControl(flags, {});
  if (flags.all === true) {
    params.all = true;
  } else {
    const target = resolveTarget(flags, pos, 1, { required: false });
    if (target) Object.assign(params, target);
  }
  if (flags['fields-json'] !== undefined) {
    let fields;
    try {
      fields = JSON.parse(String(flags['fields-json']));
    } catch (error) {
      throw new ArgError('--fields-json 不是合法 JSON：' + error.message);
    }
    if (!Array.isArray(fields) || !fields.length) throw new ArgError('--fields-json 需要非空数组');
    const target = resolveTarget(flags, pos, 1, { required: true });
    params.fields = fields;
    Object.assign(params, target);
  }
  const body = await callRpc('read', params, timeoutOf(flags));
  return renderPageBody(body, (result) => {
    const fields = Array.isArray(result.fields) ? result.fields : [];
    if (!fields.length) {
      print('(没有可读字段)');
      return;
    }
    print(renderTable(
      ['ref', 'tag', 'type', 'name', 'value', 'flags'],
      fields.map((field) => [
        field.ref || '',
        field.tag || '',
        field.type || '',
        truncateText(field.name || '', 20),
        maskFieldValue(field),
        fieldFlags(field),
      ]),
    ));
  });
}

async function cmdExtract(flags, pos) {
  const sub = pos[1];
  const maxRows = intFlag(flags, 'max-rows', { min: 1 });
  const format = flags.format === 'csv' ? 'csv' : 'json';
  const base = withControl(flags, {});
  if (maxRows !== undefined) base.maxRows = maxRows;
  const maxBytes = intFlag(flags, 'max-bytes', { min: 1 });
  if (maxBytes !== undefined) base.maxBytes = maxBytes;

  if (sub === 'discover') {
    const body = await callRpc('extract.discover', base, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    const targets = (body.result && body.result.targets) || [];
    if (!targets.length) {
      print('(没有可导出的表格/列表)');
      return 0;
    }
    print(renderTable(
      ['id', 'kind', 'label', 'rows', 'columns'],
      targets.map((target) => [String(target.id), target.kind, truncateText(target.label, 40), String(target.rows), String(target.columns)]),
    ));
    return 0;
  }

  const params = { ...base };
  let method = 'extract';
  if (sub === 'list') {
    method = 'extract.list';
    if (flags['item-selector'] !== undefined) params.itemSelector = String(flags['item-selector']);
    if (flags['fields-json'] !== undefined) {
      let fields;
      try { fields = JSON.parse(String(flags['fields-json'])); } catch (error) { throw new ArgError('--fields-json 不是合法 JSON：' + error.message); }
      params.fields = Array.isArray(fields) ? fields : (fields && Array.isArray(fields.fields) ? fields.fields : null);
      if (!params.fields) throw new ArgError('--fields-json 需要数组或 {fields:[...]}');
    }
    if (flags['fields'] !== undefined) {
      try {
        const raw = JSON.parse(fs.readFileSync(String(flags.fields), 'utf8'));
        params.fields = Array.isArray(raw) ? raw : raw.fields;
      } catch (error) { throw new ArgError('--fields 读取失败：' + error.message); }
    }
    const target = resolveTarget(flags, pos, 2, { required: false });
    if (target) Object.assign(params, target);
  } else if (sub === 'table') {
    method = 'extract.table';
    if (flags.target !== undefined) {
      const value = String(flags.target);
      if (!/^\d+$/.test(value)) throw new ArgError('--target 需要整数 id');
      params.target = Number(value);
    }
    const target = resolveTarget(flags, pos, 2, { required: false });
    if (target) Object.assign(params, target);
    if (params.target === undefined && !target) {
      throw new ArgError('extract table 需要 --target <id>（先 extract discover）或 --selector/--ref');
    }
  } else {
    const target = resolveTarget(flags, pos, 1, { required: false });
    if (target) Object.assign(params, target);
  }

  const body = await callRpc(method, params, timeoutOf(flags));
  if (!body.ok) return outputFailure(body);
  const result = body.result || {};
  if (format === 'csv') {
    if (!flags.out) throw new ArgError('extract --format csv 需要 --out <path>');
    const file = path.resolve(process.cwd(), String(flags.out));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '\ufeff' + toCsv(result, flags['csv-safe'] === true), 'utf8');
    if (jsonMode) {
      emitJson({ ok: true, result: { path: file, rowCount: result.rowCount || 0, truncated: result.truncated === true } });
      return 0;
    }
    print('已导出 ' + (result.rowCount || 0) + ' 行 → ' + file + (result.truncated ? '（已截断）' : ''));
    return 0;
  }
  if (jsonMode) {
    emitJson(body);
    return 0;
  }
  print(JSON.stringify({
    kind: result.kind,
    columns: result.columns,
    rows: result.rows,
    rowCount: result.rowCount,
    truncated: result.truncated,
    warnings: result.warnings,
  }, null, 2));
  return 0;
}

async function cmdDrag(flags, pos) {
  const from = requirePos(pos, 1, '<from>');
  const params = withControl(flags, { from: targetOf(from) });
  if (flags.to !== undefined) params.to = targetOf(flags.to);
  if (flags.dx !== undefined) params.dx = Number(flags.dx);
  if (flags.dy !== undefined) params.dy = Number(flags.dy);
  if (flags.to === undefined && flags.dx === undefined && flags.dy === undefined) {
    throw new ArgError('drag 需要 --to <ref|selector> 或 --dx/--dy');
  }
  if (flags.mode !== undefined) params.mode = String(flags.mode);
  if (flags.modifiers !== undefined) params.modifiers = parseModifiers(flags.modifiers);
  const steps = intFlag(flags, 'steps', { min: 2 });
  if (steps !== undefined) params.steps = steps;
  params.holdMs = parseDurationMs(flags.hold, 0);
  params.durationMs = parseDurationMs(flags.duration, 0);
  if (flags.trusted === true) params.trusted = true;
  if (flags.force === true) params.force = true;
  for (const key of ['from-offset-x', 'from-offset-y', 'to-offset-x', 'to-offset-y']) {
    if (flags[key] !== undefined) {
      const map = {
        'from-offset-x': 'fromOffsetX',
        'from-offset-y': 'fromOffsetY',
        'to-offset-x': 'toOffsetX',
        'to-offset-y': 'toOffsetY',
      };
      params[map[key]] = Number(flags[key]);
    }
  }
  const body = await callRpc('drag', params, timeoutOf(flags));
  return renderPageBody(body, (result) => {
    print('ok（' + (result.mode || 'hold') + '，' + (result.points || 0) + ' 个移动点）');
  });
}

async function cmdWheel(flags, pos) {
  const deltaY = intFlag(flags, 'delta-y', { min: -1000000 });
  const deltaX = intFlag(flags, 'delta-x', { min: -1000000 });
  if (deltaY === undefined && deltaX === undefined) throw new ArgError('wheel 需要 --delta-y 或 --delta-x');
  const params = withControl(flags, {});
  if (deltaY !== undefined) params.deltaY = deltaY;
  if (deltaX !== undefined) params.deltaX = deltaX;
  const target = resolveTarget(flags, pos, 1, { required: false });
  if (target) Object.assign(params, target);
  const body = await callRpc('wheel', params, timeoutOf(flags));
  return renderPageBody(body, (result) => {
    print('scrollY=' + (result.scrollY || 0) + (result.synthetic ? '（合成事件未触发页面滚动，已退化为 scrollBy）' : ''));
  });
}

async function cmdBlur(flags, pos) {
  const params = withControl(flags, {});
  const target = resolveTarget(flags, pos, 1, { required: false });
  if (target) Object.assign(params, target);
  const body = await callRpc('blur', params, timeoutOf(flags));
  return renderPageBody(body, () => print('ok'));
}

async function cmdUpload(flags, pos) {
  const target = resolveTarget(flags, pos, 1, { required: true });
  const list = Array.isArray(flags.file) ? flags.file : (flags.file ? [flags.file] : []);
  if (!list.length) throw new ArgError('upload 需要至少一个 --file <path>');
  // 大文件走 daemon staging（transfer.*），避免把整文件塞进一次 JSON RPC；
  // 小文件保持内联 base64，保留隐藏 input 兜底能力。
  const STAGE_THRESHOLD = 4 * 1024 * 1024;
  let total = 0;
  const files = [];
  const paths = [];
  for (const entry of list) {
    const filePath = path.resolve(process.cwd(), String(entry));
    let buffer;
    try {
      buffer = fs.readFileSync(filePath);
    } catch (error) {
      throw new ArgError('读取文件失败：' + filePath + '（' + error.message + '）');
    }
    total += buffer.length;
    const name = path.basename(filePath);
    const mime = guessMime(filePath);
    if (buffer.length > STAGE_THRESHOLD) {
      const transferId = await stageUploadBuffer(flags, buffer, name);
      const staged = { name, mime, transferId };
      // 8MB 以内保留内联副本，兼容直接给 input[type=file] 赋值/隐藏 input 兜底；
      // 更大的文件只走路径，避免单次 RPC 过大。
      if (buffer.length <= 8 * 1024 * 1024) staged.base64 = buffer.toString('base64');
      files.push(staged);
      paths.push(null);
    } else {
      files.push({ name, mime, base64: buffer.toString('base64') });
      paths.push(filePath);
    }
  }
  if (total > 20 * 1024 * 1024) throw new ArgError('上传总大小超过 20MB');
  const params = withControl(flags, { ...target, files, paths });
  if (flags.mode === 'drop') params.mode = 'drop';
  const body = await callRpc('upload', params, Math.max(timeoutOf(flags), 120000));
  return renderPageBody(body, (result) => {
    print('已填入：' + (result.names || []).join(', '));
  });
}

function rpcResultOrThrow(body, what) {
  if (!body || body.ok !== true) {
    const error = body && body.error ? body.error : {};
    throw new BridgeError(error.code || 'E_INTERNAL', `${what} 失败：${error.message || '未知错误'}`);
  }
  return body.result;
}

/** 把大文件分块写入 daemon staging，返回 opaque transferId。 */
async function stageUploadBuffer(flags, buffer, name) {
  const session = flags && flags.session !== undefined ? { session: flags.session } : {};
  const begin = rpcResultOrThrow(
    await callRpc('transfer.begin', { ...session, name, byteSize: buffer.length }, 30000),
    'transfer.begin',
  );
  const chunkSize = Number(begin.chunkSize) > 0 ? Number(begin.chunkSize) : 1024 * 1024;
  try {
    let offset = 0;
    while (offset < buffer.length) {
      const chunk = buffer.subarray(offset, Math.min(offset + chunkSize, buffer.length));
      const written = rpcResultOrThrow(
        await callRpc('transfer.chunk', {
          transferId: begin.transferId,
          offset,
          dataBase64: chunk.toString('base64'),
        }, 60000),
        'transfer.chunk',
      );
      if (written.nextOffset !== offset + chunk.length) {
        throw new BridgeError('E_TRANSFER_OFFSET', `transfer.chunk nextOffset 不连续：${written.nextOffset}`);
      }
      offset = written.nextOffset;
    }
    rpcResultOrThrow(await callRpc('transfer.finish', { transferId: begin.transferId }, 30000), 'transfer.finish');
    return begin.transferId;
  } catch (error) {
    await callRpc('transfer.release', { transferId: begin.transferId }, 10000).catch(() => {});
    throw error;
  }
}

/** 从 daemon staging 分块读取到本地文件（下载用）。 */
async function readTransferToFile(transferId, file) {
  const chunks = [];
  let offset = 0;
  for (;;) {
    const chunk = rpcResultOrThrow(
      await callRpc('transfer.read', { transferId, offset, maxBytes: 1024 * 1024 }, 60000),
      'transfer.read',
    );
    if (chunk.dataBase64) chunks.push(Buffer.from(chunk.dataBase64, 'base64'));
    if (chunk.eof) break;
    if (!(chunk.nextOffset > offset)) throw new BridgeError('E_TRANSFER_STATE', 'transfer.read 没有推进 offset');
    offset = chunk.nextOffset;
  }
  fs.writeFileSync(file, Buffer.concat(chunks));
}

async function cmdDownload(flags, pos) {
  const params = withControl(flags, {});
  const target = resolveTarget(flags, pos, 1, { required: false });
  if (target) Object.assign(params, target);
  else if (flags.url !== undefined) params.url = String(flags.url);
  else throw new ArgError('download 需要 <ref|selector> 或 --url <url>');
  const body = await callRpc('download', params, timeoutOf(flags));
  if (!body.ok) return outputFailure(body);
  const result = body.result || {};
  if (flags.out && result.filename) {
    const file = path.resolve(process.cwd(), String(flags.out));
    if (fs.existsSync(file) && flags.overwrite !== true) {
      throw new BridgeError('E_EXISTS', '目标文件已存在：' + file + '（加 --overwrite 覆盖）');
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (result.transferId) {
        await readTransferToFile(result.transferId, file);
      } else {
        fs.copyFileSync(result.filename, file);
      }
      result.path = file;
    } catch (error) {
      throw new BridgeError('E_DOWNLOAD_FAILED', '写入下载文件失败：' + error.message);
    }
    if (result.transferId) {
      await callRpc('transfer.release', { transferId: result.transferId }, 10000).catch(() => {});
      result.transferReleased = true;
    }
  } else if (result.transferId) {
    await callRpc('transfer.release', { transferId: result.transferId }, 10000).catch(() => {});
    result.transferReleased = true;
  }
  if (jsonMode) {
    if (result.filename) body.result.browserPath = result.filename;
    emitJson(body);
    return 0;
  }
  print('已下载：' + result.filename + '（' + formatBytes(result.bytes) + '）' + (result.path ? ' → ' + result.path : ''));
  if (result.path && result.filename && path.resolve(result.path) !== path.resolve(result.filename)) {
    print('浏览器保存路径：' + result.filename);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// v0.2：设置 / 借用标签页 / plan / step / view / 对话框 / 网络 / 仿真
// ---------------------------------------------------------------------------

function parseOnOff(value, name) {
  const text = String(value).toLowerCase();
  if (['on', 'true', '1', 'yes'].includes(text)) return true;
  if (['off', 'false', '0', 'no'].includes(text)) return false;
  throw new ArgError('--' + name + ' 需要 on|off，收到 "' + value + '"');
}

async function cmdUi(flags, pos) {
  const page = flags.page === undefined ? 'popup' : String(flags.page);
  const params = { page };
  if (flags.query !== undefined) params.query = String(flags.query);
  const body = await callRpc('ui.open', params, timeoutOf(flags));
  if (!body.ok) return outputFailure(body);
  if (jsonMode) return outputJsonBody(body);
  const result = body.result || {};
  print('已打开扩展' + (page === 'options' ? '设置页' : '弹窗') + '：tab ' + result.tabId + ' → ' + result.url);
  return 0;
}

async function cmdPair(flags, pos) {
  const sub = pos[1] || 'list';
  if (sub === 'create') {
    const params = {};
    if (flags.ttl !== undefined) params.ttlMs = parseDurationMs(flags.ttl, 10 * 60 * 1000);
    if (flags.label !== undefined) params.label = String(flags.label);
    if (flags.host !== undefined) params.host = String(flags.host);
    if (flags.replace === true) params.replace = true;
    const body = await callRpc('pair.create', params, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    const result = body.result || {};
    print('配对码：' + result.code + '（' + Math.round((result.expiresAt - Date.now()) / 60000) + ' 分钟内有效）');
    print('远程地址：' + result.url);
    print('配对 token：' + result.token);
    if (result.link) print('配对链接：' + result.link);
    print('');
    print('在另一台浏览器上粘贴配对链接（或运行 bridge pair redeem ' + result.code + ' 获取）。');
    return 0;
  }
  if (sub === 'devices') {
    const body = await callRpc('pair.list', {}, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    const devices = (body.result && body.result.devices) || [];
    if (!devices.length) {
      print('(没有已连接的远程设备)');
      return 0;
    }
    print(renderTable(['instance', 'browser', 'version', 'connected'], devices.map((item) => [
      item.instanceId,
      item.browser || '',
      item.browserVersion || '',
      formatTime(item.connectedAt),
    ])));
    return 0;
  }
  if (sub === 'list') {
    const body = await callRpc('pair.list', {}, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    const list = (body.result && body.result.pairings) || [];
    if (!list.length) {
      print('(没有有效配对码；daemon 绑定 ' + ((body.result && body.result.bind) || '?') + ')');
      return 0;
    }
    print(renderTable(['code', 'label', 'url', 'expires'], list.map((item) => [
      item.code,
      item.label || '',
      truncateText(item.url, 48),
      formatTime(item.expiresAt),
    ])));
    return 0;
  }
  if (sub === 'redeem') {
    const code = requirePos(pos, 2, '<code>');
    const body = await callRpc('pair.redeem', { code: String(code) }, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    const result = body.result || {};
    print('远程地址：' + result.url);
    print('配对 token：' + result.token);
    return 0;
  }
  if (sub === 'revoke') {
    const code = requirePos(pos, 2, '<code>');
    const body = await callRpc('pair.revoke', { code: String(code) }, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    print((body.result && body.result.revoked ? '已撤销 ' : '没有找到 ') + String(code));
    return 0;
  }
  throw new ArgError('用法：bridge pair create [--ttl 10m] [--label x] [--replace] | devices | list | redeem <code> | revoke <code>');
}

async function cmdSettings(flags, pos) {
  const sub = pos[1];
  if (sub === 'set') {
    const patch = {};
    if (flags.label !== undefined) patch.instanceLabel = String(flags.label);
    if (flags['borrow-confirm'] !== undefined) {
      throw new BridgeError(
        'E_FORBIDDEN',
        '借用前确认只能在浏览器扩展的设置页修改，Agent/CLI 一侧不可改（安全策略要求）',
      );
    }
    if (flags['allow-help'] !== undefined) patch.allowHelp = parseOnOff(flags['allow-help'], 'allow-help');
    if (flags['page-guard'] !== undefined) patch.pageGuard = parseOnOff(flags['page-guard'], 'page-guard');
    if (flags['control-hint'] !== undefined) patch.controlHint = parseOnOff(flags['control-hint'], 'control-hint');
    if (flags['daemon-url'] !== undefined) patch.daemonUrl = String(flags['daemon-url']);
    if (flags['daemon-token'] !== undefined) patch.daemonToken = String(flags['daemon-token']);
    if (flags['long-shot'] !== undefined) {
      const mode = String(flags['long-shot']);
      if (mode !== 'auto' && mode !== 'manual') throw new ArgError('--long-shot 需要 auto|manual');
      patch.longShotMode = mode;
    }
    if (!Object.keys(patch).length) {
      throw new ArgError('settings set 至少给一个：--label/--allow-help/--control-hint/--page-guard/--long-shot');
    }
    const body = await callRpc('settings.set', { patch }, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    const settings = (body.result && body.result.settings) || {};
    print('已保存：' + formatSettings(settings));
    return 0;
  }
  const body = await callRpc('settings.get', {}, timeoutOf(flags));
  if (!body.ok) return outputFailure(body);
  if (jsonMode) return outputJsonBody(body);
  print(formatSettings((body.result && body.result.settings) || {}));
  return 0;
}

function formatSettings(settings) {
  const onOff = (value) => (value !== false ? 'on' : 'off');
  return [
    '实例名      ' + (settings.instanceLabel || '（未命名）'),
    '借用前确认  ' + onOff(settings.borrowConfirm),
    '人工协助    ' + onOff(settings.allowHelp),
    '页面守卫    ' + onOff(settings.pageGuard),
    '长截图默认  ' + (settings.longShotMode || 'auto'),
  ].join('\n');
}

/** plan/step 的 --until-visible：步骤结束后等待目标可见（不改变步骤本身的退出码）。 */
async function waitUntilVisible(flags, selector) {
  const rawWait = Number(flags['wait-timeout-ms']);
  const waitMs = Number.isFinite(rawWait) && rawWait > 0 ? Math.min(Math.max(Math.round(rawWait), 1), 25000) : 5000;
  const waited = await callRpc('wait-for-element', withSession(flags, {
    selector,
    state: 'visible',
    timeoutMs: waitMs,
  }), Math.max(waitMs + 5000, timeoutOf(flags)));
  if (waited.ok) return { selector, ...waited.result };
  return { selector, satisfied: false, error: waited.error || null };
}

async function cmdPlan(flags, pos) {
  const raw = flags.steps !== undefined ? String(flags.steps) : null;
  if (!raw) throw new ArgError('plan 需要 --steps \'[{"method":"click","params":{"selector":"#a"}}]\'');
  let steps;
  try {
    steps = JSON.parse(raw);
  } catch (error) {
    throw new ArgError('--steps 不是合法 JSON：' + error.message);
  }
  if (!Array.isArray(steps) || !steps.length) throw new ArgError('--steps 需要非空数组');
  const params = withControl(flags, { steps });
  const body = await callRpc('plan', params, Math.max(timeoutOf(flags), 120000));
  if (!body.ok) return outputFailure(body);
  const untilVisible = flags['until-visible'] !== undefined ? String(flags['until-visible']).trim() : '';
  if (untilVisible && body.result && body.result.failedAt == null) {
    body.result.untilVisible = await waitUntilVisible(flags, untilVisible);
  }
  if (flags['save-full'] !== undefined && body.result && body.result.failedAt == null) {
    const file = path.resolve(process.cwd(), String(flags['save-full']));
    const observation = await callRpc('observe', withControl(flags, {}), timeoutOf(flags));
    if (observation.ok && observation.result) {
      writeFileAtomic(file, String(observation.result.observation || ''), 0o600);
      body.result.savedTo = file;
    } else {
      body.result.saveError = observation.error || { code: 'E_OBSERVE_FAILED', message: 'plan 后观察失败' };
    }
  }
  if (jsonMode) return outputJsonBody(body);
  const result = body.result || {};
  const rows = (result.steps || []).map((step) => [
    String(step.index),
    step.method || '',
    step.ok ? 'ok' : 'fail',
    step.ok ? '' : (step.error && step.error.code ? step.error.code : ''),
  ]);
  print(renderTable(['#', 'method', 'result', 'error'], rows));
  print('完成 ' + (result.completed || 0) + '/' + steps.length + (result.failedAt != null ? '，第 ' + result.failedAt + ' 步失败' : ''));
  if (result.untilVisible) {
    print('until-visible ' + result.untilVisible.selector + '：' + (result.untilVisible.satisfied ? '已可见' : '等待超时'));
  }
  return result.failedAt != null ? 1 : 0;
}

async function cmdStep(flags, pos) {
  const method = pos[1];
  if (!method) throw new ArgError('用法：bridge step <method> [参数]');
  const params = {};
  const target = resolveTarget(flags, pos, 2, { required: false });
  if (target) Object.assign(params, target);
  if (flags.value !== undefined) params.value = String(flags.value);
  if (flags.key !== undefined) params.key = String(flags.key);
  if (flags.url !== undefined) params.url = String(flags.url);
  if (pos[2] && !target && method === 'navigate') params.url = pos[2];
  const body = await callRpc('step', withControl(flags, { action: { method, params } }), Math.max(timeoutOf(flags), 120000));
  if (!body.ok) return outputFailure(body);
  const untilVisible = flags['until-visible'] !== undefined ? String(flags['until-visible']).trim() : '';
  if (untilVisible && body.result) {
    body.result.untilVisible = await waitUntilVisible(flags, untilVisible);
  }
  if (flags['save-full'] !== undefined && body.result && body.result.observation) {
    const file = path.resolve(process.cwd(), String(flags['save-full']));
    writeFileAtomic(file, String(body.result.observation.text || ''), 0o600);
    body.result.savedTo = file;
  }
  if (jsonMode) return outputJsonBody(body);
  const result = body.result || {};
  print('动作：ok');
  const observation = result.observation;
  if (observation) {
    print('观察：变化 ' + observation.changed + ' 行，refs ' + observation.refs);
    print(observation.text || '');
  }
  if (result.untilVisible) {
    print('until-visible ' + result.untilVisible.selector + '：' + (result.untilVisible.satisfied ? '已可见' : '等待超时'));
  }
  return 0;
}

function viewFile(file, flags) {
  const target = path.resolve(process.cwd(), String(file));
  let text = '';
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch (error) {
    throw new BridgeError('E_NOT_FOUND', '读不到文件：' + target);
  }
  const lines = text.split('\n');
  const find = flags.find !== undefined ? String(flags.find) : '';
  const start = intFlag(flags, 'start-line', { min: 1 }) ?? 1;
  const count = intFlag(flags, 'line-count', { min: 1 }) ?? 200;
  let rows = [];
  let matched = 0;
  if (find) {
    const needle = find.toLowerCase();
    const keep = new Set();
    lines.forEach((line, index) => {
      if (!line.toLowerCase().includes(needle)) return;
      matched += 1;
      for (let offset = -2; offset <= 2; offset += 1) {
        const target2 = index + offset;
        if (target2 >= 0 && target2 < lines.length) keep.add(target2);
      }
    });
    rows = [...keep].sort((a, b) => a - b);
  } else {
    rows = [];
    for (let index = start - 1; index < Math.min(lines.length, start - 1 + count); index += 1) rows.push(index);
  }
  if (jsonMode) {
    emitJson({
      ok: true,
      result: {
        file: target,
        total: lines.length,
        matched: matched,
        lines: rows.map((index) => ({ number: index + 1, text: lines[index] })),
      },
    });
    return 0;
  }
  if (!rows.length) {
    print('(没有内容)');
    return 0;
  }
  print(rows.map((index) => String(index + 1).padStart(5) + ' | ' + lines[index]).join('\n'));
  return 0;
}

async function cmdView(flags, pos) {
  if (pos[1]) return viewFile(pos[1], flags);
  const params = withControl(flags, {});
  if (flags.grep !== undefined) params.grep = String(flags.grep);
  const offset = intFlag(flags, 'offset', { min: 0 });
  if (offset !== undefined) params.offset = offset;
  const limit = intFlag(flags, 'limit', { min: 1 });
  if (limit !== undefined) params.limit = limit;
  const body = await callRpc('view', params, timeoutOf(flags));
  if (!body.ok) return outputFailure(body);
  if (jsonMode) return outputJsonBody(body);
  const result = body.result || {};
  print('url: ' + result.url + '\n缓存时间: ' + formatTime(result.at) + '，共 ' + result.total + ' 行，命中 ' + result.matched + ' 行');
  print('');
  print((result.lines || []).join('\n'));
  return 0;
}

async function cmdRequestHelp(flags, pos) {
  const prompt = flags.reason !== undefined ? flags.reason : flags.prompt;
  if (prompt === undefined) throw new ArgError('request-help 需要 --prompt 或 --reason <text>');
  const timeoutMs = Math.max(5000, parseDurationMs(flags.timeout, 180000));
  const params = withControl(flags, { reason: String(prompt), timeoutMs });
  if (flags.target !== undefined) params.target = String(flags.target);
  if (flags.title !== undefined) params.title = String(flags.title);
  const body = await callRpc('request-help', params, timeoutMs + 5000);
  if (!body.ok) return outputFailure(body);
  if (jsonMode) return outputJsonBody(body);
  const action = (body.result && body.result.action) || 'timeout';
  print(action === 'done' ? '用户已处理完成' : action === 'skip' ? '用户选择跳过' : '等待超时，用户未响应');
  return action === 'timeout' ? 1 : 0;
}

function dialogPolicy(flags) {
  const policy = {};
  for (const key of ['alert', 'confirm', 'prompt', 'beforeunload']) {
    if (flags[key] !== undefined) {
      const value = String(flags[key]).toLowerCase();
      if (value !== 'accept' && value !== 'dismiss') throw new ArgError('--' + key + ' 需要 accept|dismiss');
      policy[key === 'beforeunload' ? 'beforeUnload' : key] = value;
    }
  }
  if (flags['prompt-text'] !== undefined) policy.promptText = String(flags['prompt-text']);
  if (flags.queue === true) policy.queue = true;
  return policy;
}

async function cmdDialog(flags, pos) {
  const sub = pos[1];
  if (sub === 'status') {
    const body = await callRpc('dialog.status', withControl(flags, {}), timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    const dialogs = (body.result && body.result.dialogs) || [];
    if (!dialogs.length) {
      print('(没有对话框记录)');
      return 0;
    }
    print(renderTable(['id', 'type', 'action', 'message'], dialogs.map((item) => [
      item.id, item.type, item.action || '', truncateText(item.message || '', 60),
    ])));
    return 0;
  }
  if (sub === 'accept' || sub === 'dismiss') {
    const id = requirePos(pos, 2, '<id>');
    const params = withControl(flags, { id: Number(id) });
    if (sub === 'accept' && flags.text !== undefined) params.text = String(flags.text);
    const body = await callRpc('dialog.' + sub, params, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    print((sub === 'accept' ? '已接受' : '已拒绝') + '对话框 ' + id);
    return 0;
  }
  if (sub === 'arm') {
    const body = await callRpc('dialog.arm', withControl(flags, { policy: dialogPolicy(flags) }), timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    print('已挂载对话框拦截：' + JSON.stringify(body.result && body.result.policy));
    return 0;
  }
  if (sub === 'disarm') {
    const body = await callRpc('dialog.disarm', withControl(flags, {}), timeoutOf(flags));
    return renderPageBody(body, () => print('已卸载'));
  }
  if (sub === 'list') {
    const body = await callRpc('dialog.list', withControl(flags, {}), timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    const dialogs = (body.result && body.result.dialogs) || [];
    if (!dialogs.length) {
      print('(没有记录到对话框)');
      return 0;
    }
    print(renderTable(['id', 'type', 'action', 'message'], dialogs.map((item) => [
      item.id, item.type, item.action || '', truncateText(item.message || '', 60),
    ])));
    return 0;
  }
  if (sub === 'handle') {
    const id = requirePos(pos, 2, '<id>');
    if (flags.accept !== true && flags.dismiss !== true) throw new ArgError('dialog handle 需要 --accept 或 --dismiss');
    const params = withControl(flags, { id, accept: flags.accept === true });
    if (flags['prompt-text'] !== undefined) params.promptText = String(flags['prompt-text']);
    const body = await callRpc('dialog.handle', params, timeoutOf(flags));
    return renderPageBody(body, () => print('ok'));
  }
  throw new ArgError('用法：bridge dialog arm|disarm|list|handle');
}

async function cmdCooperate(flags, pos) {
  const sub = pos[1];
  if (sub === 'sync') {
    const params = withControl(flags, {});
    if (flags.policy !== undefined) params.policy = String(flags.policy);
    if (flags['probe-hover'] === true) params.probeHover = true;
    if (flags['match-text'] !== undefined) params.matchText = String(flags['match-text']);
    if (flags['context-lines'] !== undefined) params.contextLines = intFlag(flags, 'context-lines', { min: 0 });
    const body = await callRpc('cooperate.sync', params, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    const result = body.result || {};
    print('control_policy: ' + result.control_policy);
    print('context_id: ' + result.context_id);
    print('observation_id: ' + result.observation_id);
    print('');
    print('url: ' + (result.url || ''));
    print('title: ' + (result.title || ''));
    print('');
    print(result.observation && result.observation.text ? result.observation.text : '');
    return 0;
  }
  if (sub === 'handback') {
    const body = await callRpc('cooperate.handback', withControl(flags, {}), timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    print('已交回控制权（agent 可继续操作）');
    return 0;
  }
  if (sub === 'wait') {
    const params = withControl(flags, {});
    if (flags.timeout !== undefined) params.timeoutMs = parseDurationMs(flags.timeout, 0);
    const body = await callRpc('cooperate.wait', params, Math.max(timeoutOf(flags), (params.timeoutMs || 0) + 5000));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    const result = body.result || {};
    print('state: ' + ((result.state && result.state.mode) || 'unknown') + '（ready=' + Boolean(result.ready) + '，waited=' + (result.waitedMs || 0) + 'ms）');
    if (result.context_id) print('context_id: ' + result.context_id);
    return 0;
  }
  throw new ArgError('用法：bridge cooperate sync [--policy auto|strict] [--probe-hover] | cooperate wait');
}

function writeVideoFile(base64, out, overwrite) {
  const target = path.resolve(process.cwd(), String(out));
  if (fs.existsSync(target) && overwrite !== true) {
    throw new BridgeError('E_EXISTS', '目标文件已存在：' + target + '（加 --overwrite 覆盖）');
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const buffer = Buffer.from(String(base64 || ''), 'base64');
  fs.writeFileSync(target, buffer);
  return { target, buffer };
}

async function cmdVideo(flags, pos) {
  const sub = pos[1];
  const session = withControl(flags, {});

  if (sub === 'start') {
    const params = { ...session };
    const durationMs = parseDurationMs(flags.duration, 0);
    if (durationMs > 0) params.durationMs = durationMs;
    if (flags.quality !== undefined) params.quality = String(flags.quality);
    const body = await callRpc('video.start', params, Math.max(timeoutOf(flags), 30000));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    const result = body.result || {};
    print('开始录制：' + result.recordingId + '（' + (String(result.mime).includes('mp4') ? 'MP4' : 'WebM') + '，' + (result.mode || '') + '）');
    return 0;
  }

  if (sub === 'recover') {
    const body = await callRpc('video.recover', session, Math.max(timeoutOf(flags), 30000));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    const result = body.result || {};
    print('已恢复录制：' + result.recordingId + '（' + formatBytes(result.bytes || 0) + '）');
    return 0;
  }

  if (sub === 'status') {
    const id = pos[2] ? String(pos[2]) : null;
    const state = expectOkBody(await callRpc('video.status', session, timeoutOf(flags)), 'video status');
    if (state.active) {
      if (!id || state.recordingId === id) {
        if (jsonMode) return outputJsonBody({ ok: true, result: { state: 'recording', ...state } });
        print('录制中：' + state.recordingId + '（' + Math.round((Date.now() - state.startedAt) / 1000) + 's）');
        return 0;
      }
    }
    const listed = expectOkBody(await callRpc('video.list', session, timeoutOf(flags)), 'video list');
    const record = (listed.recordings || []).find((item) => !id || item.id === id);
    if (!record) {
      const detail = state && state.trace ? ' trace=' + JSON.stringify(state.trace) : '';
      if (jsonMode) return emitJson({ ok: false, error: { code: 'E_NOT_FOUND', message: '找不到录制 ' + (id || '') + detail } }), 1;
      throw new BridgeError('E_NOT_FOUND', '找不到录制 ' + (id || '') + detail);
    }
    if (jsonMode) return outputJsonBody({ ok: true, result: { state: 'ready', ...record } });
    print('已就绪：' + record.id + '（' + (String(record.mime).includes('mp4') ? 'MP4' : 'WebM') + '，' + formatBytes(record.bytes) + '）');
    return 0;
  }

  if (sub === 'stop') {
    const id = pos[2] ? String(pos[2]) : undefined;
    const body = await callRpc('video.stop', { ...session, recording: id }, Math.max(timeoutOf(flags), 30000));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    const result = body.result || {};
    print('已停止：' + result.recordingId + '（' + formatBytes(result.bytes) + '）');
    return 0;
  }

  if (sub === 'save') {
    const id = requirePos(pos, 2, '<recordingId>');
    if (!flags.out) throw new ArgError('video save 需要 --out <path>');
    const body = await callRpc('video.fetch', { ...session, recording: String(id) }, Math.max(timeoutOf(flags), 120000));
    if (!body.ok) return outputFailure(body);
    const result = body.result || {};
    const written = writeVideoFile(result.base64, flags.out, flags.overwrite === true);
    if (jsonMode) {
      emitJson({ ok: true, result: { path: written.target, bytes: written.buffer.length, mime: result.mime } });
      return 0;
    }
    print('已保存：' + written.target + '（' + formatBytes(written.buffer.length) + '）');
    return 0;
  }

  if (sub === 'list') {
    const body = await callRpc('video.list', session, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    const recordings = (body.result && body.result.recordings) || [];
    if (!recordings.length) {
      print('(没有录制)');
      return 0;
    }
    print(renderTable(['id', 'kind', 'bytes', 'started', 'title'], recordings.map((item) => [
      item.id.slice(0, 8),
      String(item.mime).includes('mp4') ? 'MP4' : 'WebM',
      formatBytes(item.bytes),
      formatTime(item.startedAt),
      truncateText(item.title || item.url || '', 40),
    ])));
    return 0;
  }

  if (sub === 'prune') {
    const params = { ...session };
    if (flags.ttl !== undefined) params.ttlMs = parseDurationMs(flags.ttl, 0);
    const body = await callRpc('video.prune', params, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    const result = body.result || {};
    print('已清理 ' + (result.removed || 0) + ' 条过期录制，剩余 ' + (result.remaining || 0) + ' 条');
    return 0;
  }

  if (sub === 'discard') {
    const id = requirePos(pos, 2, '<recordingId>');
    const body = await callRpc('video.discard', { ...session, recording: String(id) }, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    print('已删除录制 ' + id);
    return 0;
  }

  throw new ArgError('用法：bridge video start|status|stop|save|list|discard|recover');
}

async function cmdRecord(flags, pos) {
  const sub = pos[1];
  const session = withControl(flags, {});
  if (sub === 'start') {
    const params = { ...session };
    if (flags.screenshots === true) params.screenshots = true;
    const body = await callRpc('record.start', params, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    print('已开始记录用户操作（tab ' + (body.result && body.result.tabId) + '）');
    return 0;
  }
  if (sub === 'stop') {
    const body = await callRpc('record.stop', session, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    const result = body.result || {};
    print('已保存操作记录：' + ((result.recording && result.recording.events) || 0) + ' 条事件');
    return 0;
  }
  if (sub === 'status') {
    const body = await callRpc('record.status', session, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    const active = (body.result && body.result.active) || [];
    if (!active.length) {
      print('(没有进行中的记录)');
      return 0;
    }
    for (const item of active) print('记录中：tab ' + item.tabId + '，' + item.events + ' 条事件');
    return 0;
  }
  if (sub === 'list') {
    const body = await callRpc('record.list', session, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    const recordings = (body.result && body.result.recordings) || [];
    if (!recordings.length) {
      print('(没有历史记录)');
      return 0;
    }
    print(renderTable(['id', 'events', 'started', 'title'], recordings.map((item) => [
      item.id.slice(0, 8),
      String(item.events.length),
      formatTime(item.startedAt),
      truncateText(item.title || item.url || '', 40),
    ])));
    return 0;
  }
  if (sub === 'export') {
    const body = await callRpc('record.list', session, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    const recordings = (body.result && body.result.recordings) || [];
    const wanted = pos[2] ? String(pos[2]) : '';
    const recording = wanted
      ? recordings.find((item) => item.id === wanted || item.id.startsWith(wanted))
      : recordings[0];
    if (!recording) throw new BridgeError('E_NOT_FOUND', wanted ? '找不到录制 ' + wanted : '没有历史录制');
    const outDir = path.resolve(process.cwd(), flags.out !== undefined ? String(flags.out) : 'trace');
    fs.mkdirSync(path.join(outDir, 'states'), { recursive: true });
    const trace = buildTraceV3(recording);
    let screenshots = 0;
    if (flags.screenshot === true) {
      try {
        const shot = await callRpc('screenshot', { ...session, fullPage: false }, Math.max(timeoutOf(flags), 30000));
        if (shot.ok && shot.result && typeof shot.result.dataUrl === 'string') {
          trace.screenshots = [{
            id: 'shot-1',
            at: new Date().toISOString(),
            label: '导出时页面',
            width: Number(shot.result.width) || null,
            height: Number(shot.result.height) || null,
            dataUrl: shot.result.dataUrl,
          }];
          screenshots = 1;
        }
      } catch {
        // 截图是可选增强，失败不阻断 trace 导出
      }
    }
    for (const state of trace.states) {
      writeFileAtomic(path.join(outDir, 'states', state.id + '.txt'), String(state.body || ''), 0o600);
    }
    const tracePath = path.join(outDir, 'trace.json');
    writeFileAtomic(tracePath, JSON.stringify(trace, null, 2) + '\n', 0o600);
    const result = {
      tracePath,
      outDir,
      traceVersion: trace.version,
      events: trace.steps.length,
      states: trace.states.length,
      steps: trace.steps.length,
      screenshots,
      stepScreenshots: trace.steps.filter((step) => typeof step.screenshot === 'string' && step.screenshot.startsWith('data:image/')).length,
      id: recording.id,
    };
    if (jsonMode) {
      emitJson({ ok: true, result });
      return 0;
    }
    print('已导出录制：' + tracePath + '（Trace v3：' + result.steps + ' 步，' + result.states + ' 个状态）');
    return 0;
  }
  throw new ArgError('用法：bridge record start|stop|status|list|export [id] [--out <dir>]');
}

async function cmdOperation(flags, pos) {
  const sub = pos[1];
  if (sub === 'await') {
    const id = requirePos(pos, 2, '<operationId>');
    const timeoutMs = Math.max(1000, parseDurationMs(flags.timeout, 60000));
    const body = await callRpc('operation.await', withControl(flags, { id, timeoutMs }), timeoutMs + 5000);
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    const result = body.result || {};
    print('operation ' + id + '：' + (result.state || 'unknown'));
    if (result.state === 'completed') {
      print(JSON.stringify(result.result === undefined ? {} : result.result).slice(0, 2000));
      return 0;
    }
    if (result.state === 'failed') {
      process.stderr.write(JSON.stringify(result.error || {}).slice(0, 1000) + '\n');
      return 1;
    }
    return 0;
  }
  if (sub === 'cancel') {
    const id = requirePos(pos, 2, '<operationId>');
    const body = await callRpc('operation.cancel', withControl(flags, { id }), timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    print('已取消 operation ' + id);
    return 0;
  }
  throw new ArgError('用法：bridge operation await <id> [--timeout 60s] | operation cancel <id>');
}

function pathOfUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return String(url || '');
  }
}

function pickJsonPointer(value, pointer) {
  if (!pointer) return value;
  let current = value;
  for (const raw of String(pointer).split('/').slice(1)) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (current == null) return undefined;
    if (Array.isArray(current)) current = current[Number(key)];
    else current = current[key];
  }
  return current;
}

function capText(text, budget) {
  const limit = Number(budget);
  if (!Number.isFinite(limit) || limit <= 0) return text;
  if (Buffer.byteLength(text, 'utf8') <= limit) return text;
  return text.slice(0, Math.max(0, limit - 40)) + '\n…（输出已按 --budget ' + limit + ' 字节截断）';
}

function requestKind(entry) {
  const url = String(entry.url || '');
  if (/^(chrome-extension|moz-extension|safari-extension):/i.test(url)) return 'extension';
  const type = String(entry.type || '').toLowerCase();
  if (['script', 'stylesheet', 'image', 'font', 'media', 'css'].includes(type)) return 'resource';
  return 'business';
}

function filterDebugEntries(entries, flags) {
  let out = entries;
  const url = flags.url !== undefined ? String(flags.url) : (flags.filter !== undefined ? String(flags.filter) : '');
  if (url) out = out.filter((entry) => String(entry.url || '').includes(url));
  if (flags.method !== undefined) out = out.filter((entry) => String(entry.method || '').toUpperCase() === String(flags.method).toUpperCase());
  if (flags['resource-type'] !== undefined) out = out.filter((entry) => String(entry.type || '').toLowerCase() === String(flags['resource-type']).toLowerCase());
  if (flags.status !== undefined) out = out.filter((entry) => String(entry.status) === String(flags.status));
  if (flags.state !== undefined) {
    const state = String(flags.state).toLowerCase();
    out = out.filter((entry) => {
      const status = Number(entry.status) || 0;
      const derived = entry.error ? 'failed' : (status === 0 ? 'pending' : (status >= 400 ? 'failed' : 'complete'));
      return derived === state;
    });
  }
  if (flags.kind !== undefined && String(flags.kind) !== 'all') out = out.filter((entry) => requestKind(entry) === String(flags.kind));
  const offset = flags.offset !== undefined ? Math.max(0, Number(flags.offset) || 0) : 0;
  const limit = flags.limit !== undefined ? Math.max(0, Number(flags.limit) || 0) : 0;
  if (offset) out = out.slice(offset);
  if (limit) out = out.slice(0, limit);
  if (flags.fields !== undefined) {
    const fields = String(flags.fields).split(',').map((item) => item.trim()).filter(Boolean);
    out = out.map((entry) => {
      const picked = {};
      for (const field of fields) picked[field] = entry[field];
      return picked;
    });
  }
  return out;
}

/** help <method>：由 schema 生成单方法帮助；未知方法返回 2。 */
function cmdHelpTopic(topic) {
  const text = renderMethodHelp(topic);
  if (!text) {
    print('没有方法帮助：' + topic + '；用 bridge schema 查看全部方法');
    return 2;
  }
  print(text);
  return 0;
}

/** schema：输出协议方法的 scope/effect/参数 schema（来自 lib 单一来源）。 */
function cmdSchema(flags, pos) {
  const method = pos[1] ? String(pos[1]) : '';
  if (method) {
    const info = describeMethod(method);
    if (!info) throw new BridgeError('E_BAD_ARG', '未知方法：' + method + '（bridge schema 查看全部方法）');
    const result = { ...info, flags: schemaFlags(method) };
    if (jsonMode) {
      emitJson({ ok: true, result });
      return 0;
    }
    print(JSON.stringify(result, null, 2));
    return 0;
  }
  const rows = listMethods();
  if (jsonMode) {
    emitJson({ ok: true, result: { methods: rows } });
    return 0;
  }
  for (const row of rows) {
    print(row.method + '\t' + row.scope + '\t' + row.effect + '\t' + (row.mutating ? 'mutating' : 'read'));
  }
  return 0;
}

/** trace view：把 Trace v3 JSON 渲染成离线 HTML 查看器。 */
function cmdTrace(flags, pos) {
  const sub = pos[1] || 'view';
  if (sub !== 'view') throw new ArgError('用法：bridge trace view <trace.json> [--out <viewer.html>]');
  const file = pos[2] || (flags.file !== undefined ? String(flags.file) : '');
  if (!file) throw new ArgError('trace view 需要 <trace.json>');
  const source = path.resolve(process.cwd(), file);
  let raw;
  try {
    raw = fs.readFileSync(source, 'utf8');
  } catch {
    throw new BridgeError('E_NOT_FOUND', '读不到 trace 文件：' + source);
  }
  let trace;
  try {
    trace = JSON.parse(raw);
  } catch (error) {
    throw new BridgeError('E_BAD_ARG', 'trace 不是合法 JSON：' + error.message);
  }
  if (!trace || trace.version !== 3 || !Array.isArray(trace.steps)) {
    throw new BridgeError('E_BAD_ARG', '需要 Trace v3（version=3 且包含 steps）');
  }
  if (flags.debug !== undefined) {
    const debugPath = path.resolve(process.cwd(), String(flags.debug));
    let archive;
    try {
      archive = JSON.parse(fs.readFileSync(debugPath, 'utf8'));
    } catch (error) {
      throw new BridgeError('E_BAD_ARG', '读不到 debug 归档或不是 JSON：' + debugPath + '（' + error.message + '）');
    }
    const requests = Array.isArray(archive && archive.requests) ? archive.requests : [];
    if (!requests.length) throw new BridgeError('E_BAD_ARG', 'debug 归档里没有 requests 数组');
    trace.network = requests.map((request) => ({
      at: Number.isFinite(Number(request.startedAt)) ? new Date(Number(request.startedAt)).toISOString() : null,
      method: String(request.method || ''),
      url: String(request.url || ''),
      status: request.status == null ? null : Number(request.status),
      type: String(request.type || ''),
    }));
  }
  const output = path.resolve(process.cwd(), flags.out !== undefined ? String(flags.out) : source.replace(/\.json$/i, '') + '.html');
  const html = renderTraceHtml(trace);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  writeFileAtomic(output, html, 0o600);
  const result = {
    trace: source,
    out: output,
    bytes: Buffer.byteLength(html),
    steps: trace.steps.length,
    states: Array.isArray(trace.states) ? trace.states.length : 0,
    network: Array.isArray(trace.network) ? trace.network.length : 0,
    screenshots: Array.isArray(trace.screenshots) ? trace.screenshots.length : 0,
    stepScreenshots: trace.steps.filter((step) => typeof step.screenshot === 'string' && step.screenshot.startsWith('data:image/')).length,
  };
  if (jsonMode) {
    emitJson({ ok: true, result });
    return 0;
  }
  print('已生成 Trace Viewer：' + output);
  return 0;
}

async function cmdDebug(flags, pos) {
  const sub = pos[1];
  const session = withControl(flags, {});

  if (sub === 'start') {
    const params = { ...session };
    if (flags.name !== undefined) params.name = String(flags.name);
    if (flags.bodies === true) params.bodies = true;
    const body = await callRpc('debug.start', params, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    print('调试采集已开始' + (params.name ? '：' + params.name : '') + (params.bodies ? '（含正文）' : '（只采集元数据）'));
    return 0;
  }

  if (sub === 'stop') {
    const body = await callRpc('debug.stop', session, Math.max(timeoutOf(flags), 30000));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    const result = body.result || {};
    print('已停止：' + result.requests + ' 请求 / ' + result.console + ' 条控制台输出');
    return 0;
  }

  if (sub === 'status') {
    const body = await callRpc('debug.current', session, timeoutOf(flags));
    if (!body.ok) {
      const history = await callRpc('debug.history', session, timeoutOf(flags));
      const list = (history.ok && history.result && history.result.history) || [];
      if (jsonMode) {
        emitJson({ ok: true, result: { active: false, history: list.slice(0, 5) } });
        return 0;
      }
      print('当前没有进行中的调试采集');
      if (list.length) print('最近记录：' + list.slice(0, 5).map((item) => item.id.slice(0, 8) + (item.name ? '(' + item.name + ')' : '')).join(', '));
      return 0;
    }
    if (jsonMode) return outputJsonBody(body);
    const result = body.result || {};
    print('采集中：' + (result.requests || []).length + ' 请求 / ' + (result.console || []).length + ' 条控制台');
    print('url: ' + (result.url || ''));
    return 0;
  }

  if (sub === 'requests') {
    const body = await callRpc('debug.current', session, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    const result = body.result || {};
    let entries = filterDebugEntries(result.requests || [], flags);
    if (jsonMode) {
      emitJson({ ok: true, result: { entries } });
      return 0;
    }
    if (!entries.length) {
      print('(没有匹配的请求)');
      return 0;
    }
    print(renderTable(['id', 'method', 'status', 'ms', 'type', 'url'], entries.map((entry) => [
      String(entry.id),
      entry.method || '',
      entry.status || '',
      entry.durationMs != null ? String(entry.durationMs) : '',
      entry.type || '',
      truncateText(entry.url || '', 64),
    ])));
    return 0;
  }

  if (sub === 'request') {
    const id = requirePos(pos, 2, '<id>');
    const body = await callRpc('debug.request', { ...session, id: Number(id) }, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    const maxChars = flags['max-chars'] !== undefined ? Math.max(1, Math.min(16384, Number(flags['max-chars']) || 4096)) : 4096;
    const offset = flags.offset !== undefined ? Math.max(0, Math.min(65536, Number(flags.offset) || 0)) : 0;
    const sliceBody = (text) => String(text == null ? '' : text).slice(offset, offset + maxChars);
    if (jsonMode) {
      if (flags.pointer !== undefined || flags['max-chars'] !== undefined || offset > 0) {
        const result = { ...(body.result || {}) };
        for (const key of ['responseBody', 'requestBody']) {
          if (result[key] === undefined) continue;
          let value = result[key];
          if (flags.pointer !== undefined) {
            try { value = pickJsonPointer(JSON.parse(String(value)), String(flags.pointer)); } catch { value = { pointerError: '正文不是合法 JSON 或 pointer 无效' }; }
            result[key] = value;
          } else {
            result[key] = sliceBody(value);
          }
        }
        return outputJsonBody({ ...body, result });
      }
      return outputJsonBody(body);
    }
    const result = body.result || {};
    const part = flags.part === undefined ? 'all' : String(flags.part);
    if (part === 'metadata') {
      print(JSON.stringify(result.entry || {}, null, 2));
      return 0;
    }
    if (part === 'headers' || part === 'all') {
      print('请求头：' + JSON.stringify((result.requestHeaders || []).slice(0, 30)));
      print('响应头：' + JSON.stringify((result.responseHeaders || []).slice(0, 30)));
    }
    if (part === 'timing' || part === 'all') {
      print('timing：' + JSON.stringify(result.timing || {}));
    }
    if (part === 'response' || part === 'all') {
      if (result.responseBody !== undefined) {
        let text = sliceBody(result.responseBody);
        if (flags.pointer !== undefined) {
          try { text = JSON.stringify(pickJsonPointer(JSON.parse(String(result.responseBody)), String(flags.pointer)), null, 2); } catch { text = '(pointer 无法应用：正文不是合法 JSON)'; }
        }
        print('响应正文：' + text);
      }
      else print('(没有响应正文；debug start 需要 --bodies)');
    }
    if (part === 'request' || part === 'all') {
      if (result.requestBody !== undefined) print('请求正文：' + sliceBody(result.requestBody));
      else print('(没有请求正文)');
    }
    print('');
    print(JSON.stringify(result.entry || {}, null, 2));
    return 0;
  }

  if (sub === 'console') {
    const body = await callRpc('debug.current', session, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    const entries = ((body.result && body.result.console) || []).slice(-100);
    if (jsonMode) {
      emitJson({ ok: true, result: { entries } });
      return 0;
    }
    if (!entries.length) {
      print('(没有控制台输出)');
      return 0;
    }
    print(entries.map((entry) => '[' + (entry.level || 'log') + '] ' + truncateText(String(entry.text || ''), 300)).join('\n'));
    return 0;
  }

  if (sub === 'pages') {
    const body = await callRpc('debug.current', session, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    const context = (body.result && body.result.context) || null;
    if (jsonMode) return outputJsonBody({ ok: true, result: { context } });
    print(JSON.stringify(context, null, 2));
    return 0;
  }

  if (sub === 'performance') {
    const body = await callRpc('debug.performance', session, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    const metrics = (body.result && body.result.metrics) || {};
    print('TTFB: ' + (metrics.ttfb != null ? metrics.ttfb + 'ms' : '—'));
    print('DOMContentLoaded: ' + (metrics.domContentLoaded != null ? metrics.domContentLoaded + 'ms' : '—'));
    print('load: ' + (metrics.load != null ? metrics.load + 'ms' : '—'));
    print('FCP: ' + ((metrics.paints || []).find((item) => item.name === 'first-contentful-paint') || {}).startTime ?? '—');
    print('LCP: ' + (metrics.lcp != null ? metrics.lcp + 'ms' : '—'));
    print('资源: ' + ((metrics.resources && metrics.resources.count) || 0) + ' 个 / ' + ((metrics.resources && metrics.resources.transferBytes) || 0) + ' 字节');
    print('CLS: ' + (metrics.cls != null ? metrics.cls : '—'));
    print('长任务: ' + ((metrics.longTasks && metrics.longTasks.count) || 0) + ' 个，最长 ' + ((metrics.longTasks && metrics.longTasks.maxMs) || 0) + 'ms');
    return 0;
  }

  if (sub === 'aggregate') {
    const body = await callRpc('debug.current', session, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    let entries = (body.result && body.result.requests) || [];
    if (flags.filter !== undefined) entries = entries.filter((item) => String(item.url || '').includes(String(flags.filter)));
    const slowMs = intFlag(flags, 'slow-ms', { min: 1 }) ?? 1000;
    const groups = new Map();
    for (const entry of entries) {
      const key = String(entry.method || 'GET') + ' ' + pathOfUrl(entry.url);
      let group = groups.get(key);
      if (!group) {
        group = { key, count: 0, total: 0, max: 0, slow: 0, statuses: {} };
        groups.set(key, group);
      }
      group.count += 1;
      const ms = Number(entry.durationMs) || 0;
      group.total += ms;
      group.max = Math.max(group.max, ms);
      if (ms >= slowMs) group.slow += 1;
      const status = entry.status != null ? String(entry.status) : '—';
      group.statuses[status] = (group.statuses[status] || 0) + 1;
    }
    const rows = [...groups.values()].sort((a, b) => b.max - a.max);
    if (jsonMode) {
      emitJson({ ok: true, result: { slowMs, groups: rows } });
      return 0;
    }
    if (!rows.length) {
      print('(没有请求可聚合)');
      return 0;
    }
    print(renderTable(['count', 'avg', 'max', 'slow', 'status', 'method+path'], rows.map((group) => [
      String(group.count),
      Math.round(group.total / group.count) + 'ms',
      group.max + 'ms',
      String(group.slow),
      JSON.stringify(group.statuses),
      truncateText(group.key, 60),
    ])));
    return 0;
  }

  if (sub === 'operations') {
    const params = {};
    if (flags.limit !== undefined) params.limit = intFlag(flags, 'limit', { min: 1 }) ?? 20;
    if (flags.since !== undefined) params.since = parseSince(flags.since);
    const body = await callRpc('operations.list', params, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    const entries = (body.result && body.result.entries) || [];

    // 若当前有调试采集，把落在命令时间窗内的请求数标出来
    const capture = await callRpc('debug.current', session, timeoutOf(flags)).catch(() => null);
    const requests = capture && capture.ok && capture.result && Array.isArray(capture.result.requests)
      ? capture.result.requests
      : [];
    for (const row of entries) {
      const from = row.ts - (Number(row.durationMs) || 0) - 50;
      row.requests = requests.filter((item) => {
        if (row.commandId && item.commandId) return String(item.commandId) === String(row.commandId);
        return Number(item.startedAt) >= from && Number(item.startedAt) <= row.ts + 50;
      }).length;
    }

    if (jsonMode) return outputJsonBody(body);
    if (!entries.length) {
      print('(没有操作记录)');
      return 0;
    }
    print(renderTable(['id', 'time', 'method', 'ok', 'ms', 'req', 'session'], entries.map((row) => [
      row.id || '',
      formatTime(row.ts),
      row.method || '',
      row.ok ? 'ok' : (row.code || 'fail'),
      row.durationMs != null ? String(row.durationMs) : '',
      String(row.requests || 0),
      (row.sessionId || '').slice(0, 12),
    ])));
    if (!requests.length) print('\n(当前没有调试采集，req 列恒为 0；先 bridge debug start)');
    return 0;
  }

  if (sub === 'operation') {
    const id = requirePos(pos, 2, '<operationId>');
    const body = await callRpc('operations.get', { id: String(id) }, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    const entry = (body.result && body.result.entry) || {};
    let matched = [];
    if (flags['with-requests'] === true) {
      const capture = await callRpc('debug.current', session, timeoutOf(flags)).catch(() => null);
      const requests = capture && capture.ok && capture.result && Array.isArray(capture.result.requests)
        ? capture.result.requests
        : [];
      const from = Number(entry.ts) - (Number(entry.durationMs) || 0) - 50;
      matched = requests.filter((item) => Number(item.startedAt) >= from && Number(item.startedAt) <= Number(entry.ts) + 50);
      body.result.requests = matched;
    }
    if (jsonMode) return outputJsonBody(body);
    print(JSON.stringify(entry, null, 2));
    if (flags['with-requests'] === true) {
      print('');
      if (!matched.length) print('(时间窗内没有请求)');
      else print(renderTable(['id', 'method', 'status', 'ms', 'url'], matched.map((item) => [
        String(item.id),
        item.method || '',
        item.status || '',
        item.durationMs != null ? String(item.durationMs) : '',
        truncateText(item.url || '', 60),
      ])));
    }
    return 0;
  }

  if (sub === 'duplicates') {
    const body = await callRpc('debug.current', session, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    let entries = (body.result && body.result.requests) || [];
    if (flags.filter !== undefined) entries = entries.filter((item) => String(item.url || '').includes(String(flags.filter)));
    const windowMs = intFlag(flags, 'window-ms', { min: 1 }) ?? 1000;
    const byKey = new Map();
    for (const entry of entries) {
      const key = String(entry.method || 'GET') + ' ' + pathOfUrl(entry.url);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(entry);
    }
    const groups = [];
    for (const [key, list] of byKey) {
      list.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
      let cluster = [];
      for (const entry of list) {
        const previous = cluster[cluster.length - 1];
        if (previous && (entry.startedAt || 0) - (previous.startedAt || 0) > windowMs) {
          if (cluster.length >= 2) groups.push({ key, count: cluster.length, firstAt: cluster[0].startedAt, spanMs: cluster[cluster.length - 1].startedAt - cluster[0].startedAt });
          cluster = [];
        }
        cluster.push(entry);
      }
      if (cluster.length >= 2) groups.push({ key, count: cluster.length, firstAt: cluster[0].startedAt, spanMs: cluster[cluster.length - 1].startedAt - cluster[0].startedAt });
    }
    groups.sort((a, b) => b.count - a.count);
    if (jsonMode) {
      emitJson({ ok: true, result: { windowMs, groups } });
      return 0;
    }
    if (!groups.length) {
      print('(窗口 ' + windowMs + 'ms 内没有重复请求)');
      return 0;
    }
    print(renderTable(['count', 'span', 'first', 'method+path'], groups.map((group) => [
      String(group.count),
      group.spanMs + 'ms',
      formatTime(group.firstAt),
      truncateText(group.key, 60),
    ])));
    return 0;
  }

  if (sub === 'fetch_probe') {
    const params = { ...session };
    if (flags.ms !== undefined) params.ms = intFlag(flags, 'ms', { min: 200 }) ?? 1500;
    const body = await callRpc('debug.fetch_probe', params, Math.max(timeoutOf(flags), (params.ms || 1500) + 8000));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    const result = body.result || {};
    print('Fetch 拦截事件：' + (result.paused || 0) + ' 个（窗口 ' + (result.windowMs || 0) + 'ms）');
    for (const url of result.urls || []) print('  ' + url);
    if (result.error) print('错误：' + result.error);
    return 0;
  }

  if (sub === 'capabilities') {
    const body = await callRpc('debug.capabilities', session, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    const result = body.result || {};
    print('debug 能力：' + (result.actions || []).join(', '));
    print('parts：' + (result.parts || []).join(', '));
    return 0;
  }

  if (sub === 'pin' || sub === 'unpin') {
    const id = pos[2];
    if (!id) throw new ArgError('debug ' + sub + ' 需要 id');
    const body = await callRpc('debug.pin', { ...session, id, pinned: sub === 'pin' }, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    print(sub === 'pin' ? '已钉住 ' + id : '已取消钉住 ' + id);
    return 0;
  }

  if (sub === 'pinned') {
    const body = await callRpc('debug.pinned', session, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    print(((body.result && body.result.pinned) || []).join('\n') || '(没有钉住项)');
    return 0;
  }

  if (sub === 'activity') {
    const body = await callRpc('operations.list', { ...session, limit: flags.limit !== undefined ? Number(flags.limit) : 20 }, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    const ops = (body.result && body.result.operations) || [];
    if (!ops.length) {
      print('(没有调试/操作记录)');
      return 0;
    }
    print(renderTable(['id', 'method', 'status', 'ms'], ops.map((op) => [String(op.id || ''), String(op.method || ''), String(op.status || ''), String(op.durationMs == null ? '' : op.durationMs)])));
    return 0;
  }

  if (sub === 'rule_add') {
    let rule = null;
    if (flags['rule-file'] !== undefined) {
      const file = path.resolve(process.cwd(), String(flags['rule-file']));
      rule = JSON.parse(fs.readFileSync(file, 'utf8'));
    } else if (flags.rule !== undefined) {
      rule = JSON.parse(String(flags.rule));
    } else {
      throw new ArgError('debug rule_add 需要 --rule <json> 或 --rule-file <path>');
    }
    const body = await callRpc('debug.rule_add', { ...session, rule }, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    const rules = (body.result && body.result.rules) || [];
    print('已添加规则，当前 ' + rules.length + ' 条：');
    for (const item of rules) print('  ' + item.action + ' ' + item.urlPattern + '（命中 ' + item.hits + '）');
    return 0;
  }

  if (sub === 'rule_enable' || sub === 'rule_disable' || sub === 'rule_remove') {
    const id = Number(pos[2]);
    if (!Number.isInteger(id)) throw new ArgError('debug ' + sub + ' 需要规则 id');
    const method = sub === 'rule_enable' ? 'debug.rule_enable' : sub === 'rule_disable' ? 'debug.rule_disable' : 'debug.rule_remove';
    const body = await callRpc(method, { ...session, id }, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    print(sub === 'rule_remove' ? '已删除规则 ' + id : (sub === 'rule_enable' ? '已启用规则 ' : '已停用规则 ') + id);
    return 0;
  }

  if (sub === 'rule_list') {
    const body = await callRpc('debug.rule_list', session, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    const rules = (body.result && body.result.rules) || [];
    if (!rules.length) {
      print('(没有规则)');
      return 0;
    }
    print(renderTable(['action', 'status', 'hits', 'urlPattern'], rules.map((item) => [
      item.action,
      String(item.status),
      String(item.hits),
      truncateText(item.urlPattern, 60),
    ])));
    return 0;
  }

  if (sub === 'rule_clear') {
    const body = await callRpc('debug.rule_clear', session, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    print('已清理 ' + ((body.result && body.result.cleared) || 0) + ' 条规则');
    return 0;
  }

  if (sub === 'rule_export') {
    if (!flags.output) throw new ArgError('debug rule_export 需要 --output <file>');
    const body = await callRpc('debug.rule_export', session, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    const target = path.resolve(process.cwd(), String(flags.output));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeFileAtomic(target, JSON.stringify(body.result || {}, null, 2) + '\n', 0o600);
    if (jsonMode) {
      emitJson({ ok: true, result: { path: target, rules: (body.result && body.result.rules || []).length } });
      return 0;
    }
    print('已导出规则：' + target);
    return 0;
  }

  if (sub === 'rule_import') {
    const file = flags.file !== undefined ? String(flags.file) : (pos[2] || '');
    if (!file) throw new ArgError('debug rule_import 需要 --file <rules.json>');
    let snapshot;
    try { snapshot = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), file), 'utf8')); } catch (error) { throw new BridgeError('E_BAD_JSON', '读取规则文件失败：' + error.message); }
    const rules = Array.isArray(snapshot) ? snapshot : snapshot.rules;
    if (!Array.isArray(rules)) throw new ArgError('规则文件需要 rules 数组');
    const body = await callRpc('debug.rule_import', { ...session, rules }, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    print('已导入 ' + ((body.result && body.result.imported) || rules.length) + ' 条规则');
    return 0;
  }

  if (sub === 'export') {
    if (!flags.output) throw new ArgError('debug export 需要 --output <file>');
    const body = await callRpc('debug.current', session, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    const target = path.resolve(process.cwd(), String(flags.output));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(body.result, null, 2), 'utf8');
    if (jsonMode) {
      emitJson({ ok: true, result: { path: target, bytes: fs.statSync(target).size } });
      return 0;
    }
    print('已导出调试数据：' + target);
    return 0;
  }

  if (sub === 'archives') {
    if (!flags.dir) throw new ArgError('debug archives 需要 --dir <目录>');
    const dir = path.resolve(process.cwd(), String(flags.dir));
    const index = createArchiveIndex();
    const fileById = new Map();
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.json'));
    } catch {
      throw new ArgError('目录不可读：' + dir);
    }
    for (const name of files) {
      try {
        const archive = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (archive && archive.id) {
          index.add(archive);
          fileById.set(String(archive.id), path.join(dir, name));
        }
      } catch {
        // 跳过非归档 JSON
      }
    }
    if (flags.prune === true) {
      const now = Date.now();
      for (const name of files) {
        try {
          const file = path.join(dir, name);
          const archive = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (archive && archive.expiresAt && Date.parse(archive.expiresAt) <= now) fs.rmSync(file, { force: true });
        } catch {
          // 跳过不可读/非归档文件
        }
      }
      index.prune(now);
    }
    const max = intFlag(flags, 'max', { min: 1 });
    if (max !== undefined) {
      const ordered = index.list().map(archiveSummary);
      for (const entry of ordered.slice(max)) {
        const file = fileById.get(entry.id);
        if (file) fs.rmSync(file, { force: true });
      }
    }
    const entries = index.list().map(archiveSummary);
    if (jsonMode) {
      emitJson({ ok: true, result: { dir, stats: index.stats(), entries } });
      return 0;
    }
    if (!entries.length) {
      print('(没有有效归档)');
      return 0;
    }
    print(renderTable(['id', 'requests', 'console', 'createdAt', 'expiresAt', 'url'], entries.map((entry) => [
      entry.id.slice(0, 20), String(entry.requests), String(entry.console), entry.createdAt.slice(0, 19), entry.expiresAt.slice(0, 19), truncateText(entry.url, 48),
    ])));
    return 0;
  }

  if (sub === 'archive') {
    if (!flags.output) throw new ArgError('debug archive 需要 --output <file>');
    const body = await callRpc('debug.current', session, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    const archive = buildDebugArchive(body.result, { id: String(flags.name || ''), session: String(flags.session || '') });
    const target = path.resolve(process.cwd(), String(flags.output));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeFileAtomic(target, JSON.stringify(archive, null, 2) + '\n', 0o600);
    updateArchiveIndex(path.dirname(target), archive);
    if (jsonMode) {
      emitJson({ ok: true, result: { path: target, id: archive.id, requests: archive.summary.requests, console: archive.summary.console } });
      return 0;
    }
    print('已归档调试数据：' + target + '（' + archive.summary.requests + ' 请求）');
    return 0;
  }

  if (sub === 'query') {
    if (flags.dir) {
      const dir = path.resolve(process.cwd(), String(flags.dir));
      let files = [];
      try {
        files = fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.json'));
      } catch {
        throw new ArgError('目录不可读：' + dir);
      }
      const all = [];
      for (const name of files) {
        try {
          const archive = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
          if (!archive || !Array.isArray(archive.requests)) continue;
          for (const entry of queryArchive(archive, {
            url: String(flags.filter || flags.url || ''),
            method: String(flags.method || '').toUpperCase(),
            status: flags.status !== undefined ? Number(flags.status) : null,
            minDuration: flags['min-duration'] !== undefined ? Number(flags['min-duration']) : null,
            kind: String(flags.kind || ''),
            limit: intFlag(flags, 'limit', { min: 1 }) ?? 100,
          })) all.push({ archive: archive.id || name, ...entry });
        } catch {
          // 跳过非归档 JSON
        }
      }
      if (jsonMode) {
        emitJson({ ok: true, result: { matched: all.length, entries: all } });
        return 0;
      }
      print('命中 ' + all.length + ' 条（目录 ' + dir + '）');
      for (const entry of all.slice(0, 50)) print(entry.archive + '  ' + entry.method + ' ' + entry.url + '  ' + (entry.status == null ? '' : entry.status));
      return 0;
    }
    const file = flags.file !== undefined ? String(flags.file) : (pos[2] || '');
    if (!file) throw new ArgError('debug query 需要 --file <debug-export.json>');
    const target = path.resolve(process.cwd(), file);
    let snapshot;
    try { snapshot = JSON.parse(fs.readFileSync(target, 'utf8')); } catch (error) { throw new BridgeError('E_BAD_JSON', '读取调试归档失败：' + error.message); }
    const all = Array.isArray(snapshot.requests) ? snapshot.requests : [];
    const needle = String(flags.filter || flags.url || '');
    const method = String(flags.method || '').toUpperCase();
    const status = flags.status !== undefined ? Number(flags.status) : null;
    const minDuration = flags['min-duration'] !== undefined ? Number(flags['min-duration']) : null;
    const kind = String(flags.kind || '');
    const limit = intFlag(flags, 'limit', { min: 1 }) ?? 100;
    const entries = filterDebugRequests(all, { url: needle, method, status, minDuration, kind, limit });
    const result = { file: target, total: all.length, matched: entries.length, entries };
    if (jsonMode) {
      emitJson({ ok: true, result });
      return 0;
    }
    if (!entries.length) {
      print('(归档里没有匹配的请求)');
      return 0;
    }
    print(renderTable(['id', 'method', 'status', 'ms', 'url'], entries.map((entry) => [
      String(entry.id || ''),
      String(entry.method || ''),
      String(entry.status == null ? '' : entry.status),
      String(entry.durationMs == null ? '' : entry.durationMs),
      truncateText(entry.url || '', 100),
    ])));
    return 0;
  }

  if (sub === 'evidence') {
    let snapshot;
    let operations = [];
    if (flags.file) {
      const target = path.resolve(process.cwd(), String(flags.file));
      try {
        snapshot = JSON.parse(fs.readFileSync(target, 'utf8'));
      } catch (error) {
        throw new ArgError('无法读取证据文件：' + ((error && error.message) || error));
      }
    } else {
      const body = await callRpc('debug.current', session, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      snapshot = body.result;
      const opsBody = await callRpc('operations.list', { ...session, limit: 100 }, timeoutOf(flags)).catch(() => null);
      operations = opsBody && opsBody.ok && opsBody.result && Array.isArray(opsBody.result.entries) ? opsBody.result.entries : [];
    }
    const evidence = buildDebugEvidence(snapshot, { session: String(flags.session || ''), operations });
    if (flags.output) {
      const target = path.resolve(process.cwd(), String(flags.output));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      writeFileAtomic(target, JSON.stringify(evidence, null, 2) + '\n', 0o600);
      evidence.path = target;
    }
    if (jsonMode) {
      emitJson({ ok: true, result: evidence });
      return 0;
    }
    print('证据包：' + evidence.counts.requests + ' 请求 / ' + evidence.counts.console + ' 控制台 / ' + evidence.page.url);
    print('requestsSha256 ' + evidence.integrity.requestsSha256.slice(0, 16) + '…');
    return 0;
  }

  if (sub === 'analyze') {
    let snapshot;
    if (flags.file) {
      const target = path.resolve(process.cwd(), String(flags.file));
      try {
        snapshot = JSON.parse(fs.readFileSync(target, 'utf8'));
      } catch (error) {
        throw new ArgError('无法读取分析文件：' + ((error && error.message) || error));
      }
    } else {
      const body = await callRpc('debug.current', session, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      snapshot = body.result;
    }
    const analysis = analyzeDebugCapture(snapshot, {
      slowMs: flags['min-duration'] !== undefined ? Number(flags['min-duration']) : 500,
    });
    if (jsonMode) {
      emitJson({ ok: true, result: analysis });
      return 0;
    }
    print('请求 ' + analysis.counts.requests + ' / 控制台 ' + analysis.counts.console);
    print('状态：' + Object.entries(analysis.status).map(([key, value]) => key + '×' + value).join(' ') || '（无）');
    print('分类：business=' + analysis.kinds.business + ' resource=' + analysis.kinds.resource + ' extension=' + analysis.kinds.extension);
    if (analysis.slow.length) print('慢请求：' + analysis.slow.length);
    if (analysis.errors.length) print('错误：' + analysis.errors.length);
    if (analysis.duplicates.length) print('重复 URL：' + analysis.duplicates.length);
    return 0;
  }

  if (sub === 'journal') {
    const limit = intFlag(flags, 'limit', { min: 1 }) ?? 100;
    const snapshotBody = await callRpc('debug.current', session, timeoutOf(flags));
    if (!snapshotBody.ok) return outputFailure(snapshotBody);
    const opsBody = await callRpc('operations.list', { ...session, limit }, timeoutOf(flags));
    if (!opsBody.ok) return outputFailure(opsBody);
    const operations = (opsBody.result && opsBody.result.entries) || [];
    const journal = buildDebugJournal(snapshotBody.result, { operations, limit });
    if (jsonMode) {
      emitJson({ ok: true, result: { ...journal, entries: journal.events } });
      return 0;
    }
    if (!journal.events.length) {
      print('(没有 journal 记录)');
      return 0;
    }
    for (const event of journal.events) print(formatJournalEvent(event));
    if (journal.truncated) print('（已截断，共 ' + journal.counts.total + ' 条）');
    return 0;
  }

  if (sub === 'replay') {
    const id = requirePos(pos, 2, '<id>');
    const body = await callRpc('network.replay', { ...session, id: Number(id) }, Math.max(timeoutOf(flags), 120000));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    const result = body.result || {};
    print('HTTP ' + result.status + '（' + (result.durationMs || 0) + 'ms）');
    print(truncateText(String(result.body || ''), 2000));
    return 0;
  }

  if (sub === 'history') {
    const body = await callRpc('debug.history', session, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    const list = (body.result && body.result.history) || [];
    if (jsonMode) return outputJsonBody(body);
    if (!list.length) {
      print('(没有调试历史)');
      return 0;
    }
    print(renderTable(['id', 'name', 'requests', 'console', 'started'], list.map((item) => [
      item.id.slice(0, 8),
      item.name || '',
      String(item.requests || 0),
      String(item.console || 0),
      formatTime(item.startedAt),
    ])));
    return 0;
  }

  throw new ArgError('用法：bridge debug start|stop|status|requests|request|console|pages|performance|aggregate|export|query|replay|history');
}

async function cmdNetwork(flags, pos) {
  const sub = pos[1];
  if (sub === 'start') {
    const body = await callRpc('network.start', withControl(flags, { bodies: flags.bodies === true }), timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    print('已开始采集（正文：' + ((body.result && body.result.bodies) ? '开' : '关') + '）');
    return 0;
  }
  if (sub === 'stop') {
    const body = await callRpc('network.stop', withControl(flags, {}), timeoutOf(flags));
    return renderPageBody(body, () => print('已停止采集'));
  }
  if (sub === 'list') {
    const params = withControl(flags, {});
    const filter = {};
    if (flags.filter !== undefined) filter.urlContains = String(flags.filter);
    if (flags.method !== undefined) filter.method = String(flags.method).toUpperCase();
    if (flags.status !== undefined) filter.status = Number(flags.status);
    if (Object.keys(filter).length) params.filter = filter;
    const limit = intFlag(flags, 'limit', { min: 1 });
    if (limit !== undefined) params.limit = limit;
    const since = intFlag(flags, 'since', { min: 0 });
    if (since !== undefined) params.since = since;
    const body = await callRpc('network.list', params, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    const entries = (body.result && body.result.entries) || [];
    if (!entries.length) {
      print('(没有抓到请求；先 network start 再操作页面)');
      return 0;
    }
    print(renderTable(['id', 'method', 'status', 'ms', 'type', 'url'], entries.map((entry) => [
      String(entry.id), entry.method || '', entry.status || '', entry.durationMs != null ? String(entry.durationMs) : '', entry.type || '', truncateText(entry.url || '', 64),
    ])));
    return 0;
  }
  if (sub === 'detail') {
    const id = requirePos(pos, 2, '<id>');
    const body = await callRpc('network.detail', withControl(flags, { id: Number(id) }), timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    print(JSON.stringify(body.result || {}, null, 2));
    return 0;
  }
  if (sub === 'replay') {
    const id = requirePos(pos, 2, '<id>');
    const body = await callRpc('network.replay', withControl(flags, { id: Number(id) }), Math.max(timeoutOf(flags), 120000));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    const result = body.result || {};
    print('HTTP ' + result.status + '（' + (result.durationMs || 0) + 'ms）');
    print(truncateText(String(result.body || ''), 4000));
    return 0;
  }
  throw new ArgError('用法：bridge network start|stop|list|detail|replay');
}

const DEVICE_PRESETS = {
  'iphone-14': { width: 390, height: 844, dpr: 3, mobile: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' },
  'iphone-14-pro-max': { width: 430, height: 932, dpr: 3, mobile: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' },
  'iphone-se': { width: 375, height: 667, dpr: 2, mobile: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1' },
  'pixel-7': { width: 412, height: 915, dpr: 2.625, mobile: true, ua: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' },
  'galaxy-s23': { width: 360, height: 780, dpr: 3, mobile: true, ua: 'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' },
  'ipad-mini': { width: 768, height: 1024, dpr: 2, mobile: true, ua: 'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' },
  'galaxy-tab-s8': { width: 800, height: 1280, dpr: 2, mobile: true, ua: 'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
};

async function cmdEmulate(flags, pos) {
  const params = {};
  const preset = flags.device !== undefined ? DEVICE_PRESETS[String(flags.device)] : null;
  if (flags.device !== undefined && !preset) throw new ArgError('未知 --device：' + flags.device);
  const width = intFlag(flags, 'width', { min: 1 }) !== undefined ? intFlag(flags, 'width', { min: 1 }) : (preset ? preset.width : undefined);
  const height = intFlag(flags, 'height', { min: 1 }) !== undefined ? intFlag(flags, 'height', { min: 1 }) : (preset ? preset.height : undefined);
  if (width !== undefined || height !== undefined) {
    if (width === undefined || height === undefined) throw new ArgError('--width 与 --height 需要同时给');
    params.viewport = { width, height };
    const dprValue = flags.dpr !== undefined ? Number(flags.dpr) : (preset ? preset.dpr : NaN);
    if (Number.isFinite(dprValue) && dprValue > 0) params.viewport.deviceScaleFactor = dprValue;
    if (flags.mobile === true || (preset && preset.mobile)) params.viewport.mobile = true;
  }
  const ua = flags.ua !== undefined ? String(flags.ua) : (preset ? preset.ua : '');
  if (ua) params.userAgent = ua;
  if (flags['accept-language'] !== undefined) params.acceptLanguage = String(flags['accept-language']);
  if (flags.touch === true) params.touch = true;
  if (flags['no-touch'] === true) params.touch = false;
  if (flags.timezone !== undefined) params.timezone = String(flags.timezone);
  if (flags.locale !== undefined) params.locale = String(flags.locale);
  if (flags.geolocation !== undefined) {
    const parts = String(flags.geolocation).split(',').map((item) => Number(item.trim()));
    if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) {
      throw new ArgError('--geolocation 需要 "<lat>,<lon>"');
    }
    params.geolocation = { latitude: parts[0], longitude: parts[1] };
  }
  if (flags.reset === true) params.reset = true;
  if (!Object.keys(params).length) throw new ArgError('emulate 至少给一个参数（--width/--timezone/--geolocation/--reset 等）');
  const body = await callRpc('emulate', withControl(flags, params), timeoutOf(flags));
  return renderPageBody(body, () => print('ok'));
}

// ---------------------------------------------------------------------------
// v0.2：recipe / audit / install-skill
// ---------------------------------------------------------------------------

const RECIPE_DIR = path.join(HOME_DIR, 'recipes');
const OBSERVATIONS_DIR = path.join(HOME_DIR, 'observations');

/** 保存整页观察的本地基线，供后续 --delta 合并使用。 */
function saveObservationCache(id, text) {
  if (!id || typeof text !== 'string' || !text.length) return;
  try {
    fs.mkdirSync(OBSERVATIONS_DIR, { recursive: true });
    fs.writeFileSync(path.join(OBSERVATIONS_DIR, String(id) + '.json'), JSON.stringify({ id: String(id), text, at: Date.now() }), { mode: 0o600 });
  } catch { /* 缓存失败不影响主流程 */ }
}

/** 用本地基线应用增量补丁；没有基线时返回 null，调用方应回退整页观察。 */
function applyCachedObservation(id, patch) {
  try {
    const cached = JSON.parse(fs.readFileSync(path.join(OBSERVATIONS_DIR, String(id) + '.json'), 'utf8'));
    if (!cached || typeof cached.text !== 'string') return null;
    return applyObservationPatch(cached.text, patch);
  } catch {
    return null;
  }
}
const UPDATE_STATE_PATH = path.join(HOME_DIR, 'update-state.json');
const AUDIT_DIR = path.join(HOME_DIR, 'audit');
const SKILL_SOURCE = path.join(REPO_ROOT, 'skill');

const SKILL_TARGETS = {
  dsh: () => path.join(os.homedir(), '.dsh', 'skills', 'browser-bridge'),
  'claude-code': () => path.join(os.homedir(), '.claude', 'skills', 'browser-bridge'),
  claude: () => path.join(os.homedir(), '.claude', 'skills', 'browser-bridge'),
  codex: () => path.join(os.homedir(), '.agents', 'skills', 'browser-bridge'),
  cursor: () => path.join(os.homedir(), '.cursor', 'skills', 'browser-bridge'),
  codebuddy: () => path.join(os.homedir(), '.codebuddy', 'skills', 'browser-bridge'),
  workbuddy: () => path.join(os.homedir(), '.workbuddy', 'skills', 'browser-bridge'),
  openclaw: () => path.join(os.homedir(), '.openclaw', 'skills', 'browser-bridge'),
  qoder: () => path.join(os.homedir(), '.qoder', 'skills', 'browser-bridge'),
  'qoder-cn': () => path.join(os.homedir(), '.qoder-cn', 'skills', 'browser-bridge'),
  // 技能安装目标：Pi / Hermes Agent / Kimi Code
  pi: () => path.join(os.homedir(), '.pi', 'agent', 'skills', 'browser-bridge'),
  hermes: () => path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'hermes', 'skills', 'browser-bridge'),
  'kimi-code': () => path.join(os.homedir(), '.kimi-code', 'skills', 'browser-bridge'),
};

function writeSkillFiles(targetDir) {
  const out = [];
  for (const [rel, content] of Object.entries(SKILL_FILES)) {
    const to = path.join(targetDir, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, content, 'utf8');
    out.push(to);
  }
  return out;
}

function copySkillDir(source, targetDir) {
  const sourceDir = fs.statSync(source).isDirectory() ? source : path.dirname(source);
  const skip = new Set(['.git']);
  const walk = (dir, out) => {
    for (const name of fs.readdirSync(dir)) {
      if (skip.has(name)) continue;
      const from = path.join(dir, name);
      const to = path.join(targetDir, path.relative(sourceDir, from));
      const stat = fs.statSync(from);
      if (stat.isDirectory()) { walk(from, out); continue; }
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      out.push(to);
    }
  };
  fs.mkdirSync(targetDir, { recursive: true });
  const out = [];
  walk(sourceDir, out);
  return out;
}

function recipeFile(name) {
  return recipePath(RECIPE_DIR, name);
}

async function cmdRecipe(flags, pos) {
  const sub = pos[1];
  if (sub === 'list') {
    const rows = listRecipes(RECIPE_DIR).map((item) => [
      item.name,
      item.title,
      String(item.steps),
      item.file,
    ]);
    if (jsonMode) {
      emitJson({ ok: true, result: { dir: RECIPE_DIR, recipes: listRecipes(RECIPE_DIR) } });
      return 0;
    }
    if (!rows.length) {
      print('没有 recipe（目录 ' + RECIPE_DIR + '）');
      return 0;
    }
    print(renderTable(['name', 'title', 'steps', 'file'], rows));
    return 0;
  }
  if (sub === 'save') {
    const name = requirePos(pos, 2, '<name>');
    const rawFile = Array.isArray(flags.file) ? flags.file[0] : flags.file;
    if (!rawFile) throw new ArgError('recipe save 需要 --file <json>');
    const source = path.resolve(process.cwd(), String(rawFile));
    let json;
    try {
      json = JSON.parse(fs.readFileSync(source, 'utf8'));
    } catch (error) {
      throw new ArgError('读取 recipe 失败：' + error.message);
    }
    if (!Array.isArray(json.steps) || !json.steps.length) throw new ArgError('recipe 需要非空 steps 数组');
    const { file: target } = saveRecipe(RECIPE_DIR, name, json);
    if (jsonMode) {
      emitJson({ ok: true, result: { name: String(name), file: target } });
      return 0;
    }
    print('已保存 recipe（草稿，需人工审批）：' + target);
    print('  审批：bridge recipe approve ' + name + ' --confirm-human');
    return 0;
  }
  if (sub === 'show') {
    const name = requirePos(pos, 2, '<name>');
    const recipe = readRecipe(RECIPE_DIR, name);
    if (jsonMode) {
      emitJson({ ok: true, result: { name: String(name), recipe } });
      return 0;
    }
    print(JSON.stringify(recipe, null, 2));
    return 0;
  }
  if (sub === 'rm') {
    const name = requirePos(pos, 2, '<name>');
    const target = recipeFile(name);
    if (!fs.existsSync(target)) throw new BridgeError('E_NOT_FOUND', 'recipe 不存在：' + target);
    fs.rmSync(target, { force: true });
    if (jsonMode) {
      emitJson({ ok: true, result: { deleted: target } });
      return 0;
    }
    print('已删除：' + target);
    return 0;
  }
  if (sub === 'draft') {
    return cmdRecipe(flags, ['recipe', 'save', ...pos.slice(2)]);
  }
  if (sub === 'approve') {
    const name = requirePos(pos, 2, '<name>');
    if (flags['confirm-human'] !== true) {
      throw new ArgError('recipe approve 只能由人类执行：请加 --confirm-human');
    }
    const recipe = approveRecipe(RECIPE_DIR, name, {
      approver: flags.by !== undefined ? String(flags.by) : (os.userInfo().username || 'human'),
      host: os.hostname(),
    });
    if (jsonMode) {
      emitJson({ ok: true, result: { name: String(name), approved: true, approver: recipe.approver } });
      return 0;
    }
    print('已审批 recipe：' + name + '（by ' + recipe.approver + '）');
    return 0;
  }
  if (sub === 'run') {
    const name = requirePos(pos, 2, '<name>');
    const recipe = readRecipe(RECIPE_DIR, name);
    assertRunnable(recipe);
    const pairs = Array.isArray(flags.param) ? flags.param : (flags.param ? [flags.param] : []);
    const values = {};
    for (const pair of pairs) {
      const index = String(pair).indexOf('=');
      if (index <= 0) throw new ArgError('--param 需要 key=value，收到 "' + pair + '"');
      values[String(pair).slice(0, index)] = String(pair).slice(index + 1);
    }
    const steps = substituteParams(recipe.steps, values);
    const body = await callRpc('plan', withControl(flags, { steps }), Math.max(timeoutOf(flags), 180000));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    const result = body.result || {};
    print('recipe ' + name + '：完成 ' + (result.completed || 0) + '/' + steps.length + (result.failedAt != null ? '，第 ' + result.failedAt + ' 步失败' : ''));
    return result.failedAt != null ? 1 : 0;
  }
  throw new ArgError('用法：bridge recipe list|show|draft|save|approve|run|rm');
}

function parseSince(text) {
  if (text === undefined) return 0;
  const value = String(text).trim();
  const match = /^(\d+)([smhd])$/.exec(value);
  if (match) {
    const amount = Number(match[1]);
    const unit = match[2];
    const factor = unit === 's' ? 1000 : unit === 'm' ? 60000 : unit === 'h' ? 3600000 : 86400000;
    return Date.now() - amount * factor;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new ArgError('--since 需要 24h / 30m / 7d 或 ISO 时间');
  return parsed;
}

async function cmdAudit(flags, pos) {
  const sub = pos[1] || 'list';
  if (sub !== 'list') throw new ArgError('用法：bridge audit list [--since 24h] [--limit N]');
  const since = parseSince(flags.since);
  const limit = intFlag(flags, 'limit', { min: 1 }) ?? 50;
  const offset = intFlag(flags, 'offset', { min: 0 }) ?? 0;
  let files = [];
  try {
    files = fs.readdirSync(AUDIT_DIR).filter((name) => name.endsWith('.jsonl')).sort();
  } catch {
    files = [];
  }
  const entries = [];
  for (const name of files) {
    let raw = '';
    try {
      raw = fs.readFileSync(path.join(AUDIT_DIR, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row.ts >= since) entries.push(row);
      } catch {
        // 跳过损坏行
      }
    }
  }
  entries.sort((a, b) => b.ts - a.ts);
  const sliced = entries.slice(offset, offset + limit);
  if (jsonMode) {
    emitJson({ ok: true, result: { dir: AUDIT_DIR, total: entries.length, offset, limit, entries: sliced } });
    return 0;
  }
  if (!sliced.length) {
    print('没有审计记录（目录 ' + AUDIT_DIR + '）');
    return 0;
  }
  print(renderTable(['time', 'method', 'ok', 'ms', 'session', 'url'], sliced.map((row) => [
    formatTime(row.ts),
    row.method || '',
    row.ok ? 'ok' : (row.code || 'fail'),
    row.durationMs != null ? String(row.durationMs) : '',
    row.sessionId || '',
    truncateText(row.url || '', 44),
  ])));
  print('');
  print('共 ' + entries.length + ' 条（offset ' + offset + '，显示 ' + sliced.length + ' 条）');
  return 0;
}

function mcpCommand() {
  return { command: process.execPath, args: [path.join(REPO_ROOT, 'cli', 'bridge.mjs'), 'mcp'] };
}

function jsonMcpConfig(file) {
  let config = {};
  try {
    const text = fs.readFileSync(file, 'utf8');
    config = text.trim() ? JSON.parse(text) : {};
  } catch {
    throw new BridgeError('E_CONFIG_INVALID', 'MCP 配置不是合法 JSON：' + file);
  }
  const servers = config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {};
  const desired = mcpCommand();
  const existing = servers['browser-bridge'];
  if (existing) {
    const same = existing.command === desired.command
      && Array.isArray(existing.args)
      && existing.args.length === desired.args.length
      && existing.args.every((arg, index) => arg === desired.args[index]);
    if (!same) throw new BridgeError('E_MCP_CONFLICT', '已存在不同的 browser-bridge MCP 配置，请手动编辑：' + file);
    return { status: 'already configured', path: file };
  }
  servers['browser-bridge'] = { ...desired, env: {} };
  config.mcpServers = servers;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return { status: 'installed', path: file };
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function codexMcpConfig() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const file = path.join(home, 'config.toml');
  const desired = mcpCommand();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { text = ''; }
  const marker = '[mcp_servers.browser-bridge]';
  if (text.includes(marker)) {
    const section = text.slice(text.indexOf(marker) + marker.length).split(/\n\[/)[0];
    const expected = 'command = ' + tomlString(desired.command);
    const argsExpected = 'args = [' + desired.args.map(tomlString).join(', ') + ']';
    if (!section.includes(expected) || !section.includes(argsExpected)) {
      throw new BridgeError('E_MCP_CONFLICT', '已存在不同的 browser-bridge MCP 配置，请手动编辑：' + file);
    }
    return { status: 'already configured', path: file };
  }
  const block = marker + '\ncommand = ' + tomlString(desired.command) + '\nargs = [' + desired.args.map(tomlString).join(', ') + ']\n';
  fs.mkdirSync(home, { recursive: true });
  const prefix = text && !text.endsWith('\n') ? text + '\n' : text;
  fs.writeFileSync(file, prefix + (prefix ? '\n' : '') + block, 'utf8');
  return { status: 'installed', path: file };
}

function configureMcp(harness) {
  if (harness === 'codex') return { harness, ...codexMcpConfig() };
  const file = harness === 'cursor'
    ? path.join(os.homedir(), '.cursor', 'mcp.json')
    : (harness === 'claude' || harness === 'claude-code')
      ? path.join(os.homedir(), '.claude.json')
      : null;
  if (!file) return { harness, status: 'unsupported' };
  return { harness, ...jsonMcpConfig(file) };
}

function skillManifest(tempDir, sourceKind) {
  const files = {};
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) { walk(full); continue; }
      if (name === '.bridge-skill.json') continue;
      files[path.relative(tempDir, full).split(path.sep).join('/')] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(tempDir);
  return { name: 'BridgeDeck skill', version: SKILL_VERSION, source: sourceKind, installedAt: new Date().toISOString(), files };
}

function installSkillAtomic(targetDir, writeFn, sourceKind, force) {
  const parent = path.dirname(targetDir);
  fs.mkdirSync(parent, { recursive: true });
  const temp = fs.mkdtempSync(path.join(parent, '.bridge-skill-'));
  let backup = null;
  try {
    writeFn(temp);
    const manifest = skillManifest(temp, sourceKind);
    fs.writeFileSync(path.join(temp, '.bridge-skill.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    if (fs.existsSync(targetDir)) {
      if (!force) return { skipped: true, manifest };
      backup = targetDir + '.bak-' + Date.now();
      fs.renameSync(targetDir, backup);
    }
    try {
      fs.renameSync(temp, targetDir);
    } catch (error) {
      if (backup && !fs.existsSync(targetDir)) fs.renameSync(backup, targetDir);
      throw error;
    }
    if (backup) fs.rmSync(backup, { recursive: true, force: true });
    return { skipped: false, manifest };
  } finally {
    if (fs.existsSync(temp)) fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function cmdInstallSkill(flags, pos) {
  const source = flags.source !== undefined ? path.resolve(process.cwd(), String(flags.source)) : SKILL_SOURCE;
  const useEmbedded = flags.embedded === true || !fs.existsSync(source);
  if (!useEmbedded && !fs.existsSync(source)) throw new BridgeError('E_INTERNAL', '找不到 skill 源：' + source);
  const names = Object.keys(SKILL_TARGETS);
  const isDetected = (name) => {
    const target = SKILL_TARGETS[name]();
    const root = path.dirname(path.dirname(target));
    return fs.existsSync(root);
  };
  const isInstalled = (name) => fs.existsSync(path.join(SKILL_TARGETS[name](), 'SKILL.md'));

  if (flags.list === true) {
    const rows = names.map((name) => ({ harness: name, path: SKILL_TARGETS[name](), detected: isDetected(name), installed: isInstalled(name) }));
    if (jsonMode) { emitJson({ ok: true, result: { harnesses: rows, skillVersion: SKILL_VERSION, embedded: true } }); return 0; }
    for (const row of rows) print(row.harness + '  ' + (row.detected ? '已检测' : '未检测') + (row.installed ? ' · 已安装' : '') + '  →  ' + row.path);
    return 0;
  }

  let selected;
  if (flags.all === true) selected = names.filter((name) => isDetected(name));
  else if (flags.harness !== undefined) {
    const raw = String(flags.harness);
    selected = raw.split(',').map((item) => item.trim()).filter(Boolean);
    for (const name of selected) if (!SKILL_TARGETS[name]) throw new ArgError('--harness 只能取 ' + names.join('|'));
  } else if (flags.dir !== undefined) selected = ['dir'];
  else selected = ['dsh'];

  const results = [];
  for (const name of selected) {
    const targetDir = name === 'dir' ? path.resolve(process.cwd(), String(flags.dir)) : SKILL_TARGETS[name]();
    const targetFile = path.join(targetDir, 'SKILL.md');
    if (fs.existsSync(targetFile) && flags.force !== true) {
      results.push({ harness: name, path: targetFile, status: 'skipped' });
      continue;
    }
    const installed = installSkillAtomic(
      targetDir,
      (tempDir) => (useEmbedded ? writeSkillFiles(tempDir) : copySkillDir(source, tempDir)),
      useEmbedded ? 'embedded' : 'filesystem',
      flags.force === true,
    );
    if (installed.skipped) {
      results.push({ harness: name, path: targetFile, status: 'skipped' });
      continue;
    }
    results.push({ harness: name, path: targetFile, status: 'installed', files: Object.keys(installed.manifest.files).length, manifest: installed.manifest.version });
    if (flags.mcp === true) results.push(configureMcp(name));
  }
  if (jsonMode) { emitJson({ ok: true, result: { results, skillVersion: SKILL_VERSION, embedded: useEmbedded } }); return 0; }
  for (const row of results) {
    if (row.harness && row.path && row.files === undefined) {
      print('MCP ' + row.harness + ' → ' + row.path + '（' + row.status + '）');
    } else {
      print(row.status === 'skipped' ? '已存在，跳过（--force 覆盖）：' + row.path : '已安装 skill → ' + row.path + '（' + row.files + ' 个文件）');
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// 页面命令的公共辅助 + 入口
// ---------------------------------------------------------------------------

function indent(text) {
  return text.split('\n').map((line) => `  ${line}`).join('\n');
}

function printHelp() {
  print(`BridgeDeck CLI v${VERSION}（bridge）

用法：
  bridge <命令> [参数] [--session <id>] [--json] [--port <n>] [--timeout <ms>]
  bridge help [method]   带 method 时由协议 schema 生成该方法的参数帮助

总览：
  open [url]                       新建会话（可带 URL 直接导航），≈ session start + navigate
  sync                             同步当前会话的控制上下文，≈ cooperate sync
  close [sessionId]                结束会话，≈ session stop
  ledger status                    查看预写意图账本（待确认/最近记录）
  ledger resolve <id> [--outcome abandoned|done]
                                   确认一条账本记录，解除同标签页的重放拦截
  status                           daemon + 浏览器 + session 总览
  agent brief --session <id>       面向 agent 的页面简报（引用/截断/对话框/下一步）
  cancel <commandId>               取消进行中的命令（协作式取消，需扩展支持）
  browsers                         已连接浏览器实例（含实例名）
  doctor                           环境自检
  settings [--json]                查看扩展设置
  ui [--page popup|options|quick|record|debug|longshot|ops|audit] [--query k=v]
                                  在浏览器里打开扩展页面
  settings set [--label <名字>] [--allow-help on|off] [--control-hint on|off]
               [--page-guard on|off] [--long-shot auto|manual]
               [--daemon-url ws://host:port/ws] [--daemon-token <token>]
                                 借用前确认（--borrow-confirm）只能在扩展设置页改，CLI 不可改
  audit list [--since 24h] [--limit N] [--offset N]
  install-skill [--harness <name>] [--dir <path>] [--force] [--list] [--embedded] [--mcp]
                                  --mcp 同时写入 Codex/Cursor/Claude 的 MCP 客户端配置
  update check|verify|stage|fetch|state|auto [--manifest <path>] [--source <url>] [--out <path>] [--key <file>] [--force] [--download] [--apply --target <dir>]
                                  校验/暂存 dist/release.json（不自动替换当前安装）
  daemon start|stop|restart|status|log [--tail [N]]
  daemon pair [--replace <browserId>]      生成本机配对链接（5 分钟）
  daemon trust-local on|off                本机未配对连接是否允许（off=严格模式）

会话：
  session start [--browser <id|名字|edge|chrome>] [--tab <tabId>] [--no-focus] [--incognito]
                [--agent-name <name>] [--project <name>] [--controller-color <#rrggbb>]
                默认新建并聚焦独立 Agent Window；--no-focus 才在后台开窗
  session rebind <id> --tab <tabId> [--release-old]
  session stop <id> [--keep]
  session list

页面（省略 --session 且只有一个 session 时自动选用）：
  navigate <url> | reload | back|navigate-back | forward|navigate-forward
  observe [--probe-hover] [--max-depth N] [--debug-surfaces] [--save-full <path>] [--max-tokens N] [--cursor <token>] [--frames] [--closed-shadow] [--vom] [--ax]
          [--delta --baseline <observationId>] [--out <path>]
                                   只读观察；文本原地变化时可用增量补丁，未命中基线自动回退整页
  snapshot
  get-html [--ref @eN | --selector css]
  view [--grep <文本>] [--offset N] [--limit N]
  view <file> [--find <文本>] [--start-line N] [--line-count N]
  read [--ref @eN | --selector css] [--all] [--fields-json '<...>'] [--closed-shadow-text <文本>]
  extract discover [--json]
  extract table|list --target <id> | --selector css [--item-selector css] [--fields-json <json>]
               [--max-rows N] [--format json|csv] [--csv-safe] [--out <path>]
  screenshot --out <path> [--mode visible|auto|manual] [--scope viewport|document|follow|current] [--region x,y,w,h] [--overlap px]
             [--ref @eN | --selector css] [--annotate]
  screenshot --mode manual --stitch --out <path>
  click <ref|selector> ${renderFlagUsage('click').join(' ')} | click --capture <id> --image-x X --image-y Y | click --closed-shadow-text <文本>
  动作通用：--context <id> --observation <id> --expect '<json>' --depends-on '<json>' --settle 300ms --wait-timeout 5s
  click --wait-navigation           点击后等 URL 变化且 document readyState=complete（最多 8s）
  hover | focus | scroll-to <ref|selector>
  fill <ref|selector> ${renderFlagUsage('fill').join(' ')}
  press <key> [--ref <ref>]
  select <ref|selector> --value <value>
  drag <from> --to <to> | --dx N --dy N [--mode hold|click-move-click] [--hold 500ms] [--duration 800ms] [--modifiers ctrl+shift]
  wheel --delta-y <n> [--delta-x <n>] [--ref @eN | --selector css]
  blur [--ref @eN | --selector css]
  upload <ref|selector> --file <path> [--file <path> ...]
  download <ref|selector> [--out <path>] [--overwrite] | download --url <url>
  evaluate <expression>
  wait-for-element <selector|@ref> [--state visible] [--timeout 20s]   # 超时 satisfied=false，退出码 0
  wait-for-navigation [--wait-until load|domcontentloaded|networkidle|commit] [--timeout 30s]
  wait-ms <ms>
  console [--since N] [--limit N] [--cursor N]

对话框 / 网络 / 仿真 / 协助：
  dialog arm [--alert accept|dismiss] [--confirm accept|dismiss] [--prompt accept|dismiss]
             [--prompt-text <t>] [--queue]
  dialog status | dialog accept <id> [--text <t>] | dialog dismiss <id>
  dialog arm|disarm | dialog list | dialog handle <id> --accept|--dismiss [--prompt-text <t>]
  operation await <id> [--timeout 60s] | operation cancel <id>
  cooperate sync [--policy auto|strict] [--probe-hover] [--match-text <t>] [--context-lines N]
  cooperate wait [--timeout 5s] | cooperate handback
  pair create [--ttl 10m] [--label x] [--host ip] [--replace] | devices | list | redeem <code> | revoke <code>
  video start [--duration 60s] [--quality standard|high] | status <id> | stop <id> | recover
  video save <id> --out <path> [--overwrite] | list | discard <id> | prune [--ttl 24h]
  record start [--screenshots] | stop | status | list | export [id] [--out <dir>] [--screenshot]
  trace view <trace.json> [--debug <archive.json>] [--out <viewer.html>]   把 Trace v3 渲染成离线 HTML 查看器
  schema [method]   列出方法/作用域/effect/参数 schema（单一来源）
  debug start [--name <t>] [--bodies] | stop | status | export --output <file> | query --file <json> --filter <text>
  debug requests [--filter <子串>] | request <id> [--part headers|timing|request|response|all]
  debug console | pages | performance | aggregate [--filter <子串>] [--slow-ms N]
  debug operations [--limit N] | operation <id> [--with-requests]
  debug capabilities | activity [--limit N] | pin <id> | unpin <id> | pinned
  debug fetch_probe [--ms 1500] | duplicates [--window-ms N] | rule_add --rule '<json>'|--rule-file <f>
  debug rule_export --output <file> | rule_import --file <rules.json> | rule_clear
  debug evidence [--output <file>] [--file <archive.json>] | archive --output <file> | archives --dir <dir> [--prune] [--max N] | analyze [--file <archive.json>] | query --file <archive.json>|--dir <dir> [--filter q] | journal [--limit N]
  debug rule_list | rule_enable <id> | rule_disable <id> | rule_remove <id> | rule_clear
  debug export --output <file> | replay <id> | history
  network start [--bodies] | stop
  network list [--filter <子串>] [--status <n>] [--method GET] [--limit N]
  network detail <id> | network replay <id>
  emulate [--device iphone-14|pixel-7|ipad-mini|...] [--width N --height N] [--dpr 2] [--mobile] [--ua ...] [--touch|--no-touch]
          [--timezone Asia/Shanghai]
          [--locale zh-CN] [--geolocation <lat>,<lon>] [--reset]
  request-help --reason <文本> [--timeout ms]

tab / window：
  tab list [--scope agent|user|all]
  tab new [url] [--no-focus] [--window]
  tab close <tabId> | tab select <tabId> | tab move <tabId> --to-window <windowId>
  tab borrow <tabId> | tab return <tabId>
  window list | window focus <windowId> | window ensure | window resize --width <n> --height <n>

流程：
  plan --steps '[{"method":"fill","params":{"ref":"@e1","value":"x"}},{"method":"click","params":{"ref":"@e2"}}]' [--until-visible <selector>] [--wait-timeout-ms N] [--save-full <path>]
  step <method> [参数...] [--until-visible <selector>] [--wait-timeout-ms N] [--save-full <path>]
  recipe list | show <name> | draft|save <name> --file <json>
  recipe approve <name> --confirm-human [--by x]
  recipe run <name> [--param k=v ...] | rm <name>
                                   默认只回放只读/可逆步骤；含 click/fill 等风险步骤需先
                                   recipe approve <name> --confirm-human

全局参数：
  --session <id>   指定会话；只有一个 session 时可省略
  --session-scope <名字>  按 controller name/project 选唯一会话；优先级低于 --session
  BB_SESSION=<id> 环境变量兜底；未给 --session/--session-scope 时生效
  --json           stdout 输出单行 JSON（{"ok":true,"result":...} / {"ok":false,"error":{...}}）
  --port <n>       daemon 未运行时自动拉起所用端口（默认 BB_PORT → 52900）
  --timeout <ms|20s|2m>   RPC 超时（默认 60000）
  -h, --help       显示本帮助

MCP：node mcp/server.mjs（stdio，13 个 browser_* 工具）

退出码：0 成功；1 业务失败；2 参数错误；6 对话框待处理（dialog_pending）`);
}

async function runCommand(flags, pos) {
  requestedPort = intFlag(flags, 'port', { min: 1 });
  const command = pos[0];
  switch (command) {
    case 'status':
      return cmdStatus(flags);
    case 'agent':
      return cmdAgent(flags, pos);
    case 'cancel':
      return cmdCancel(flags, pos);
    case 'browsers':
      return cmdBrowsers(flags);
    case 'doctor':
      return cmdDoctor(flags);
    case 'settings':
      return cmdSettings(flags, pos);
    case 'ui':
      return cmdUi(flags, pos);
    case 'daemon':
      return cmdDaemon(flags, pos);
    case 'help':
      if (pos[1]) return cmdHelpTopic(String(pos[1]));
      printHelp();
      return 0;
    case 'logs':
      return cmdDaemonLog(flags);
    case 'status':
      return cmdDaemon(flags, ['status']);
    case 'update':
      return cmdUpdate(flags, pos);
    case 'mcp':
      return cmdMcp();
    case 'session':
      return cmdSession(flags, pos);
    case 'tab':
      return cmdTab(flags, pos);
    case 'window':
      return cmdWindow(flags, pos);
    case 'read':
      return cmdRead(flags, pos);
    case 'extract':
      return cmdExtract(flags, pos);
    case 'drag':
      return cmdDrag(flags, pos);
    case 'wheel':
      return cmdWheel(flags, pos);
    case 'blur':
      return cmdBlur(flags, pos);
    case 'upload':
      return cmdUpload(flags, pos);
    case 'download':
      return cmdDownload(flags, pos);
    case 'dialog':
      return cmdDialog(flags, pos);
    case 'network':
      return cmdNetwork(flags, pos);
    case 'debug':
      return cmdDebug(flags, pos);
    case 'operation':
      return cmdOperation(flags, pos);
    case 'cooperate':
      return cmdCooperate(flags, pos);
    case 'pair':
      return cmdPair(flags, pos);
    case 'video':
      return cmdVideo(flags, pos);
    case 'record':
      return cmdRecord(flags, pos);
    case 'trace':
      return cmdTrace(flags, pos);
    case 'schema':
      return cmdSchema(flags, pos);
    case 'emulate':
      return cmdEmulate(flags, pos);
    case 'plan':
      return cmdPlan(flags, pos);
    case 'step':
      return cmdStep(flags, pos);
    case 'view':
      return cmdView(flags, pos);
    case 'request-help':
      return cmdRequestHelp(flags, pos);
    case 'recipe':
      return cmdRecipe(flags, pos);
    case 'audit':
      return cmdAudit(flags, pos);
    case 'install-skill':
      return cmdInstallSkill(flags, pos);
    default:
      return cmdPage(command, flags, pos);
  }
}

function finish(code) {
  process.exitCode = code;
  // 兜底：极少数情况下还有悬挂句柄（例如被中断的 socket），2s 后强制退出。
  const timer = setTimeout(() => process.exit(code), 2000);
  timer.unref();
}

async function main(argv) {
  if (argv.length === 1 && ['--version', '-v', 'version'].includes(argv[0])) {
    print(VERSION);
    return 0;
  }
  const { flags, pos } = parseArgs(argv);
  jsonMode = flags.json === true;
  if (flags.help) {
    printHelp();
    return 0;
  }
  if (!pos.length) {
    printHelp();
    return 2;
  }
  // 零仪式生命周期别名：open / sync / close
  if (pos[0] === 'open') return cmdOpenAlias(flags, pos);
  if (pos[0] === 'sync') return runCommand(flags, ['cooperate', 'sync', ...pos.slice(1)]);
  if (pos[0] === 'close') return runCommand(flags, ['session', 'stop', ...pos.slice(1)]);
  if (pos[0] === 'ledger') return cmdLedger(flags, pos);
  return runCommand(flags, pos);
}

/** bridge ledger：查看/确认预写意图账本。 */
async function cmdLedger(flags, pos) {
  const sub = pos[1] || 'status';
  if (sub === 'status') {
    const limit = flags.limit !== undefined ? Number(flags.limit) : 20;
    const body = await callRpc('ledger.status', { limit: Number.isFinite(limit) ? limit : 20 }, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    const result = body.result || {};
    const pending = result.pending || [];
    if (!pending.length) print('账本：没有待确认的变异操作');
    else {
      print('待确认（同标签页的新变异操作会被拦截）：');
      for (const entry of pending) print(`  ${entry.id}  ${entry.method}  tab=${entry.tabId == null ? '-' : entry.tabId}  ${entry.state}  ${entry.at}`);
    }
    const recent = (result.recent || []).slice(0, 8);
    if (recent.length) {
      print('最近记录：');
      for (const entry of recent) print(`  ${entry.id}  ${entry.method}  ${entry.state}  ${entry.at}`);
    }
    return 0;
  }
  if (sub === 'resolve') {
    const id = pos[2] || flags.id;
    if (!id) throw new ArgError('用法：bridge ledger resolve <id> [--outcome abandoned|done]');
    const outcome = flags.outcome !== undefined ? String(flags.outcome) : 'abandoned';
    const body = await callRpc('ledger.resolve', { id: String(id), outcome }, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (jsonMode) return outputJsonBody(body);
    const entry = (body.result || {}).entry || {};
    print('账本记录 ' + id + ' 已确认（' + (entry.outcome || outcome) + '），同标签页已解锁');
    return 0;
  }
  throw new ArgError('用法：bridge ledger status | bridge ledger resolve <id> [--outcome abandoned|done]');
}

/** bridge open [url]：一步创建会话（可选直接导航），等价 session start + navigate。 */
async function cmdOpenAlias(flags, pos) {
  const url = pos.slice(1).find((value) => /^https?:\/\//i.test(value)) || '';
  const params = { noFocus: flags['no-focus'] === true };
  if (flags.incognito === true) params.incognito = true;
  if (flags.browser !== undefined) params.browser = String(flags.browser);
  if (flags['agent-name'] !== undefined) {
    const controller = { name: String(flags['agent-name']) };
    if (flags.project !== undefined) controller.project = String(flags.project);
    if (flags['controller-color'] !== undefined) controller.color = String(flags['controller-color']);
    if (!isControllerInfo(controller)) throw new ArgError('--agent-name/--project/--controller-color 不合法');
    params.controller = controller;
  }
  const started = await callRpc('session.start', params, timeoutOf(flags));
  if (!started.ok) return outputFailure(started);
  const sessionId = (started.result || {}).sessionId;
  let title = '';
  if (url) {
    const nav = await callRpc('navigate', { session: sessionId, url }, Math.max(timeoutOf(flags), 60000));
    if (!nav.ok) return outputFailure(nav);
    title = (nav.result || {}).title || '';
  }
  if (jsonMode) {
    emitJson({ ok: true, result: { sessionId, url: url || null, title: title || null } });
    return 0;
  }
  print(`已打开会话 ${sessionId}` + (url ? `：${url}${title ? '（' + title + '）' : ''}` : ''));
  return 0;
}

main(process.argv.slice(2))
  .then((code) => finish(code))
  .catch((err) => {
    if (err instanceof ArgError) {
      process.stderr.write('参数错误：' + err.message + '\n运行 bridge -h 查看用法\n');
      finish(2);
      return;
    }
    if (err instanceof BridgeError) {
      outputBridgeError(err);
      finish(1);
      return;
    }
    if (err instanceof RecipeStoreError) {
      outputBridgeError(new BridgeError(err.code, err.message));
      finish(1);
      return;
    }
    process.stderr.write('意外错误：' + (err && err.stack ? err.stack : err) + '\n');
    finish(1);
  });
