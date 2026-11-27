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
import { charWidth, textWidth, padEndWidth, truncateText, renderTable, formatUptime, formatTime, formatLease, formatBytes } from './lib/format.mjs';
import { ArgError, intFlag, requirePos, parseDurationMs, parseOnOff } from './lib/args.mjs';
import { remuxFaststartBase64 } from './lib/video-remux.mjs';
import { createPairCommand } from './commands/pair.mjs';
import { createAuditCommand } from './commands/audit.mjs';
import { createRecipeCommand } from './commands/recipe.mjs';
import { createRecordCommand } from './commands/record.mjs';
import { createTabCommand } from './commands/tab.mjs';
import { createWindowCommand } from './commands/window.mjs';
import { createDialogCommand } from './commands/dialog.mjs';
import { createNetworkCommand } from './commands/network.mjs';
import { createEmulateCommand } from './commands/emulate.mjs';
import { createSessionCommand } from './commands/session.mjs';
import { createExtractCommand } from './commands/extract.mjs';
import { createDaemonCommand } from './commands/daemon.mjs';
import { createBatchCommand } from './commands/batch.mjs';
import { createLeaseCommand } from './commands/lease.mjs';
import { createPageCommand } from './commands/page.mjs';
import { downloadCommand, uploadCommand } from './commands/files.mjs';
import { uiCommand, settingsCommand } from './commands/ui-settings.mjs';
import { longshotCommand, refsCommand } from './commands/misc.mjs';
import { traceCommand } from './commands/trace.mjs';
import { createPlanCommands } from './commands/plan.mjs';
import { createCooperateCommands } from './commands/cooperate.mjs';
import { requestHelpCommand } from './commands/help.mjs';
import { installSkillCommand } from './commands/install-skill.mjs';
import { createReadDragCommands } from './commands/read-drag.mjs';
import { createSchemaLedgerCommands } from './commands/schema-ledger.mjs';
import { createAgentCommands } from './commands/agent.mjs';
import { createStatusCommands } from './commands/status.mjs';
import { createWebmcpCommands } from './commands/webmcp.mjs';
import { mcpInstallCommand } from './commands/mcp-install.mjs';
import { createDaemonLogCommands } from './commands/daemon-log.mjs';
import { createReleaseHelpers } from './commands/release-helpers.mjs';
import { createDebugCommand } from './commands/debug.mjs';
import { createDoctorCommand } from './commands/doctor.mjs';
import { createUpdateCommand } from './commands/update.mjs';
import { createUpdateOps } from './commands/update-ops.mjs';
import { createHelpCommand } from './help.mjs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { COMMAND_SPECS, renderCommandHelp, specFor, validateInvocation } from './lib/command-specs.mjs';
import { decorateJson, errorEnvelope } from './lib/json-contract.mjs';
import { isControllerInfo } from '../extension/src/lib/controller-info.js';
import { recoveryHint } from '../lib/error-codes.mjs';
import { pruneObservationCache } from '../lib/observation-cache.mjs';
import { commandTargetFor, renderSkillCommand } from '../lib/skill-commands.mjs';
import { deriveActions, findHealingAction } from '../lib/observe-actions.mjs';
import { recallAction, rememberActions } from '../lib/action-cache.mjs';
import { redactFillResult, resolveSecretValue } from '../lib/secrets.mjs';
import { analyzePerformance } from '../lib/perf-insights.mjs';
import { matchRecipeWhen, normalizeLoopTimes, recipeStepType } from '../lib/recipe-blocks.mjs';
import { defaultInputMode } from '../lib/input-mode.mjs';
import { summarizePageDiagnostics } from '../lib/diagnostics.mjs';

/**
 * 重模块按需加载：status/evaluate/read/screenshot/session 等热路径不再为 update/trace/debug/recipe
 * 的代码付出启动时间（每个 import 图约 40ms）。命令处理函数在用到时 await 对应 loader。
 */
const lazy = (factory) => {
  let promise = null;
  return () => (promise ||= factory());
};
const loadSkillBundle = lazy(() => import('./embedded-skill.mjs'));
const loadSchemaInfo = lazy(() => import('../lib/schema-info.mjs'));
const loadTraceViewer = lazy(() => import('../lib/trace-viewer.mjs'));
const loadTraceSummary = lazy(() => import('../lib/trace-summary.mjs'));
const loadObservationDelta = lazy(() => import('../lib/observation-delta.mjs'));
const loadDebugEvidence = lazy(() => import('../lib/debug-evidence.mjs'));
const loadDebugAnalysis = lazy(() => import('../lib/debug-analysis.mjs'));
const loadDebugArchive = lazy(() => import('../lib/debug-archive.mjs'));
const loadDebugJournal = lazy(() => import('../lib/debug-journal.mjs'));
const loadDebugArchiveIndex = lazy(() => import('../lib/debug-archive-index.mjs'));
const loadDebugArchiveStore = lazy(() => import('../lib/debug-archive-store.mjs'));
const loadDebug = lazy(() => Promise.all([
  loadDebugEvidence(),
  loadDebugAnalysis(),
  loadDebugArchive(),
  loadDebugJournal(),
  loadDebugArchiveIndex(),
  loadDebugArchiveStore(),
]).then(([a, b, c, d, e, f]) => ({ ...a, ...b, ...c, ...d, ...e, ...f })));
const loadUpdate = lazy(() => Promise.all([
  import('../lib/update-source.mjs'),
  import('../lib/update-state.mjs'),
  import('../lib/release-sign.mjs'),
  import('../lib/release-public-key.mjs'),
]).then(([source, state, sign, key]) => ({ ...source, ...state, ...sign, RELEASE_PUBLIC_KEY: key.RELEASE_PUBLIC_KEY })));

