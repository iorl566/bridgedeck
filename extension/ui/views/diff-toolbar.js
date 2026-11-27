// ui/views/diff-toolbar.js —— 差异导航工具栏与差异行视图（纯描述，无 DOM）。
//
// lib/diff-nav.js 提供导航状态；本文件把它渲染成：
// - 工具栏：上一处/下一处 + 位置（“第 2 / 5 处差异”）+ 只看差异开关 + 上下文行数；
// - 行列表：差异行（+/-）与折叠行（“折叠 12 行未变内容”），带 aria 行号与可访问名称；
// - 行内词级差异：左右两行成对展示，变化词加 mark。

import { formatLabel } from '../lib/labels.js';
import { h, button, when } from '../lib/render.js';
import { foldLabel, diffSummaryText } from '../lib/diff-nav.js';

/**
 * 工具栏模型。
 * @param {{snapshot?:object, lang?:string, onNext?:Function, onPrev?:Function,
 *   onToggleOnlyChanges?:Function, onChangeContext?:Function}} input
 */
export function buildDiffToolbar(input = {}) {
  const lang = input.lang || 'zh';
  const snapshot = input.snapshot && typeof input.snapshot === 'object' ? input.snapshot : { current: 0, total: 0, position: { index: 0, total: 0 }, onlyChanges: false, context: 3, stats: {} };
  const total = Number(snapshot.total) || 0;
  const position = snapshot.position || { index: total ? 1 : 0, total };
  const prev = button({ label: '↑', attrs: { 'aria-label': formatLabel('diff.prev', {}, lang), 'data-diff-prev': '1' }, disabled: total === 0 });
  if (total > 0 && typeof input.onPrev === 'function') prev.on = { click: () => input.onPrev() };
  const next = button({ label: '↓', attrs: { 'aria-label': formatLabel('diff.next', {}, lang), 'data-diff-next': '1' }, disabled: total === 0 });
  if (total > 0 && typeof input.onNext === 'function') next.on = { click: () => input.onNext() };
  const onlyChanges = button({
    label: formatLabel('diff.onlyChanges', {}, lang),
    tone: snapshot.onlyChanges ? 'primary' : '',
    attrs: { 'data-diff-only': '1', 'aria-pressed': snapshot.onlyChanges ? 'true' : 'false' },
  });
  if (typeof input.onToggleOnlyChanges === 'function') onlyChanges.on = { click: () => input.onToggleOnlyChanges(!snapshot.onlyChanges) };
  const contextLabel = formatLabel('diff.context', {}, lang);
  const contextSelect = h('label', { class: 'diff-context' }, [
    h('span', { class: 'muted' }, contextLabel),
    h('select', {
      class: 'inline-input',
      'aria-label': contextLabel,
      'data-diff-context': '1',
    }, [0, 1, 2, 3, 5, 8].map((value) => h('option', { value: String(value), ...(Number(snapshot.context) === value ? { selected: true } : {}) }, String(value)))),
  ]);
  if (typeof input.onChangeContext === 'function') contextSelect.children[1].on = { change: (event) => input.onChangeContext(event && event.target ? event.target.value : '') };

  const tree = h('div', { class: 'diff-toolbar', role: 'toolbar', 'aria-label': formatLabel('diff.title', {}, lang) }, [
    prev,
    next,
    h('span', { class: 'diff-position', role: 'status', 'aria-live': 'polite', 'data-diff-position': '1' }, formatLabel('diff.position', { index: position.index || 0, total: position.total || 0 }, lang)),
    onlyChanges,
    contextSelect,
    h('span', { class: 'grow' }),
    h('span', { class: 'muted diff-stats' }, diffSummaryText(snapshot.stats || {}, total, lang)),
  ]);
  return {
    tree,
    model: {
      current: Number(snapshot.current) || 0,
      total,
      position,
      onlyChanges: snapshot.onlyChanges === true,
      context: Number(snapshot.context) || 0,
      text: formatLabel('diff.position', { index: position.index || 0, total: position.total || 0 }, lang),
      stats: snapshot.stats || {},
    },
  };
}

/**
 * 差异行列表。
 * @param {{rows?:Array, hunks?:Array, snapshot?:object, lang?:string, onFold?:Function}} input
 */
