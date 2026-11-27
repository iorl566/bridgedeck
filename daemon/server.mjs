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
import { createTransferStore } from './transfer.mjs';
import { createAuthCommit } from './auth-commit.js';
import { createAuthResolve } from './auth-resolve.js';
import { createPairingApi } from './pairing-api.js';
import { createLocalTrustApi } from './local-trust.js';
import { createExtensionEventHandler } from './extension-events.js';
import { createPreviewHandler } from './preview.js';
import { createRpcHandler } from './rpc.js';
import { createLocalDispatch } from './local-dispatch.js';
import { recordRunLog } from './run-log-record.js';
import { postProcessRoute } from './route-post.js';
import { runInQueues } from './route-queue.js';
import { createStartRequests } from './start-requests.js';
import { createTabControls } from './tab-controls.js';
import { createControlOps } from './control-ops.js';
import { createReadViews } from './read-views.js';
import { createSessionRebind } from './session-rebind.js';
import { createSessionStop } from './session-stop.js';
import { createTransferOps } from './transfer-ops.js';
import { createSessionViews } from './session-views.js';
import { createSessionAdmin } from './session-admin.js';
import { createSessionStart } from './session-start.js';
import { createLedgerTarget } from './ledger-target.js';
import { createLedgerReport } from './ledger-report.js';
import { createCommandQueue, queueLimitsFromEnv } from './command-queue.js';
import { createDaemonDoctor } from './doctor.js';
import { createStatusViews } from './status-views.js';
import { createSessionQuota, quotaPolicyFromEnv } from './session-quota.js';
import { createBatchSessions } from './batch-sessions.js';
import { createLeaseArbiter } from './lease-arbitration.js';
import { transferPolicyFromEnv } from './transfer-policy.js';
import { createRoutePolicy } from './route-policy.js';
import { createHealthPayload } from './health.js';
import { createInflightOps } from './inflight-ops.js';
// 兼容目标 0.5.0 对齐：通用 cancel / ledger.request（daemon 本地 RPC）+ 调用方 rpc_id 上下文。
import { createGenericOps } from './generic-ops.js';
import { COMPAT_RPC_NAMES } from '../lib/compat-rpc.mjs';
import { currentRpcId } from './request-context.js';
import { createExtensionDispatch } from './extension-dispatch.js';
import { createPlanRunner } from './plan-run.js';
import { createHttpHandler } from './http-handler.js';
import { createAutoUpdate } from './auto-update.js';
import { parseServerArgs } from './cli-args.js';
import { createUsagePrinter } from './cli-args.js';
import { withEffectState, annotateEffectSuccess } from './effect-state.js';
import { createSubmit } from './submit.js';
import { createPairingModule } from './pairing.mjs';
import { isAllowedWhilePaused, shouldRejectRemoteTransfer, compareProtocol } from '../lib/protocol.mjs';
import { validateMethodParams } from '../lib/schemas.mjs';
import { enforceOperationLimit } from '../lib/limits.mjs';
import { createAuthGuard } from '../lib/auth-guard.mjs';
import { createSessionState } from '../lib/session-state.mjs';
import { createSessionQueue } from '../lib/session-queue.mjs';
import { authKeyId } from '../lib/auth-challenge.mjs';
import { createAuthSession } from '../lib/auth-session.mjs';
import { createPairCode, pairCodeMatches } from '../lib/pair-code.mjs';
import { normalizeEndpoint, pairProof, randomNonce } from '../lib/pair-proof.mjs';
import { domainAllowed, normalizeDomains } from '../lib/domain-policy.mjs';
import { decodeTextFrame } from '../lib/transport-frame.mjs';
import { isSessionExpired, sessionPublicView } from '../lib/session-model.mjs';
import { SessionRunLog } from '../lib/run-log.mjs';
import { createSessionRecord, markSessionDisconnected, rebindSessionRecord, setSessionPaused } from '../lib/session-lifecycle.mjs';
import { TabReservations } from '../lib/tab-reservations.mjs';
import { TabControl, CONTROL_MODES } from '../lib/tab-control.mjs';
import { fetchManifest, fetchArtifact } from '../lib/update-source.mjs';
import { readUpdateState, writeUpdateState } from '../lib/update-state.mjs';
import { verifyReleaseSignature } from '../lib/release-sign.mjs';
import { RELEASE_PUBLIC_KEY } from '../lib/release-public-key.mjs';
import { isControllerInfo } from '../extension/src/lib/controller-info.js';
import { IntentLedger, isUnknownOutcome, hasNoEffect } from '../lib/intent-ledger.mjs';
import { createSessionLeases } from '../lib/session-lease.mjs';
import { createSessionRecovery, planPersistedSessionRecovery, recoverLedgerOnStartup } from './session-recovery.js';
import { createLeaseOps } from './lease-ops.js';
import { createCommandBoundary } from './command-boundary.js';
import { createRecoveryReporter } from './recovery-report.js';
import { AliasRegistry } from '../lib/alias-registry.mjs';
import { selectBrowserInstance } from '../lib/browser-selection.mjs';
import { createDeviceStore, deviceIdForToken } from '../lib/device-store.mjs';
import { createStartJournal, normalizeStartToken } from '../lib/start-journal.mjs';
import { LOCAL_METHODS, SESSION_METHODS, EXT_METHODS, SESSION_QUEUE_BYPASS, isMutating, remoteScopeAllows } from '../lib/methods.mjs';
import { resolveSessionByScope } from '../lib/session-scope.mjs';
import {
  LEGACY_CAPABILITY_UNSUPPORTED,
  PROTOCOL_UNSUPPORTED,
  PROTOCOL_UNSUPPORTED_ALIASES,
  assertProtocolCompatible,
  featureMatrix,
} from '../lib/protocol-features.mjs';
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
let LOCAL_TRUST_PATH = '';
let localTrust = { token: '', strict: false, pairedAt: 0, pendingUntil: 0, pendingCode: '', browserId: '', commitTxn: '', commitUntil: 0, rotationToken: '', rotationTxn: '', rotationUntil: 0 };
const authGuard = createAuthGuard({ maxAttempts: 10, windowMs: 60_000, blockMs: 60_000, maxHelloBytes: 64 * 1024 });
const sessionState = createSessionState();
const HANDSHAKE_TIMEOUT_MS = 5000;
const LOCAL_PAIR_TTL_MS = 5 * 60 * 1000;
const humanEventSeen = new Map(); // tabId -> 最近一次人类事件时间（用于限流）

// 方法分类集中在 lib/methods.mjs：LOCAL/SESSION/INSTANCE/EXT、队列旁路与变异判定。
// daemon 只消费分类结果，避免与 CLI/MCP/账本各自维护一份清单。

// 扩展经 WS 可调用的只读方法（弹窗/审计页读取 daemon 状态用）
const WS_CALL_METHODS = new Set(['audit.list', 'status', 'session.list', 'browsers', 'operations.list', 'operations.get']);

