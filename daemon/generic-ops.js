// daemon/generic-ops.js —— 兼容目标 0.5.0 对齐的两个通用本地 RPC：
//   * cancel { rpc_id }        —— 通用取消（兼容目标 CancelParams/CancelResult：{ cancelled }）
//   * ledger.request { action } —— 通用账本入口（兼容目标: action=status|resolve）
//
// 两者都是 daemon 本地方法（不需要浏览器实例），复用既有真实实现，不另造一套语义：
// - cancel 的落点就是既有的 daemon→扩展 in-flight 命令表 / command.cancel 的转发链；
// - ledger.request 的落点就是既有 IntentLedger.status/resolve 与 ledger-report 的
//   reconcile/manual-resolve（与 ledger.status / ledger.resolve 同一实现）。
//
// 错误码口径（网关层）：
// - 缺 rpc_id / 非法 action / resolve 缺目标 → E_BAD_ARG（带 allowedActions 等证据）；
// - 未知/已结束的 rpc_id 不报错，回 { cancelled:false, reason:'no-inflight' }（兼容目标 语义）；
// - 转发失败沿用既有 BridgeError（E_NOT_FOUND/E_NO_BROWSER/...）。

export const GENERIC_RPC_METHODS = Object.freeze(['cancel', 'ledger.request']);
export const LEDGER_REQUEST_ACTIONS = Object.freeze(['status', 'resolve']);

const BAD_ARG = 'E_BAD_ARG';

function asObject(params) {
  return params && typeof params === 'object' && !Array.isArray(params) ? params : {};
}

