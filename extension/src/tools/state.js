// src/tools/state.js —— 跨模块共享的轻量内存状态。
export const recentFillFocus = new Map(); // tabId -> { ref, at }
export const shadowRefs = new Map(); // tabId -> Map('@eN' -> entry)
export const inputFocusCache = new Map(); // tabId -> focusedAt

import { RefRegistry } from '../refs/ref-registry.js';
/** tabId -> RefKey 注册表；后续动作层按复合身份校验。 */
export const refRegistry = new RefRegistry();
