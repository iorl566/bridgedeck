// lib/longshot-state.js —— 长截图的显式状态机（合法迁移表 + 拒绝证据，纯内存、可注入时钟）。
//
// 0.3.0 的长截图生命周期散落在 tiled-capture / screenshot / longshot-recover 三处：
//   * “正在拍 / 正在拼 / 已封版”只是函数返回值里的零散字段（stale、extended、segmented…）；
//   * stale 重试靠 attempt 参数递归，最多几次没有显式闸门；
//   * 崩溃恢复产物与正常结束没有可区分的状态，谁也无法回答“这次 capture 到底怎么结束的”。
//
// 本模块把生命周期收敛为 7 个状态与一张显式迁移表：
//
//   idle ──capture.begin──▶ capturing ──stitch.begin──▶ stitching ──seal──▶ sealed
//     │                        │  ▲                        │
//     │                 stale.detected  stale.retry  stale.detected
//     │                        ▼  └──────────────┐          ▼
//     │                       stale ──────────────┘        stale
//     │                        │ stitch.begin / fail
//     ├──recover.begin──▶ recovered ──seal──▶ sealed
//     └──fail──▶ failed
//
// 每条迁移必须命中迁移表；未命中的迁移被拒绝并返回证据
//   { from, to, event, allowed, code, error, at, facts }
// （deny-by-default）。同状态、同事件的重复声明是幂等的（duplicate=true），
// 只更新事实计数、不重复记一条迁移。seal 有硬闸门：分片必须齐、hash 必须已校验；
// stale.retry 有硬闸门：重试次数不能超过 maxStaleAttempts（默认 3，对齐兼容目标）。
//
// 本模块不碰 DOM/chrome/IDB；service worker 与 Node 单测共用同一实现。

export const LONGSHOT_STATES = Object.freeze({
  IDLE: 'idle',
  CAPTURING: 'capturing',
  STITCHING: 'stitching',
  STALE: 'stale',
  SEALED: 'sealed',
  RECOVERED: 'recovered',
  FAILED: 'failed',
});

export const LONGSHOT_STATE_LIST = Object.freeze([
  LONGSHOT_STATES.IDLE,
  LONGSHOT_STATES.CAPTURING,
  LONGSHOT_STATES.STITCHING,
  LONGSHOT_STATES.STALE,
  LONGSHOT_STATES.SEALED,
  LONGSHOT_STATES.RECOVERED,
  LONGSHOT_STATES.FAILED,
]);

export const LONGSHOT_EVENTS = Object.freeze({
  CAPTURE_BEGIN: 'capture.begin',
  CAPTURE_PROGRESS: 'capture.progress',
  STITCH_BEGIN: 'stitch.begin',
  STITCH_PROGRESS: 'stitch.progress',
  STALE_DETECTED: 'stale.detected',
  STALE_RETRY: 'stale.retry',
  SEAL: 'seal',
  RECOVER_BEGIN: 'recover.begin',
  FAIL: 'fail',
  RESET: 'reset',
});

const STATE_LABELS = Object.freeze({
  idle: '空闲',
  capturing: '采集中',
  stitching: '拼接中',
  stale: '页面已变化（待重试）',
  sealed: '已封版',
  recovered: '已从分片恢复',
  failed: '失败',
});

