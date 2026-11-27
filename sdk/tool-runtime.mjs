// sdk/tool-runtime.mjs —— 把 MCP 的 92 个工具真正接到 Node SDK 的连接上。
//
// 目标（W4-A 第 4 项）：SDK 不再只有 Playwright 风格的高频动作，而是完整覆盖 MCP 工具面：
//   const bb = await connect();
//   const spec = bb.toolSpec('browser_observe');
//   const observation = await bb.callTool('browser_observe', { max_tokens: 800 });
//   await bb.callTool('browser_evaluate', { expression: '1+1' }, { approval: true });
//
// 实现方式：复用 mcp/tools-*.mjs 的 run()（同一份语义），SDK 只提供一份 ctx：
//   rpc           → bridge.rpc(method, params, { timeoutMs })
//   ensureSession → 显式 session > SDK 运行时会话 > session.start
//   withSession   → { ...params, session }
//   parseDurationMs / runCliJson / HOME → 本地 CLI 与文件工具所需
// 因此不存在“SDK 第二套工具实现”，MCP 改了什么 SDK 立刻跟随（契约测试在
// tests/unit/sdk-contract.test.mjs 里逐工具核对）。
//
// 分档/审批与 MCP server 一致：
//   - read/mutate 直接执行；
//   - destructive 需要 options.approval=true（或环境 BB_MCP_APPROVAL=off，browser_update 除外）；
//   - 超时用工具策略里的 timeoutMs，可用 options.timeoutMs 覆盖；
//   - 入参先过 mcp/tool-args.mjs 的运行时校验（E_ARG_MISSING / E_ARG_TYPE / ...）。
//
// W7-C 第 2 项：进度与取消（与 Python SDK 的 call_tool 对齐）
//   - callTool(name, args, { onProgress })：onProgress(event) 收到本地阶段事件
//     { phase: start|progress|done|error|cancelled, tool, tier, callId, elapsedMs, progress?, message?, code? }，
//     心跳节流规格与 MCP server 的 notifications/progress 同一份策略（mcp/progress.mjs）；
//   - callTool(name, args, { signal })：AbortSignal 触发取消（本地停止等待，E_CANCELLED）；
//   - runtime.cancelTool(callIdOrTool, reason)：取消在途调用，返回结构化报告。
//     取消会复用 mcp/cancel.mjs：立刻停止等待，并 best-effort 向 daemon 转发
//     inflight.list/command.cancel；工具 Promise 本身无法中止，会自然结束且结果被丢弃
//     （报告里 remote 字段如实说明，不把“停止等待”说成“任务已回滚”）。

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createBrowserTools } from '../mcp/tools.mjs';
import { TOOL_METHODS } from '../mcp/tool-methods.mjs';
import { approvalDisabled, policyFor } from '../mcp/tool-policy.mjs';
import { createCallRegistry, raceToolCall } from '../mcp/cancel.mjs';
import { createProgressSession, progressResultMeta } from '../mcp/progress.mjs';
import { assertToolInput, listToolSpecs, toolSpec } from './tool-catalog.mjs';

const execFileAsync = promisify(execFile);
const SDK_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SDK_DIR, '..');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'bridge.mjs');

