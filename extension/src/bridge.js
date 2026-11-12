// src/bridge.js —— service worker 生命周期、命令处理、alarm 兜底重连、弹窗消息、页面守卫
import { BridgeSocket } from './ws-client.js';
import { runSerialized } from './dispatch.js';
import { toWireError } from './errors.js';
import { redactUrl } from './redact.js';
import { recordAudit, listAudit, clearAudit } from './audit.js';
import { showRecordOverlay, hideRecordOverlay } from './record-overlay.js';
import { showTakeover, hideTakeover, setTakeoverState, getTakeoverState, clearTakeoverState } from './takeover.js';
import { capture, hideManualOverlay, manualFrame, manualSave, manualStart, popupState, saveDataUrl, saveDataUrlImage, showManualOverlay } from './quick.js';
import { readSettings, subscribeSettings, writeSettings } from './settings.js';
import { consumeSelfCreated, getAgentWindowId, refreshTakeoverForTab, resolveHumanDecision } from './tabs.js';
import { dialogAccept, dialogDismiss, dialogStatus, onDialogOpened, pendingDialog } from './dialogs.js';
import { awaitOperation, cancelOperation, registerOperation, settleOperation } from './operations.js';
import { noteNavigation } from './control.js';
import { clearInputLeases } from './input-lease.js';
import { forgetRules, reinjectRules } from './rules.js';
import { ruleAdd, ruleClear, ruleExport, ruleImport, ruleList } from './rules.js';
import { networkReplay } from './network.js';
import { activeRecordings, collectEvent, deleteRecording, listRecordings, reattach, recordTabSwitch, startRecording, stopRecording } from './ops.js';
import { debugCurrent, debugDelete, debugHistory, debugHistoryDetail, debugPerformance, debugRequest, debugStart, debugStop } from './debug.js';
import { discardVideo, fetchVideo, handleRecDone, listVideos, startVideo, stopVideo, videoState } from './video.js';
import { log, warn } from './log.js';
import { cancelCommand, isCommandCancelled, registerCommand, unregisterCommand } from './command-cancel.js';
import { createDeadline } from './command-deadline.js';
import { beginCommand, endCommand } from './command-context.js';
import { installFrameGraphInvalidation } from './frame-graph.js';

const RECONNECT_ALARM = 'bb-reconnect';
const ALARM_PERIOD_MINUTES = 0.5; // 30s；Chrome 120+ 允许的最小周期
const COMMAND_TIMEOUT_MS = 60000;

let client = null;
let currentSettings = null;

// 会触发页面脚本/对话框的动作（用于登记 operation 并竞速 dialog_pending）
// 会产生输入/可能触发原生弹窗的动作。只读命令（observe/read/screenshot/network/emulate…）不在此列，
// 挂起对话框期间仍然可用。
const PAGE_ACTION_METHODS = new Set([
  'navigate', 'reload', 'navigate-back', 'navigate-forward',
  'click', 'hover', 'fill', 'press', 'select', 'focus', 'blur', 'scroll-to',
  'drag', 'wheel', 'evaluate', 'upload', 'download',
  'plan', 'step',
]);

async function handleCommand(message) {
  const commandId = message && message.id != null ? String(message.id) : '';
  registerCommand(commandId);
  const modeTab = message && message.params && Number.isInteger(message.params.tabId) ? message.params.tabId : null;
  const mode = message && message.method ? String(message.method) : '';
  const modeWatched = modeTab != null && (typeof PAGE_ACTION_METHODS !== 'undefined' && (PAGE_ACTION_METHODS.has(mode) || ['observe','observe-frames','snapshot','get-html','read','extract','extract.discover','extract.table','cooperate.sync'].includes(mode)));
  if (modeWatched) handleCommandMode(modeTab, mode, 'begin');
  const tagCommand = modeTab != null && typeof PAGE_ACTION_METHODS !== 'undefined' && PAGE_ACTION_METHODS.has(mode) && !pendingDialog(modeTab);
  if (tagCommand) {
    beginCommand(modeTab, commandId);
    await setPageCommandId(modeTab, commandId);
  }
  try {
    return await handleCommandInner(message);
  } finally {
    unregisterCommand(commandId);
    if (tagCommand) {
      await setPageCommandId(modeTab, '');
      endCommand(modeTab, commandId);
    }
    if (modeWatched) handleCommandMode(modeTab, mode, 'end');
  }
}

