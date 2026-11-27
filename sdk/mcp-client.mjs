// sdk/mcp-client.mjs —— Node SDK 的 MCP 客户端（与 Python SDK 的 McpToolClient 对齐）。
//
// 定位：sdk/index.mjs 走的是「直连 daemon HTTP /rpc」的 Playwright 风格薄封装；
// 本模块走的是「和模型完全相同的那条路」：spawn `node mcp/server.mjs`，用
// newline-delimited JSON-RPC 2.0 调 MCP。两边共享同一份工具目录/策略/分页/错误映射，
// 因此适合做 SDK 契约测试与“SDK 行为 = MCP 行为”的对账。
//
// 与 Python McpToolClient 对齐的能力面：
//   - initialize 握手 + notifications/initialized；
//   - tools/list、resources/list（含 cursor/limit/query/kind）、resources/read、
//     resources/templates/list、prompts/list（含分页）、prompts/get、completion/complete；
//   - resources/subscribe / unsubscribe + notifications/resources/updated 回调；
//   - callTool：本地 schema 校验 → 审批闸门 → 分档超时 → 进度通知 → 取消；
//   - callToolPaged：按分页工具的 cursor 自动续读（maxPages 上限）；
//   - 重试：按 mcp/error-map.mjs 的 retryPlan 对可重试错误做指数退避（默认关闭）；
//   - AbortSignal：abort 时发 notifications/cancelled 并立刻以 E_CANCELLED 结束等待
//     （server 对该请求不再回响应 —— 与 MCP 规范一致，不假装“已回滚”）；
//   - 错误码透传：server 的 isError/_meta['browser-bridge/errorCode'] → ToolCallError，
//     JSON-RPC error → McpRpcError（带 rpcCode）。
//
// 零第三方依赖：只用 node:child_process / node:readline / node:fs / node:path。
// 调用点：sdk/index.mjs 的导出、tests/unit/sdk-mcp-client.test.mjs；
// 与 Python 侧 tests/python/test_sdk_deep.py 的三方契约对账互为镜像。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { TOOL_NAMES, paginationOf, toolSpec, validateToolInput } from './tool-catalog.mjs';
import { ToolCallError } from './tool-runtime.mjs';
import { RETRY_POLICY, retryPlan } from '../mcp/error-map.mjs';
import { APPROVAL_CONFIRMED, APPROVAL_ENV, APPROVAL_META_KEY, approvalDisabled } from '../mcp/tool-policy.mjs';
import { planSubscriptionChanges } from '../mcp/subscription-diff.mjs';
import {
  RECONNECT_REASONS,
  ReconnectTracker,
  backoffDelayMs,
  isReconnectableError,
  reconnectSnapshot,
  resolveReconnectPolicy,
  runReconnect,
} from './reconnect.mjs';

const SDK_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SDK_DIR, '..');

/** 默认 MCP server 入口（与 Python SDK 的 MCP_SERVER_PATH 同一个文件）。 */
export const MCP_SERVER_PATH = path.join(REPO_ROOT, 'mcp', 'server.mjs');

/** initialize 携带的协议版本（server 支持 2024-11-05 / 2025-03-26 / 2025-06-18）。 */
export const MCP_PROTOCOL_VERSION = '2024-11-05';

/** 客户端默认参数（超时/重试/自身标识）。 */
export const MCP_CLIENT_DEFAULTS = Object.freeze({
  timeoutMs: 60_000,
  connectTimeoutMs: 12_000,
  closeTimeoutMs: 2_000,
  retryMaxAttempts: RETRY_POLICY.maxAttempts,
  clientInfo: Object.freeze({ name: 'browser-bridge-node-sdk', version: '0.1.3' }),
  approvalRetry: 'after-action',
});

/** 默认 BB_HOME（与 CLI/daemon/Python SDK 一致）。 */
export function defaultHome() {
  return process.env.BB_HOME && String(process.env.BB_HOME).trim()
    ? String(process.env.BB_HOME)
    : path.join(os.homedir(), '.browser-bridge');
}

/** JSON-RPC 层面的错误（连接/超时/服务端 error）。 */
export class McpRpcError extends Error {
  constructor(code, message, { method = null, rpcCode = null, data = undefined, requestId = null } = {}) {
    super(String(message));
    this.name = 'McpRpcError';
    this.code = code;
    this.method = method;
    this.rpcCode = rpcCode;
    this.data = data;
    this.requestId = requestId;
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message, method: this.method, rpcCode: this.rpcCode, requestId: this.requestId };
  }
}

/** 本次请求是否应被审批闸门拦下（与 MCP server 的 approvalGate 语义一致）。 */
export function requiresApproval(spec, { approval = false, env = process.env } = {}) {
  if (!spec || !spec.approvalRequired) return false;
  if (approval) return false;
  // browser_update 恒审批；其余 destructive 工具在 BB_MCP_APPROVAL=off 时放行。
  if (spec.name === 'browser_update') return true;
  return !approvalDisabled(env);
}

/**
 * stdio 传输：一行一条 JSON-RPC 消息。
 * 语义与 Python StdioMcpTransport 一致：单读线程（Node 里是 readline）、每个请求一个
 * pending 表、超时即 kill（避免半开管道永久阻塞）、cancel 立即唤醒等待方。
 */
