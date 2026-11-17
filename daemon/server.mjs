// daemon/server.mjs — BridgeDeck daemon（零依赖）。
//
// 一个进程同时提供：
//   GET  /health   无鉴权健康检查
//   POST /rpc      本地 JSON-RPC（x-bridge-token 鉴权）
//   WS   /ws       浏览器扩展接入，按 docs/PROTOCOL.md §3 握手/心跳/收发命令
//
// 进程模型：CLI 首次调用时以 detached 子进程拉起本文件（--foreground）；
// 单实例由 daemon.json + /health 共同判定；--stop 通过内部 RPC daemon.stop 优雅退出。
// 状态目录：%USERPROFILE%\.browser-bridge\（BB_HOME 可覆盖）。

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { attachWsServer } from '../lib/ws.mjs';
import { isAllowedWhilePaused, shouldRejectRemoteTransfer, compareProtocol } from '../lib/protocol.mjs';
import { validateMethodParams } from '../lib/schemas.mjs';
import { enforceOperationLimit } from '../lib/limits.mjs';
import { createAuthGuard } from '../lib/auth-guard.mjs';
import { createSessionState } from '../lib/session-state.mjs';
import { createSessionQueue } from '../lib/session-queue.mjs';
import { authKeyId } from '../lib/auth-challenge.mjs';
import { createAuthSession } from '../lib/auth-session.mjs';
import { createPairCode, pairCodeMatches } from '../lib/pair-code.mjs';
import { domainAllowed, normalizeDomains } from '../lib/domain-policy.mjs';
import { decodeTextFrame } from '../lib/transport-frame.mjs';
import { isSessionExpired, sessionPublicView } from '../lib/session-model.mjs';
import { createSessionRecord, markSessionDisconnected, rebindSessionRecord, setSessionPaused } from '../lib/session-lifecycle.mjs';
import { fetchManifest, fetchArtifact } from '../lib/update-source.mjs';
import { readUpdateState, writeUpdateState } from '../lib/update-state.mjs';
import { verifyReleaseSignature } from '../lib/release-sign.mjs';
import { RELEASE_PUBLIC_KEY } from '../lib/release-public-key.mjs';
import { isControllerInfo } from '../extension/src/lib/controller-info.js';
import { IntentLedger, isUnknownOutcome, hasNoEffect } from '../lib/intent-ledger.mjs';
import { AliasRegistry } from '../lib/alias-registry.mjs';
import { selectBrowserInstance } from '../lib/browser-selection.mjs';
import { createDeviceStore } from '../lib/device-store.mjs';
import { createStartJournal, normalizeStartToken } from '../lib/start-journal.mjs';
import { LOCAL_METHODS, SESSION_METHODS, EXT_METHODS, SESSION_QUEUE_BYPASS, isMutating, remoteScopeAllows } from '../lib/methods.mjs';
import { resolveSessionByScope } from '../lib/session-scope.mjs';
import { FEATURE_RECOVERY, featureShortfall, featuresForCall } from '../lib/protocol-features.mjs';
import { serverProof as makeServerProof } from '../lib/local-proof.mjs';
import { normalizePlanSteps } from '../lib/plan-steps.mjs';

const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0.1.2'; }
  catch { return '0.1.2'; }
})();
const SERVICE = 'browser-bridge';
const PROTOCOL_VERSION = '1.9';
const PROTOCOL_MAJOR = 1;
const PROTOCOL_MINOR = 9;

function parseProtocol(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? { major: value, minor: 0 } : null;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(value == null ? '' : value).trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2] || 0) };
}

function protocolSupported(value) {
  // 旧客户端不带 protocol：按 1.0 处理，保持兼容。
  // 同一 major 内允许 minor 偏斜（1.7/1.8 扩展仍可连接），由能力位决定新功能是否可用。
  if (value === undefined || value === null || value === '') return true;
  const parsed = parseProtocol(value);
  return Boolean(parsed) && parsed.major === PROTOCOL_MAJOR;
}

/** 同 major 下的 minor 偏斜：null=一致，older=对方更旧，newer=对方更新。 */
function protocolSkewOf(value) {
  const parsed = parseProtocol(value);
  if (!parsed || parsed.major !== PROTOCOL_MAJOR) return null;
  if (parsed.minor === PROTOCOL_MINOR) return null;
  return parsed.minor < PROTOCOL_MINOR ? 'older' : 'newer';
}

function protocolLabel(value) {
  const parsed = parseProtocol(value);
  return parsed ? parsed.major + '.' + parsed.minor : '0';
}
const DAEMON_CAPABILITIES = ['observe', 'frames', 'dialog', 'screenshot', 'network', 'rules', 'video', 'recording', 'pairing', 'tls', 'unverified', 'dom-read'];
const aliases = new AliasRegistry();
const DEFAULT_PORT = 52900;
const PORT_CANDIDATES = Array.from({ length: 10 }, (_, i) => DEFAULT_PORT + i);
const PING_INTERVAL_MS = 15_000; // 每 15s 发一次 ping
const INSTANCE_DEAD_MS = 45_000; // 45s 无 pong 判定掉线
const DEFAULT_TIMEOUT_MS = 60_000;
let globalBorrowConfirm = null;
const CMD_TIMEOUT_GRACE_MS = 500; // 留给扩展自己先返回 E_TIMEOUT
const STOP_WAIT_MS = 5_000;
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const BODY_LIMIT = 32 * 1024 * 1024;
const STARTUP_WAIT_MS = 10_000;

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const BIND_ADDRESS = process.env.BB_BIND && String(process.env.BB_BIND).trim() ? String(process.env.BB_BIND).trim() : '127.0.0.1';
const TLS_ENABLED = process.env.BB_TLS === '1' || process.env.BB_TLS === 'true';
const TLS_PFX_PATH = process.env.BB_TLS_PFX && String(process.env.BB_TLS_PFX).trim() ? String(process.env.BB_TLS_PFX).trim() : '';
const TLS_PASSPHRASE = process.env.BB_TLS_PASSPHRASE && String(process.env.BB_TLS_PASSPHRASE) ? String(process.env.BB_TLS_PASSPHRASE) : 'browser-bridge';
const PUBLIC_URL = process.env.BB_PUBLIC_URL && String(process.env.BB_PUBLIC_URL).trim() ? String(process.env.BB_PUBLIC_URL).trim().replace(/\/+$/, '') : '';

function tlsPaths() {
  const dir = path.join(HOME_DIR, 'tls');
  return {
    dir,
    cert: path.join(dir, 'cert.pfx'),
    keyPem: path.join(dir, 'key.pem'),
    certPem: path.join(dir, 'cert.pem'),
  };
}
const PAIR_TTL_MS = 10 * 60 * 1000;
let LOCAL_TRUST_PATH = '';
let localTrust = { token: '', strict: false, pairedAt: 0, pendingUntil: 0, pendingCode: '' };
const authGuard = createAuthGuard({ maxAttempts: 10, windowMs: 60_000, blockMs: 60_000, maxHelloBytes: 64 * 1024 });
const sessionState = createSessionState();
const HANDSHAKE_TIMEOUT_MS = 5000;
const LOCAL_PAIR_TTL_MS = 5 * 60 * 1000;
const PAIR_MAX_TTL_MS = 24 * 60 * 60 * 1000;
const pairings = new Map(); // code -> { code, token, url, expiresAt, label, createdAt }
const humanEventSeen = new Map(); // tabId -> 最近一次人类事件时间（用于限流）

// 方法分类集中在 lib/methods.mjs：LOCAL/SESSION/INSTANCE/EXT、队列旁路与变异判定。
// daemon 只消费分类结果，避免与 CLI/MCP/账本各自维护一份清单。

// 扩展经 WS 可调用的只读方法（弹窗/审计页读取 daemon 状态用）
const WS_CALL_METHODS = new Set(['audit.list', 'status', 'session.list', 'browsers', 'operations.list', 'operations.get']);

const HOME_DIR = resolveHomeDir();
// 预写意图账本：变异操作先落盘；超时/断连后拦截同 tab 重放，直到 ledger resolve。
const intentLedger = new IntentLedger({
  dir: HOME_DIR,
  staleMs: Number(process.env.BB_LEDGER_STALE_MS || 15000),
});
intentLedger.load();
LOCAL_TRUST_PATH = path.join(HOME_DIR, 'local-trust.json');
const deviceStore = createDeviceStore(path.join(HOME_DIR, 'devices.json'));
let auditSeq = 0;
const SESSIONS_PATH = path.join(HOME_DIR, 'sessions.json');
const START_JOURNAL_PATH = path.join(HOME_DIR, 'session-starts.json');
// 可恢复启动：请求 token 预写日志；同 token 重试返回既有会话，不重复开窗。
const startJournal = createStartJournal(START_JOURNAL_PATH);
const TRANSFER_DIR = path.join(HOME_DIR, 'transfers');
const TRANSFER_MAX_BYTES = 64 * 1024 * 1024;
const TRANSFER_CHUNK_BYTES = 1024 * 1024;
/** transferId -> { id, sessionId, name, byteSize, received, filePath, fd, createdAt, finished } */
const transfers = new Map();
const DAEMON_JSON_PATH = path.join(HOME_DIR, 'daemon.json');
const LOG_PATH = path.join(HOME_DIR, 'daemon.log');

/** 业务错误：带错误码，最终序列化成 { ok:false, error:{ code, message } }。 */
class BridgeError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function resolveHomeDir() {
  const fromEnv = process.env.BB_HOME;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return path.join(os.homedir(), '.browser-bridge');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureHomeDir() {
  fs.mkdirSync(HOME_DIR, { recursive: true });
}

function rotateLogIfNeeded() {
  try {
    const stat = fs.statSync(LOG_PATH);
    if (stat.size < LOG_MAX_BYTES) return;
    const rotated = `${LOG_PATH}.1`;
    try { fs.rmSync(rotated, { force: true }); } catch { /* 忽略 */ }
    fs.renameSync(LOG_PATH, rotated);
  } catch { /* 文件不存在或轮转失败都不影响主流程 */ }
}

let foreground = false; // --foreground 时同时打到控制台

/** 追加一行日志到 daemon.log；--foreground 时镜像到控制台。 */
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  try {
    ensureHomeDir();
    rotateLogIfNeeded();
    fs.appendFileSync(LOG_PATH, `${line}\n`);
  } catch { /* 日志失败不致命 */ }
  if (foreground) console.log(line);
}

/** 操作审计：只记元数据（方法/耗时/会话/URL），绝不记录输入值、页面正文、截图。 */
function audit(method, params, result, error, durationMs) {
  if (process.env.BB_AUDIT === '0') return;
  try {
    const dir = path.join(HOME_DIR, 'audit');
    fs.mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const ts = Date.now();
    auditSeq += 1;
    const row = { id: ts.toString(36) + '-' + auditSeq, ts, method, ok: !error, durationMs };
    if (error) row.code = error.code || 'E_INTERNAL';
    if (params && typeof params.session === 'string' && params.session) row.sessionId = params.session;
    else if (params && typeof params.sessionId === 'string' && params.sessionId) row.sessionId = params.sessionId;
    if (params && Number.isInteger(params.tabId)) row.tabId = params.tabId;
    if (result && typeof result.url === 'string' && result.url) row.url = result.url;
    fs.appendFileSync(path.join(dir, day + '.jsonl'), JSON.stringify(row) + '\n');
  } catch {
    // 审计失败不影响主流程
  }
}

