// ui/lib/diff-nav.js —— 差异视图导航模型（纯函数，无 DOM，可在 Node 单测）。
//
// lib/diff.js 负责“算出差异”，本模块负责“在差异里走动”：
// - 差异块导航（上一个/下一个/第 n 个，首尾循环）；
// - 只看差异（把未变上下文折叠成“折叠 N 行”）；
// - 行内词级差异（`/api/v1` → `/api/v2` 只高亮 v1→v2）；
// - 位置播报（“第 2 个差异，共 5 个”）。
//
// 这些都是“有状态但无 DOM”的模型，页面只把结果渲染成行，测试可以在 Node 里
// 直接断言光标位置、折叠数量与可见行。

import { diffSequences, splitWords, sideBySide, unifiedHunks, diffStats } from './diff.js';
import { formatLabel } from './labels.js';

/** 折叠行数超过这个值才显示“折叠 N 行”（避免每两行就出现一条折叠提示）。 */
export const FOLD_MIN_LINES = 2;

/** 默认上下文行数（与 unified diff 一致）。 */
export const DEFAULT_CONTEXT = 3;

/**
 * 把差异 ops 压成“折叠感知”的可见行：
 * - type: 'equal' | 'insert' | 'delete' | 'fold'
 * - fold 行带 count（被折叠的未改行数）
 * @param {Array<{type:string,text:string,aIndex:number|null,bIndex:number|null}>} ops
 * @param {{onlyChanges?:boolean, context?:number}} options
 */
export function buildDiffRows(ops, options = {}) {
  const list = Array.isArray(ops) ? ops : [];
  const onlyChanges = options.onlyChanges === true;
  const context = Math.max(0, Math.floor(Number(options.context) === undefined ? DEFAULT_CONTEXT : Number(options.context)));
  const rows = [];
  if (!onlyChanges) {
    for (const op of list) rows.push({ type: op.type, text: op.text, aIndex: op.aIndex, bIndex: op.bIndex });
    return rows;
  }
  // 只看差异：保留变化行 + 其前后 context 行，其余合成 fold 行。
  const keep = new Set();
  list.forEach((op, index) => {
    if (op.type === 'equal') return;
    for (let cursor = Math.max(0, index - context); cursor <= Math.min(list.length - 1, index + context); cursor += 1) keep.add(cursor);
  });
  let folded = 0;
  let pendingRows = [];
  const flushFold = () => {
    if (folded === 0) return;
    // 折叠太少反而打断阅读：不足阈值时按原样显示未变行。
    if (folded >= FOLD_MIN_LINES) {
      rows.push({ type: 'fold', count: folded, text: '' });
    } else {
      rows.push(...pendingRows);
    }
    folded = 0;
    pendingRows = [];
  };
  list.forEach((op, index) => {
    if (keep.has(index)) {
      flushFold();
      rows.push({ type: op.type, text: op.text, aIndex: op.aIndex, bIndex: op.bIndex });
    } else if (op.type === 'equal') {
      folded += 1;
      pendingRows.push({ type: op.type, text: op.text, aIndex: op.aIndex, bIndex: op.bIndex });
    } else {
      // 变化行永远不应该被折叠；保险起见直接展示。
      flushFold();
      rows.push({ type: op.type, text: op.text, aIndex: op.aIndex, bIndex: op.bIndex });
    }
  });
  flushFold();
  return rows;
}

/**
 * 差异块列表：直接复用 unifiedHunks，但补上序号/统计/行文本，便于导航。
 * @returns {Array<{index:number, aStart:number, bStart:number, aCount:number, bCount:number,
 *   added:number, removed:number, unchanged:number, ops:Array, rows:Array, label:string}>}
 */
