// ui/views/empty-state-view.js —— 空态渲染视图（纯描述，无 DOM）。
//
// lib/empty-state.js 负责“为什么空 + 给什么动作”，本文件把它渲染成描述：
// 标题、正文、脚注、主/次按钮、aria-live。页面只要 `mount(node, buildEmptyStateView(...).tree)`。

import { h, button, when } from '../lib/render.js';
import { buildEmptyState } from '../lib/empty-state.js';

/**
 * @param {{surface?:string, input?:object, reason?:string, lang?:string, query?:string,
 *   total?:number, matched?:number, error?:any, detail?:string, limit?:number,
 *   onAction?:Function, actions?:Array}} options
 * @returns {{tree:object, model:object}}
 */
export function buildEmptyStateView(options = {}) {
  const lang = options.lang || 'zh';
  const model = buildEmptyState({
    surface: options.surface,
    lang,
    reason: options.reason,
    query: options.query,
    total: options.total,
    matched: options.matched,
    error: options.error,
    detail: options.detail,
    limit: options.limit,
    actions: options.actions,
    ...(options.input && typeof options.input === 'object' ? options.input : {}),
  });
  const actionNodes = model.actions.map((action) => {
    const node = button({
      label: action.label,
      tone: action.primary ? 'primary' : '',
      attrs: { 'data-empty-action': action.key },
    });
    if (typeof options.onAction === 'function') node.on = { click: () => options.onAction(action.key, model) };
    return node;
  });
  const tree = h('div', {
    class: 'state-block empty-deep ' + model.tone,
    role: model.role,
    'aria-live': model.live,
    'aria-atomic': 'true',
    'data-empty-reason': model.reason,
    'data-empty-icon': model.icon,
  }, [
    h('div', { class: 'empty-body' }, [
      h('p', { class: 'empty-title' }, model.title),
      h('p', { class: 'empty-text' }, model.body),
      when(Boolean(model.footnote), h('p', { class: 'empty-footnote muted' }, model.footnote)),
    ]),
    when(actionNodes.length > 0, h('div', { class: 'empty-actions' }, actionNodes)),
    h('p', { class: 'sr-only', 'aria-live': 'polite' }, model.announcement),
  ]);
  return { tree, model };
}

/** 空态是否为空（页面不 mount 时直接跳过）。 */
export function isEmptyVisible(model) {
  return Boolean(model && model.reason && model.reason !== 'has-data');
}

/** 空态动作 → 事件 key 映射（页面 switch 用，集中在一处避免拼错）。 */
export const EMPTY_ACTION_KEYS = Object.freeze({
  retry: 'retry',
  refresh: 'refresh',
  import: 'import',
  load: 'load',
  'clear-filter': 'clear-filter',
  'clear-selection': 'clear-selection',
  reduce: 'reduce',
  settings: 'settings',
});