function logError(message) {
  const line = `[${new Date().toISOString()}] ERROR ${message}`;
  try {
    ensureHomeDir();
    rotateLogIfNeeded();
    fs.appendFileSync(LOG_PATH, `${line}\n`);
  } catch { /* 忽略 */ }
  if (foreground) console.error(line);
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

function readDaemonJson() {
  try {
    const raw = fs.readFileSync(DAEMON_JSON_PATH, 'utf8');
    const info = JSON.parse(raw);
    if (!info || typeof info.port !== 'number') return null;
    return info;
  } catch {
    return null;
  }
}

/** 原子写 daemon.json：先写临时文件再 rename，避免读到半截 JSON。 */
function writeDaemonJson(info) {
  ensureHomeDir();
  info.tls = TLS_ENABLED;
  const tmp = path.join(HOME_DIR, `daemon.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(info), 'utf8');
  fs.renameSync(tmp, DAEMON_JSON_PATH);
  log(`daemon.json 已写入 ${DAEMON_JSON_PATH}`);
}

/** 只清理属于本进程的 daemon.json，避免误删新 daemon 的状态。 */
function removeDaemonJsonOwned() {
  try {
    const info = readDaemonJson();
    if (!info || info.pid === process.pid) fs.rmSync(DAEMON_JSON_PATH, { force: true });
  } catch { /* 忽略 */ }
}

/** GET /health，返回解析后的 health 对象；失败返回 null。 */
function httpGetHealthTls(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    let req;
    try {
      req = https.get({ host: '127.0.0.1', port, path: '/health', agent: false, timeout: timeoutMs, rejectUnauthorized: false }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
          if (text.length > 64 * 1024) req.destroy();
        });
        res.on('end', () => {
          try {
            const json = JSON.parse(text);
            resolve(json && json.service === SERVICE ? json : null);
          } catch {
            resolve(null);
          }
        });
      });
    } catch {
      resolve(null);
      return;
    }
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function httpGetHealth(port, timeoutMs = 1000) {
  return httpGetHealthPlain(port, timeoutMs).then((value) => value || httpGetHealthTls(port, timeoutMs));
}

function httpGetHealthPlain(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let req;
    try {
      req = http.get({ host: '127.0.0.1', port, path: '/health', agent: false, timeout: timeoutMs }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
          if (text.length > 64 * 1024) req.destroy();
        });
        res.on('end', () => {
          try {
            const json = JSON.parse(text);
            finish(json && json.service === SERVICE ? json : null);
          } catch {
            finish(null);
          }
        });
      });
    } catch {
      finish(null);
      return;
    }
    req.on('timeout', () => { req.destroy(); finish(null); });
    req.on('error', () => finish(null));
  });
}

/** 请求自身 /rpc（只有 --stop 用到）。 */
function httpRpcToSelf(port, token, method, params = {}, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify({ method, params, timeoutMs }), 'utf8');
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/rpc',
      method: 'POST',
      agent: false,
      headers: {
        'content-type': 'application/json',
        'content-length': payload.length,
        'x-bridge-token': token,
      },
      timeout: timeoutMs,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(text));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('rpc timeout')));
    req.on('error', reject);
    req.end(payload);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new BridgeError('E_BAD_REQUEST', 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function tokenMatches(header) {
  const token = CURRENT_TOKEN;
  if (!token || typeof header !== 'string' || header.length !== token.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(token));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 运行时状态
// ---------------------------------------------------------------------------

const startedAt = Date.now();
let currentServer = null;
let currentPort = 0;
let CURRENT_TOKEN = '';
let heartbeatTimer = null;
let shuttingDown = false;

/** instanceId -> { instanceId, browser, browserVersion, extVersion, userAgent, connectedAt, lastPong, conn, pending } */
const instances = new Map();
/** sessionId -> { sessionId, instanceId, tabId, windowId, url, title, startedAt } */
const sessions = new Map();
const inflight = new Map();
// 每个 session 一条串行队列：同一会话的命令按提交顺序执行，避免扩展侧
// ref-store / debugger / 输入状态在并发工具调用下互相踩踏。
const sessionQueue = createSessionQueue({ capacity: 64 });
// 队列旁路表见 lib/methods.mjs 的 SESSION_QUEUE_BYPASS。
loadSessions();
loadLocalTrust();
// 上次进程的 staging 文件在崩溃后不可继续使用：启动时清空，避免目录膨胀。
try {
  fs.rmSync(TRANSFER_DIR, { recursive: true, force: true });
} catch { /* 忽略 */ }
try {
  fs.mkdirSync(TRANSFER_DIR, { recursive: true });
} catch { /* 忽略 */ }

function saveSessions() {
  try {
    const list = [...sessions.values()].map((session) => ({ ...session, observation: null }));
    const temp = SESSIONS_PATH + '.tmp';
    fs.writeFileSync(temp, JSON.stringify({ version: 1, sessions: list }, null, 2), 'utf8');
    fs.renameSync(temp, SESSIONS_PATH);
  } catch (error) {
    log('持久化会话失败：' + ((error && error.message) || error));
  }
}

function loadSessions() {
  try {
    const data = JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8'));
    for (const session of data.sessions || []) {
      if (session && typeof session.sessionId === 'string' && Number.isInteger(session.tabId) && Date.now() - (Number(session.startedAt) || 0) < 24 * 60 * 60 * 1000) {
        sessions.set(session.sessionId, { ...session, observation: null, restored: true });
        sessionState.recover(session.sessionId);
      }
    }
    if (sessions.size) log('已恢复 ' + sessions.size + ' 个持久化会话');
  } catch {
    // 没有历史会话
  }
}

// ---------------------------------------------------------------------------
// 扩展连接：握手 / 心跳 / 命令回包
// ---------------------------------------------------------------------------

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item && item.family === 'IPv4' && !item.internal) return item.address;
    }
  }
  return '127.0.0.1';
}

function wsUrlFor(host) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const bind = BIND_ADDRESS;
  const target = host || (bind === '0.0.0.0' || bind === '::' ? lanAddress() : bind);
  return (TLS_ENABLED ? 'wss://' : 'ws://') + target + ':' + currentPort + '/ws';
}

function prunePairings() {
  const now = Date.now();
  for (const [code, item] of pairings) {
    if (item.expiresAt <= now) pairings.delete(code);
  }
}

function pairCreate(params = {}) {
  prunePairings();
  if (params.replace === true) pairings.clear();
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = Array.from({ length: 6 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  } while (pairings.has(code));
  const ttl = Math.min(Math.max(Number(params.ttlMs) || PAIR_TTL_MS, 60_000), PAIR_MAX_TTL_MS);
  const item = {
    code,
    token: crypto.randomBytes(16).toString('hex'),
    url: wsUrlFor(params.host ? String(params.host) : ''),
    expiresAt: Date.now() + ttl,
    label: typeof params.label === 'string' ? params.label.slice(0, 40) : '',
    scope: params.scope === 'read' ? 'read' : 'control',
    createdAt: Date.now(),
  };
  pairings.set(code, item);
  log('pair 创建 code=' + code + ' ttl=' + ttl + 'ms');
  return { ...item, link: item.url + '#' + item.token };
}

function pairList() {
  prunePairings();
  return {
    devices: [...instances.values()]
      .filter((instance) => instance.remote === true)
      .map((instance) => ({ instanceId: instance.instanceId, browser: instance.browser, browserVersion: instance.browserVersion, connectedAt: instance.connectedAt, localAuth: 'remote-paired', scope: instance.scope || 'control' })),
    pairings: [...pairings.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((item) => ({ code: item.code, url: item.url, label: item.label, scope: item.scope, expiresAt: item.expiresAt })),
    bind: BIND_ADDRESS,
    knownDevices: deviceStore.list(),
  };
}

function pairRedeem(params = {}) {
  prunePairings();
  const code = String(params.code || '').trim().toUpperCase();
  const item = pairings.get(code);
  if (!item) throw new BridgeError('E_PAIR_INVALID', '配对码无效或已过期');
  return { ok: true, code: item.code, url: item.url, token: item.token, scope: item.scope, expiresAt: item.expiresAt };
}

function pairRenew(params = {}) {
  const deviceId = String(params.deviceId || '').trim();
  const rotated = deviceStore.rotate(deviceId, { scope: params.scope });
  if (!rotated) throw new BridgeError('E_PAIR_INVALID', '设备不存在：' + deviceId);
  for (const [code, item] of [...pairings]) {
    if (authKeyId(item.token) === rotated.oldTokenHash.slice(0, 32)) pairings.delete(code);
  }
  let kicked = 0;
  const oldKey = rotated.oldTokenHash.slice(0, 32);
  for (const instance of [...instances.values()]) {
    if (instance.pairToken && authKeyId(instance.pairToken) === oldKey) {
      kicked += 1;
      try { instance.conn.close(4003, 'pair renewed'); } catch { /* 忽略 */ }
      dropInstance(instance, '配对已续期');
    }
  }
  const url = wsUrlFor('');
  return { ok: true, deviceId: rotated.deviceId, token: rotated.token, url, link: url + '#' + rotated.token, scope: rotated.scope, kicked };
}

function pairRevoke(params = {}) {
  const raw = String(params.deviceId || params.code || '').trim();
  const code = raw.toUpperCase();
  const item = pairings.get(code);
  const existed = pairings.delete(code);
  const known = deviceStore.revoke(raw) || { revoked: false, deviceId: null };
  if (!known.revoked && item) deviceStore.revoke(authKeyId(item.token));
  const revokedTokenHash = item ? authKeyId(item.token) : known.tokenHash;
  let kicked = 0;
  for (const instance of [...instances.values()]) {
    const matchesPair = item && instance.pairToken && instance.pairToken === item.token;
    const matchesDevice = revokedTokenHash && instance.pairToken && authKeyId(instance.pairToken) === revokedTokenHash.slice(0, 32);
    if (matchesPair || matchesDevice) {
      kicked += 1;
      try { instance.conn.close(4003, 'pair revoked'); } catch { /* 忽略 */ }
      dropInstance(instance, '配对已撤销');
    }
  }
  return { ok: true, revoked: existed || known.revoked, code: item ? code : '', deviceId: known.deviceId || null, kicked };
}

/** 轮换本机配对 token：旧链接立即失效，用旧 token 认证的本机连接断开。 */
function pairRotate() {
  const previous = localTrust.token;
  localTrust.token = crypto.randomBytes(24).toString('hex');
  localTrust.pairedAt = Date.now();
  localTrust.pendingUntil = 0;
  localTrust.pendingCode = '';
  saveLocalTrust();
  let kicked = 0;
  for (const instance of [...instances.values()]) {
    if (instance.remote === true) continue;
    if (instance.pairToken && instance.pairToken === previous) {
      kicked += 1;
      try { instance.conn.close(4003, 'local token rotated'); } catch { /* 忽略 */ }
      dropInstance(instance, '本机 token 已轮换');
    }
  }
  log('本机配对 token 已轮换，断开旧连接 ' + kicked + ' 个');
  return { ok: true, rotated: true, kicked, link: wsUrlFor('') + '#' + localTrust.token };
}

function loadLocalTrust() {
  try {
    const raw = JSON.parse(fs.readFileSync(LOCAL_TRUST_PATH, 'utf8'));
    localTrust = {
      token: typeof raw.token === 'string' ? raw.token : '',
      strict: raw.strict === true,
      pairedAt: Number(raw.pairedAt) || 0,
      pendingUntil: Number(raw.pendingUntil) || 0,
      pendingCode: typeof raw.pendingCode === 'string' ? raw.pendingCode : '',
    };
  } catch {
    localTrust = { token: '', strict: false, pairedAt: 0, pendingUntil: 0, pendingCode: '' };
  }
}
function saveLocalTrust() {
  try { fs.writeFileSync(LOCAL_TRUST_PATH, JSON.stringify(localTrust, null, 2), 'utf8'); } catch { /* 忽略 */ }
}
function localPairCreate(params = {}) {
  const token = crypto.randomBytes(16).toString('hex');
  const code = createPairCode();
  localTrust.token = token;
  localTrust.pendingUntil = Date.now() + LOCAL_PAIR_TTL_MS;
  localTrust.pendingCode = code;
  if (params.replace) localTrust.pairedAt = 0;
  saveLocalTrust();
  const link = wsUrlFor('') + '#' + token;
  log('本机配对链接已生成（5 分钟内有效）');
  return { ok: true, link, token, code, expiresAt: localTrust.pendingUntil, strict: localTrust.strict !== true };
}
function localTrustSet(params = {}) {
  localTrust.strict = params.strict === true;
  saveLocalTrust();
  if (localTrust.strict) {
    for (const instance of [...instances.values()]) {
      if (instance.localVerified !== true) {
        try { instance.conn.close(4003, 'local trust required'); } catch { /* 忽略 */ }
        dropInstance(instance, '本机严格模式：未配对连接被拒绝');
      }
    }
  }
  log('本机信任模式 strict=' + localTrust.strict);
  return { ok: true, strict: localTrust.strict };
}
function localPairVerified(token) {
  if (!token || !localTrust.token || token !== localTrust.token) return false;
  // 配对成功后长期有效；从未使用过的链接 5 分钟后过期。
  if (localTrust.pairedAt > 0) return true;
  return localTrust.pendingUntil === 0 || localTrust.pendingUntil > Date.now();
}

/** 新配对链接必须同时带 6 位确认码，防止只拿到链接就完成配对。 */
function localPairCodeRequired() {
  return localTrust.pendingUntil > Date.now() && Boolean(localTrust.pendingCode);
}
function localPairCodeValid(message) {
  return !localPairCodeRequired() || pairCodeMatches(localTrust.pendingCode, message && message.pairCode);
}

function scopeForRemoteToken(token) {
  if (!token) return 'control';
  for (const item of pairings.values()) {
    if (item.token === token && item.expiresAt > Date.now()) return item.scope === 'read' ? 'read' : 'control';
  }
  return deviceStore.scopeForToken(token) || 'control';
}

function isPairTokenValid(token) {
  if (!token) return false;
  const now = Date.now();
  for (const item of pairings.values()) {
    if (item.token === token && item.expiresAt > now) return true;
  }
  return deviceStore.verify(token);
}

/** 根据客户端发来的 keyId 找回密钥；不把明文 token 放进 hello。 */
function findAuthSecret(keyId) {
  if (!keyId) return null;
  if (localTrust.token && authKeyId(localTrust.token) === keyId) {
    return { token: localTrust.token, local: true, remote: false };
  }
  const now = Date.now();
  for (const item of pairings.values()) {
    if (item.expiresAt > now && authKeyId(item.token) === keyId) {
      return { token: item.token, local: false, remote: true, scope: item.scope === 'read' ? 'read' : 'control' };
    }
  }
  const deviceToken = deviceStore.secretForKeyId(keyId);
  if (deviceToken) return { token: deviceToken, local: false, remote: true, scope: deviceStore.scopeForToken(deviceToken) || 'control' };
  return null;
}

function newInstanceId() {
  return crypto.randomBytes(4).toString('hex');
}

function normalizeSettings(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  return {
    borrowConfirm: input.borrowConfirm !== false,
    allowHelp: input.allowHelp !== false,
    pageGuard: input.pageGuard !== false,
    longShotMode: input.longShotMode === 'manual' ? 'manual' : 'auto',
  };
}

function normalizeHello(hello) {
  return {
    protocol: protocolLabel(hello.protocol),
    protocolSkew: protocolSkewOf(hello.protocol),
    capabilities: Array.isArray(hello.capabilities) ? hello.capabilities.filter((item) => typeof item === 'string').slice(0, 32) : [],
    browser: typeof hello.browser === 'string' && hello.browser ? hello.browser : 'unknown',
    browserVersion: typeof hello.browserVersion === 'string' ? hello.browserVersion : '',
    extVersion: typeof hello.extVersion === 'string' ? hello.extVersion : '',
    userAgent: typeof hello.userAgent === 'string' ? hello.userAgent : '',
    label: typeof hello.label === 'string' ? hello.label.trim().slice(0, 40) : '',
    settings: normalizeSettings(hello.settings),
  };
}

/** 处理 hello：生成/沿用 instanceId，回 hello-ack，登记实例。 */
function registerInstance(conn, hello, extra = {}) {
  const meta = normalizeHello(hello);
  const hint = typeof hello.instanceId === 'string' && /^[0-9a-f]{8}$/i.test(hello.instanceId)
    ? hello.instanceId.toLowerCase()
    : null;
  let instance;
  if (hint && instances.has(hint)) {
    // 同一浏览器实例重连：沿用 instanceId 与既有会话，只替换连接。
    instance = instances.get(hint);
    const oldConn = instance.conn;
    instance.conn = conn;
    instance.lastPong = Date.now();
    instance.localVerified = hello.localVerified === true;
    Object.assign(instance, meta);
    if (oldConn && oldConn !== conn && !oldConn.closed) {
      try { oldConn.close(1000, 'replaced by reconnect'); } catch { /* 忽略 */ }
    }
  } else {
    let instanceId = hint;
    if (!instanceId) {
      instanceId = newInstanceId();
      while (instances.has(instanceId)) instanceId = newInstanceId();
    }
    instance = {
      instanceId,
      localVerified: hello.localVerified === true,
      ...meta,
      connectedAt: Date.now(),
      lastPong: Date.now(),
      conn,
      pending: new Map(),
    };
    instances.set(instanceId, instance);
  }
  if (instance.localVerified) {
    localTrust.pairedAt = Date.now();
    localTrust.pendingUntil = 0;
    localTrust.pendingCode = '';
    saveLocalTrust();
  }
  for (const session of sessions.values()) {
    if (session.instanceId === instance.instanceId) sessionState.activate(session.sessionId);
  }
  conn.sendJson({
    type: 'hello-ack',
    instanceId: instance.instanceId,
    daemonVersion: VERSION,
    protocol: PROTOCOL_VERSION,
    capabilities: DAEMON_CAPABILITIES,
    localAuth: { state: instance.localVerified ? 'verified' : 'unpaired', strict: localTrust.strict === true },
    ...(extra.serverProof ? { serverProof: extra.serverProof } : {}),
  });
  log(`扩展已连接 instance=${instance.instanceId} browser=${instance.browser} v${instance.browserVersion} ext=${instance.extVersion}`);
  instance.pairToken = typeof hello.pairToken === 'string' ? hello.pairToken : '';
  return instance;
}

/** 清理实例：拒绝未完成命令、删掉它名下的 session、关连接。 */
function dropInstance(instance, reason, { closeSocket = true } = {}) {
  if (!instance) return;
  if (instances.get(instance.instanceId) === instance) instances.delete(instance.instanceId);
  for (const [, entry] of instance.pending) {
    clearTimeout(entry.timer);
    inflight.delete(entry.id);
    entry.reject(new BridgeError('E_NO_BROWSER', `浏览器实例已断开（${reason}）`));
  }
  instance.pending.clear();
  // 保留会话：同一实例重连（设置切换/WS 抖动）后还能继续用；过期由 sessionList 清理
  let keptSessions = 0;
  for (const [, session] of sessions) {
    if (session.instanceId === instance.instanceId) {
      markSessionDisconnected(session);
      keptSessions += 1;
    }
  }
  saveSessions();
  log(`扩展断开 instance=${instance.instanceId}：${reason}${keptSessions ? `，保留 ${keptSessions} 个 session` : ''}`);
  if (closeSocket && !instance.conn.closed) {
    try { instance.conn.close(1001, reason); } catch { /* 忽略 */ }
  }
}

function settleResponse(instance, msg) {
  const entry = instance.pending.get(msg.id);
  if (!entry) {
    // 超时后才回来的回包直接丢弃（PROTOCOL §3.3）。
    log(`丢弃迟到/未知回包 id=${msg.id} method=${entry ? entry.method : '?'}`);
    return;
  }
  instance.pending.delete(msg.id);
  clearTimeout(entry.timer);
  inflight.delete(msg.id);
  if (msg.ok) {
    entry.resolve(msg.result === undefined ? {} : msg.result);
  } else {
    const error = msg.error && typeof msg.error === 'object' ? msg.error : {};
    entry.reject(new BridgeError(error.code || 'E_INTERNAL', error.message || '扩展返回失败', error.data));
  }
}

function handleExtensionEvent(instance, msg) {
  if (msg.event === 'settings' && msg.params && typeof msg.params === 'object') {
    const params = msg.params;
    instance.label = typeof params.label === 'string' ? params.label.trim().slice(0, 40) : '';
    instance.settings = normalizeSettings(params);
    log(`实例 ${instance.instanceId} 设置已更新 label="${instance.label}" borrowConfirm=${instance.settings.borrowConfirm} allowHelp=${instance.settings.allowHelp}`);
    return;
  }
  if ((msg.event === 'human.input' || msg.event === 'human.blur') && msg.params && Number.isInteger(msg.params.tabId)) {
    const tabId = msg.params.tabId;
    const now = Date.now();
    if (now - (humanEventSeen.get(tabId) || 0) < 200) return;
    humanEventSeen.set(tabId, now);
    for (const [sessionId, session] of sessions) {
      if (session.instanceId !== instance.instanceId || session.tabId !== tabId) continue;
      session.lastHumanInputAt = now;
      if (msg.event === 'human.input' && session.paused !== true) {
        session.paused = true;
        session.pausedBy = 'auto';
        session.pausedAt = now;
        sendInstanceEvent(instance, 'takeover.state', { tabId, sessionId, paused: true, pausedBy: 'auto', borrowed: session.borrowed === true, controller: session.controller ?? null, project: session.controller?.project ?? null });
        log('session ' + sessionId + ' 人类输入 → 自动暂停');
      }
      break;
    }
    return;
  }
  if (msg.event === 'takeover.pause' && msg.params && Number.isInteger(msg.params.tabId)) {
    const tabId = msg.params.tabId;
    for (const [sessionId, session] of sessions) {
      if (session.instanceId === instance.instanceId && session.tabId === tabId) {
        session.paused = msg.params.paused === true;
        log('接管浮层切换暂停 session=' + sessionId + ' paused=' + session.paused);
        sendInstanceEvent(instance, 'takeover.state', { tabId, sessionId, paused: session.paused, borrowed: session.borrowed === true });
        break;
      }
    }
    return;
  }
  if (msg.event === 'takeover.stop' && msg.params && Number.isInteger(msg.params.tabId)) {
    const tabId = msg.params.tabId;
    for (const [sessionId, session] of sessions) {
      if (session.instanceId === instance.instanceId && session.tabId === tabId) {
        log('用户从接管浮层收回控制 session=' + sessionId + ' tab=' + tabId);
        stopSession({ sessionId }, 5000).catch((error) => log('收回控制失败：' + ((error && error.message) || error)));
        break;
      }
    }
    return;
  }
  if (msg.event === 'tab-removed' && msg.params && typeof msg.params.tabId === 'number') {
    const tabId = msg.params.tabId;
    for (const [sessionId, session] of sessions) {
      if (session.instanceId === instance.instanceId && session.tabId === tabId) {
        sessions.delete(sessionId);
        aliases.clear(sessionId);
        releaseTransfersForSession(sessionId);
        sessionState.finish(sessionId);
        sessionQueue.drop(sessionId);
        saveSessions();
        log(`tab ${tabId} 已关闭，移除 session ${sessionId}`);
      }
    }
    return;
  }
  log(`忽略扩展事件 event=${msg.event}`);
}

/** 扩展发起的只读调用：{type:"call", id, method, params} → {type:"call-res", id, ok, result|error} */
async function handleWsCall(instance, msg) {
  const id = msg.id != null ? msg.id : '';
  const method = String(msg.method || '');
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
  const reply = (payload) => {
    try {
      instance.conn.sendJson({ type: 'call-res', id, ...payload });
    } catch {
      /* 连接已断，忽略 */
    }
  };
  if (!WS_CALL_METHODS.has(method)) {
    reply({ ok: false, error: { code: 'E_UNKNOWN_METHOD', message: '不允许的 WS 调用：' + method } });
    return;
  }
  try {
    const result = await dispatch(method, params, 10000);
    reply({ ok: true, result });
  } catch (error) {
    reply({ ok: false, error: { code: (error && error.code) || 'E_INTERNAL', message: String((error && error.message) || error) } });
  }
}

function handleExtensionMessage(instance, msg) {
  instance.lastPong = Date.now();
  switch (msg.type) {
    case 'pong':
      return;
    case 'ping':
      try { instance.conn.sendJson({ type: 'pong' }); } catch { /* 忽略 */ }
      return;
    case 'res':
      settleResponse(instance, msg);
      return;
    case 'event':
      handleExtensionEvent(instance, msg);
      return;
    case 'call':
      handleWsCall(instance, msg).catch((error) => log('WS call 处理失败：' + ((error && error.message) || error)));
      return;
    default:
      log(`忽略扩展消息 type=${msg.type}`);
  }
}

function onExtensionConnection(conn, req) {
  const role = conn.query ? conn.query.get('role') : 'extension';
  if (role !== 'extension') {
    try { conn.close(1008, 'unsupported role'); } catch { /* 忽略 */ }
    return;
  }
  // 只允许扩展来源或没有 Origin 的本地测试客户端；网页/沙箱 Origin 不能连本机 daemon。
  const origin = String((req && req.headers && req.headers.origin) || '');
  if (origin && !/^(chrome-extension|moz-extension):\/\//i.test(origin)) {
    try { conn.close(1008, 'web origin not allowed'); } catch { /* 忽略 */ }
    return;
  }
  const remoteAddress = conn.socket && conn.socket.remoteAddress ? conn.socket.remoteAddress : '';
  const isRemote = remoteAddress && !/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(remoteAddress);
  const peerKey = remoteAddress || 'unknown';
  let instance = null;
  const authSession = createAuthSession();
  if (isRemote && authGuard.isBlocked(peerKey)) {
    try { conn.sendJson({ type: 'hello-error', code: 'E_RATE_LIMITED', message: '握手失败次数过多，请稍后再试' }); } catch { /* 忽略 */ }
    try { conn.close(4029, 'rate limited'); } catch { /* 忽略 */ }
    return;
  }
  const handshakeTimer = setTimeout(() => {
    if (instance) return;
    try { conn.sendJson({ type: 'hello-error', code: 'E_TIMEOUT', message: '5s 内没有收到 hello' }); } catch { /* 忽略 */ }
    try { conn.close(4008, 'hello timeout'); } catch { /* 忽略 */ }
  }, HANDSHAKE_TIMEOUT_MS);
  conn.on('message', (raw, isBinary) => {
    if (isBinary) return;
    if (!instance) {
      const sizeCheck = authGuard.checkHello(peerKey, Buffer.byteLength(String(raw), 'utf8'));
      if (!sizeCheck.ok) {
        if (isRemote) authGuard.fail(peerKey);
        try { conn.sendJson({ type: 'hello-error', code: sizeCheck.code, message: sizeCheck.code === 'E_TOO_LARGE' ? 'hello 帧过大' : '握手被限流' }); } catch { /* 忽略 */ }
        try { conn.close(sizeCheck.code === 'E_TOO_LARGE' ? 4009 : 4029, sizeCheck.code); } catch { /* 忽略 */ }
        return;
      }
    }
    const decoded = decodeTextFrame(raw);
    if (!decoded.ok) {
      if (decoded.code === 'E_TOO_LARGE') {
        try { conn.sendJson({ type: 'hello-error', code: 'E_TOO_LARGE', message: '帧超过 16MiB 上限' }); } catch { /* 忽略 */ }
        try { conn.close(4009, 'frame too large'); } catch { /* 忽略 */ }
      } else {
        log('扩展消息不是合法 JSON，已忽略');
      }
      return;
    }
    let msg = decoded.value;
    if (!instance) {
      let authCompleted = false;
      let authSecret = '';
      let authScope = 'control';
      let serverProof = '';
      if (msg.type === 'auth-response') {
        const result = authSession.verify(msg.challenge, msg.proof);
        if (!result.ok) {
          log('auth-response 失败 code=' + result.code);
          authSession.fail(result.code);
          if (isRemote) authGuard.fail(peerKey);
          try { conn.sendJson({ type: 'hello-error', code: 'E_AUTH_FAILED', message: 'challenge-response 校验失败' }); } catch { /* 忽略 */ }
          try { conn.close(4003, 'auth failed'); } catch { /* 忽略 */ }
          return;
        }
        msg = result.hello;
        authCompleted = true;
        authSecret = result.secret;
        // 双向证明：daemon 也用同一密钥对挑战签名，扩展据此确认"连的是真 daemon"。
        serverProof = makeServerProof(result.secret, result.challenge);
      }
      if (msg.type !== 'hello') {
        log('忽略握手前的扩展消息');
        return;
      }
      const clientProtocol = msg.protocol;
      if (!protocolSupported(clientProtocol)) {
        log('拒绝不兼容的客户端协议：protocol=' + protocolLabel(clientProtocol));
        if (isRemote) authGuard.fail(peerKey);
        try { conn.sendJson({ type: 'hello-error', code: 'E_PROTOCOL_UNSUPPORTED', message: '扩展协议版本 ' + protocolLabel(clientProtocol) + ' 与 daemon（' + PROTOCOL_VERSION + '）不兼容' }); } catch { /* 忽略 */ }
        try { conn.close(4004, 'protocol unsupported'); } catch { /* 忽略 */ }
        return;
      }
      const authInfo = !authCompleted && typeof msg.authKeyId === 'string' ? findAuthSecret(msg.authKeyId) : null;
      if (authInfo) authScope = authInfo.scope === 'read' ? 'read' : 'control';
      if (msg.authChallenge === true && authInfo && !authCompleted) {
        const localVerified = !isRemote && authInfo.local;
        if (isRemote && !authInfo.remote) {
          if (isRemote) authGuard.fail(peerKey);
          try { conn.sendJson({ type: 'hello-error', code: 'E_PAIR_REQUIRED', message: '远程连接不能使用本机 token' }); } catch { /* 忽略 */ }
          try { conn.close(4003, 'pair required'); } catch { /* 忽略 */ }
          return;
        }
        if (!isRemote && localTrust.strict === true && !localVerified) {
          try { conn.sendJson({ type: 'hello-error', code: 'E_PAIR_REQUIRED', message: '本机严格模式要求配对：bridge daemon pair' }); } catch { /* 忽略 */ }
          try { conn.close(4003, 'local pair required'); } catch { /* 忽略 */ }
          return;
        }
        if (!isRemote && localPairCodeRequired() && !localPairCodeValid(msg)) {
          try { conn.sendJson({ type: 'hello-error', code: 'E_PAIR_REQUIRED', message: '本机配对码不匹配：请核对 bridge daemon pair 显示的 6 位数字' }); } catch (error) { log('发送配对码错误失败：' + (error && error.message)); }
          setTimeout(() => { try { conn.close(4003, 'local pair code required'); } catch { /* 忽略 */ } }, 50);
          return;
        }
        const challenge = crypto.randomBytes(32).toString('hex');
        if (!authSession.begin({ ...msg, pairToken: authInfo.token }, authInfo.token, challenge)) {
          try { conn.sendJson({ type: 'hello-error', code: 'E_AUTH_BUSY', message: '认证握手已在进行中' }); } catch { /* 忽略 */ }
          try { conn.close(4003, 'auth busy'); } catch { /* 忽略 */ }
          return;
        }
        try { conn.sendJson({ type: 'auth-challenge', challenge, alg: 'hmac-sha256' }); } catch { /* 忽略 */ }
        return;
      }
      const localVerified = !isRemote && localPairVerified(msg.pairToken);
      log('hello 本机验证 localVerified=' + localVerified + ' tokenPresent=' + Boolean(msg.pairToken) + ' remote=' + isRemote);
      if (!isRemote && localTrust.strict === true && !localVerified) {
        log('拒绝未配对的本机连接（trust-local off）');
        try { conn.sendJson({ type: 'hello-error', code: 'E_PAIR_REQUIRED', message: '本机严格模式要求配对：bridge daemon pair' }); } catch { /* 忽略 */ }
        try { conn.close(4003, 'local pair required'); } catch { /* 忽略 */ }
        return;
      }
      if (isRemote && !isPairTokenValid(msg.pairToken)) {
        log('拒绝未配对的远程连接：' + remoteAddress);
        authGuard.fail(peerKey);
        try { conn.sendJson({ type: 'hello-error', code: 'E_PAIR_REQUIRED', message: '远程连接需要有效的配对 token（bridge pair redeem <code>）' }); } catch { /* 忽略 */ }
        try { conn.close(4003, 'pair required'); } catch { /* 忽略 */ }
        return;
      }
      if (!isRemote && localPairCodeRequired() && !localPairCodeValid(msg)) {
        try { conn.sendJson({ type: 'hello-error', code: 'E_PAIR_REQUIRED', message: '本机配对码不匹配：请核对 bridge daemon pair 显示的 6 位数字' }); } catch (error) { log('发送配对码错误失败：' + (error && error.message)); }
        setTimeout(() => { try { conn.close(4003, 'local pair code required'); } catch { /* 忽略 */ } }, 50);
        return;
      }
      msg.localVerified = localVerified;
      try {
        instance = registerInstance(conn, msg, { serverProof });
      } catch (error) {
        log('注册浏览器实例失败：' + ((error && error.stack) || error));
        if (isRemote) authGuard.fail(peerKey);
        try { conn.close(1011, 'register failed'); } catch { /* 忽略 */ }
        return;
      }
      clearTimeout(handshakeTimer);
      if (isRemote) authGuard.success(peerKey);
      instance.remote = isRemote;
      if (isRemote) {
        const remoteToken = authCompleted ? authSecret : msg.pairToken;
        const remoteScope = authCompleted ? authScope : scopeForRemoteToken(remoteToken);
        instance.scope = remoteScope;
        if (remoteToken) {
          instance.pairToken = remoteToken;
          try {
            deviceStore.remember(remoteToken, { label: msg.label || msg.instanceLabel || '', browser: instance.browser, instanceId: instance.instanceId, scope: remoteScope });
          } catch (error) {
            log('保存远程设备凭据失败：' + ((error && error.message) || error));
          }
        }
      }
      // localVerified 已在 registerInstance 中写入并用于 hello-ack
      return;
    }
    handleExtensionMessage(instance, msg);
  });
  conn.on('close', () => {
    clearTimeout(handshakeTimer);
    // 只处理当前连接：重连替换时旧连接的 close 不能误删新连接。
    if (instance && instance.conn === conn) dropInstance(instance, '连接关闭', { closeSocket: false });
  });
  conn.on('error', (err) => log(`扩展连接错误：${err && err.message ? err.message : err}`));
}

function heartbeatTick() {
  const now = Date.now();
  for (const instance of [...instances.values()]) {
    if (now - instance.lastPong >= INSTANCE_DEAD_MS) {
      dropInstance(instance, '心跳超时（45s 无 pong）');
      continue;
    }
    try {
      instance.conn.sendJson({ type: 'ping' });
    } catch {
      /* 下一次 tick 或 close 事件会清理 */
    }
  }
}

// ---------------------------------------------------------------------------
// 实例 / 会话选择与命令下发
// ---------------------------------------------------------------------------

function instancePublicView(instance) {
  return {
    instanceId: instance.instanceId,
    browser: instance.browser,
    browserVersion: instance.browserVersion,
    extVersion: instance.extVersion,
    protocol: instance.protocol || 0,
    protocolSkew: instance.protocolSkew || null,
    capabilities: Array.isArray(instance.capabilities) ? instance.capabilities : [],
    label: instance.label || '',
    localAuth: instance.localVerified ? 'verified' : 'unpaired',
    automation: instance.settings || null,
    connectedAt: instance.connectedAt,
  };
}

function browserList() {
  return [...instances.values()]
    .sort((a, b) => a.connectedAt - b.connectedAt)
    .map(instancePublicView);
}

function sessionList() {
  const now = Date.now();
  for (const [sessionId, session] of sessions) {
    if (isSessionExpired(session, { connected: instances.has(session.instanceId), now })) {
      sessions.delete(sessionId);
    }
  }
  return [...sessions.values()]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((session) => sessionPublicView(session, {
      connected: instances.has(session.instanceId),
      phase: sessionState.phase(session.sessionId),
      now,
    }));
}

/** 解析 --browser 参数：instanceId 精确匹配，或 edge/chrome 前缀匹配。 */
function pickInstance(browserSpec) {
  const list = [...instances.values()].sort((a, b) => a.connectedAt - b.connectedAt);
  if (!browserSpec) {
    if (!list.length) {
      throw new BridgeError('E_NO_BROWSER', '没有已连接的浏览器；请在 Edge/Chrome 里加载并启用 browser-bridge 扩展');
    }
    const edge = list.filter((item) => item.browser === 'edge');
    const chrome = list.filter((item) => item.browser === 'chrome');
    const pool = edge.length ? edge : (chrome.length ? chrome : list);
    return pool[pool.length - 1];
  }
  const selected = selectBrowserInstance(list, browserSpec);
  if (selected.error) throw new BridgeError(selected.error, selected.message);
  return selected.instance;
}
function listSessionIds() {
  return [...sessions.keys()].sort().join(', ');
}

/** 解析会话：显式 id → 唯一会话自动选用 → 否则 E_NO_SESSION（PROTOCOL §7）。 */
function resolveSession(sessionId) {
  if (sessionId) {
    const key = String(sessionId);
    const session = sessions.get(key.toLowerCase()) || sessions.get(key);
    if (!session) {
      throw new BridgeError('E_NO_SESSION', `session "${sessionId}" 不存在；可用 session：${listSessionIds() || '(无)'}`);
    }
    return session;
  }
  if (sessions.size === 1) return [...sessions.values()][0];
  if (sessions.size === 0) {
    throw new BridgeError('E_NO_SESSION', '当前没有活动 session；先运行 bridge session start');
  }
  throw new BridgeError('E_NO_SESSION', `存在多个 session，请用 --session 指定：${listSessionIds()}`);
}

function newSessionId() {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let id = '';
    for (let i = 0; i < 4; i += 1) id += letters[crypto.randomInt(0, letters.length)];
    if (!sessions.has(id)) return id;
  }
  throw new BridgeError('E_INTERNAL', '无法生成唯一 sessionId');
}

/** 给扩展发命令，按 id 匹配回包，超时返回 E_TIMEOUT。 */
function sendInstanceEvent(instance, event, params) {
  try {
    if (instance && instance.conn && !instance.conn.closed) instance.conn.sendJson({ type: 'event', event, params });
  } catch {
    // 连接已断
  }
}

function sendCommand(instance, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (instance && instance.remote === true && !remoteScopeAllows(instance.scope, method)) {
      reject(new BridgeError('E_FORBIDDEN', '该远程设备是只读授权，不能执行 ' + method));
      return;
    }
    if (!instance || instance.conn.closed) {
      reject(new BridgeError('E_NO_BROWSER', '浏览器实例已断开'));
      return;
    }
    const base = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
    const hinted = Number(params && params.timeoutMs) > 0 ? Number(params.timeoutMs) : 0;
    const waitMs = Math.max(base, hinted) + CMD_TIMEOUT_GRACE_MS;
    const id = crypto.randomUUID();
    const entry = {
      resolve,
      reject,
      timer: null,
      method,
      id,
      instanceId: instance.instanceId,
      tabId: Number.isInteger(params && params.tabId) ? params.tabId : null,
      startedAt: Date.now(),
    };
    entry.timer = setTimeout(() => {
      if (instance.pending.get(id) === entry) {
        instance.pending.delete(id);
        inflight.delete(id);
        reject(new BridgeError('E_TIMEOUT', `命令 ${method} 超时（${waitMs}ms）`));
      }
    }, waitMs);
    instance.pending.set(id, entry);
    inflight.set(id, entry);
    try {
      instance.conn.sendJson({ type: 'cmd', id, method, params: params || {}, timeoutMs: waitMs });
    } catch (err) {
      clearTimeout(entry.timer);
      instance.pending.delete(id);
      inflight.delete(id);
      reject(new BridgeError('E_INTERNAL', `发送命令失败：${err && err.message ? err.message : err}`));
    }
  });
}

/** 通过 tab.list 找出 tabId 属于哪个浏览器实例（多实例时必需）。 */
async function findInstanceForTab(tabId) {
  const list = [...instances.values()].sort((a, b) => b.connectedAt - a.connectedAt);
  for (const instance of list) {
    try {
      const result = await sendCommand(instance, 'tab.list', { scope: 'all' }, 5000);
      const tabs = result && Array.isArray(result.tabs) ? result.tabs : [];
      if (tabs.some((tab) => tab.tabId === tabId)) return instance;
    } catch (error) {
      log(`查找 tab ${tabId} 时实例 ${instance.instanceId} 查询失败：${error && error.message}`);
    }
  }
  return null;
}

/** 决定命令走哪个实例、注入 tabId、剥离 CLI 侧字段。 */
async function prepareRoute(method, rawParams) {
  const params = { ...(rawParams || {}) };
  const sessionId = params.session !== undefined ? params.session : params.sessionId;
  delete params.session;
  delete params.sessionId;

  if (SESSION_METHODS.has(method)) {
    const session = resolveSession(sessionId);
    const instance = instances.get(session.instanceId);
    if (!instance) throw new BridgeError('E_NO_BROWSER', '会话所属浏览器实例已断开');
    if (params.tabId === undefined || params.tabId === null) params.tabId = session.tabId;
    else if (Number(params.tabId) !== Number(session.tabId)) {
      throw new BridgeError('E_FORBIDDEN', '会话只能操作自己的标签页：请用 session.rebind 改绑，或在目标会话上执行');
    }
    applyAliasParams(params, session);
    return { instance, session, params };
  }

  let session = null;
  let instance;
  if (sessionId !== undefined && sessionId !== null && sessionId !== '') {
    session = resolveSession(sessionId);
    instance = instances.get(session.instanceId);
    if (!instance) throw new BridgeError('E_NO_BROWSER', '会话所属浏览器实例已断开');
  } else if (Number.isInteger(params.tabId)) {
    // 直接对某个 tab 操作（borrow/return/tab.*）：按 tab 归属找实例，找不到再按 browser 选。
    instance = await findInstanceForTab(params.tabId);
    if (!instance) {
      if (params.browser) instance = pickInstance(params.browser);
      else throw new BridgeError('E_NO_TAB', `tabId ${params.tabId} 不属于任何已连接的浏览器`);
    }
  } else {
    instance = pickInstance(params.browser);
  }
  delete params.browser;
  // 每 session 一个 Agent 窗口：tab.new 默认落在本会话自己的窗口里。
  if (session && method === 'tab.new' && params.windowId === undefined) {
    params.windowId = session.windowId;
  }
  applyAliasParams(params, session);
  return { instance, session, params };
}

/** 把 --observation o2 / --baseline o1 / --capture c1 换成真实 id。 */
function applyAliasParams(params, session) {
  if (!session || !params) return;
  const mapping = [['observation', 'observation'], ['baseline', 'observation'], ['capture', 'capture']];
  for (const [key, kind] of mapping) {
    const value = params[key];
    if (typeof value !== 'string' || !/^[oc]\d+$/.test(value)) continue;
    const resolved = aliases.resolve(session.sessionId, kind, value);
    if (resolved) {
      params[key] = resolved;
      log('alias ' + value + ' → ' + resolved + '（' + key + '）');
    }
  }
}

const METHOD_CAPABILITY = {
  'observe-frames': 'frames',
  'debug.rule_add': 'rules',
  'debug.rule_enable': 'rules',
  'debug.rule_disable': 'rules',
  'debug.rule_remove': 'rules',
  'video.start': 'video',
  'record.start': 'recording',
};

function hasCapability(instance, name) {
  const caps = Array.isArray(instance.capabilities) ? instance.capabilities : [];
  if (!caps.length) return true; // 老客户端没声明能力：按支持处理
  return caps.includes(name);
}

function requireCapability(instance, method) {
  const needed = METHOD_CAPABILITY[method];
  if (!needed) return;
  if (hasCapability(instance, needed)) return;
  // observe-frames 可以降级为主文档 observe
  if (method === 'observe-frames' && needed === 'frames') return;
  throw new BridgeError('E_UNSUPPORTED_CAPABILITY', `浏览器实例不支持 ${needed} 能力（method ${method}）`);
}

/** 新参数（unverified/expect/plan 等）在旧扩展上会静默失效：派发前按特性表拦住。 */
function requireFeatures(instance, method, params) {
  const features = featuresForCall(method, params);
  if (!features.length) return;
  const missing = featureShortfall(instance, features, compareProtocol);
  if (!missing.length) return;
  const detail = missing.map((item) => `${item.feature}（需要 ${item.required}，当前 ${item.actual}）`).join('、');
  throw new BridgeError('E_UNSUPPORTED_CAPABILITY', `浏览器扩展协议版本过低，缺少特性：${detail}。${FEATURE_RECOVERY}`, {
    missing,
    method,
    features,
  });
}


async function broadcastSettingsSet(params, timeoutMs) {
  const targets = [...instances.values()].filter((item) => item.conn && item.conn.socket);
  if (!targets.length) throw new BridgeError('E_NO_BROWSER', '没有已连接的浏览器');
  const results = await Promise.allSettled(targets.map((instance) => sendCommand(instance, 'settings.set', params, timeoutMs)));
  if (params && params.patch && typeof params.patch.borrowConfirm === 'boolean') globalBorrowConfirm = params.patch.borrowConfirm === true;
  const ok = results.find((item) => item.status === 'fulfilled');
  if (ok) return ok.value;
  const first = results.find((item) => item.status === 'rejected');
  throw (first && first.reason) || new BridgeError('E_INTERNAL', 'settings.set 全部实例失败');
}

/**
 * 单一决策点：prepareRoute 之后、落账与派发之前，集中判断这条命令能否执行。
 * - 远程实例上的文件传输：daemon 与浏览器不同机，路径不可用，直接拒绝。
 * - 暂停会话：只放行 passive_read / control_plane（isAllowedWhilePaused）。
 * 通过时返回 route，拒绝时抛 BridgeError。
 */
function verifyDecision(route, method) {
  if (shouldRejectRemoteTransfer(route.instance, method)) {
    throw new BridgeError('E_UNSUPPORTED_REMOTE', '远程浏览器连接不支持文件传输（daemon 与浏览器不在同一台机器）；请在浏览器本机运行 CLI');
  }
  if (route.session && route.session.paused === true && !isAllowedWhilePaused(method)) {
    throw new BridgeError('E_SESSION_PAUSED', '会话已暂停：请在接管浮层点“交给 Agent”或执行 bridge session resume 后继续');
  }
  return route;
}

async function routeExtension(route, method, timeoutMs) {
  // route 已在 dispatchInner 里 prepareRoute + verifyDecision 过；这里只做能力降级与派发。
  requireCapability(route.instance, method);
  if (method === 'evaluate' && route.params && route.params.unverified === true) {
    if (route.params.expect !== undefined || route.params.dependsOn !== undefined || route.params.observation !== undefined) {
      throw new BridgeError('E_BAD_ARG', 'evaluate --unverified 不能与 --expect/--depends-on/--observation 同时使用');
    }
    if (!hasCapability(route.instance, 'unverified')) {
      throw new BridgeError('E_UNSUPPORTED_CAPABILITY', '当前浏览器扩展不支持 evaluate --unverified（需要协议 1.9 扩展；请更新并重载扩展）');
    }
  }
  let effectiveMethod = method;
  if (method === 'observe-frames' && !hasCapability(route.instance, 'frames')) {
    effectiveMethod = 'observe';
  }
  let result = route.session && !SESSION_QUEUE_BYPASS.has(method)
    ? await sessionQueue.enqueue(route.session.sessionId, () => sendCommand(route.instance, effectiveMethod, route.params, timeoutMs))
    : await sendCommand(route.instance, effectiveMethod, route.params, timeoutMs);
  if (effectiveMethod !== method && result && typeof result === 'object') {
    result.downgraded = true;
    result.frames = [{ frameId: 0, url: result.url || '', title: result.title || '', refs: result.refs || 0, observation: result.observation || '' }];
    result.text = result.observation || '';
  }
  // 顺手把 URL/标题同步到 session（status/list 才有内容可看）。
  if (route.session && result && typeof result === 'object') {
    if (typeof result.url === 'string' && result.url) route.session.url = result.url;
    if (typeof result.title === 'string' && result.title) route.session.title = result.title;
  }
  // 导航之后文档重建，控制提示条会随旧文档消失：补挂一次（受设置约束，失败忽略）。
  // 不阻塞导航返回：提示条是可见性 UI，晚一两百毫秒出现不影响动作。
  if (route.session && ['navigate', 'reload', 'navigate-back', 'navigate-forward'].includes(method)) {
    sendCommand(route.instance, 'control-hint', { tabId: route.session.tabId, enabled: true }, 3000).catch(() => {});
  }
  // 页面没变时扩展只回 unchanged（不带全文）：用 daemon 缓存补回文本，省一次大传输。
  if (method === 'observe' && route.session && result && result.unchanged === true) {
    const cached = route.session.observation;
    if (cached && typeof cached.text === 'string') {
      result.observation = cached.text;
      result.cachedFrom = cached.at;
    } else {
      // 缓存缺失（daemon 重启/会话重建）：强制重取一次全文。
      result = await sendCommand(route.instance, 'observe', { ...route.params, force: true }, timeoutMs);
    }
  }
  // observe 结果留在 daemon 里，view 可以直接分段检索，不必重新采集页面。
  if (method === 'observe' && route.session && result && typeof result.observation === 'string') {
    route.session.observation = {
      text: result.observation,
      refs: typeof result.refs === 'number' ? result.refs : 0,
      url: typeof result.url === 'string' ? result.url : route.session.url || '',
      title: typeof result.title === 'string' ? result.title : route.session.title || '',
      at: Date.now(),
    };
  }
  // 短别名：观察/截图结果带回 oN / cN，后续可用 --observation o2 / --capture c1 引用。
  if (route.session && result && typeof result === 'object') {
    if (method === 'observe') {
      if (!result.observationId) result.observationId = 'ob_' + crypto.randomBytes(6).toString('hex');
      const alias = aliases.register(route.session.sessionId, 'observation', result.observationId);
      if (alias) result.observationAlias = alias;
    } else if (method === 'screenshot' && result.capture_id) {
      const alias = aliases.register(route.session.sessionId, 'capture', result.capture_id);
      if (alias) result.captureAlias = alias;
    }
  }
  return result;
}

/** audit.list：读最近的操作审计（只读元数据）。 */
function getOperation(id) {
  const wanted = String(id || '');
  if (!wanted) throw new BridgeError('E_BAD_ARG', '需要 operation id');
  const dir = path.join(HOME_DIR, 'audit');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort().reverse();
  } catch {
    files = [];
  }
  for (const name of files) {
    let raw = '';
    try {
      raw = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row.id === wanted) return { entry: row };
      } catch {
        // 跳过坏行
      }
    }
  }
  throw new BridgeError('E_NOT_FOUND', '找不到 operation ' + wanted);
}

function listAudit(params) {
  const limitRaw = Number(params.limit);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 100, 1), 500);
  const since = Number(params.since) > 0 ? Number(params.since) : 0;
  const dir = path.join(HOME_DIR, 'audit');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort();
  } catch {
    files = [];
  }
  const entries = [];
  for (const name of files) {
    let raw = '';
    try {
      raw = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row.ts >= since) entries.push(row);
      } catch {
        // 跳过坏行
      }
    }
  }
  entries.sort((a, b) => b.ts - a.ts);
  return { dir, total: entries.length, entries: entries.slice(0, limit) };
}

/** view：在当前 session 的最近一次 observe 缓存里检索/分页。 */
function viewCache(params) {
  const session = resolveSession(params.session !== undefined ? params.session : params.sessionId);
  const cache = session.observation;
  if (!cache) {
    throw new BridgeError('E_CACHE_EMPTY', '该 session 还没有 observe 缓存；先运行 bridge observe');
  }
  const lines = String(cache.text || '').split('\n');
  const needle = typeof params.grep === 'string' && params.grep ? params.grep.toLowerCase() : '';
  const matched = needle ? lines.filter((line) => line.toLowerCase().includes(needle)) : lines;
  const offset = Math.max(0, Number.isFinite(Number(params.offset)) ? Math.floor(Number(params.offset)) : 0);
  const limitRaw = Number(params.limit);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 200, 1), 2000);
  return {
    lines: matched.slice(offset, offset + limit),
    total: lines.length,
    matched: matched.length,
    offset,
    limit,
    url: cache.url || '',
    title: cache.title || '',
    at: cache.at,
    refs: cache.refs || 0,
  };
}

// ---------------------------------------------------------------------------
// 本地 RPC 方法（PROTOCOL §4）
// ---------------------------------------------------------------------------

function inflightList() {
  return [...inflight.values()].map((entry) => ({
    id: entry.id,
    instanceId: entry.instanceId,
    method: entry.method,
    tabId: entry.tabId,
    startedAt: entry.startedAt,
    elapsedMs: Date.now() - entry.startedAt,
  }));
}

async function cancelInflight(params) {
  const id = String(params && params.id ? params.id : '');
  if (!id) throw new BridgeError('E_BAD_ARG', 'command.cancel 需要命令 id');
  const entry = inflight.get(id);
  if (!entry) throw new BridgeError('E_NOT_FOUND', '没有进行中的命令 ' + id);
  if (entry.method === 'cancel') throw new BridgeError('E_BAD_ARG', '不能取消 cancel 命令');
  const instance = instances.get(entry.instanceId);
  if (!instance) throw new BridgeError('E_NO_BROWSER', '命令所属浏览器已断开');
  const result = await sendCommand(instance, 'cancel', { rpc_id: id }, 3000);
  return { id, forwarded: true, accepted: Boolean(result && result.cancelled === true) };
}

function buildStatus() {
  return {
    service: SERVICE,
    version: VERSION,
    protocol: PROTOCOL_VERSION,
    pid: process.pid,
    port: currentPort,
    uptimeMs: Date.now() - startedAt,
    browsers: browserList(),
    sessions: sessionList(),
    inflight: inflightList(),
    queues: sessionQueue.snapshot(),
    auth: authGuard.snapshot(),
  };
}

/** 可恢复启动的 token 校验（转成协议错误）。 */
function normalizeRequestToken(value) {
  try {
    return normalizeStartToken(String(value));
  } catch (error) {
    throw new BridgeError('E_BAD_ARG', String((error && error.message) || error));
  }
}

function startRequestMeta(params) {
  return {
    browser: params.browser ?? null,
    noFocus: params.noFocus === true,
    incognito: params.incognito === true,
    tab: params.tab ?? null,
  };
}

/** 预登记：不创建任何窗口，只占住 token（prepare 语义）。 */
async function prepareStartRequest(params) {
  const requestId = normalizeRequestToken(params.requestId);
  const existing = startJournal.get(requestId);
  if (existing) {
    if (existing.state === 'cancelled') {
      throw new BridgeError('E_REQUEST_CANCELLED', '该 requestId 已被取消，请重新生成', { requestId, state: existing.state });
    }
    return { requestId, entry: existing };
  }
  return { requestId, entry: startJournal.prepare(requestId, startRequestMeta(params)) };
}

/** 认领：ready/claimed → claimed，表示调用方已经持久化会话。 */
async function claimStartRequest(params) {
  const requestId = normalizeRequestToken(params.requestId);
  const existing = startJournal.get(requestId);
  if (!existing) throw new BridgeError('E_BAD_ARG', 'requestId 不存在；请先 prepare 或 start', { requestId });
  if (existing.state === 'cancelled') {
    throw new BridgeError('E_REQUEST_CANCELLED', '该 requestId 已被取消', { requestId, state: existing.state });
  }
  if (existing.state !== 'ready' && existing.state !== 'claimed') {
    throw new BridgeError('E_START_NOT_READY', '会话尚未 ready，不能认领', { requestId, state: existing.state });
  }
  if (existing.state === 'claimed') return { requestId, entry: existing };
  return { requestId, entry: startJournal.setState(requestId, 'claimed', {}) };
}

/** 取消：prepared/ready/claimed 可直接取消并留下墓碑；starting 进行中拒绝。 */
async function cancelStartRequest(params) {
  const requestId = normalizeRequestToken(params.requestId);
  const existing = startJournal.get(requestId);
  if (existing && existing.state === 'cancelled') return { requestId, entry: existing };
  if (existing && existing.state === 'starting') {
    throw new BridgeError('E_START_PENDING', '启动进行中，暂不能取消；稍后用同一 requestId 查询', {
      requestId,
      startedAt: existing.at || null,
    });
  }
  const sessionId = existing && existing.result ? existing.result.sessionId : null;
  return { requestId, sessionId, entry: startJournal.setState(requestId, 'cancelled', {}) };
}

async function startRequestStatus(params) {
  const requestId = normalizeRequestToken(params.requestId);
  return { requestId, entry: startJournal.get(requestId) };
}

async function startSession(params, timeoutMs) {  const traceStart = Date.now();
  const traceStep = (label) => {
    if (process.env.BB_DAEMON_TRACE === '1') log(`session.start ${label} +${Date.now() - traceStart}ms`);
  };
  const controller = params.controller;
  if (controller !== undefined && !isControllerInfo(controller)) {
    throw new BridgeError('E_BAD_ARG', 'session.start 的 controller 需要 name（1-80 字符），可选 project（1-120 字符）与 #rrggbb 颜色');
  }
  const callerScope = params.scope === undefined || params.scope === null ? '' : String(params.scope).trim().slice(0, 80);
  if (params.scope !== undefined && params.scope !== null && !callerScope) {
    throw new BridgeError('E_BAD_ARG', 'session.start 的 scope 不能为空字符串');
  }
  // 可恢复启动：token 幂等。同一个 requestId 重试返回既有会话；进行中的同一 token 拒绝并给出状态。
  let requestToken = null;
  if (params.requestId !== undefined && params.requestId !== null) {
    try {
      requestToken = normalizeStartToken(String(params.requestId));
    } catch (error) {
      throw new BridgeError('E_BAD_ARG', String((error && error.message) || error));
    }
    const existing = startJournal.get(requestToken);
    if (existing) {
      if (existing.state === 'cancelled') {
        throw new BridgeError('E_REQUEST_CANCELLED', '该 requestId 已被取消，请重新生成', { requestId: requestToken, state: existing.state });
      }
      if ((existing.state === 'ready' || existing.state === 'claimed') && existing.result && sessions.has(existing.result.sessionId)) {
        return { ...existing.result, reused: true };
      }
      if (existing.state === 'starting' && Date.now() - Number(existing.at || 0) < 120000) {
        throw new BridgeError('E_START_PENDING', '同一 requestId 的启动仍在进行中；稍后用同一 requestId 重试即可取回会话', {
          requestId: requestToken,
          startedAt: existing.at || null,
        });
      }
    }
    startJournal.begin(requestToken, { browser: params.browser ?? null, noFocus: params.noFocus === true });
  }
  try {
  let instance;
  let tabId = null;
  let windowId = 0;
  let url = '';
  let title = '';
  let borrowed = false;

  if (params.tab !== undefined && params.tab !== null) {
    const wanted = Number(params.tab);
    if (!Number.isInteger(wanted)) throw new BridgeError('E_BAD_ARG', 'session.start 的 tab 需要整数 tabId');
    instance = await findInstanceForTab(wanted);
    if (!instance) throw new BridgeError('E_NO_TAB', `tabId ${wanted} 不属于任何已连接的浏览器`);
    const borrowParams = { tabId: wanted };
    if (typeof globalBorrowConfirm === 'boolean') borrowParams.borrowConfirm = globalBorrowConfirm;
    const info = await sendCommand(instance, 'tab.borrow', borrowParams, timeoutMs);
    tabId = wanted;
    borrowed = true;
    windowId = info && Number.isInteger(info.windowId) ? info.windowId : 0;
    url = info && typeof info.url === 'string' ? info.url : '';
    title = info && typeof info.title === 'string' ? info.title : '';
  } else {
    instance = pickInstance(params.browser);
    const result = await sendCommand(instance, 'window.newAgent', { noFocus: params.noFocus === true, incognito: params.incognito === true }, timeoutMs);
    traceStep('window.newAgent');
    tabId = result && typeof result.tabId === 'number' ? result.tabId : null;
    if (tabId === null) throw new BridgeError('E_INTERNAL', 'window.ensureAgent 未返回 tabId');
    windowId = result && typeof result.windowId === 'number' ? result.windowId : 0;
    url = result && typeof result.url === 'string' ? result.url : '';
    title = result && typeof result.title === 'string' ? result.title : '';
  }

  const sessionId = newSessionId();
  sessionState.begin(sessionId);
  sessions.set(sessionId, createSessionRecord({
    sessionId,
    instanceId: instance.instanceId,
    tabId,
    windowId,
    url,
    title,
    borrowed,
    incognito: params.incognito === true,
    controller,
    scope: callerScope,
    allowDomains: normalizeDomains(params.allowDomains),
    denyDomains: normalizeDomains(params.denyDomains),
    minIntervalMs: Math.max(0, Math.min(Number(params.minIntervalMs) || 0, 5000)),
  }));
  saveSessions();
  log(`session ${sessionId} 创建 instance=${instance.instanceId} tab=${tabId}${borrowed ? '（借用）' : ''}`);
  // 自动挂载对话框拦截（queue 策略）：动作触发原生弹窗时先回 dialog_pending，由调用方决策。
  // 同一 tab 的命令按队列串行，因此这里不等待 arm 完成也不会让后续动作抢在拦截器之前。
  sendCommand(instance, 'dialog.arm', { tabId, policy: { queue: true } }, 5000)
    .then(() => traceStep('dialog.arm'))
    .catch((error) => {
      log('session ' + sessionId + ' 对话框拦截挂载失败（忽略）：' + ((error && error.message) || error));
    });
  // 接管浮层状态（新 UI 取代旧控制提示条）
  sendInstanceEvent(instance, 'takeover.state', { tabId, sessionId, paused: false, borrowed, controller: controller ?? null, project: controller?.project ?? null });
  try {
    // 控制提示是可见性 UI；不阻塞会话返回，注入失败也不影响控制权。
    sendCommand(instance, 'control-hint', { tabId, enabled: true }, 5000).catch(() => {});
    traceStep('control-hint');
  } catch (error) {
    log('session ' + sessionId + ' 控制提示注入失败（忽略）：' + ((error && error.message) || error));
  }
  sessionState.activate(sessionId);
  traceStep('done');
  const started = { sessionId, tabId, windowId, instanceId: instance.instanceId, borrowed };
  if (requestToken) startJournal.ready(requestToken, started);
  return started;
  } catch (error) {
    if (requestToken) startJournal.fail(requestToken, (error && error.message) || error);
    throw error;
  }
}

/** session.rebind：把会话切到另一个标签页（可顺带归还旧的借用 tab）。 */
async function rebindSession(params, timeoutMs) {
  const session = resolveSession(params.session !== undefined ? params.session : params.sessionId);
  const wanted = Number(params.tab);
  if (!Number.isInteger(wanted)) throw new BridgeError('E_BAD_ARG', 'session.rebind 需要 --tab <tabId>');
  const target = await findInstanceForTab(wanted);
  if (!target) throw new BridgeError('E_NO_TAB', `tabId ${wanted} 不属于任何已连接的浏览器`);

  const previous = instances.get(session.instanceId);
  const oldTabId = session.tabId;

  const info = await sendCommand(target, 'tab.borrow', { tabId: wanted }, timeoutMs);
  if (previous && oldTabId && oldTabId !== wanted) {
    try { await sendCommand(previous, 'dialog.disarm', { tabId: oldTabId }, 3000); } catch { /* 忽略 */ }
    try { await sendCommand(previous, 'control-hint', { tabId: oldTabId, enabled: false }, 3000); } catch { /* 忽略 */ }
    try { await sendCommand(previous, 'debugger.detach', { tabId: oldTabId }, 5000); } catch { /* 忽略 */ }
    if (params.releaseOld === true && session.borrowed === true) {
      try { await sendCommand(previous, 'tab.return', { tabId: oldTabId }, 3000); } catch { /* 忽略 */ }
    }
  }

  rebindSessionRecord(session, {
    instanceId: target.instanceId,
    tabId: wanted,
    windowId: info && Number.isInteger(info.windowId) ? info.windowId : 0,
    url: info && typeof info.url === 'string' ? info.url : '',
    title: info && typeof info.title === 'string' ? info.title : '',
  });
  saveSessions();

  try { await sendCommand(target, 'dialog.arm', { tabId: wanted, policy: { queue: true } }, 5000); } catch (error) {
    log('session ' + session.sessionId + ' 重绑后对话框拦截失败（忽略）：' + ((error && error.message) || error));
  }
  try { await sendCommand(target, 'control-hint', { tabId: wanted, enabled: true }, 5000); } catch { /* 忽略 */ }
  if (previous && oldTabId && oldTabId !== wanted) sendInstanceEvent(previous, 'takeover.hide', { tabId: oldTabId });
  sendInstanceEvent(target, 'takeover.state', { tabId: wanted, sessionId: session.sessionId, paused: session.paused === true, borrowed: true });
  log(`session ${session.sessionId} 重绑到 tab=${wanted} instance=${target.instanceId}`);
  return sessionPublicView(session, {
    connected: instances.has(session.instanceId),
    phase: sessionState.phase(session.sessionId),
  });
}

async function pauseSession(params, timeoutMs) {
  const session = resolveSession(params.session !== undefined ? params.session : params.sessionId);
  const wantPause = params.paused === true;
  // 自动恢复只允许作用于 auto 暂停；手动暂停必须由人确认（E_PAUSED_MANUAL）。
  if (!wantPause && params.auto === true && session.pausedBy !== 'auto') {
    throw new BridgeError('E_PAUSED_MANUAL', '会话是人工暂停的，auto 恢复被拒绝；请显式 resume 或交回控制');
  }
  session.paused = setSessionPaused(session, wantPause);
  session.pausedBy = session.paused ? (params.reason === 'auto' ? 'auto' : 'manual') : null;
  session.pausedAt = session.paused ? Date.now() : null;
  const instance = instances.get(session.instanceId);
  if (instance) sendInstanceEvent(instance, 'takeover.state', { tabId: session.tabId, sessionId: session.sessionId, paused: session.paused, pausedBy: session.pausedBy, borrowed: session.borrowed === true, controller: session.controller ?? null, project: session.controller?.project ?? null });
  log('session ' + session.sessionId + ' paused=' + session.paused + (session.pausedBy ? ' by=' + session.pausedBy : ''));
  return { sessionId: session.sessionId, paused: session.paused, pausedBy: session.pausedBy };
}

async function stopSession(params, timeoutMs) {
  const session = resolveSession(params.session !== undefined ? params.session : params.sessionId);
  aliases.clear(session.sessionId);
  if (sessionState.requestStop(session.sessionId) === false) {
    return { ok: true, alreadyStopping: true, borrowed: session.borrowed === true };
  }
  sessionQueue.drop(session.sessionId);
  const instance = instances.get(session.instanceId);
  const closeTimeout = Math.min(Number(timeoutMs) > 0 ? Number(timeoutMs) : 15_000, 15_000);
  if (instance) {
    // 独立清理动作并行下发，避免 3-4 个 RTT 串行叠加到 session stop 上。
    const cleanup = [
      sendCommand(instance, 'dialog.disarm', { tabId: session.tabId }, 3000).catch(() => {}),
      sendCommand(instance, 'debugger.detach', { tabId: session.tabId }, 5000).catch((error) => {
        log(`session ${session.sessionId} 释放 debugger 失败（忽略）：${error && error.message}`);
      }),
    ];
    // 关闭标签页时控制提示会随页面消失，不必再单独下发；保留窗口/借用标签才需要。
    if (params.keep === true || session.borrowed === true) {
      cleanup.push(sendCommand(instance, 'control-hint', { tabId: session.tabId, enabled: false }, 3000).catch(() => {}));
    }
    // 关闭标签页时清理动作无需等待：标签页马上消失，dialog/debugger 的清理随页面一起结束。
    // 保留窗口或归还借用标签才需要确认清理完成。
    const closingTab = session.borrowed !== true && params.keep !== true;
    if (closingTab) {
      for (const pending of cleanup) pending.catch(() => {});
    } else {
      await Promise.allSettled(cleanup);
    }
    if (session.borrowed === true) {
      // 借用的用户标签页：只清标记，不移动、不关闭。
      try {
        await sendCommand(instance, 'tab.return', { tabId: session.tabId }, Math.min(closeTimeout, 10_000));
      } catch (err) {
        logError(`session ${session.sessionId} 归还 tab 失败：${err.code || ''} ${err.message}`);
      }
    } else if (params.keep !== true) {
      try {
        await sendCommand(instance, 'tab.close', { tabId: session.tabId }, closeTimeout);
      } catch (err) {
        logError(`session ${session.sessionId} 关闭 tab 失败：${err.code || ''} ${err.message}`);
      }
      // 每个 session 独占一个 Agent 窗口：关闭标签页后窗口通常随之消失；这里只做兜底，
      // 不等待结果，避免会话结束被窗口关闭流程拖慢。
      if (Number.isInteger(session.windowId) && session.windowId > 0) {
        sendCommand(instance, 'window.close', { windowId: session.windowId }, Math.min(closeTimeout, 5000)).catch(() => {});
      }
    }
  }
  if (instance) sendInstanceEvent(instance, 'takeover.hide', { tabId: session.tabId });
  releaseTransfersForSession(session.sessionId);
  sessions.delete(session.sessionId);
  sessionState.finish(session.sessionId);
  log(`session ${session.sessionId} 已停止${session.borrowed ? '（归还借用标签页）' : params.keep === true ? '（保留窗口）' : ''}`);
  return { ok: true, borrowed: session.borrowed === true };
}

// ---------------------------------------------------------------------------
// 文件传输 staging（transfer.*）
// 页面/CLI 只拿 opaque transferId；真实路径只在 daemon 内部与 daemon->扩展 出现。
// ---------------------------------------------------------------------------

function safeTransferName(value) {
  const raw = String(value == null ? '' : value).trim();
  const base = path.basename(raw);
  if (!raw || raw !== base || raw === '.' || raw === '..' || /[\\/]/.test(raw)) {
    throw new BridgeError('E_BAD_ARG', 'transfer 需要合法文件名（不能包含路径）');
  }
  if (/[\u0000-\u001f<>:"|?*]/.test(base)) throw new BridgeError('E_BAD_ARG', '文件名包含非法字符');
  return base.slice(0, 200);
}

function requireTransfer(transferId) {
  const entry = transfers.get(String(transferId || ''));
  if (!entry) throw new BridgeError('E_TRANSFER_NOT_FOUND', 'transfer 不存在或已释放');
  return entry;
}

function closeTransferFile(entry) {
  if (entry && entry.fd != null) {
    try { fs.closeSync(entry.fd); } catch { /* 忽略 */ }
    entry.fd = null;
  }
}

function removeTransfer(entry, reason) {
  if (!entry) return false;
  closeTransferFile(entry);
  try { fs.rmSync(path.dirname(entry.filePath), { recursive: true, force: true }); } catch { /* 忽略 */ }
  transfers.delete(entry.id);
  log(`transfer ${entry.id} 释放${reason ? '（' + reason + '）' : ''}`);
  return true;
}

function releaseTransfersForSession(sessionId) {
  for (const entry of [...transfers.values()]) {
    if (entry.sessionId === sessionId) removeTransfer(entry, 'session stop');
  }
}

function transferBegin(params = {}) {
  const session = resolveSession(params.session !== undefined ? params.session : params.sessionId);
  const name = safeTransferName(params.name);
  const byteSize = Number(params.byteSize);
  if (!Number.isInteger(byteSize) || byteSize <= 0 || byteSize > TRANSFER_MAX_BYTES) {
    throw new BridgeError('E_BAD_ARG', `byteSize 必须是 1..${TRANSFER_MAX_BYTES} 的整数`);
  }
  let transferId = '';
  do {
    transferId = 'tr_' + crypto.randomBytes(8).toString('hex');
  } while (transfers.has(transferId));
  const filePath = path.join(TRANSFER_DIR, transferId, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, 'w');
  const entry = { id: transferId, sessionId: session.sessionId, name, byteSize, received: 0, filePath, fd, createdAt: Date.now(), finished: false };
  transfers.set(transferId, entry);
  log(`transfer ${transferId} begin name=${name} bytes=${byteSize} session=${session.sessionId}`);
  return { transferId, chunkSize: TRANSFER_CHUNK_BYTES };
}

function transferChunk(params = {}) {
  const entry = requireTransfer(params.transferId);
  if (entry.finished) throw new BridgeError('E_TRANSFER_STATE', 'transfer 已完成，不能继续写入');
  const offset = Number(params.offset);
  if (!Number.isInteger(offset) || offset !== entry.received) {
    throw new BridgeError('E_TRANSFER_OFFSET', `offset 不连续：期望 ${entry.received}，收到 ${params.offset}`);
  }
  const raw = String(params.dataBase64 == null ? '' : params.dataBase64);
  let buffer;
  try {
    buffer = Buffer.from(raw, 'base64');
  } catch {
    throw new BridgeError('E_BAD_ARG', 'dataBase64 不是合法 base64');
  }
  if (!buffer.length) throw new BridgeError('E_BAD_ARG', 'dataBase64 不能为空');
  if (buffer.length > TRANSFER_CHUNK_BYTES) {
    throw new BridgeError('E_TRANSFER_LIMIT', `单块不能超过 ${TRANSFER_CHUNK_BYTES} 字节`);
  }
  if (entry.received + buffer.length > entry.byteSize) {
    throw new BridgeError('E_TRANSFER_LIMIT', `写入超过声明的 byteSize=${entry.byteSize}`);
  }
  fs.writeSync(entry.fd, buffer, 0, buffer.length, entry.received);
  entry.received += buffer.length;
  return { nextOffset: entry.received, eof: entry.received === entry.byteSize };
}

function transferFinish(params = {}) {
  const entry = requireTransfer(params.transferId);
  if (entry.finished) return { transferId: entry.id, byteSize: entry.received };
  if (entry.received !== entry.byteSize) {
    throw new BridgeError('E_TRANSFER_INCOMPLETE', `已写入 ${entry.received}/${entry.byteSize} 字节，不能 finish`);
  }
  try { fs.fsyncSync(entry.fd); } catch { /* 忽略 */ }
  closeTransferFile(entry);
  entry.finished = true;
  log(`transfer ${entry.id} finish bytes=${entry.received}`);
  return { transferId: entry.id, byteSize: entry.received };
}

function transferRead(params = {}) {
  const entry = requireTransfer(params.transferId);
  const offset = Number(params.offset);
  if (!Number.isInteger(offset) || offset < 0 || offset > entry.byteSize) {
    throw new BridgeError('E_BAD_ARG', `offset 必须在 0..${entry.byteSize}`);
  }
  const wanted = Number(params.maxBytes);
  const maxBytes = Number.isInteger(wanted) && wanted > 0 ? Math.min(wanted, TRANSFER_CHUNK_BYTES) : TRANSFER_CHUNK_BYTES;
  const remaining = entry.byteSize - offset;
  const size = Math.min(maxBytes, remaining);
  const buffer = Buffer.alloc(size);
  if (size > 0) {
    const fd = fs.openSync(entry.filePath, 'r');
    try {
      fs.readSync(fd, buffer, 0, size, offset);
    } finally {
      fs.closeSync(fd);
    }
  }
  return {
    nextOffset: offset + size,
    eof: offset + size >= entry.byteSize,
    dataBase64: buffer.toString('base64'),
  };
}

function transferRelease(params = {}) {
  const id = String(params.transferId || '');
  const entry = transfers.get(id);
  if (!entry) return { released: false };
  removeTransfer(entry, 'release');
  return { released: true };
}

/** upload 前把 transferId 换成 daemon 内部 staging 路径；路径只出现在 daemon->扩展。 */
function injectTransferPaths(params = {}) {
  const files = Array.isArray(params.files) ? params.files : [];
  const paths = Array.isArray(params.paths) ? params.paths.slice() : [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (!file || !file.transferId) continue;
    const entry = requireTransfer(file.transferId);
    if (entry.sessionId !== params.sessionId && entry.sessionId !== params.session) {
      throw new BridgeError('E_TRANSFER_STATE', 'transfer 不属于当前会话');
    }
    if (!entry.finished) throw new BridgeError('E_TRANSFER_INCOMPLETE', 'transfer 尚未 finish');
    file.stagedPath = entry.filePath;
    paths[index] = entry.filePath;
  }
  if (paths.length) params.paths = paths;
  return params;
}

/** 把扩展下载到浏览器的文件导入 daemon staging，CLI 用 transfer.read 流式读取。 */
function stageDownloadResult(result, sessionId) {
  try {
    if (!result || typeof result.filename !== 'string' || !result.filename) return result;
    const stat = fs.statSync(result.filename);
    if (!stat.isFile() || stat.size <= 0 || stat.size > TRANSFER_MAX_BYTES) return result;
    let transferId = '';
    do {
      transferId = 'tr_' + crypto.randomBytes(8).toString('hex');
    } while (transfers.has(transferId));
    const name = safeTransferName(path.basename(result.filename));
    const filePath = path.join(TRANSFER_DIR, transferId, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.copyFileSync(result.filename, filePath);
    transfers.set(transferId, {
      id: transferId, sessionId, name, byteSize: stat.size, received: stat.size,
      filePath, fd: null, createdAt: Date.now(), finished: true, direction: 'download',
    });
    log(`transfer ${transferId} download staged name=${name} bytes=${stat.size}`);
    return { ...result, transferId, transferBytes: stat.size };
  } catch (error) {
    log('下载文件导入 staging 失败（继续用浏览器路径）：' + ((error && error.message) || error));
    return result;
  }
}

/** 变异操作的账本目标：优先 tabId，其次用 session 解析出 tab。 */
function ledgerTarget(params) {
  const sessionId = params && (params.session !== undefined ? params.session : params.sessionId);
  if (sessionId === undefined || sessionId === null || sessionId === '') return { tabId: null, sessionId: null };
  try {
    const session = resolveSession(sessionId);
    return { tabId: session.tabId ?? null, sessionId: session.sessionId };
  } catch {
    return { tabId: null, sessionId: String(sessionId) };
  }
}

/**
 * 账本目标直接取自已解析的 route：sessionId/tabId 不再二次 resolveSession。
 * 直接按 tabId 操作的实例方法没有 session，用命令参数里的 tabId。
 */
function ledgerTargetFromRoute(route) {
  const session = route && route.session ? route.session : null;
  const explicitTabId = route && route.params && Number.isInteger(route.params.tabId) ? route.params.tabId : null;
  const tabId = explicitTabId !== null ? explicitTabId : (session && Number.isInteger(session.tabId) ? session.tabId : null);
  return { tabId, sessionId: session ? session.sessionId : null };
}

/** 需要先 prepareRoute 才能确定账本目标的方法（扩展方法 + 唯一走 routeExtension 的本地方法）。 */
function isExtensionRouted(method) {
  return EXT_METHODS.has(method) || method === 'settings.get';
}

/**
 * 扩展方法统一入口：prepareRoute → verifyDecision → ledgerTargetFromRoute → sendCommand。
 * 账本目标与真正派发的实例/tab 来自同一份 route，避免再解析一次 session。
 */
async function enforceSessionPolicy(route, method, params = route.params) {
  if (!route || !route.session) return;
  let targetUrl = '';
  if ((method === 'navigate' || method === 'tab.new' || method === 'download') && params && params.url) targetUrl = String(params.url);
  if (method === 'step' && params && params.action && typeof params.action === 'object') {
    const inner = params.action;
    const innerMethod = String(inner.method || inner.action || '');
    if (['navigate', 'tab.new', 'download'].includes(innerMethod) && inner.params && inner.params.url) targetUrl = String(inner.params.url);
  }
  if (targetUrl) {
    const decision = domainAllowed(route.session.allowDomains, route.session.denyDomains, targetUrl);
    if (!decision.allowed) throw new BridgeError('E_FORBIDDEN', '会话域名策略拒绝：' + decision.reason + '（' + targetUrl + '）');
  }
  if (isMutating(method) && route.session.minIntervalMs > 0) {
    const now = Date.now();
    const scheduled = Math.max(now, (Number(route.session.lastActionAt) || 0) + route.session.minIntervalMs);
    route.session.lastActionAt = scheduled;
    if (scheduled > now) await sleep(scheduled - now);
  }
}

async function dispatchExtension(method, params, timeoutMs) {
  const route = await prepareRoute(method, params);
  await enforceSessionPolicy(route, method, route.params);
  requireFeatures(route.instance, method, route.params);
  verifyDecision(route, method);
  return submitRouted(route, method, params, timeoutMs);
}

/** 给失败结果补 effect_state：未派发=none，其余无法证明时=unknown（保守语义）。 */
function withEffectState(error, effectState) {
  if (!error || typeof error !== 'object') return error;
  const data = { ...(error.data && typeof error.data === 'object' ? error.data : {}) };
  if (data.effect_state === undefined && data.effectState === undefined) data.effect_state = effectState;
  error.data = data;
  return error;
}

/** 变异操作成功 → committed；业务失败结果（ok:false / failedAt）与只读方法保持原样。 */
function annotateEffectSuccess(result, method) {
  if (!isMutating(method) || !result || typeof result !== 'object' || Array.isArray(result)) return result;
  if (result.ok === false || result.failed === true || result.failedAt !== undefined) return result;
  if (result.effectState === undefined && result.effect_state === undefined) result.effectState = 'committed';
  return result;
}

/** 落账 → routeExtension（内部 sendCommand）→ 按结果结算；intentLedger.begin 每次必调。 */
async function submitRouted(route, method, params, timeoutMs) {
  const intent = intentLedger.begin(method, params, ledgerTargetFromRoute(route));
  try {
    const result = await routeExtension(route, method, timeoutMs);
    intentLedger.finish(intent, 'done');
    return annotateEffectSuccess(result, method);
  } catch (error) {
    // 先判"是否确定未派发"，再结算：否则 E_TIMEOUT 一类会把未派发的操作记成 unknown 并冻结标签页。
    const notDispatched = error && (error.code === 'E_TARGET_MISMATCH' || hasNoEffect(error));
    if (isMutating(method)) withEffectState(error, notDispatched ? 'none' : 'unknown');
    const noEffect = notDispatched === true || (error && (
      error.effectState === 'none' || error.effect_state === 'none'
      || (error.data && (error.data.effect_state === 'none' || error.data.effectState === 'none'))
    ));
    // evaluate 是诊断/读取通道：超时也视为已结算，避免只读命令把标签页冻结。
    const settleUnknown = noEffect !== true && isUnknownOutcome(error) && method !== 'evaluate';
    intentLedger.finish(intent, settleUnknown ? 'unknown' : 'failed');
    throw error;
  }
}

/** 解析 --session-scope：显式 session 优先；否则把 scope 解析成唯一 sessionId。 */
function applySessionScope(params) {
  if (!params || params.sessionScope === undefined) return;
  const scope = params.sessionScope;
  delete params.sessionScope;
  if (params.session !== undefined || params.sessionId !== undefined) return;
  const resolved = resolveSessionByScope([...sessions.values()], scope);
  if (resolved.error) throw new BridgeError(resolved.error, resolved.message);
  params.session = resolved.session.sessionId;
}

async function dispatch(method, params, timeoutMs) {
  if (method === 'ledger.status') return intentLedger.status({ limit: params && params.limit });
  if (method === 'ledger.resolve') {
    if (!params || !params.id) throw new BridgeError('E_BAD_ARG', 'ledger.resolve 需要 id');
    return { entry: intentLedger.resolve(params.id, params.outcome) };
  }
  // 只有本地方法（以及需要自动和解的 cooperate.sync）才在这里解析账本目标；
  // 扩展方法的目标由 prepareRoute 之后的 ledgerTargetFromRoute 给出，避免二次 resolveSession。
  const needsTarget = method === 'cooperate.sync' || (isMutating(method) && !isExtensionRouted(method));
  const target = needsTarget ? ledgerTarget(params) : null;
  // 对齐上游语义：sync 时若为 auto 暂停且人类静默 >=2s、Agent 静默 >=3s，则自动恢复。
  if (method === 'cooperate.sync' && target.sessionId) {
    try {
      const session = resolveSession(target.sessionId);
      const nowMs = Date.now();
      if (session.paused && session.pausedBy === 'auto' && nowMs - (session.lastHumanInputAt || session.pausedAt || 0) >= 2000 && nowMs - (session.lastAgentActivity || 0) >= 3000) {
        session.paused = false;
        session.pausedBy = null;
        session.pausedAt = null;
        const owner = instances.get(session.instanceId);
        if (owner) sendInstanceEvent(owner, 'takeover.state', { tabId: session.tabId, sessionId: session.sessionId, paused: false, pausedBy: null, borrowed: session.borrowed === true, controller: session.controller ?? null, project: session.controller?.project ?? null });
        log('session ' + session.sessionId + ' 空闲自动恢复（sync）');
      }
      session.lastAgentActivity = nowMs;
    } catch { /* 会话不存在时交给下游报错 */ }
  }
  // 走扩展路由的方法在 dispatchExtension 里 prepareRoute 之后再落账（目标取自 route.session）；
  // 其余本地方法在这里落账。两条路径互斥，保证每个变异调用恰好 begin 一次。
  const intent = isMutating(method) && !isExtensionRouted(method)
    ? intentLedger.begin(method, params, target)
    : null;
  try {
    const result = await dispatchInner(method, params, timeoutMs);
    intentLedger.finish(intent, 'done');
    // 同步成功意味着 Agent 已重新确认页面状态：自动和解该 tab 的历史未知意图。
    if (method === 'cooperate.sync' && target && target.tabId != null) intentLedger.reconcile(target.tabId);
    return annotateEffectSuccess(result, method);
  } catch (error) {
    const notDispatched = error && (error.code === 'E_BAD_ARG' || error.code === 'E_TARGET_MISMATCH' || hasNoEffect(error));    if (isMutating(method)) withEffectState(error, notDispatched ? 'none' : 'unknown');
    const noEffect = notDispatched === true || (error && (
      error.effectState === 'none' || error.effect_state === 'none'
      || (error.data && (error.data.effect_state === 'none' || error.data.effectState === 'none'))
    ));
    // evaluate 是诊断/读取通道：超时也视为已结算，避免只读命令把标签页冻结。
    const settleUnknown = noEffect !== true && isUnknownOutcome(error) && method !== 'evaluate';
    intentLedger.finish(intent, settleUnknown ? 'unknown' : 'failed');
    throw error;
  }
}

/** 把步骤异常转成协议错误对象（plan 用；不抛出，交由调用方决定是否停）。 */
function wireStepError(error) {
  if (!error) return { code: 'E_INTERNAL', message: '未知错误' };
  const code = typeof error.code === 'string' && error.code.startsWith('E_') ? error.code : 'E_INTERNAL';
  return { code, message: String(error.message || code), ...(error.data && typeof error.data === 'object' ? { data: error.data } : {}) };
}

/**
 * plan：逐步骤经由正常派发路径执行。
 * 这样每一步都有自己的账本记录与结算（首步失败即停、不重试），
 * 结束后再同步观察一次并带回结果。
 */
async function runPlan(params, timeoutMs) {
  const steps = Array.isArray(params && params.steps) ? params.steps : null;
  if (!steps || !steps.length) throw new BridgeError('E_BAD_ARG', 'plan 需要非空 steps 数组');
  if (steps.length > 50) throw new BridgeError('E_BAD_ARG', 'plan 单次最多 50 步');
  const results = [];
  let failedAt = null;
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index] && typeof steps[index] === 'object' ? steps[index] : {};
    if (step.method === 'plan') throw new BridgeError('E_BAD_ARG', 'plan 不能嵌套 plan');
    const stepParams = step.params && typeof step.params === 'object' ? { ...step.params } : {};
    if (stepParams.tabId == null && params.tabId != null) stepParams.tabId = params.tabId;
    for (const key of ['context', 'observation', 'expect']) {
      if (stepParams[key] == null && params[key] != null) stepParams[key] = params[key];
    }
    if (stepParams.session === undefined && params.session !== undefined) stepParams.session = params.session;
    if (stepParams.sessionId === undefined && params.sessionId !== undefined) stepParams.sessionId = params.sessionId;
    try {
      const result = await dispatchInner(step.method, stepParams, timeoutMs);
      results.push({ index, method: step.method, ok: true, result });
    } catch (error) {
      results.push({ index, method: step.method, ok: false, error: wireStepError(error) });
      if (params.continueOnError !== true) {
        failedAt = index;
        break;
      }
    }
  }
  let observation = null;
  try {
    const base = {};
    if (params.tabId != null) base.tabId = params.tabId;
    if (params.session !== undefined) base.session = params.session;
    if (params.sessionId !== undefined) base.sessionId = params.sessionId;
    const obs = await dispatchExtension('observe', { ...base, force: true, probeHover: false }, timeoutMs);
    if (obs && typeof obs.observation === 'string') {
      observation = { text: obs.observation, refs: obs.refs, url: obs.url };
    }
  } catch {
    // 页面可能已关闭/导航失败：plan 结果仍然有效，不因观察失败覆盖。
  }
  return {
    steps: results,
    completed: results.filter((item) => item.ok).length,
    failedAt,
    ...(observation ? { observation } : {}),
  };
}

async function dispatchInner(method, params, timeoutMs) {
  // plan 的兼容写法（{action,...}）先归一再过 schema。
  if (method === 'plan' && params && Array.isArray(params.steps)) {
    params = { ...params, steps: normalizePlanSteps(params.steps) };
  }
  const schemaErrors = validateMethodParams(method, params);
  if (schemaErrors.length) {
    throw new BridgeError('E_BAD_ARG', `参数校验失败（${method}）：` + schemaErrors.join('；'), { errors: schemaErrors });
  }
  switch (method) {
    case 'status':
      return buildStatus();
    case 'browsers':
      return { browsers: browserList() };
    case 'session.start':
      return startSession(params, timeoutMs);
    case 'session.start_tracked':
      return startSession({ ...params, requestId: params.requestId ?? params.request_id }, timeoutMs);
    case 'session.request_prepare':
      return prepareStartRequest(params);
    case 'session.request_claim':
      return claimStartRequest(params);
    case 'session.request_cancel':
      return cancelStartRequest(params);
    case 'session.request_status':
      return startRequestStatus(params);
    case 'session.stop':
      return stopSession(params, timeoutMs);
    case 'session.list':
      return { sessions: sessionList() };
    case 'session.rebind':
      return rebindSession(params, timeoutMs);
    case 'session.pause':
      return pauseSession(params, timeoutMs);
    case 'session.resume':
      return pauseSession({ ...params, paused: false }, timeoutMs);
    case 'view':
      return viewCache(params);
    case 'audit.list':
      return listAudit(params);
    case 'operations.list':
      return listAudit(params);
    case 'operations.get':
      return getOperation(params.id);
    case 'inflight.list':
      return { commands: inflightList() };
    case 'command.cancel':
      return cancelInflight(params);
    case 'local.pair':
      return localPairCreate(params);
    case 'local.trust':
      return localTrustSet(params);
    case 'pair.create':
      return pairCreate(params);
    case 'pair.list':
      return pairList();
    case 'pair.redeem':
      return pairRedeem(params);
    case 'pair.revoke':
      return pairRevoke(params);
    case 'pair.renew':
      return pairRenew(params);
    case 'pair.rotate':
      return pairRotate();
    case 'settings.get':
      return dispatchExtension('settings.get', params, timeoutMs);
    case 'settings.set':
      return broadcastSettingsSet(params, timeoutMs);
    case 'transfer.begin':
      return transferBegin(params);
    case 'transfer.chunk':
      return transferChunk(params);
    case 'transfer.finish':
      return transferFinish(params);
    case 'transfer.read':
      return transferRead(params);
    case 'transfer.release':
      return transferRelease(params);
    case 'upload': {
      const route = await prepareRoute('upload', params);
      await enforceSessionPolicy(route, 'upload', route.params);
      verifyDecision(route, 'upload');
      const withPaths = injectTransferPaths({ ...route.params, sessionId: route.session ? route.session.sessionId : undefined });
      delete withPaths.sessionId;
      route.params = withPaths;
      return submitRouted(route, 'upload', params, timeoutMs);
    }
    case 'download': {
      const route = await prepareRoute('download', params);
      await enforceSessionPolicy(route, 'download', route.params);
      verifyDecision(route, 'download');
      const result = await submitRouted(route, 'download', params, timeoutMs);
      return stageDownloadResult(result, route.session ? route.session.sessionId : null);
    }
    case 'daemon.stop':
      // 生命周期方法：先回包再优雅退出。
      scheduleShutdown('rpc daemon.stop', 0);
      return { ok: true };
    case 'operation.await': {
      const result = await dispatchExtension('operation.await', params, timeoutMs);
      return enforceOperationLimit(result);
    }
    case 'plan':
      return runPlan(params, timeoutMs);
    default:
      if (EXT_METHODS.has(method)) return dispatchExtension(method, params, timeoutMs);
      throw new BridgeError('E_UNKNOWN_METHOD', `unknown method: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// HTTP 服务
// ---------------------------------------------------------------------------

function healthPayload() {
  return {
    ok: true,
    service: SERVICE,
    protocol: PROTOCOL_VERSION,
    version: VERSION,
    pid: process.pid,
    uptimeMs: Date.now() - startedAt,
    port: currentPort,
    tls: TLS_ENABLED,
    bind: BIND_ADDRESS,
    publicUrl: PUBLIC_URL || null,
    browsers: instances.size,
    sessions: sessions.size,
  };
}

async function handleRpcRequest(req, res) {
  if (!tokenMatches(req.headers['x-bridge-token'])) {
    sendJson(res, 401, { ok: false, error: { code: 'E_AUTH', message: 'invalid token' } });
    return;
  }
  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    sendJson(res, 400, { ok: false, error: { code: 'E_BAD_REQUEST', message: err.message } });
    return;
  }
  let message;
  try {
    message = JSON.parse(raw || '{}');
  } catch {
    sendJson(res, 400, { ok: false, error: { code: 'E_BAD_JSON', message: 'request body is not valid JSON' } });
    return;
  }
  const method = typeof message.method === 'string' ? message.method : '';
  const params = message.params && typeof message.params === 'object' ? message.params : {};
  const timeoutMs = Number(message.timeoutMs) > 0 ? Number(message.timeoutMs) : DEFAULT_TIMEOUT_MS;

  if (!LOCAL_METHODS.has(method) && !EXT_METHODS.has(method)) {
    // 方法不存在按 PROTOCOL §2 返回 404。
    sendJson(res, 404, { ok: false, error: { code: 'E_UNKNOWN_METHOD', message: `unknown method: ${method}` } });
    return;
  }

  const startedAtMs = Date.now();
  try {
    applySessionScope(params);
    const result = await dispatch(method, params, timeoutMs);
    audit(method, params, result, null, Date.now() - startedAtMs);
    sendJson(res, 200, { ok: true, result });
  } catch (err) {
    audit(method, params, null, err, Date.now() - startedAtMs);
    const code = err && err.code ? err.code : 'E_INTERNAL';
    const text = err && err.message ? err.message : String(err);
    if (code !== 'E_TIMEOUT' && code !== 'E_NO_SESSION' && code !== 'E_NO_BROWSER' && code !== 'E_BAD_ARG') {
      logError(`rpc ${method} 失败 ${code}: ${text}`);
    }
    const payload = { code, message: text };
    if (err && err.data !== undefined) payload.data = err.data;
    sendJson(res, 200, { ok: false, error: payload });
  }
}


function previewAuthorized(token) {
  return Boolean(token) && (tokenMatches(token) || isPairTokenValid(token));
}

function sendPng(res, buffer) {
  res.writeHead(200, {
    'content-type': 'image/png',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end(buffer);
}

function previewPageHtml(sessionId, token) {
  const safeSession = JSON.stringify(sessionId);
  const safeToken = JSON.stringify(token);
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>BridgeDeck Remote View</title>'
    + '<style>body{margin:0;background:#111827;color:#e5e7eb;font:14px/1.5 system-ui,sans-serif}header{display:flex;gap:10px;align-items:center;padding:10px 14px;background:#1f2937;position:sticky;top:0}header h1{font-size:14px;margin:0;flex:1}button{height:30px;padding:0 12px;border:0;border-radius:8px;background:#2563eb;color:#fff;cursor:pointer}main{padding:10px}#meta{color:#9ca3af;font-size:12px;margin-bottom:8px;overflow-wrap:anywhere}img{max-width:100%;height:auto;display:block;margin:auto;background:#000;border:1px solid #374151}</style>'
    + '<header><h1>BridgeDeck Remote View</h1><span id="status" style="color:#9ca3af;font-size:12px">…</span><input id="key" placeholder="按键 Enter/Tab" style="height:30px;width:110px;border-radius:8px;border:1px solid #374151;background:#111827;color:#e5e7eb;padding:0 8px"><button id="sendKey">发送按键</button><button id="focus">聚焦标签页</button></header>'
    + '<main><div id="meta"></div><img id="shot" alt="" title="点击画面即远程点击"></main>'
    + '<script type="module">const S=' + safeSession + ',T=' + safeToken + ';'
    + 'const qs=(p)=>"/preview/"+p+"?session="+encodeURIComponent(S)+"&token="+encodeURIComponent(T);'
    + 'const shot=document.getElementById("shot"),status=document.getElementById("status"),meta=document.getElementById("meta"),keyInput=document.getElementById("key");'
    + 'let vw=0,vh=0;'
    + 'async function loadMeta(){try{const r=await fetch(qs("meta"));if(!r.ok)throw new Error("HTTP "+r.status);const j=await r.json();vw=j.width;vh=j.height;meta.textContent=(j.title||S)+" · "+j.url+" · "+vw+"x"+vh;}catch(e){meta.textContent=S;}}'
    + 'async function refresh(){try{const r=await fetch(qs("shot"),{cache:"no-store"});if(!r.ok)throw new Error("HTTP "+r.status);const b=await r.blob();shot.src=URL.createObjectURL(b);status.textContent="已更新 "+new Date().toLocaleTimeString();}catch(e){status.textContent="刷新失败："+e.message}}'
    + 'async function post(p,body){const r=await fetch(qs(p),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});if(!r.ok)throw new Error((await r.text()).slice(0,120));return r.json();}'
    + 'shot.onclick=async(e)=>{try{const r=shot.getBoundingClientRect();const ix=(e.clientX-r.left)/r.width*shot.naturalWidth;const iy=(e.clientY-r.top)/r.height*shot.naturalHeight;const x=vw?ix*vw/shot.naturalWidth:ix;const y=vh?iy*vh/shot.naturalHeight:iy;await post("click",{x,y});status.textContent="已点击 "+Math.round(x)+","+Math.round(y);setTimeout(refresh,250);}catch(err){status.textContent="点击失败："+err.message}};'
    + 'document.getElementById("sendKey").onclick=async()=>{try{await post("key",{key:keyInput.value||"Enter"});status.textContent="已发送按键";setTimeout(refresh,250);}catch(err){status.textContent="按键失败："+err.message}};'
    + 'document.getElementById("focus").onclick=async()=>{try{await post("focus",{});status.textContent="已聚焦";}catch(e){status.textContent="聚焦失败："+e.message}};'
    + 'loadMeta();refresh();setInterval(refresh,2000);setInterval(loadMeta,5000);</script></html>';
}

async function previewBody(req) {
  try {
    const raw = await readBody(req);
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

function previewControlAllowed(instance) {
  return !(instance && instance.remote === true && instance.scope === 'read');
}

async function previewSelectorAt(instance, tabId, x, y) {
  const expression = '(() => { const el = document.elementFromPoint(' + Number(x) + ',' + Number(y) + '); if (!el) return "";'
    + ' const old = el.id; if (old && document.querySelectorAll("#" + CSS.escape(old)).length === 1) return "#" + CSS.escape(old);'
    + ' const id = "__bb_preview_" + Date.now().toString(36); el.id = id; return "#" + id; })()';
  const result = await sendCommand(instance, 'evaluate', { tabId, expression }, 5000);
  return String((result && result.value) || '');
}

async function handlePreviewRequest(req, res, pathname, url) {
  const token = url.searchParams.get('token') || '';
  if (!previewAuthorized(token)) {
    sendJson(res, 401, { ok: false, error: { code: 'E_AUTH', message: 'preview token invalid' } });
    return;
  }
  let session;
  try {
    session = resolveSession(url.searchParams.get('session') || '');
  } catch (error) {
    sendJson(res, 404, { ok: false, error: { code: 'E_NO_SESSION', message: (error && error.message) || 'no session' } });
    return;
  }
  if (pathname === '/preview' || pathname === '/preview/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
    res.end(previewPageHtml(session.sessionId, token));
    return;
  }
  const instance = instances.get(session.instanceId);
  if (!instance) {
    sendJson(res, 503, { ok: false, error: { code: 'E_NO_BROWSER', message: 'browser disconnected' } });
    return;
  }
  if (pathname === '/preview/meta') {
    try {
      const result = await sendCommand(instance, 'evaluate', { tabId: session.tabId, expression: '({ width: window.innerWidth, height: window.innerHeight })' }, 5000);
      const value = (result && result.value) || {};
      sendJson(res, 200, { ok: true, width: Number(value.width) || 0, height: Number(value.height) || 0, url: session.url || '', title: session.title || '' });
    } catch (error) { sendJson(res, 502, { ok: false, error: { code: 'E_PREVIEW_META', message: (error && error.message) || 'meta failed' } }); }
    return;
  }
  if (pathname === '/preview/click' && req.method === 'POST') {
    if (!previewControlAllowed(instance)) { sendJson(res, 403, { ok: false, error: { code: 'E_FORBIDDEN', message: 'read-only device' } }); return; }
    const body = await previewBody(req);
    const x = Number(body.x); const y = Number(body.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 20000 || y > 20000) { sendJson(res, 400, { ok: false, error: { code: 'E_BAD_ARG', message: 'x/y required' } }); return; }
    try {
      const selector = await previewSelectorAt(instance, session.tabId, x, y);
      if (!selector) { sendJson(res, 409, { ok: false, error: { code: 'E_NOT_FOUND', message: 'no element at point' } }); return; }
      const result = await sendCommand(instance, 'click', { tabId: session.tabId, selector, force: true }, 8000);
      sendJson(res, 200, { ok: true, selector, result });
    } catch (error) { sendJson(res, 502, { ok: false, error: { code: 'E_CLICK', message: (error && error.message) || 'click failed' } }); }
    return;
  }
  if (pathname === '/preview/key' && req.method === 'POST') {
    if (!previewControlAllowed(instance)) { sendJson(res, 403, { ok: false, error: { code: 'E_FORBIDDEN', message: 'read-only device' } }); return; }
    const body = await previewBody(req);
    const key = String(body.key || '').slice(0, 32);
    if (!key) { sendJson(res, 400, { ok: false, error: { code: 'E_BAD_ARG', message: 'key required' } }); return; }
    try {
      const result = await sendCommand(instance, 'press', { tabId: session.tabId, key }, 5000);
      sendJson(res, 200, { ok: true, result });
    } catch (error) { sendJson(res, 502, { ok: false, error: { code: 'E_KEY', message: (error && error.message) || 'key failed' } }); }
    return;
  }
  if (pathname === '/preview/shot') {
    try {
      const result = await sendCommand(instance, 'screenshot', { tabId: session.tabId, scope: 'viewport', preview: true }, 10000);
      const dataUrl = String((result && result.dataUrl) || '');
      const comma = dataUrl.indexOf(',');
      if (comma < 0) throw new Error('screenshot returned no dataUrl');
      sendPng(res, Buffer.from(dataUrl.slice(comma + 1), 'base64'));
    } catch (error) {
      sendJson(res, 502, { ok: false, error: { code: 'E_SCREENSHOT', message: (error && error.message) || 'screenshot failed' } });
    }
    return;
  }
  if (pathname === '/preview/focus' && req.method === 'POST') {
    try {
      await sendCommand(instance, 'window.focus', { windowId: session.windowId }, 5000);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 502, { ok: false, error: { code: 'E_FOCUS', message: (error && error.message) || 'focus failed' } });
    }
    return;
  }
  sendJson(res, 404, { ok: false, error: { code: 'E_NOT_FOUND', message: 'preview route not found' } });
}

function handleHttpRequest(req, res) {
  let pathname = '/';
  let requestUrl = null;
  try {
    requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
    pathname = requestUrl.pathname;
  } catch { /* 保持默认 */ }
  if (req.method === 'GET' && pathname === '/health') {
    sendJson(res, 200, healthPayload());
    return;
  }
  if (requestUrl && pathname.startsWith('/preview')) {
    handlePreviewRequest(req, res, pathname, requestUrl).catch((err) => {
      try { sendJson(res, 500, { ok: false, error: { code: 'E_INTERNAL', message: (err && err.message) || 'preview error' } }); } catch { /* 忽略 */ }
    });
    return;
  }
  if (req.method === 'POST' && pathname === '/rpc') {
    handleRpcRequest(req, res).catch((err) => {
      logError(`处理 /rpc 异常：${err && err.stack ? err.stack : err}`);
      try { sendJson(res, 500, { ok: false, error: { code: 'E_INTERNAL', message: 'internal error' } }); } catch { /* 忽略 */ }
    });
    return;
  }
  sendJson(res, 404, { ok: false, error: { code: 'E_NOT_FOUND', message: `no route: ${req.method} ${pathname}` } });
}

function ensureTlsCert() {
  const paths = tlsPaths();
  try {
    if (process.platform !== 'win32') {
      if (fs.existsSync(paths.certPem) && fs.existsSync(paths.keyPem)
        && fs.statSync(paths.certPem).size > 0 && fs.statSync(paths.keyPem).size > 0) return paths;
    } else if (fs.existsSync(paths.cert) && fs.statSync(paths.cert).size > 0) {
      return paths;
    }
  } catch {
    // 继续生成
  }
  fs.mkdirSync(paths.dir, { recursive: true });
  if (process.platform !== 'win32') {
    const result = spawnSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '730',
      '-subj', '/CN=localhost',
      '-keyout', paths.keyPem,
      '-out', paths.certPem,
    ], { encoding: 'utf8', timeout: 30000 });
    let size = 0;
    try { size = fs.statSync(paths.certPem).size; } catch { size = 0; }
    if (!size) {
      throw new Error('生成自签证书失败（需要 openssl）：' + String((result && (result.stderr || result.stdout)) || 'unknown'));
    }
    log('已生成自签 TLS 证书 ' + paths.certPem);
    return paths;
  }
  const script = path.join(path.dirname(SCRIPT_PATH), '..', 'tools', 'make-cert.ps1');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-OutFile', paths.cert], {
    encoding: 'utf8',
    timeout: 30000,
  });
  let size = 0;
  try { size = fs.statSync(paths.cert).size; } catch { size = 0; }
  if (!size) {
    throw new Error('生成自签证书失败：' + String((result && (result.stderr || result.stdout)) || 'unknown'));
  }
  log('已生成自签 TLS 证书 ' + paths.cert);
  return paths;
}

function createHttpServer() {
  let server;
  if (TLS_ENABLED) {
    const paths = TLS_PFX_PATH ? null : ensureTlsCert();
    if (TLS_PFX_PATH) {
      server = https.createServer({ pfx: fs.readFileSync(TLS_PFX_PATH), passphrase: TLS_PASSPHRASE }, handleHttpRequest);
    } else if (process.platform === 'win32') {
      server = https.createServer({ pfx: fs.readFileSync(paths.cert), passphrase: TLS_PASSPHRASE }, handleHttpRequest);
    } else {
      server = https.createServer({ key: fs.readFileSync(paths.keyPem), cert: fs.readFileSync(paths.certPem) }, handleHttpRequest);
    }
  } else {
    server = http.createServer(handleHttpRequest);
  }
  attachWsServer(server, onExtensionConnection);
  return server;
}

// ---------------------------------------------------------------------------
// 生命周期：启动 / 单实例 / 端口 / 停止
// ---------------------------------------------------------------------------

function listenOn(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, BIND_ADDRESS);
  });
}