/** SDK 调用 MCP 工具时的错误（协议码 + 工具名 + 结构化细节）。 */
export class ToolCallError extends Error {
  /**
   * @param {string} code 协议错误码（E_ARG_* / E_HUMAN_GATE / E_TIMEOUT / ...）
   * @param {string} message
   * @param {{ tool?: string, details?: unknown }} [options]
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'ToolCallError';
    this.code = code;
    this.tool = options.tool || null;
    this.details = options.details;
  }
}

/** "3s"/"500ms"/"2m"/数字 → 毫秒；无法解析返回 null（与 MCP server 同语义）。 */
export function parseDurationMs(value) {
  if (Number.isInteger(value) && value >= 0) return value;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(String(value || '').trim());
  if (!match) return null;
  const unit = String(match[2] || 's').toLowerCase();
  const factor = unit === 'ms' ? 1 : (unit === 'm' ? 60000 : (unit === 'h' ? 3600000 : 1000));
  return Math.round(Number(match[1]) * factor);
}

/** 默认 home：BB_HOME > ~/.browser-bridge。 */
function resolveHome(home) {
  if (home) return path.resolve(String(home));
  const configured = String(process.env.BB_HOME || '').trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.browser-bridge');
}

/** 默认 CLI JSON 执行器：spawn 本仓库 CLI，返回解析后的 JSON。 */
async function defaultRunCliJson(argv) {
  if (!fs.existsSync(CLI_PATH)) {
    throw new ToolCallError('E_DAEMON', '找不到 CLI：' + CLI_PATH);
  }
  const { stdout } = await execFileAsync(process.execPath, [CLI_PATH, ...argv, '--json'], {
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  try {
    return JSON.parse(stdout);
  } catch {
    throw new ToolCallError('E_BAD_JSON', 'CLI 输出不是 JSON：' + String(stdout).slice(0, 200));
  }
}

/**
 * 把 mcp/progress.mjs 的通知参数映射成 SDK 的本地阶段事件。
 * phase 语义与 Python SDK 的 call_tool(on_progress=...) 一致：
 *   start → 已开始；progress → 心跳；done/error/cancelled → 终态（每条调用必有且只有一条终态）。
 * @returns {'start'|'progress'|'done'|'error'|'cancelled'}
 */
export function progressPhaseFrom(params, finalPhase = null) {
  const meta = (params && params._meta && params._meta['browser-bridge/progress']) || {};
  if (meta.phase === 'start') return 'start';
  if (meta.phase === 'final') {
    if (finalPhase === 'error') return 'error';
    if (finalPhase === 'cancelled') return 'cancelled';
    return 'done';
  }
  return 'progress';
}

/**
 * 创建工具运行时。
 * @param {{ bridge: { rpc: Function }, home?: string, env?: object,
 *           runCliJson?: Function, state?: { sessionId?: string|null } }} options
 */
export function createToolRuntime({ bridge, home, env = process.env, runCliJson = defaultRunCliJson, state } = {}) {
  if (!bridge || typeof bridge.rpc !== 'function') throw new Error('createToolRuntime 需要带 rpc() 的 bridge');
  const homeDir = resolveHome(home);
  const sessionState = state || { sessionId: null, sessionScope: null };

  // 在途工具调用登记：cancelTool / AbortSignal 用它停止等待，并 best-effort 转发 daemon 取消。
  // rpc 适配：mcp/cancel.mjs 以 rpc(method, params, timeoutMs) 调用，SDK 的 rpc 收 options。
  const callRegistry = createCallRegistry({
    rpc: (method, params = {}, timeoutMs = 0) => {
      const options = Number(timeoutMs) > 0 ? { timeoutMs: Number(timeoutMs) } : {};
      return bridge.rpc(method, params, options);
    },
    env,
  });
  let callSeq = 0;

  async function ensureSession(args) {
    if (args && args.session) return String(args.session);
    if (sessionState.sessionId) return sessionState.sessionId;
    const started = await bridge.rpc('session.start', {});
    sessionState.sessionId = started && started.sessionId ? started.sessionId : null;
    if (!sessionState.sessionId) throw new ToolCallError('E_NO_SESSION', 'session.start 没有返回 sessionId');
    return sessionState.sessionId;
  }

  function withSession(sessionId, params) {
    return { ...params, session: sessionId };
  }

  const tools = createBrowserTools({
    rpc: (method, params = {}, timeoutMs = 120000) => bridge.rpc(method, params, timeoutMs ? { timeoutMs } : {}),
    ensureSession,
    withSession,
    parseDurationMs,
    runCliJson,
    HOME: homeDir,
    state: sessionState,
  }).map((tool) => ({
    ...tool,
    // 分档/特性门派生需要方法映射（与 MCP server / sdk/tool-catalog.mjs 一致）。
    methods: [...(TOOL_METHODS[tool.name] || [])],
  }));
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));

  /** 列目录（含分档/分页标记）。 */
  function listTools() {
    return listToolSpecs();
  }

  /** 单工具目录。 */
  function describe(name) {
    return toolSpec(name);
  }

  /** 只校验不执行。 */
  function validate(name, args) {
    try {
      assertToolInput(name, args);
      return { ok: true, errors: [] };
    } catch (error) {
      return { ok: false, errors: error.errors || [{ code: error.code || 'E_ARG_TYPE', path: '', message: String(error.message || error) }] };
    }
  }

  /**
   * 调用一个 MCP 工具，返回工具原始结果（与 MCP tools/call content 里的 JSON 等价）。
   * @param {string} name
   * @param {object} [args]
   * @param {{ approval?: boolean, timeoutMs?: number,
   *           onProgress?: (event:object)=>void, signal?: AbortSignal,
   *           progressToken?: string|number }} [options]
   */
  async function callTool(name, args = {}, options = {}) {
    const detailed = await callToolDetailed(name, args, options);
    return detailed.result;
  }

  /**
   * 调用并返回 { tool, tier, methods, elapsedMs, result, progress, events, callId }。
   * 便于调用方记录审计/分档，以及核对本次调用实际发了多少条进度事件。
   */
  async function callToolDetailed(name, args = {}, options = {}) {
    const spec = toolSpec(name);
    if (!spec) throw new ToolCallError('E_ARG_UNEXPECTED', '未知 MCP 工具：' + name, { tool: name });
    try {
      assertToolInput(name, args);
    } catch (error) {
      throw new ToolCallError(error.code || 'E_ARG_TYPE', String(error.message || error), { tool: name, details: error.errors });
    }
    const policy = policyFor(name, toolMap.get(name));
    if (policy.approvalRequired && options.approval !== true) {
      if (policy.approvalAlways || !approvalDisabled(env)) {
        throw new ToolCallError(
          'E_HUMAN_GATE',
          policy.title + '（' + name + '）属于 ' + policy.tier + ' 级工具，需要人工确认：用 options.approval=true 重试。' + (policy.approvalReason || ''),
          { tool: name, details: { tier: policy.tier, approvalRequired: true } },
        );
      }
    }
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : spec.timeoutMs;
    const tool = toolMap.get(name);
    const tier = policy.tier;
    const signal = options.signal;
    if (signal != null && (typeof signal !== 'object' || typeof signal.aborted !== 'boolean')) {
      throw new ToolCallError('E_ARG_TYPE', 'options.signal 必须是 AbortSignal（有 aborted/addEventListener）', { tool: name });
    }
    const callId = name + '#' + (++callSeq);
    const startedAt = Date.now();
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const events = [];

    /** 发一条本地阶段事件：回调异常不影响工具调用（与 Python SDK 的 best-effort 一致）。 */
    function emit(event) {
      const frozen = Object.freeze({
        ...event,
        tool: name,
        tier,
        callId,
        elapsedMs: Math.max(0, Date.now() - startedAt),
      });
      events.push(frozen);
      if (onProgress) {
        try {
          onProgress(frozen);
        } catch { /* 进度回调失败不应中断工具调用 */ }
      }
      return frozen;
    }

    // 已经取消的 signal：不执行工具，直接给终态（避免发起一个注定被丢弃的远程动作）。
    if (signal && signal.aborted) {
      emit({ phase: 'cancelled', code: 'E_CANCELLED', reason: 'signal-already-aborted' });
      throw new ToolCallError('E_CANCELLED', '工具 ' + name + ' 在开始前已被 signal 取消', {
        tool: name,
        details: { callId, reason: 'signal-already-aborted' },
      });
    }

    // 进度会话：token 默认用 callId（SDK 本地事件不需要与 MCP 客户端共享令牌），
    // 可显式传 options.progressToken 与外部令牌对齐；BB_MCP_PROGRESS=off 时只保留 start/终态。
    let session = null;
    let call = null;
    let failureCode = null;
    session = createProgressSession({
      tool: name,
      token: options.progressToken != null ? options.progressToken : callId,
      policy,
      env,
      notify: (params) => {
        const finalPhase = session ? session.stats().finalPhase : null;
        const phase = progressPhaseFrom(params, finalPhase);
        const event = { phase, progress: params && params.progress, message: params && params.message };
        if (phase === 'error') event.code = failureCode || 'E_INTERNAL';
        if (phase === 'cancelled') {
          event.code = 'E_CANCELLED';
          event.reason = (call && call.reason) || '';
        }
        emit(event);
      },
    });
    call = callRegistry.register(callId, {
      tool: name,
      methods: [...(TOOL_METHODS[name] || [])],
      progress: session,
    });
    let abortHandler = null;
    if (signal && typeof signal.addEventListener === 'function') {
      abortHandler = () => {
        // 取消是异步的（要 best-effort 转发 daemon），但本地等待会同步结束。
        callRegistry.cancel(callId, 'signal').catch(() => {});
      };
      try {
        signal.addEventListener('abort', abortHandler, { once: true });
      } catch { /* 非标准 AbortSignal 实现：忽略监听失败 */ }
    }
    session.start();
    // 进度通知被环境关闭（BB_MCP_PROGRESS=off）时，SDK 仍用本地事件给出 start/终态：
    // onProgress 是调用方自己的回调，不应该因为“不发 MCP 通知”就完全静默。
    if (!session.enabled) emit({ phase: 'start', progress: 0, message: name + ' 开始执行' });
    try {
      const result = await raceToolCall(Promise.resolve().then(() => tool.run(args)), {
        call,
        timeoutMs,
        name,
      });
      session.finish();
      if (!session.enabled) emit({ phase: 'done', message: name + ' 完成' });
      return Object.freeze({
        tool: name,
        tier,
        methods: Object.freeze([...(TOOL_METHODS[name] || [])]),
        elapsedMs: Date.now() - startedAt,
        callId,
        result,
        progress: progressResultMeta(session),
        events: Object.freeze([...events]),
        cancelled: false,
      });
    } catch (error) {
      if (call.cancelled) {
        // 终态 cancelled 事件由 callRegistry.cancel 在关闭进度会话时发出；先等它发完再抛。
        if (call.cancelSettled) {
          try { await call.cancelSettled; } catch { /* 取消报告失败不影响抛错 */ }
        }
        const reason = call.reason || '';
        if (!session.enabled) emit({ phase: 'cancelled', code: 'E_CANCELLED', reason, message: '工具 ' + name + ' 已取消' });
        const cancelled = new ToolCallError('E_CANCELLED', '工具 ' + name + ' 已被取消' + (reason ? '：' + reason : ''), {
          tool: name,
          details: { callId, reason, remote: call.remoteReport },
        });
        cancelled.callId = callId;
        cancelled.events = Object.freeze([...events]);
        cancelled.progress = progressResultMeta(session);
        throw cancelled;
      }
      if (error && error.code === 'E_TIMEOUT') {
        failureCode = 'E_TIMEOUT';
        session.fail(error);
        if (!session.enabled) emit({ phase: 'error', code: 'E_TIMEOUT', message: error.message });
        throw new ToolCallError('E_TIMEOUT', error.message, { tool: name, details: { callId, timeoutMs } });
      }
      failureCode = (error && error.code) || 'E_INTERNAL';
      session.fail(error);
      if (!session.enabled) emit({ phase: 'error', code: failureCode, message: name + ' 失败：' + failureCode });
      // 工具/daemon 自身错误原样透传（调用方按协议错误码分支，不在这里改写）。
      throw error;
    } finally {
      if (abortHandler && typeof signal.removeEventListener === 'function') {
        try { signal.removeEventListener('abort', abortHandler); } catch { /* 忽略 */ }
      }
      callRegistry.release(callId);
      session.dispose();
    }
  }

  /**
   * 取消在途工具调用。
   *
   * target 取值：
   *   - 省略/undefined/null → 取消当前全部在途调用；
   *   - callId（如 "browser_observe#3"）→ 精确取消；
   *   - 工具名（如 "browser_observe"）→ 取消该工具的全部在途调用（多个并发时逐个取消）。
   * 找不到目标不报错（取消是尽力而为），用 unknown=true / requested=0 如实报告。
   *
   * @returns {{ requested:number, cancelled:string[], unknown:boolean, reason:string,
   *             reports:Array<object>, inflight:object }}
   */
  async function cancelTool(target, reason = '') {
    const inflight = callRegistry.snapshot().inflight;
    const key = target == null ? '' : String(target);
    let ids;
    let unknown = false;
    if (!key) {
      ids = inflight.map((row) => row.id);
    } else {
      ids = inflight.filter((row) => String(row.id) === key).map((row) => row.id);
      if (ids.length === 0) ids = inflight.filter((row) => row.tool === key).map((row) => row.id);
      unknown = ids.length === 0;
    }
    const reports = [];
    for (const id of ids) {
      try {
        reports.push(await callRegistry.cancel(id, String(reason || '')));
      } catch (error) {
        reports.push({ found: false, id, error: String((error && error.message) || error) });
      }
    }
    return Object.freeze({
      requested: ids.length,
      cancelled: Object.freeze(reports.filter((row) => row.found).map((row) => row.id)),
      unknown,
      reason: String(reason || ''),
      reports: Object.freeze(reports),
      inflight: callRegistry.snapshot(),
    });
  }

  /** 在途调用快照（诊断/测试用；不含 Promise 引用）。 */
  function inflight() {
    return callRegistry.snapshot();
  }

  /** 关闭运行时：先取消在途调用，再结束 SDK 自己创建的会话（显式传入的会话不动）。 */
  async function close() {
    const cancelled = await cancelTool(undefined, 'runtime-close');
    const sessionId = sessionState.sessionId;
    sessionState.sessionId = null;
    if (!sessionId) return { ok: true, stopped: false, cancelled: cancelled.cancelled };
    try {
      await bridge.rpc('session.stop', { session: sessionId });
      return { ok: true, stopped: true, cancelled: cancelled.cancelled };
    } catch (error) {
      return { ok: false, stopped: false, cancelled: cancelled.cancelled, code: error && error.code ? error.code : 'E_INTERNAL' };
    }
  }

  return Object.freeze({
    home: homeDir,
    listTools,
    describe,
    validate,
    callTool,
    callToolDetailed,
    cancelTool,
    inflight,
    close,
    sessionId: () => sessionState.sessionId,
  });
}
