// ui/views/io-toolbar.js —— 导入/导出工具栏视图模型（纯描述，无 DOM）。
//
// 工作台与旧页面（debug/audit/ops/record/longshot）共用同一个工具栏：格式选择、
// 导出、复制、导入、载入记录。按钮的可用性完全由数据推导（没有数据时导出禁用、
// 载入按钮按页面能力显示），页面只负责挂 on 事件。

import { formatLabel } from '../lib/labels.js';
import { h, button, fragment, when } from '../lib/render.js';
import { EXPORT_FORMATS } from '../lib/io-export.js';
import { formatBytes } from '../lib/format.js';

/** 工具栏可用的“载入来源”（不同页面暴露不同按钮）。 */
export const LOAD_SOURCES = Object.freeze([
  { key: 'audit', labelKey: 'io.loadAudit', type: 'bb.audit.list' },
  { key: 'debug', labelKey: 'io.loadDebug', type: 'bb.debug.history' },
  { key: 'ops', labelKey: 'io.loadOps', type: 'bb.ops.list' },
]);

/** 格式下拉的选项文本（技术词，不翻译）。 */
const FORMAT_TEXT = Object.freeze({ json: 'JSON', csv: 'CSV', ndjson: 'NDJSON' });

/**
 * 构建工具栏模型。
 * @param {{surface?:string, lang?:string, format?:string, rows?:number, selected?:number,
 *   disabled?:boolean, sources?:string[], onFormat?:Function, onExport?:Function,
 *   onCopy?:Function, onImport?:Function, onLoad?:Function, onClear?:Function}} input
 * @returns {{tree:object, model:object}}
 */
export function buildIoToolbar(input = {}) {
  const lang = input.lang || 'zh';
  const surface = input.surface || 'workspace';
  const rows = Math.max(0, Number(input.rows) || 0);
  const selected = Math.max(0, Number(input.selected) || 0);
  const format = EXPORT_FORMATS.includes(input.format) ? input.format : 'json';
  const disabled = input.disabled === true || rows === 0;
  const sources = (Array.isArray(input.sources) ? input.sources : LOAD_SOURCES.map((item) => item.key))
    .map((key) => LOAD_SOURCES.find((item) => item.key === key))
    .filter(Boolean);

  const formatSelect = h('label', { class: 'io-format' }, [
    h('span', { class: 'muted' }, formatLabel('io.format', {}, lang)),
    h('select', {
      class: 'inline-input',
      'aria-label': formatLabel('io.format', {}, lang),
      ...(input.onFormat ? { 'data-io-format': '1' } : {}),
    }, EXPORT_FORMATS.map((value) => h('option', { value, ...(value === format ? { selected: true } : {}) }, FORMAT_TEXT[value]))),
  ]);

  const exportButton = button({
    label: formatLabel('io.export', {}, lang),
    tone: 'primary',
    disabled,
    attrs: { 'data-io-export': '1', 'aria-describedby': 'ioSummary' },
  });
  if (!disabled && typeof input.onExport === 'function') exportButton.on = { click: () => input.onExport(format) };

  const copyButton = button({
    label: formatLabel('io.copy', {}, lang),
    disabled,
    attrs: { 'data-io-copy': '1' },
  });
  if (!disabled && typeof input.onCopy === 'function') copyButton.on = { click: () => input.onCopy(format) };

  const importButton = button({
    label: formatLabel('io.import', {}, lang),
    attrs: { 'data-io-import': '1' },
  });
  if (typeof input.onImport === 'function') importButton.on = { click: () => input.onImport() };

  const clearButton = button({
    label: formatLabel('io.clearData', {}, lang),
    tone: 'danger',
    disabled: rows === 0,
    attrs: { 'data-io-clear': '1' },
  });
  if (rows > 0 && typeof input.onClear === 'function') clearButton.on = { click: () => input.onClear() };

  const loadButtons = sources.map((source) => {
    const node = button({
      label: formatLabel(source.labelKey, {}, lang),
      attrs: { 'data-io-load': source.key },
    });
    if (typeof input.onLoad === 'function') node.on = { click: () => input.onLoad(source.key) };
    return node;
  });

  const summary = rows === 0
    ? formatLabel('io.needData', {}, lang)
    : formatLabel('io.rows', { count: rows }, lang) + (selected ? ' · ' + formatLabel('io.selected', { count: selected }, lang) : '');

  const tree = h('div', {
    class: 'io-toolbar',
    role: 'toolbar',
    'aria-label': formatLabel('io.tabs', {}, lang),
  }, [
    formatSelect,
    exportButton,
    copyButton,
    importButton,
    clearButton,
    ...loadButtons,
    h('span', { id: 'ioSummary', class: 'muted io-summary', role: 'status', 'aria-live': 'polite' }, summary),
  ]);

  return {
    tree,
    model: {
      surface,
      format,
      rows,
      selected,
      disabled,
      summary,
      buttonCount: 4 + loadButtons.length,
      formats: EXPORT_FORMATS.slice(),
      sources: sources.map((source) => source.key),
    },
  };
}

