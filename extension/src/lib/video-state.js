// extension/src/lib/video-state.js —— 视频录制生命周期状态机（纯函数 + 可注入时钟）。
//
// 迁移表：
//   idle ──start──▶ recording ⇄pause/resume⇄ paused ──stop──▶ finalizing ──seal──▶ sealed
//                     │                        │                  │
//                     ├──────────── fail ──────┴──────────────────┴──▶ failed
//                     └──────────── recover（崩溃恢复 / 部分收尾）──▶ recovered
//   sealed / recovered / failed 是终态；start 允许从终态开始新录制，reset 回到 idle。
//
// 设计要点：
// 1) 非法迁移不抛异常，返回 `{ok:false, code, allowed_events, evidence}`（code 见 video-codes.js），
//    由调用方（video.start/stop/status/recover）决定如何呈报；被拒绝的迁移同样留证据。
// 2) paused 期间不计入 duration_ms；resume 累计 paused_ms / resume_count，便于预算与报告。
// 3) snapshot() 可持久化到 chrome.storage.local（`bb.video.state`）并在 Service Worker 重启后
//    restoreVideoStateMachine() 还原；坏快照返回结构化证据并回退到全新 idle 机器。
// 4) 机器本身不触碰 chrome/DB/OPFS，全部由调用方注入，因此可在 node:test 里完整驱动。

import { VIDEO_STATE_ERRORS, VIDEO_STATE_NOTES } from './video-codes.js';

export { VIDEO_STATE_ERRORS };

export const VIDEO_STATE_VERSION = 1;
export const VIDEO_STATES = Object.freeze([
  'idle',
  'recording',
  'paused',
  'finalizing',
  'sealed',
  'recovered',
  'failed',
]);
export const VIDEO_TERMINAL_STATES = Object.freeze(['sealed', 'recovered', 'failed']);
export const VIDEO_ACTIVE_STATES = Object.freeze(['recording', 'paused', 'finalizing']);

/** 事件 → { 来源状态: 目标状态 }。表是唯一事实来源，allowedEventsFor 由此派生。 */
const TRANSITIONS = Object.freeze({
  start: Object.freeze({ idle: 'recording', sealed: 'recording', recovered: 'recording', failed: 'recording' }),
  pause: Object.freeze({ recording: 'paused' }),
  resume: Object.freeze({ paused: 'recording' }),
  stop: Object.freeze({ recording: 'finalizing', paused: 'finalizing' }),
  seal: Object.freeze({ finalizing: 'sealed' }),
  recover: Object.freeze({ idle: 'recovered', recording: 'recovered', paused: 'recovered', finalizing: 'recovered' }),
  fail: Object.freeze({ idle: 'failed', recording: 'failed', paused: 'failed', finalizing: 'failed' }),
  reset: Object.freeze({ idle: 'idle', sealed: 'idle', recovered: 'idle', failed: 'idle' }),
});
export const VIDEO_EVENTS = Object.freeze(Object.keys(TRANSITIONS));

const DEFAULT_HISTORY_LIMIT = 48;
const MAX_DETAIL_KEYS = 16;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteInt(value, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/** 迁移表副本（报告/文档/测试用，避免调用方修改内部冻结表）。 */
export function transitionTable() {
  const table = {};
  for (const event of VIDEO_EVENTS) table[event] = { ...TRANSITIONS[event] };
  return table;
}

export function isKnownState(state) {
  return VIDEO_STATES.includes(String(state));
}

export function isTerminalState(state) {
  return VIDEO_TERMINAL_STATES.includes(String(state));
}

export function isActiveState(state) {
  return VIDEO_ACTIVE_STATES.includes(String(state));
}

/** 给定状态与事件，返回目标状态；非法迁移返回空串。 */
export function nextStateFor(state, event) {
  const row = TRANSITIONS[String(event)];
  if (!row) return '';
  return row[String(state)] || '';
}

export function canTransition(state, event) {
  return nextStateFor(state, event) !== '';
}

export function allowedEventsFor(state) {
  return VIDEO_EVENTS.filter((event) => nextStateFor(state, event) !== '');
}

/** 只保留 JSON 可序列化的浅层字段，避免 Error/Blob 等把持久化快照撑坏。 */
function plainDetail(detail) {
  if (!isPlainObject(detail)) return {};
  const out = {};
  let keys = 0;
  for (const [key, value] of Object.entries(detail)) {
    if (keys >= MAX_DETAIL_KEYS) break;
    if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    } else if (Array.isArray(value)) {
      out[key] = value.slice(0, 20).map((item) => (isPlainObject(item) || Array.isArray(item) ? '[object]' : item));
    } else if (typeof value === 'object') {
      out[key] = '[object]';
    } else {
      out[key] = String(value);
    }
    keys += 1;
  }
  return out;
}