// 迁移表：from + event -> to；bumps 声明推进哪些运行计数。
const TRANSITIONS = Object.freeze([
  // 空闲：开始采集、从分片恢复、直接失败（参数错误）。
  { from: ['idle'], event: 'capture.begin', to: 'capturing', bumps: [] },
  { from: ['idle'], event: 'recover.begin', to: 'recovered', bumps: ['recoveries'] },
  { from: ['idle'], event: 'fail', to: 'failed', bumps: ['failures'] },
  // 采集：tile 进度、进入拼接、发现页面变化、失败。
  { from: ['capturing'], event: 'capture.progress', to: 'capturing', bumps: [] },
  { from: ['capturing'], event: 'stitch.begin', to: 'stitching', bumps: [] },
  { from: ['capturing'], event: 'stale.detected', to: 'stale', bumps: [] },
  { from: ['capturing'], event: 'fail', to: 'failed', bumps: ['failures'] },
  // 拼接：stdout 进度、仍可发现 stale（扩展/改写后重拼）、封版、失败。
  { from: ['stitching'], event: 'stitch.progress', to: 'stitching', bumps: [] },
  { from: ['stitching'], event: 'stale.detected', to: 'stale', bumps: [] },
  { from: ['stitching'], event: 'seal', to: 'sealed', bumps: ['seals'] },
  { from: ['stitching'], event: 'fail', to: 'failed', bumps: ['failures'] },
  // stale：重试（回采集）、原地修复后继续拼接、失败。
  { from: ['stale'], event: 'capture.progress', to: 'stale', bumps: [] },
  { from: ['stale'], event: 'stale.retry', to: 'capturing', bumps: ['staleRetries'] },
  { from: ['stale'], event: 'stitch.begin', to: 'stitching', bumps: [] },
  { from: ['stale'], event: 'fail', to: 'failed', bumps: ['failures'] },
  // 已封版：只允许记录后续失败（写文件失败等）或显式 reset。
  { from: ['sealed'], event: 'fail', to: 'failed', bumps: ['failures'] },
  // 恢复态：可再封版、可失败、可 reset。
  { from: ['recovered'], event: 'seal', to: 'sealed', bumps: ['seals'] },
  { from: ['recovered'], event: 'fail', to: 'failed', bumps: ['failures'] },
  // 失败态：重复失败幂等，reset 后可重新开始。
  { from: ['failed'], event: 'fail', to: 'failed', bumps: [] },
  // 显式 reset：任何状态回 idle（tab 关闭、会话停止、诊断清理）。
  { from: LONGSHOT_STATE_LIST, event: 'reset', to: 'idle', bumps: ['resets'] },
]);

function buildRuleIndex() {
  const index = new Map();
  for (const rule of TRANSITIONS) {
    for (const from of rule.from) {
      const key = from + '|' + rule.event;
      if (index.has(key)) throw new Error('长截图迁移表重复：' + key);
      index.set(key, rule);
    }
  }
  return index;
}

const RULE_INDEX = buildRuleIndex();

/** 某个状态允许的迁移（拒绝证据里的 allowed 列表、诊断/文档共用）。 */
export function allowedTransitions(from) {
  const state = LONGSHOT_STATE_LIST.includes(from) ? from : LONGSHOT_STATES.IDLE;
  return TRANSITIONS
    .filter((rule) => rule.from.includes(state))
    .map((rule) => ({ event: rule.event, to: rule.to, bumps: rule.bumps.slice() }));
}

/** 迁移表快照（只读），供单测确认没有重复/悬空规则。 */
export function longshotTransitionTable() {
  return TRANSITIONS.map((rule) => ({ from: rule.from.slice(), event: rule.event, to: rule.to, bumps: rule.bumps.slice() }));
}

/** 当前状态是否允许该事件（只看迁移表，不看 guards）。 */
export function canTransition(from, event) {
  return RULE_INDEX.has(String(from) + '|' + String(event));
}

/** sealed/failed 是终态：正常流程不会再自动离开（只能显式 reset）。 */
export function isTerminalLongshotState(state) {
  return state === LONGSHOT_STATES.SEALED || state === LONGSHOT_STATES.FAILED;
}

export function describeLongshotState(state) {
  return STATE_LABELS[state] || '未知状态(' + String(state) + ')';
}

const FACT_KEYS = ['tabId', 'url', 'tiles', 'segments', 'totalSegments', 'sealedSegments', 'attempts', 'maxStaleAttempts', 'hashVerified', 'reason', 'action', 'manifestSealed', 'changed', 'dpr', 'degraded', 'refetched'];

function summarizeFacts(facts) {
  if (!facts || typeof facts !== 'object') return null;
  const summary = {};
  for (const key of FACT_KEYS) {
    if (facts[key] === undefined) continue;
    summary[key] = typeof facts[key] === 'string' ? facts[key].slice(0, 160) : facts[key];
  }
  return Object.keys(summary).length ? summary : null;
}

function normalizeCaptureId(captureId) {
  if (captureId == null) return null;
  const value = String(captureId).trim();
  return value || null;
}