/** 启动前探测已有 daemon：pid 活着且 /health 通 → 交给它。 */
async function findRunningDaemon() {
  const info = readDaemonJson();
  if (!info) return null;
  let health = await httpGetHealth(info.port, 1000);
  if (!health && isPidAlive(info.pid)) {
    for (let i = 0; i < 10 && !health; i += 1) {
      await sleep(200);
      health = await httpGetHealth(info.port, 600);
    }
  }
  return health;
}

/** 依次尝试候选端口（显式 --port 只试它；否则 BB_PORT → 52900..52909）。 */
async function listenOnCandidatePort(explicitPort) {
  const candidates = [];
  if (explicitPort) {
    candidates.push(explicitPort);
  } else if (process.env.BB_PORT) {
    const envPort = Number(process.env.BB_PORT);
    if (Number.isInteger(envPort) && envPort > 0) candidates.push(envPort);
  }
  for (const port of PORT_CANDIDATES) {
    if (!candidates.includes(port)) candidates.push(port);
  }
  let lastError = null;
  for (const port of candidates) {
    const server = createHttpServer();
    try {
      await listenOn(server, port);
      return { server, port };
    } catch (err) {
      lastError = err;
      try { server.close(); } catch { /* 忽略 */ }
      // 显式 --port 或权限错误时直接报错，不偷偷换端口。
      if (explicitPort || (err && err.code === 'EACCES')) break;
    }
  }
  throw new BridgeError('E_LISTEN', `无法监听 127.0.0.1（已尝试 ${candidates.join(', ')}）：${lastError && lastError.message ? lastError.message : 'unknown'}`);
}