const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0.1.2'; }
  catch { return '0.1.2'; }
})();
// 启动耗时诊断：BB_STARTUP_TRACE=1 时把关键阶段打到 stderr（不改变 stdout 的 JSON 输出）。
const STARTUP_TRACE = process.env.BB_STARTUP_TRACE === '1';
function traceStartup(label) {
  if (!STARTUP_TRACE) return;
  process.stderr.write('[startup] ' + label + ' ' + Math.round(process.uptime() * 1000) + 'ms\n');
}
traceStartup('module-body');
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
const ACTION_CACHE_PATH = path.join(HOME_DIR, 'action-cache.json');
const DAEMON_JSON_PATH = path.join(HOME_DIR, 'daemon.json');
const LOG_PATH = path.join(HOME_DIR, 'daemon.log');

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
  'json', 'no-focus', 'probe-hover', 'full', 'keep', 'help', 'tail', 'lines',
  'all', 'mobile', 'reset', 'queue', 'bodies', 'accept', 'dismiss', 'force', 'list', 'stitch', 'no-clear', 'overwrite', 'annotate', 'grid', 'screenshot', 'incognito', 'with-requests', 'frames', 'release', 'blocking', 'redact-values', 'release-old', 'confirm-human', 'closed-shadow', 'trusted', 'human', 'diff', 'window', 'focus', 'enable', 'disable', 'download', 'apply', 'prune', 'wait-navigation', 'screenshots', 'include-agent',
]);
const VALUE_FLAGS = new Set([
  'session', 'port', 'timeout', 'out', 'value', 'ref', 'selector',
  'state', 'since', 'scope', 'browser', 'width', 'height',
  'mode', 'format', 'max-rows', 'file', 'to', 'steps', 'delta-y', 'delta-x',
  'alert', 'confirm', 'prompt', 'prompt-text', 'reason', 'filter', 'status', 'method', 'action', 'params', 'purpose', 'max-page-tokens', 'trace-version',
  'limit', 'dpr', 'timezone', 'locale', 'geolocation', 'label', 'long-shot', 'id', 'outcome', 'baseline',
  'borrow-confirm', 'allow-help', 'page-guard', 'control-hint', 'name', 'param', 'dir', 'harness',
  'client',
  'url', 'grep', 'offset', 'tab', 'save-full', 'page', 'query', 'fields-json', 'dx', 'dy', 'hold', 'duration', 'group', 'alias', 'idle-ms', 'frame',
  'from-offset-x', 'from-offset-y', 'to-offset-x', 'to-offset-y', 'target', 'text', 'overlap', 'to-window', 'max',
  'context', 'expect', 'observation', 'policy', 'name', 'part', 'output', 'quality',
  'max-tokens', 'cursor', 'match-text', 'context-lines', 'find', 'start-line', 'line-count', 'debug', 'expect-revision',
  'capture', 'image-x', 'image-y', 'image-dx', 'image-dy', 'grid-step', 'profile', 'region-scale', 'visual', 'points', 'plan', 'settle', 'depends-on', 'rule', 'rule-file', 'window-ms', 'ms', 'scope', 'ttl', 'label', 'host', 'daemon-url', 'daemon-token', 'operation-id', 'closed-shadow-text', 'until-visible', 'wait-timeout-ms', 'wait-timeout', 'session-scope', 'agent-name', 'project', 'controller-color', 'code', 'input', 'sandbox',
]);
for (const name of ['item-selector', 'max-depth', 'fields', 'tab-id', 'wait-until', 'device', 'ua', 'accept-language', 'max-bytes', 'max-cells', 'max-targets', 'preview-columns', 'max-steps', 'wait-ms', 'command-id', 'url', 'resource-type', 'state', 'kind', 'max-chars', 'pointer', 'budget']) VALUE_FLAGS.add(name);
for (const name of ['csv-safe', 'touch', 'no-touch', 'full-page', 'debug-surfaces', 'include-controlled', 'embedded', 'vom', 'ax', 'check', 'mcp', 'delta', 'replace', 'auto', 'force', 'accept-dialog']) BOOL_FLAGS.add(name);
for (const name of ['manifest', 'staging', 'backup', 'modifiers', 'key', 'source', 'region', 'interval', 'from', 'dest', 'rollback', 'older-than', 'before', 'allow-domains', 'deny-domains', 'allow-origins', 'secret', 'by', 'min-interval']) VALUE_FLAGS.add(name);
for (const name of ['no-restart', 'yes', 'dry-run', 'unverified', 'observe', 'facts', 'synthetic', 'quiet', 'verbose', 'diagnostics', 'cdp-frames', 'commands', 'actions', 'heal', 'insight', 'synthetic', 'read-only', 'clear', 'keep-open', 'release', 'foreground', 'share', 'node-scope', 'focus', 'stream']) BOOL_FLAGS.add(name);
VALUE_FLAGS.add('max-requests');
VALUE_FLAGS.add('max-console');
VALUE_FLAGS.add('request-id');
VALUE_FLAGS.add('encoder');
VALUE_FLAGS.add('out-dir');
VALUE_FLAGS.add('parts');
// debug 的阈值/时长过滤：帮助与技能文档长期承诺这两个参数，但解析器漏注册，
// 导致 `debug aggregate --slow-ms` / `debug query --min-duration` 被当成未知选项。
VALUE_FLAGS.add('slow-ms');
VALUE_FLAGS.add('min-duration');
VALUE_FLAGS.add('vom-weights');
VALUE_FLAGS.add('vom-top');
VALUE_FLAGS.add('vom-min-score');
VALUE_FLAGS.add('vom-max-nodes');
VALUE_FLAGS.add('vom-max-tokens');
VALUE_FLAGS.add('vom-profile');
VALUE_FLAGS.add('vom-per-group');
VALUE_FLAGS.add('vom-group-tokens');
VALUE_FLAGS.add('vom-billing-model');
VALUE_FLAGS.add('vom-semantic-max-groups');
VALUE_FLAGS.add('vom-semantic-min-score');
VALUE_FLAGS.add('vom-semantic-max-tokens');
VALUE_FLAGS.add('file');
VALUE_FLAGS.add('tile-size');
VALUE_FLAGS.add('stale-attempts');
VALUE_FLAGS.add('entry');
VALUE_FLAGS.add('pages');
VALUE_FLAGS.add('scale');
VALUE_FLAGS.add('margins');
VALUE_FLAGS.add('start');
VALUE_FLAGS.add('end');
VALUE_FLAGS.add('stable-ref');
VALUE_FLAGS.add('steps-file');VALUE_FLAGS.add('until');
VALUE_FLAGS.add('backend');
VALUE_FLAGS.add('pipeline');
for (const name of ['lease', 'expect-epoch', 'control']) VALUE_FLAGS.add(name);
for (const name of ['listen', 'public-url', 'tls-pfx', 'tls-passphrase']) VALUE_FLAGS.add(name);
BOOL_FLAGS.add('fallback-ax');
BOOL_FLAGS.add('merged');
BOOL_FLAGS.add('strict');
BOOL_FLAGS.add('all');
BOOL_FLAGS.add('vom-explain');
BOOL_FLAGS.add('vom-exclude-hidden');
BOOL_FLAGS.add('compare-ax');
// 兼容目标 0.5.0 CLI 参数对齐（M6-P0②）：click/drag/evaluate/extract/read/open/cancel/ledger。
// 取值型参数必须在此注册，否则 parseArgs 会当作未知选项拒绝。
VALUE_FLAGS.add('button');
VALUE_FLAGS.add('click-count');
VALUE_FLAGS.add('observation-id');
VALUE_FLAGS.add('await-promise');
VALUE_FLAGS.add('return-by-value');
VALUE_FLAGS.add('max-columns');
VALUE_FLAGS.add('max-nodes');
VALUE_FLAGS.add('wait-for');
VALUE_FLAGS.add('wait-not');
VALUE_FLAGS.add('timeout-ms');
VALUE_FLAGS.add('rpc-id');
VALUE_FLAGS.add('action');
VALUE_FLAGS.add('confirmation-timeout');
BOOL_FLAGS.add('segmented');
BOOL_FLAGS.add('force-frames');
BOOL_FLAGS.add('vom-tree');
BOOL_FLAGS.add('vom-rank');
BOOL_FLAGS.add('vom-deep');
BOOL_FLAGS.add('vom-group-context');
VALUE_FLAGS.add('deep-max-tokens');
BOOL_FLAGS.add('follow');
VALUE_FLAGS.add('text');
// 第十一批 G：批处理 / 租约裁决 / status --views 的新参数（只增不改）。
for (const name of ['views', 'items', 'on-error', 'concurrency', 'retries', 'batch-id', 'strategy']) VALUE_FLAGS.add(name);
BOOL_FLAGS.add('include-clean');

