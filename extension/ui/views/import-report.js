// ui/views/import-report.js —— 导入结果报告视图（纯描述，无 DOM）。
//
// 导入是“不可逆写数据”的操作，报告必须回答四个问题：
// 1. 识别成了什么格式、共多少行；
// 2. 多少行有效、多少行有问题，问题在哪一行哪一列；
// 3. 合并方式与合并前后的行数（现有/新增/替换/结果）；
// 4. 去重/截断/敏感值等警告。
//
// 报告本身是纯模型（可测试），tree 只是把模型渲染成描述。

import { formatLabel } from '../lib/labels.js';
import { h, when } from '../lib/render.js';
import { formatBytes } from '../lib/format.js';
import { formatLabelText } from '../lib/io-import.js';

/**
 * @param {{parsed?:object, validation?:object, merge?:{stats:object}, lang?:string,
 *   keyField?:string, previewLimit?:number}} input
 * @returns {{model:object, tree:object}}
 */
export function buildImportReport(input = {}) {
  const lang = input.lang || 'zh';
  const parsed = input.parsed && typeof input.parsed === 'object' ? input.parsed : {};
  const validation = input.validation && typeof input.validation === 'object' ? input.validation : null;
  const merge = input.merge && typeof input.merge === 'object' ? input.merge : null;
  const errors = Array.isArray(parsed.errors) ? parsed.errors : (validation && validation.errors) || [];
  const warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
  const total = Array.isArray(parsed.objects) ? parsed.objects.length : 0;
  const valid = validation ? validation.valid : total;
  const invalid = validation ? validation.invalid : 0;
  const duplicates = validation ? validation.duplicates : 0;

  const model = {
    ok: Boolean(parsed.ok) && (!validation || validation.ok),
    format: parsed.format || '',
    formatText: formatLabelText(parsed.format),
    detectedBy: parsed.by || '',
    total,
    valid,
    invalid,
    duplicates,
    errors: errors.slice(0, 50),
    warnings: warnings.slice(),
    bytes: Number(parsed.bytes) || 0,
    truncated: parsed.truncated === true || (validation && validation.truncated === true),
    mergeStats: merge && merge.stats ? merge.stats : null,
    keyField: String(input.keyField || ''),
    summary: importSummaryText({ total, valid, invalid, duplicates }, lang),
    rows: (errors.length ? errors.slice(0, 20) : []).map((error, index) => ({
      index,
      line: error.line === undefined ? null : error.line,
      code: error.code || '',
      field: error.field || null,
      message: String(error.message || error.code || ''),
    })),
  };

  const tree = h('section', {
    class: 'import-report',
    'aria-label': formatLabel('io.import', {}, lang),
    'data-import-report': '1',
  }, [
    h('div', { class: 'toolbar' }, [
      h('h3', { class: 'panel-title' }, formatLabel('io.import', {}, lang)),
      h('span', { class: 'grow' }),
      h('span', { class: model.ok ? 'pill ok' : 'pill err', role: 'status', 'aria-live': 'polite' }, model.summary),
    ]),
    h('div', { class: 'kv-inline' }, [
      h('span', { class: 'muted' }, formatLabel('import.detected', { format: model.formatText }, lang)),
      when(model.bytes > 0, h('span', { class: 'muted' }, formatLabel('io.size', { size: formatBytes(model.bytes) }, lang))),
      when(model.duplicates > 0, h('span', { class: 'warn' }, formatLabel('import.duplicates', { count: model.duplicates }, lang))),
    ]),
    when(Boolean(merge && merge.stats), h('p', { class: 'muted import-merge' }, formatLabel('import.mergeStats', {
      existing: merge && merge.stats ? merge.stats.existing : 0,
      appended: merge && merge.stats ? merge.stats.appended : 0,
      replaced: merge && merge.stats ? merge.stats.replaced : 0,
      result: merge && merge.stats ? merge.stats.result : 0,
    }, lang))),
    when(model.rows.length > 0, h('div', { class: 'import-errors', role: 'table', 'aria-label': formatLabel('import.errors', { count: errors.length }, lang) }, [
      h('div', { class: 'list-head', role: 'row' }, [
        h('span', { role: 'columnheader', class: 'col-line' }, formatLabel('import.errorLine', { line: '#' }, lang)),
        h('span', { role: 'columnheader', class: 'col-field' }, formatLabel('compare.field', {}, lang)),
        h('span', { role: 'columnheader', class: 'col-message' }, formatLabel('import.errors', { count: errors.length }, lang)),
      ]),
      ...model.rows.map((row) => h('div', { class: 'import-error-row', role: 'row', 'data-import-error': String(row.index) }, [
        h('span', { role: 'cell', class: 'col-line mono' }, row.line === null ? '—' : String(row.line)),
        h('span', { role: 'cell', class: 'col-field mono' }, row.field || '—'),
        h('span', { role: 'cell', class: 'col-message' }, row.message),
      ])),
    ])),
    when(model.warnings.length > 0, h('p', { class: 'muted import-warnings' }, formatLabel('import.warnings', { count: model.warnings.length }, lang) + '：' + model.warnings.slice(0, 5).join('、'))),
  ]);

  return { model, tree };
}

