// ui/lib/page-tools.js —— 旧页面（debug/audit/ops/record/longshot）的 IO 增强（唯一 DOM 侧）。
//
// 第十批 E 已经给五个页面接了时间线/对比/过滤等 helper；这一轮补“把数据带走”：
// - 导出 JSON / CSV / NDJSON（页面当前可见数据 → 下载）；
// - 复制到剪贴板；
// - 导入校验（选择一个 JSON/CSV 文件，解析 + 校验 + 合并预览；只读页面不写数据，
//   避免绕过后台存储语义，报告里明确“校验结果 + 可下载归一化 JSON”）；
// - aria-live 状态播报与失败提示。
//
// 设计原则：
// 1. 只增强、不改既有行为：不碰 SELFTEST 标题、不接管列表渲染、不删除任何既有节点；
// 2. 全防御：页面被 Node 单测/桩环境加载时也不能抛错（stub DOM 上静默降级）；
// 3. 可重入：同一工具栏重复安装会被 dataset 标记挡住。

import { formatLabel } from './labels.js';
import { buildExportPayload, buildDownloadDescriptor, summarizeExport, exportPresetFor } from './io-export.js';
import { parseImport, validateImport, mergeImported, buildImportPreview } from './io-import.js';
import { createAnnouncer, liveRegionAttrs, describeTransfer } from './aria-live.js';
import { createNode, mount } from './dom.js';
import { h, button, when } from './render.js';
import { buildImportReport, importSummaryText } from '../views/import-report.js';
import { buildExportPreview } from '../views/export-preview.js';

/** 每个旧页面导出时的默认列（与页面列表的展示顺序一致）。 */
export const PAGE_EXPORT_COLUMNS = Object.freeze({
  debug: Object.freeze([
    { key: 'ts', label: 'time', type: 'timestamp' },
    { key: 'method', label: 'method' },
    { key: 'status', label: 'status', type: 'number' },
    { key: 'durationMs', label: 'durationMs', type: 'number' },
    { key: 'url', label: 'url' },
  ]),
  audit: Object.freeze([
    { key: 'ts', label: 'time', type: 'timestamp' },
    { key: 'method', label: 'method' },
    { key: 'durationMs', label: 'durationMs', type: 'number' },
    { key: 'result', label: 'result' },
    { key: 'session', label: 'session' },
    { key: 'url', label: 'url' },
  ]),
  ops: Object.freeze([
    { key: 'ts', label: 'time', type: 'timestamp' },
    { key: 'type', label: 'type' },
    { key: 'selector', label: 'selector' },
    { key: 'url', label: 'url' },
  ]),
  record: Object.freeze([
    { key: 'ts', label: 'time', type: 'timestamp' },
    { key: 'mime', label: 'mime' },
    { key: 'bytes', label: 'bytes', type: 'number' },
    { key: 'durationMs', label: 'durationMs', type: 'number' },
  ]),
  longshot: Object.freeze([
    { key: 'ts', label: 'time', type: 'timestamp' },
    { key: 'tiles', label: 'tiles', type: 'number' },
    { key: 'width', label: 'width', type: 'number' },
    { key: 'height', label: 'height', type: 'number' },
    { key: 'url', label: 'url' },
  ]),
});

/** 取页面的导出列。 */
export function columnsForPage(surface) {
  return PAGE_EXPORT_COLUMNS[surface] || PAGE_EXPORT_COLUMNS.debug;
}

/**
 * 从 DOM 列表读行（页面 provider 缺失时的兜底）：每个直接子元素一行，保留文本。
 * @param {Element|null} container
 * @returns {Array<{text:string}>}
 */
export function readDomRows(container, { selector } = {}) {
  if (!container) return [];
  let nodes = [];
  try {
    if (selector && typeof container.querySelectorAll === 'function') nodes = [...container.querySelectorAll(selector)];
    else nodes = [...(container.children || [])];
  } catch {
    return [];
  }
  return nodes.map((node, index) => {
    const text = String(node && node.textContent ? node.textContent : '').replace(/\s+/g, ' ').trim();
    return { index, text };
  }).filter((row) => row.text !== '');
}

