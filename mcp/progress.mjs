// mcp/progress.mjs —— tools/call 的 `notifications/progress` 分档节流。
//
// 背景：MCP 客户端只知道“请求发出去了”，长任务（截图/长截图/视频/观察/导出/计划）在完成前
// 完全静默；客户端无法区分“慢”和“挂了”。本模块按工具的预期耗时分成几档，用请求里携带的
// `params._meta.progressToken` 回推进度通知，并做两件事：
//   1. 节流：同一工具每档有最小间隔与首次延迟，短任务根本不会产生通知；
//   2. 有界：单次调用最多发 maxNotifications 条，避免把 stdio 通道刷满。
//
// 协议事实：
//   - 只有客户端在请求 _meta 里给了 progressToken 才允许回 notifications/progress；
//   - 进度值是“单调递增的数字”；总时长未知时省略 total（规范允许）；
//   - 通知不占请求 id、不产生响应，客户端忽略也不影响工具结果。
//
// 调用点：mcp/server.mjs 的 tools/call 执行前后（start/finish/fail/cancel）。
// 单测可用注入的时钟与定时器精确断言节流行为，不需要真实等待。

/** 进度档位：首次延迟、最小间隔、客户端可读的阶段文案。 */
export const PROGRESS_CLASSES = Object.freeze({
  /** 秒级以上的重活：截图/长截图/视频/PDF/上传/计划/回放。 */
  stream: Object.freeze({
    class: 'stream',
    firstDelayMs: 300,
    intervalMs: 500,
    maxNotifications: 240,
    label: '大任务',
  }),
  /** 观察/读取/证据/网络导出：通常 0.5–5s。 */
  observe: Object.freeze({
    class: 'observe',
    firstDelayMs: 400,
    intervalMs: 750,
    maxNotifications: 64,
    label: '观察/读取',
  }),
  /** 普通交互动作：多数几十毫秒，只在异常慢时才提示。 */
  interactive: Object.freeze({
    class: 'interactive',
    firstDelayMs: 1_200,
    intervalMs: 1_500,
    maxNotifications: 24,
    label: '交互动作',
  }),
  /** 快查询（status/state 等）：默认不主动发进度。 */
  fast: Object.freeze({
    class: 'fast',
    firstDelayMs: 2_500,
    intervalMs: 3_000,
    maxNotifications: 8,
    label: '查询',
  }),
});

/**
 * 工具 → 进度档位。只列需要区分“慢但正常”的工具；
 * 未列出的按分档/超时派生（见 progressClassFor），避免维护第二份 92 工具表。
 */
export const PROGRESS_CLASS_BY_TOOL = Object.freeze({
  browser_screenshot: 'stream',
  browser_longshot_recover: 'stream',
  browser_pdf: 'stream',
  browser_upload: 'stream',
  browser_download: 'stream',
  browser_plan: 'stream',
  browser_video_start: 'stream',
  browser_video_stop: 'stream',
  browser_video_recover: 'stream',
  browser_video_merge: 'stream',
  browser_video_split: 'stream',
  browser_video_trim: 'stream',
  browser_video_info: 'stream',
  browser_debug_har: 'stream',
  browser_debug_har_import: 'stream',
  browser_debug_archive: 'stream',
  browser_network_replay_har: 'stream',
  browser_observe: 'observe',
  browser_brief: 'observe',
  browser_read: 'observe',
  browser_extract: 'observe',
  browser_debug_journal: 'observe',
  browser_debug_evidence: 'observe',
  browser_debug_query: 'observe',
  browser_debug_analyze: 'observe',
  browser_debug_archives: 'observe',
  browser_network_waterfall: 'observe',
  browser_network_list: 'observe',
  browser_trace_stop: 'observe',
  browser_trace_summary: 'observe',
  browser_navigate: 'interactive',
  browser_click: 'interactive',
  browser_click_backend: 'interactive',
  browser_fill: 'interactive',
  browser_wait_for: 'interactive',
  browser_record_start: 'interactive',
  browser_record_stop: 'interactive',
  browser_record_list: 'interactive',
  browser_tab_new: 'interactive',
  browser_tab_close: 'interactive',
  browser_tab_select: 'interactive',
  browser_tab_move: 'interactive',
  browser_window: 'interactive',
  browser_dialog: 'interactive',
  browser_install_skill: 'interactive',
  browser_recipe: 'interactive',
  browser_settings: 'interactive',
  browser_pair: 'interactive',
  browser_status: 'fast',
  browser_update_state: 'fast',
  browser_tabs: 'fast',
  browser_audit: 'fast',
  browser_rule_list: 'fast',
  browser_video_status: 'fast',
  browser_video_list: 'fast',
  browser_refs_negotiate: 'interactive',
  browser_update: 'interactive',
  // M6-P0①：console 是读日志（可能较大）；request_status 是本地快查询。
  browser_console: 'observe',
  browser_session_request_status: 'fast',
});

