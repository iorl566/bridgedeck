// daemon/status-views.js —— daemon.status 的增量视图
// （ledger / transfers / queues / doctor / leases / boundary / batch / arbitration）。
//
// 关键约束：**默认 status 载荷必须与 0.3.0 完全一致**（apps/扩展/CLI/MCP 都按既有字段读）。
// 因此这里只在调用方显式请求时才追加字段：
//   {"method":"status","params":{"views":["transfers","queues"]}}
//   {"method":"status","params":{"doctor":true}}            // 等价 views=all + doctor 报告
//   {"method":"status","params":{"views":["leases"]}}       // 多会话 tab 租约所有权/冲突/回收计划
//   {"method":"status","params":{"views":["boundary"]}}     // 命令超时/取消/幂等边界矩阵
//   {"method":"status","params":{"views":["batch"]}}        // 批处理会话 + 配额分配快照（第十一批 G）
//   {"method":"status","params":{"views":["arbitration"]}}  // 跨会话租约冲突裁决计划（第十一批 G）
// 新增字段：ledger / transfers / queue / doctor / leases / boundary / batch / arbitration / views（只加不改）。
//
// 视图计算全部是 daemon 内存快照（同步），因此 buildStatus 保持同步返回，
// 与 local-dispatch 的 `case 'status': return buildStatus(params)` 兼容。
// 视图数据源自身报错时降级为 {ok:false, error} 字段（复用已登记错误码或 E_INTERNAL），
// 不允许一条坏视图把整个 status 打挂。

export const STATUS_VIEWS = Object.freeze(['ledger', 'transfers', 'queues', 'doctor', 'leases', 'boundary', 'batch', 'arbitration']);
export const STATUS_MAX_LIMIT = 500;

/**
 * 解析 status 请求的视图参数。
 * - views 接受字符串 / 字符串数组 / 'all'；
 * - doctor:true 等价加上 doctor 视图；
 * - 未识别的视图忽略（不报错，避免新客户端打到旧 daemon 时整条 status 失败）。
 * @returns {{requested: boolean, views: string[], unknown: string[], doctor: boolean, limit: number|null, sessionsLimit: number|null}}
 */
export function parseStatusViews(params) {
  const source = params && typeof params === 'object' ? params : {};
  const raw = source.views !== undefined ? source.views : source.view;
  const list = [];
  const unknown = [];
  const push = (value) => {
    const name = String(value || '').trim().toLowerCase();
    if (!name) return;
    if (name === 'all') {
      for (const view of STATUS_VIEWS) if (!list.includes(view)) list.push(view);
      return;
    }
    if (STATUS_VIEWS.includes(name)) {
      if (!list.includes(name)) list.push(name);
      return;
    }
    unknown.push(name);
  };
  if (Array.isArray(raw)) for (const value of raw) push(value);
  else if (raw !== undefined && raw !== null) push(raw);
  const doctor = source.doctor === true;
  if (doctor && !list.includes('doctor')) list.push('doctor');
  const intParam = (value, fallback) => {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? Math.min(number, STATUS_MAX_LIMIT) : fallback;
  };
  // 裁决视图的候选排序策略（fifo/lru/priority/holder）；非法值不报错，交给视图层回退默认。
  const strategy = source.strategy === undefined || source.strategy === null || source.strategy === ''
    ? null
    : String(source.strategy).trim().toLowerCase();
  return {
    requested: list.length > 0,
    views: list,
    unknown,
    doctor,
    limit: intParam(source.limit, null),
    sessionsLimit: intParam(source.limitSessions, null),
    strategy,
  };
}

/**
 * 构造 daemon.status 的视图包装器。
 * baseStatus() 必须返回 0.3.0 的原始 status 载荷（引用透明：不请求视图时原样返回）。
 * @param {{baseStatus: Function, ledgerReport?: object|null, transferOps?: object|null,
 *          commandQueue?: object|null, daemonDoctor?: object|null, leaseOps?: object|null,
 *          commandBoundary?: object|null, batchSessions?: object|null, leaseArbiter?: object|null}} options
 */