function trim(list, limit) {
  while (list.length > limit) list.shift();
  return list;
}

function sanitizeTransition(entry) {
  if (!isPlainObject(entry)) return null;
  const from = String(entry.from || '');
  const to = String(entry.to || '');
  const event = String(entry.event || '');
  if (!VIDEO_STATES.includes(from) || !VIDEO_STATES.includes(to) || !VIDEO_EVENTS.includes(event)) return null;
  return {
    revision: finiteInt(entry.revision),
    from,
    to,
    event,
    at: finiteInt(entry.at),
    duration_ms: finiteInt(entry.duration_ms),
    ...(isPlainObject(entry.detail) ? { detail: plainDetail(entry.detail) } : {}),
  };
}

/**
 * 创建录制状态机。
 * 可注入：now()、historyLimit、onTransition(entry, snapshot)；initial/startedAt/... 用于恢复。
 */
export function createVideoStateMachine(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const historyLimit = finiteInt(options.historyLimit, 0) || DEFAULT_HISTORY_LIMIT;
  const onTransition = typeof options.onTransition === 'function' ? options.onTransition : null;
  const id = String(options.id || '');
  const transitions = [];
  const rejected = [];

  let state = 'idle';
  let revision = finiteInt(options.revision);
  let startedAt = finiteInt(options.startedAt);
  let endedAt = finiteInt(options.endedAt);
  let pausedAt = finiteInt(options.pausedAt);
  let pausedTotalMs = finiteInt(options.pausedTotalMs);
  let pauseCount = finiteInt(options.pauseCount);
  let resumeCount = finiteInt(options.resumeCount);
  let stopReason = options.stopReason ? String(options.stopReason) : null;
  let sealReason = options.sealReason ? String(options.sealReason) : null;
  let lastError = options.lastError ? String(options.lastError) : null;

  const initial = String(options.initial || 'idle');
  if (VIDEO_STATES.includes(initial)) {
    state = initial;
  } else {
    rejected.push({
      revision,
      from: 'idle',
      event: 'restore',
      to: null,
      at: finiteInt(options.at, Math.max(0, Math.floor(now()))),
      code: VIDEO_STATE_ERRORS.BAD_SNAPSHOT,
      allowed_events: allowedEventsFor('idle'),
      detail: { initial },
    });
  }
  if (Array.isArray(options.transitions)) {
    for (const entry of options.transitions.slice(-historyLimit)) {
      const clean = sanitizeTransition(entry);
      if (clean) transitions.push(clean);
    }
  }
  if (Array.isArray(options.rejected)) {
    for (const entry of options.rejected.slice(-historyLimit)) {
      if (isPlainObject(entry)) rejected.push(entry);
    }
  }

  function elapsedMs(at = now()) {
    if (!startedAt) return 0;
    const end = endedAt || at;
    const extraPause = pausedAt && !endedAt ? Math.max(0, end - pausedAt) : 0;
    return Math.max(0, end - startedAt - pausedTotalMs - extraPause);
  }

  function pausedMs(at = now()) {
    const extraPause = pausedAt && !endedAt ? Math.max(0, at - pausedAt) : 0;
    return pausedTotalMs + extraPause;
  }

  function snapshot() {
    const at = now();
    return {
      version: VIDEO_STATE_VERSION,
      id,
      state,
      revision,
      startedAt,
      endedAt,
      pausedAt,
      pausedTotalMs,
      pauseCount,
      resumeCount,
      stopReason,
      sealReason,
      lastError,
      duration_ms: elapsedMs(at),
      paused_ms: pausedMs(at),
      allowed_events: allowedEventsFor(state),
      terminal: isTerminalState(state),
      transitions: transitions.slice(-historyLimit),
      rejected: rejected.slice(-historyLimit),
    };
  }

  function reject(event, at, detail, code = VIDEO_STATE_ERRORS.ILLEGAL_TRANSITION) {
    const entry = {
      revision,
      from: state,
      event: String(event),
      to: null,
      at,
      code,
      allowed_events: allowedEventsFor(state),
      detail: plainDetail(detail),
    };
    rejected.push(entry);
    trim(rejected, historyLimit);
    return {
      ok: false,
      code,
      from: state,
      event: String(event),
      to: null,
      at,
      allowed_events: entry.allowed_events,
      evidence: entry,
      state,
      snapshot: snapshot(),
    };
  }

  function apply(event, at, detail) {
    if (event === 'start') {
      startedAt = at;
      endedAt = 0;
      pausedAt = 0;
      pausedTotalMs = 0;
      pauseCount = 0;
      resumeCount = 0;
      stopReason = null;
      sealReason = null;
      lastError = null;
      return;
    }
    if (event === 'pause') {
      if (!pausedAt) {
        pausedAt = at;
        pauseCount += 1;
      }
      return;
    }
    if (event === 'resume') {
      if (pausedAt) {
        pausedTotalMs += Math.max(0, at - pausedAt);
        pausedAt = 0;
        resumeCount += 1;
      }
      return;
    }
    if (event === 'stop') {
      if (pausedAt) {
        pausedTotalMs += Math.max(0, at - pausedAt);
        pausedAt = 0;
      }
      stopReason = String((detail && detail.reason) || 'user');
      return;
    }
    if (event === 'seal') {
      endedAt = at;
      sealReason = detail && detail.reason ? String(detail.reason) : 'sealed';
      return;
    }
    if (event === 'recover') {
      endedAt = at;
      stopReason = 'recovered';
      return;
    }
    if (event === 'fail') {
      endedAt = at;
      stopReason = String((detail && detail.reason) || 'failed');
      lastError = detail && detail.error ? String(detail.error) : lastError;
      return;
    }
    if (event === 'reset') {
      startedAt = 0;
      endedAt = 0;
      pausedAt = 0;
      pausedTotalMs = 0;
      pauseCount = 0;
      resumeCount = 0;
      stopReason = null;
      sealReason = null;
      lastError = null;
    }
  }

  /** 发送事件。成功返回迁移证据；失败返回结构化拒绝（不抛异常）。 */
  function send(event, detail = {}) {
    const at = finiteInt(detail && detail.at, 0) || Math.max(0, Math.floor(now()));
    const key = String(event || '');
    if (!VIDEO_EVENTS.includes(key)) return reject(key, at, detail, VIDEO_STATE_ERRORS.UNKNOWN_EVENT);
    const to = nextStateFor(state, key);
    if (!to) return reject(key, at, detail);
    const from = state;
    apply(key, at, detail);
    state = to;
    revision += 1;
    const entry = {
      revision,
      from,
      to,
      event: key,
      at,
      duration_ms: elapsedMs(at),
      paused_ms: pausedMs(at),
      ...(isPlainObject(detail) ? { detail: plainDetail(detail) } : {}),
    };
    transitions.push(entry);
    trim(transitions, historyLimit);
    if (onTransition) {
      try {
        onTransition(entry, snapshot());
      } catch {
        // 观察者异常不得影响状态机
      }
    }
    return { ok: true, ...entry, state, snapshot: snapshot() };
  }

  /** 记录一条失败证据但不迁移状态（用于捕获非状态机的内部错误）。 */
  function annotate(code, detail = {}) {
    const at = Math.max(0, Math.floor(now()));
    rejected.push({ revision, from: state, event: 'annotate', to: null, at, code: String(code || VIDEO_STATE_NOTES.NOTE), detail: plainDetail(detail) });
    trim(rejected, historyLimit);
    return snapshot();
  }

  function toRecordFields() {
    const at = now();
    return {
      recording_state: state,
      recording_state_version: VIDEO_STATE_VERSION,
      recording_state_revision: revision,
      duration_ms: elapsedMs(at),
      paused_ms: pausedMs(at),
      pause_count: pauseCount,
      resume_count: resumeCount,
      ...(stopReason ? { recording_stop_reason: stopReason } : {}),
      ...(sealReason ? { recording_seal_reason: sealReason } : {}),
      ...(lastError ? { recording_error: lastError } : {}),
      recording_state_evidence: transitions.slice(-12),
    };
  }

  return {
    id,
    get state() {
      return state;
    },
    get revision() {
      return revision;
    },
    can: (event) => canTransition(state, event),
    send,
    annotate,
    snapshot,
    elapsedMs,
    pausedMs,
    toRecordFields,
  };
}