export function buildDiffRowsView(input = {}) {
  const lang = input.lang || 'zh';
  const rows = Array.isArray(input.rows) ? input.rows : (input.snapshot && Array.isArray(input.snapshot.rows) ? input.snapshot.rows : []);
  if (!rows.length) {
    return {
      tree: h('p', { class: 'state-block empty', role: 'status', 'aria-live': 'polite' }, formatLabel('diff.identicalShort', {}, lang)),
      model: { rows: [], empty: true, folds: 0, changed: 0 },
    };
  }
  let folds = 0;
  let changed = 0;
  const nodes = rows.map((row, index) => {
    if (row.type === 'fold') {
      folds += 1;
      const node = h('div', { class: 'diff-fold', role: 'row', 'data-diff-fold': String(index), 'aria-label': foldLabel(row.count, lang) }, '⋯ ' + foldLabel(row.count, lang));
      if (typeof input.onFold === 'function') node.on = { click: () => input.onFold(index) };
      return node;
    }
    if (row.type === 'insert' || row.type === 'delete') changed += 1;
    const prefix = row.type === 'insert' ? '+ ' : row.type === 'delete' ? '- ' : '  ';
    const aria = (row.type === 'insert' ? formatLabel('compare.added', {}, lang) + ': ' : row.type === 'delete' ? formatLabel('compare.removed', {}, lang) + ': ' : '') + String(row.text || '');
    return h('div', {
      class: 'diff-row ' + row.type,
      role: 'row',
      'data-diff-type': row.type,
      'aria-label': aria,
    }, [
      h('span', { class: 'diff-num mono', 'aria-hidden': 'true' }, row.aIndex === null || row.aIndex === undefined ? '' : String(row.aIndex + 1)),
      h('span', { class: 'diff-num mono', 'aria-hidden': 'true' }, row.bIndex === null || row.bIndex === undefined ? '' : String(row.bIndex + 1)),
      h('span', { class: 'diff-text mono' }, prefix + String(row.text === undefined || row.text === null ? '' : row.text)),
    ]);
  });
  return {
    tree: h('div', { class: 'diff-rows', role: 'table', 'aria-label': formatLabel('diff.title', {}, lang), 'data-diff-rows': '1' }, nodes),
    model: { rows: rows.length, folds, changed, empty: false },
  };
}

/** 行内词级差异行（成对行 + mark 片段）。 */
export function buildInlineDiffRows(inlineRows, lang = 'zh') {
  const list = Array.isArray(inlineRows) ? inlineRows : [];
  if (!list.length) return { tree: h('p', { class: 'muted' }, formatLabel('diff.identicalShort', {}, lang)), model: { rows: 0, changes: 0 } };
  let changes = 0;
  const nodes = list.map((row, index) => {
    if (row.type === 'change') changes += 1;
    return h('div', { class: 'diff-inline-row ' + row.type, role: 'row', 'data-inline-row': String(index) }, [
      h('span', { class: 'diff-inline-left', role: 'cell' }, segmentsToNodes(row.leftSegments, 'delete')),
      h('span', { class: 'diff-inline-right', role: 'cell' }, segmentsToNodes(row.rightSegments, 'insert')),
    ]);
  });
  return {
    tree: h('div', { class: 'diff-inline-rows', role: 'table', 'aria-label': formatLabel('diff.title', {}, lang), 'data-inline-diff': '1' }, nodes),
    model: { rows: list.length, changes },
  };
}

/** 片段 → 文本 + mark 节点（mark 只包变化部分，读屏仍读完整句子）。 */
export function segmentsToNodes(segments, type) {
  const list = Array.isArray(segments) ? segments : [];
  return list.map((segment) => {
    if (segment.type === 'same') return segment.text;
    return h('mark', { class: 'diff-mark ' + (segment.type || type) }, segment.text);
  });
}

/** 折叠摘要行（hunks 导航旁显示）。 */
export function buildHunksSummary(snapshot, lang = 'zh') {
  const total = Number(snapshot && snapshot.total) || 0;
  if (!total) return h('p', { class: 'muted' }, formatLabel('diff.identicalShort', {}, lang));
  return h('p', { class: 'muted diff-hunks', role: 'status', 'aria-live': 'polite' }, formatLabel('diff.hunks', { count: total }, lang));
}

/** 差异区域整体（工具栏 + 行）。 */
export function buildDiffPanel(input = {}) {
  const snapshot = input.snapshot || {};
  const toolbar = buildDiffToolbar({ ...input, snapshot, lang: input.lang });
  const rows = buildDiffRowsView({ ...input, snapshot, lang: input.lang });
  return {
    tree: h('section', { class: 'diff-panel', 'aria-label': formatLabel('diff.title', {}, input.lang || 'zh'), 'data-diff-panel': '1' }, [
      toolbar.tree,
      when(snapshot.onlyChanges === true && snapshot.total === 0, h('p', { class: 'muted' }, formatLabel('diff.identicalShort', {}, input.lang || 'zh'))),
      rows.tree,
    ]),
    toolbar: toolbar.model,
    rows: rows.model,
  };
}