export function createStatusViews({
  baseStatus,
  ledgerReport = null,
  transferOps = null,
  commandQueue = null,
  daemonDoctor = null,
  leaseOps = null,
  commandBoundary = null,
  batchSessions = null,
  leaseArbiter = null,
} = {}) {
  if (typeof baseStatus !== 'function') throw new TypeError('createStatusViews 需要 baseStatus');

  function buildStatus(params = {}) {
    const base = baseStatus();
    const request = parseStatusViews(params);
    if (!request.requested) return base;
    const result = { ...base };
    if (request.views.includes('ledger') && ledgerReport && typeof ledgerReport.summary === 'function') {
      try { result.ledger = ledgerReport.summary(); } catch (error) { result.ledger = { ok: false, error: (error && error.code) || 'E_INTERNAL', message: String((error && error.message) || error) }; }
    }
    if (request.views.includes('transfers') && transferOps && typeof transferOps.transferSnapshot === 'function') {
      try {
        result.transfers = transferOps.transferSnapshot({ limit: request.limit == null ? 20 : request.limit });
      } catch (error) {
        result.transfers = { ok: false, error: (error && error.code) || 'E_INTERNAL', message: String((error && error.message) || error) };
      }
    }
    if (request.views.includes('queues') && commandQueue && typeof commandQueue.diagnostics === 'function') {
      try {
        result.queue = commandQueue.diagnostics({
          limitSessions: request.sessionsLimit == null ? 50 : request.sessionsLimit,
          tabLimit: request.limit == null ? 20 : request.limit,
        });
      } catch (error) {
        result.queue = { ok: false, error: (error && error.code) || 'E_INTERNAL', message: String((error && error.message) || error) };
      }
    }
    if (request.views.includes('doctor') && daemonDoctor && typeof daemonDoctor.run === 'function') {
      try { result.doctor = daemonDoctor.run(); } catch (error) { result.doctor = { ok: false, error: (error && error.code) || 'E_INTERNAL', message: String((error && error.message) || error) }; }
    }
    // 多会话 tab 所有权租约视图（冲突/续租/过期回收/证据）；不请求时字段不出现。
    if (request.views.includes('leases') && leaseOps && typeof leaseOps.report === 'function') {
      try {
        result.leases = leaseOps.report({
          limit: request.limit == null ? 20 : request.limit,
          includeEvidence: true,
        });
      } catch (error) {
        result.leases = { ok: false, error: (error && error.code) || 'E_INTERNAL', message: String((error && error.message) || error) };
      }
    }
    // 命令超时/取消/幂等边界矩阵视图（从单一目录派生，不手写方法名清单）。
    if (request.views.includes('boundary') && commandBoundary && typeof commandBoundary.summary === 'function') {
      try {
        result.boundary = commandBoundary.summary({ limit: request.limit == null ? 20 : request.limit });
      } catch (error) {
        result.boundary = { ok: false, error: (error && error.code) || 'E_INTERNAL', message: String((error && error.message) || error) };
      }
    }
    // 批处理会话 + 配额分配视图（第十一批 G）：配额池、最近批次、总量；只读快照。
    if (request.views.includes('batch') && batchSessions && typeof batchSessions.snapshot === 'function') {
      try {
        result.batch = batchSessions.snapshot({ limit: request.limit == null ? 10 : request.limit });
      } catch (error) {
        result.batch = { ok: false, error: (error && error.code) || 'E_INTERNAL', message: String((error && error.message) || error) };
      }
    }
    // 跨会话租约冲突裁决视图（第十一批 G）：只出计划（dryRun），绝不在这里执行写操作。
    if (request.views.includes('arbitration') && leaseArbiter && typeof leaseArbiter.report === 'function') {
      try {
        result.arbitration = leaseArbiter.report({
          limit: request.limit == null ? 20 : request.limit,
          ...(request.strategy ? { strategy: request.strategy } : {}),
        });
      } catch (error) {
        result.arbitration = { ok: false, error: (error && error.code) || 'E_INTERNAL', message: String((error && error.message) || error) };
      }
    }
    // 标记本次实际返回的视图，方便 CLI --json 消费方按需断言；未知视图名也回显（诊断用）。
    result.views = request.views.slice();
    if (request.unknown.length) result.unknownViews = request.unknown.slice();
    return result;
  }

  return { buildStatus, parseStatusViews };
}