/** 触发浏览器下载（Blob + a.click）；不可用时返回 false，调用方回退剪贴板。 */
export function downloadText(descriptor, { doc, url, anchor } = {}) {
  const documentRef = doc || (typeof document !== 'undefined' ? document : null);
  const urlRef = url || (typeof URL !== 'undefined' ? URL : null);
  if (!documentRef || !urlRef || typeof urlRef.createObjectURL !== 'function') return false;
  const payload = descriptor && typeof descriptor === 'object' ? descriptor : { text: '' };
  try {
    const blob = new Blob([String(payload.text || '')], { type: String(payload.mime || 'text/plain') });
    const href = urlRef.createObjectURL(blob);
    const node = anchor || documentRef.createElement('a');
    node.href = href;
    node.download = String(payload.name || 'bridge-export');
    node.rel = 'noopener';
    try { (documentRef.body || documentRef.documentElement).appendChild(node); } catch { /* 桩环境忽略 */ }
    node.click();
    try { node.remove(); } catch { /* 忽略 */ }
    if (payload.revoke !== false) {
      // 延迟回收，给浏览器读取 Blob 的时间；Node 测试里 unref 避免挂住进程。
      const timer = setTimeout(() => { try { urlRef.revokeObjectURL(href); } catch { /* 忽略 */ } }, 4000);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }
    return true;
  } catch {
    return false;
  }
}

/** 复制文本（优先 Clipboard API，其次后台消息，最后返回 false）。 */
export async function copyText(text, { clipboard } = {}) {
  const api = clipboard || (typeof navigator !== 'undefined' ? navigator.clipboard : null);
  if (!api || typeof api.writeText !== 'function') return false;
  try {
    await api.writeText(String(text === undefined || text === null ? '' : text));
    return true;
  } catch {
    return false;
  }
}

/**
 * 安装页面 IO 工具栏。
 * @param {{surface:string, toolsId:string, listId?:string, lang?:string|(()=>string),
 *   rows?:()=>Array<object>, columns?:Array, doc?:Document, download?:Function,
 *   copy?:Function, storageKey?:string, onQuery?:(query:string)=>void}} options
 * @returns {object|null} 句柄（null 表示环境不满足，静默跳过）
 */