export class McpTransport {
  /**
   * @param {{command?:string[], cwd?:string, env?:object, timeoutMs?:number}} [options]
   */
  constructor({ command = [process.execPath, MCP_SERVER_PATH], cwd = REPO_ROOT, env = null, timeoutMs = MCP_CLIENT_DEFAULTS.timeoutMs } = {}) {
    if (!Array.isArray(command) || command.length === 0) throw new McpRpcError('E_ENV', 'McpTransport 需要启动命令');
    this.command = command.map(String);
    this.cwd = cwd;
    this.env = env ? { ...env } : { ...process.env };
    this.timeoutMs = Number(timeoutMs) || MCP_CLIENT_DEFAULTS.timeoutMs;
    this.child = null;
    this.reader = null;
    this.pending = new Map();
    this.listeners = [];
    this.seq = 0;
    this.closed = false;
    this.notifications = 0;
    this.responses = 0;
    this.stderr = '';
    // 第十一批-C：传输生命周期证据（供 McpClient 的重连状态机 / transportSnapshot 使用）。
    this.exited = false;
    this.startedAt = null;
    this.exitInfo = null;
    this.onExit = null;
  }

  /** 传输当前是否可写（子进程在、读到循环在、未被显式关闭）。 */
  get alive() {
    return Boolean(this.child) && !this.closed && !this.exited;
  }

  /** 启动子进程（幂等）。 */
  start() {
    if (this.child) return this;
    if (this.closed) throw new McpRpcError('E_DISCONNECTED', 'MCP 传输已关闭');
    this.exited = false;
    this.exitInfo = null;
    const child = spawn(this.command[0], this.command.slice(1), {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.startedAt = Date.now();
    child.stderr.on('data', (chunk) => {
      // stderr 只做诊断留证（server 只往 stdout 写 JSON-RPC）。
      this.stderr = (this.stderr + String(chunk)).slice(-8192);
    });
    child.on('exit', (code, signal) => {
      // restart()/close() 后旧子进程的 exit 会晚于新进程启动到达：只处理“当前子进程”的退出，
      // 否则会把新传输的 pending 请求全部 reject（重连场景下非常隐蔽）。
      if (this.child !== child) return;
      this.exited = true;
      this.exitInfo = Object.freeze({ code: typeof code === 'number' ? code : null, signal: signal || null, at: new Date().toISOString() });
      this._failPending(new McpRpcError('E_DISCONNECTED', 'MCP server 已退出'));
      if (typeof this.onExit === 'function') {
        try { this.onExit(this.exitInfo); } catch { /* 退出回调失败不能影响传输清理 */ }
      }
    });
    child.on('error', (error) => {
      if (this.child !== child) return;
      this._failPending(new McpRpcError('E_ENV', '启动 MCP server 失败（需要 node）：' + error.message));
    });
    this.reader = readline.createInterface({ input: child.stdout });
    this.reader.on('line', (line) => this._handleLine(line));
    return this;
  }

  _handleLine(line) {
    const text = String(line || '').trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return; // 非 JSON 行按噪声忽略（server 不会写）
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    if (message.method && message.id === undefined) {
      this.notifications += 1;
      for (const listener of [...this.listeners]) {
        try {
          listener(message);
        } catch {
          // 通知回调失败不能影响读循环
        }
      }
      return;
    }
    this.responses += 1;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    if (entry.timer) clearTimeout(entry.timer);
    if (message.error) {
      const error = message.error;
      entry.reject(new McpRpcError('E_RPC', String(error.message || 'mcp rpc failed'), {
        method: entry.method,
        rpcCode: typeof error.code === 'number' ? error.code : null,
        data: error.data,
        requestId: message.id,
      }));
      return;
    }
    entry.resolve(message.result);
  }

  _failPending(error) {
    for (const [id, entry] of [...this.pending.entries()]) {
      this.pending.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  /** 注册 server→client 通知回调；返回同一函数（便于注销）。 */
  addNotificationHandler(handler) {
    if (typeof handler !== 'function') throw new McpRpcError('E_ARG_TYPE', '通知回调必须是函数');
    this.listeners.push(handler);
    return handler;
  }

  removeNotificationHandler(handler) {
    const index = this.listeners.indexOf(handler);
    if (index < 0) return false;
    this.listeners.splice(index, 1);
    return true;
  }

  /** 发请求并等待响应。@returns {Promise<any>} */
  request(method, params = {}, { timeoutMs = null, onStart = null } = {}) {
    this.start();
    if (this.closed || !this.child) return Promise.reject(new McpRpcError('E_DISCONNECTED', 'MCP 连接已关闭'));
    const wait = Number(timeoutMs) || this.timeoutMs;
    this.seq += 1;
    const id = this.seq;
    const payload = { jsonrpc: '2.0', id, method: String(method), params: params || {} };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this._abort();
        reject(new McpRpcError('E_TIMEOUT', 'MCP ' + method + ' 超过 ' + (wait / 1000).toFixed(2) + 's 未返回', { method, requestId: id }));
      }, wait);
      if (timer && typeof timer.unref === 'function') timer.unref();
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.child.stdin.write(JSON.stringify(payload) + '\n');
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new McpRpcError('E_DISCONNECTED', 'MCP 写入失败：' + error.message, { method, requestId: id }));
        return;
      }
      if (typeof onStart === 'function') {
        try {
          onStart(id);
        } catch (error) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      }
    });
  }

  /** 发通知（无响应）。 */
  notify(method, params = {}) {
    this.start();
    if (!this.child) throw new McpRpcError('E_DISCONNECTED', 'MCP 连接已关闭');
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: String(method), params: params || {} }) + '\n');
  }

  /**
   * 取消一个在途请求：发 notifications/cancelled 并立刻以 E_CANCELLED 结束等待。
   * 返回 false 表示请求已返回/不存在（取消按规范是尽力而为）。
   */
  cancel(requestId, reason = '') {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    if (entry.timer) clearTimeout(entry.timer);
    try {
      this.notify('notifications/cancelled', { requestId, reason: String(reason || '') });
    } catch {
      // 通知发不出去也要唤醒等待方
    }
    entry.reject(new McpRpcError('E_CANCELLED', 'MCP ' + entry.method + ' 已被取消' + (reason ? '：' + reason : ''), {
      method: entry.method,
      data: { requestId, reason: String(reason || '') },
      requestId,
    }));
    return true;
  }

  _abort() {
    this.closed = true;
    const child = this.child;
    this.child = null;
    if (!child) return;
    try { child.stdin.end(); } catch { /* 忽略 */ }
    try { child.kill(); } catch { /* 忽略 */ }
  }

  /** 关闭子进程（幂等）。 */
  close() {
    this.closed = true;
    const child = this.child;
    this.child = null;
    if (this.reader) {
      try { this.reader.close(); } catch { /* 忽略 */ }
      this.reader = null;
    }
    this._failPending(new McpRpcError('E_DISCONNECTED', 'MCP 传输已关闭'));
    if (!child) return;
    try { if (child.stdin) child.stdin.end(); } catch { /* 忽略 */ }
    try { child.kill(); } catch { /* 忽略 */ }
  }

  /**
   * 重建子进程（重连用）：先彻底关闭旧进程/读循环/pending，再按同一配置启动新进程。
   * 返回 this（新进程已 spawn，但尚未握手——握手由 McpClient.connect 负责）。
   */
  restart() {
    this.close();
    this.closed = false;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = [];
    this.notifications = 0;
    this.responses = 0;
    this.stderr = '';
    this.exited = false;
    this.exitInfo = null;
    return this.start();
  }

  /** 传输生命周期快照（诊断/重连证据）。 */
  snapshot() {
    return Object.freeze({
      alive: this.alive,
      closed: this.closed,
      exited: this.exited,
      pid: this.child && typeof this.child.pid === 'number' ? this.child.pid : null,
      startedAt: this.startedAt == null ? null : new Date(this.startedAt).toISOString(),
      uptimeMs: this.startedAt == null ? 0 : Math.max(0, Date.now() - this.startedAt),
      requests: this.seq,
      responses: this.responses,
      notifications: this.notifications,
      pending: this.pending.size,
      exitInfo: this.exitInfo,
      stderr: this.stderr ? String(this.stderr).slice(-512) : '',
    });
  }
}