let autoUpdateTimer = null;
let autoUpdateRunning = false;

function extractReleaseArchive(archive, target) {
  let result = spawnSync('tar', ['-xf', archive, '-C', target], { encoding: 'utf8' });
  if (result.status === 0) return;
  if (process.platform !== 'win32') {
    result = spawnSync('unzip', ['-q', '-o', archive, '-d', target], { encoding: 'utf8' });
    if (result.status === 0) return;
  }
  throw new Error('自动应用失败：' + String(result.error?.message || result.stderr || result.stdout || archive));
}

async function checkAutoUpdate() {
  if (autoUpdateRunning) return;
  const statePath = path.join(HOME_DIR, 'update-state.json');
  const state = readUpdateState(statePath);
  const auto = state.auto;
  if (!auto || auto.enabled !== true || !auto.source) return;
  const now = Date.now();
  const last = auto.lastCheckAt ? Date.parse(auto.lastCheckAt) : 0;
  if (auto.intervalMs && now - last < Number(auto.intervalMs)) return;
  autoUpdateRunning = true;
  try {
    const manifest = await fetchManifest(auto.source);
    let signature = null;
    let verifyKey = '';
    if (auto.key) {
      try { verifyKey = fs.readFileSync(auto.key, 'utf8').trim(); } catch { verifyKey = ''; }
    } else if (manifest && manifest.signature && manifest.signature.alg === 'ed25519') {
      verifyKey = RELEASE_PUBLIC_KEY;
    }
    if (verifyKey) {
      try { signature = verifyReleaseSignature(manifest, verifyKey); } catch { signature = false; }
      if (signature === false) throw new Error('发布清单签名无效');
    }
    const latest = typeof manifest.version === 'string' ? manifest.version : null;
    if (latest && !/^[0-9A-Za-z._-]{1,32}$/.test(latest)) throw new Error('清单 version 非法：' + latest);
    const available = Boolean(latest && latest !== VERSION);
    if (available && auto.apply === true && signature !== true) throw new Error('自动应用要求有效的发布签名');
    let downloadedDir = null;
    if (available && auto.download === true && Array.isArray(manifest.artifacts)) {
      downloadedDir = path.join(HOME_DIR, 'update-cache', 'v' + latest);
      fs.mkdirSync(downloadedDir, { recursive: true });
      for (const artifact of manifest.artifacts) {
        if (!artifact || typeof artifact.file !== 'string' || !artifact.sha256) continue;
        const artifactUrl = new URL(artifact.file, auto.source).toString();
        const buffer = await fetchArtifact(artifactUrl);
        const hash = crypto.createHash('sha256').update(buffer).digest('hex');
        if (hash !== String(artifact.sha256).toLowerCase()) throw new Error('artifact sha256 不匹配：' + artifact.name);
        fs.writeFileSync(path.join(downloadedDir, path.basename(artifact.file)), buffer, { mode: 0o600 });
      }
    }
    let appliedAt = null;
    if (available && auto.apply === true && auto.applyTarget && downloadedDir) {
      fs.mkdirSync(auto.applyTarget, { recursive: true });
      for (const file of fs.readdirSync(downloadedDir).filter((name) => /\.(zip|tar\.gz)$/i.test(name))) {
        extractReleaseArchive(path.join(downloadedDir, file), auto.applyTarget);
      }
      appliedAt = new Date().toISOString();
    }
    writeUpdateState(statePath, {
      auto: {
        ...auto,
        lastCheckAt: new Date().toISOString(),
        latest,
        available,
        signature,
        downloadedDir,
        appliedAt,
        error: null,
      },
    });
    if (available) log('自动更新：发现新版本 ' + latest + '（当前 ' + VERSION + '）');
  } catch (error) {
    writeUpdateState(statePath, {
      auto: { ...auto, lastCheckAt: new Date().toISOString(), error: String((error && error.message) || error) },
    });
  } finally {
    autoUpdateRunning = false;
  }
}