async function setPageCommandId(tabId, commandId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (value) => {
        try {
          if (value) document.documentElement.setAttribute('data-bb-command-id', value);
          else document.documentElement.removeAttribute('data-bb-command-id');
        } catch { /* 忽略 */ }
      },
      args: [String(commandId || '')],
    });
  } catch {
    // 受限页面/已关闭标签页时忽略
  }
}

const modeCounts = new Map();
function handleCommandMode(tabId, method, phase) {
  const isSync = ['observe','observe-frames','snapshot','get-html','read','extract','extract.discover','extract.table','cooperate.sync'].includes(method);
  const current = modeCounts.get(tabId) || 0;
  if (phase === 'begin') {
    modeCounts.set(tabId, current + 1);
    if (current === 0) updateTakeoverMode(tabId, isSync ? 'syncing' : 'acting');
  } else {
    const next = Math.max(0, current - 1);
    if (next === 0) modeCounts.delete(tabId); else modeCounts.set(tabId, next);
    if (next === 0) updateTakeoverMode(tabId, 'ready');
  }
}

function updateTakeoverMode(tabId, mode) {
  const state = getTakeoverState(tabId);
  if (!state || !state.sessionId) return;
  if (state.mode === mode) return;
  setTakeoverState(tabId, { mode });
  showTakeover(tabId, { mode }).catch(() => {});
}

async function handleCommandInner(message) {
  const id = message.id != null ? message.id : '';
  const method = message.method;
  const params = message.params && typeof message.params === 'object' ? message.params : {};
  if (id) params.commandId = String(id);
  const tabId = Number.isInteger(params.tabId) ? params.tabId : null;
  if (tabId != null && id) beginCommand(tabId, String(id));
  const timeoutMs =
    Number.isFinite(message.timeoutMs) && message.timeoutMs > 0
      ? message.timeoutMs
      : Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
        ? params.timeoutMs
        : COMMAND_TIMEOUT_MS;

  log('收到命令 ' + method + ' id=' + id + ' tabId=' + (tabId != null ? tabId : '-'));
  if (currentSettings && currentSettings.auditEnabled === true) {
    void recordAudit({ ts: Date.now(), commandId: String(id), method, tabId, sessionId: params.sessionId || null, url: redactUrl(params.url || params.selector || '') || null });
  }

  // 有挂起的原生对话框时，新的"输入类"动作不派发（dispatched=false）；只读命令放行
  if (tabId != null && PAGE_ACTION_METHODS.has(method)) {
    const pending = pendingDialog(tabId);
    if (pending) {
      const sent = client ? client.sendJson({
        type: 'res',
        id,
        ok: false,
        error: {
          code: 'E_DIALOG_PENDING',
          message: '该标签页有未处理的对话框（' + pending.type + '）：' + pending.message,
          data: { dialog: pending, dispatched: false },
        },
      }) : false;
      log('命令被挂起对话框挡住 ' + method + ' id=' + id + (sent ? '' : '（发送失败）'));
      return;
    }
  }

  let operation = null;
  if (tabId != null && PAGE_ACTION_METHODS.has(method)) {
    operation = registerOperation({
      id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
      method,
      tabId,
      startedAt: Date.now(),
      settled: false,
      state: 'running',
      payload: null,
      waiters: [],
      cancelled: false,
    });
  }

  let settled = false;
  let unsubscribe = null;
  const deadline = createDeadline(timeoutMs, method);
  const respond = (payload) => {
    if (settled) return;
    settled = true;
    deadline.cancel();
    const sent = client ? client.sendJson({ type: 'res', id, ...payload }) : false;
    log('命令回包 ' + method + ' id=' + id + ' ok=' + payload.ok + (sent ? '' : '（发送失败）'));
  };

  if (method === 'cancel') {
    respond({ ok: true, result: { ok: true, cancelled: cancelCommand(params.rpc_id) } });
    return;
  }

  // 对话框竞速：先订阅再执行动作，动作被弹窗挡住时立刻回 dialog_pending
  let resolveDialog = null;
  const dialogPromise = new Promise((resolve) => { resolveDialog = resolve; });
  if (operation) {
    unsubscribe = onDialogOpened(tabId, (dialog) => resolveDialog({ dialog }));
  }

  const runPromise = runSerialized(method, params)
    .then((result) => {
      if (operation) settleOperation(operation, { state: 'completed', result });
      return { ok: true, result };
    })
    .catch((error) => {
      const wire = toWireError(error);
      if (operation) settleOperation(operation, { state: 'failed', error: wire });
      return { ok: false, error: wire };
    });

  let winner = null;
  try {
    winner = await Promise.race([runPromise, dialogPromise, deadline.promise]);
  } catch (error) {
    winner = { ok: false, error: toWireError(error) };
  }

  if (deadline.expired) {
    cancelCommand(String(id));
    if (operation) settleOperation(operation, { state: 'failed', error: { code: 'E_TIMEOUT', message: method + ' 超时' } });
    respond({ ok: false, error: { code: 'E_TIMEOUT', message: '扩展执行 ' + method + ' 超过 ' + deadline.limit + 'ms' } });
    return;
  }
  deadline.cancel();

  if (winner && winner.dialog) {
    respond({
      ok: false,
      error: {
        code: 'E_DIALOG_PENDING',
        message: '页面弹出了原生对话框：' + winner.dialog.message,
        data: {
          dialog: winner.dialog,
          operationId: operation.id,
          dispatched: true,
          method,
        },
      },
    });
  } else {
    respond(winner);
  }
  if (unsubscribe) unsubscribe();
}