/** 环境变量：BB_MCP_PROGRESS=off 关闭；BB_MCP_PROGRESS_MAX=数字 收紧单次上限。 */
export const PROGRESS_ENV = Object.freeze({
  disable: 'BB_MCP_PROGRESS',
  maxNotifications: 'BB_MCP_PROGRESS_MAX',
});

function envValue(env, name) {
  const bag = env && typeof env === 'object' ? env : {};
  const value = bag[name];
  return value == null ? '' : String(value).trim();
}

/** 进度通知总开关（off/0/false/disabled 关闭）。 */
export function progressDisabled(env = process.env) {
  const value = envValue(env, PROGRESS_ENV.disable).toLowerCase();
  return value === 'off' || value === '0' || value === 'false' || value === 'disabled';
}

/**
 * 单个工具的进度档位：
 *   1. 显式映射优先；
 *   2. 否则按策略超时 ≥120s 视为 stream、≥90s 视为 observe、其余 interactive；
 *   3. 未知工具（没有 policy）退化为 fast。
 */
export function progressClassFor(name, policy = null) {
  const explicit = PROGRESS_CLASS_BY_TOOL[name];
  if (explicit && PROGRESS_CLASSES[explicit]) return explicit;
  const timeoutMs = Number(policy && policy.timeoutMs) || 0;
  if (timeoutMs >= 120_000) return 'stream';
  if (timeoutMs >= 90_000) return 'observe';
  if (timeoutMs > 0) return 'interactive';
  return 'fast';
}

/**
 * 解析某工具本次调用的进度策略（纯函数，便于单测与 tools/list 展示）。
 * @returns {{ name:string, class:string, firstDelayMs:number, intervalMs:number, maxNotifications:number, enabled:boolean }}
 */
export function resolveProgressPolicy(name, policy = null, env = process.env) {
  const className = progressClassFor(name, policy);
  const preset = PROGRESS_CLASSES[className];
  const maxOverride = Number.parseInt(envValue(env, PROGRESS_ENV.maxNotifications), 10);
  const maxNotifications = Number.isInteger(maxOverride) && maxOverride > 0
    ? Math.min(maxOverride, preset.maxNotifications)
    : preset.maxNotifications;
  return Object.freeze({
    name: String(name || ''),
    class: className,
    firstDelayMs: preset.firstDelayMs,
    intervalMs: preset.intervalMs,
    maxNotifications,
    label: preset.label,
    enabled: !progressDisabled(env),
  });
}

/**
 * tools/list / initialize 用的进度分档快照（按档计数 + 每工具档位）。
 * @param {Array} tools 工具数组（元素可带 policy 字段）
 * @param {object} env 环境变量
 * @param {Function|null} policyOf 可选：tool → policy（server 用 policyFor 派生真实分档）
 */
export function progressSnapshot(tools, env = process.env, policyOf = null) {
  const rows = (Array.isArray(tools) ? tools : []).map((tool) => {
    const policy = typeof policyOf === 'function'
      ? policyOf(tool)
      : (tool && tool.policy ? tool.policy : null);
    const resolved = resolveProgressPolicy(tool && tool.name, policy, env);
    return { name: tool && tool.name, class: resolved.class, intervalMs: resolved.intervalMs, maxNotifications: resolved.maxNotifications };
  });
  const byClass = { stream: 0, observe: 0, interactive: 0, fast: 0 };
  for (const row of rows) byClass[row.class] = (byClass[row.class] || 0) + 1;
  return Object.freeze({
    enabled: !progressDisabled(env),
    classes: Object.freeze(Object.keys(PROGRESS_CLASSES)),
    byClass: Object.freeze(byClass),
    rows,
    maxNotifications: rows.reduce((max, row) => Math.max(max, row.maxNotifications), 0),
  });
}

/**
 * 从 tools/call 的 params 里取进度令牌。
 * 规范位置是 params._meta.progressToken；string/number 都接受，其余忽略；
 * 长度上限 128 字符，防止把通知通道当日志用。
 * @returns {string|number|null}
 */
export function progressTokenFrom(params) {
  const meta = params && typeof params === 'object' ? params._meta : null;
  if (!meta || typeof meta !== 'object') return null;
  const token = meta.progressToken;
  if (typeof token === 'number' && Number.isFinite(token)) return token;
  if (typeof token === 'string' && token.length > 0 && token.length <= 128) return token;
  return null;
}

function percent(progress, total) {
  if (!Number.isFinite(progress) || !Number.isFinite(total) || total <= 0) return null;
  return Math.min(100, Math.round((progress / total) * 100));
}

/**
 * 创建一次 tools/call 的进度会话。
 *
 * 设计要点：
 *   - token 缺失/非法 → 返回 inert 会话（所有方法 no-op），server 不需要写条件分支；
 *   - start 立即发一条 progress=0 的通知（客户端能确认“工具已开始”）；
 *   - 之后按 firstDelayMs/intervalMs 心跳，最多 maxNotifications 条；
 *   - finish/fail/cancel 强制发最后一条（不受间隔限制），然后清定时器；
 *   - 定时器 unref，不让 MCP server 因为心跳而无法退出。
 *
 * @param {{
 *   tool:string, token:string|number|null, policy:object,
 *   notify:(params:object)=>void, now?:()=>number,
 *   setTimer?:Function, clearTimer?:Function, env?:object,
 * }} options
 */