const REPEATABLE_FLAGS = new Set(['file', 'param']);

async function executeRecipeBlocks(steps, flags) {
  let current = [];
  let planned = 0;
  let completed = 0;
  const flush = async () => {
    if (!current.length) return null;
    const segment = current;
    current = [];
    const body = await callRpc('plan', withControl(flags, { steps: segment }), Math.max(timeoutOf(flags), 180000));
    if (!body.ok) return body;
    planned += segment.length;
    completed += Number((body.result && body.result.completed) || 0);
    return null;
  };
  const urlNow = async () => {
    const body = await callRpc('evaluate', withControl(flags, { expression: 'location.href' }), Math.max(timeoutOf(flags), 10000));
    if (!body.ok) return body;
    return { ok: true, url: String((body.result && body.result.value) || '') };
  };
  const walk = async (list) => {
    for (const step of Array.isArray(list) ? list : []) {
      const type = recipeStepType(step);
      if (type === 'human') {
        const failed = await flush();
        if (failed) return failed;
        const timeoutMs = Math.max(5000, Math.min(Number(step.timeoutMs) || 180000, 1800000));
        const body = await callRpc('request-help', withControl(flags, { reason: String(step.reason || step.prompt || '请完成人工步骤'), timeoutMs }), timeoutMs + 5000);
        if (!body.ok) return body;
        const action = String((body.result && body.result.action) || 'timeout');
        if (action === 'timeout') return { ok: false, error: { code: 'E_TIMEOUT', message: '人工节点等待超时' } };
        if (action === 'skip' || action === 'cancel') return { ok: false, error: { code: 'E_CANCELLED', message: '用户取消了人工节点' } };
        continue;
      }
      if (type === 'if') {
        const failed = await flush();
        if (failed) return failed;
        const currentUrl = await urlNow();
        if (!currentUrl.ok) return currentUrl;
        const branch = matchRecipeWhen(step.when, currentUrl.url) ? step.then : step.else;
        const branchFailed = await walk(branch);
        if (branchFailed) return branchFailed;
        continue;
      }
      if (type === 'loop') {
        const failed = await flush();
        if (failed) return failed;
        const times = normalizeLoopTimes(step.times);
        if (!times) throw new ArgError('recipe loop 需要 1-50 的 times');
        for (let index = 0; index < times; index += 1) {
          const loopFailed = await walk(step.steps);
          if (loopFailed) return loopFailed;
        }
        continue;
      }
      current.push(step);
      if (current.length >= 25) {
        const failed = await flush();
        if (failed) return failed;
      }
    }
    return null;
  };
  const failed = await walk(steps);
  if (failed) return failed;
  const tail = await flush();
  if (tail) return tail;
  return { ok: true, result: { completed, planned } };
}

async function healAction(command, params, body, flags) {
  // 默认开启：ref 过期/找不到时自动重新观察并重试一次（--heal=false 可关闭）。
  if (flags.heal === false || !body || body.ok) return body;
  const code = String((body.error && body.error.code) || '');
  if (!/STALE|NOT_FOUND|BAD_REF|UNKNOWN_REF/i.test(code)) return body;
  const ref = params && params.ref;
  if (typeof ref !== 'string' || !/^@e\d+$/.test(ref)) return body;
  const previous = recallAction(ACTION_CACHE_PATH, ref);
  if (!previous) return body;
  const observed = await callRpc('observe', withControl(flags, { vom: true }), timeoutOf(flags));
  if (!observed.ok) return body;
  const observedUrl = String((observed.result && observed.result.url) || '');
  if (previous.url && observedUrl && previous.url !== observedUrl) return body;
  const actions = deriveActions(observed.result && observed.result.nodes);
  const found = findHealingAction(actions, previous, command);
  if (!found || found.ref === ref) return body;
  const retry = await callRpc(command, { ...params, ref: found.ref }, timeoutOf(flags));
  if (retry.ok && retry.result) retry.result.healed = { from: ref, to: found.ref };
  rememberActions(ACTION_CACHE_PATH, [{ ...found, action: command }], (observed.result && observed.result.url) || '');
  return retry;
}

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
    if (name === 'tail' || name === 'lines') {
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
let quietMode = false;
let verboseMode = false;
let requestedPort = null;
let daemonInfo = null;
// --json 契约的上下文：当前命令/子命令/flags（供统一信封推导 schema/page）。
let jsonContext = { command: null, subcommand: null, flags: null, usage: '' };

function setJsonContext(command, subcommand, flags, usage) {
  jsonContext = {
    command: command ? String(command) : null,
    subcommand: subcommand && subcommand !== 'default' ? String(subcommand) : null,
    flags: flags || null,
    usage: usage ? String(usage) : '',
  };
}

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
  // 快路径：daemon.json 存在且 pid 存活时直接使用，省掉每次命令的 /health 往返。
  // 连接失败（daemon 崩溃留下的残留文件）由 callRpc 清缓存后走完整探测。
  const cached = readDaemonInfo();
  if (cached && (cached.pid == null || isPidAlive(cached.pid))) {
    daemonInfo = { port: cached.port, token: cached.token, pid: cached.pid, tls: cached.tls === true };
    traceStartup('ensureDaemon:fast');
    return daemonInfo;
  }
  const found = await locateDaemon();
  if (found.info) {
    daemonInfo = found.info;
    return daemonInfo;
  }
  if (found.health) {
    throw new BridgeError('E_AUTH', `检测到 daemon 正在运行（pid ${found.health.pid}, port ${found.health.port}），但 ${DAEMON_JSON_PATH} 缺失或损坏，无法取得 token；请先结束该进程后重试`);
  }
  if (process.env.BB_AUTO_START === '0') {
    throw new BridgeError('E_DAEMON', 'daemon 未运行，且 BB_AUTO_START=0；请在主机上显式启动 bridge daemon start，或取消该环境变量');
  }
  daemonInfo = await spawnDaemon(requestedPort);
  return daemonInfo;
}