async function handleDaemonEvent(message) {
  const event = message && message.event;
  const params = (message && message.params) || {};
  if (event === 'takeover.state' && Number.isInteger(params.tabId)) {
    const state = { sessionId: params.sessionId || '', paused: params.paused === true, borrowed: params.borrowed === true };
    setTakeoverState(params.tabId, state);
    await showTakeover(params.tabId, state).catch(() => {});
    return;
  }
  if (event === 'takeover.hide' && Number.isInteger(params.tabId)) {
    clearTakeoverState(params.tabId);
    await hideTakeover(params.tabId).catch(() => {});
  }
}

function getClient() {
  if (!client) client = new BridgeSocket({ onCommand: handleCommand, onEvent: handleDaemonEvent });
  return client;
}

/** 弹窗/设置页发来的消息（MV3 里必须同步返回 true 才能异步 sendResponse）。 */
async function activeTabId() {
  try {
    const tabs = await chrome.tabs.query({ active: true });
    const httpTab = tabs.find((item) => item.id && /^https?:/i.test(item.url || ''));
    if (httpTab) return httpTab.id;
    return tabs.length ? tabs[0].id : null;
  } catch {
    return null;
  }
}

const MESSAGE_HANDLERS = {
  'bb.takeover.stop': (message, sender) => {
    const tabId = sender && sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : null;
    if (tabId == null) return { ok: false, error: '没有标签页上下文' };
    getClient().sendJson({ type: 'event', event: 'takeover.stop', params: { tabId } });
    return { ok: true };
  },
  'bb.takeover.pause': (message, sender) => {
    const tabId = sender && sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : null;
    if (tabId == null) return { ok: false, error: '没有标签页上下文' };
    getClient().sendJson({ type: 'event', event: 'takeover.pause', params: { tabId, paused: message.paused === true } });
    setTakeoverState(tabId, { paused: message.paused === true });
    return { ok: true, paused: message.paused === true };
  },
  'bb.state': () => popupState(getClient()),
  'bb.audit.list': (message) => listAudit(message || {}),
  'bb.audit.clear': () => clearAudit(),
  'bb.capture': (message) => capture(
    message.mode === 'auto' ? 'auto' : 'visible',
    { preview: message.preview === true, tabId: message.tabId },
  ),
  'bb.manual.stitch': async () => {
    const result = await manualSave();
    if (!result || result.ok === false) return result || { ok: false, error: '拼接失败' };
    return { ok: true, dataUrl: result.dataUrl, frames: result.frames, width: result.width, height: result.height };
  },
  'bb.file.save': async (message) => {
    if (!message || typeof message.dataUrl !== 'string') return { ok: false, error: '缺少 dataUrl' };
    return saveDataUrlImage(message.dataUrl, message.prefix || 'shot');
  },
  'bb.manual.start': (message) => manualStart({ tabId: message.tabId }),
  'bb.manual.finish': async () => {
    const tabId = await activeTabId();
    const result = await manualSave();
    if (!result || result.ok === false) return result || { ok: false, error: '拼接失败' };
    try { await chrome.storage.session.set({ 'bb.longshot.last': { dataUrl: result.dataUrl, width: result.width, height: result.height, ts: Date.now() } }); } catch { /* 忽略 */ }
    if (tabId != null) await hideManualOverlay(tabId).catch(() => {});
    try { await chrome.tabs.create({ url: chrome.runtime.getURL('ui/longshot.html') }); } catch { /* 忽略 */ }
    return { ok: true, frames: result.frames, width: result.width, height: result.height };
  },
  'bb.manual.cancel': async () => {
    const tabId = await activeTabId();
    if (tabId != null) await hideManualOverlay(tabId).catch(() => {});
    return { ok: true };
  },
  'bb.manual.frame': (message) => manualFrame({ tabId: message.tabId }),
  'bb.manual.save': async () => {
    const result = await manualSave();
    if (!result || result.ok === false) return result || { ok: false, error: '拼接失败' };
    const filename = await saveDataUrl(result.dataUrl, 'stitch');
    return { ok: true, filename, frames: result.frames, width: result.width, height: result.height };
  },
  'bb.video.start': async (message) => {
    const tabId = await activeTabId();
    if (!tabId) return { ok: false, error: '没有可录制的标签页' };
    return startVideo({ tabId, durationMs: message && message.durationMs });
  },
  'bb.video.stop': (message) => stopVideo(message && message.recordingId),
  'bb.video.list': () => listVideos(),
  'bb.video.state': () => videoState(),
  'bb.debug.start': async (message) => {
    const tabId = await activeTabId();
    if (!tabId) return { ok: false, error: '没有可采集的标签页' };
    return debugStart({ tabId, bodies: message && message.bodies === true });
  },
  'bb.debug.stop': async () => {
    const tabId = await activeTabId();
    if (!tabId) return { ok: false, error: '没有可停止的标签页' };
    return debugStop({ tabId });
  },
  'bb.debug.current': () => debugCurrent({}),
  'bb.record.start': async () => {
    const tabId = await activeTabId();
    if (!tabId) return { ok: false, error: '没有可录制的标签页' };
    return startRecording({ tabId });
  },
  'bb.record.stop': async () => {
    const tabId = await activeTabId();
    if (!tabId) return { ok: false, error: '没有可停止的标签页' };
    return stopRecording({ tabId });
  },
  'bb.record.list': () => listRecordings(),
  'bb.longshot.capture': async () => {
    const result = await capture('auto', { preview: false });
    try { await chrome.storage.session.set({ 'bb.longshot.last': { dataUrl: result.dataUrl, width: result.width, height: result.height, ts: Date.now() } }); } catch { /* 忽略 */ }
    return result;
  },
  'bb.reconnect': () => {
    const socket = getClient();
    socket.stop();
    socket.start();
    return { ok: true };
  },
  'bb.connection': async (message) => {
    const enabled = message.enabled !== false;
    currentSettings = await writeSettings({ connectionEnabled: enabled });
    const socket = getClient();
    if (enabled) socket.start();
    else socket.stop();
    return { ok: true, connected: enabled };
  },
  'bb.settings.set': async (message) => {
    const patch = message.patch && typeof message.patch === 'object' ? message.patch : {};
    currentSettings = await writeSettings(patch);
    const socket = getClient();
    socket.sendJson({
      type: 'event',
      event: 'settings',
      params: {
        label: currentSettings.instanceLabel,
        borrowConfirm: currentSettings.borrowConfirm,
        allowHelp: currentSettings.allowHelp,
        pageGuard: currentSettings.pageGuard,
        controlHint: currentSettings.controlHint,
        auditEnabled: currentSettings.auditEnabled,
        connectionEnabled: currentSettings.connectionEnabled,
        longShotMode: currentSettings.longShotMode,
      },
    });
    return { ok: true, settings: currentSettings };
  },
  'bb.ops.start': (message) => startRecording({ tabId: message.tabId }),
  'bb.longshot.last': async () => {
    const stored = await chrome.storage.session.get('bb.longshot.last');
    return { ok: true, last: (stored && stored['bb.longshot.last']) || null };
  },
  'bb.ops.stop': (message) => stopRecording({ tabId: message.tabId }),
  'bb.ops.list': () => listRecordings(),
  'bb.ops.delete': (message) => deleteRecording({ id: message.id }),
  'bb.ops.active': () => activeRecordings(),
  'bb.debug.start': (message) => debugStart({ tabId: message.tabId, bodies: message.bodies === true, name: message.name }),
  'bb.debug.stop': (message) => debugStop({ tabId: message.tabId }),
  'bb.debug.current': (message) => debugCurrent({ tabId: message.tabId }),
  'bb.debug.request': (message) => debugRequest({ tabId: message.tabId, id: message.id }),
  'bb.debug.performance': (message) => debugPerformance({ tabId: message.tabId }),
  'bb.debug.history': () => debugHistory(),
  'bb.debug.history.detail': (message) => debugHistoryDetail({ id: message.id }),
  'bb.debug.delete': (message) => debugDelete({ id: message.id }),
  'bb.debug.rule_list': (message) => ruleList({ tabId: message.tabId }),
  'bb.debug.rule_add': (message) => ruleAdd({ tabId: message.tabId, rule: message.rule }),
  'bb.debug.rule_clear': (message) => ruleClear({ tabId: message.tabId }),
  'bb.debug.rule_export': (message) => ruleExport({ tabId: message.tabId }),
  'bb.debug.rule_import': (message) => ruleImport({ tabId: message.tabId, rules: message.rules }),
  'bb.debug.replay': async (message) => {
    const result = await networkReplay({ tabId: message.tabId, id: message.id, overrides: message.overrides });
    return { ok: true, ...result };
  },
  'bb.rec.start': (message) => startVideo({
    tabId: message.tabId,
    durationMs: message.durationMs,
    quality: message.quality,
  }),
  'bb.rec.stop': (message) => stopVideo(message.recordingId),
  'bb.video.fetch': (message) => fetchVideo({ recording: message.recording }),
  'bb.video.list': () => listVideos(),
  'bb.video.discard': (message) => discardVideo({ recording: message.recording }),
  'bb.rec.state': () => videoState(),
  'bb.operation.await': (message) => awaitOperation(message.id, message.timeoutMs),
  'bb.operation.cancel': (message) => cancelOperation(message.id),
  'bb.dialog.status': (message) => dialogStatus({ tabId: message.tabId }),
  'bb.dialog.accept': (message) => dialogAccept({ tabId: message.tabId, id: message.id, text: message.text }),
  'bb.dialog.dismiss': (message) => dialogDismiss({ tabId: message.tabId, id: message.id }),
  'bb.daemon.call': async (message) => {
    const socket = getClient();
    if (!socket.isOpen()) return { ok: false, error: 'daemon 未连接' };
    try {
      const result = await socket.call(message.method, message.params, message.timeoutMs);
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  },
  'bb.notifications': async (message) => {
    const stored = await chrome.storage.local.get('bb.notifications').catch(() => ({}));
    if (message && message.clear === true) {
      await chrome.storage.local.set({ 'bb.notifications': [] });
      return { ok: true, notifications: [] };
    }
    const list = Array.isArray(stored && stored['bb.notifications']) ? stored['bb.notifications'] : [];
    return { ok: true, notifications: list };
  },
};

/** 追加一条扩展内通知（弹窗铃铛里看）。 */
export async function pushNotification(level, text) {
  try {
    const stored = await chrome.storage.local.get('bb.notifications');
    const list = Array.isArray(stored && stored['bb.notifications']) ? stored['bb.notifications'] : [];
    list.unshift({ id: crypto.randomUUID(), at: Date.now(), level: level || 'info', text: String(text || '') });
    await chrome.storage.local.set({ 'bb.notifications': list.slice(0, 50) });
  } catch {
    // 通知只是锦上添花，失败忽略
  }
}

function installMessageBridge() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const type = message && message.type;
    if (message && message.target === 'offscreen') return false;
    if (type === 'bb.rec.done') {
      handleRecDone(message);
      const mb = message.bytes ? (message.bytes / (1024 * 1024)).toFixed(1) + ' MB' : '视频';
      pushNotification('info', '录制已保存：' + mb);
      sendResponse({ ok: true });
      return false;
    }
    if (type === 'bb.rec.error') {
      pushNotification('error', '录制失败：' + (message.error || '未知错误'));
      sendResponse({ ok: true });
      return false;
    }
    if (type === 'bb.ops.event') {
      const tabId = sender && sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : null;
      if (tabId != null) {
        collectEvent(tabId, Object.assign({}, message, {
          frameId: sender && Number.isInteger(sender.frameId) ? sender.frameId : 0,
        }));
      }
      sendResponse({ ok: true });
      return false;
    }
    if (type === 'bb.borrow.decision') {
      const handled = resolveHumanDecision(message);
      pushNotification(message.allow ? 'info' : 'warn', message.allow ? '已允许接管标签页' : '已拒绝接管标签页');
      sendResponse({ ok: handled });
      return false;
    }
    if (type === 'bb.record.finish') {
      const tabId = sender && sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : null;
      if (tabId != null) {
        hideRecordOverlay(tabId).catch(() => {});
        stopRecording({ tabId }).catch(() => {});
        pushNotification('info', '操作录制已结束');
      }
      sendResponse({ ok: true });
      return false;
    }
    if (type === 'bb.help.resolved') {
      const handled = resolveHumanDecision(message);
      pushNotification('info', message.action === 'done' ? '人工协助已完成' : '人工协助被跳过');
      sendResponse({ ok: handled });
      return false;
    }
    const handler = type ? MESSAGE_HANDLERS[type] : null;
    if (!handler) return false;
    Promise.resolve()
      .then(() => handler(message, sender))
      .then((result) => sendResponse(result && typeof result === 'object' ? result : { ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String((error && error.message) || error) }));
    return true;
  });
}

