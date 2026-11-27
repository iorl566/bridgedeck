// src/tools/interaction.js —— 动作编排层：re-export 已拆分的 pointer/fill 模块，保留 select/focus/滚动等薄命令。
import { bridgeError } from '../errors.js';
import { execPage } from '../inject.js';
import { pageAction } from './page-action.js';
import { requireTabId } from './shared.js';

export { fill, press } from './fill-actions.js';
export { click, clickBackend, hover, drag } from './pointer-actions.js';
export { forgetPointerPosition } from './pointer-primitives.js';

export async function actionable(params = {}) {
  const tabId = requireTabId(params);
  const target = params.ref ? { ref: params.ref } : (params.selector ? { selector: params.selector } : null);
  if (!target) throw bridgeError('E_BAD_ARG', 'actionable 需要 ref 或 selector');
  return execPage(tabId, 'actionable', target);
}

const rawSelect = pageAction('select');
export async function select(params = {}) {
  return rawSelect(params);
}

export const focus = pageAction('focus');
export const scrollTo = pageAction('scroll-to');
export const wheel = pageAction('wheel');
export const blur = pageAction('blur');
