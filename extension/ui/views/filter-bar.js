// ui/views/filter-bar.js —— 过滤工具栏视图模型（纯描述，无 DOM）。
//
// 结构：输入框（aria-label + 帮助文本）+ 常用过滤按钮 + 已生效条件的芯片 + 匹配计数。
// 输入框每次 input 只回调文本，页面拿到后调用 filter-model 计算；芯片删除按钮回调
// “删掉后剩余查询串”。

import { formatLabel } from '../lib/labels.js';
import { h, button, fragment, when } from '../lib/render.js';
import { activeChips, savedFiltersFor, filterSummary, suggestFields } from '../lib/filter-model.js';

/**
 * @param {{lang?:string, surface?:string, query?:string, result?:object, fields?:Array,
 *   savedFilters?:Array, disabled?:boolean, placeholder?:string,
 *   onInput?:Function, onClear?:Function, onRemove?:Function, onApplySaved?:Function}} input
 * @returns {{tree:object, model:object}}
 */
export function buildFilterBar(input = {}) {
  const lang = input.lang || 'zh';
  const surface = input.surface || 'workspace';
  const query = String(input.query || '');
  const result = input.result && typeof input.result === 'object' ? input.result : { matched: 0, total: 0 };
  const fields = Array.isArray(input.fields) ? input.fields : [];
  const chips = activeChips(query, { surface, fields, lang });
  const saved = Array.isArray(input.savedFilters) ? input.savedFilters : savedFiltersFor(surface, { fields, lang });
  const summary = filterSummary({ ...result, query }, lang);
  const hasErrors = Array.isArray(result.errors) && result.errors.length > 0;

  const inputNode = h('input', {
    type: 'search',
    class: 'inline-input filter-input',
    value: query,
    placeholder: input.placeholder || formatLabel('filter.placeholder', {}, lang),
    'aria-label': formatLabel('filter.title', {}, lang),
    'aria-describedby': 'filterHelp',
    autocomplete: 'off',
    spellcheck: 'false',
    'data-filter-input': '1',
  });
  if (typeof input.onInput === 'function') inputNode.on = { input: (event) => input.onInput(event && event.target ? event.target.value : '') };

  const clearNode = button({
    label: formatLabel('filter.clear', {}, lang),
    attrs: { 'data-filter-clear': '1' },
    disabled: query === '',
  });
  if (query !== '' && typeof input.onClear === 'function') clearNode.on = { click: () => input.onClear() };

  const savedNodes = saved.map((item) => {
    const node = button({
      label: item.text,
      attrs: { 'data-filter-saved': item.key, title: item.query },
    });
    if (typeof input.onApplySaved === 'function') node.on = { click: () => input.onApplySaved(item.query) };
    return node;
  });

  const chipNodes = chips.map((chip) => h('span', { class: 'filter-chip', 'data-filter-chip': chip.key }, [
    h('span', { class: 'filter-chip-label' }, chip.label),
    h('button', {
      type: 'button',
      class: 'filter-chip-close',
      'aria-label': formatLabel('filter.clear', {}, lang) + ' ' + chip.label,
      'data-filter-remove': chip.key,
    }, '×'),
  ]))
    .map((node) => {
      const close = node.children[1];
      if (typeof input.onRemove === 'function') close.on = { click: () => input.onRemove(chips.find((chip) => chip.key === close.attrs['data-filter-remove'])) };
      return node;
    });

  const errorNodes = hasErrors
    ? result.errors.slice(0, 3).map((error) => h('p', { class: 'filter-error', role: 'status' }, describeFilterError(error, lang)))
    : [];

  const tree = h('div', { class: 'filters filter-bar' }, [
    h('div', { class: 'filter-row' }, [inputNode, clearNode, ...savedNodes]),
    when(chips.length > 0, h('div', { class: 'filter-chips' }, chipNodes)),
    h('p', { id: 'filterHelp', class: 'muted filter-help' }, formatLabel('filter.help', {}, lang)),
    h('p', {
      class: 'filter-summary' + (result.matched === 0 && Number(result.total) > 0 ? ' err' : ''),
      role: 'status',
      'aria-live': 'polite',
      'data-filter-summary': '1',
    }, summary),
    ...errorNodes,
  ]);

  return {
    tree,
    model: {
      surface,
      query,
      chips,
      saved: saved.map((item) => ({ key: item.key, query: item.query, text: item.text })),
      matched: Number(result.matched) || 0,
      total: Number(result.total) || 0,
      summary,
      errors: Array.isArray(result.errors) ? result.errors.slice() : [],
      suggestions: suggestFields(query, { surface, fields, lang }).slice(0, 8),
    },
  };
}

/** 过滤错误文案（未知字段 / 非法数值 / 空值）。 */
export function describeFilterError(error, lang = 'zh') {
  const source = error && typeof error === 'object' ? error : {};
  if (source.code === 'E_FILTER_UNKNOWN_FIELD') return formatLabel('filter.unknownField', { field: source.field || '?' }, lang);
  if (source.code === 'E_FILTER_BAD_NUMBER' || source.code === 'E_FILTER_EMPTY_VALUE') {
    const raw = String(source.raw || source.value || '');
    const value = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw;
    return formatLabel('filter.badValue', { value }, lang);
  }
  return formatLabel('filter.badValue', { value: String(source.raw || source.code || '?') }, lang);
}

/** 过滤为空时提示“清除过滤”，与空态视图配合。 */
export function buildFilterEmptyHint(result, lang = 'zh') {
  const source = result && typeof result === 'object' ? result : {};
  if (Number(source.matched) !== 0 || !(Number(source.total) > 0)) return null;
  return h('p', { class: 'filter-empty', role: 'status', 'aria-live': 'polite' }, formatLabel('filter.none', { total: Number(source.total) || 0 }, lang));
}

/** 搜索建议（字段补全）：页面把结果渲染为下拉项。 */
export function buildFilterSuggestions(suggestions, { lang = 'zh', onPick } = {}) {
  const list = Array.isArray(suggestions) ? suggestions : [];
  if (!list.length) return null;
  return h('ul', { class: 'filter-suggest', role: 'list' }, list.map((item) => {
    const node = h('li', { role: 'listitem' }, [
      h('button', { type: 'button', class: 'link-btn', 'data-filter-suggest': item.field }, item.field + ' · ' + item.label),
    ]);
    if (typeof onPick === 'function') node.children[0].on = { click: () => onPick(item.field) };
    return node;
  }));
}
