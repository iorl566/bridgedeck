// ui/views/compare-matrix.js —— 多维对比矩阵视图（纯描述，无 DOM）。
//
// 既有 views/compare-view.js 做“两份记录”的差异（新增/移除/变化）。这一轮补的是
// 三条以上记录的“逐字段矩阵”：每行一个字段，每列一次记录，单元格标出与基准是否相同。
// 两个真实场景：
// - debug 页：同一请求在 3 次调试采集里的 status/耗时 对比（找抖动）；
// - ops 页：同一录制在 2 次重放里的步骤序列对比。
//
// 纯函数：模型可断言（字段数、差异数、基准列），tree 只负责渲染。

import { formatLabel } from '../lib/labels.js';
import { h, when } from '../lib/render.js';
import { formatValue } from '../lib/format.js';

/** 单元格状态：same（与基准相同）/ changed / missing（该记录没有此字段）。 */
export const CELL_STATES = Object.freeze(['same', 'changed', 'missing']);

/**
 * 字段级矩阵：每条记录是一个对象（如一条请求/一条审计）。
 * @param {{runs:Array<{id?:string, label?:string, data?:object, fields?:object}>,
 *   fields?:string[], lang?:string, baselineIndex?:number, onRemove?:Function}} input
 * @returns {{model:object, tree:object}}
 */
export function buildFieldCompareMatrix(input = {}) {
  const lang = input.lang || 'zh';
  const runs = (Array.isArray(input.runs) ? input.runs : [])
    .filter((run) => run && typeof run === 'object')
    .map((run, index) => ({
      id: String(run.id === undefined ? index : run.id),
      label: String(run.label || run.title || run.id || '#' + (index + 1)),
      data: run.data && typeof run.data === 'object' ? run.data : {},
    }));
  if (!runs.length) {
    const model = { runs: [], fields: [], differences: 0, baseline: null, empty: true, summary: formatLabel('compare.empty', {}, lang) };
    return { model, tree: h('p', { class: 'muted', role: 'status' }, model.summary) };
  }
  const baselineIndex = Math.min(runs.length - 1, Math.max(0, Math.floor(Number(input.baselineIndex) || 0)));
  const baseline = runs[baselineIndex];
  const explicit = Array.isArray(input.fields) ? input.fields.map(String) : null;
  const fields = explicit && explicit.length ? explicit : collectFields(runs.map((run) => run.data));
  const fieldRows = fields.map((field) => {
    const baselineValue = baseline.data ? baseline.data[field] : undefined;
    const cells = runs.map((run, runIndex) => {
      const value = run.data ? run.data[field] : undefined;
      const state = value === undefined || value === null
        ? 'missing'
        : (runIndex === baselineIndex ? 'same' : (equalValue(value, baselineValue) ? 'same' : 'changed'));
      return {
        runId: run.id,
        runIndex,
        state,
        value,
        text: value === undefined || value === null ? '' : formatValue(value, 120),
        isBaseline: runIndex === baselineIndex,
      };
    });
    const changed = cells.some((cell) => cell.state === 'changed');
    return { field, baselineValue, cells, changed, label: field };
  });
  const differences = fieldRows.filter((row) => row.changed).length;
  const model = {
    runs,
    fields,
    fieldRows,
    differences,
    baseline: { id: baseline.id, label: baseline.label, index: baselineIndex },
    empty: false,
    summary: formatLabel('compare.matrixSummary', { runs: runs.length, fields: fields.length, differences }, lang),
    comparable: runs.every((run) => run.data && typeof run.data === 'object'),
  };

  const header = h('div', { class: 'mx-head', role: 'row' }, [
    h('span', { role: 'columnheader', class: 'mx-field' }, formatLabel('compare.field', {}, lang)),
    ...runs.map((run, index) => h('span', {
      role: 'columnheader',
      class: 'mx-run' + (index === baselineIndex ? ' baseline' : ''),
      'aria-label': (index === baselineIndex ? formatLabel('compare.baseline', {}, lang) + ': ' : '') + run.label,
    }, run.label)),
  ]);
  const body = fieldRows.map((row) => h('div', {
    class: 'mx-row' + (row.changed ? ' changed' : ''),
    role: 'row',
    'data-mx-field': row.field,
  }, [
    h('span', { role: 'rowheader', class: 'mx-field mono' }, row.label),
    ...row.cells.map((cell) => h('span', {
      role: 'cell',
      class: 'mx-cell ' + cell.state + (cell.isBaseline ? ' baseline' : ''),
      'data-mx-state': cell.state,
      title: cell.state === 'missing' ? formatLabel('compare.notComparable', {}, lang) : cell.text,
    }, cell.state === 'missing' ? '—' : cell.text)),
  ]));
  const tree = h('section', {
    class: 'compare-matrix',
    'aria-label': formatLabel('compare.matrix', {}, lang),
    'data-compare-matrix': '1',
  }, [
    h('div', { class: 'toolbar' }, [
      h('h3', { class: 'panel-title' }, formatLabel('compare.matrix', {}, lang)),
      h('span', { class: 'grow' }),
      h('span', { class: 'muted', role: 'status', 'aria-live': 'polite' }, model.summary),
    ]),
    h('p', { class: 'muted' }, formatLabel('compare.matrixHint', {}, lang)),
    h('div', { class: 'mx-table', role: 'table', 'aria-label': formatLabel('compare.matrix', {}, lang) }, [header, ...body]),
    when(!model.comparable, h('p', { class: 'io-note warn' }, formatLabel('compare.notComparable', {}, lang))),
  ]);
  return { model, tree };
}