/** 页面守卫：外部/手动新建的标签页落进 agent 窗口时，移回用户窗口。 */
function installPageGuard() {
  chrome.tabs.onCreated.addListener((tab) => {
    Promise.resolve()
      .then(async () => {
        if (!tab || !Number.isInteger(tab.id)) return;
        if (consumeSelfCreated(tab.id)) return;
        const settings = await readSettings();
        if (!settings.pageGuard) return;
        const agentWindowId = await getAgentWindowId();
        if (agentWindowId == null || tab.windowId !== agentWindowId) return;
        const openerId = tab.openerTabId;
        if (Number.isInteger(openerId)) {
          try {
            const opener = await chrome.tabs.get(openerId);
            if (opener && opener.windowId === agentWindowId) return;
          } catch {
            // opener 已关闭：按外部标签页处理
          }
        }
        const windows = await chrome.windows.getAll({ populate: false });
        const userWindows = windows.filter((item) => item.id !== agentWindowId && item.type === 'normal');
        const target =
          userWindows.find((item) => item.focused) ||
          userWindows.find((item) => item.state !== 'minimized') ||
          userWindows[0];
        if (target) {
          await chrome.tabs.move(tab.id, { windowId: target.id, index: -1 });
          log('页面守卫：tab ' + tab.id + ' 移回用户窗口 ' + target.id);
        } else {
          const created = await chrome.windows.create({ tabId: tab.id, focused: false });
          log('页面守卫：没有用户窗口，为 tab ' + tab.id + ' 新建窗口 ' + (created && created.id));
        }
      })
      .catch((error) => warn('页面守卫处理失败', error && error.message));
  });
}