export function installPageTools(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const surface = String(opts.surface || 'debug');
  const documentRef = opts.doc || (typeof document !== 'undefined' ? document : null);
  if (!documentRef) return null;
  let container = null;
  try {
    container = documentRef.getElementById(opts.toolsId || '');
  } catch { /* 桩环境 */ }
  if (!container) return null;
  try {
    if (container.dataset && container.dataset.bbIoTools === '1') return null;
    if (container.dataset) container.dataset.bbIoTools = '1';
  } catch { /* dataset 只读的桩 */ }

  const getLang = typeof opts.lang === 'function' ? opts.lang : () => (opts.lang || 'zh');
  const t = (key, params) => formatLabel(key, params, getLang());
  const announcer = createAnnouncer();
  const columns = Array.isArray(opts.columns) && opts.columns.length ? opts.columns : columnsForPage(surface);
  const rowsProvider = typeof opts.rows === 'function' ? opts.rows : () => {
    let list = null;
    try { list = documentRef.getElementById(opts.listId || ''); } catch { /* 忽略 */ }
    return readDomRows(list);
  };
  let lastImport = null;
  let reportNode = null;

  const status = documentRef.createElement('span');
  status.className = 'io-status muted';
  status.id = 'ioStatus-' + surface;
  try {
    for (const [name, value] of Object.entries(liveRegionAttrs('polite'))) status.setAttribute(name, value);
  } catch { /* 忽略 */ }
  status.textContent = t('io.rows', { count: 0 });

  const reportHost = documentRef.createElement('div');
  reportHost.className = 'io-report-host';
  try { reportHost.hidden = true; } catch { /* 忽略 */ }

  const refreshStatus = (extra) => {
    const rows = safeRows();
    let text = t('io.rows', { count: rows.length });
    if (extra) text = extra + ' · ' + text;
    try { status.textContent = text; } catch { /* 忽略 */ }
    return text;
  };
  function safeRows() {
    try {
      const rows = rowsProvider();
      return Array.isArray(rows) ? rows : [];
    } catch { return []; }
  }

  const announce = (text) => {
    announcer.announce(text);
    try { status.textContent = text; } catch { /* 忽略 */ }
  };

  const dispatchDownload = (descriptor) => (typeof opts.download === 'function'
    ? Boolean(opts.download(descriptor))
    : downloadText(descriptor, { doc: documentRef }));

  const exportNow = (format) => {
    const rows = safeRows();
    const payload = buildExportPayload({
      surface,
      format: format || exportPresetFor(surface).format,
      rows,
      columns,
      redact: true,
      keepQuery: false,
    });
    const descriptor = buildDownloadDescriptor(payload);
    const started = dispatchDownload(descriptor);
    if (started) {
      announce(describeTransfer('export', summarizeExport(payload), getLang()));
    } else {
      announce(t('export.failed', { reason: t('io.noRows') }));
    }
    return payload;
  };

  const copyNow = async (format) => {
    const rows = safeRows();
    const payload = buildExportPayload({ surface, format: format || 'json', rows, columns, redact: true, keepQuery: false });
    const done = await copyText(payload.text);
    announce(done ? t('io.copied') : t('export.failed', { reason: t('io.copy') }));
    if (typeof opts.copy === 'function') {
      try { opts.copy(payload); } catch { /* 忽略 */ }
    }
    return payload;
  };

  const renderImportReport = (parsed, validation, merge) => {
    const report = buildImportReport({ parsed, validation, merge, lang: getLang() });
    reportNode = mount(reportHost, report.tree, documentRef).node;
    try { reportHost.hidden = false; } catch { /* 忽略 */ }
    return report;
  };

  const runImport = (text, fileName) => {
    const parsed = parseImport(text, { fileName });
    const schema = { fields: columns.map((column) => ({ key: column.key, type: column.type || 'string' })) };
    const validation = parsed.objects && parsed.objects.length
      ? validateImport(parsed.objects, schema, {})
      : { ok: parsed.ok, valid: 0, invalid: 0, duplicates: 0, errors: parsed.errors, warnings: [] };
    const merge = mergeImported(safeRows(), parsed.objects || [], { strategy: 'append' });
    const preview = buildImportPreview(parsed, { limit: 12 });
    lastImport = { parsed, validation, merge, preview };
    renderImportReport(parsed, validation, merge);
    announce(importSummaryText({ total: parsed.objects ? parsed.objects.length : 0, valid: validation.valid, invalid: validation.invalid }, getLang()));
    return lastImport;
  };

  const downloadImportResult = () => {
    if (!lastImport) return null;
    const merged = lastImport.merge && Array.isArray(lastImport.merge.rows) ? lastImport.merge.rows : [];
    const payload = buildExportPayload({ surface, format: 'json', rows: merged, columns, redact: true });
    dispatchDownload(buildDownloadDescriptor(payload));
    announce(t('export.done', { count: payload.rowCount }));
    return payload;
  };

  const fileInput = documentRef.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.json,.csv,.ndjson,.jsonl,.txt,application/json,text/csv';
  fileInput.setAttribute('aria-label', t('io.chooseFile'));
  try { fileInput.hidden = true; } catch { /* 忽略 */ }
  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => runImport(String(reader.result || ''), file.name || '');
    reader.onerror = () => announce(t('import.noFile'));
    reader.readAsText(file);
  });

  const toolbar = documentRef.createElement('div');
  toolbar.className = 'io-inline-tools';
  toolbar.setAttribute('role', 'group');
  toolbar.setAttribute('aria-label', t('io.export'));
  const addButton = (label, attrs, handler) => {
    const node = documentRef.createElement('button');
    node.type = 'button';
    node.className = 'btn';
    node.textContent = label;
    for (const [name, value] of Object.entries(attrs || {})) node.setAttribute(name, value);
    if (typeof handler === 'function') node.addEventListener('click', handler);
    toolbar.appendChild(node);
    return node;
  };
  addButton(t('io.exportJson'), { 'data-page-export': 'json' }, () => exportNow('json'));
  addButton(t('io.exportCsv'), { 'data-page-export': 'csv' }, () => exportNow('csv'));
  addButton(t('io.copy'), { 'data-page-copy': 'json' }, () => { void copyNow('json'); });
  const importButton = addButton(t('io.import'), { 'data-page-import': '1' }, () => {
    try { fileInput.click(); } catch { announce(t('import.noFile')); }
  });
  importButton.setAttribute('aria-describedby', status.id);
  toolbar.appendChild(status);

  try { container.appendChild(toolbar); } catch { /* 桩环境 */ }
  try { container.appendChild(fileInput); } catch { /* 忽略 */ }
  try { container.appendChild(reportHost); } catch { /* 忽略 */ }
  refreshStatus();

  const handle = {
    surface,
    announcer,
    refresh() { return refreshStatus(); },
    exportNow,
    copyNow,
    importText(text, fileName) { return runImport(text, fileName); },
    downloadImportResult,
    get lastImport() { return lastImport; },
    rows: safeRows,
    statusText() { try { return status.textContent; } catch { return ''; } },
    dispose() {
      try { container.textContent = ''; } catch { /* 忽略 */ }
      try { delete container.dataset.bbIoTools; } catch { /* 忽略 */ }
    },
  };
  return handle;
}