function startAutoUpdateCheck() {
  if (autoUpdateTimer) return;
  setTimeout(() => { checkAutoUpdate().catch(() => {}); }, 5000).unref?.();
  autoUpdateTimer = setInterval(() => { checkAutoUpdate().catch(() => {}); }, 10 * 60 * 1000);
  autoUpdateTimer.unref?.();
}

async function startForeground(opts) {
  foreground = true;
  ensureHomeDir();
  log(`daemon 启动 pid=${process.pid} version=${VERSION} home=${HOME_DIR}`);
  const existing = await findRunningDaemon();
  if (existing) {
    log(`已有 daemon 在运行 pid=${existing.pid} port=${existing.port}，本次启动退出`);
    console.log(`daemon 已在运行 (pid ${existing.pid}, port ${existing.port})`);
    return 0;
  }
  // 清理上次崩溃留下的 daemon.json。
  if (readDaemonJson() || fs.existsSync(DAEMON_JSON_PATH)) {
    log('清理残留 daemon.json');
    try { fs.rmSync(DAEMON_JSON_PATH, { force: true }); } catch { /* 忽略 */ }
  }

  const { server, port } = await listenOnCandidatePort(opts.port);
  currentServer = server;
  currentPort = port;
  CURRENT_TOKEN = crypto.randomBytes(16).toString('hex');
  writeDaemonJson({
    pid: process.pid,
    port,
    token: CURRENT_TOKEN,
    version: VERSION,
    startedAt,
  });
  heartbeatTimer = setInterval(heartbeatTick, PING_INTERVAL_MS);
  startAutoUpdateCheck();
  installProcessHandlers();
  log(`listening on http://127.0.0.1:${port}/ （pid ${process.pid}）`);
  if (foreground) console.log(`daemon listening on 127.0.0.1:${port} (pid ${process.pid})`);
  return undefined; // 保持运行
}