const HOME_DIR = resolveHomeDir();
// 预写意图账本：变异操作先落盘；超时/断连后拦截同 tab 重放，直到 ledger resolve。
// WAL 每次 begin 都 append+fsync（BB_LEDGER_FSYNC=0 可在极端慢盘上关闭），启动时
// recover() 把上次进程遗留的 pending → unknown 并留证据；非幂等动作 replayBlocked。
const intentLedger = new IntentLedger({
  dir: HOME_DIR,
  staleMs: Number(process.env.BB_LEDGER_STALE_MS || 15000),
  fsync: process.env.BB_LEDGER_FSYNC !== '0',
});
const ledgerRecovery = recoverLedgerOnStartup(intentLedger, { legacyState: 'unknown', reason: 'daemon-restart' });
// 账本对账快照（daemon 自己的证据层，不是账本本体）：启动时读上次快照做漂移对账，
// 正常停止/显式 snapshot 时原子写入。恢复只产证据，未知意图仍由账本保持 replayBlocked。
const ledgerReport = createLedgerReport({ ledger: intentLedger, dir: HOME_DIR, recovery: ledgerRecovery, log });
const ledgerRestore = ledgerReport.restore();
if (ledgerRestore && ledgerRestore.exists && ledgerRestore.ok === false) {
  log('账本对账快照不可用：' + (ledgerRestore.error || 'invalid') + '（' + (ledgerRestore.message || '') + '）');
} else if (ledgerRestore && ledgerRestore.drift && ledgerRestore.drift.drift) {
  log('账本对账：快照后已结算 ' + ledgerRestore.drift.counts.resolvedSince + ' 条，新增未知 ' + ledgerRestore.drift.counts.becameUnknown + ' 条');
}
LOCAL_TRUST_PATH = path.join(HOME_DIR, 'local-trust.json');
const deviceStore = createDeviceStore(path.join(HOME_DIR, 'devices.json'));
let auditSeq = 0;
const SESSIONS_PATH = path.join(HOME_DIR, 'sessions.json');
const START_JOURNAL_PATH = path.join(HOME_DIR, 'session-starts.json');
// 可恢复启动：请求 token 预写日志；同 token 重试返回既有会话，不重复开窗。
const startJournal = createStartJournal(START_JOURNAL_PATH);
const TRANSFER_DIR = path.join(HOME_DIR, 'transfers');
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

const handleAuthCommit = createAuthCommit({
  deviceStore, getLocalTrust: () => localTrust, saveLocalTrust, commitProofFor, log,
});

const pairing = createPairingModule({
  deviceStore,
  getInstances: () => instances.values(),
  dropInstance,
  log,
  BridgeError,
  wsUrlFor,
  authKeyId,
});

const localTrustApi = createLocalTrustApi({
  getLocalTrust: () => localTrust, saveLocalTrust, createPairCode, wsUrlFor, LOCAL_PAIR_TTL_MS, instances, dropInstance, pairCodeMatches, log, crypto,
});
const pairingApi = createPairingApi({ pairing, BIND_ADDRESS, getLocalTrust: () => localTrust, saveLocalTrust, wsUrlFor, crypto, log });
const authResolve = createAuthResolve({ pairing, deviceStore, getLocalTrust: () => localTrust, authKeyId });