/** 从一个"行文本"数组推断简单列（DOM 兜底导出用；JSON 每行一个 text 字段）。 */
export function rowsToObjects(rows, columns) {
  const list = Array.isArray(rows) ? rows : [];
  const cols = Array.isArray(columns) && columns.length ? columns : [{ key: 'text' }];
  return list.map((row, index) => {
    if (row && typeof row === 'object' && !Array.isArray(row)) return row;
    const text = String(row === undefined || row === null ? '' : row);
    // 先铺列默认值再写 text，保证文本行不会被空字符串覆盖。
    return { index, ...Object.fromEntries(cols.map((column) => [column.key, ''])), text };
  });
}

/** 工具栏描述（供页面自渲染/测试断言，不触 DOM）。 */
export function pageToolsDescriptor(surface, lang = 'zh') {
  return [
    { key: 'export-json', label: formatLabel('io.exportJson', {}, lang), format: 'json' },
    { key: 'export-csv', label: formatLabel('io.exportCsv', {}, lang), format: 'csv' },
    { key: 'copy', label: formatLabel('io.copy', {}, lang) },
    { key: 'import', label: formatLabel('io.import', {}, lang) },
  ].map((item) => ({ ...item, surface }));
}

/** 导出预览（页面/测试共用；空数据返回 null）。 */
export function previewPayload(payload, columns, lang = 'zh') {
  if (!payload || !payload.rowCount) return null;
  return buildExportPreview({ payload, columns, lang });
}

/** 空数据提示（导出按钮旁的轻量提示，不覆盖页面既有空态）。 */
export function emptyExportHint(lang = 'zh') {
  return h('p', { class: 'muted io-empty-hint' }, formatLabel('io.noRows', {}, lang));
}

/** 描述 → DOM 的小工具导出（页面/测试无需重复 import dom.js）。 */
export const descriptorToNode = createNode;
export { when, button, mount };