export function createProgressSession({
  tool,
  token = null,
  policy = null,
  notify = null,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  env = process.env,
} = {}) {
  const resolved = resolveProgressPolicy(tool, policy, env);
  const usable = token !== null && token !== undefined && typeof notify === 'function' && resolved.enabled;
  const startedAt = now();
  const state = {
    emitted: 0,
    skipped: 0,
    closed: false,
    timer: null,
    finalPhase: null,
    events: [],
  };

  function emit(phase, progress, message) {
    if (!usable) return false;
    if (phase !== 'final' && state.closed) return false;
    if (phase !== 'final' && state.emitted >= resolved.maxNotifications) {
      state.skipped += 1;
      return false;
    }
    const params = {
      progressToken: token,
      progress: Number.isFinite(progress) ? Math.max(0, Math.round(progress)) : 0,
      message: String(message || ''),
      _meta: {
        'browser-bridge/progress': {
          tool: resolved.name,
          class: resolved.class,
          phase,
          elapsedMs: Math.max(0, now() - startedAt),
        },
      },
    };
    try {
      notify(params);
    } catch {
      // 通知写失败（客户端断开）不影响工具执行。
    }
    state.emitted += 1;
    state.events.push(Object.freeze({ phase, progress: params.progress, message: params.message, at: now() }));
    return true;
  }

  function schedule(delayMs, handler) {
    if (typeof setTimer !== 'function') return null;
    const timer = setTimer(handler, delayMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
  }

  function tick() {
    if (!usable || state.closed) return;
    const elapsed = Math.max(0, now() - startedAt);
    emit('heartbeat', elapsed, resolved.name + ' 运行中（' + Math.round(elapsed) + 'ms，' + resolved.label + '）');
    if (state.emitted >= resolved.maxNotifications) {
      // 达到单次上限：不再续排心跳（记一次 skipped 便于自测核对节流确实生效）。
      state.skipped += 1;
      return;
    }
    state.timer = schedule(resolved.intervalMs, tick);
  }

  function start() {
    if (!usable) return state;
    emit('start', 0, resolved.name + ' 开始执行（' + resolved.label + '）');
    if (resolved.firstDelayMs > 0) state.timer = schedule(resolved.firstDelayMs, tick);
    return state;
  }

  function close(phase, message, extra = {}) {
    if (!usable) return stats();
    if (state.closed) return stats();
    state.closed = true;
    if (state.timer) {
      try { clearTimer(state.timer); } catch { /* 忽略 */ }
      state.timer = null;
    }
    state.finalPhase = phase;
    const elapsed = Math.max(0, now() - startedAt);
    emit('final', elapsed, message, extra);
    return stats();
  }

  function finish(detail = '') {
    const elapsed = Math.max(0, now() - startedAt);
    return close('done', resolved.name + ' 完成（' + Math.round(elapsed) + 'ms）' + (detail ? '：' + detail : ''));
  }

  function fail(error) {
    const code = (error && error.code) || 'E_INTERNAL';
    return close('error', resolved.name + ' 失败：' + code);
  }

  function cancel(reason = '', extra = {}) {
    const suffix = reason ? '（' + reason + '）' : '';
    return close('cancelled', resolved.name + ' 已取消' + suffix, extra);
  }

  function dispose() {
    if (state.timer) {
      try { clearTimer(state.timer); } catch { /* 忽略 */ }
      state.timer = null;
    }
    state.closed = true;
  }

  function stats() {
    return Object.freeze({
      tool: resolved.name,
      token,
      enabled: usable,
      class: resolved.class,
      emitted: state.emitted,
      skipped: state.skipped,
      finalPhase: state.finalPhase,
      elapsedMs: Math.max(0, now() - startedAt),
      events: Object.freeze([...state.events]),
      policy: resolved,
    });
  }

  return Object.freeze({
    token,
    enabled: usable,
    policy: resolved,
    startedAt,
    start,
    finish,
    fail,
    cancel,
    dispose,
    stats,
    percent,
  });
}

/**
 * tools/call 结果里的进度元数据（便于客户端/自测核对“到底发了几条”）。
 * 关闭进度时也返回结构，只是 enabled=false / emitted=0。
 */
export function progressResultMeta(session) {
  const stats = session && typeof session.stats === 'function' ? session.stats() : null;
  if (!stats) return Object.freeze({ enabled: false, emitted: 0 });
  return Object.freeze({
    enabled: stats.enabled,
    class: stats.class,
    emitted: stats.emitted,
    skipped: stats.skipped,
    finalPhase: stats.finalPhase,
    elapsedMs: stats.elapsedMs,
    maxNotifications: stats.policy.maxNotifications,
    firstDelayMs: stats.policy.firstDelayMs,
    intervalMs: stats.policy.intervalMs,
  });
}