function installProcessHandlers() {
  process.on('SIGINT', () => { shutdown('SIGINT', 0); });
  process.on('SIGTERM', () => { shutdown('SIGTERM', 0); });
  process.on('exit', () => {
    try { removeDaemonJsonOwned(); } catch { /* 忽略 */ }
  });
  process.on('uncaughtException', (err) => {
    logError(`uncaughtException: ${err && err.stack ? err.stack : err}`);
    shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (err) => {
    logError(`unhandledRejection: ${err && err.stack ? err.stack : err}`);
  });
}

function scheduleShutdown(reason, code) {
  setTimeout(() => { shutdown(reason, code); }, 120).unref?.();
}

async function shutdown(reason, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`daemon 停止：${reason}`);
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  for (const instance of [...instances.values()]) {
    for (const [, entry] of instance.pending) {
      clearTimeout(entry.timer);
      inflight.delete(entry.id);
      entry.reject(new BridgeError('E_INTERNAL', 'daemon 正在停止'));
    }
    instance.pending.clear();
    try { instance.conn.close(1001, 'daemon shutdown'); } catch { /* 忽略 */ }
  }
  saveSessions();
  instances.clear();
  sessions.clear();
  removeDaemonJsonOwned();
  if (currentServer) {
    try { currentServer.close(); } catch { /* 忽略 */ }
  }
  await sleep(150);
  process.exit(code);
}