export function buildDiffHunks(ops, options = {}) {
  const hunks = unifiedHunks(Array.isArray(ops) ? ops : [], { context: options.context === undefined ? DEFAULT_CONTEXT : options.context });
  return hunks.map((hunk, index) => {
    const stats = diffStats(hunk.ops || []);
    return {
      index,
      aStart: hunk.aStart,
      bStart: hunk.bStart,
      aCount: hunk.aCount,
      bCount: hunk.bCount,
      added: stats.added,
      removed: stats.removed,
      unchanged: stats.unchanged,
      ops: hunk.ops || [],
      rows: buildDiffRows(hunk.ops || [], { onlyChanges: false }),
      label: 'hunk ' + (index + 1) + ' +' + stats.added + ' -' + stats.removed,
    };
  });
}

/**
 * 差异导航器：有状态、可注入初始位置（测试确定性）。
 * @param {Array} ops 差异 ops（diff.js 输出）
 * @param {{context?:number, onlyChanges?:boolean}} options
 */
export function createDiffNavigator(ops, options = {}) {
  const list = Array.isArray(ops) ? ops : [];
  let context = Math.max(0, Math.floor(Number(options.context) === undefined ? DEFAULT_CONTEXT : Number(options.context)));
  let onlyChanges = options.onlyChanges === true;
  let current = 0;
  const compute = () => buildDiffHunks(list, { context });
  let hunks = compute();
  let rows = buildDiffRows(list, { onlyChanges, context });
  const listeners = new Set();
  const emit = () => {
    for (const listener of [...listeners]) {
      try { listener(snapshot()); } catch { /* 忽略页面监听器异常 */ }
    }
  };
  function snapshot() {
    return {
      current,
      total: hunks.length,
      position: positionOf(hunks.length, current),
      hunks: hunks.slice(),
      rows,
      onlyChanges,
      context,
      stats: diffStats(list),
      currentHunk: hunks[current] || null,
    };
  }
  function clamp(index) {
    if (!hunks.length) return 0;
    const count = hunks.length;
    return ((Math.floor(Number(index) || 0) % count) + count) % count;
  }
  return {
    get current() { return current; },
    get total() { return hunks.length; },
    get rows() { return rows; },
    get hunks() { return hunks.slice(); },
    get onlyChanges() { return onlyChanges; },
    get stats() { return diffStats(list); },
    /** 视图快照（可直接渲染/播报）。 */
    snapshot,
    /** 下一处差异（循环）。 */
    next() {
      if (!hunks.length) return snapshot();
      current = clamp(current + 1);
      emit();
      return snapshot();
    },
    /** 上一处差异（循环）。 */
    prev() {
      if (!hunks.length) return snapshot();
      current = clamp(current - 1);
      emit();
      return snapshot();
    },
    /** 跳到第 index 个差异（0 基，越界夹取，不循环）。 */
    goto(index) {
      if (!hunks.length) return snapshot();
      const value = Math.floor(Number(index) || 0);
      current = Math.min(hunks.length - 1, Math.max(0, value));
      emit();
      return snapshot();
    },
    /** 只看差异开关（默认开启时首屏聚焦第一个差异）。 */
    setOnlyChanges(value) {
      const next = value === undefined ? !onlyChanges : Boolean(value);
      if (next === onlyChanges) return snapshot();
      onlyChanges = next;
      rows = buildDiffRows(list, { onlyChanges, context });
      emit();
      return snapshot();
    },
    /** 调整上下文行数（只影响折叠块与行列表）。 */
    setContext(value) {
      const next = Math.max(0, Math.min(20, Math.floor(Number(value) || 0)));
      if (next === context) return snapshot();
      context = next;
      hunks = compute();
      current = clamp(current);
      rows = buildDiffRows(list, { onlyChanges, context });
      emit();
      return snapshot();
    },
    /** 订阅导航变化：返回退订函数。 */
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** 当前位置的 aria 播报文本。 */
    positionText(lang = 'zh') {
      return formatLabel('diff.position', { index: hunks.length ? current + 1 : 0, total: hunks.length }, lang);
    },
  };
}