/** 把 MCP tools/call 结果还原成工具原始返回值；isError 时抛 ToolCallError。 */
export function toolPayloadFromResult(name, result) {
  if (!result || typeof result !== 'object') return result;
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .filter((item) => item && item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
  const meta = result._meta && typeof result._meta === 'object' ? result._meta : {};
  if (result.isError === true) {
    let code = meta['browser-bridge/errorCode'];
    if (!code) {
      const matched = /^\s*([A-Z][A-Z0-9_]+)\s*[:：]/.exec(text);
      code = matched ? matched[1] : 'E_INTERNAL';
    }
    const details = meta['browser-bridge/validation'] != null ? meta['browser-bridge/validation'] : (Object.keys(meta).length ? meta : null);
    throw new ToolCallError(String(code), text, { tool: name, details });
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function newProgressToken() {
  return 'bb-node-' + process.pid + '-' + Math.random().toString(36).slice(2, 14);
}

/** 进度事件收集器（与 Python ProgressTracker 语义一致）。 */
export class ProgressAggregator {
  constructor() {
    this.events = [];
    this.phases = [];
  }

  /** onProgress 回调：记录并透传给调用方。 */
  handler(sink = null) {
    return (event) => {
      this.events.push(event);
      this.phases.push(event.phase);
      if (typeof sink === 'function') {
        try { sink(event); } catch { /* 回调失败不中断工具调用 */ }
      }
    };
  }

  get count() {
    return this.events.length;
  }

  summary() {
    const last = this.events[this.events.length - 1] || null;
    return Object.freeze({
      events: this.events.length,
      phases: [...this.phases],
      finalPhase: last ? last.phase : null,
      sawStart: this.phases.includes('start'),
      sawDone: this.phases.includes('done'),
      sawError: this.phases.includes('error'),
      sawCancelled: this.phases.includes('cancelled'),
      progressSamples: this.events.filter((event) => event.phase === 'progress').length,
    });
  }
}

/**
 * MCP 客户端。
 * 用法：
 *   const client = await createMcpClient({ home: tempDir });
 *   const tools = await client.listTools();                       // 92
 *   const status = await client.callTool('browser_status', {});   // 无 daemon → ToolCallError(E_DAEMON)
 *   await client.callTool('browser_evaluate', { expression: '1' }, { approval: true });
 *   await client.callToolPaged('browser_observe', {}, { maxPages: 3 });
 *   const completion = await client.complete({ ref: { type: 'ref/prompt', name: 'har_analysis' }, argument: { name: 'focus', value: '' } });
 *   client.close();
 */
export class McpClient {
  /**
   * @param {{home?:string, node?:string, timeoutMs?:number, transport?:object, env?:object,
   *          transportFactory?:Function, reconnect?:boolean|object, sleep?:Function}} [options]
   */
  constructor({ home = null, node = null, timeoutMs = MCP_CLIENT_DEFAULTS.timeoutMs, transport = null, env = null, transportFactory = null, reconnect = null, sleep = null } = {}) {
    this.home = home ? String(home) : defaultHome();
    this.timeoutMs = Number(timeoutMs) || MCP_CLIENT_DEFAULTS.timeoutMs;
    this.node = node || process.env.BB_NODE || process.execPath;
    this._transport = transport;
    this._envOverride = env;
    // 第十一批-C：传输工厂 + 重连策略。工厂用于“重连时新建传输”（测试可注入 fake）；
    // 默认关闭重连（副作用工具不能被悄悄重放），需要时传 reconnect:true 或配置对象。
    this._transportFactory = typeof transportFactory === 'function' ? transportFactory : null;
    this.reconnectPolicy = resolveReconnectPolicy(reconnect);
    this.reconnectTracker = new ReconnectTracker({ policy: this.reconnectPolicy });
    this.reconnectInfo = null;
    this._sleep = typeof sleep === 'function' ? sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    this.serverInfo = null;
    this.capabilities = {};
    this.protocolVersion = null;
    this.connected = false;
    this.closed = false;
    this.subscriptions = new Set();
    this.resourceHandlers = [];
  }

  /** 按当前配置新建传输并挂上退出钩子（重连/首次连接共用）。 */
  _createTransport() {
    if (!this._transportFactory && !fs.existsSync(MCP_SERVER_PATH)) {
      throw new McpRpcError('E_ENV', '找不到 MCP server：' + MCP_SERVER_PATH);
    }
    const env = {
      ...(this._envOverride || process.env),
      BB_HOME: this.home,
    };
    const options = {
      command: [this.node, MCP_SERVER_PATH],
      cwd: REPO_ROOT,
      env,
      timeoutMs: this.timeoutMs,
    };
    const transport = this._transportFactory
      ? this._transportFactory(options)
      : new McpTransport(options);
    if (transport && typeof transport === 'object' && 'onExit' in transport) {
      transport.onExit = (info) => {
        // 子进程退出：标记未连接并记录一次 disconnect；真正的重连由 ensureConnected/callTool 触发。
        this.connected = false;
        this.reconnectTracker.recordDisconnect(new McpRpcError('E_DISCONNECTED', 'MCP server 已退出', { data: info }));
      };
    }
    return transport;
  }

  get transport() {
    if (this.closed) throw new McpRpcError('E_DISCONNECTED', 'MCP 客户端已关闭：先 connect() 重新握手');
    if (!this._transport) this._transport = this._createTransport();
    return this._transport;
  }

  /** initialize 握手（幂等）；返回 this 便于链式调用。 */
  async connect() {
    if (this.connected) return this;
    this.closed = false;
    // 传输已退出/已关闭时，先重建一个再握手（否则会在死管道上等超时）。
    if (!this._transport || this._transport.alive === false) {
      this._transport = this._createTransport();
    }
    const result = await this.transport.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { ...MCP_CLIENT_DEFAULTS.clientInfo },
    }, { timeoutMs: this.timeoutMs });
    if (result && typeof result === 'object') {
      this.serverInfo = result.serverInfo || null;
      this.capabilities = result.capabilities || {};
      this.protocolVersion = result.protocolVersion || null;
    }
    try {
      this.transport.notify('notifications/initialized', {});
    } catch {
      // 通知失败不阻止握手（有些传输不支持通知）
    }
    this.connected = true;
    this.reconnectTracker.recordConnected();
    return this;
  }

  /** 关闭连接并清理本地订阅镜像/回调（server 侧断开时同样清理订阅）。 */
  close() {
    const transport = this._transport;
    this._transport = null;
    this.connected = false;
    this.closed = true;
    this.subscriptions.clear();
    this.resourceHandlers = [];
    if (transport && typeof transport.close === 'function') transport.close();
  }

  // -- 重连 ---------------------------------------------------------------
  /**
   * 确保连接可用：未连接 → 重连（受策略约束）；已连接且传输存活 → 直接返回。
   * @returns {Promise<McpClient>}
   */
  async ensureConnected() {
    if (this.closed) throw new McpRpcError('E_DISCONNECTED', 'MCP 客户端已关闭');
    const alive = Boolean(this._transport) && this._transport.alive !== false;
    if (this.connected && alive) return this;
    if (!this.reconnectPolicy.enabled) {
      throw new McpRpcError('E_DISCONNECTED', 'MCP 连接不可用且未开启重连（构造时传 reconnect:true）');
    }
    const result = await this._reconnect(new McpRpcError('E_DISCONNECTED', '连接不可用'));
    if (!result.connected) {
      throw new McpRpcError('E_DISCONNECTED', 'MCP 重连失败：' + result.errors.map((item) => item.code).join(','));
    }
    return this;
  }

  /**
   * 重建传输 → 重新握手 → 恢复本地登记的订阅 → 健康检查。
   * 返回 runReconnect 的结果（connected/attempts/errors）。
   */
  async _reconnect(cause = null) {
    const result = await runReconnect(async () => {
      const previous = this._transport;
      this._transport = null;
      this.connected = false;
      if (previous) {
        try { previous.close(); } catch { /* 旧传输关闭失败不阻塞重连 */ }
      }
      this._transport = this._createTransport();
      await this.connect();
      // 恢复本客户端登记的资源订阅（server 断开时会清理，必须重新 subscribe）。
      if (this.reconnectPolicy.resubscribe) {
        for (const uri of [...this.subscriptions]) {
          try {
            await this._transport.request('resources/subscribe', { uri }, { timeoutMs: this.timeoutMs });
          } catch {
            // 单个订阅恢复失败不阻塞重连；subscriptions 集合保留，供下次对账重试。
          }
        }
      }
      if (this.reconnectPolicy.healthCheck) {
        await this._transport.request('ping', {}, { timeoutMs: this.reconnectPolicy.handshakeTimeoutMs });
      }
      return true;
    }, {
      policy: this.reconnectPolicy,
      tracker: this.reconnectTracker,
      error: cause,
      sleep: this._sleep,
    });
    this.reconnectInfo = result;
    return result;
  }

  /** 重连/传输/订阅的只读快照（诊断用）。 */
  transportSnapshot() {
    const transport = this._transport;
    return Object.freeze({
      connected: this.connected,
      closed: this.closed,
      protocolVersion: this.protocolVersion,
      serverInfo: this.serverInfo,
      reconnect: Object.freeze({
        policy: this.reconnectPolicy,
        tracker: this.reconnectTracker.snapshot(),
        lastResult: this.reconnectInfo,
      }),
      transport: transport && typeof transport.snapshot === 'function' ? transport.snapshot() : null,
      subscriptions: [...this.subscriptions].sort(),
      handlers: this.resourceHandlers.length,
    });
  }

  // -- 只读 MCP 方法 -------------------------------------------------------
  async ping() {
    return this.transport.request('ping', {}, { timeoutMs: this.timeoutMs });
  }

  async listTools() {
    const result = await this.transport.request('tools/list', {}, { timeoutMs: this.timeoutMs });
    return Array.isArray(result && result.tools) ? result.tools : [];
  }

  async listResources({ cursor = null, limit = null, query = null, kind = null, mimeType = null, sort = null } = {}) {
    const params = {};
    if (cursor != null) params.cursor = cursor;
    if (limit != null) params.limit = limit;
    if (query != null) params.query = query;
    if (kind != null) params.kind = kind;
    if (mimeType != null) params.mimeType = mimeType;
    if (sort != null) params.sort = sort;
    const result = await this.transport.request('resources/list', params, { timeoutMs: this.timeoutMs });
    return result || {};
  }

  async listResourceTemplates({ cursor = null, limit = null } = {}) {
    const params = {};
    if (cursor != null) params.cursor = cursor;
    if (limit != null) params.limit = limit;
    const result = await this.transport.request('resources/templates/list', params, { timeoutMs: this.timeoutMs });
    return result || {};
  }

  async readResource(uri) {
    const result = await this.transport.request('resources/read', { uri: String(uri) }, { timeoutMs: this.timeoutMs });
    return result || {};
  }

  async listPrompts({ cursor = null, limit = null } = {}) {
    const params = {};
    if (cursor != null) params.cursor = cursor;
    if (limit != null) params.limit = limit;
    const result = await this.transport.request('prompts/list', params, { timeoutMs: this.timeoutMs });
    return result || {};
  }

  async getPrompt(name, args = {}) {
    const result = await this.transport.request('prompts/get', { name: String(name), arguments: args || {} }, { timeoutMs: this.timeoutMs });
    return result || {};
  }

  /** completion/complete：prompt 参数 / 资源模板变量候选值。 */
  async complete({ ref, argument, cursor = null, limit = null, context = null } = {}) {
    const params = { ref, argument };
    if (cursor != null) params.cursor = cursor;
    if (limit != null) params.limit = limit;
    if (context != null) params.context = context;
    const result = await this.transport.request('completion/complete', params, { timeoutMs: this.timeoutMs });
    return result || {};
  }

  /** 一次拉完所有分页（resources/list / prompts/list 通用）。 */
  async listAllResources({ maxPages = 20, pageSize = 100 } = {}) {
    const resources = [];
    let cursor = null;
    let pages = 0;
    do {
      const result = await this.listResources({ cursor, limit: pageSize });
      resources.push(...(Array.isArray(result.resources) ? result.resources : []));
      cursor = result.nextCursor || null;
      pages += 1;
    } while (cursor && pages < maxPages);
    return { resources, pages };
  }

  // -- 资源订阅 -----------------------------------------------------------
  static _subscriptionReport(result) {
    const meta = result && result._meta;
    if (!meta || typeof meta !== 'object') return {};
    const report = meta['browser-bridge/subscription'];
    return report && typeof report === 'object' ? { ...report } : {};
  }

  async subscribeResource(uri) {
    const result = await this.transport.request('resources/subscribe', { uri: String(uri) }, { timeoutMs: this.timeoutMs });
    this.subscriptions.add(String(uri));
    return McpClient._subscriptionReport(result);
  }

  async unsubscribeResource(uri) {
    const result = await this.transport.request('resources/unsubscribe', { uri: String(uri) }, { timeoutMs: this.timeoutMs });
    this.subscriptions.delete(String(uri));
    return McpClient._subscriptionReport(result);
  }

  resourceSubscriptions() {
    return [...this.subscriptions].sort();
  }

  /**
   * 声明式订阅对账（第十一批-C）：把本地期望订阅集合同步到服务端。
   * 复用 mcp/subscription-diff.mjs 的 planSubscriptionChanges（幂等、可重放）。
   *
   * @param {Iterable<string>} desired
   * @param {{ignoreErrors?:boolean}} [options]
   * @returns {Promise<{toSubscribe:string[], toUnsubscribe:string[], unchanged:string[],
   *                    subscribed:string[], unsubscribed:string[], errors:Array<{uri:string,code:string}>}>}
   */
  async syncResourceSubscriptions(desired, { ignoreErrors = false } = {}) {
    const plan = planSubscriptionChanges([...(desired || [])], this.resourceSubscriptions());
    const subscribed = [];
    const unsubscribed = [];
    const errors = [];
    for (const uri of plan.toUnsubscribe) {
      try {
        await this.unsubscribeResource(uri);
        unsubscribed.push(uri);
      } catch (error) {
        errors.push(Object.freeze({ uri, code: String((error && error.code) || 'E_INTERNAL') }));
        if (!ignoreErrors) throw error;
      }
    }
    for (const uri of plan.toSubscribe) {
      try {
        await this.subscribeResource(uri);
        subscribed.push(uri);
      } catch (error) {
        errors.push(Object.freeze({ uri, code: String((error && error.code) || 'E_INTERNAL') }));
        if (!ignoreErrors) throw error;
      }
    }
    return Object.freeze({
      toSubscribe: plan.toSubscribe,
      toUnsubscribe: plan.toUnsubscribe,
      unchanged: plan.unchanged,
      subscribed: Object.freeze(subscribed),
      unsubscribed: Object.freeze(unsubscribed),
      errors: Object.freeze(errors),
    });
  }

  supportsResourceSubscriptions() {
    return Boolean(this.capabilities && this.capabilities.resources && this.capabilities.resources.subscribe);
  }

  /** 注册 notifications/resources/updated 回调：handler(params)；返回注销函数。 */
  addResourceUpdatedHandler(handler) {
    if (typeof handler !== 'function') throw new McpRpcError('E_ARG_TYPE', '资源更新回调必须是函数');
    const transport = this.transport;
    if (typeof transport.addNotificationHandler !== 'function') {
      throw new McpRpcError('E_UNSUPPORTED_CAPABILITY', '当前传输不支持 server→client 通知回调');
    }
    const listener = (message) => {
      if (!message || message.method !== 'notifications/resources/updated') return;
      const params = message.params && typeof message.params === 'object' ? { ...message.params } : {};
      try { handler(params); } catch { /* 回调失败不影响其它订阅者 */ }
    };
    transport.addNotificationHandler(listener);
    this.resourceHandlers.push(listener);
    return () => this.removeResourceUpdatedHandler(listener);
  }

  removeResourceUpdatedHandler(handler) {
    const transport = this._transport;
    if (!transport || typeof transport.removeNotificationHandler !== 'function') return false;
    const removed = transport.removeNotificationHandler(handler);
    const index = this.resourceHandlers.indexOf(handler);
    if (index >= 0) this.resourceHandlers.splice(index, 1);
    return removed;
  }

  // -- 工具调用 -----------------------------------------------------------
  /**
   * 调用一个 MCP 工具，返回工具原始结果（解析后的 JSON；非 JSON 返回文本）。
   *
   * @param {string} name
   * @param {object} [args]
   * @param {{
   *   approval?: boolean, timeoutMs?: number, progress?: boolean,
   *   onProgress?: Function, onRequest?: Function, signal?: AbortSignal,
   *   validate?: boolean, retry?: boolean|number,
   * }} [options]
   * @returns {Promise<any>}
   */
  async callTool(name, args = {}, options = {}) {
    const detailed = await this.callToolDetailed(name, args, options);
    return detailed.payload;
  }

  /** 同 callTool，但返回 { payload, meta, elapsedMs, progress, requestId }。 */
  async callToolDetailed(name, args = {}, options = {}) {
    const spec = toolSpec(name);
    if (!spec) throw new ToolCallError('E_ARG_UNEXPECTED', '未知 MCP 工具：' + name, { tool: String(name) });
    const {
      approval = false,
      timeoutMs = null,
      progress = false,
      onProgress = null,
      onRequest = null,
      signal = null,
      validate = true,
      retry = false,
    } = options;
    if (validate) {
      const validation = validateToolInput(name, args || {});
      if (!validation.ok) {
        const first = validation.errors[0] || { code: 'E_ARG_UNEXPECTED', message: '入参校验失败' };
        throw new ToolCallError(first.code, first.message, { tool: name, details: validation.errors });
      }
    }
    if (requiresApproval(spec, { approval })) {
      throw new ToolCallError('E_HUMAN_GATE', name + ' 属于 ' + spec.tier + ' 级工具，需要人工确认：用 { approval: true } 重试。', {
        tool: name,
        details: { tier: spec.tier, approval_required: true, retry: MCP_CLIENT_DEFAULTS.approvalRetry },
      });
    }
    const attempts = retry === true ? MCP_CLIENT_DEFAULTS.retryMaxAttempts : (Number.isInteger(retry) && retry > 0 ? retry : 1);
    let attempt = 1;
    // 重连预算独立于 retry 预算：连接错误先重建连接再重试；非幂等工具默认不自动重放
    // （retryIdempotentOnly=true），除非调用方显式关闭该限制。
    let reconnectTries = 0;
    while (true) {
      try {
        return await this._callToolOnce(name, spec, args || {}, { approval, timeoutMs, progress, onProgress, signal, onRequest });
      } catch (error) {
        const code = error && error.code;
        const reconnectable = isReconnectableError(error);
        const idempotent = spec.idempotent !== false;
        const mayReconnect = reconnectable.reconnectable
          && this.reconnectPolicy.enabled
          && reconnectTries < this.reconnectPolicy.maxAttempts
          && !(this.reconnectPolicy.retryIdempotentOnly && !idempotent);
        if (mayReconnect) {
          reconnectTries += 1;
          const delayMs = backoffDelayMs(reconnectTries - 1, this.reconnectPolicy, { code });
          if (typeof onProgress === 'function') {
            try {
              onProgress({
                phase: 'reconnect', tool: name, tier: spec.tier, attempt: reconnectTries,
                code, delayMs, reason: RECONNECT_REASONS.DISCONNECT,
              });
            } catch { /* 回调失败不中断重连 */ }
          }
          await this._sleep(delayMs);
          const reconnect = await this._reconnect(error);
          if (reconnect.connected) continue;
          throw error;
        }
        if (reconnectable.reconnectable && this.reconnectPolicy.enabled
          && this.reconnectPolicy.retryIdempotentOnly && !idempotent) {
          // 明确记账：非幂等工具因安全策略未自动重连/重放（调用方可传 reconnect:{retryIdempotentOnly:false}）。
          process.stderr.write('sdk: ' + name + ' 连接错误但工具非幂等，跳过自动重连重放\n');
        }
        const plan = retryPlan(code, { attempt, maxAttempts: attempts });
        if (!plan.retryable || attempt >= attempts) throw error;
        attempt += 1;
        if (typeof onProgress === 'function') {
          try {
            onProgress({ phase: 'retry', tool: name, tier: spec.tier, attempt: attempt - 1, code, delayMs: plan.delayMs, elapsedMs: 0 });
          } catch { /* 回调失败不中断重试 */ }
        }
        await this._sleep(plan.delayMs);
      }
    }
  }

  async _callToolOnce(name, spec, args, { approval, timeoutMs, progress, onProgress, signal, onRequest }) {
    const transport = this.transport;
    if (signal && signal.aborted) {
      throw new ToolCallError('E_CANCELLED', name + ' 在开始前已被取消', { tool: name, details: { reason: String(signal.reason || '') } });
    }
    const startedAt = Date.now();
    const wait = Number(timeoutMs) || spec.timeoutMs;
    const progressToken = progress ? newProgressToken() : null;
    const emit = (event) => {
      if (typeof onProgress !== 'function') return;
      try {
        onProgress({ tool: name, tier: spec.tier, elapsedMs: Date.now() - startedAt, ...event });
      } catch { /* 回调失败不中断工具调用 */ }
    };
    let progressHandler = null;
    let abortHandler = null;
    let requestId = null;
    emit({ phase: 'start', cursor: args.cursor != null ? args.cursor : null });
    if (progressToken && typeof transport.addNotificationHandler === 'function') {
      progressHandler = (message) => {
        if (!message || message.method !== 'notifications/progress') return;
        const params = message.params || {};
        if (params.progressToken !== progressToken) return;
        emit({ phase: 'progress', progress: params.progress, total: params.total, message: params.message });
      };
      transport.addNotificationHandler(progressHandler);
    }
    const params = { name, arguments: args };
    const meta = {};
    if (approval) meta[APPROVAL_META_KEY] = APPROVAL_CONFIRMED;
    if (progressToken) meta.progressToken = progressToken;
    if (Object.keys(meta).length) params._meta = meta;
    const requestOptions = {
      timeoutMs: wait,
      onStart: (id) => {
        requestId = id;
        if (typeof onRequest === 'function') onRequest(id);
        if (signal && typeof signal.addEventListener === 'function') {
          abortHandler = () => {
            if (this._transport) this._transport.cancel(id, String(signal.reason || 'node-sdk-abort'));
          };
          signal.addEventListener('abort', abortHandler, { once: true });
        }
      },
    };
    let result;
    try {
      result = await transport.request('tools/call', params, requestOptions);
    } catch (error) {
      if (error && error.code === 'E_CANCELLED') {
        emit({ phase: 'cancelled', code: error.code, requestId });
      } else {
        emit({ phase: 'error', code: error && error.code ? error.code : 'E_INTERNAL', requestId });
      }
      throw error;
    } finally {
      if (abortHandler && signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', abortHandler);
      if (progressHandler && typeof transport.removeNotificationHandler === 'function') transport.removeNotificationHandler(progressHandler);
    }
    let payload;
    try {
      payload = toolPayloadFromResult(name, result);
    } catch (error) {
      emit({ phase: 'error', code: error.code, requestId });
      throw error;
    }
    const resultMeta = result && result._meta && typeof result._meta === 'object' ? result._meta : {};
    emit({ phase: 'done', requestId, elapsedMs: Date.now() - startedAt });
    return {
      payload,
      meta: resultMeta,
      elapsedMs: Date.now() - startedAt,
      progress: resultMeta['browser-bridge/progress'] || null,
      requestId,
    };
  }

  /**
   * 对分页工具按 cursor 自动续读。
   * @returns {Promise<{ pages:Array<any>, payloads:Array<any>, stoppedReason:string, calls:number }>}
   */
  async callToolPaged(name, args = {}, options = {}) {
    const { maxPages = 8 } = options;
    if (!Number.isInteger(maxPages) || maxPages < 1) {
      throw new ToolCallError('E_ARG_RANGE', 'maxPages 必须是正整数，实际 ' + JSON.stringify(maxPages), { tool: name });
    }
    const markers = paginationOf(name);
    const pages = [];
    const payloads = [];
    let current = { ...(args || {}) };
    let stoppedReason = 'completed';
    while (pages.length < maxPages) {
      const page = await this.callTool(name, current, options);
      pages.push(page);
      payloads.push(page);
      if (!markers || !markers.partial) { stoppedReason = 'not-paginated'; break; }
      const cursor = page && typeof page === 'object' ? (page.cursor != null && page.cursor !== '' ? page.cursor : null) : null;
      const truncated = Boolean(page && typeof page === 'object' && (page.truncated || page.partial));
      if (cursor == null) { stoppedReason = truncated ? 'truncated-without-cursor' : 'no-more-pages'; break; }
      current = { ...current, cursor };
    }
    if (pages.length >= maxPages && markers && markers.partial) stoppedReason = 'max-pages';
    return { pages, payloads, stoppedReason, calls: pages.length };
  }

  /** 取消一个在途工具调用（onRequest 拿到的 id）；传输不支持时返回 false。 */
  cancelRequest(requestId, reason = '') {
    const transport = this._transport;
    if (!transport || typeof transport.cancel !== 'function') return false;
    return Boolean(transport.cancel(requestId, reason));
  }
}

/** 便捷构造 + 自动握手：`const client = await createMcpClient({ home })`。 */
export async function createMcpClient(options = {}) {
  const client = new McpClient(options);
  await client.connect();
  return client;
}

/** 作用域客户端：`await withMcpClient({ home }, async (client) => ...)`，结束必关。 */
export async function withMcpClient(options, fn) {
  if (typeof fn !== 'function') throw new McpRpcError('E_ARG_TYPE', 'withMcpClient 需要回调函数');
  const client = await createMcpClient(options);
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

/** 客户端能力快照（测试/诊断用；不发起连接）。 */
export function mcpClientSnapshot() {
  return Object.freeze({
    protocolVersion: MCP_PROTOCOL_VERSION,
    serverPath: MCP_SERVER_PATH,
    defaults: MCP_CLIENT_DEFAULTS,
    tools: TOOL_NAMES.length,
    approvalMetaKey: APPROVAL_META_KEY,
    approvalConfirmedValue: APPROVAL_CONFIRMED,
    approvalEnv: APPROVAL_ENV,
    reconnect: reconnectSnapshot(),
    methods: Object.freeze([
      'initialize',
      'ping',
      'tools/list',
      'tools/call',
      'resources/list',
      'resources/templates/list',
      'resources/read',
      'resources/subscribe',
      'resources/unsubscribe',
      'prompts/list',
      'prompts/get',
      'completion/complete',
    ]),
    // 第十一批-C：客户端侧扩展方法（传输生命周期 / 重连 / 订阅对账）。
    clientMethods: Object.freeze([
      'ensureConnected',
      'transportSnapshot',
      'syncResourceSubscriptions',
      'callToolPaged',
      'cancelRequest',
    ]),
  });
}
