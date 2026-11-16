// src/tools/page-action.js —— 页面动作的统一入口（通过 page-lib 执行）。
import { execPage } from '../inject.js';
import { requireTabId } from './shared.js';

export function pageAction(name) {
  return async function handler(params = {}) {
    const tabId = requireTabId(params);
    const frameId = Number.isInteger(params.frameId) ? params.frameId : 0;
    return execPage(tabId, name, params, frameId);
  };
}