/**
 * 从持久化快照恢复机器。坏快照/未知状态返回 ok:false + code（见 video-codes.js），
 * 同时给出一个可继续使用的全新 idle 机器（绝不把坏状态带进运行时）。
 */
export function restoreVideoStateMachine(snapshot, options = {}) {
  if (!isPlainObject(snapshot)) {
    return {
      ok: false,
      restored: false,
      code: VIDEO_STATE_ERRORS.BAD_SNAPSHOT,
      evidence: { code: VIDEO_STATE_ERRORS.BAD_SNAPSHOT, reason: 'missing_snapshot' },
      machine: createVideoStateMachine(options),
    };
  }
  const state = String(snapshot.state || '');
  if (!VIDEO_STATES.includes(state)) {
    return {
      ok: false,
      restored: false,
      code: VIDEO_STATE_ERRORS.BAD_SNAPSHOT,
      evidence: { code: VIDEO_STATE_ERRORS.BAD_SNAPSHOT, reason: 'unknown_state', state },
      machine: createVideoStateMachine(options),
    };
  }
  const machine = createVideoStateMachine({
    ...options,
    id: options.id || snapshot.id,
    initial: state,
    startedAt: snapshot.startedAt,
    endedAt: snapshot.endedAt,
    pausedAt: snapshot.pausedAt,
    pausedTotalMs: snapshot.pausedTotalMs,
    pauseCount: snapshot.pauseCount,
    resumeCount: snapshot.resumeCount,
    stopReason: snapshot.stopReason,
    sealReason: snapshot.sealReason,
    lastError: snapshot.lastError,
    revision: snapshot.revision,
    transitions: snapshot.transitions,
    rejected: snapshot.rejected,
  });
  return { ok: true, restored: true, machine, evidence: { code: VIDEO_STATE_NOTES.STATE_RESTORED, state, revision: finiteInt(snapshot.revision) } };
}