/** 后台拉起自身（默认行为）：detached 子进程 + 等健康检查就绪。 */
async function runDetached(opts) {
  const existing = await findRunningDaemon();
  if (existing) {
    console.log(`daemon 已在运行 (pid ${existing.pid}, port ${existing.port})`);
    return 0;
  }
  const args = [SCRIPT_PATH, '--foreground'];
  if (opts.port) args.push('--port', String(opts.port));
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
    cwd: process.cwd(),
  });
  child.unref();
  const deadline = Date.now() + STARTUP_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(150);
    const info = readDaemonJson();
    if (!info) continue;
    const health = await httpGetHealth(info.port, 500);
    if (health) {
      console.log(`daemon 已启动 (pid ${health.pid}, port ${health.port})`);
      return 0;
    }
  }
  console.error(`daemon 启动失败，请查看日志：${LOG_PATH}`);
  return 1;
}

/** --stop：通过内部 RPC daemon.stop 优雅停止已有 daemon，并清理 daemon.json。 */
async function runStop() {
  const info = readDaemonJson();
  if (!info) {
    console.log('daemon 未运行（无 daemon.json）');
    return 0;
  }
  const health = await httpGetHealth(info.port, 1000);
  if (!health) {
    try { fs.rmSync(DAEMON_JSON_PATH, { force: true }); } catch { /* 忽略 */ }
    console.log('daemon 未运行（已清理残留 daemon.json）');
    return 0;
  }
  const pid = health.pid;
  try {
    await httpRpcToSelf(info.port, info.token, 'daemon.stop', {}, 3000);
  } catch (err) {
    logError(`--stop 发送 daemon.stop 失败：${err && err.message ? err.message : err}`);
  }
  let stopped = false;
  const deadline = Date.now() + STOP_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(150);
    const now = await httpGetHealth(info.port, 300);
    if (!now) {
      stopped = true;
      break;
    }
  }
  if (!stopped) {
    console.error(`daemon (pid ${pid}) 未在 ${STOP_WAIT_MS}ms 内退出`);
    return 1;
  }
  try {
    const current = readDaemonJson();
    if (!current || current.pid === pid) fs.rmSync(DAEMON_JSON_PATH, { force: true });
  } catch { /* 忽略 */ }
  console.log(`daemon 已停止 (pid ${pid})`);
  return 0;
}

