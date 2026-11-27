// ui/views/compare-view.js —— 对比/差异视图的纯视图模型（无 DOM，可在 Node 单测）。
//
// 三种真实对比：
// 1. 采集记录对比（debug）：两次 debug 历史里的请求 / 控制台输出；
// 2. 录制对比（ops）：两次操作录制的步骤序列；
// 3. 审计窗口对比（audit）：两个时间窗口的任务序列。
//
// 统一输出：摘要行 + 分区（新增/移除/变化/相同）+ 差异行。页面 mount 即可。

import { formatLabel } from '../lib/labels.js';
import { compareCaptureRuns, compareEventSequences, diffStats, sideBySide, unifiedHunks, lineRangeLabel } from '../lib/diff.js';
import { formatDuration, formatTimestamp, truncateMiddle } from '../lib/format.js';
import { h, diffRow, stateBlock, button } from '../lib/render.js';

function summaryText(summary, lang) {
  return formatLabel('compare.summary', {
    added: summary.added,
    removed: summary.removed,
    changed: summary.changed,
  }, lang);
}

/** 一个可折叠分区：标题 + 计数 + 子节点。 */
function section(kind, title, count, children) {
  const node = h('section', { class: 'cmp-section cmp-' + kind }, [
    h('h4', { class: 'cmp-section-title' }, [title + ' (' + count + ')']),
    h('div', { class: 'cmp-section-body' }, children),
  ]);
  return node;
}

function emptySectionHint(lang) {
  return h('p', { class: 'muted' }, formatLabel('compare.identical', {}, lang));
}

/**
 * 采集记录对比视图。
 * @param {{base:object, other:object, lang?:string, baseLabel?:string, otherLabel?:string,
 *   onPickBase?:Function, onPickOther?:Function}} input
 */
export function buildCaptureCompareView(input = {}) {
  const lang = input.lang || 'zh';
  const base = input.base || {};
  const other = input.other || {};
  if (!input.base || !input.other) {
    return {
      empty: true,
      tree: stateBlock({
        kind: 'empty',
        message: formatLabel('compare.needTwo', {}, lang),
        retry: input.onPickBase ? { label: formatLabel('compare.pick', {}, lang), on: input.onPickBase } : null,
      }),
      summary: { added: 0, removed: 0, changed: 0, identical: false },
    };
  }
  const result = compareCaptureRuns(base, other);
  const summary = result.summary;
  const children = [
    h('p', { class: 'cmp-summary', 'aria-live': 'polite' }, summary.identical ? formatLabel('compare.identical', {}, lang) : summaryText(summary, lang)),
  ];
  const baseTitle = input.baseLabel || String(base.title || base.url || formatLabel('compare.left', {}, lang));
  const otherTitle = input.otherLabel || String(other.title || other.url || formatLabel('compare.right', {}, lang));
  children.push(h('div', { class: 'kv-inline' }, [
    h('span', { class: 'muted' }, formatLabel('compare.left', {}, lang) + ': ' + truncateMiddle(baseTitle, 48)),
    h('span', { class: 'muted' }, formatLabel('compare.right', {}, lang) + ': ' + truncateMiddle(otherTitle, 48)),
  ]));

  // 请求差异：新增 / 移除 / 变化（请求顺序不参与对比，按 key 对齐更符合直觉）。
  const requestRows = (list, tone) => list.map((item) => h('div', { class: 'list-row ' + tone, role: 'row' }, [
    h('span', { class: 'mono grow truncate' }, renderRequestLabel(item.row || item.left || item.right || {})),
  ]));
  children.push(section('added', formatLabel('compare.added', {}, lang), result.requests.added.length, result.requests.added.length ? requestRows(result.requests.added, 'added') : [emptySectionHint(lang)]));
  children.push(section('removed', formatLabel('compare.removed', {}, lang), result.requests.removed.length, result.requests.removed.length ? requestRows(result.requests.removed, 'removed') : [emptySectionHint(lang)]));
  children.push(section('changed', formatLabel('compare.changed', {}, lang), result.requests.changed.length, result.requests.changed.length
    ? result.requests.changed.map((item) => h('div', { class: 'list-row changed', role: 'row' }, [
      h('span', { class: 'mono grow truncate' }, renderRequestLabel(item.left)),
      h('span', { class: 'muted mono' }, '→ ' + renderRequestLabel(item.right)),
    ]))
    : [emptySectionHint(lang)]));

  // 控制台差异：多重集计数（同一条输出出现次数变化也算差异）。
  const consoleRows = (list, tone) => list.map((item) => h('div', { class: 'list-row ' + tone, role: 'row' }, [
    h('span', { class: 'mono grow truncate' }, truncateMiddle(item.key, 160) + (item.count > 1 ? ' ×' + item.count : '')),
  ]));
  children.push(section('console-added', formatLabel('compare.added', {}, lang) + ' · console', result.console.added.length, result.console.added.length ? consoleRows(result.console.added, 'added') : [emptySectionHint(lang)]));
  children.push(section('console-removed', formatLabel('compare.removed', {}, lang) + ' · console', result.console.removed.length, result.console.removed.length ? consoleRows(result.console.removed, 'removed') : [emptySectionHint(lang)]));

  const tree = h('div', { class: 'cmp-root', role: 'region', 'aria-label': formatLabel('compare.title', {}, lang) }, children);
  return { empty: false, tree, result, summary };
}

