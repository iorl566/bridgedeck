// src/dialogs.js —— 原生对话框拦截（chrome.debugger / Page.javascriptDialogOpening）
import { bridgeError } from './errors.js';
import { acquire, onEvent, release, send } from './debugger.js';
import { log } from './log.js';

const DEFAULT_POLICY = {
  alert: 'dismiss',
  confirm: 'dismiss',
  prompt: 'dismiss',
  beforeUnload: 'dismiss',
  promptText: '',
  queue: false,
};

const QUEUE_TIMEOUT_MS = 60000;
const runtime = new Map(); // tabId -> { policy, dialogs: [], pending, installed }
const openedListeners = new Map(); // tabId -> Set<fn>
let dialogSeq = 0;

function normalizePolicy(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const pick = (key) => (input[key] === 'accept' ? 'accept' : input[key] === 'dismiss' ? 'dismiss' : DEFAULT_POLICY[key]);
  return {
    alert: pick('alert'),
    confirm: pick('confirm'),
    prompt: pick('prompt'),
    beforeUnload: pick('beforeUnload'),
    promptText: typeof input.promptText === 'string' ? input.promptText : '',
    queue: input.queue === true,
  };
}

function requireTabId(params) {
  if (!params || !Number.isInteger(params.tabId)) {
    throw bridgeError('E_BAD_ARG', '缺少 tabId（由 daemon 注入）');
  }
  return params.tabId;
}

async function answerDialog(tabId, accept, promptText) {
  const params = accept
    ? { accept: true, promptText: typeof promptText === 'string' ? promptText : '' }
    : { accept: false };
  await send(tabId, 'Page.handleJavaScriptDialog', params);
}

/** 订阅"该 tab 打开了原生对话框"。返回取消函数。 */
export function onDialogOpened(tabId, callback) {
  let set = openedListeners.get(tabId);
  if (!set) {
    set = new Set();
    openedListeners.set(tabId, set);
  }
  set.add(callback);
  return () => {
    const current = openedListeners.get(tabId);
    if (!current) return;
    current.delete(callback);
    if (!current.size) openedListeners.delete(tabId);
  };
}

function notifyOpened(tabId, dialog) {
  const set = openedListeners.get(tabId);
  if (!set) return;
  for (const callback of [...set]) {
    try {
      callback({ id: dialog.id, type: dialog.type, message: dialog.message, defaultPrompt: dialog.defaultPrompt });
    } catch (error) {
      log('对话框监听回调异常', error && error.message);
    }
  }
}

/** 该 tab 当前挂起的对话框（没有则 null）。 */
export function pendingDialog(tabId) {
  const state = runtime.get(tabId);
  if (!state || !state.pending) return null;
  return {
    id: state.pending.dialog.id,
    type: state.pending.dialog.type,
    message: state.pending.dialog.message,
    defaultPrompt: state.pending.dialog.defaultPrompt,
  };
}

async function handleOpening(tabId, event) {
  const state = runtime.get(tabId);
  if (!state) return;
  dialogSeq += 1;
  const dialog = {
    id: dialogSeq,
    type: event.type,
    message: event.message || '',
    defaultPrompt: event.defaultPrompt || '',
    at: Date.now(),
    action: null,
    pending: false,
  };
  state.dialogs.push(dialog);
  if (state.dialogs.length > 50) state.dialogs.shift();

  if (state.policy.queue === true) {
    dialog.pending = true;
    const pending = { dialog, timer: null };
    state.pending = pending;
    // 队列模式下最多挂 60s，超时自动 dismiss，避免页面永久卡死
    pending.timer = setTimeout(async () => {
      if (state.pending !== pending) return;
      state.pending = null;
      dialog.pending = false;
      dialog.action = 'timeout-dismiss';
      try {
        await answerDialog(tabId, false, '');
      } catch (error) {
        log('对话框超时自动关闭失败', error && error.message);
      }
    }, QUEUE_TIMEOUT_MS);
    log('对话框已挂起 id=' + dialog.id + ' type=' + dialog.type + '（等待 dialog handle）');
    notifyOpened(tabId, dialog);
    return;
  }

  const accept = state.policy[event.type] === 'accept';
  dialog.action = accept ? 'accept' : 'dismiss';
  try {
    await answerDialog(tabId, accept, state.policy.promptText);
    log('对话框已自动处理 id=' + dialog.id + ' type=' + dialog.type + ' action=' + dialog.action);
  } catch (error) {
    log('自动处理对话框失败', error && error.message);
  }
}