function emptyRun(captureId, now) {
  return {
    captureId,
    state: LONGSHOT_STATES.IDLE,
    since: now,
    event: null,
    tabId: null,
    url: '',
    tiles: 0,
    segments: 0,
    totalSegments: 0,
    sealedSegments: 0,
    attempts: 0,
    staleRetries: 0,
    recoveries: 0,
    seals: 0,
    failures: 0,
    hashVerified: null,
    recovered: false,
    failedReason: null,
    transitions: 0,
    rejected: 0,
    lastRejection: null,
    history: [],
  };
}

function runSnapshot(record) {
  if (!record) return null;
  return {
    captureId: record.captureId,
    state: record.state,
    label: describeLongshotState(record.state),
    since: record.since,
    event: record.event,
    tabId: record.tabId,
    url: record.url,
    tiles: record.tiles,
    segments: record.segments,
    totalSegments: record.totalSegments,
    sealedSegments: record.sealedSegments,
    attempts: record.attempts,
    staleRetries: record.staleRetries,
    recoveries: record.recoveries,
    seals: record.seals,
    failures: record.failures,
    hashVerified: record.hashVerified,
    recovered: record.recovered,
    terminal: isTerminalLongshotState(record.state),
    failedReason: record.failedReason,
    transitions: record.transitions,
    rejected: record.rejected,
    lastRejection: record.lastRejection,
    history: record.history.slice(-8),
  };
}

/**
 * 创建一个长截图状态机。每个实例有独立的时钟/history/上限，便于单测隔离；
 * service worker 里用模块级单例（tiled-capture 的每次截图一个 captureId）。
 */