function pickString(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

export function createGenericOps({
  inflight,
  instances,
  inflightList,
  cancelInflight,
  cancelStartRequest,
  ledger,
  ledgerReport,
  recoveryReporter,
  resolveSession,
  getOperation,
  BridgeError,
  log = () => {},
}) {
  /** 在 daemon→扩展的 in-flight 表里按“内部 id”或“调用方 rpc_id”找条目。 */
  function findInflight(rpcId) {
    if (!inflight || typeof inflight.get !== 'function') return null;
    const direct = inflight.get(rpcId);
    if (direct) return direct;
    for (const entry of inflight.values()) {
      if (entry && entry.rpcId === rpcId) return entry;
    }
    return null;
  }

  /**
   * 通用取消。参数：{ rpc_id | rpcId | id }（三选一，等价）。
   * - 命中 in-flight：走既有 cancelInflight（会向扩展转发 WS cancel），回 兼容目标 形 { cancelled }。
   * - 命中 pending start request（request_id）：走 start-request 取消（阶段生命周期的取消）。
   * - 命中已结束的 operation：回 cancelled:false + operation 状态（只读证据，不改历史）。
   * - 都没有：回 cancelled:false（不报错，与 兼容目标 一致）。
   */
  async function cancel(params = {}) {
    const bag = asObject(params);
    const explicit = pickString(bag.rpc_id, bag.rpcId, bag.id);
    const requestId = pickString(bag.request_id, bag.requestId);
    const operationId = pickString(bag.operation_id, bag.operationId);
    const target = explicit || requestId || operationId;
    if (!target) {
      throw new BridgeError(BAD_ARG, 'cancel 需要 rpc_id（或 id / request_id / operation_id）', {
        params: ['rpc_id', 'id', 'request_id', 'operation_id'],
      });
    }

    const entry = findInflight(target);
    if (entry) {
      if (entry.method === 'cancel') throw new BridgeError(BAD_ARG, '不能取消 cancel 命令');
      const result = await cancelInflight({ id: entry.id });
      const response = {
        rpc_id: target,
        id: entry.id,
        method: entry.method,
        cancelled: Boolean(result && result.accepted === true),
        forwarded: Boolean(result && result.forwarded === true),
        // 既有 CLI（bridge cancel <commandId>）读 accepted/id 的默认输出逐字不变。
        accepted: Boolean(result && result.accepted === true),
      };
      if (result && result.boundary) response.boundary = result.boundary;
      return response;
    }

    // pending 的 session start request：取消它（同一取消语义的生命周期面）。
    if (requestId || bag.request_id !== undefined || bag.requestId !== undefined) {
      try {
        const cancelled = cancelStartRequest ? cancelStartRequest({ requestId: target }) : null;
        return {
          rpc_id: target,
          request_id: target,
          cancelled: true,
          forwarded: false,
          request: cancelled || null,
        };
      } catch (error) {
        // 不存在/已完成的 request 不是取消失败：按“没有可取消对象”回报，并带原因。
        return {
          rpc_id: target,
          request_id: target,
          cancelled: false,
          forwarded: false,
          reason: (error && error.code) || 'request-not-pending',
        };
      }
    }

    // 已经结束的操作：只读证据（operation 记录），不改账本。
    if (operationId || typeof getOperation === 'function') {
      try {
        const operation = operationId && typeof getOperation === 'function' ? getOperation(operationId) : null;
        if (operation) {
          return {
            rpc_id: target,
            operation_id: operationId || target,
            cancelled: false,
            forwarded: false,
            reason: 'operation-finished',
            operation,
          };
        }
      } catch (error) {
        log('cancel 读取 operation 证据失败（忽略）：' + ((error && error.message) || error));
      }
    }

    return { rpc_id: target, cancelled: false, forwarded: false, reason: 'no-inflight' };
  }

  /** 兼容目标 led/status 回包形状：{ session_id, frozen, pending_unknown, recent } + 既有 status 字段。 */
  function ledgerStatusReply(bag) {
    const sessionId = pickString(bag.session_id, bag.sessionId, bag.session);
    const limit = Number.isInteger(bag.limit) && bag.limit > 0 ? bag.limit : undefined;
    const status = ledger.status(limit === undefined ? {} : { limit });
    const pending = Array.isArray(status.pending) ? status.pending : [];
    // frozen：存在被账本阻断的 unknown/stale 意图（兼容目标 用 frozen 表达“等待人工 resolve”）。
    const frozen = pending.some((entry) => entry && (entry.state === 'unknown' || entry.state === 'stale' || entry.replayBlocked === true));
    return {
      ...status,
      action: 'status',
      session_id: sessionId || null,
      frozen,
      pending_unknown: pending,
    };
  }

  /** resolve：operation_id 优先（兼容目标 单条），其次 tab/session 批量（复用 ledger-report）。 */
  function ledgerResolveReply(bag) {
    const sessionId = pickString(bag.session_id, bag.sessionId, bag.session);
    const operationId = pickString(bag.operation_id, bag.operationId, bag.id);
    const outcome = bag.outcome !== undefined ? String(bag.outcome) : 'abandoned';
    const by = bag.by !== undefined ? String(bag.by) : 'rpc-ledger-request';
    const dryRun = bag.dryRun === true || bag.dry_run === true;
    const explicitTab = Number.isInteger(bag.tab_id) ? bag.tab_id : (Number.isInteger(bag.tabId) ? bag.tabId : null);

    if (Array.isArray(bag.ids)) {
      const manual = recoveryReporter.manualResolve({ ids: bag.ids, outcome, by, dryRun });
      if (manual && manual.ok === false && manual.error) {
        throw new BridgeError(manual.error, manual.message || '人工 resolve 参数不合法', {
          ...(manual.allowedOutcomes ? { allowedOutcomes: manual.allowedOutcomes } : {}),
        });
      }
      return { action: 'resolve', session_id: sessionId || null, dry_run: dryRun, ...manual };
    }

    if (operationId) {
      if (dryRun) {
        return {
          action: 'resolve',
          session_id: sessionId || null,
          operation_id: operationId,
          dry_run: true,
          planned: { operation_id: operationId, outcome },
        };
      }
      const entry = ledger.resolve(operationId, outcome, { by });
      return {
        action: 'resolve',
        session_id: sessionId || null,
        operation_id: operationId,
        resolved_count: 1,
        resolved: [entry],
        entry,
      };
    }

    // 批量：session_id 先解析成 tabId；显式 tab_id 优先；all=true 表示全局。
    let tabId = explicitTab;
    if (tabId === null && sessionId) {
      try {
        const session = resolveSession(sessionId);
        if (session && Number.isInteger(session.tabId)) tabId = session.tabId;
      } catch (error) {
        throw new BridgeError(BAD_ARG, 'ledger.request resolve 无法解析 session_id：' + ((error && error.message) || error), {
          session_id: sessionId,
        });
      }
    }
    if (tabId !== null || bag.all === true) {
      const report = ledgerReport.reconcile({ tabId, all: bag.all === true, outcome, by, dryRun });
      return {
        action: 'resolve',
        session_id: sessionId || null,
        tab_id: tabId,
        dry_run: dryRun,
        resolved_count: Number(report && report.resolved) || 0,
        ...report,
      };
    }

    throw new BridgeError(BAD_ARG, 'ledger.request resolve 需要 operation_id、tab_id、session_id 或 all=true', {
      allowedActions: [...LEDGER_REQUEST_ACTIONS],
    });
  }

  /**
   * 通用账本入口：action=status|resolve。
   * 默认（action 缺省）按 status：与 兼容目标 CLI `ledger status` 的默认行为一致。
   */
  async function ledgerRequest(params = {}) {
    const bag = asObject(params);
    const action = bag.action === undefined || bag.action === null || bag.action === ''
      ? 'status'
      : String(bag.action).trim();
    if (!LEDGER_REQUEST_ACTIONS.includes(action)) {
      throw new BridgeError(BAD_ARG, "ledger.request 不支持 action '" + action + "'；可用：status|resolve", {
        allowedActions: [...LEDGER_REQUEST_ACTIONS],
      });
    }
    if (!ledger || typeof ledger.status !== 'function') {
      throw new BridgeError('E_INTERNAL', 'daemon 未接入意图账本');
    }
    return action === 'status' ? ledgerStatusReply(bag) : ledgerResolveReply(bag);
  }

  return { cancel, ledgerRequest };
}
