// ui/lib/focus.js —— 焦点管理模型（纯函数；DOM 挂载由页面/`lib/dom.js` 完成）。
//
// ui/a11y-dialog.js 已经有「模态对话框」的焦点陷阱（Tab 循环 + 背景 inert）；
// 这里补的是非模态组件需要的另一半：
// - roving tabindex：列表/标签页只有一项 tabindex=0，其余 -1，方向键移动焦点；
// - 焦点陷阱（非模态面板）：Tab/Shift+Tab 在面板内循环，可临时暂停；
// - 焦点恢复栈：面板收起后回到打开它的按钮（多个面板叠加也正确）；
// - grid 导航：二维时间线/对比表格的方向键移动。
//
// 全部是纯计算，真实 DOM 焦点由页面调用 `applyRoving`/`createFocusTrap` 的
// DOM 版本完成（见 lib/dom.js），所以本模块可在 Node 里单测。

import { moveIndex } from './keyboard.js';

/**
 * roving tabindex 模型：只记录「当前哪个索引拥有 tabindex=0」。
 * 返回的 move* 都做边界收敛，不会产生越界索引。
 */
export function createRovingModel({ total = 0, activeIndex = -1, wrap = true, orientation = 'vertical' } = {}) {
  let count = Math.max(0, Math.floor(Number(total) || 0));
  const wanted = activeIndex === undefined || activeIndex === null ? -1 : Math.floor(Number(activeIndex));
  // 默认 -1：列表还没获得焦点时没有任何行是 tabindex=0（容器本身可聚焦）。
  let active = count === 0 || !Number.isFinite(wanted) || wanted < 0
    ? -1
    : Math.min(count - 1, wanted);

  function clamp(index) {
    if (count === 0) return -1;
    return Math.min(count - 1, Math.max(0, Math.floor(Number(index) || 0)));
  }

  return {
    get total() { return count; },
    get activeIndex() { return active; },
    setTotal(next) {
      count = Math.max(0, Math.floor(Number(next) || 0));
      active = count === 0 ? -1 : Math.min(count - 1, Math.max(0, active));
      return count;
    },
    setActive(index) {
      active = clamp(index);
      return active;
    },
    tabIndexAt(index) {
      return clamp(index) === active && active !== -1 ? 0 : -1;
    },
    move(delta) {
      if (count === 0) return -1;
      // 还没有活动项时，任一方向键都先落到第一项（不跳过首项）。
      if (active < 0) { active = 0; return active; }
      active = moveIndex(active, delta, count, { wrap });
      return active;
    },
    moveTo(index) {
      active = clamp(index);
      return active;
    },
    first() { active = count === 0 ? -1 : 0; return active; },
    last() { active = count === 0 ? -1 : count - 1; return active; },
    /** 方向键 → 索引；非该方向的键返回 null（页面据此决定是否 preventDefault）。 */
    onArrow(key, shiftKey = false) {
      const horizontal = orientation === 'horizontal';
      // 纵向列表：↑/↓ 移动；横向列表：←/→ 移动。反方向的键也接受（列表同时支持两者，
      // 与 roving tabindex 的常见实现一致），保证用户不用先记住方向。
      switch (key) {
        case 'ArrowUp': return this.move(horizontal ? 0 : -1);
        case 'ArrowDown': return this.move(horizontal ? 0 : 1);
        case 'ArrowLeft': return this.move(-1);
        case 'ArrowRight': return this.move(1);
        case 'Home': return this.first();
        case 'End': return this.last();
        default: return null;
      }
    },
    /** 可访问性属性：列表容器/行用。 */
    attributesFor(index) {
      const current = clamp(index);
      return {
        tabindex: current === active && active !== -1 ? 0 : -1,
        'aria-selected': current === active ? 'true' : 'false',
      };
    },
  };
}

/**
 * 二维网格（时间线轨道、对比表格）导航。
 * @param {{rows:number, cols:number, row?:number, col?:number, wrap?:boolean}} input
 */