/** 导出结果行（工作台显示“已导出 N 行 / 大小 / 脱敏”）。 */
export function buildExportResultLine(payload, lang = 'zh') {
  const source = payload && typeof payload === 'object' ? payload : {};
  const rows = Number(source.rowCount) || 0;
  if (!rows) {
    return h('p', { class: 'muted', role: 'status', 'aria-live': 'polite' }, formatLabel('export.noRows', {}, lang));
  }
  const parts = [formatLabel('export.done', { count: rows }, lang)];
  if (source.bytes) parts.push(formatLabel('export.bytes', { size: formatBytes(source.bytes) }, lang));
  if (source.redacted) parts.push(formatLabel('export.redacted', { count: source.redacted }, lang));
  if (source.truncated) parts.push(formatLabel('export.truncated', {}, lang));
  return h('p', { class: 'muted', role: 'status', 'aria-live': 'polite' }, parts.join(' · '));
}

/** 载入失败/成功提示（页面 note 区）。 */
export function buildLoadNotice(sourceKey, { ok, count = 0, error, lang = 'zh' } = {}) {
  const label = (LOAD_SOURCES.find((item) => item.key === sourceKey) || { labelKey: 'io.loadFailed' }).labelKey;
  if (ok) {
    return h('p', { class: 'io-note ok', role: 'status', 'aria-live': 'polite' }, formatLabel('io.loaded', { count }, lang));
  }
  const text = error ? String(error.message || error.text || error) : formatLabel('io.loadFailed', {}, lang);
  return h('p', { class: 'io-note err', role: 'alert' }, formatLabel('export.failed', { reason: text }, lang));
}

/** 提示行（导入/导出工具栏下方的帮助文本）。 */
export function buildIOHint({ surface, lang = 'zh', text } = {}) {
  return h('p', { class: 'muted io-hint' }, text || formatLabel('io.importHint', {}, lang));
}

/** 数据统计条：`行数 · 大小 · 脱敏`。 */
export function buildDataStats({ rows = 0, bytes = 0, selected = 0, lang = 'zh' } = {}) {
  const parts = [formatLabel('io.rows', { count: Number(rows) || 0 }, lang)];
  if (bytes) parts.push(formatLabel('io.size', { size: formatBytes(bytes) }, lang));
  if (selected) parts.push(formatLabel('io.selected', { count: Number(selected) || 0 }, lang));
  return h('p', { class: 'io-stats muted' }, parts.join(' · '));
}

/** 导出分片提示（大文件）。 */
export function buildSplitNotice(parts, lang = 'zh') {
  const count = Array.isArray(parts) ? parts.length : 0;
  return when(count > 1, h('p', { class: 'io-note warn', role: 'status', 'aria-live': 'polite' }, formatLabel('io.split', { count }, lang)));
}
