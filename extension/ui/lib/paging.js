// ui/lib/paging.js —— 纯分页模型（无 DOM/chrome，可在 Node 单测）。
//
// 页面用途：audit/debug/ops/record/longshot 的记录列表都可能超过一屏，统一走这里，
// 这样「上一页/下一页」的边界、页码窗口、aria 摘要只有一份实现。
//
// 设计要点：
// - 页码 1 基（面向用户），内部索引 0 基（slice 用），转换只在 slicePage 里做。
// - clampPage 对 NaN/负数/超界都返回合法页码，页面按钮永远不会把状态弄坏。
// - pageWindow 只做「页码按钮」的窗口计算（首尾页 + 当前页 ± 邻居 + 省略号），
//   不关心数据，方便测试边界。
// - cursor pager 用于「加载更多」型列表（RPC 增量返回）：合并去重、记住最后游标。
import { formatThousands } from './format.js';

export const DEFAULT_PAGE_SIZE = 20;

function positiveInt(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const rounded = Math.floor(number);
  return rounded > 0 ? rounded : fallback;
}

function clampInt(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

/** 总页数：total=0 时返回 0（页面用 hasPages 判断空态）。 */
export function pageCount(total, pageSize = DEFAULT_PAGE_SIZE) {
  const size = positiveInt(pageSize, DEFAULT_PAGE_SIZE);
  const count = Math.max(0, Math.floor(Number(total) || 0));
  return count === 0 ? 0 : Math.ceil(count / size);
}

/** 把任意页码夹到 [1, pages]；空集合返回 1（这样“第 1 / 0 页”不会出现）。 */
export function clampPage(page, total, pageSize = DEFAULT_PAGE_SIZE) {
  const pages = pageCount(total, pageSize);
  if (pages === 0) return 1;
  const wanted = Number(page);
  if (!Number.isFinite(wanted)) return 1;
  return Math.min(pages, Math.max(1, Math.floor(wanted)));
}

/** 是否有上一页/下一页。 */
export function pageEdges(page, total, pageSize = DEFAULT_PAGE_SIZE) {
  const pages = pageCount(total, pageSize);
  const current = clampPage(page, total, pageSize);
  return { hasPrev: pages > 0 && current > 1, hasNext: pages > 0 && current < pages, pages, page: current };
}

/** 当前页的 0 基切片边界 [start, end)。 */
export function pageBounds(page, total, pageSize = DEFAULT_PAGE_SIZE) {
  const size = positiveInt(pageSize, DEFAULT_PAGE_SIZE);
  const count = Math.max(0, Math.floor(Number(total) || 0));
  const current = clampPage(page, count, size);
  const start = (current - 1) * size;
  return { start, end: Math.min(count, start + size), page: current, pageSize: size, total: count };
}

/** 从数组里取当前页（不修改入参）。 */
export function slicePage(items, page, pageSize = DEFAULT_PAGE_SIZE) {
  const list = Array.isArray(items) ? items : [];
  const bounds = pageBounds(page, list.length, pageSize);
  return {
    items: list.slice(bounds.start, bounds.end),
    ...bounds,
  };
}

/**
 * 分页按钮窗口。
 * @returns {{items: Array<number|'…'>, pages: number}}
 * 规则：总页数 ≤7 全列出；否则「首页 + … + 邻居 + … + 末页」。
 */
export function pageWindow(page, total, pageSize = DEFAULT_PAGE_SIZE, siblings = 1) {
  const pages = pageCount(total, pageSize);
  if (pages <= 7) {
    const all = [];
    for (let index = 1; index <= pages; index += 1) all.push(index);
    return { items: all, pages };
  }
  const current = clampPage(page, total, pageSize);
  const radius = Math.max(0, Math.floor(Number(siblings) || 0));
  const start = Math.max(2, current - radius);
  const end = Math.min(pages - 1, current + radius);
  const items = [1];
  if (start > 2) items.push('…');
  for (let index = start; index <= end; index += 1) {
    if (index > 1 && index < pages) items.push(index);
  }
  if (end < pages - 1) items.push('…');
  items.push(pages);
  return { items, pages };
}

/** "1–20 / 320" 之类的人读范围；用千分位避免长数字串。 */
export function rangeLabel(page, total, pageSize = DEFAULT_PAGE_SIZE) {
  const bounds = pageBounds(page, total, pageSize);
  if (bounds.total === 0) return '0 / 0';
  return (bounds.start + 1) + '–' + bounds.end + ' / ' + formatThousands(bounds.total);
}

/** 键盘分页意图书：PageUp/PageDown/Home/End 映射到页码。 */
export function pageForKey(page, total, key, pageSize = DEFAULT_PAGE_SIZE) {
  const pages = pageCount(total, pageSize);
  const current = clampPage(page, total, pageSize);
  switch (key) {
    case 'PageUp': return Math.max(1, current - 1);
    case 'PageDown': return Math.min(Math.max(1, pages), current + 1);
    case 'Home': return 1;
    case 'End': return Math.max(1, pages);
    default: return current;
  }
}

/** 完整的分页视图模型（按钮状态 + aria 文本参数），页面直接渲染。 */
export function buildPagingModel({ page, total, pageSize = DEFAULT_PAGE_SIZE, siblings = 1 } = {}) {
  const size = positiveInt(pageSize, DEFAULT_PAGE_SIZE);
  const count = Math.max(0, Math.floor(Number(total) || 0));
  const pages = pageCount(count, size);
  const current = clampPage(page, count, size);
  const edges = pageEdges(current, count, size);
  return {
    page: current,
    pages,
    pageSize: size,
    total: count,
    hasPrev: edges.hasPrev,
    hasNext: edges.hasNext,
    window: pageWindow(current, count, size, siblings),
    range: rangeLabel(current, count, size),
    empty: count === 0,
    firstIndex: count === 0 ? 0 : (current - 1) * size,
    lastIndex: count === 0 ? 0 : Math.min(count, current * size),
  };
}

/**
 * 游标分页（“加载更多”）：只关心“已收到的条目 + 是否还有下一页 + 游标”。
 * merge 按 id 去重并保持顺序（新页追加到尾部，按 id 覆盖旧内容）。
 */
export function createCursorPager({ pageSize = DEFAULT_PAGE_SIZE, idOf } = {}) {
  const size = positiveInt(pageSize, DEFAULT_PAGE_SIZE);
  const identify = typeof idOf === 'function' ? idOf : (item) => (item && (item.id ?? item.key));
  let items = [];
  let cursor = null;
  let done = false;
  let loading = false;

  function sanitize(list) {
    return Array.isArray(list) ? list.filter((item) => item !== undefined && item !== null) : [];
  }

  return {
    get items() { return items; },
    get cursor() { return cursor; },
    get done() { return done; },
    get loading() { return loading; },
    get size() { return size; },
    setLoading(value) { loading = value === true; return loading; },
    /** 追加一页；返回新增条数（去重后）。 */
    append(list, { nextCursor = null, hasMore = false } = {}) {
      const incoming = sanitize(list);
      const seen = new Set(items.map((item) => String(identify(item))));
      let added = 0;
      for (const item of incoming) {
        const key = String(identify(item));
        if (seen.has(key)) continue;
        seen.add(key);
        items = items.concat([item]);
        added += 1;
      }
      cursor = nextCursor;
      done = hasMore !== true;
      loading = false;
      return added;
    },
    /** 用第一页重置（筛选变化/刷新时调用）。 */
    reset(list, { nextCursor = null, hasMore = false } = {}) {
      items = sanitize(list);
      cursor = nextCursor;
      done = hasMore !== true;
      loading = false;
      return items.length;
    },
    nextQuery() {
      return { limit: size, cursor, after: cursor };
    },
    canLoadMore() {
      return !done && !loading;
    },
  };
}