/** sessionId -> { sessionId, instanceId, tabId, windowId, url, title, startedAt } */
const sessions = new Map();
const tabReservations = new TabReservations();
// 共享 tab 的控制权/租约/handoff。只在同一 tab 有多个会话时参与仲裁。
const tabControl = new TabControl();
// 多会话 tab 所有权租约：独占 holder + 共享参与者 + 冲突证据（谁持有/何时/为何）。
// 与 tabControl 分工：tabControl 管“共享 tab 上谁有写控制权”，本租约管“tab 归哪个会话所有”。
const sessionLeases = createSessionLeases({
  defaultTtlMs: Number(process.env.BB_TAB_LEASE_MS || 60_000),
  // 启动中的 session.start 用 'start:<uuid>' 请求令牌占位，不能当成失联会话抢走。
  isSessionAlive: (sessionId) => sessions.has(String(sessionId)) || String(sessionId).startsWith('start:'),
});
// 多会话租约运行时服务（第十批 F）：统一证据环、命令前 touch 续租、过期/崩溃残租回收、
// 会话↔租约对账与所有权报告。默认行为不变：定时器只在显式 startSweeper() 后运行；
// 存活会话的 TTL 到点不会被回收，只提示续租。
const leaseOps = createLeaseOps({
  leases: sessionLeases,
  sessions,
  sessionState,
  log,
  now: () => Date.now(),
  defaultTtlMs: Number(process.env.BB_TAB_LEASE_MS || 60_000),
  sweepIntervalMs: Number(process.env.BB_LEASE_SWEEP_MS || 5_000),
  isAlive: (sessionId) => sessions.has(String(sessionId)) || String(sessionId).startsWith('start:'),
});
// 命令边界矩阵（幂等/超时/取消）：从单一目录派生，默认不改任何命令的默认超时/取消路径，
// 只在 status 增量视图与 command.cancel 回包里附带证据。
const commandBoundary = createCommandBoundary({
  now: () => Date.now(),
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
});
// ---------------------------------------------------------------------------
// 第十一批 G：批处理会话配额 + 跨会话租约裁决（daemon 本地能力）
// ---------------------------------------------------------------------------
// 配额池：全局存活会话上限、单批上限、启动并发；策略来自 BB_SESSION_QUOTA /
// BB_BATCH_QUOTA / BB_BATCH_CONCURRENCY，写错只忽略不阻塞 daemon 启动。
const sessionQuota = createSessionQuota({
  policy: quotaPolicyFromEnv().policy,
  liveSessions: () => sessions.size,
  liveInstances: () => {
    const counts = new Map();
    for (const session of sessions.values()) {
      const key = String(session.instanceId || '');
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  },
  now: () => Date.now(),
  log,
});
// 批处理编排：startSession/stopSession 注入真实生命周期（函数声明提升，调用时已就绪）；
// 带 url 的条目在启动成功后用 dispatch('navigate') 导航（与单条 CLI 走同一条账本/路由链）。
const batchSessions = createBatchSessions({
  quota: sessionQuota,
  startSession: (params, timeoutMs) => startSessionWithLease(params, timeoutMs),
  stopSession: (params, timeoutMs) => stopSessionWithLease(params, timeoutMs),
  navigate: (sessionId, url, timeoutMs) => dispatch('navigate', { session: sessionId, url }, timeoutMs),
  now: () => Date.now(),
  log,
  BridgeError,
});
// 跨会话租约裁决：默认只出计划（dry-run）；apply 仅在显式 lease.arbitrate apply=true 时执行。
// dropControl 只在冲突是 control-without-session 时清理 tabControl 记录，不触碰租约本体。
const leaseArbiter = createLeaseArbiter({
  leaseOps,
  sessions,
  phases: (sessionId) => sessionState.phase(sessionId),
  controls: () => [],
  now: () => Date.now(),
  log,
  dropControl: (tabId) => {
    if (!Number.isInteger(tabId)) return { ok: false, code: 'E_BAD_ARG', message: 'tabId 需要整数' };
    try {
      tabControl.unregister(tabId, null);
      return { ok: true, tabId, dropped: true };
    } catch (error) {
      return { ok: false, code: (error && error.code) || 'E_INTERNAL', message: String((error && error.message) || error) };
    }
  },
});
const inflight = new Map();
// 每个 session 一条串行队列：同一会话的命令按提交顺序执行，避免扩展侧
// ref-store / debugger / 输入状态在并发工具调用下互相踩踏。
// 第九批 B：会话串行仍由 lib/session-queue.mjs 承担，外层 commandQueue 补
// per-session/全局 inflight 上限、tab 轮转公平与排队诊断；enqueue/drop/snapshot/capacity
// 语义与 lib 一致，所以既有注入点（session-stop/extension-events/health）零改动。
const commandQueue = createCommandQueue({ limits: queueLimitsFromEnv(), log });
const sessionQueue = commandQueue;
const tabQueue = commandQueue;
// 队列旁路表见 lib/methods.mjs 的 SESSION_QUEUE_BYPASS。
// 启动恢复聚合：账本 reconcile + 持久化会话分类 + tab 租约重建（挂在 status/health）。
const sessionRecovery = createSessionRecovery({ sessions, sessionState, sessionLeases, ledger: intentLedger, log });
sessionRecovery.recordLedger(ledgerRecovery);
// 崩溃恢复报告器（第十批 F）：把账本 pending/unknown、会话恢复计划、租约对账合成可查询报告；
// 人工 resolve 走"计划→执行"两段式，**绝不自动 resolve**（autoResolved 恒为 0）。
const recoveryReporter = createRecoveryReporter({
  ledger: intentLedger,
  recovery: sessionRecovery,
  recoverySnapshot: () => sessionRecovery.snapshot(),
  leaseOps,
  sessions,
  log,
});
loadSessions();
// 启动租约对账：只产证据（不自动抢 holder、不自动回收）；恢复报告同理只读。
try {
  const leaseReconcile = leaseOps.reconcile({ apply: false });
  sessionRecovery.recordLeaseReconcile(leaseReconcile);
  sessionRecovery.recordRecoveryReport(recoveryReporter.report());
} catch (error) {
  log('启动租约对账/恢复报告失败（忽略）：' + ((error && error.message) || error));
}
// 定期回收"持有者已失联"的残租（崩溃遗留）。unref 不影响 daemon 退出；
// 存活会话的到期租约不会被回收，只会被下一次命令派发前的 touch 续租。
try { leaseOps.startSweeper(); } catch (error) {
  log('租约自动回收定时器启动失败（忽略）：' + ((error && error.message) || error));
}
loadLocalTrust();
// 上次进程的 staging 文件在崩溃后不可继续使用：启动时清空，避免目录膨胀。
try {
  fs.rmSync(TRANSFER_DIR, { recursive: true, force: true });
} catch { /* 忽略 */ }
try {
  fs.mkdirSync(TRANSFER_DIR, { recursive: true });
} catch { /* 忽略 */ }

let sessionsSaveTimer = null;

function persistSessionsNow() {
  try {
    const list = [...sessions.values()].map((session) => ({ ...session, observation: null }));
    const temp = SESSIONS_PATH + '.tmp';
    // 会话文件只用于重启恢复：compact JSON 足够，且比 pretty 少约 1/3 写入量。
    fs.writeFileSync(temp, JSON.stringify({ version: 1, sessions: list }), 'utf8');
    fs.renameSync(temp, SESSIONS_PATH);
  } catch (error) {
    log('持久化会话失败：' + ((error && error.message) || error));
  }
}

/**
 * 持久化会话列表。
 * 默认 80ms 合并写入（同一批控制权/暂停变化只落一次盘）；会话 start/stop 与 daemon 停止用 immediate。
 */
function saveSessions({ immediate = false } = {}) {
  if (immediate) {
    if (sessionsSaveTimer) {
      clearTimeout(sessionsSaveTimer);
      sessionsSaveTimer = null;
    }
    persistSessionsNow();
    return;
  }
  if (sessionsSaveTimer) return;
  sessionsSaveTimer = setTimeout(() => {
    sessionsSaveTimer = null;
    persistSessionsNow();
  }, 80);
  if (sessionsSaveTimer.unref) sessionsSaveTimer.unref();
}

/** daemon 停止前调用：把挂起的会话写入立即落盘。 */
function flushSessions() {
  saveSessions({ immediate: true });
}

function loadSessions() {
  try {
    const data = JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8'));
    const plan = planPersistedSessionRecovery(data.sessions, { now: Date.now() });
    sessionRecovery.recordSessionPlan(plan);
    for (const item of plan.restore) {
      sessions.set(item.sessionId, { ...item.record, observation: null, restored: true, runLog: new SessionRunLog() });
    }
    // 状态机按 recovering 恢复；租约按 startedAt 最老者为 holder、其余共享 join。
    sessionRecovery.applySessionPlan(plan);
    if (plan.restore.length) log('已恢复 ' + plan.restore.length + ' 个持久化会话');
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



function loadLocalTrust() {
  try {
    const raw = JSON.parse(fs.readFileSync(LOCAL_TRUST_PATH, 'utf8'));
    localTrust = {
      token: typeof raw.token === 'string' ? raw.token : '',
      strict: raw.strict === true,
      pairedAt: Number(raw.pairedAt) || 0,
      pendingUntil: Number(raw.pendingUntil) || 0,
      pendingCode: typeof raw.pendingCode === 'string' ? raw.pendingCode : '',
      browserId: typeof raw.browserId === 'string' ? raw.browserId.slice(0, 64) : '',
      commitTxn: typeof raw.commitTxn === 'string' ? raw.commitTxn : '',
      commitUntil: Number(raw.commitUntil) || 0,
      rotationToken: typeof raw.rotationToken === 'string' ? raw.rotationToken : '',
      rotationTxn: typeof raw.rotationTxn === 'string' ? raw.rotationTxn : '',
      rotationUntil: Number(raw.rotationUntil) || 0,
    };
  } catch {
    localTrust = { token: '', strict: false, pairedAt: 0, pendingUntil: 0, pendingCode: '', browserId: '', commitTxn: '', commitUntil: 0, rotationToken: '', rotationTxn: '', rotationUntil: 0 };
  }
}
function saveLocalTrust() {
  try { fs.writeFileSync(LOCAL_TRUST_PATH, JSON.stringify(localTrust, null, 2), 'utf8'); } catch { /* 忽略 */ }
}




/** auth-commit：扩展用设备 token 对 commitTxn 签名，确认分阶段激活（pending → active）。 */


function newInstanceId() {
  return crypto.randomBytes(4).toString('hex');
}

/** 设备 token 已绑定 browser_id：换浏览器复用 token 时直接拒绝。 */
function rejectBrowserBinding(conn, message) {
  try { conn.sendJson({ type: 'hello-error', code: 'E_PAIR_REJECTED', message }); } catch { /* 忽略 */ }
  try { conn.close(4003, 'pair browser mismatch'); } catch { /* 忽略 */ }
}

/** 分阶段激活的 commit 证明：扩展用（新）设备 token 对 txn 签名，daemon 验证后 pending→active。 */
function commitProofFor(token, txn) {
  return crypto.createHmac('sha256', String(token || '')).update('bridgedeck-commit-v1\n' + String(txn || '')).digest('hex');
}

function newCommitTxn() {
  return crypto.randomBytes(8).toString('hex');
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
    browserId: typeof hello.browserId === 'string' ? hello.browserId.slice(0, 64) : '',
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
    ...(extra.deviceToken ? { deviceToken: extra.deviceToken } : {}),
    ...(extra.commit ? { deviceStatus: 'pending', commitTxn: extra.commit.txn, commitProof: extra.commit.proof } : {}),
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

const handleExtensionEvent = createExtensionEventHandler({
  normalizeSettings, log, humanEventSeen, sessions, sendInstanceEvent, stopSession: (...args) => sessionStop.stopSession(...args), aliases, releaseTransfersForSession: (...args) => transferOps.releaseTransfersForSession(...args), sessionState, sessionQueue, tabQueue, saveSessions, sessionLeases,
});

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
      const authInfo = !authCompleted && typeof msg.authKeyId === 'string' ? authResolve.findAuthSecret(msg.authKeyId) : null;
      const claimedBrowserId = typeof msg.browserId === 'string' ? msg.browserId.slice(0, 64) : '';
      if (authInfo && authInfo.browserId && claimedBrowserId !== authInfo.browserId) {
        if (isRemote) authGuard.fail(peerKey);
        log('拒绝 browser_id 不匹配的配对 token（期望 ' + authInfo.browserId + '，实际 ' + (claimedBrowserId || '空') + '）');
        rejectBrowserBinding(conn, '配对 token 已绑定到另一个浏览器，请重新配对');
        return;
      }
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
        if (!isRemote && localTrustApi.localPairCodeRequired() && !localTrustApi.localPairCodeValid(msg)) {
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
      const localVerified = !isRemote && localTrustApi.localPairVerified(msg.pairToken);
      if (localVerified && localTrust.browserId && claimedBrowserId !== localTrust.browserId) {
        log('拒绝 browser_id 不匹配的本机配对 token（期望 ' + localTrust.browserId + '，实际 ' + (claimedBrowserId || '空') + '）');
        rejectBrowserBinding(conn, '本机配对 token 已绑定到另一个浏览器，请重新配对');
        return;
      }
      log('hello 本机验证 localVerified=' + localVerified + ' tokenPresent=' + Boolean(msg.pairToken) + ' remote=' + isRemote);
      if (!isRemote && localTrust.strict === true && !localVerified) {
        log('拒绝未配对的本机连接（trust-local off）');
        try { conn.sendJson({ type: 'hello-error', code: 'E_PAIR_REQUIRED', message: '本机严格模式要求配对：bridge daemon pair' }); } catch { /* 忽略 */ }
        try { conn.close(4003, 'local pair required'); } catch { /* 忽略 */ }
        return;
      }
      if (isRemote && !authResolve.isPairTokenValid(msg.pairToken)) {
        log('拒绝未配对的远程连接：' + remoteAddress);
        authGuard.fail(peerKey);
        try { conn.sendJson({ type: 'hello-error', code: 'E_PAIR_REQUIRED', message: '远程连接需要有效的配对 token（bridge pair redeem <code>）' }); } catch { /* 忽略 */ }
        try { conn.close(4003, 'pair required'); } catch { /* 忽略 */ }
        return;
      }
      if (isRemote && msg.pairToken) {
        const knownDevice = deviceStore.recordForToken(msg.pairToken);
        if (knownDevice && knownDevice.browserId && claimedBrowserId !== knownDevice.browserId) {
          authGuard.fail(peerKey);
          log('拒绝 browser_id 不匹配的远程设备 token（期望 ' + knownDevice.browserId + '，实际 ' + (claimedBrowserId || '空') + '）');
          rejectBrowserBinding(conn, '设备 token 已绑定到另一个浏览器，请重新配对');
          return;
        }
      }
      if (!isRemote && localTrustApi.localPairCodeRequired() && !localTrustApi.localPairCodeValid(msg)) {
        try { conn.sendJson({ type: 'hello-error', code: 'E_PAIR_REQUIRED', message: '本机配对码不匹配：请核对 bridge daemon pair 显示的 6 位数字' }); } catch (error) { log('发送配对码错误失败：' + (error && error.message)); }
        setTimeout(() => { try { conn.close(4003, 'local pair code required'); } catch { /* 忽略 */ } }, 50);
        return;
      }
      // 配对激活：配对码/链接只用于首次激活；激活后旧 token 立即作废，换发独立设备 token。
      // 分阶段：设备先进入 pending，扩展用新 token 对 commitTxn 签名确认后才 active；
      // 断线未 commit 时，带 pending 设备 token 重连会重新拿到 commitTxn（断点恢复）。
      const activationToken = authCompleted ? authSecret : msg.pairToken;
      let deviceToken = '';
      let commitInfo = null;
      const commitTxn = newCommitTxn();
      const commitUntil = Date.now() + 10 * 60 * 1000;
      if (isRemote && activationToken) {
        const pairingEntry = pairing.findByToken(activationToken);
        if (pairingEntry) {
          deviceStore.remember(pairingEntry.token, {
            label: typeof msg.label === 'string' ? msg.label : '',
            browser: typeof msg.browser === 'string' ? msg.browser : '',
            browserId: claimedBrowserId,
            instanceId: typeof msg.instanceId === 'string' ? msg.instanceId : '',
            scope: pairingEntry.scope,
          });
          const rotated = deviceStore.rotate(deviceIdForToken(pairingEntry.token), { scope: pairingEntry.scope });
          if (rotated) {
            deviceToken = rotated.token;
            pairing.consume(pairingEntry.code);
            deviceStore.beginActivation(deviceToken, { browserId: claimedBrowserId, commitTxn, pendingUntil: commitUntil });
            commitInfo = { txn: commitTxn, proof: commitProofFor(deviceToken, commitTxn) };
            log('配对激活：code=' + pairingEntry.code + ' 已作废，设备换发新 token device=' + rotated.deviceId + '（pending）');
          }
        } else if (activationToken) {
          const record = deviceStore.recordForToken(activationToken);
          if (record && record.status === 'pending' && record.commitTxn) {
            commitInfo = { txn: record.commitTxn, proof: commitProofFor(activationToken, record.commitTxn) };
            log('配对断点恢复：device=' + record.deviceId + ' 重新下发 commitTxn');
          } else if (record && record.rotationToken === activationToken && record.rotationTxn) {
            commitInfo = { txn: record.rotationTxn, proof: commitProofFor(activationToken, record.rotationTxn) };
            log('rotation 激活：device=' + record.deviceId + ' 下发 commitTxn');
          }
        }
      } else if (!isRemote && activationToken && localTrustApi.localPairVerified(activationToken)
        && (localTrust.pendingUntil > 0 || Boolean(localTrust.pendingCode))) {
        // 本机首次激活：旧链接（含 #token）作废，换发独立 token；扩展用 hello-ack.deviceToken 持久化。
        localTrust.token = crypto.randomBytes(24).toString('hex');
        localTrust.pairedAt = Date.now();
        localTrust.pendingUntil = 0;
        localTrust.pendingCode = '';
        localTrust.browserId = typeof msg.browserId === 'string' ? msg.browserId.slice(0, 64) : '';
        localTrust.commitTxn = commitTxn;
        localTrust.commitUntil = commitUntil;
        saveLocalTrust();
        deviceToken = localTrust.token;
        commitInfo = { txn: commitTxn, proof: commitProofFor(deviceToken, commitTxn) };
        log('本机配对激活：旧链接已作废，换发设备 token（pending）');
      } else if (!isRemote && activationToken && localTrustApi.localPairVerified(activationToken) && localTrust.commitTxn) {
        commitInfo = { txn: localTrust.commitTxn, proof: commitProofFor(activationToken, localTrust.commitTxn) };
        log('本机配对断点恢复：重新下发 commitTxn');
      } else if (!isRemote && activationToken && activationToken === localTrust.rotationToken && localTrust.rotationTxn) {
        // 本机 rotation：新 token 先 pending，commit 后才替换旧 token。
        deviceToken = activationToken;
        commitInfo = { txn: localTrust.rotationTxn, proof: commitProofFor(activationToken, localTrust.rotationTxn) };
        log('本机 rotation：下发 commitTxn');
      }
      msg.localVerified = localVerified;
      try {
        instance = registerInstance(conn, msg, { serverProof, deviceToken, commit: commitInfo });
      } catch (error) {
        log('注册浏览器实例失败：' + ((error && error.stack) || error));
        if (isRemote) authGuard.fail(peerKey);
        try { conn.close(1011, 'register failed'); } catch { /* 忽略 */ }
        return;
      }
      clearTimeout(handshakeTimer);
      if (isRemote) authGuard.success(peerKey);
      instance.remote = isRemote;
      // 本机激活换发 token 后，instance 也必须用新 token（commit 证明用 instance.pairToken 校验）。
      if (deviceToken) instance.pairToken = deviceToken;
      if (isRemote) {
        let remoteToken = authCompleted ? authSecret : msg.pairToken;
        if (deviceToken) remoteToken = deviceToken;
        const remoteScope = authCompleted ? authScope : authResolve.scopeForRemoteToken(remoteToken);
        instance.scope = remoteScope;
        if (remoteToken) {
          instance.pairToken = remoteToken;
          if (deviceToken) {
            try {
              deviceStore.touch(deviceToken, { instanceId: instance.instanceId, label: msg.label || msg.instanceLabel || '', browserId: claimedBrowserId });
            } catch (error) {
              log('更新远程设备信息失败：' + ((error && error.message) || error));
            }
          } else {
            try {
              // 只更新已存在的设备记录：绝不能用 hello 里任意 token 新建设备（否则轮换后的旧 token 会被复活）。
              deviceStore.touch(remoteToken, { label: msg.label || msg.instanceLabel || '', browser: instance.browser, instanceId: instance.instanceId, scope: remoteScope, browserId: claimedBrowserId });
            } catch (error) {
              log('更新远程设备凭据失败：' + ((error && error.message) || error));
            }
          }
        }
      }
      // localVerified 已在 registerInstance 中写入并用于 hello-ack
      return;
    }
    if (msg.type === 'auth-commit') {
      handleAuthCommit(instance, conn, msg);
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
  // 人工事件限流表按 tabId 记录：长时间未更新的条目清掉，避免反复开关 tab 造成无界增长。
  for (const [tabId, at] of humanEventSeen) {
    if (now - at > 10 * 60 * 1000) humanEventSeen.delete(tabId);
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

/** 解析 --browser 参数：instanceId 精确匹配，或 edge/chrome 前缀匹配。 */
function pickInstance(browserSpec) {
  const list = [...instances.values()].sort((a, b) => a.connectedAt - b.connectedAt);
  if (!browserSpec) {
    if (!list.length) {
      throw new BridgeError('E_NO_BROWSER', '没有已连接的浏览器；请在 Edge/Chrome/Brave/Arc/Vivaldi/Opera/Helium 里加载并启用 browser-bridge 扩展');
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
      // 调用方 rpc_id（来自 daemon/rpc.js 的 request-context）：通用 cancel { rpc_id }
      // 靠它把“调用方视角的 id”解析到这条 daemon→扩展 命令。属于 daemon 内部字段，
      // 不进 inflight.list / status 的默认载荷。
      rpcId: currentRpcId(),
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

/**
 * 新参数/新能力（unverified、expect、plan、read、video、capture.stream、debug.journal、har）
 * 在旧扩展上会静默失效：派发前按特性表硬拒绝。
 *
 * 语义（W4 起收敛到单一实现 lib/protocol-features.mjs）：
 * - 主错误码 E_PROTOCOL_UNSUPPORTED，data 固定带 method/feature/required/actual/missing；
 * - 兼容别名在 **daemon 这一层**兜底映射：data.legacyCode=E_UNSUPPORTED_CAPABILITY、
 *   data.aliasCodes=[新码, 旧码]（即使 lib gate data 将来不带这两个字段，旧调用方仍能识别；
 *   TS 包 packages/protocol 的类型契约不需要 daemon 改它）；
 * - “能力位缺失”（hello caps 不含 frames/video/...）仍由 requireCapability 报旧码，未改；
 * - 没有特性门的方法（click/navigate/observe/tab.list…）原样放行，1.8 客户端照常可用。
 */
function requireFeatures(instance, method, params) {
  try {
    assertProtocolCompatible(instance, method, params, compareProtocol);
  } catch (error) {
    // 只翻译特性门拒绝；其它异常（例如 assert 内部 bug）原样抛出，避免把真 bug 伪装成协议错误。
    if (!error || error.code !== PROTOCOL_UNSUPPORTED) throw error;
    const base = error.data && typeof error.data === 'object' ? error.data : {};
    const data = {
      ...base,
      legacyCode: base.legacyCode || LEGACY_CAPABILITY_UNSUPPORTED,
      aliasCodes: Array.isArray(base.aliasCodes) && base.aliasCodes.length ? base.aliasCodes : PROTOCOL_UNSUPPORTED_ALIASES,
    };
    log(`协议门禁拒绝 ${method}：feature=${data.feature} required=${data.required} actual=${data.actual}`);
    throw new BridgeError(error.code, error.message, data);
  }
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

/**
 * 共享 tab 控制权闸门（在 tab 队列内执行，保证同一 tab 上的判定与派发串行）。
 * - 只读方法：永远放行（不续租）。
 * - exclusive 模式下非持有者的变更动作：E_CONTROL_NOT_HELD。
 * - open 模式：放行，只把“当前写者”记进租约（单会话 tab 同样续租，
 *   这样后来者 --share 时主会话的控制权是新鲜的）。
 */
function enforceTabControl(route, method) {
  if (!route || !route.session) return null;
  const session = route.session;
  const control = tabControls.syncTabControl(session.tabId);
  if (!control) return null;
  const decision = tabControl.check(session.tabId, session.sessionId, { mutating: isMutating(method), method });
  if (!decision.ok) throw new BridgeError(decision.code, decision.message, decision.data);
  return decision.control;
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
  const run = () => {
    // 命令派发前复核 tab 所有权租期：剩余不足一半时原地续租（不换代、不改 payload）。
    // 失败（共享参与者/已释放）只留内部证据，绝不阻塞既有派发路径。
    if (route.session) {
      try { leaseOps.touch(route.session.tabId, route.session.sessionId, { reason: 'command' }); } catch { /* 证据失败不影响命令 */ }
    }
    const control = enforceTabControl(route, method);
    return sendCommand(route.instance, effectiveMethod, route.params, timeoutMs).then((value) => {
      if (control && route.session) {
        route.session.control = {
          epoch: control.epoch,
          holder: control.holder,
          mode: control.mode,
          leaseRemainingMs: control.leaseRemainingMs,
          shared: control.shared,
        };
      }
      return value;
    });
  };
  let result = await runInQueues({ route, method, run, sessionQueue, tabQueue, bypass: SESSION_QUEUE_BYPASS, commandQueue });
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
  recordRunLog(route, method, result);
  // 导航之后文档重建，控制提示条会随旧文档消失：补挂一次（受设置约束，失败忽略）。
  result = await postProcessRoute({ route, method, result, timeoutMs, sendCommand, aliases, crypto });
  return result;
}

/** audit.list：读最近的操作审计（只读元数据）。 */
// ---------------------------------------------------------------------------
// 本地 RPC 方法（PROTOCOL §4）
// ---------------------------------------------------------------------------

/** 可恢复启动的 token 校验（转成协议错误）。 */




const tabControls = createTabControls({ sessions, tabReservations, tabControl, sessionState, CONTROL_MODES, BridgeError, saveSessions, lease: sessionLeases });

/**
 * 扩展方法统一入口：prepareRoute → verifyDecision → ledgerTargetFromRoute → sendCommand。
 * 账本目标与真正派发的实例/tab 来自同一份 route，避免再解析一次 session。
 */
/** 给失败结果补 effect_state：未派发=none，其余无法证明时=unknown（保守语义）。 */


/** 落账 → routeExtension（内部 sendCommand）→ 按结果结算；intentLedger.begin 每次必调。 */


const inflightOps = createInflightOps({ inflight, instances, sendCommand, BridgeError, boundary: commandBoundary });

const health = createHealthPayload({ SERVICE, PROTOCOL_VERSION, VERSION, startedAt, getCurrentPort: () => currentPort, TLS_ENABLED, BIND_ADDRESS, PUBLIC_URL, instances, sessions, browserList, sessionList: () => sessionViews.sessionList(), inflightList: () => inflightOps.inflightList(), sessionQueue, authGuard, featureMatrix, compareProtocol, recovery: () => sessionRecovery.snapshot() });

const routePolicy = createRoutePolicy({ BridgeError, isMutating, domainAllowed, sleep });

const ledgerOps = createLedgerTarget({ resolveSession, EXT_METHODS });

const submitApi = createSubmit({
  intentLedger, routeExtension, withEffectState, annotateEffectSuccess, sessions, resolveSessionByScope, BridgeError, ledgerTargetFromRoute: ledgerOps.ledgerTargetFromRoute,
});

const extensionDispatch = createExtensionDispatch({ prepareRoute, routePolicy, requireFeatures, verifyDecision, submitApi, saveSessions, sendInstanceEvent, sessionState });

const planRunner = createPlanRunner({ BridgeError, dispatchInner, extensionDispatch });

async function dispatch(method, params, timeoutMs) {
  if (method === 'ledger.status') {
    const limit = params && params.limit;
    const status = intentLedger.status({ limit });
    // 默认载荷（pending/recent/recovery/wal/durability）保持不变；只有显式请求才追加
    // 结构化快照 / 对账恢复报告 / 崩溃恢复报告，供 `bridge daemon ledger snapshot|restore` 消费。
    const wantsStructured = Boolean(params) && (params.snapshot === true || params.compare === true || params.persist === true || params.recovery === true);
    if (!wantsStructured) return status;
    const snapshot = ledgerReport.snapshot({ status });
    const result = { ...status, snapshot };
    if (params.persist === true) result.persisted = ledgerReport.persistSnapshot({ status });
    if (params.compare === true) result.restore = ledgerReport.restore({ status });
    // recovery=true：端到端崩溃恢复报告（含人工 resolve 策略、按 tab/method 聚合、租约对账）。
    if (params.recovery === true) {
      try {
        result.recoveryReport = recoveryReporter.report({ limit: limit == null ? 20 : limit, status });
      } catch (error) {
        result.recoveryReport = { ok: false, error: (error && error.code) || 'E_INTERNAL', message: String((error && error.message) || error) };
      }
    }
    return result;
  }
  if (method === 'ledger.resolve') {
    // 人工批量 resolve（第十批 F）：ids=[...] 是"计划→执行"两段式，protected 永不自动解锁。
    // 只有在显式传 ids 时才走这里；既有 id / tabId / all 语义保持不变。
    if (params && Array.isArray(params.ids)) {
      const manual = recoveryReporter.manualResolve({
        ids: params.ids,
        outcome: params.outcome,
        by: params.by || 'rpc-manual',
        dryRun: params.dryRun === true,
      });
      // 参数层错误（空目标/未知结论）与既有 ledger.resolve 一致地抛 BridgeError（E_BAD_ARG），
      // 而不是把 {ok:false} 当成成功回包，方便 CLI 以参数错误退出。
      if (manual && manual.ok === false && manual.error) {
        throw new BridgeError(manual.error, manual.message || '人工 resolve 参数不合法', {
          ...(manual.allowedOutcomes ? { allowedOutcomes: manual.allowedOutcomes } : {}),
        });
      }
      if (manual && manual.ok === true && manual.dryRun !== true) {
        try { sessionRecovery.recordRecoveryReport(recoveryReporter.report()); } catch { /* 报告刷新失败不影响 resolve 结果 */ }
      }
      return manual;
    }
    // 单条 dryRun：只出计划与理由（不写账本），用于"先看会发生什么"。
    if (params && params.id && params.dryRun === true) {
      const planned = recoveryReporter.manualResolve({
        ids: [params.id],
        outcome: params.outcome,
        by: params.by || 'rpc-manual',
        dryRun: true,
      });
      if (planned && planned.ok === false && planned.error) {
        throw new BridgeError(planned.error, planned.message || '人工 resolve 参数不合法', {
          ...(planned.allowedOutcomes ? { allowedOutcomes: planned.allowedOutcomes } : {}),
        });
      }
      return planned;
    }
    // 单条：0.3.0 语义不变（需要 id；崩溃恢复的非幂等动作强制 confirmed|not-applied 由账本裁定）。
    if (params && params.id) {
      return { entry: intentLedger.resolve(params.id, params.outcome, { by: params.by || 'rpc' }) };
    }
    // 批量（新增）：按 tab 或 all 和解，返回结构化报告（含 protected/active/skipped 原因）。
    if (params && (params.tabId !== undefined || params.all === true)) {
      return ledgerReport.reconcile({
        tabId: params.tabId,
        all: params.all === true,
        outcome: params.outcome,
        by: params.by || 'rpc-tab',
        dryRun: params.dryRun === true,
      });
    }
    throw new BridgeError('E_BAD_ARG', 'ledger.resolve 需要 id');
  }
  // 只有本地方法（以及需要自动和解的 cooperate.sync）才在这里解析账本目标；
  // 扩展方法的目标由 prepareRoute 之后的 ledgerTargetFromRoute 给出，避免二次 resolveSession。
  const needsTarget = method === 'cooperate.sync' || (isMutating(method) && !ledgerOps.isExtensionRouted(method));
  const target = needsTarget ? ledgerOps.ledgerTarget(params) : null;
  // 对齐兼容目标语义：sync 时若为 auto 暂停且人类静默 >=2s、Agent 静默 >=3s，则自动恢复。
  if (method === 'cooperate.sync' && target.sessionId) {
    try {
      const session = resolveSession(target.sessionId);
      const nowMs = Date.now();
      if (session.paused && session.pausedBy === 'auto' && nowMs - (session.lastHumanInputAt || session.pausedAt || 0) >= 2000 && nowMs - (session.lastAgentActivity || 0) >= 3000) {
        session.paused = false;
        session.pausedBy = null;
        session.pausedAt = null;
        try { sessionState.resume(session.sessionId, { reason: 'cooperate-sync-idle' }); } catch { /* 忽略 */ }
        const owner = instances.get(session.instanceId);
        if (owner) sendInstanceEvent(owner, 'takeover.state', { tabId: session.tabId, sessionId: session.sessionId, paused: false, pausedBy: null, borrowed: session.borrowed === true, controller: session.controller ?? null, project: session.controller?.project ?? null });
        log('session ' + session.sessionId + ' 空闲自动恢复（sync）');
      }
      session.lastAgentActivity = nowMs;
    } catch { /* 会话不存在时交给下游报错 */ }
  }
  // 走扩展路由的方法在 dispatchExtension 里 prepareRoute 之后再落账（目标取自 route.session）；
  // 其余本地方法在这里落账。两条路径互斥，保证每个变异调用恰好 begin 一次。
  const intent = isMutating(method) && !ledgerOps.isExtensionRouted(method)
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
async function dispatchInner(method, params, timeoutMs) {
  // plan 的兼容写法（{action,...}）先归一再过 schema。
  if (method === 'plan' && params && Array.isArray(params.steps)) {
    params = { ...params, steps: normalizePlanSteps(params.steps) };
  }
  const schemaErrors = validateMethodParams(method, params);
  if (schemaErrors.length) {
    throw new BridgeError('E_BAD_ARG', `参数校验失败（${method}）：` + schemaErrors.join('；'), { errors: schemaErrors });
  }
  const local = await localDispatch(method, params, timeoutMs);
  if (!local || local.handled !== false) return local;

  switch (method) {
    case 'upload': {
      const route = await prepareRoute('upload', params);
      await routePolicy.enforceSessionPolicy(route, 'upload', route.params);
      verifyDecision(route, 'upload');
      const withPaths = transferOps.injectTransferPaths({ ...route.params, sessionId: route.session ? route.session.sessionId : undefined });
      delete withPaths.sessionId;
      route.params = withPaths;
      return submitApi.submitRouted(route, 'upload', params, timeoutMs);
    }
    case 'download': {
      const route = await prepareRoute('download', params);
      await routePolicy.enforceSessionPolicy(route, 'download', route.params);
      verifyDecision(route, 'download');
      const result = await submitApi.submitRouted(route, 'download', params, timeoutMs);
      return transferOps.stageDownloadResult(result, route.session ? route.session.sessionId : null);
    }
    case 'daemon.stop':
      // 生命周期方法：先回包再优雅退出。
      scheduleShutdown('rpc daemon.stop', 0);
      return { ok: true };
    case 'operation.await': {
      const result = await extensionDispatch.dispatchExtension('operation.await', params, timeoutMs);
      return enforceOperationLimit(result);
    }
    case 'plan':
      return planRunner.runPlan(params, timeoutMs);
    default:
      if (EXT_METHODS.has(method)) return extensionDispatch.dispatchExtension(method, params, timeoutMs);
      throw new BridgeError('E_UNKNOWN_METHOD', `unknown method: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// HTTP 服务
// ---------------------------------------------------------------------------









const startRequests = createStartRequests({ startJournal, normalizeStartToken, BridgeError });

const sessionRebind = createSessionRebind({ resolveSession, tabControls, instances, sendCommand, tabReservations, rebindSessionRecord, tabControl, saveSessions, sendInstanceEvent, log, sessionPublicView, sessionState, BridgeError, findInstanceForTab, lease: sessionLeases });

const readViews = createReadViews({ HOME_DIR, BridgeError, resolveSession });

const sessionViews = createSessionViews({ sessions, instances, tabControl, sessionState, sessionPublicView, isSessionExpired, resolveSession, sessionLeases });

const transferPolicy = transferPolicyFromEnv();
const transferOps = createTransferOps({ dir: TRANSFER_DIR, log, BridgeError, resolveSession, policy: transferPolicy });
// 失败清理：定期回收"空闲未完成"（客户端断连不再续传）与"过期已完成"（消费方没来读）的 staging。
// unref 保证不影响 daemon 退出；卸载时在 shutdown() 里 clearInterval。
const transferSweeper = setInterval(() => {
  try {
    const swept = transferOps.transferSweep();
    if (swept.removed.length) log('transfer 清理：' + swept.removed.length + ' 个 staging（' + swept.bytes + ' 字节）');
  } catch (error) {
    logError('transfer 清理失败：' + ((error && error.message) || error));
  }
}, transferPolicy.sweepIntervalMs);
if (transferSweeper.unref) transferSweeper.unref();

// daemon 结构化自检 + status 增量视图（视图按需计算；默认 status 载荷与 0.3.0 一致）。
const daemonDoctor = createDaemonDoctor({
  ledgerReport, transferOps, commandQueue, sessionRecovery, ledger: intentLedger,
  version: VERSION, protocol: PROTOCOL_VERSION, startedAt, homeDir: HOME_DIR, now: () => Date.now(),
});
const statusViews = createStatusViews({
  baseStatus: health.buildStatus, ledgerReport, transferOps, commandQueue, daemonDoctor,
  leaseOps, commandBoundary, batchSessions, leaseArbiter,
});

const sessionStop = createSessionStop({ resolveSession, aliases, tabReservations, tabControls, tabControl, sessionState, sessions, instances, sendCommand, sendInstanceEvent, saveSessions, sessionPublicView, log, logError, BridgeError, sessionQueue, lease: sessionLeases, releaseTransfersForSession: transferOps.releaseTransfersForSession });

const sessionStart = createSessionStart({ log, isControllerInfo, BridgeError, normalizeStartToken, startJournal, sessions, instances, tabControls, findInstanceForTab, crypto, tabReservations, getBorrowConfirm: () => globalBorrowConfirm, sendCommand, pickInstance, newSessionId, sessionState, createSessionRecord, normalizeDomains, saveSessions, tabControl, sendInstanceEvent, lease: sessionLeases });

const sessionAdmin = createSessionAdmin({ resolveSession, instances, sendInstanceEvent, log, BridgeError, sessions, sessionStop, sessionState });

const controlOps = createControlOps({ resolveSession, tabControls, tabControl, BridgeError, log });

// 会话生命周期 → 租约证据（第十批 F）。只在成功后补登/重绑/释放，失败不改变原有错误语义；
// note* 内部对冲突/缺失全部容错（session.start 撞上恢复租约时会自动降级为 join 参与者）。
async function startSessionWithLease(params, timeoutMs) {
  const started = await sessionStart.startSession(params, timeoutMs);
  try { leaseOps.noteSessionStarted(started); } catch (error) {
    log('会话启动后租约登记失败（忽略）：' + ((error && error.message) || error));
  }
  return started;
}

async function stopSessionWithLease(params, timeoutMs) {
  let before = null;
  try { before = resolveSession(params && params.session !== undefined ? params.session : params.sessionId); } catch { /* 交给 stopSession 报错 */ }
  const result = await sessionStop.stopSession(params, timeoutMs);
  try { if (before) leaseOps.noteSessionStopped({ sessionId: before.sessionId, tabId: before.tabId }); } catch (error) {
    log('会话停止后租约释放失败（忽略）：' + ((error && error.message) || error));
  }
  return result;
}

async function rebindSessionWithLease(params, timeoutMs) {
  let before = null;
  try { before = resolveSession(params && params.session !== undefined ? params.session : params.sessionId); } catch { /* 交给 rebindSession 报错 */ }
  const result = await sessionRebind.rebindSession(params, timeoutMs);
  try {
    if (before) {
      const toTabId = result && Number.isInteger(result.tabId) ? result.tabId : (params && params.tab);
      leaseOps.noteSessionRebound({ sessionId: before.sessionId, fromTabId: before.tabId, toTabId });
      if (result && Number.isInteger(result.tabId)) before.tabId = result.tabId;
    }
  } catch (error) {
    log('会话重绑后租约迁移失败（忽略）：' + ((error && error.message) || error));
  }
  return result;
}

const genericOps = createGenericOps({
  inflight,
  instances,
  inflightList: () => inflightOps.inflightList(),
  cancelInflight: (params) => inflightOps.cancelInflight(params),
  cancelStartRequest: (params) => startRequests.cancelStartRequest(params),
  ledger: intentLedger,
  ledgerReport,
  recoveryReporter,
  resolveSession,
  getOperation: (id) => readViews.getOperation(id),
  BridgeError,
  log,
});

const compatPing = () => ({ ok: true, pong: true, protocol: PROTOCOL_VERSION, version: VERSION, ts: Date.now() });
const compatHandshake = () => ({ ok: true, protocol: PROTOCOL_VERSION, version: VERSION });

const localDispatch = createLocalDispatch({
  buildStatus: statusViews.buildStatus, browserList, startSession: startSessionWithLease, prepareStartRequest: startRequests.prepareStartRequest, claimStartRequest: startRequests.claimStartRequest, cancelStartRequest: startRequests.cancelStartRequest, startRequestStatus: startRequests.startRequestStatus, stopSession: stopSessionWithLease, stopAllSessions: sessionAdmin.stopAllSessions, runLogView: sessionViews.runLogView, sessionList: sessionViews.sessionList, rebindSession: rebindSessionWithLease, pauseSession: sessionAdmin.pauseSession, controlStatus: controlOps.controlStatus, claimControl: controlOps.claimControl, releaseControl: controlOps.releaseControl, handoffControl: controlOps.handoffControl, setControlMode: controlOps.setControlMode, viewCache: readViews.viewCache, listAudit: readViews.listAudit, getOperation: readViews.getOperation, inflightList: inflightOps.inflightList, cancelInflight: inflightOps.cancelInflight, localTrustApi, pairingApi, dispatchExtension: extensionDispatch.dispatchExtension, broadcastSettingsSet, transferBegin: transferOps.transferBegin, transferChunk: transferOps.transferChunk, transferFinish: transferOps.transferFinish, transferRead: transferOps.transferRead, transferRelease: transferOps.transferRelease,
  // 兼容目标 0.5.0 对齐：通用 cancel / ledger.request（真实实现复用 inflight + intent ledger）。
  genericCancel: genericOps.cancel,
  genericLedgerRequest: genericOps.ledgerRequest,
compatPing,
compatHandshake,
  // 第十一批 G：批处理会话 + 配额 + 跨会话租约裁决（全部本地方法）。
  batchPlan: batchSessions.plan,
  batchStart: batchSessions.start,
  batchStatus: (params) => batchSessions.status(params && params.batchId),
  batchList: (params) => batchSessions.list(params || {}),
  batchCancel: (params) => batchSessions.cancel(params && params.batchId),
  quotaSnapshot: (params) => sessionQuota.snapshot({ limit: params && params.limit }),
  leaseReport: (params) => leaseArbiter.report(params || {}),
  leaseArbitrate: (params) => leaseArbiter.arbitrate(params || {}),
  BridgeError,
});

// 第十一批 G 新增的本地 RPC 方法：rpc 入口按 LOCAL_METHODS ∪ 本表放行。
// 方法目录（lib/method-catalog.mjs）是扩展/协议侧的单一来源，这里不修改它；
// 新方法只存在于 daemon 本地面，CLI 通过同一 token/鉴权链调用。
const BATCH_LOCAL_METHODS = Object.freeze(['batch.plan', 'batch.start', 'batch.status', 'batch.list', 'batch.cancel', 'batch.quota', 'lease.report', 'lease.arbitrate']);
const RPC_LOCAL_METHODS = new Set([...LOCAL_METHODS, ...BATCH_LOCAL_METHODS, ...COMPAT_RPC_NAMES]);

const rpcHandler = createRpcHandler({
  tokenMatches, readBody, sendJson, LOCAL_METHODS: RPC_LOCAL_METHODS, EXT_METHODS, DEFAULT_TIMEOUT_MS, applySessionScope: submitApi.applySessionScope, dispatch, audit, logError,
});

const previewHandler = createPreviewHandler({
  resolveSession, instances, sendCommand, tokenMatches, authResolve, readBody, sendJson,
});

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

const handleHttpRequest = createHttpHandler({ health, previewHandler, rpcHandler, sendJson, logError });

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

const autoUpdate = createAutoUpdate({ HOME_DIR, VERSION, fs, path, crypto, spawnSync, fetchManifest, fetchArtifact, verifyReleaseSignature, RELEASE_PUBLIC_KEY, readUpdateState, writeUpdateState, log });

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
  autoUpdate.startAutoUpdateCheck();
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
  saveSessions({ immediate: true });
  // 结算类账本写入是 25ms 合并的：停止前必须落盘，否则重启后看到的是 active（会被误判 stale）。
  try { intentLedger.checkpoint(); } catch { /* 忽略 */ }
  // 停止前写对账快照：下次启动 restore() 可以回答"上次停下来时还有哪些未知意图"。
  try { ledgerReport.persistSnapshot(); } catch { /* 忽略 */ }
  try { transferOps.transferSweep(); } catch { /* 忽略 */ }
  if (transferSweeper) {
    try { clearInterval(transferSweeper); } catch { /* 忽略 */ }
  }
  // 停止租约自动回收定时器（unref 的不需要，但显式停掉便于测试/重启复用）。
  try { leaseOps.stopSweeper(); } catch { /* 忽略 */ }
  sessionLeases.clear();
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

const printUsage = createUsagePrinter({ VERSION, HOME_DIR, LOG_PATH });

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