/** 收集所有记录出现过的字段（并集，保持首次出现顺序）。 */
export function collectFields(objects, { limit = 128 } = {}) {
  const keys = [];
  const seen = new Set();
  for (const object of Array.isArray(objects) ? objects : []) {
    if (!object || typeof object !== 'object') continue;
    for (const key of Object.keys(object)) {
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
      if (keys.length >= limit) return keys;
    }
  }
  return keys;
}

function equalValue(left, right) {
  if (left === right) return true;
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
  }
  return String(left) === String(right);
}

/**
 * 行级矩阵：每条记录是一组行（如请求序列），按 keyOf 对齐，比较“出现/缺失/字段变化”。
 * @param {{runs:Array<{id?:string,label?:string,rows?:Array<object>}>,
 *   keyOf?:(row:any)=>string, fields?:string[], lang?:string}} input
 */
export function buildRowCompareMatrix(input = {}) {
  const lang = input.lang || 'zh';
  const runs = (Array.isArray(input.runs) ? input.runs : []).map((run, index) => ({
    id: String(run && run.id !== undefined ? run.id : index),
    label: String(run && (run.label || run.title) || '#' + (index + 1)),
    rows: Array.isArray(run && run.rows) ? run.rows : [],
  }));
  const keyOf = typeof input.keyOf === 'function' ? input.keyOf : (row) => String(row && (row.id ?? row.url ?? row.key ?? JSON.stringify(row)));
  const keys = [];
  const seen = new Set();
  for (const run of runs) {
    for (const row of run.rows) {
      const key = String(keyOf(row));
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
  }
  const fields = Array.isArray(input.fields) && input.fields.length
    ? input.fields.map(String)
    : collectFields(runs.flatMap((run) => run.rows), { limit: 32 }).slice(0, 6);
  const byRun = runs.map((run) => {
    const map = new Map();
    for (const row of run.rows) {
      const key = String(keyOf(row));
      if (!map.has(key)) map.set(key, row);
    }
    return map;
  });
  const rows = keys.slice(0, 500).map((key) => {
    const present = byRun.map((map) => map.has(key));
    const cells = fields.map((field) => {
      const values = byRun.map((map) => (map.has(key) ? map.get(key)[field] : undefined));
      const defined = values.filter((value) => value !== undefined && value !== null);
      const changed = new Set(defined.map((value) => (typeof value === 'object' ? JSON.stringify(value) : String(value)))).size > 1;
      return {
        field,
        values,
        changed,
        present: values.map((value) => value !== undefined && value !== null),
        text: defined.length ? formatValue(defined[0], 80) : '',
      };
    });
    return { key, present, missing: present.filter((value) => !value).length, cells, changed: cells.some((cell) => cell.changed) };
  });
  const differences = rows.reduce((total, row) => total + (row.changed ? 1 : 0) + (row.missing ? 1 : 0), 0);
  const model = {
    runs: runs.map((run) => ({ id: run.id, label: run.label, count: run.rows.length })),
    keys,
    fields,
    rows,
    differences,
    truncated: keys.length > rows.length,
    summary: formatLabel('compare.matrixSummary', { runs: runs.length, fields: fields.length, differences }, lang),
    empty: keys.length === 0,
  };
  const header = h('div', { class: 'mx-head', role: 'row' }, [
    h('span', { role: 'columnheader', class: 'mx-field' }, 'key'),
    ...fields.map((field) => h('span', { role: 'columnheader', class: 'mx-run' }, field)),
    ...runs.map((run) => h('span', { role: 'columnheader', class: 'mx-present' }, run.label)),
  ]);
  const body = rows.map((row) => h('div', { class: 'mx-row' + (row.changed || row.missing ? ' changed' : ''), role: 'row', 'data-mx-key': row.key }, [
    h('span', { role: 'rowheader', class: 'mx-field mono' }, row.key),
    ...row.cells.map((cell) => h('span', { role: 'cell', class: 'mx-cell ' + (cell.changed ? 'changed' : 'same'), 'data-mx-state': cell.changed ? 'changed' : 'same' }, cell.text)),
    ...row.present.map((present) => h('span', { role: 'cell', class: 'mx-present ' + (present ? 'yes' : 'no') }, present ? '●' : '—')),
  ]));
  const tree = h('section', { class: 'compare-matrix row-matrix', 'aria-label': formatLabel('compare.matrix', {}, lang), 'data-compare-row-matrix': '1' }, [
    h('div', { class: 'toolbar' }, [
      h('h3', { class: 'panel-title' }, formatLabel('compare.matrix', {}, lang)),
      h('span', { class: 'grow' }),
      h('span', { class: 'muted', role: 'status', 'aria-live': 'polite' }, model.summary),
    ]),
    h('p', { class: 'muted' }, formatLabel('compare.matrixHint', {}, lang)),
    when(rows.length > 0, h('div', { class: 'mx-table', role: 'table', 'aria-label': formatLabel('compare.matrix', {}, lang) }, [header, ...body])),
    when(rows.length === 0, h('p', { class: 'muted', role: 'status' }, formatLabel('compare.empty', {}, lang))),
    when(model.truncated, h('p', { class: 'muted' }, formatLabel('import.truncated', {}, lang))),
  ]);
  return { model, tree };
}

/** 多记录选择条：每列一个可移除的记录 chip + “添加记录”下拉。 */
export function buildRunPicker({ runs = [], choices = [], lang = 'zh', onPick, onRemove } = {}) {
  const selected = (Array.isArray(runs) ? runs : []).map((run, index) => ({
    id: String(run.id === undefined ? index : run.id),
    label: String(run.label || run.title || run.id || '#' + (index + 1)),
  }));
  const selectedIds = new Set(selected.map((run) => run.id));
  const options = (Array.isArray(choices) ? choices : [])
    .filter((choice) => !selectedIds.has(String(choice.id)))
    .map((choice) => ({ id: String(choice.id), label: String(choice.label || choice.id) }));
  const chips = selected.map((run) => h('span', { class: 'run-chip', 'data-run-chip': run.id }, [
    h('span', { class: 'run-chip-label' }, run.label),
    h('button', {
      type: 'button',
      class: 'chip-close',
      'aria-label': formatLabel('compare.removeRun', { label: run.label }, lang),
      'data-run-remove': run.id,
    }, '×'),
  ]));
  for (const chip of chips) {
    const close = chip.children[1];
    if (typeof onRemove === 'function') close.on = { click: () => onRemove(close.attrs['data-run-remove']) };
  }
  const picker = h('label', { class: 'run-picker' }, [
    h('span', { class: 'muted' }, formatLabel('compare.addRun', {}, lang)),
    h('select', { class: 'inline-input', 'aria-label': formatLabel('compare.addRun', {}, lang), 'data-run-picker': '1' }, [
      h('option', { value: '' }, '—'),
      ...options.map((option) => h('option', { value: option.id }, option.label)),
    ]),
  ]);
  if (typeof onPick === 'function') picker.children[1].on = { change: (event) => onPick(event && event.target ? event.target.value : '') };
  return h('div', { class: 'run-picker-row', role: 'group', 'aria-label': formatLabel('compare.runs', { count: selected.length }, lang) }, [...chips, picker]);
}

/** 摘要行（记录数 / 差异数）。 */
export function buildMatrixSummary(model, lang = 'zh') {
  const source = model && typeof model === 'object' ? model : {};
  return formatLabel('compare.matrixSummary', {
    runs: Array.isArray(source.runs) ? source.runs.length : 0,
    fields: Array.isArray(source.fields) ? source.fields.length : 0,
    differences: Number(source.differences) || 0,
  }, lang);
}