/** 设置变化时把实例名与自动化开关同步给 daemon。 */
let connectionReconnectTimer = null;

function installSettingsSync() {
  subscribeSettings((settings) => {
    const previous = currentSettings || {};
    const connectionChanged = previous.daemonUrl !== settings.daemonUrl || previous.daemonToken !== settings.daemonToken;
    currentSettings = settings;
    const socket = getClient();
    socket.sendJson({
      type: 'event',
      event: 'settings',
      params: {
        label: settings.instanceLabel,
        borrowConfirm: settings.borrowConfirm,
        allowHelp: settings.allowHelp,
        pageGuard: settings.pageGuard,
        longShotMode: settings.longShotMode,
        connectionEnabled: settings.connectionEnabled,
        controlHint: settings.controlHint,
        daemonUrl: settings.daemonUrl,
      },
    });
    if (connectionChanged) {
      log('连接设置变化，稍后重新连接 daemon');
      // 去抖：连续改设置只重连一次，且等当前 RPC 回包发出后再重连
      if (connectionReconnectTimer) clearTimeout(connectionReconnectTimer);
      connectionReconnectTimer = setTimeout(() => {
        connectionReconnectTimer = null;
        try {
          socket.reconnect();
        } catch (error) {
          warn('重连失败', error && error.message);
        }
      }, 800);
    }
  });
}