/**
 * 从已落库录制推断状态（兼容没有 recording_state 的旧记录）。
 * 注意：`completeness:'partial'` 的旧记录按 recovered 处理（收尾未 seal）。
 */
export function recordingStateOf(record) {
  if (!record || typeof record !== 'object') return 'idle';
  const explicit = String(record.recording_state || '');
  if (VIDEO_STATES.includes(explicit)) return explicit;
  if (record.recovered === true) return 'recovered';
  if (record.failed === true) return 'failed';
  if (record.completeness === 'complete') return 'sealed';
  if (record.completeness === 'partial') return 'recovered';
  if (Number(record.bytes) > 0) return 'sealed';
  return 'failed';
}

/** 录制状态证据（对外报告用；只摘关键字段，不回传整段历史之外的大对象）。 */
export function stateEvidenceOf(record, limit = 8) {
  if (!record || typeof record !== 'object') return [];
  const evidence = Array.isArray(record.recording_state_evidence) ? record.recording_state_evidence : [];
  return evidence.slice(-Math.max(1, finiteInt(limit, 8)));
}

/** 供报告输出的紧凑摘要（不暴露 transition detail 大对象）。 */
export function summarizeStateMachine(machine) {
  if (!machine || typeof machine.snapshot !== 'function') return null;
  const snapshot = machine.snapshot();
  return {
    state: snapshot.state,
    revision: snapshot.revision,
    duration_ms: snapshot.duration_ms,
    paused_ms: snapshot.paused_ms,
    pause_count: snapshot.pauseCount,
    resume_count: snapshot.resumeCount,
    terminal: snapshot.terminal,
    allowed_events: snapshot.allowed_events,
    transitions: snapshot.transitions.length,
    rejected: snapshot.rejected.length,
    ...(snapshot.stopReason ? { stop_reason: snapshot.stopReason } : {}),
    ...(snapshot.lastError ? { error: snapshot.lastError } : {}),
  };
}