/** 导入摘要：`3 / 4 行有效 · 1 行有问题`。 */
export function importSummaryText({ total = 0, valid = 0, invalid = 0, duplicates = 0 }, lang = 'zh') {
  const parts = [formatLabel('import.valid', { valid: Number(valid) || 0, total: Number(total) || 0 }, lang)];
  if (invalid > 0) parts.push(formatLabel('import.invalid', { count: invalid }, lang));
  if (duplicates > 0) parts.push(formatLabel('import.duplicates', { count: duplicates }, lang));
  return parts.join(' · ');
}

/** 合并方式选择（单选组；返回描述与模型）。 */
export function buildMergeChooser(value, lang = 'zh', onChange) {
  const options = [
    { value: 'append', labelKey: 'import.mergeAppend' },
    { value: 'replace', labelKey: 'import.mergeReplace' },
    { value: 'merge', labelKey: 'import.mergeKeyed' },
  ];
  const selected = options.some((item) => item.value === value) ? value : 'append';
  const tree = h('div', { class: 'merge-chooser', role: 'radiogroup', 'aria-label': formatLabel('import.merge', {}, lang) }, options.map((option) => {
    const radio = h('button', {
      type: 'button',
      class: 'chip' + (option.value === selected ? ' on' : ''),
      role: 'radio',
      'aria-checked': option.value === selected ? 'true' : 'false',
      'data-merge-mode': option.value,
    }, formatLabel(option.labelKey, {}, lang));
    if (typeof onChange === 'function') radio.on = { click: () => onChange(option.value) };
    return radio;
  }));
  return { tree, value: selected, options: options.map((item) => item.value) };
}

/** 导入确认条（不可逆操作前的确认文案 + 两个按钮）。 */
export function buildImportConfirm({ count = 0, lang = 'zh', onConfirm, onCancel } = {}) {
  const confirm = h('button', {
    type: 'button',
    class: 'btn primary',
    'data-import-confirm': '1',
  }, formatLabel('import.confirm', { count: Number(count) || 0 }, lang));
  if (typeof onConfirm === 'function') confirm.on = { click: onConfirm };
  const cancel = h('button', { type: 'button', class: 'btn', 'data-import-cancel': '1' }, formatLabel('help.close', {}, lang));
  if (typeof onCancel === 'function') cancel.on = { click: onCancel };
  return h('div', { class: 'import-confirm', role: 'group', 'aria-label': formatLabel('io.import', {}, lang) }, [confirm, cancel]);
}

/** 空/错误提示（工作台没有可导入内容时）。 */
export function buildImportEmpty(lang = 'zh') {
  return h('p', { class: 'muted import-empty', role: 'status' }, formatLabel('import.pasteFirst', {}, lang));
}