export function createGridModel({ rows = 0, cols = 0, row = 0, col = 0, wrap = false } = {}) {
  let rowCount = Math.max(0, Math.floor(Number(rows) || 0));
  let colCount = Math.max(0, Math.floor(Number(cols) || 0));
  let currentRow = rowCount === 0 ? -1 : Math.min(rowCount - 1, Math.max(0, Math.floor(Number(row) || 0)));
  let currentCol = colCount === 0 ? -1 : Math.min(colCount - 1, Math.max(0, Math.floor(Number(col) || 0)));

  function clampAll() {
    currentRow = rowCount === 0 ? -1 : Math.min(rowCount - 1, Math.max(0, currentRow));
    currentCol = colCount === 0 ? -1 : Math.min(colCount - 1, Math.max(0, currentCol));
  }

  return {
    get rows() { return rowCount; },
    get cols() { return colCount; },
    get row() { return currentRow; },
    get col() { return currentCol; },
    setSize(nextRows, nextCols) {
      rowCount = Math.max(0, Math.floor(Number(nextRows) || 0));
      colCount = Math.max(0, Math.floor(Number(nextCols) || 0));
      clampAll();
      return { rows: rowCount, cols: colCount };
    },
    move(deltaRow, deltaCol) {
      if (rowCount === 0 || colCount === 0) return -1;
      const rowNext = currentRow + Math.floor(Number(deltaRow) || 0);
      const colNext = currentCol + Math.floor(Number(deltaCol) || 0);
      currentRow = wrap ? ((rowNext % rowCount) + rowCount) % rowCount : Math.min(rowCount - 1, Math.max(0, rowNext));
      currentCol = wrap ? ((colNext % colCount) + colCount) % colCount : Math.min(colCount - 1, Math.max(0, colNext));
      return currentRow * colCount + currentCol;
    },
    onArrow(key) {
      switch (key) {
        case 'ArrowUp': return this.move(-1, 0);
        case 'ArrowDown': return this.move(1, 0);
        case 'ArrowLeft': return this.move(0, -1);
        case 'ArrowRight': return this.move(0, 1);
        case 'Home': currentCol = 0; return this.index();
        case 'End': currentCol = Math.max(0, colCount - 1); return this.index();
        default: return null;
      }
    },
    index() {
      if (rowCount === 0 || colCount === 0) return -1;
      return currentRow * colCount + currentCol;
    },
    tabIndexAt(index) {
      return index === this.index() ? 0 : -1;
    },
  };
}

/**
 * 非模态焦点陷阱：给面板用（面板里的 Tab 不跑出去，Escape 关闭）。
 * 纯函数部分：给定当前焦点在内部元素中的序号和容器长度，算下一个序号。
 */
export function trapStep(currentIndex, total, { shift = false, wrap = true } = {}) {
  const count = Math.max(0, Math.floor(Number(total) || 0));
  if (count === 0) return -1;
  const current = Math.min(count - 1, Math.max(0, Math.floor(Number(currentIndex) || 0)));
  const step = shift ? -1 : 1;
  const next = current + step;
  if (next < 0) return wrap ? count - 1 : 0;
  if (next >= count) return wrap ? 0 : count - 1;
  return next;
}

/**
 * 焦点恢复栈：open 时压入触发元素，close 时弹出并还焦点。
 * 不直接碰 DOM：元素对象由调用方传入，`isConnected`/`focus` 存在时才调用。
 */
export function createFocusReturnStack() {
  const stack = [];
  return {
    get depth() { return stack.length; },
    push(element) {
      if (!element) return stack.length;
      stack.push(element);
      return stack.length;
    },
    /** 弹出最近的元素并还焦点；返回被弹出的元素（可能为 undefined）。 */
    pop() {
      const element = stack.pop();
      if (element && element.isConnected !== false && typeof element.focus === 'function') {
        try { element.focus({ preventScroll: true }); } catch { /* 元素已被移除 */ }
      }
      return element;
    },
    /** 只丢弃不还焦点（元素即将被销毁）。 */
    drop() { return stack.pop(); },
    clear() { stack.length = 0; },
  };
}

/**
 * 面板内部焦点顺序的稳定排序：可见、未禁用、tabindex !== -1、不在 aria-hidden 里。
 * 传进来的项是「描述对象」（有 hidden/disabled/tabindex/ariaHidden），便于单测。
 */
export function orderFocusables(items) {
  const list = Array.isArray(items) ? items : [];
  return list
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item && item.hidden !== true && item.disabled !== true && item.ariaHidden !== true && item.tabindex !== -1)
    .sort((a, b) => {
      const orderA = Number.isFinite(a.item.order) ? a.item.order : a.index;
      const orderB = Number.isFinite(b.item.order) ? b.item.order : b.index;
      return orderA - orderB;
    })
    .map(({ item }) => item);
}

/** 焦点是否在面板内（DOM 版是 contains；这里支持描述对象与真实元素）。 */
export function focusWithin(container, activeElement) {
  if (!container || !activeElement) return false;
  if (typeof container.contains === 'function') {
    try { return container.contains(activeElement); } catch { return false; }
  }
  const items = Array.isArray(container.items) ? container.items : [];
  return items.includes(activeElement);
}

/** 组合多个焦点区域时的「当前陷阱」判定：最上层（最后打开）优先。 */
export function topmostTrap(traps) {
  const list = Array.isArray(traps) ? traps.filter((trap) => trap && trap.active !== false) : [];
  if (!list.length) return null;
  return list.reduce((top, trap) => (Number(trap.layer || 0) >= Number(top.layer || 0) ? trap : top), list[0]);
}
