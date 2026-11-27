// ui/lib/virtual-list.js —— 纯虚拟列表窗口计算（无 DOM/chrome，可在 Node 单测）。
//
// 长列表（审计 500 条、请求 100+）一次性建 DOM 会卡；这里只算「哪些行可见 +
// 上下占位高度」，由页面把窗口内的行渲染进固定高度容器。
//
// 两种模式：
// - 等行高：rowHeight + total 直接算，O(1)。
// - 变行高：offsets 前缀和 + 二分查找，O(log n)；offsets 由页面在拿到数据时构建。
//
// 不变量（测试断言）：
// - start ≥ 0、end ≤ total、start ≤ end；
// - 窗口至少覆盖可视区（不会出现整屏空白）；
// - 占位高度 + 已渲染高度 = 总高度（列表滚动条不抖）。
import { toFiniteNumber } from './format.js';

function intOr(value, fallback) {
  const number = toFiniteNumber(value);
  if (number === null) return fallback;
  return Math.floor(number);
}

/** 构建变行高 offsets：offsets[i] 是第 i 行顶部 y，offsets[n] 是总高度。 */
export function buildOffsets(heights) {
  const list = Array.isArray(heights) ? heights : [];
  const offsets = new Array(list.length + 1);
  offsets[0] = 0;
  for (let index = 0; index < list.length; index += 1) {
    const height = Math.max(0, toFiniteNumber(list[index]) || 0);
    offsets[index + 1] = offsets[index] + height;
  }
  return offsets;
}

/** 二分查找：返回“包含 offset 的行号”（offsets 递增）。空列表返回 0。 */
export function indexAtOffset(offsets, offset) {
  const list = Array.isArray(offsets) ? offsets : [];
  if (list.length <= 1) return 0;
  const target = Math.max(0, toFiniteNumber(offset) || 0);
  let low = 0;
  let high = list.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (list[mid + 1] <= target) low = mid + 1;
    else high = mid;
  }
  return Math.min(list.length - 2, Math.max(0, low));
}

/**
 * 等行高窗口。
 * @param {{scrollTop?:number, viewportHeight?:number, rowHeight?:number, total?:number, overscan?:number}} input
 * @returns {{start:number,end:number,topPad:number,bottomPad:number,totalHeight:number,visibleCount:number}}
 */
export function computeWindow({ scrollTop = 0, viewportHeight = 0, rowHeight = 36, total = 0, overscan = 3 } = {}) {
  const height = Math.max(1, intOr(rowHeight, 36));
  const count = Math.max(0, intOr(total, 0));
  const view = Math.max(0, toFiniteNumber(viewportHeight) || 0);
  const pad = Math.max(0, intOr(overscan, 3));
  const scroll = Math.max(0, toFiniteNumber(scrollTop) || 0);
  if (count === 0) {
    return { start: 0, end: 0, topPad: 0, bottomPad: 0, totalHeight: 0, visibleCount: 0 };
  }
  const rawStart = Math.floor(scroll / height);
  const rawEnd = Math.ceil((scroll + Math.max(view, height)) / height);
  const start = Math.max(0, Math.min(count - 1, rawStart - pad));
  const end = Math.max(start, Math.min(count, rawEnd + pad));
  return {
    start,
    end,
    topPad: start * height,
    bottomPad: (count - end) * height,
    totalHeight: count * height,
    visibleCount: end - start,
  };
}

/**
 * 变行高窗口：offsets 来自 buildOffsets。
 * @returns {{start:number,end:number,topPad:number,bottomPad:number,totalHeight:number,visibleCount:number}}
 */
