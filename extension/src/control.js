// src/control.js —— 共享控制：sync 产出 context/observation，动作校验与失效
import { bridgeError } from './errors.js';
import { execPage } from './inject.js';
import { log } from './log.js';
import { sleep } from './tabs.js';
import { getTakeoverState } from './takeover.js';

const TAB_METHODS = new Set([
  'click', 'hover', 'fill', 'press', 'select', 'focus', 'blur', 'scroll-to',
  'drag', 'wheel', 'evaluate', 'upload', 'download',
]);

const states = new Map(); // tabId -> { policy, contextId, observationId, generation, strictUsed }

function foldObservation(text, needle, contextLines) {
  if (!needle) return text;
  const lines = String(text || '').split('\n');
  const context = Math.min(Math.max(Number(contextLines) || 0, 0), 20);
  const keep = new Set();
  const lowered = String(needle).toLowerCase();
  lines.forEach((line, index) => {
    if (!line.toLowerCase().includes(lowered)) return;
    for (let offset = -context; offset <= context; offset += 1) {
      const target = index + offset;
      if (target >= 0 && target < lines.length) keep.add(target);
    }
  });
  if (!keep.size) return text;
  const out = [];
  let omitted = 0;
  lines.forEach((line, index) => {
    if (keep.has(index)) {
      if (omitted) {
        out.push('… (' + omitted + ' lines omitted)');
        omitted = 0;
      }
      out.push(line);
    } else {
      omitted += 1;
    }
  });
  if (omitted) out.push('… (' + omitted + ' lines omitted)');
  return out.join('\n');
}

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(16).slice(2);
}

function ensure(tabId) {
  let state = states.get(tabId);
  if (!state) {
    state = { policy: 'target', contextId: null, observationId: null, generation: 0, strictUsed: new Set() };
    states.set(tabId, state);
  }
  return state;
}

/** cooperate.sync：观测一次并签发 context_id / observation_id。 */
export async function cooperateSync(params = {}) {
  const tabId = params.tabId;
  if (!Number.isInteger(tabId)) throw bridgeError('E_BAD_ARG', 'cooperate.sync 需要 tabId');
  const state = ensure(tabId);
  const requested = params.policy === 'strict'
    ? 'strict'
    : (params.policy === 'target' || params.policy === 'auto')
      ? 'target'
      : state.policy;
  state.policy = requested;
  const observation = await execPage(tabId, 'observe', { probeHover: params.probeHover === true });
  const media = await execPage(tabId, 'media-progress', {}).catch(() => null);
  state.contextId = uuid();
  state.observationId = uuid();
  state.generation += 1;
  state.strictUsed = new Set();
  state.observedAt = Date.now();
  log('cooperate sync tab=' + tabId + ' policy=' + state.policy + ' context=' + state.contextId);
  return {
    control_policy: state.policy,
    context_id: state.contextId,
    observation_id: state.observationId,
    generation: state.generation,
    url: observation.url,
    title: observation.title,
    media,
    evidence: {
      observedAt: state.observedAt,
      url: observation.url,
      title: observation.title,
      refs: observation.refs,
      generation: state.generation,
      contextId: state.contextId,
      observationId: state.observationId,
      mediaPlaying: media ? media.playing : 0,
    },
    observation: {
      observation_id: state.observationId,
      text: foldObservation(observation.observation, params.matchText, params.contextLines),
      refs: observation.refs,
    },
  };
}

/** cooperate.wait：等到人工停止操作（默认立即返回当前状态）。 */
export async function cooperateWait(params = {}) {
  const tabId = params.tabId;
  const state = Number.isInteger(tabId) ? states.get(tabId) : null;
  const base = {
    control_policy: state ? state.policy : null,
    context_id: state ? state.contextId : null,
    observation_id: state ? state.observationId : null,
  };
  if (!Number.isInteger(tabId)) return { state: { mode: 'ready' }, ready: true, ...base };
  const timeout = Math.min(Math.max(Number(params.timeoutMs) || 0, 0), 30000);
  const started = Date.now();
  const clearedAt = state ? state.humanClearedAt || 0 : 0;
  while (true) {
    const activity = await execPage(tabId, 'human-activity', {}).catch(() => null);
    const last = Number(activity && activity.lastInputAt) || 0;
    const active = Boolean(activity && activity.active) && last > clearedAt;
    if (!active) {
      return { state: { mode: 'ready' }, ready: true, waitedMs: Date.now() - started, ...base };
    }
    if (Date.now() - started >= timeout) {
      return { state: { mode: 'human' }, ready: false, waitedMs: Date.now() - started, ...base };
    }
    await sleep(250);
  }
}

/** 动作前的授权校验：context / observation。 */
export function checkControl(params = {}) {
  const tabId = params.tabId;
  if (!Number.isInteger(tabId)) return;
  const takeover = getTakeoverState(tabId);
  if (takeover && takeover.paused === true && TAB_METHODS.has(String(params.method || ''))) {
    throw bridgeError('E_SESSION_PAUSED', '人工接管中：请先在浮层点“交给 Agent”或执行 cooperate handback');
  }
  const state = states.get(tabId);
  if (state && state.policy === 'strict' && params.context == null && (params.ref || params.selector)) {
    throw bridgeError('E_CONTEXT_REQUIRED', 'strict 策略下 DOM 动作必须带 --context（先 cooperate sync 获取）');
  }
  if (params.context != null) {
    if (!state || state.contextId == null) {
      throw bridgeError('E_CONTEXT_STALE', 'context 已失效（页面导航或会话重建），请重新 cooperate sync');
    }
    if (state.policy === 'strict' && state.strictUsed.has(params.context)) {
      throw bridgeError('E_CONTEXT_STALE', '该 context 在 strict 策略下已用过，请重新 cooperate sync');
    }
    if (String(params.context) !== state.contextId) {
      throw bridgeError('E_CONTEXT_STALE', 'context 已失效（页面变化或已重新 sync），请重新 cooperate sync');
    }
    if (state.policy === 'strict') state.strictUsed.add(String(params.context));
  }
  if (params.observation != null) {
    if (!state || state.observationId == null || String(params.observation) !== state.observationId) {
      throw bridgeError('E_OBSERVATION_STALE', 'observation 已失效，请重新 cooperate sync');
    }
  }
}

/** cooperate.handback：人工主动把控制权交回 agent。 */
export function cooperateHandback(params = {}) {
  const tabId = params.tabId;
  if (!Number.isInteger(tabId)) throw bridgeError('E_BAD_ARG', 'cooperate.handback 需要 tabId');
  const state = ensure(tabId);
  state.humanClearedAt = Date.now();
  return {
    ok: true,
    state: { mode: 'ready' },
    handedBackAt: state.humanClearedAt,
    context_id: state.contextId,
    observation_id: state.observationId,
  };
}

/** 导航/文档替换会吊销 context。 */
export function noteNavigation(tabId) {
  const state = states.get(tabId);
  if (!state) return;
  state.contextId = null;
  state.observationId = null;
  state.generation += 1;
  state.strictUsed = new Set();
  log('cooperate context 已因导航失效 tab=' + tabId);
}

export function forgetControl(tabId) {
  states.delete(tabId);
}

export { TAB_METHODS };