export async function dialogArm(params = {}) {
  const tabId = requireTabId(params);
  const policy = normalizePolicy(params.policy);
  const dbg = await acquire(tabId, 'dialog');
  await send(tabId, 'Page.enable');
  const existing = runtime.get(tabId);
  runtime.set(tabId, {
    policy,
    dialogs: existing ? existing.dialogs : [],
    pending: existing ? existing.pending : null,
    installed: true,
  });
  if (!dbg.dialogListenerInstalled) {
    onEvent(dbg, 'Page.javascriptDialogOpening', (event) => {
      handleOpening(tabId, event).catch((error) => log('对话框事件处理异常', error && error.message));
    });
    dbg.dialogListenerInstalled = true;
  }
  return { armed: true, policy };
}

export async function dialogDisarm(params = {}) {
  const tabId = requireTabId(params);
  const state = runtime.get(tabId);
  if (state && state.pending) {
    const pending = state.pending;
    if (pending.timer) clearTimeout(pending.timer);
    try {
      await answerDialog(tabId, false, '');
      pending.dialog.pending = false;
      pending.dialog.action = 'dismissed-on-disarm';
    } catch {
      // 页面可能已关闭
    }
  }
  runtime.delete(tabId);
  await release(tabId, 'dialog').catch(() => {});
  return { ok: true };
}

export async function dialogList(params = {}) {
  const tabId = requireTabId(params);
  const state = runtime.get(tabId);
  if (!state) return { dialogs: [], armed: false };
  const dialogs = state.dialogs.map((dialog) => ({
    id: dialog.id,
    type: dialog.type,
    message: dialog.message,
    defaultPrompt: dialog.defaultPrompt,
    action: dialog.pending ? 'pending' : dialog.action,
    at: dialog.at,
  }));
  if (params.clear === true) state.dialogs = [];
  return { dialogs, armed: true };
}

export async function dialogHandle(params = {}) {
  const tabId = requireTabId(params);
  const state = runtime.get(tabId);
  if (!state) throw bridgeError('E_BAD_ARG', '该 tab 没有挂载对话框拦截；先 dialog arm');
  const pending = state.pending;
  if (!pending) throw bridgeError('E_BAD_ARG', '当前没有挂起的对话框');
  const wanted = Number(params.id);
  if (Number.isFinite(wanted) && wanted !== pending.dialog.id) {
    throw bridgeError('E_BAD_ARG', '挂起的对话框 id 是 ' + pending.dialog.id + '，不是 ' + params.id);
  }
  if (pending.timer) clearTimeout(pending.timer);
  state.pending = null;
  pending.dialog.pending = false;
  pending.dialog.action = params.accept === true ? 'accept' : 'dismiss';
  await answerDialog(tabId, params.accept === true, params.promptText);
  return { ok: true, id: pending.dialog.id, action: pending.dialog.action };
}

/** 标签页关闭/调试器分离时清理运行时状态。 */
export function forgetDialogTab(tabId) {
  const state = runtime.get(tabId);
  if (state && state.pending && state.pending.timer) clearTimeout(state.pending.timer);
  runtime.delete(tabId);
}

/** dialog.status：与 list 相同的视图，便于对齐 dialog status。 */
export async function dialogStatus(params = {}) {
  return dialogList(params);
}

/** dialog.accept：接受指定对话框（prompt 可带 text）。 */
export async function dialogAccept(params = {}) {
  return dialogHandle({ ...params, accept: params.text !== undefined ? true : true, promptText: params.text });
}

/** dialog.dismiss：拒绝指定对话框。 */
export async function dialogDismiss(params = {}) {
  return dialogHandle({ ...params, accept: false });
}