export function computeVariableWindow({ offsets, scrollTop = 0, viewportHeight = 0, overscan = 3 } = {}) {
  const list = Array.isArray(offsets) ? offsets : [0];
  const count = Math.max(0, list.length - 1);
  const totalHeight = Math.max(0, toFiniteNumber(list[list.length - 1]) || 0);
  if (count === 0) {
    return { start: 0, end: 0, topPad: 0, bottomPad: 0, totalHeight: 0, visibleCount: 0 };
  }
  const view = Math.max(0, toFiniteNumber(viewportHeight) || 0);
  const pad = Math.max(0, intOr(overscan, 3));
  const scroll = Math.max(0, toFiniteNumber(scrollTop) || 0);
  const bottom = scroll + Math.max(view, 1);
  const rawStart = indexAtOffset(list, scroll);
  const rawEnd = Math.min(count, indexAtOffset(list, bottom) + 1);
  const start = Math.max(0, rawStart - pad);
  const end = Math.min(count, Math.max(start, rawEnd + pad));
  return {
    start,
    end,
    topPad: list[start],
    bottomPad: Math.max(0, totalHeight - list[end]),
    totalHeight,
    visibleCount: end - start,
  };
}

/**
 * 有状态的虚拟列表模型：页面滚一下喂 scrollTop，拿窗口；也支持 locate(index)。
 * 等行高/变行高统一入口。
 */
export function createVirtualModel({ rowHeight = 36, total = 0, heights = null, overscan = 3 } = {}) {
  let offsets = Array.isArray(heights) ? buildOffsets(heights) : null;
  let count = offsets ? offsets.length - 1 : Math.max(0, intOr(total, 0));
  let scrollTop = 0;
  let viewportHeight = 0;
  const fixedHeight = Math.max(1, intOr(rowHeight, 36));

  function recompute() {
    return offsets
      ? computeVariableWindow({ offsets, scrollTop, viewportHeight, overscan })
      : computeWindow({ scrollTop, viewportHeight, rowHeight: fixedHeight, total: count, overscan });
  }

  return {
    get total() { return count; },
    get variable() { return Boolean(offsets); },
    setTotal(nextTotal) {
      offsets = null;
      count = Math.max(0, intOr(nextTotal, 0));
      return count;
    },
    setHeights(nextHeights) {
      offsets = buildOffsets(nextHeights);
      count = Math.max(0, offsets.length - 1);
      return count;
    },
    setScroll(top) {
      scrollTop = Math.max(0, toFiniteNumber(top) || 0);
      return scrollTop;
    },
    setViewport(height) {
      viewportHeight = Math.max(0, toFiniteNumber(height) || 0);
      return viewportHeight;
    },
    window() {
      return recompute();
    },
    /** 第 index 行顶部偏移（页面 scrollIntoView 的替代：直接算）。 */
    offsetOf(index) {
      const position = Math.min(Math.max(0, intOr(index, 0)), Math.max(0, count - 1));
      if (offsets) return offsets[position];
      return position * fixedHeight;
    },
    heightOf(index) {
      const position = Math.min(Math.max(0, intOr(index, 0)), Math.max(0, count - 1));
      if (offsets) return offsets[position + 1] - offsets[position];
      return count === 0 ? 0 : fixedHeight;
    },
    totalHeight() {
      if (offsets) return offsets[count];
      return count * fixedHeight;
    },
    /** 让某一行进入视口（返回建议的 scrollTop，页面赋值给容器）。 */
    scrollToIndex(index, { align = 'auto' } = {}) {
      const position = Math.min(Math.max(0, intOr(index, 0)), Math.max(0, count - 1));
      const top = offsets ? offsets[position] : position * fixedHeight;
      const height = offsets ? offsets[position + 1] - offsets[position] : fixedHeight;
      const view = Math.max(0, viewportHeight);
      if (align === 'start') return top;
      if (align === 'end') return Math.max(0, top + height - view);
      if (align === 'center') return Math.max(0, top + height / 2 - view / 2);
      if (top < scrollTop) return top;
      if (top + height > scrollTop + view) return Math.max(0, top + height - view);
      return scrollTop;
    },
  };
}

/** 行高的常用估值：单行 36px，双行 56px，带操作按钮 64px；页面按行内容选。 */
export const ROW_HEIGHTS = Object.freeze({ compact: 30, single: 36, double: 56, action: 64 });
