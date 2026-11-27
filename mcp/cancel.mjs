// mcp/cancel.mjs —— MCP `notifications/cancelled` 支持：在途调用登记、超时、genuine 取消、
// daemon 侧 best-effort 取消。
//
// 背景与边界：
//   - MCP 规范允许客户端对已发出的请求发 `notifications/cancelled`（params.requestId/reason）；
//     server 应停止处理并 **不再回该请求的响应**。stdio 服务端没有真正的“中断正在执行的
//     fetch”，所以这里做两件事：立刻停止等待工具 Promise（客户端不会再拿到迟到响应），
//     并尽量把取消转发到 daemon。
//   - daemon 已有 `inflight.list` / `command.cancel` 两个内部方法（按扩展命令 id 取消）。
//     MCP 层无法预知工具内部产生了哪个命令 id，因此在取消时按工具映射的协议方法筛选
//     最近的在途命令再取消；这是 best-effort：命令可能已完成、可能尚未登记、也可能
//     工具根本不是扩展命令（本地 CLI/文件工具）。结果如实写入取消报告，不假装成功。
//   - 工具 Promise 本身无法被中止（daemon/扩展协议没有跨层 abort），取消后它在后台自然结束，
//     结果被丢弃；这一点在报告里明确写 "remote" 字段，避免把“停止等待”说成“任务已回滚”。
//
// 调用点：mcp/server.mjs 的 tools/call（register/race/release）与 notifications/cancelled。

import { setTimeout as defaultSetTimeout, clearTimeout as defaultClearTimeout } from 'node:timers';

/** 取消相关错误码（与 lib/error-codes.mjs 的通用 E_* 命名一致）。 */
export const CANCEL_ERRORS = Object.freeze({
  CANCELLED: 'E_CANCELLED',
  TIMEOUT: 'E_TIMEOUT',
});

/** 环境变量：BB_MCP_CANCEL_REMOTE=off 关闭向 daemon 的取消转发（保留本地停止等待）。 */
export const CANCEL_ENV = Object.freeze({
  remote: 'BB_MCP_CANCEL_REMOTE',
  maxRemote: 'BB_MCP_CANCEL_MAX',
});

/** 单次取消最多向 daemon 转发多少个在途命令（防止一个 broaden 匹配误伤一串命令）。 */
export const DEFAULT_MAX_REMOTE_CANCELS = 3;

function envValue(env, name) {
  const bag = env && typeof env === 'object' ? env : {};
  const value = bag[name];
  return value == null ? '' : String(value).trim();
}

/** 是否允许向 daemon 转发取消。 */
export function remoteCancelEnabled(env = process.env) {
  const value = envValue(env, CANCEL_ENV.remote).toLowerCase();
  return !(value === 'off' || value === '0' || value === 'false' || value === 'disabled');
}

function remoteCancelLimit(env = process.env) {
  const parsed = Number.parseInt(envValue(env, CANCEL_ENV.maxRemote), 10);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_MAX_REMOTE_CANCELS;
  return Math.min(parsed, 8);
}

/** 构造一个“已被取消”的错误（code=E_CANCELLED，带 reason/tool）。 */
export function cancelledError(tool, reason = '') {
  const error = new Error('工具 ' + (tool || '(unknown)') + ' 已被客户端取消' + (reason ? '：' + reason : ''));
  error.code = CANCEL_ERRORS.CANCELLED;
  error.cancelled = true;
  error.tool = tool || null;
  error.reason = String(reason || '');
  return error;
}

/** 构造超时错误（文案与既有 tools/call 兜底保持一致）。 */
export function timeoutError(tool, timeoutMs) {
  const error = new Error('工具 ' + tool + ' 超过 ' + timeoutMs + 'ms 未返回');
  error.code = CANCEL_ERRORS.TIMEOUT;
  return error;
}

/**
 * 在途工具调用登记表。
 *
 * 每个调用登记后：
 *   - raceToolCall() 挂上 onCancel；
 *   - notifications/cancelled → cancel(id) 立即触发 onCancel（停止等待），随后异步转发 daemon；
 *   - release(id) 在请求结束时清理（无论成功/失败/取消）。
 */
