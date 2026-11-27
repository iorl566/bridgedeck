// ui/views/columns-panel.js —— 列配置面板视图模型（纯描述，无 DOM）。
//
// 面板是一组“显示/隐藏 + 上下移动 + 宽度”的列表，外加恢复默认/显示全部。
// 每个操作都对应 columns-model 的一个纯函数；这里只负责把 state 渲染成
// 带 aria 的可操作描述（checkbox role、aria-label 用列名、按钮有可访问名称）。

import { formatLabel } from '../lib/labels.js';
import { h, button, when } from '../lib/render.js';
import { orderedColumns, columnsSummary, WIDTH_MIN, WIDTH_MAX } from '../lib/columns-model.js';

/**
 * @param {{state:object, lang?:string, limit?:number,
 *   onToggle?:Function, onMove?:Function, onResize?:Function, onReset?:Function,
 *   onShowAll?:Function, onClose?:Function}} input
 * @returns {{tree:object, model:object}}
 */
export function buildColumnsPanel(input = {}) {
  const lang = input.lang || 'zh';
  const state = input.state && typeof input.state === 'object' ? input.state : null;
  const columns = orderedColumns(state);
  const summary = columnsSummary(state, lang);

  const rows = columns.map((column) => {
    const toggle = h('button', {
      type: 'button',
      class: 'col-toggle' + (column.visible ? ' on' : ''),
      role: 'switch',
      'aria-checked': column.visible ? 'true' : 'false',
      'aria-label': column.label,
      'data-col-toggle': column.key,
      disabled: column.visible && !column.hideable ? true : undefined,
    }, column.visible ? '●' : '○');
    if (typeof input.onToggle === 'function' && !(column.visible && !column.hideable)) {
      toggle.on = { click: () => input.onToggle(column.key) };
    }
    const up = button({
      label: formatLabel('columns.moveUp', {}, lang),
      disabled: !column.canMoveUp,
      attrs: { 'data-col-up': column.key, 'aria-label': formatLabel('columns.moveUp', {}, lang) + ' ' + column.label },
    });
    if (column.canMoveUp && typeof input.onMove === 'function') up.on = { click: () => input.onMove(column.key, -1) };
    const down = button({
      label: formatLabel('columns.moveDown', {}, lang),
      disabled: !column.canMoveDown,
      attrs: { 'data-col-down': column.key, 'aria-label': formatLabel('columns.moveDown', {}, lang) + ' ' + column.label },
    });
    if (column.canMoveDown && typeof input.onMove === 'function') down.on = { click: () => input.onMove(column.key, 1) };
    const narrower = button({
      label: '−',
      attrs: { 'data-col-narrow': column.key, 'aria-label': formatLabel('columns.narrower', {}, lang) + ' ' + column.label },
      disabled: column.width <= WIDTH_MIN,
    });
    if (column.width > WIDTH_MIN && typeof input.onResize === 'function') narrower.on = { click: () => input.onResize(column.key, -1) };
    const wider = button({
      label: '+',
      attrs: { 'data-col-wide': column.key, 'aria-label': formatLabel('columns.wider', {}, lang) + ' ' + column.label },
      disabled: column.width >= WIDTH_MAX,
    });
    if (column.width < WIDTH_MAX && typeof input.onResize === 'function') wider.on = { click: () => input.onResize(column.key, 1) };

    return h('li', {
      class: 'col-row' + (column.visible ? '' : ' off'),
      role: 'listitem',
      'data-col-key': column.key,
      'data-col-visible': column.visible ? '1' : '0',
    }, [
      toggle,
      h('span', { class: 'col-label' }, column.label),
      h('span', { class: 'col-type muted' }, column.type),
      h('span', { class: 'col-width muted' }, formatLabel('columns.width', { width: column.width }, lang)),
      h('span', { class: 'col-actions' }, [narrower, wider, up, down]),
    ]);
  });

  const resetButton = button({ label: formatLabel('columns.reset', {}, lang), attrs: { 'data-col-reset': '1' } });
  if (typeof input.onReset === 'function') resetButton.on = { click: () => input.onReset() };
  const showAllButton = button({ label: formatLabel('columns.showAll', {}, lang), attrs: { 'data-col-show-all': '1' } });
  if (typeof input.onShowAll === 'function') showAllButton.on = { click: () => input.onShowAll() };
  const closeButton = button({ label: formatLabel('help.close', {}, lang), attrs: { 'data-col-close': '1' } });
  if (typeof input.onClose === 'function') closeButton.on = { click: () => input.onClose() };

  const tree = h('section', {
    class: 'columns-panel',
    'aria-label': formatLabel('columns.title', {}, lang),
    'data-columns-panel': '1',
  }, [
    h('div', { class: 'toolbar' }, [
      h('h3', { class: 'panel-title' }, formatLabel('columns.title', {}, lang)),
      h('span', { class: 'grow' }),
      resetButton,
      showAllButton,
      closeButton,
    ]),
    h('p', { class: 'muted columns-summary', role: 'status', 'aria-live': 'polite', 'data-columns-summary': '1' }, summary),
    h('ul', { class: 'col-list', role: 'list' }, rows),
    when(columns.length === 0, h('p', { class: 'muted' }, formatLabel('columns.needOne', {}, lang))),
  ]);

  return {
    tree,
    model: {
      columns,
      summary,
      visible: columns.filter((column) => column.visible).length,
      total: columns.length,
      presets: ['compact', 'default', 'wide'],
    },
  };
}

/** 列配置状态提示（操作被拒绝时给原因）。 */
export function buildColumnsNotice(reason, lang = 'zh') {
  if (!reason || reason === 'noop' || reason === 'moved' || reason === 'resized' || reason === 'sorted') return null;
  const map = {
    'last-visible': 'columns.needOne',
    'not-hideable': 'columns.notHideable',
    'no-hideable': 'columns.needOne',
  };
  const key = map[reason];
  if (!key) return null;
  return h('p', { class: 'io-note warn', role: 'status', 'aria-live': 'polite' }, formatLabel(key, {}, lang));
}
