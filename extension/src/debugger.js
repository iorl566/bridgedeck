// src/debugger.js —— chrome.debugger 会话管理（对话框 / 网络正文 / 仿真共用）
import { bridgeError, mapChromeError } from './errors.js';
import { log } from './log.js';
import { runCdpCommand } from './browser-driver/command-deadline.js';

const states = new Map(); // tabId -> { tabId, handlers: Map<method, Set<fn>>, onDetach }

chrome.debugger.onEvent.addListener((source, method, params) => {
  const state = states.get(source.tabId);
  if (!state) return;
  const handlers = state.handlers.get(method);
  if (!handlers) return;
  for (const handler of handlers) {
    try {
      handler(params || {});
    } catch (error) {
      log('debugger 事件处理异常 ' + method + '：' + ((error && error.message) || error));
    }
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  const state = states.get(source.tabId);
  if (!state) return;
  states.delete(source.tabId);
  log('debugger 已分离 tab=' + source.tabId + ' reason=' + reason);
  if (typeof state.onDetach === 'function') {
    try {
      state.onDetach(reason);
    } catch (error) {
      log('onDetach 回调异常', error && error.message);
    }
  }
});

/** 挂上 debugger；同一 tab 重复调用复用同一会话。 */
export async function attach(tabId) {
  const existing = states.get(tabId);
  if (existing) return existing;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (error) {
    const message = String((error && error.message) || error);
    if (/another debugger|already attached/i.test(message)) {
      throw bridgeError('E_DEBUGGER_BUSY', 'tab ' + tabId + ' 已被其它调试会话占用');
    }
    throw mapChromeError(error, '挂载调试器失败');
  }
  const state = { tabId, handlers: new Map(), onDetach: null };
  states.set(tabId, state);
  log('debugger 已挂载 tab=' + tabId);
  return state;
}

export function isAttached(tabId) {
  return states.has(tabId);
}

/** 谁在用 debugger：对话框/网络/仿真各自持有引用，全部释放后才真正 detach（提示条随之消失）。 */
const users = new Map(); // tabId -> Set<feature>

export async function acquire(tabId, feature) {
  const state = await attach(tabId);
  let set = users.get(tabId);
  if (!set) {
    set = new Set();
    users.set(tabId, set);
  }
  set.add(feature);
  return state;
}

export async function release(tabId, feature) {
  const set = users.get(tabId);
  if (!set) return;
  set.delete(feature);
  if (set.size === 0) {
    users.delete(tabId);
    await detach(tabId);
  }
}

export function activeFeatures(tabId) {
  const set = users.get(tabId);
  return set ? [...set] : [];
}

export function onEvent(state, method, handler) {
  let set = state.handlers.get(method);
  if (!set) {
    set = new Set();
    state.handlers.set(method, set);
  }
  set.add(handler);
  return () => {
    const current = state.handlers.get(method);
    if (current) current.delete(handler);
  };
}

export function send(tabId, method, params) {
  return runCdpCommand({ tabId }, method, () => chrome.debugger.sendCommand({ tabId }, method, params || {}));
}

export async function detach(tabId) {
  if (!states.has(tabId)) return false;
  try {
    await chrome.debugger.detach({ tabId });
  } catch (error) {
    log('分离 debugger 失败 tab=' + tabId + '：' + ((error && error.message) || error));
  }
  states.delete(tabId);
  return true;
}

export function detachAll() {
  for (const tabId of [...states.keys()]) {
    detach(tabId).catch(() => {});
  }
}