function renderRequestLabel(row) {
  if (!row || typeof row !== 'object') return String(row || '');
  const method = String(row.method || 'GET').toUpperCase();
  const status = row.status === undefined || row.status === null ? '' : ' ' + String(row.status);
  const duration = row.durationMs === undefined || row.durationMs === null ? '' : ' · ' + formatDuration(row.durationMs);
  return method + status + ' ' + truncateMiddle(String(row.url || ''), 120) + duration;
}

/**
 * 事件序列对比视图（ops 录制 / audit 任务序列）。
 * @param {{leftEvents:Array, rightEvents:Array, lang?:string, title?:string, summarize?:Function,
 *   leftLabel?:string, rightLabel?:string}} input
 */
export function buildSequenceCompareView(input = {}) {
  const lang = input.lang || 'zh';
  const left = Array.isArray(input.leftEvents) ? input.leftEvents : [];
  const right = Array.isArray(input.rightEvents) ? input.rightEvents : [];
  if (!left.length && !right.length) {
    return { empty: true, tree: stateBlock({ kind: 'empty', message: formatLabel('compare.needTwo', {}, lang) }), stats: diffStats([]) };
  }
  const result = compareEventSequences(left, right, { summarize: input.summarize });
  const stats = result.stats;
  const rows = sideBySide(result.ops).map((row) => diffRow({
    type: row.type,
    leftNumber: row.left ? lineRangeLabel(row.left.aIndex, 1) : '',
    rightNumber: row.right ? lineRangeLabel(row.right.bIndex, 1) : '',
    text: (row.left && row.left.text) || (row.right && row.right.text) || '',
    ariaLabel: formatLabel(row.type === 'insert' ? 'compare.added' : row.type === 'delete' ? 'compare.removed' : 'compare.same', {}, lang),
  }));
  const hunks = result.hunks.map((hunk, index) => h('div', { class: 'diff-hunk' }, [
    h('div', { class: 'diff-hunk-title muted' }, formatLabel('diff.hunk', { index: index + 1 }, lang) + '  @' + lineRangeLabel(hunk.aStart, hunk.aCount) + ' / ' + lineRangeLabel(hunk.bStart, hunk.bCount)),
    h('div', { class: 'diff-body', role: 'table', 'aria-rowcount': String(hunk.ops.length) }, hunk.ops.map((op) => diffRow({
      type: op.type,
      leftNumber: op.aIndex === null ? '' : String(op.aIndex + 1),
      rightNumber: op.bIndex === null ? '' : String(op.bIndex + 1),
      text: op.text,
    }))),
  ]));
  const children = [
    h('p', { class: 'cmp-summary', 'aria-live': 'polite' }, stats.identical ? formatLabel('compare.identical', {}, lang) : summaryText({ added: stats.added, removed: stats.removed, changed: 0 }, lang)),
    hunks.length ? h('div', { class: 'diff-hunks' }, hunks) : h('p', { class: 'muted' }, formatLabel('diff.empty', {}, lang)),
  ];
  if (input.title) children.unshift(h('h3', { class: 'cmp-title' }, input.title));
  const tree = h('div', { class: 'cmp-root', role: 'region', 'aria-label': formatLabel('compare.title', {}, lang) }, children);
  return { empty: false, tree, result, stats, rows };
}

/**
 * 通用「两条记录」对比入口：按 kind 选择对比口径。
 * @param {{kind?:'capture'|'events', lang?:string, [key:string]:any}} input
 */
export function buildCompareView(input = {}) {
  const kind = input.kind === 'events' ? 'events' : 'capture';
  const view = kind === 'events' ? buildSequenceCompareView(input) : buildCaptureCompareView(input);
  return { ...view, kind };
}

/**
 * 对比记录选择器描述（两个 <select> + 一个对比按钮）。
 * @param {{records:Array<{id:string,label:string}>, base?:string, other?:string, lang?:string,
 *   onBase?:(value:string)=>void, onOther?:(value:string)=>void, onCompare?:Function, disabled?:boolean}} input
 */
export function buildComparePicker(input = {}) {
  const lang = input.lang || 'zh';
  const records = Array.isArray(input.records) ? input.records : [];
  const select = (id, label, value, onChange) => {
    const node = h('select', {
      id,
      class: 'inline-input',
      'aria-label': label,
      style: { 'min-inline-size': '160px' },
    }, records.map((record) => {
      const option = h('option', { value: String(record.id) }, String(record.label));
      if (String(record.id) === String(value)) option.attrs.selected = '';
      return option;
    }));
    if (onChange) node.on = { change: (event) => onChange(event && event.target ? event.target.value : '') };
    else node.attrs.disabled = '';
    return node;
  };
  const compareButton = button({
    label: formatLabel('compare.title', {}, lang),
    tone: 'primary',
    disabled: input.disabled === true,
    on: input.onCompare ? { click: input.onCompare } : null,
  });
  return h('div', { class: 'cmp-picker toolbar' }, [
    h('span', { class: 'muted' }, formatLabel('compare.pickBase', {}, lang)),
    select('compareBase', formatLabel('compare.pickBase', {}, lang), input.base || '', input.onBase),
    h('span', { class: 'muted' }, formatLabel('compare.pickOther', {}, lang)),
    select('compareOther', formatLabel('compare.pickOther', {}, lang), input.other || '', input.onOther),
    compareButton,
  ]);
}

/** 对比摘要的一行文本（工具栏/aria-live 用）。 */
export function compareSummaryLine(summary, lang = 'zh') {
  if (!summary) return '';
  if (summary.identical) return formatLabel('compare.identical', {}, lang);
  return summaryText(summary, lang);
}
