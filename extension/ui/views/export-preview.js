// ui/views/export-preview.js —— 导出预览视图（纯描述，无 DOM）。
//
// 导出前给用户看一眼“将要写进文件的表格”：列、前几行、文件名与大小。
// 纯模型，方便测试断言“预览里的列顺序 = 列配置里的可见列顺序”。

import { formatLabel } from '../lib/labels.js';
import { h, when } from '../lib/render.js';
import { formatBytes } from '../lib/format.js';
import { sanitizeFileName } from '../lib/io-export.js';

/**
 * 把导出载荷 + 列配置压成预览模型。
 * @param {{payload?:object, columns?:Array, limit?:number, lang?:string}} input
 * @returns {{model:object, tree:object}}
 */
export function buildExportPreview(input = {}) {
  const lang = input.lang || 'zh';
  const payload = input.payload && typeof input.payload === 'object' ? input.payload : {};
  const columns = Array.isArray(input.columns) ? input.columns.filter((column) => column && column.key !== undefined) : [];
  const rows = Array.isArray(payload.preview) ? payload.preview : (Array.isArray(payload.rows) ? payload.rows.slice(0, 8) : []);
  const limit = Math.max(1, Math.min(20, Math.floor(Number(input.limit) || rows.length || 8)));
  const shown = rows.slice(0, limit);
  const model = {
    fileName: String(payload.fileName || ''),
    mime: String(payload.mime || ''),
    format: String(payload.format || 'json'),
    bytes: Number(payload.bytes) || 0,
    rowCount: Number(payload.rowCount) || 0,
    redacted: Number(payload.redacted) || 0,
    truncated: payload.truncated === true,
    warnings: Array.isArray(payload.warnings) ? payload.warnings.slice() : [],
    columns: columns.map((column) => ({ key: String(column.key), label: String(column.label || column.key) })),
    rows: shown,
    cellText: (row, column) => previewCell(row, column),
    summary: previewSummary({ rowCount: Number(payload.rowCount) || 0, bytes: Number(payload.bytes) || 0 }, lang),
    truncatedPreview: rows.length > shown.length,
  };

  const headerCells = model.columns.map((column) => h('th', { scope: 'col', role: 'columnheader' }, column.label));
  const bodyRows = shown.map((row, index) => h('div', { class: 'preview-row', role: 'row', 'data-preview-row': String(index) }, model.columns.map((column) => h('span', { role: 'cell', class: 'preview-cell mono' }, previewCell(row, column)))));
  const tree = h('section', { class: 'export-preview', 'aria-label': formatLabel('export.previewTitle', {}, lang), 'data-export-preview': '1' }, [
    h('div', { class: 'toolbar' }, [
      h('h3', { class: 'panel-title' }, formatLabel('export.previewTitle', {}, lang)),
      h('span', { class: 'grow' }),
      h('span', { class: 'muted', role: 'status', 'aria-live': 'polite' }, model.summary),
    ]),
    h('div', { class: 'kv-inline' }, [
      h('span', { class: 'muted' }, formatLabel('export.filename', { name: sanitizeFileName(model.fileName) || model.fileName }, lang)),
      when(model.bytes > 0, h('span', { class: 'muted' }, formatLabel('export.bytes', { size: formatBytes(model.bytes) }, lang))),
      when(model.truncated, h('span', { class: 'warn' }, formatLabel('export.truncated', {}, lang))),
    ]),
    when(model.redacted > 0, h('p', { class: 'muted io-note' }, formatLabel('export.redacted', { count: model.redacted }, lang))),
    when(model.columns.length > 0, h('div', { class: 'preview-table', role: 'table', 'aria-label': formatLabel('export.previewTitle', {}, lang) }, [
      h('div', { class: 'preview-head', role: 'row' }, [h('span', { role: 'columnheader', class: 'preview-index' }, '#'), ...headerCells]),
      ...bodyRows.map((row) => {
        const indexCell = h('span', { role: 'rowheader', class: 'preview-index mono' }, row.attrs['data-preview-row']);
        row.children = [indexCell, ...row.children];
        return row;
      }),
    ])),
    when(model.columns.length === 0, h('p', { class: 'muted' }, formatLabel('columns.needOne', {}, lang))),
    when(model.truncatedPreview, h('p', { class: 'muted' }, formatLabel('import.truncated', {}, lang))),
  ]);

  return { model, tree };
}

/** 单元格文本：优先列取文本函数，其次行字段（对象 JSON 化），最后空串。 */
export function previewCell(row, column) {
  if (!row || typeof row !== 'object' || !column) return '';
  try {
    if (typeof column.text === 'function') {
      const value = column.text(row);
      return value === undefined || value === null ? '' : String(value);
    }
    const value = row[column.key];
    if (value === undefined || value === null) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  } catch {
    return '?';
  }
}

/** 预览摘要：`12 行 · 3.2 KB`。 */
export function previewSummary({ rowCount = 0, bytes = 0 }, lang = 'zh') {
  const parts = [formatLabel('io.rows', { count: Number(rowCount) || 0 }, lang)];
  if (bytes) parts.push(formatLabel('export.bytes', { size: formatBytes(bytes) }, lang));
  return parts.join(' · ');
}

/** 警告列表（大小超限/截断等）。 */
export function buildExportWarnings(payload, lang = 'zh') {
  const warnings = Array.isArray(payload && payload.warnings) ? payload.warnings : [];
  if (!warnings.length) return null;
  const lines = warnings.map((warning) => {
    if (warning === 'size-limit') return formatLabel('export.truncated', {}, lang);
    if (warning === 'no-rows') return formatLabel('export.noRows', {}, lang);
    return String(warning);
  });
  return h('ul', { class: 'io-warnings', role: 'status', 'aria-live': 'polite' }, lines.map((line) => h('li', {}, line)));
}
