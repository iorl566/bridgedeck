// src/tracing.js —— CDP Performance tracing：采集 traceEvents，停录后返回可保存的 Trace JSON。
import { acquire, onEvent, release, send } from './debugger.js';
import { bridgeError } from './errors.js';

const active = new Map(); // tabId -> { dbg, events, done, offs, categories, startedAt }

function requireTabId(params) {
  const tabId = Number(params && params.tabId);
  if (!Number.isInteger(tabId)) throw bridgeError('E_BAD_ARG', '需要 tabId');
  return tabId;
}

const DEFAULT_CATEGORIES = 'devtools.timeline,v8.execute,blink.user_timing';

function summarize(events) {
  const cats = {};
  const names = {};
  let minTs = Infinity;
  let maxTs = 0;
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const cat = String(event.cat || '');
    cats[cat] = (cats[cat] || 0) + 1;
    const name = String(event.name || '');
    names[name] = (names[name] || 0) + 1;
    const ts = Number(event.ts);
    if (Number.isFinite(ts)) {
      if (ts < minTs) minTs = ts;
      if (ts > maxTs) maxTs = ts;
    }
  }
  const topNames = Object.entries(names).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([name, count]) => ({ name, count }));
  const topCategories = Object.entries(cats).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([category, count]) => ({ category, count }));
  const span = Number.isFinite(minTs) && maxTs >= minTs ? Math.round((maxTs - minTs) / 1000) : null;
  return {
    events: events.length,
    categories: topCategories,
    topNames,
    // 不同 clock domain 的事件可能混入超大 ts；超过 1h 视为不可信。
    spanMs: span != null && span >= 0 && span < 3600000 ? span : null,
  };
}

export async function traceStart(params = {}) {
  const tabId = requireTabId(params);
  if (active.has(tabId)) throw bridgeError('E_BAD_ARG', '该标签页已在 tracing');
  const dbg = await acquire(tabId, 'trace');
  try {
    const events = [];
    let settle = null;
    const done = new Promise((resolve) => { settle = resolve; });
    const offs = [
      onEvent(dbg, 'Tracing.dataCollected', (event) => {
        if (event && Array.isArray(event.value)) events.push(...event.value);
      }),
      onEvent(dbg, 'Tracing.tracingComplete', () => { if (settle) settle(true); }),
    ];
    const categories = String(params.categories || DEFAULT_CATEGORIES);
    await send(tabId, 'Tracing.start', {
      categories,
      options: 'sampling-frequency=1000',
      transferMode: 'ReportEvents',
    });
    active.set(tabId, { dbg, events, done, offs, categories, startedAt: Date.now() });
    return { ok: true, tabId, categories, startedAt: Date.now() };
  } catch (error) {
    release(tabId, 'trace').catch(() => {});
    throw error;
  }
}

export async function traceStop(params = {}) {
  const tabId = requireTabId(params);
  const state = active.get(tabId);
  if (!state) throw bridgeError('E_BAD_ARG', '该标签页没有进行中的 tracing');
  active.delete(tabId);
  try {
    await send(tabId, 'Tracing.end', {});
    await Promise.race([
      state.done,
      new Promise((resolve) => setTimeout(resolve, 10000)),
    ]);
  } finally {
    for (const off of state.offs) {
      try { if (typeof off === 'function') off(); } catch { /* 忽略 */ }
    }
    await release(tabId, 'trace').catch(() => {});
  }
  const summary = summarize(state.events);
  return {
    ok: true,
    tabId,
    categories: state.categories,
    startedAt: state.startedAt,
    durationMs: Date.now() - state.startedAt,
    events: state.events.length,
    summary,
    trace: state.events.length ? JSON.stringify({ traceEvents: state.events }) : '',
  };
}

export function traceStatus(params = {}) {
  const tabId = requireTabId(params);
  const state = active.get(tabId);
  return {
    ok: true,
    tabId,
    tracing: Boolean(state),
    events: state ? state.events.length : 0,
    categories: state ? state.categories : null,
    startedAt: state ? state.startedAt : null,
  };
}
