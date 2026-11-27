// ui/lib/states.js —— 加载/错误/空态的纯状态模型（无 DOM）。
//
// 页面里「正在读取… / 读取失败 / 没有记录」散落在各个 load 函数里并且文案不一致；
// 这里统一成一个状态机：loading → ready | error | empty。页面把状态模型渲染成
// 一行状态文本 +（错误时）重试按钮，aria-live 播报由 dom.js 统一挂。
//
// 纯函数：stale 判定、可见性、aria 文本全部可 Node 单测。

import { formatLabel } from './labels.js';
import { describeError } from '../error-hints.js';

export const VIEW_STATES = Object.freeze(['idle', 'loading', 'ready', 'empty', 'error']);

/** 计算某状态下的文案与可见性。 */
export function stateModel(kind, { lang = 'zh', error, retryLabel, detail, total } = {}) {
  const state = VIEW_STATES.includes(kind) ? kind : 'idle';
  const resolvedLang = lang;
  const showRetry = state === 'error';
  const base = {
    kind: state,
    busy: state === 'loading',
    visible: state !== 'ready' && state !== 'idle',
    showRetry,
    lang: resolvedLang,
  };
  if (state === 'loading') {
    return {
      ...base,
      text: formatLabel('state.loading', {}, resolvedLang),
      aria: formatLabel('a11y.loading', {}, resolvedLang),
      tone: 'muted',
    };
  }
  if (state === 'empty') {
    return {
      ...base,
      text: detail || formatLabel('state.empty', {}, resolvedLang),
      aria: formatLabel('a11y.empty', {}, resolvedLang),
      tone: 'muted',
    };
  }
  if (state === 'error') {
    const localized = detail || describeError(error, lang).text;
    return {
      ...base,
      text: localized || formatLabel('state.error', {}, resolvedLang),
      aria: formatLabel('a11y.error', {}, resolvedLang),
      tone: 'err',
      retryText: retryLabel || formatLabel('state.retry', {}, resolvedLang),
      code: error && typeof error === 'object' && error.code ? error.code : (typeof error === 'string' ? error : null),
    };
  }
  if (state === 'ready') {
    return {
      ...base,
      text: total === undefined ? '' : String(total),
      aria: '',
      tone: '',
    };
  }
  return { ...base, text: '', aria: '', tone: 'muted', visible: false };
}

/** 从一次调用结果推状态：空数组 → empty，错误 → error，其余 ready。 */
export function stateFromResult(result, { items, loading = false } = {}) {
  if (loading) return 'loading';
  if (result && result.ok === false) return 'error';
  const list = Array.isArray(items) ? items : [];
  return list.length ? 'ready' : 'empty';
}

/** 状态机：只允许合法迁移，避免「loading 中又被置成 empty」闪烁。 */
export function createStateMachine({ initial = 'idle', onChange } = {}) {
  let current = VIEW_STATES.includes(initial) ? initial : 'idle';
  let lastError = null;
  let updatedAt = 0;
  const emit = () => {
    if (typeof onChange === 'function') {
      try { onChange({ state: current, error: lastError, updatedAt }); } catch { /* 忽略 */ }
    }
  };
  return {
    get state() { return current; },
    get error() { return lastError; },
    get updatedAt() { return updatedAt; },
    set(next, error) {
      if (!VIEW_STATES.includes(next)) return current;
      if (next === current && error === lastError) return current;
      current = next;
      lastError = next === 'error' ? (error || lastError) : null;
      updatedAt = Date.now();
      emit();
      return current;
    },
    loading() { return this.set('loading'); },
    ready() { return this.set('ready'); },
    empty() { return this.set('empty'); },
    fail(error) { return this.set('error', error); },
    idle() { return this.set('idle'); },
    is(kind) { return current === kind; },
  };
}

/** 数据新鲜度：超过 ttl 视为过期（页面显示「可能已过期」）。 */
export function isStale(updatedAt, { ttlMs = 60_000, now = Date.now() } = {}) {
  const stamp = Number(updatedAt);
  if (!Number.isFinite(stamp) || stamp <= 0) return false;
  return Number(now) - stamp > Math.max(0, Number(ttlMs) || 0);
}

/** 空态的可选行动作：不同表面给不同按钮（refresh / start capture）。 */
export function emptyActions(surface, lang = 'zh') {
  const map = {
    debug: [{ key: 'refresh', label: formatLabel('state.retry', {}, lang) }],
    audit: [{ key: 'refresh', label: formatLabel('state.retry', {}, lang) }],
    ops: [{ key: 'refresh', label: formatLabel('state.retry', {}, lang) }],
    record: [{ key: 'refresh', label: formatLabel('state.retry', {}, lang) }],
    longshot: [{ key: 'refresh', label: formatLabel('state.retry', {}, lang) }],
  };
  return map[surface] || [];
}

/** 多区块状态聚合：任一块 error → error，全部 empty → empty，否则 ready。 */
export function aggregateStates(states) {
  const list = Array.isArray(states) ? states.filter((state) => VIEW_STATES.includes(state)) : [];
  if (list.some((state) => state === 'error')) return 'error';
  if (list.some((state) => state === 'loading')) return 'loading';
  if (list.length && list.every((state) => state === 'empty')) return 'empty';
  if (list.some((state) => state === 'ready')) return 'ready';
  return 'idle';
}