/** 位置文本（无状态版本，视图模型直接使用）。 */
export function positionOf(total, index) {
  const count = Math.max(0, Math.floor(Number(total) || 0));
  const pos = count === 0 ? 0 : Math.min(count, Math.max(1, Math.floor(Number(index) || 0) + 1));
  return { index: pos, total: count };
}

/**
 * 行内词级差异：左右两行文本 → 片段数组，供 `<mark>` 渲染。
 * 连续同类型片段会合并（避免 DOM 里出现上百个 span）。
 * @returns {Array<{type:'same'|'insert'|'delete', text:string}>}
 */
export function inlineWordSegments(left, right) {
  const a = splitWords(left);
  const b = splitWords(right);
  const ops = diffSequences(a, b);
  const segments = [];
  const push = (type, textValue) => {
    if (!textValue) return;
    const last = segments[segments.length - 1];
    if (last && last.type === type) last.text += textValue;
    else segments.push({ type, text: textValue });
  };
  for (const op of ops) {
    if (op.type === 'equal') push('same', op.text);
    else if (op.type === 'insert') push('insert', op.text);
    else push('delete', op.text);
  }
  return segments;
}

/** 左右行成对模型：sideBySide + 行内片段（delete/insert 成对时在同一行对比）。 */
export function buildInlineRows(ops) {
  const rows = sideBySide(Array.isArray(ops) ? ops : []);
  return rows.map((row, index) => ({
    index,
    type: row.type,
    left: row.left ? row.left.text : null,
    right: row.right ? row.right.text : null,
    leftSegments: row.left && row.right ? inlineWordSegments(row.left.text, row.right.text) : (row.left ? [{ type: 'delete', text: row.left.text }] : []),
    rightSegments: row.left && row.right ? inlineWordSegments(row.left.text, row.right.text) : (row.right ? [{ type: 'insert', text: row.right.text }] : []),
  }));
}

/** 折叠摘要文本：`折叠 12 行未变内容`。 */
export function foldLabel(count, lang = 'zh') {
  return formatLabel('diff.fold', { count: Number(count) || 0 }, lang);
}

/** 差异统计摘要：`3 个差异块 / 12 行变化`。 */
export function diffSummaryText(stats, hunkCount, lang = 'zh') {
  const source = stats && typeof stats === 'object' ? stats : {};
  if (source.identical) return formatLabel('diff.identicalShort', {}, lang);
  const changed = Number(source.changed) || 0;
  return formatLabel('diff.changedLines', { count: changed }, lang) + ' · ' + formatLabel('diff.hunks', { count: Number(hunkCount) || 0 }, lang);
}

/** 快速判断：两份文本是否完全相同（先比长度再逐行，避免直接 LCS）。 */
export function isIdenticalText(left, right) {
  const a = String(left === undefined || left === null ? '' : left);
  const b = String(right === undefined || right === null ? '' : right);
  return a === b;
}

/** 从两份文本直接建导航器（页面代码短）。 */
export function navigatorForTexts(left, right, options = {}) {
  const a = String(left === undefined || left === null ? '' : left).replace(/\r\n?/g, '\n');
  const b = String(right === undefined || right === null ? '' : right).replace(/\r\n?/g, '\n');
  return createDiffNavigator(diffLinesSafe(a, b), options);
}

function diffLinesSafe(a, b) {
  // 延迟 import 会让模块在 Node 里也同步可用：这里直接复用 diff.js 的 splitLines + diffSequences。
  const split = (text) => {
    if (!text) return [];
    const lines = text.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  return diffSequences(split(a), split(b));
}

/** 折叠行阈值：小于 FOLD_MIN_LINES 的折叠行不值得展示（返回 0 表示不折叠）。 */
export function foldCountOrZero(count) {
  const value = Math.max(0, Math.floor(Number(count) || 0));
  return value >= FOLD_MIN_LINES ? value : 0;
}