// ---------------------------------------------------------------------------
// 参数与入口
// ---------------------------------------------------------------------------

function parseServerArgs(argv) {
  const opts = { port: null, foreground: false, stop: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value <= 0 || value > 65535) {
        console.error('--port 需要一个 1-65535 的整数');
        process.exit(2);
      }
      opts.port = value;
      i += 1;
    } else if (arg.startsWith('--port=')) {
      const value = Number(arg.slice('--port='.length));
      if (!Number.isInteger(value) || value <= 0 || value > 65535) {
        console.error('--port 需要一个 1-65535 的整数');
        process.exit(2);
      }
      opts.port = value;
    } else if (arg === '--foreground') {
      opts.foreground = true;
    } else if (arg === '--stop') {
      opts.stop = true;
    } else if (arg === '-h' || arg === '--help') {
      opts.help = true;
    } else {
      console.error(`未知参数：${arg}`);
      process.exit(2);
    }
  }
  return opts;
}

function printUsage() {
  console.log(`BridgeDeck daemon v${VERSION}

用法：
  node daemon/server.mjs [--port <n>] [--foreground]
  node daemon/server.mjs --stop
  node daemon/server.mjs --help

说明：
  默认后台 detached 拉起自身并退出；--foreground 前台运行（CLI 自动拉起用此模式）。
  --port     指定监听端口（默认 BB_PORT，否则 52900..52909 取第一个可用）
  --stop     优雅停止正在运行的 daemon 并清理 daemon.json
  状态目录    ${HOME_DIR}（BB_HOME 可覆盖）
  日志        ${LOG_PATH}（5MB 轮转）`);
}

async function main() {
  const opts = parseServerArgs(process.argv.slice(2));
  if (opts.help) {
    printUsage();
    return 0;
  }
  if (opts.stop) return runStop();
  if (!opts.foreground) return runDetached(opts);
  return startForeground(opts);
}

main()
  .then((code) => {
    if (typeof code === 'number') process.exit(code);
    // 前台模式 promise 已返回 undefined：服务继续运行。
  })
  .catch((err) => {
    logError(`daemon 启动失败：${err && err.stack ? err.stack : err}`);
    console.error(`daemon 启动失败：${err && err.message ? err.message : err}`);
    process.exit(1);
  });