export function createCallRegistry({
  rpc = null,
  env = process.env,
  now = () => Date.now(),
  maxRemote = null,
  log = null,
} = {}) {
  const calls = new Map();
  const counters = { registered: 0, released: 0, cancelled: 0, remoteAttempts: 0, remoteAccepted: 0, remoteFailed: 0, unknownCancelled: 0 };
  const limit = Number.isInteger(maxRemote) && maxRemote > 0 ? maxRemote : remoteCancelLimit(env);

  function register(id, meta = {}) {
    const call = {
      id,
      tool: String(meta.tool || ''),
      methods: Array.isArray(meta.methods) ? meta.methods.map(String) : [],
      startedAt: now(),
      cancelled: false,
      reason: '',
      cancelledAt: null,
      remoteReport: null,
      progress: meta.progress || null,
      onCancel: null,
      // 取消处理完成（含最终 progress 通知）后 resolve；tools/call 的 finally 靠它避免
      // 在通知发出前就 dispose 进度会话。
      cancelSettled: null,
    };
    calls.set(id, call);
    counters.registered += 1;
    return call;
  }

  function release(id) {
    if (calls.delete(id)) counters.released += 1;
  }

  function has(id) {
    return calls.has(id);
  }

  function snapshot() {
    return Object.freeze({
      inflight: [...calls.values()].map((call) => Object.freeze({
        id: call.id,
        tool: call.tool,
        methods: Object.freeze([...call.methods]),
        startedAt: call.startedAt,
        elapsedMs: Math.max(0, now() - call.startedAt),
        cancelled: call.cancelled,
        reason: call.reason,
      })),
      counters: Object.freeze({ ...counters }),
      inflightCount: calls.size,
      remoteLimit: limit,
      remoteEnabled: remoteCancelEnabled(env) && Boolean(rpc),
    });
  }

  /**
   * 取消一个在途调用：
   *   1. 找不到 → {found:false}（通知按规范忽略，不是错误）；
   *   2. 幂等：重复取消不重复触发；
   *   3. 立即触发本地 onCancel（停止等待），再 best-effort 转发 daemon。
   * @returns {Promise<{found:boolean, id:any, reason:string, local:boolean, remote:object, alreadyCancelled?:boolean}>}
   */
  async function cancel(id, reason = '') {
    const call = calls.get(id);
    if (!call) {
      counters.unknownCancelled += 1;
      return { found: false, id, reason: String(reason || ''), local: false, remote: { attempted: 0, skipped: true } };
    }
    if (call.cancelled) {
      return {
        found: true,
        id,
        reason: call.reason,
        local: false,
        remote: call.remoteReport || { attempted: 0, skipped: true },
        alreadyCancelled: true,
        progress: call.progress,
      };
    }
    call.cancelled = true;
    call.reason = String(reason || '');
    call.cancelledAt = now();
    counters.cancelled += 1;
    let settle = null;
    call.cancelSettled = new Promise((resolve) => { settle = resolve; });
    let local = false;
    if (typeof call.onCancel === 'function') {
      try {
        call.onCancel(cancelledError(call.tool, call.reason));
        local = true;
      } catch (error) {
        if (typeof log === 'function') log('取消回调失败：' + String((error && error.message) || error));
      }
    }
    const remote = await cancelRemote(call);
    call.remoteReport = remote;
    // 最终进度通知必须在 cancelSettled 之前发出：tools/call 的 cancelled 分支会等它，
    // 保证客户端既收不到原请求响应，又能通过 progressToken 看到“已取消”。
    if (call.progress && typeof call.progress.cancel === 'function') {
      let note = '';
      if (Array.isArray(remote.accepted) && remote.accepted.length) note = 'daemon 已取消 ' + remote.accepted.length + ' 个在途命令';
      else if (remote.note) note = remote.note;
      try {
        call.progress.cancel(call.reason, note);
      } catch (error) {
        if (typeof log === 'function') log('取消进度通知失败：' + String((error && error.message) || error));
      }
    }
    if (settle) settle(remote);
    return { found: true, id, reason: call.reason, local, remote, progress: call.progress };
  }

  /**
   * 向 daemon 转发取消：inflight.list → 按方法筛选 → command.cancel 最近 N 个。
   * 任何一步失败都写进报告，绝不抛出（取消是通知，不能反过来把 server 打挂）。
   */
  async function cancelRemote(call) {
    const report = {
      attempted: 0,
      matched: [],
      cancelled: [],
      accepted: [],
      rejected: [],
      skipped: false,
      error: null,
      note: '',
    };
    if (!rpc || !remoteCancelEnabled(env)) {
      report.skipped = true;
      report.note = 'daemon 取消转发已关闭或不可用（只停止 MCP 等待，工具在后台自然结束）';
      return report;
    }
    if (call.methods.length === 0) {
      report.skipped = true;
      report.note = '该工具没有映射扩展命令方法，无 daemon 在途命令可取消';
      return report;
    }
    let listed;
    try {
      listed = await rpc('inflight.list', {}, 3000);
    } catch (error) {
      report.error = String((error && error.code) || 'E_INTERNAL') + ': ' + String((error && error.message) || error);
      counters.remoteFailed += 1;
      return report;
    }
    const rows = Array.isArray(listed) ? listed
      : Array.isArray(listed && listed.inflight) ? listed.inflight
        : Array.isArray(listed && listed.commands) ? listed.commands
          : Array.isArray(listed && listed.entries) ? listed.entries
            : [];
    const wanted = new Set(call.methods);
    const matches = rows
      .filter((row) => row && typeof row === 'object' && typeof row.method === 'string' && wanted.has(row.method))
      .sort((left, right) => Number(right.startedAt || 0) - Number(left.startedAt || 0))
      .slice(0, limit);
    report.matched = matches.map((row) => ({ id: row.id, method: row.method, elapsedMs: row.elapsedMs }));
    if (matches.length === 0) {
      report.skipped = true;
      report.note = 'daemon 没有匹配方法 ' + [...wanted].join('|') + ' 的在途命令（可能已完成或尚未登记）';
      return report;
    }
    for (const row of matches) {
      report.attempted += 1;
      counters.remoteAttempts += 1;
      try {
        const result = await rpc('command.cancel', { id: row.id }, 2000);
        report.cancelled.push(row.id);
        if (result && result.accepted === true) {
          report.accepted.push(row.id);
          counters.remoteAccepted += 1;
        } else {
          report.rejected.push(row.id);
        }
      } catch (error) {
        report.rejected.push(row.id);
        report.error = String((error && error.code) || 'E_INTERNAL') + ': ' + String((error && error.message) || error);
        counters.remoteFailed += 1;
      }
    }
    if (report.accepted.length === 0) {
      report.note = 'daemon 已收到取消请求但扩展未确认（命令可能已结束）；MCP 侧已停止等待';
    }
    return report;
  }

  return Object.freeze({ register, release, cancel, has, snapshot, remoteLimit: limit });
}

/**
 * 执行工具 Promise，并同时处理：
 *   - 调用级超时（E_TIMEOUT，文案与旧兜底一致）；
 *   - 客户端取消（E_CANCELLED，停止等待）；
 *   - 工具自身异常（原样透传）。
 * 早于超时/取消完成时，落选的 Promise 结果被丢弃（不产生未处理拒绝）。
 *
 * @param {Promise<any>} promise
 * @param {{ call?:object, timeoutMs:number, name:string,
 *           setTimeoutImpl?:Function, clearTimeoutImpl?:Function }} options
 */
export function raceToolCall(promise, {
  call = null,
  timeoutMs,
  name,
  setTimeoutImpl = defaultSetTimeout,
  clearTimeoutImpl = defaultClearTimeout,
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      try { clearTimeoutImpl(timer); } catch { /* 忽略 */ }
      if (call) call.onCancel = null;
      handler(value);
    };
    const timer = setTimeoutImpl(() => finish(reject, timeoutError(name, timeoutMs)), timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    if (call) {
      call.onCancel = (error) => finish(reject, error);
      // 注册竞态：如果登记后、挂 onCancel 前已被取消，补一次。
      if (call.cancelled) finish(reject, cancelledError(call.tool || name, call.reason));
    }
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}