async function callRpc(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  traceStartup('callRpc:' + method + ':begin');
  const startedAt = Date.now();
  const info = await ensureDaemon();
  traceStartup('callRpc:' + method + ':daemon-ready');
  let reply;
  try {
    reply = await postRpc(info, method, params, timeoutMs);
  } catch (error) {
    if (!error || error.code !== 'E_DAEMON') throw error;
    // 残留 daemon.json 指向已崩溃的 daemon：清缓存、完整探测一次再重试。
    daemonInfo = null;
    const found = await locateDaemon();
    if (!found.info) throw error;
    daemonInfo = found.info;
    reply = await postRpc(found.info, method, params, timeoutMs);
  }
  traceStartup('callRpc:' + method + ':reply');
  if (verboseMode && !jsonMode) process.stderr.write('[rpc] ' + method + ' ' + (Date.now() - startedAt) + 'ms\n');
  return reply;
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
  // 统一走 bb.cli/1 契约：只追加 schema/command/subcommand/page，不改既有 ok/result/error。
  process.stdout.write(`${JSON.stringify(decorateJson(value, jsonContext))}\n`);
}

function print(text) {
  if (quietMode) return;
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
    const advice = recoveryHint(error.code);
    if (advice.hint) process.stderr.write(`  下一步（${advice.retry}）：${advice.hint}\n`);
  }
  return 1;
}

function outputBridgeError(err) {
  if (jsonMode) {
    emitJson({ ok: false, error: { code: err.code || 'E_INTERNAL', message: err.message } });
  } else {
    process.stderr.write(`错误 ${err.code || 'E_INTERNAL'}: ${err.message}\n`);
    const advice = recoveryHint(err.code || 'E_INTERNAL');
    if (advice.hint) process.stderr.write(`  下一步（${advice.retry}）：${advice.hint}\n`);
  }
}

function outputJsonBody(body) {
  emitJson(body);
  return 0;
}

/** 读取文件尾部 N 字节并按行切分（doctor 用，避免读整份大日志）。 */
function readTailLines(file, maxBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const length = Math.min(maxBytes, stat.size);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, stat.size - length);
    return buffer.toString('utf8').split('\n');
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// 命令：status / browsers / doctor
// ---------------------------------------------------------------------------

/** 浏览器表格：有实例名时多一列。 */


const cmdDoctor = createDoctorCommand({
  HOME_DIR,
  DAEMON_JSON_PATH,
  LOG_PATH,
  REPO_ROOT,
  locateDaemon,
  postRpc,
  readDaemonInfo,
  readTailLines,
  emitJson,
  isJson: () => jsonMode,
  print,
});



// ---------------------------------------------------------------------------
// 命令：daemon start|stop|status|log | logs [--tail N] | mcp
// ---------------------------------------------------------------------------

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



const daemonLogCommands = createDaemonLogCommands({
  LOG_PATH, formatBytes, emitJson, isJson: () => jsonMode, print,
});

const cmdDaemon = createDaemonCommand({
  SERVER_PATH,
  REPO_ROOT,
  HOME_DIR,
  ensureDaemon,
  stopDaemon,
  locateDaemon,
  setDaemonInfo: (value) => { daemonInfo = value; },
  callRpc,
  timeoutOf,
  outputFailure,
  outputJsonBody,
  emitJson,
  isJson: () => jsonMode,
  print,
  daemonLog: daemonLogCommands.cmdDaemonLog,
  // 第十一批 G：`bridge daemon batch ...` / `bridge daemon lease ...` 子命令（真实 RPC 消费）。
  cmdBatch: createBatchCommand({
    callRpc, timeoutOf, outputFailure, outputJsonBody, emitJson, isJson: () => jsonMode, print, ArgError,
  }),
  cmdLease: createLeaseCommand({
    callRpc, timeoutOf, outputFailure, outputJsonBody, emitJson, isJson: () => jsonMode, print, ArgError,
  }),
});






/**
 * update install：把便携包安装到当前安装目录，并按“装新 → 试跑 → 原端口重启 → 失败回滚”执行。
 * 文件替换交给临时目录里的独立脚本，避免覆盖正在运行的 cli/lib 代码。
 */






function cmdMcp() {
  const server = path.join(REPO_ROOT, 'mcp', 'server.mjs');
  if (!fs.existsSync(server)) throw new ArgError('找不到 MCP server：' + server);  const child = spawn(process.execPath, [server], { stdio: 'inherit', env: { ...process.env } });
  return new Promise((resolve) => {
    child.on('close', (code) => resolve(code || 0));
    child.on('error', () => resolve(1));
  });
}







// ---------------------------------------------------------------------------
// 命令：session start|stop|list
// ---------------------------------------------------------------------------

const cmdSession = createSessionCommand({
  callRpc,
  timeoutOf,
  outputFailure,
  outputJsonBody,
  isJson: () => jsonMode,
  print,
  spec: COMMAND_SPECS.session,
});

const cmdTab = createTabCommand({
  withSession,
  callRpc,
  timeoutOf,
  outputFailure,
  outputJsonBody,
  isJson: () => jsonMode,
  print,
  renderTable,
  truncateText,
  parseDurationMs,
  requirePos,
  ArgError,
  spec: COMMAND_SPECS.tab,
});

const cmdWindow = createWindowCommand({
  callRpc,
  timeoutOf,
  outputFailure,
  outputJsonBody,
  isJson: () => jsonMode,
  print,
  renderTable,
  requirePos,
  intFlag,
  ArgError,
});

const cmdPage = createPageCommand({
  withControl,
  withSession,
  callRpc,
  timeoutOf,
  renderPageBody,
  resolveTarget,
  writeDataUrl,
  writeStreamedCapture,
  emitJson,
  outputFailure,
  outputJsonBody,
  isJson: () => jsonMode,
  print,
  ACTION_CACHE_PATH,
  applyCachedObservation,
  followOpenedTab,
  healAction,
  readCachedObservation,
  saveObservationCache,
  sessionTabIds,
  waitForNavigationAfterClick,
  withNavigationProbe,
  writeFileAtomic,
});