export function createLongshotStateMachine(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const historyLimit = Number.isInteger(options.historyLimit) && options.historyLimit > 0
    ? options.historyLimit
    : 32;
  const maxRuns = Number.isInteger(options.maxRuns) && options.maxRuns > 0 ? options.maxRuns : 256;
  const defaultMaxStaleAttempts = Number.isInteger(options.maxStaleAttempts) && options.maxStaleAttempts > 0
    ? options.maxStaleAttempts
    : 3;
  const runs = new Map();
  const stats = { transitions: 0, rejected: 0, duplicates: 0, resets: 0, recoveries: 0, seals: 0, failures: 0 };

  function runFor(captureId) {
    const id = normalizeCaptureId(captureId);
    if (!id) return null;
    let record = runs.get(id);
    if (!record) {
      if (runs.size >= maxRuns) {
        const oldest = runs.keys().next().value;
        if (oldest !== undefined) runs.delete(oldest);
      }
      record = emptyRun(id, now());
      runs.set(id, record);
    }
    return record;
  }

  function pushHistory(record, entry) {
    record.history.push(entry);
    if (record.history.length > historyLimit) record.history.splice(0, record.history.length - historyLimit);
  }

  function reject(record, event, to, facts, code, message, inferredTo) {
    const at = now();
    const evidence = {
      captureId: record ? record.captureId : null,
      from: record ? record.state : null,
      to: to == null ? inferredTo : String(to),
      event: String(event || ''),
      allowed: allowedTransitions(record ? record.state : LONGSHOT_STATES.IDLE),
      code,
      error: message,
      at,
      facts: summarizeFacts(facts),
    };
    if (record) {
      record.rejected += 1;
      record.lastRejection = evidence;
      pushHistory(record, { kind: 'reject', event: evidence.event, at, code, from: record.state });
    }
    stats.rejected += 1;
    return {
      ok: false,
      code,
      error: message,
      captureId: record ? record.captureId : null,
      from: evidence.from,
      to: evidence.to,
      event: evidence.event,
      state: runSnapshot(record),
      evidence,
    };
  }

  function applyFacts(record, facts) {
    if (!facts || typeof facts !== 'object') return;
    if (facts.tabId != null && Number.isFinite(Number(facts.tabId))) record.tabId = Math.round(Number(facts.tabId));
    if (facts.url != null) record.url = String(facts.url).slice(0, 2048);
    for (const [fact, field] of [['tiles', 'tiles'], ['segments', 'segments'], ['totalSegments', 'totalSegments'], ['sealedSegments', 'sealedSegments'], ['attempts', 'attempts']]) {
      if (facts[fact] == null) continue;
      const value = Number(facts[fact]);
      if (Number.isFinite(value) && value >= 0) record[field] = Math.round(value);
    }
    if (typeof facts.hashVerified === 'boolean') record.hashVerified = facts.hashVerified;
    if (typeof facts.manifestSealed === 'boolean') record.manifestSealed = facts.manifestSealed;
  }

  function accept(record, rule, event, facts, duplicate) {
    const at = now();
    const from = record.state;
    applyFacts(record, facts);
    if (!duplicate) {
      record.state = rule.to;
      record.since = at;
      record.event = event;
      record.transitions += 1;
      stats.transitions += 1;
      const bumps = Array.isArray(rule.bumps) ? rule.bumps : [];
      if (bumps.includes('staleRetries')) record.staleRetries += 1;
      if (bumps.includes('recoveries')) { record.recoveries += 1; record.recovered = true; stats.recoveries += 1; }
      if (bumps.includes('seals')) { record.seals += 1; stats.seals += 1; }
      if (bumps.includes('failures')) {
        record.failures += 1;
        record.failedReason = facts && facts.reason != null ? String(facts.reason).slice(0, 300) : (record.failedReason || 'unspecified');
        stats.failures += 1;
      }
      if (bumps.includes('resets')) { record.recovered = false; stats.resets += 1; }
      if (event === LONGSHOT_EVENTS.RECOVER_BEGIN) record.recovered = true;
      pushHistory(record, { kind: 'transition', event, at, from, to: rule.to });
    } else {
      stats.duplicates += 1;
    }
    const evidence = {
      captureId: record.captureId,
      from,
      to: record.state,
      event,
      allowed: allowedTransitions(record.state),
      duplicate,
      at,
      facts: summarizeFacts(facts),
    };
    return {
      ok: true,
      duplicate,
      captureId: record.captureId,
      from,
      to: record.state,
      state: runSnapshot(record),
      evidence,
    };
  }

  /** seal/stale.retry 这类需要跨事实校验的闸门；返回 blocked 或 null。 */
  function checkGuard(event, facts, record) {
    if (event === LONGSHOT_EVENTS.CAPTURE_BEGIN) {
      if (facts.tabId == null || !Number.isFinite(Number(facts.tabId))) {
        return { code: 'LONGSHOT_NO_TAB', error: 'capture.begin 需要整数 tabId 作为归属证据', field: 'tabId' };
      }
      return null;
    }
    if (event === LONGSHOT_EVENTS.STITCH_BEGIN) {
      const segments = Number(facts.segments != null ? facts.segments : (facts.tiles != null ? facts.tiles : 1));
      if (!Number.isFinite(segments) || segments < 1) {
        return { code: 'LONGSHOT_NO_SEGMENTS', error: '没有可拼接的分片（segments/tiles 必须 ≥1）', field: 'segments' };
      }
      return null;
    }
    if (event === LONGSHOT_EVENTS.SEAL) {
      const total = Number(facts.totalSegments != null ? facts.totalSegments : record.totalSegments);
      const sealedCount = Number(facts.sealedSegments != null ? facts.sealedSegments : record.sealedSegments);
      if (!Number.isFinite(total) || total < 1) {
        return { code: 'LONGSHOT_NO_TOTAL', error: 'seal 需要 totalSegments ≥ 1', field: 'totalSegments' };
      }
      if (!Number.isFinite(sealedCount) || sealedCount < total) {
        return { code: 'LONGSHOT_INCOMPLETE', error: '还有分片未落盘：' + (Number.isFinite(sealedCount) ? sealedCount : 0) + '/' + total, field: 'sealedSegments' };
      }
      if (facts.hashVerified === false || (facts.hashVerified == null && record.hashVerified === false)) {
        return { code: 'LONGSHOT_HASH_UNVERIFIED', error: '分片 hash 校验未通过，不能封版', field: 'hashVerified' };
      }
      return null;
    }
    if (event === LONGSHOT_EVENTS.STALE_RETRY) {
      const maxAttempts = Number.isFinite(Number(facts.maxStaleAttempts)) && Number(facts.maxStaleAttempts) > 0
        ? Math.round(Number(facts.maxStaleAttempts))
        : defaultMaxStaleAttempts;
      const attempts = Number.isFinite(Number(facts.attempts)) && Number(facts.attempts) > 0
        ? Math.round(Number(facts.attempts))
        : record.staleRetries + 1;
      if (attempts >= maxAttempts) {
        return { code: 'LONGSHOT_STALE_BUDGET', error: 'stale 重试次数 ' + attempts + ' 已达上限 ' + maxAttempts, field: 'attempts' };
      }
      return null;
    }
    if (event === LONGSHOT_EVENTS.RECOVER_BEGIN) {
      if (facts.manifestSealed === true) {
        return { code: 'LONGSHOT_ALREADY_SEALED', error: 'manifest 已封版，不需要恢复', field: 'manifestSealed' };
      }
      if (facts.tiles != null && !(Number(facts.tiles) > 0)) {
        return { code: 'LONGSHOT_NO_TILES', error: '没有可恢复的已落盘分片', field: 'tiles' };
      }
      return null;
    }
    return null;
  }

  /**
   * 迁移一次。两种调用方式都支持：
   *   transition(captureId, 'capture.begin', { tabId, url })
   *   transition(captureId, { event: 'stale.retry', attempts: 2, maxStaleAttempts: 3 })
   */
  function transition(captureId, eventOrOptions, factsInput = {}) {
    const record = runFor(captureId);
    if (!record) {
      return reject(null, typeof eventOrOptions === 'string' ? eventOrOptions : (eventOrOptions && eventOrOptions.event), null, factsInput, 'E_BAD_ARG', '长截图状态迁移需要非空 captureId', null);
    }
    const optionsObject = eventOrOptions && typeof eventOrOptions === 'object' ? eventOrOptions : null;
    const event = optionsObject ? String(optionsObject.event || '') : String(eventOrOptions || '');
    const facts = optionsObject ? { ...optionsObject, ...(factsInput || {}) } : { ...(factsInput || {}) };
    if (!event) {
      return reject(record, '', null, facts, 'E_BAD_ARG', '长截图状态迁移缺少 event', null);
    }
    const rule = RULE_INDEX.get(record.state + '|' + event);
    if (!rule) {
      return reject(
        record,
        event,
        facts.to,
        facts,
        'LONGSHOT_TRANSITION',
        '非法长截图迁移：' + record.state + ' -[' + event + ']-> ' + (facts.to || '?'),
        facts.to || null,
      );
    }
    const blocked = checkGuard(event, facts, record);
    if (blocked) {
      return reject(record, event, rule.to, facts, blocked.code, blocked.error, rule.to);
    }
    const duplicate = rule.to === record.state && record.event === event;
    return accept(record, rule, event, facts, duplicate);
  }

  function snapshot(captureId) {
    const id = normalizeCaptureId(captureId);
    if (!id) return null;
    return runSnapshot(runs.get(id));
  }

  function get(captureId) {
    const record = runFor(captureId);
    return record ? record.state : null;
  }

  function history(captureId) {
    const record = runFor(captureId);
    return record ? record.history.slice() : [];
  }

  function list() {
    return [...runs.keys()].map((id) => runSnapshot(runs.get(id)));
  }

  function counters() {
    const states = {};
    for (const record of runs.values()) states[record.state] = (states[record.state] || 0) + 1;
    return { ...stats, runs: runs.size, states };
  }

  function clear(captureId) {
    const id = normalizeCaptureId(captureId);
    if (!id) return false;
    return runs.delete(id);
  }

  function isTerminal(captureId) {
    const record = runFor(captureId);
    return record ? isTerminalLongshotState(record.state) : false;
  }

  /** 把一次运行收敛成协议/日志可用的紧凑证据（无历史数组）。 */
  function evidence(captureId) {
    const state = snapshot(captureId);
    if (!state) return null;
    return {
      captureId: state.captureId,
      state: state.state,
      label: state.label,
      from: state.lastRejection ? state.lastRejection.from : null,
      to: state.state,
      event: state.event,
      terminal: state.terminal,
      tiles: state.tiles,
      segments: state.segments,
      staleRetries: state.staleRetries,
      sealedSegments: state.sealedSegments,
      totalSegments: state.totalSegments,
      hashVerified: state.hashVerified,
      recovered: state.recovered,
      rejected: state.rejected,
      transitions: state.transitions,
    };
  }

  return { transition, snapshot, get, history, list, counters, clear, isTerminal, evidence, allowedTransitions };
}

/** service worker 共享单例：tiled-capture / longshot-recover 的每次截图都登记在这里。 */
export const longshotRuns = createLongshotStateMachine();