/**
 * 所有 chrome.* 事件监听必须在 service worker 顶层同步注册（MV3 唤醒时事件只等首轮脚本执行），
 * 因此这里刻意不 await 任何异步操作，storage 读取放到后面。
 */
function registerListeners() {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== RECONNECT_ALARM) return;
    if (currentSettings && currentSettings.connectionEnabled === false) return;
    const socket = getClient();
    if (socket.isOpen()) return;
    log('alarm 兜底触发：WebSocket 不在线，立即重连');
    socket.ensureConnected();
  });

  chrome.runtime.onInstalled.addListener((details) => {
    log('扩展已安装/更新 reason=' + details.reason + ' version=' + chrome.runtime.getManifest().version);
    if (currentSettings && currentSettings.connectionEnabled === false) return;
    getClient().ensureConnected();
  });

  chrome.runtime.onStartup.addListener(() => {
    log('浏览器启动，扩展唤醒');
    if (currentSettings && currentSettings.connectionEnabled === false) return;
    getClient().ensureConnected();
  });

  // 录制中页面导航后补挂记录器
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === 'loading' || info.url) noteNavigation(tabId);
    if (info.status === 'complete') {
      reattach(tabId).catch(() => {});
      reinjectRules(tabId);
      refreshTakeoverForTab(tabId).catch(() => {});
    }
  });

  // 录制中切换标签页：记 tab-switch 步骤（原标签页的记录器继续保留）
  chrome.tabs.onActivated.addListener((info) => {
    if (info && Number.isInteger(info.tabId)) recordTabSwitch(info.tabId).catch(() => {});
  });

  // tab 关闭事件上报 daemon（PROTOCOL.md §3.4）
  chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    log('tab 关闭 tabId=' + tabId + ' windowId=' + (removeInfo && removeInfo.windowId));
    clearInputLeases(tabId);
    getClient().sendJson({ type: 'event', event: 'tab-removed', params: { tabId } });
  });

  installMessageBridge();
  installPageGuard();
  installFrameGraphInvalidation();
  installSettingsSync();
}

function bootstrap() {
  const manifest = chrome.runtime.getManifest();
  log('BridgeDeck扩展启动 version=' + manifest.version);
  const socket = getClient();
  registerListeners();
  chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: ALARM_PERIOD_MINUTES }).catch((error) => {
    warn('创建重连 alarm 失败', error && error.message);
  });

  // 首轮同步执行结束；之后异步恢复上次的 instanceId（作为 hello 提示），再建立连接
  readSettings()
    .then((settings) => {
      currentSettings = settings;
      if (settings.connectionEnabled !== false) {
        chrome.storage.session
          .get('instanceId')
          .then((stored) => {
            if (stored && stored.instanceId) socket.instanceId = stored.instanceId;
          })
          .catch((error) => {
            warn('读取 instanceId 失败', error && error.message);
          })
          .finally(() => socket.start());
      } else {
        log('连接开关已关闭：不自动连接 daemon');
      }
    })
    .catch((error) => {
      warn('读取设置失败，按默认连接', error && error.message);
      socket.start();
    });
}

bootstrap();
