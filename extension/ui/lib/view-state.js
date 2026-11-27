// ui/lib/view-state.js —— 列表视图状态（筛选/排序/分页/选中 tab）的读写（纯函数）。
//
// 目标：刷新页面或从详情返回后，列表还停在同一页、同一个筛选、同一个排序。
// - URL query 编码：可分享/可回退（`?filter=api&sort=duration:desc&page=3`）；
// - 内存持久化：页面内 tab 切换（请求/控制台/历史）记住上一次的选择；
// - 严格白名单：只接受已知字段，避免把任意 query 写进状态（安全 + 稳定）。

/** 各表面允许的字段与默认值。 */
export const VIEW_STATE_SCHEMA = Object.freeze({
  list: {
    query: '',
    sort: '',
    direction: 'asc',
    page: 1,
    pageSize: 20,
    view: 'list',
    tab: '',
  },
  timeline: {
    zoom: 1,
    pan: 0,
    view: 'waterfall',
  },
  compare: {
    base: '',
    other: '',
  },
});

/** 判断 key 是否在该表面允许列表里。 */
export function isAllowedKey(surface, key) {
  const schema = VIEW_STATE_SCHEMA[surface];
  return Boolean(schema) && Object.prototype.hasOwnProperty.call(schema, key);
}

/** 生成默认状态（拷贝，避免共享可变默认值）。 */
export function defaultViewState(surface) {
  const schema = VIEW_STATE_SCHEMA[surface];
  if (!schema) return {};
  return { ...schema };
}

function parseNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function parseBoolean(value, fallback) {
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return fallback;
}

/**
 * 从 URLSearchParams / 查询串 / 普通对象里读状态。
 * 未知字段忽略；数字字段夹到合理区间。
 */
export function decodeViewState(surface, input, { overrides } = {}) {
  const schema = VIEW_STATE_SCHEMA[surface];
  if (!schema) return {};
  let source = input;
  if (typeof source === 'string') source = new URLSearchParams(source.replace(/^\?/, ''));
  const state = { ...schema };
  if (source && typeof source === 'object') {
    for (const key of Object.keys(schema)) {
      const raw = typeof source.get === 'function' ? source.get(key) : source[key];
      if (raw === undefined || raw === null || raw === '') continue;
      const fallback = schema[key];
      switch (key) {
        case 'page': state.page = Math.max(1, Math.floor(parseNumber(raw, fallback))); break;
        case 'pageSize': state.pageSize = Math.min(500, Math.max(1, Math.floor(parseNumber(raw, fallback)))); break;
        case 'zoom': state.zoom = Math.min(64, Math.max(0.01, parseNumber(raw, fallback))); break;
        case 'pan': state.pan = Math.max(-50, Math.min(50, parseNumber(raw, fallback))); break;
        default:
          if (typeof fallback === 'boolean') state[key] = parseBoolean(raw, fallback);
          else state[key] = String(raw).slice(0, 200);
          break;
      }
    }
  }
  if (overrides && typeof overrides === 'object') {
    for (const [key, value] of Object.entries(overrides)) {
      if (isAllowedKey(surface, key) && value !== undefined && value !== null) state[key] = value;
    }
  }
  if (state.direction !== 'desc') state.direction = 'asc';
  return state;
}

/**
 * 只序列化「与默认值不同」的字段，保持 URL 短。
 * @returns {string} 形如 "filter=api&sort=duration%3Adesc"（不含 '?'）
 */
export function encodeViewState(surface, state, { includeDefaults = false } = {}) {
  const schema = VIEW_STATE_SCHEMA[surface];
  if (!schema) return '';
  // includeDefaults 时用 schema 补齐缺失字段（否则只传 {query} 会把分页/排序丢掉）。
  const merged = includeDefaults ? { ...schema, ...(state && typeof state === 'object' ? state : {}) } : state;
  const params = new URLSearchParams();
  for (const key of Object.keys(schema)) {
    const value = merged && merged[key];
    if (value === undefined || value === null || value === '') continue;
    if (!includeDefaults && value === schema[key]) continue;
    params.set(key, String(value));
  }
  return params.toString();
}

/** 读当前页面 URL 里的状态（Node 测试可传入 href）。 */
export function readViewStateFromLocation(surface, href) {
  const url = String(href === undefined || href === null ? '' : href);
  const queryIndex = url.indexOf('?');
  if (queryIndex < 0) return defaultViewState(surface);
  return decodeViewState(surface, url.slice(queryIndex + 1).split('#')[0]);
}

/** 用新状态替换 URL 上的 query（不新增历史记录语义，页面用 replaceState）。 */
export function applyViewStateToHref(surface, href, state) {
  const url = String(href === undefined || href === null ? '' : href);
  const hashIndex = url.indexOf('#');
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : '';
  const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const queryIndex = base.indexOf('?');
  const path = queryIndex >= 0 ? base.slice(0, queryIndex) : base;
  const encoded = encodeViewState(surface, state);
  return path + (encoded ? '?' + encoded : '') + hash;
}

/**
 * 内存状态仓：页面里多个 tab 共享同一份状态（刷新时按需落到 URL）。
 */
export function createViewStateStore(surface, initial) {
  let state = { ...defaultViewState(surface), ...(initial && typeof initial === 'object' ? initial : {}) };
  const listeners = new Set();
  function emit() {
    for (const listener of [...listeners]) {
      try { listener({ ...state }); } catch { /* 页面监听器异常不影响状态 */ }
    }
  }
  return {
    get state() { return { ...state }; },
    get(key) { return state[key]; },
    set(patch) {
      if (!patch || typeof patch !== 'object') return { ...state };
      let changed = false;
      for (const [key, value] of Object.entries(patch)) {
        if (!isAllowedKey(surface, key)) continue;
        if (state[key] === value) continue;
        state[key] = value;
        changed = true;
      }
      if (changed) emit();
      return { ...state };
    },
    reset() {
      state = defaultViewState(surface);
      emit();
      return { ...state };
    },
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    toQuery() { return encodeViewState(surface, state); },
  };
}

/** 稳定排序字段编码："duration:desc" ↔ {key:'duration',direction:'desc'}。 */
export function encodeSort(sort) {
  if (!sort || !sort.key) return '';
  return String(sort.key) + ':' + (sort.direction === 'desc' ? 'desc' : 'asc');
}

export function decodeSort(value) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!text) return { key: '', direction: 'asc' };
  const [key, direction] = text.split(':');
  return { key: key || '', direction: direction === 'desc' ? 'desc' : 'asc' };
}
