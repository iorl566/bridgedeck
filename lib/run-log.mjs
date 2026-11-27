// lib/run-log.mjs —— 会话级运行日志（session run log）。
//
// 目的（run_log）：daemon 看到整个会话的步骤，把一次成功的操作
// 沉淀成 recipe 草稿。只保存**可回放的目标描述**，绝不保存输入值：
// - navigate：只留 origin + pathname，query/hash 丢弃（可能含数据）；
// - action：method + target {ref, stableRef, role, name, selector, text} + frameId + revision；
// - 上限：200 步 / 8000 refs；会话结束即释放（内存）。

export const RUN_LOG_LIMITS = Object.freeze({ steps: 200, refs: 8000 });

const NAVIGATE_METHODS = new Set(['navigate', 'reload', 'navigate-back', 'navigate-forward']);
const ACTION_METHODS = new Set([
  'click', 'hover', 'focus', 'fill', 'press', 'select', 'upload', 'drag', 'wheel', 'blur',
  'click-backend', 'shadow.click', 'evaluate',
]);
// 显式排除不会进入 recipe 的方法（值/敏感输入无法回放，evaluate 也不适合）。
const NON_REPLAYABLE = new Set(['evaluate', 'upload']);

function safeUrlParts(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return {
      origin: url.origin,
      path: url.pathname,
      dropped_query: url.search.length > 1,
    };
  } catch {
    return null;
  }
}

function safeTarget(target) {
  if (!target || typeof target !== 'object') return null;
  const out = {};
  for (const key of ['ref', 'stableRef', 'role', 'name', 'selector', 'text']) {
    const value = target[key];
    if (typeof value === 'string' && value) out[key] = value.slice(0, 160);
  }
  return Object.keys(out).length ? out : null;
}

function targetRefKey(target) {
  if (!target) return null;
  return target.stableRef || target.selector || target.ref || (target.name ? 'name:' + target.name : null);
}

export class SessionRunLog {
  constructor({ limits = {}, now = () => Date.now() } = {}) {
    this.maxSteps = Math.max(1, Number(limits.steps) || RUN_LOG_LIMITS.steps);
    this.maxRefs = Math.max(1, Number(limits.refs) || RUN_LOG_LIMITS.refs);
    this.now = now;
    this.steps = [];
    this.refs = new Set();
    this.truncated = false;
    this.dropped = 0;
  }

  /**
   * @param {{method:string, tabId?:number, frameId?:number, url?:string, target?:object,
   *   revision?:number|null, effectState?:string, ok?:boolean, code?:string}} entry
   * @returns {object|null} 记录下的步骤（未记录返回 null）
   */
  record(entry = {}) {
    const method = String(entry.method || '');
    if (!NAVIGATE_METHODS.has(method) && !ACTION_METHODS.has(method)) return null;
    const at = Number.isFinite(entry.at) ? entry.at : this.now();
    let step = null;
    if (NAVIGATE_METHODS.has(method)) {
      const parts = safeUrlParts(entry.url);
      if (!parts) return null;
      step = {
        kind: 'navigate',
        method,
        ...parts,
        at,
        ok: entry.ok !== false,
        tabId: Number.isInteger(entry.tabId) ? entry.tabId : null,
        frameId: 0,
      };
    } else {
      const target = safeTarget(entry.target);
      if (!target) return null;
      const refKey = targetRefKey(target);
      if (refKey && this.refs.size < this.maxRefs) this.refs.add(refKey);
      step = {
        kind: 'action',
        method,
        target,
        replayable: !NON_REPLAYABLE.has(method) && Boolean(target.selector || target.text || target.name),
        at,
        ok: entry.ok !== false,
        tabId: Number.isInteger(entry.tabId) ? entry.tabId : null,
        frameId: Number.isInteger(entry.frameId) ? entry.frameId : 0,
        revision: Number.isInteger(entry.revision) ? entry.revision : null,
        effectState: entry.effectState ? String(entry.effectState) : 'committed',
        ...(entry.code ? { code: String(entry.code) } : {}),
      };
    }
    if (this.steps.length >= this.maxSteps) {
      this.truncated = true;
      this.dropped += 1;
      return null;
    }
    this.steps.push(step);
    return step;
  }

  snapshot({ limit } = {}) {
    const wanted = Number.isFinite(Number(limit)) && Number(limit) > 0
      ? Math.min(Math.floor(Number(limit)), this.maxSteps)
      : this.maxSteps;
    const steps = this.steps.slice(-wanted);
    return {
      steps,
      count: steps.length,
      total: this.steps.length,
      refs: this.refs.size,
      truncated: this.truncated,
      dropped: this.dropped,
      limits: { steps: this.maxSteps, refs: this.maxRefs },
    };
  }

  clear() {
    this.steps = [];
    this.refs.clear();
    this.truncated = false;
    this.dropped = 0;
  }
}