/**
 * 给页面命令补上 session：--session > --session-scope > BB_SESSION > BB_SESSION_SCOPE > daemon 单会话默认。
 * --session-scope 交给 daemon 按 caller scope / controller.name/project 解析唯一会话。
 */
function withSession(flags, params) {
  if (flags.session !== undefined) {
    params.session = String(flags.session);
  } else if (flags['session-scope'] !== undefined) {
    params.sessionScope = String(flags['session-scope']);
  } else if (process.env.BB_SESSION && process.env.BB_SESSION.trim()) {
    params.session = process.env.BB_SESSION.trim();
  } else if (process.env.BB_SESSION_SCOPE && process.env.BB_SESSION_SCOPE.trim()) {
    params.sessionScope = process.env.BB_SESSION_SCOPE.trim();
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
    const raw = String(flags['tab-id']);
    if (/^\d+$/.test(raw)) {
      out.tabId = Number(raw);
    } else if (flags['dry-run'] === true) {
      // dry-run 不触达 daemon：别名不解析，用占位符让预检输出可读（notes 会说明）。
      out.tabId = '<tabId:' + raw + '>';
    } else {
      throw new ArgError('--tab-id 需要整数或 tab 别名（先用 bridge tab alias 设置）');
    }
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
  // 节点级动态校验：只校验目标节点自身（detached / 文本/值/属性变化），
  // 页面其他位置变化不拦动作与读取。
  if (flags['node-scope'] === true) out.nodeScope = true;
  // 默认后台执行；只有显式 --focus 才允许真正置前（见 docs/PROTOCOL.md §12.2.3）。
  if (flags.focus === true) out.focus = true;
  if (flags['wait-timeout'] !== undefined) {
    const waitMs = parseDurationMs(flags['wait-timeout'], 0);
    if (!Number.isFinite(waitMs) || waitMs < 0) throw new ArgError('--wait-timeout 需要非负毫秒数');
    out.waitTimeoutMs = waitMs;
  }
  return out;
}

/** 解析 <ref|selector> 位置参数或 --ref/--selector/--stable-ref/--text 选项。 */
function resolveTarget(flags, pos, index, { required }) {
  const hasRef = flags.ref !== undefined;
  const hasSelector = flags.selector !== undefined;
  const hasText = flags.text !== undefined;
  const hasStableRef = flags['stable-ref'] !== undefined;
  if ([hasRef, hasSelector, hasText, hasStableRef].filter(Boolean).length > 1) {
    throw new ArgError('--ref、--selector、--text、--stable-ref 只能给一个');
  }
  if (hasStableRef) return { stableRef: String(flags['stable-ref']) };
  if (hasText) return { text: String(flags.text) };
  if (hasRef) return { ref: String(flags.ref) };
  if (hasSelector) return { selector: String(flags.selector) };
  const value = pos[index];
  if (value === undefined || value === '') {
    if (required) throw new ArgError('缺少参数 <ref|selector> 或 --text');
    return null;
  }
  return value.startsWith('@') ? { ref: value } : { selector: value };
}

async function sessionTabIds(sessionId) {
  const body = await callRpc('tab.list', { session: sessionId }, 10000);
  if (!body || body.ok !== true) return [];
  const tabs = (body.result && body.result.tabs) || [];
  return tabs;
}

/** 应用启动后跟随新标签页；识别 IAM SSO 错误页。 */
async function followOpenedTab(sessionId, beforeIds) {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const tabs = await sessionTabIds(sessionId);
    const fresh = tabs.filter((tab) => !beforeIds.has(tab.tabId));
    if (fresh.length) {
      const tab = fresh[fresh.length - 1];
      const rebind = await callRpc('session.rebind', { session: sessionId, tab: tab.tabId, releaseOld: false }, 20000);
      if (!rebind || rebind.ok !== true) {
        throw new BridgeError('E_FOLLOW_FAILED', '新标签页已打开，但 session rebind 失败：' + JSON.stringify(rebind && rebind.error));
      }
      const url = String(tab.url || '');
      if (/\/login\/errorPage\.html/i.test(url)) {
        throw new BridgeError('E_APP_SSO_FAILED', '应用启动被 IAM 拒绝（SSO20004 App子帐号不可用）；请使用 --trusted 点击或检查应用授权');
      }
      return { tabId: tab.tabId, url, title: tab.title || '' };
    }
    await sleep(500);
  }
  return null;
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

/** 流式截图：扩展暂存 base64，CLI 分块 screenshot.read → 拼成文件 → release。 */
async function writeStreamedCapture(out, result, flags) {
  const target = path.resolve(process.cwd(), String(out));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const chunks = [];
  let offset = 0;
  for (let guard = 0; guard < 10000; guard += 1) {
    const body = await callRpc('screenshot.read', withControl(flags, { captureId: result.captureId, offset, length: 512 * 1024 }), timeoutOf(flags));
    if (!body.ok) {
      throw new BridgeError((body.error && body.error.code) || 'E_INTERNAL', '读取截图块失败：' + ((body.error && body.error.message) || ''));
    }
    const chunk = body.result || {};
    if (chunk.dataBase64) chunks.push(Buffer.from(String(chunk.dataBase64), 'base64'));
    offset = Number(chunk.nextOffset);
    if (chunk.eof === true) break;
    if (!Number.isFinite(offset)) throw new BridgeError('E_INTERNAL', '截图流缺少 nextOffset');
    if (!chunk.dataBase64) throw new BridgeError('E_INTERNAL', '截图流提前结束');
  }
  const buffer = Buffer.concat(chunks);
  fs.writeFileSync(target, buffer);
  await callRpc('screenshot.release', withControl(flags, { captureId: result.captureId }), timeoutOf(flags)).catch(() => {});
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



const cmdExtract = createExtractCommand({
  withControl,
  resolveTarget,
  callRpc,
  timeoutOf,
  outputFailure,
  outputJsonBody,
  emitJson,
  isJson: () => jsonMode,
  print,
  renderTable,
  truncateText,
  intFlag,
  ArgError,
  spec: COMMAND_SPECS.extract,
});



const MIME_BY_EXT = {
    '.txt': 'text/plain', '.json': 'application/json', '.csv': 'text/csv',
    '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.zip': 'application/zip',
  };

function guessMime(filePath) {
    return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
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

const webmcpCommands = createWebmcpCommands({
  callRpc, withControl, timeoutOf, outputFailure, outputJsonBody, print, isJson: () => jsonMode, ArgError, renderTable, truncateText, requirePos, BridgeError, parseDurationMs, emitJson,
});

const statusCommands = createStatusCommands({
  callRpc, timeoutOf, outputFailure, outputJsonBody, print, isJson: () => jsonMode, requirePos, formatTime, formatUptime, indent, renderTable, truncateText,
});

const agentCommands = createAgentCommands({
  withControl, callRpc, timeoutOf, outputFailure, emitJson, print, isJson: () => jsonMode, ArgError, summarizePageDiagnostics,
});

const schemaLedgerCommands = createSchemaLedgerCommands({
  loadSchemaInfo, BridgeError, isJson: () => jsonMode, emitJson, print, callRpc, timeoutOf, outputFailure, outputJsonBody, ArgError, isControllerInfo,
  spec: COMMAND_SPECS.open,
});

const readDragCommands = createReadDragCommands({
  callRpc, withControl, timeoutOf, outputFailure, outputJsonBody, print, isJson: () => jsonMode, renderPageBody, renderTable, truncateText, resolveTarget, requirePos, targetOf, parseModifiers, parseDurationMs, intFlag, defaultInputMode, ArgError,
});

const planCommands = createPlanCommands({
  callRpc, withSession, timeoutOf, withControl, outputFailure, outputJsonBody, print, emitJson, isJson: () => jsonMode, renderTable, writeFileAtomic, resolveTarget, BridgeError, ArgError, intFlag, formatTime,
  spec: COMMAND_SPECS.plan,
});

const cooperateCommands = createCooperateCommands({
  callRpc, withControl, timeoutOf, outputFailure, outputJsonBody, print, isJson: () => jsonMode, intFlag, parseDurationMs, ArgError, BridgeError, requirePos,
});

const cmdPair = createPairCommand({
  callRpc,
  timeoutOf,
  outputFailure,
  outputJsonBody,
  isJson: () => jsonMode,
  print,
  renderTable,
  formatTime,
  truncateText,
  BridgeError,
});





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

const cmdDialog = createDialogCommand({
  withControl,
  dialogPolicy,
  callRpc,
  timeoutOf,
  outputFailure,
  outputJsonBody,
  renderPageBody,
  isJson: () => jsonMode,
  print,
  renderTable,
  truncateText,
  requirePos,
  ArgError,
});



function writeVideoFile(base64, out, overwrite, options = {}) {
  const target = path.resolve(process.cwd(), String(out));
  if (fs.existsSync(target) && overwrite !== true) {
    throw new BridgeError('E_EXISTS', '目标文件已存在：' + target + '（加 --overwrite 覆盖）');
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let buffer = Buffer.from(String(base64 || ''), 'base64');
  let trimmedBytes = 0;
  const completeBytes = Number(options.completeBytes);
  if (Number.isFinite(completeBytes) && completeBytes > 0 && completeBytes < buffer.length) {
    trimmedBytes = buffer.length - Math.floor(completeBytes);
    buffer = buffer.subarray(0, Math.floor(completeBytes));
  }
  fs.writeFileSync(target, buffer);
  return { target, buffer, trimmedBytes };
}

const __videoCtx = {
  withControl,
  callRpc,
  timeoutOf,
  outputFailure,
  outputJsonBody,
  emitJson,
  expectOkBody,
  isJson: () => jsonMode,
  print,
  BridgeError,
  ArgError,
  requirePos,
  parseDurationMs,
  writeVideoFile,
  remuxFaststartBase64,
  formatBytes,
  formatTime,
  renderTable,
  truncateText,
};
let __videoCommand = null;
const cmdVideo = async (...args) => {
  if (!__videoCommand) {
    const mod = await import('./commands/video.mjs');
    __videoCommand = mod.createVideoCommand(__videoCtx);
  }
  return __videoCommand(...args);
};

const cmdRecord = createRecordCommand({
  withControl,
  callRpc,
  timeoutOf,
  outputFailure,
  outputJsonBody,
  emitJson,
  isJson: () => jsonMode,
  print,
  BridgeError,
  ArgError,
  writeFileAtomic,
  renderTable,
  formatTime,
  truncateText,
});



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

/** help <topic>：命令主题由 command-specs 渲染；否则回落到协议 schema；未知返回 2。 */
async function cmdHelpTopic(topic) {
  const commandSpec = specFor(topic);
  if (commandSpec) {
    print(renderCommandHelp(commandSpec.command));
    return 0;
  }
  const { renderMethodHelp } = await loadSchemaInfo();
  const text = renderMethodHelp(topic);
  if (!text) {
    print('没有命令或方法帮助：' + topic + '；用 bridge -h 看命令总览，bridge schema 看全部方法');
    return 2;
  }
  print(text);
  return 0;
}

/** schema：输出协议方法的 scope/effect/参数 schema（来自 lib 单一来源）。 */


/** longshot recover：从落盘 tile 重建长截图。 */
/** trace：CDP 性能追踪（start/stop/status）与 Trace v3 离线查看。 */


const cmdDebug = createDebugCommand({
  withControl,
  callRpc,
  timeoutOf,
  renderPageBody,
  emitJson,
  outputFailure,
  outputJsonBody,
  isJson: () => jsonMode,
  print,
  parseSince,
  writeFileAtomic,
  pathOfUrl,
  pickJsonPointer,
  filterDebugEntries,
  HOME_DIR,
});



const cmdNetwork = createNetworkCommand({
  withControl,
  callRpc,
  timeoutOf,
  outputFailure,
  outputJsonBody,
  renderPageBody,
  isJson: () => jsonMode,
  print,
  renderTable,
  truncateText,
  requirePos,
  intFlag,
  ArgError,
});

const cmdEmulate = createEmulateCommand({
  withControl,
  callRpc,
  timeoutOf,
  renderPageBody,
  print,
  intFlag,
  ArgError,
});

// ---------------------------------------------------------------------------

const RECIPE_DIR = path.join(HOME_DIR, 'recipes');
const OBSERVATIONS_DIR = path.join(HOME_DIR, 'observations');

/** 保存整页观察的本地基线，供后续 --delta 合并使用。 */
let lastObservationPrune = 0;
function saveObservationCache(id, text) {
  if (!id || typeof text !== 'string' || !text.length) return;
  try {
    fs.mkdirSync(OBSERVATIONS_DIR, { recursive: true });
    fs.writeFileSync(path.join(OBSERVATIONS_DIR, String(id) + '.json'), JSON.stringify({ id: String(id), text, at: Date.now() }), { mode: 0o600 });
    // 每 10 分钟最多清理一次，避免每次 observe 都扫目录。
    if (Date.now() - lastObservationPrune > 10 * 60 * 1000) {
      lastObservationPrune = Date.now();
      pruneObservationCache(OBSERVATIONS_DIR);
    }
  } catch { /* 缓存失败不影响主流程 */ }
}

/** 用本地基线应用增量补丁；没有基线时返回 null，调用方应回退整页观察。 */
async function applyCachedObservation(id, patch) {
  const { applyObservationPatch } = await loadObservationDelta();
  try {
    const cached = JSON.parse(fs.readFileSync(path.join(OBSERVATIONS_DIR, String(id) + '.json'), 'utf8'));
    if (!cached || typeof cached.text !== 'string') return null;
    return applyObservationPatch(cached.text, patch);
  } catch {
    return null;
  }
}

/** 读取本地基线文本；没有则返回 null。 */
function readCachedObservation(id) {
  try {
    const cached = JSON.parse(fs.readFileSync(path.join(OBSERVATIONS_DIR, String(id) + '.json'), 'utf8'));
    return cached && typeof cached.text === 'string' ? cached.text : null;
  } catch {
    return null;
  }
}
const UPDATE_STATE_PATH = path.join(HOME_DIR, 'update-state.json');

const releaseHelpers = createReleaseHelpers({ REPO_ROOT, VERSION, loadUpdate, BridgeError });

const { cmdUpdateInstall, cmdUpdateFetch, cmdUpdateApply, cmdUpdateRollback } = createUpdateOps({
  REPO_ROOT,
  HOME_DIR,
  UPDATE_STATE_PATH,
  emitJson,
  isJson: () => jsonMode,
  print,
  loadUpdate,
  releaseVerifyKey: releaseHelpers.releaseVerifyKey,
  writeFileAtomic,
  assertInside: releaseHelpers.assertInside,
  sha256File: releaseHelpers.sha256File,
  BridgeError,
});


const cmdUpdate = createUpdateCommand({
  REPO_ROOT,
  UPDATE_STATE_PATH,
  VERSION,
  emitJson,
  isJson: () => jsonMode,
  print,
  loadUpdate,
  verifyRelease: releaseHelpers.verifyRelease,
  releaseVerifyKey: releaseHelpers.releaseVerifyKey,
  sha256File: releaseHelpers.sha256File,
  cmdUpdateInstall,
  cmdUpdateFetch,
  cmdUpdateApply,
  cmdUpdateRollback,
  BridgeError,
});
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
  hermes: () => process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'hermes', 'skills', 'browser-bridge')
    : path.join(os.homedir(), '.hermes', 'skills', 'browser-bridge'),
  'kimi-code': () => path.join(os.homedir(), '.kimi-code', 'skills', 'browser-bridge'),
};

async function writeSkillFiles(targetDir) {
  const { SKILL_FILES } = await loadSkillBundle();
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

const cmdRecipe = createRecipeCommand({
  recipeDir: RECIPE_DIR,
  executeRecipeBlocks,
  isJson: () => jsonMode,
  emitJson,
  print,
  outputFailure,
  outputJsonBody,
  BridgeError,
  ArgError,
  requirePos,
  intFlag,
  callRpc,
  timeoutOf,
  renderTable,
  spec: COMMAND_SPECS.recipe,
});

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

const cmdAudit = createAuditCommand({
  auditDir: AUDIT_DIR,
  writeFileAtomic,
  parseSince,
  intFlag,
  ArgError,
  parseDurationMs,
  emitJson,
  isJson: () => jsonMode,
  print,
  renderTable,
  formatTime,
  truncateText,
});

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

async function skillManifest(tempDir, sourceKind) {
  const { SKILL_VERSION } = await loadSkillBundle();
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

async function installSkillAtomic(targetDir, writeFn, sourceKind, force) {
  const parent = path.dirname(targetDir);
  fs.mkdirSync(parent, { recursive: true });
  const temp = fs.mkdtempSync(path.join(parent, '.bridge-skill-'));
  let backup = null;
  try {
    await writeFn(temp);
    const manifest = await skillManifest(temp, sourceKind);
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



// ---------------------------------------------------------------------------
// 页面命令的公共辅助 + 入口
// ---------------------------------------------------------------------------

function indent(text) {
  return text.split('\n').map((line) => `  ${line}`).join('\n');
}

const printHelp = createHelpCommand({
  print,
  VERSION,
  loadSchemaInfo,
});



async function runCommand(flags, pos) {
  requestedPort = intFlag(flags, 'port', { min: 1 });
  const command = pos[0];
  // 目标命令先做参数契约校验（非法组合在参数层退出 2，不发任何 RPC）。
  const invocation = validateInvocation(command, flags, pos);
  if (invocation) setJsonContext(invocation.command, invocation.sub, flags, invocation.usage);
  switch (command) {
    case 'status':
      return statusCommands.cmdStatus(flags);
    case 'diagnose':
      return agentCommands.cmdDiagnose(flags);
    case 'agent':
      return agentCommands.cmdAgent(flags, pos);
    case 'cancel':
      return statusCommands.cmdCancel(flags, pos);
    case 'browsers':
      return statusCommands.cmdBrowsers(flags);
    case 'doctor':
      return cmdDoctor(flags);
    case 'settings':
      return settingsCommand({
        callRpc, timeoutOf, outputFailure, outputJsonBody, print, isJson: () => jsonMode, BridgeError, ArgError, parseOnOff,
      }, flags, pos);
    case 'ui':
      return uiCommand({
        callRpc, timeoutOf, outputFailure, outputJsonBody, print, isJson: () => jsonMode,
      }, flags, pos);
    case 'daemon':
      return cmdDaemon(flags, pos);
    case 'help':
      if (pos[1]) return cmdHelpTopic(String(pos[1]));
      await printHelp();
      return 0;
    case 'logs':
      return daemonLogCommands.cmdDaemonLog(flags);
    case 'status':
      return cmdDaemon(flags, ['status']);
    case 'update':
      return cmdUpdate(flags, pos);
    case 'webmcp':
      return webmcpCommands.cmdWebmcp(flags, pos);
    case 'exec':
      return webmcpCommands.cmdExec(flags);
    case 'mcp-install':
      return mcpInstallCommand({ REPO_ROOT, ArgError, emitJson, isJson: () => jsonMode, print }, flags);
    case 'mcp':
      return cmdMcp();
    case 'session':
      return cmdSession(flags, pos, invocation);
    case 'tab':
      return cmdTab(flags, pos, invocation);
    case 'window':
      return cmdWindow(flags, pos);
    case 'read':
      return readDragCommands.cmdRead(flags, pos);
    case 'extract':
      return cmdExtract(flags, pos, invocation);
    case 'drag':
      return readDragCommands.cmdDrag(flags, pos);
    case 'wheel':
      return readDragCommands.cmdWheel(flags, pos);
    case 'blur':
      return readDragCommands.cmdBlur(flags, pos);
    case 'upload':
      return uploadCommand({
        withControl, resolveTarget, callRpc, timeoutOf, renderPageBody, print, guessMime, stageUploadBuffer, ArgError,
      }, flags, pos);
    case 'download':
      return downloadCommand({
        withControl, resolveTarget, callRpc, timeoutOf, outputFailure, outputJsonBody, print, emitJson, readTransferToFile, isJson: () => jsonMode, BridgeError,
      }, flags, pos);
    case 'dialog':
      return cmdDialog(flags, pos);
    case 'network':
      return cmdNetwork(flags, pos);
    case 'debug':
      return cmdDebug(flags, pos);
    case 'operation':
      return cooperateCommands.cmdOperation(flags, pos);
    case 'cooperate':
      return cooperateCommands.cmdCooperate(flags, pos);
    case 'pair':
      return cmdPair(flags, pos);
    case 'video':
      return cmdVideo(flags, pos);
    case 'record':
      return cmdRecord(flags, pos);
    case 'trace':
      return traceCommand({
        callRpc, withControl, timeoutOf, outputFailure, outputJsonBody, print, emitJson, isJson: () => jsonMode, loadTraceSummary, writeFileAtomic, BridgeError, ArgError,
      }, flags, pos);
    case 'refs':
      return refsCommand({
        callRpc, withControl, timeoutOf, outputFailure, outputJsonBody, print, isJson: () => jsonMode, ArgError,
      }, flags, pos);
    case 'longshot':
      return longshotCommand({
        callRpc, withControl, timeoutOf, outputFailure, print, emitJson, isJson: () => jsonMode, writeDataUrl, ArgError, requirePos,
      }, flags, pos);
    case 'schema':
      return schemaLedgerCommands.cmdSchema(flags, pos);
    case 'emulate':
      return cmdEmulate(flags, pos);
    case 'plan':
      return planCommands.cmdPlan(flags, pos, invocation);
    case 'replay':
      return planCommands.cmdReplay(flags, pos, invocation);
    case 'step':
      return planCommands.cmdStep(flags, pos, invocation);
    case 'view':
      return planCommands.cmdView(flags, pos, invocation);
    case 'request-help':
      return requestHelpCommand({
        parseDurationMs, withControl, callRpc, outputFailure, outputJsonBody, print, isJson: () => jsonMode, ArgError,
      }, flags, pos);
    case 'recipe':
      return cmdRecipe(flags, pos, invocation);
    case 'audit':
      return cmdAudit(flags, pos);
    case 'install-skill':
      return installSkillCommand({
        loadSkillBundle, SKILL_SOURCE, SKILL_TARGETS, commandTargetFor, installSkillAtomic, writeSkillFiles, copySkillDir, renderSkillCommand, configureMcp, emitJson, isJson: () => jsonMode, print, BridgeError, ArgError,
      }, flags, pos);
    default:
      return cmdPage(command, flags, pos, invocation);
  }
}

function finish(code) {
  traceStartup('finish:' + code);
  process.exitCode = code;
  // 兜底：极少数情况下还有悬挂句柄（例如被中断的 socket），2s 后强制退出。
  const timer = setTimeout(() => process.exit(code), 2000);
  timer.unref();
}
if (STARTUP_TRACE) process.on('exit', (code) => traceStartup('exit:' + code));

async function main(argv) {
  traceStartup('main');
  if (argv.length === 1 && ['--version', '-v', 'version'].includes(argv[0])) {
    print(VERSION);
    return 0;
  }
  const { flags, pos } = parseArgs(argv);
  traceStartup('args-parsed');
  jsonMode = flags.json === true;
  quietMode = flags.quiet === true;
  verboseMode = flags.verbose === true;
  setJsonContext(pos[0], null, flags);
  // dry-run 不允许触达 daemon：只有“目标命令 + --dry-run”才跳过 tab 别名解析（plan 里会提示未解析）。
  const dryPreflight = flags['dry-run'] === true && Boolean(specFor(pos[0]));
  if (flags['tab-id'] !== undefined && !/^\d+$/.test(String(flags['tab-id'])) && !dryPreflight) {
    const resolved = await callRpc('tab.alias', { action: 'resolve', alias: String(flags['tab-id']) }, 10000);
    if (!resolved.ok) return outputFailure(resolved);
    flags['tab-id'] = String((resolved.result || {}).tabId || '');
  }
  if (flags.help) {
    const topic = pos.length ? specFor(pos[0]) : null;
    if (topic) {
      print(renderCommandHelp(topic.command));
      return 0;
    }
    await printHelp();
    return 0;
  }
  if (!pos.length) {
    await printHelp();
    return 2;
  }
  // 零仪式生命周期别名：open / sync / close
  if (pos[0] === 'open') {
    const invocation = validateInvocation('open', flags, pos);
    if (invocation) setJsonContext(invocation.command, invocation.sub, flags, invocation.usage);
    return schemaLedgerCommands.cmdOpenAlias(flags, pos, invocation);
  }
  if (pos[0] === 'sync') return runCommand(flags, ['cooperate', 'sync', ...pos.slice(1)]);
  if (pos[0] === 'close') return runCommand(flags, ['session', 'stop', ...pos.slice(1)]);
  if (pos[0] === 'ledger') return schemaLedgerCommands.cmdLedger(flags, pos);
  return runCommand(flags, pos);
}

/** bridge ledger：查看/确认预写意图账本。 */


/** bridge open [url]：一步创建会话（可选直接导航），等价 session start + navigate。 */


main(process.argv.slice(2))
  .then((code) => finish(code))
  .catch((err) => {
    if (err instanceof ArgError) {
      const code = err.code || 'E_ARG_USAGE';
      const usage = err.usage || jsonContext.usage || '';
      if (jsonMode) {
        // --json 下参数错误也遵守单行 JSON 契约（stdout 一行；人类提示仍在 stderr）。
        emitJson(errorEnvelope({ code, message: err.message, hint: err.hint, usage }, jsonContext));
      }
      process.stderr.write('参数错误：' + err.message + '\n');
      if (code) process.stderr.write('  代码：' + code + '\n');
      if (err.hint) process.stderr.write('  提示：' + err.hint + '\n');
      if (usage && !String(err.hint || '').includes(usage)) process.stderr.write('  用法：' + usage + '\n');
      process.stderr.write('运行 bridge -h 查看用法\n');
      finish(2);
      return;
    }
    if (err instanceof BridgeError) {
      outputBridgeError(err);
      finish(1);
      return;
    }
    if (err && err.name === 'RecipeStoreError') {
      outputBridgeError(new BridgeError(err.code, err.message));
      finish(1);
      return;
    }
    process.stderr.write('意外错误：' + (err && err.stack ? err.stack : err) + '\n');
    finish(1);
  });

