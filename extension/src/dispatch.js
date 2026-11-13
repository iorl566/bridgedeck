// src/dispatch.js —— 命令分发：方法表 + 同一 tabId 串行
import { bridgeError, toWireError } from './errors.js';
import { cancelWait, observe, observeSmart, observeFrames, resolveFrameAlias, shadowClick, shadowRead, snapshot, getHtml, click, hover, fill, actionable, press, select, focus, scrollTo, evaluate, consoleEntries, navigate, reload, goBack, goForward, waitMs, waitForElement, waitForNavigationCmd, read, extract, extractDiscover, extractList, extractTable, drag, wheel, blur, upload } from './actions.js';
import { ensureAgent, newAgentWindow, windowClose, sleep, tabList, tabNew, tabClose, tabSelect, tabMove, windowList, windowFocus, windowResize, tabBorrow, tabReturn, requestHelp, controlHint } from './tabs.js';
import { settingsGet, settingsSet } from './settings.js';
import { clickByImage, takeScreenshot } from './screenshot.js';
import { ruleAdd, ruleClear, ruleExport, ruleImport, ruleList, ruleRemove, ruleSetEnabled } from './rules.js';
import { fetchProbe } from './fetch-probe.js';
import { download } from './files.js';
import { manualFrame, manualSave, manualStart } from './quick.js';
import { dialogAccept, dialogArm, dialogDisarm, dialogDismiss, dialogHandle, dialogList, dialogStatus, forgetDialogTab } from './dialogs.js';
import { awaitOperation, cancelOperation } from './operations.js';
import { checkControl, cooperateHandback, cooperateSync, cooperateWait, TAB_METHODS } from './control.js';
import { activeRecordings, listRecordings, startRecording, stopRecording } from './ops.js';
import { debugCapabilities, debugCurrent, debugDelete, debugHistory, debugHistoryDetail, debugPerformance, debugPin, debugPinned, debugRequest, debugStart, debugStop } from './debug.js';
import { discardVideo, fetchVideo, listVideos, recoverVideo, startVideo, stopVideo, videoPrune, videoState, videoStatus } from './video.js';
import { emulate, forgetEmulateTab } from './emulate.js';
import { networkDetail, networkList, networkReplay, networkStart, networkStop, forgetNetworkTab } from './network.js';
import { detach } from './debugger.js';
import { uiDiagnostics, uiOpen } from './diagnostics.js';
import { execPage } from './inject.js';
import { log } from './log.js';

export const HANDLERS = {
  'observe-frames': observeFrames,
  'shadow.click': shadowClick,
  'shadow.read': shadowRead,
  'window.ensureAgent': ensureAgent,
  'window.newAgent': newAgentWindow,
  'window.close': windowClose,
  'tab.borrow': tabBorrow,
  'tab.return': tabReturn,
  'tab.list': tabList,
  'tab.new': tabNew,
  'tab.close': tabClose,
  'tab.select': tabSelect,
  'tab.move': tabMove,
  'window.list': windowList,
  'window.focus': windowFocus,
  'window.resize': windowResize,
  navigate,
  reload,
  'navigate-back': goBack,
  'navigate-forward': goForward,
  'wait-ms': waitMs,
  'wait-for-navigation': waitForNavigationCmd,
  'wait-for-element': waitForElement,
  actionable,
  observe: (params = {}) => (params && (params.closedShadow || params.cursor || params.maxTokens || params.vom || params.ax || params.delta)) ? observe(params) : observeSmart(params),
  snapshot,
  'get-html': getHtml,
  screenshot: takeScreenshot,
  'click-point': clickByImage,
  'screenshot.manual.start': manualStart,
  'screenshot.manual.frame': manualFrame,
  'screenshot.manual.save': manualSave,
  click,
  hover,
  fill,
  press,
  select,
  focus,
  'scroll-to': scrollTo,
  read,
  extract,
  'extract.discover': extractDiscover,
  'extract.table': extractTable,
  'extract.list': extractList,
  drag,
  wheel,
  blur,
  upload,
  download,
  evaluate,
  console: consoleEntries,
  plan,
  step,
  'dialog.arm': dialogArm,
  'dialog.status': dialogStatus,
  'dialog.accept': dialogAccept,
  'dialog.dismiss': dialogDismiss,
  'video.start': startVideo,
  'video.stop': (params) => stopVideo(params.recording),
  'video.status': (params) => videoStatus(params),
  'video.recover': () => recoverVideo(),
  'video.list': () => listVideos(),
  'video.fetch': fetchVideo,
  'video.discard': discardVideo,
  'video.prune': videoPrune,
  'record.start': (params) => startRecording({ tabId: params.tabId, screenshots: params.screenshots === true }),
  'record.stop': (params) => stopRecording({ tabId: params.tabId }),
  'record.status': () => activeRecordings(),
  'record.list': () => listRecordings(),
  'cooperate.sync': cooperateSync,
  'cooperate.handback': cooperateHandback,
  'cooperate.wait': cooperateWait,
  'operation.await': (params) => awaitOperation(params.id, params.timeoutMs),
  'operation.cancel': (params) => {
    const wait = cancelWait(params.id);
    if (wait.ok) return wait;
    return cancelOperation(params.id);
  },
  'dialog.disarm': dialogDisarm,
  'dialog.list': dialogList,
  'dialog.handle': dialogHandle,
  emulate,
  'network.start': networkStart,
  'network.stop': networkStop,
  'network.list': networkList,
  'network.detail': networkDetail,
  'network.replay': networkReplay,
  'debugger.detach': debuggerDetach,
  'debug.start': debugStart,
  'debug.stop': debugStop,
  'debug.current': debugCurrent,
  'debug.request': debugRequest,
  'debug.performance': debugPerformance,
  'debug.fetch_probe': fetchProbe,
  'debug.capabilities': debugCapabilities,
  'debug.pin': debugPin,
  'debug.pinned': debugPinned,
  'debug.rule_add': ruleAdd,
  'debug.rule_list': ruleList,
  'debug.rule_enable': (params) => ruleSetEnabled({ ...params, enabled: true }),
  'debug.rule_disable': (params) => ruleSetEnabled({ ...params, enabled: false }),
  'debug.rule_remove': ruleRemove,
  'debug.rule_clear': ruleClear,
  'debug.rule_export': ruleExport,
  'debug.rule_import': ruleImport,
  'debug.history': debugHistory,
  'debug.delete': debugDelete,
  'control-hint': controlHint,
  'diagnostics.ui': uiDiagnostics,
  'ui.open': uiOpen,
  'settings.get': settingsGet,
  'settings.set': settingsSet,
  'request-help': requestHelp,
};

/** 会话结束/标签页关闭时释放 debugger 与采集状态。 */
async function debuggerDetach(params = {}) {
  const tabId = Number(params.tabId);
  if (!Number.isInteger(tabId)) throw bridgeError('E_BAD_ARG', 'debugger.detach 需要 tabId');
  forgetDialogTab(tabId);
  forgetEmulateTab(tabId);
  await forgetNetworkTab(tabId).catch(() => {});
  await detach(tabId).catch(() => {});
  return { ok: true };
}

// plan / step 会再调用 runSerialized，本身不能被 tab 串行链包住（否则同 tab 自锁到超时）。
// 另外：动作被原生弹窗挂起时，对话框决策与只读命令必须能立即执行，不能排在阻塞动作后面。
const UNSERIALIZED_METHODS = new Set([
  'plan', 'step',
  'dialog.status', 'dialog.accept', 'dialog.dismiss', 'dialog.list', 'dialog.arm', 'dialog.disarm',
  'operation.await', 'operation.cancel', 'request-help', 'evaluate',
  'observe', 'observe-frames', 'snapshot', 'get-html', 'read', 'extract', 'extract.discover', 'extract.table', 'extract.list',
  'console', 'screenshot', 'screenshot.manual.start', 'screenshot.manual.frame', 'screenshot.manual.save',
  'network.start', 'network.stop', 'network.list', 'network.detail', 'network.replay',
  'emulate', 'settings.get', 'settings.set', 'diagnostics.ui', 'debugger.detach', 'control-hint',
  'cooperate.sync', 'cooperate.wait', 'cooperate.handback', 'debug.fetch_probe',
  'tab.borrow', 'tab.return', 'tab.close', 'tab.new', 'tab.list', 'tab.select',
  'window.resize', 'window.ensureAgent', 'window.newAgent', 'window.close',
]);

/** 每个 tab 最近一次 observe 的行集合，供 step 计算「变化了几行」。 */
const observationCache = new Map();

async function plan(params = {}) {
  const steps = Array.isArray(params.steps) ? params.steps : null;
  if (!steps) throw bridgeError('E_BAD_ARG', 'plan 需要 steps 数组');
  if (!steps.length) throw bridgeError('E_BAD_ARG', 'plan 的 steps 不能为空');
  if (steps.length > 50) throw bridgeError('E_BAD_ARG', 'plan 单次最多 50 步');
  const results = [];
  let failedAt = null;
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index] && typeof steps[index] === 'object' ? steps[index] : {};
    const method = step.method;
    const stepParams = step.params && typeof step.params === 'object' ? { ...step.params } : {};
    if (stepParams.tabId == null && params.tabId != null) stepParams.tabId = params.tabId;
    for (const key of ['context', 'observation', 'expect']) {
      if (stepParams[key] == null && params[key] != null) stepParams[key] = params[key];
    }
    try {
      if (typeof method !== 'string' || !method) throw bridgeError('E_BAD_ARG', '步骤缺少 method');
      const result = await runSerialized(method, stepParams);
      results.push({ index, method, ok: true, result });
    } catch (error) {
      results.push({ index, method, ok: false, error: toWireError(error) });
      if (params.continueOnError !== true) {
        failedAt = index;
        break;
      }
    }
  }
  return {
    steps: results,
    completed: results.filter((item) => item.ok).length,
    failedAt,
  };
}

async function step(params = {}) {
  const action = params.action && typeof params.action === 'object' ? params.action : null;
  if (!action || typeof action.method !== 'string' || !action.method) {
    throw bridgeError('E_BAD_ARG', 'step 需要 action.method');
  }
  const actionParams = action.params && typeof action.params === 'object' ? { ...action.params } : {};
  if (actionParams.tabId == null && params.tabId != null) actionParams.tabId = params.tabId;
  for (const key of ['context', 'observation', 'expect']) {
    if (actionParams[key] == null && params[key] != null) actionParams[key] = params[key];
  }
  const tabId = Number.isInteger(actionParams.tabId) ? actionParams.tabId : null;
  const result = await runSerialized(action.method, actionParams);
  if (tabId == null) return { action: result, observation: null };
  const observation = await execPage(tabId, 'observe', { probeHover: false });
  const lines = String(observation.observation || '').split('\n');
  const current = new Set(lines);
  const previous = observationCache.get(tabId);
  let changed = current.size;
  if (previous) {
    changed = 0;
    for (const line of current) {
      if (!previous.has(line)) changed += 1;
    }
  }
  observationCache.set(tabId, current);
  return {
    action: result,
    observation: {
      text: observation.observation,
      refs: observation.refs,
      changed,
      url: observation.url,
    },
  };
}

// key: tabId -> 该 tab 上最后一个命令的 Promise
const tabChains = new Map();

async function dispatchCommand(method, params) {
  if (typeof method !== 'string' || !method) {
    throw bridgeError('E_BAD_ARG', '命令缺少 method');
  }
  const handler = Object.prototype.hasOwnProperty.call(HANDLERS, method) ? HANDLERS[method] : null;
  if (!handler) {
    throw bridgeError('E_UNKNOWN_METHOD', `未知方法: ${method}`);
  }
  const input = params || {};
  if (typeof input.ref === 'string') {
    const aliased = /^@e\d+$/.test(input.ref) ? resolveFrameAlias(input.tabId, input.ref) : null;
    if (aliased) {
      input.frameId = aliased.frameId;
      input.ref = aliased.localRef;
    }
    const framed = /^@f(\d+)e(\d+)$/.exec(input.ref);
    if (framed) {
      input.frameId = Number(framed[1]);
      input.ref = '@e' + framed[2];
    }
  }
  if (TAB_METHODS.has(method)) {
    checkControl({ ...input, method });
    const isDepends = !Array.isArray(input.expect) && Array.isArray(input.dependsOn);
    const conditions = Array.isArray(input.expect) ? input.expect : isDepends ? input.dependsOn : [];
    if (conditions.length) {
      const checked = await execPage(input.tabId, 'expect-check', { conditions });
      if (!checked || checked.ok !== true) {
        const mismatch = (checked && checked.mismatch) || {};
        throw bridgeError(
          isDepends ? 'E_DEPENDS_FAILED' : 'E_EXPECT_FAILED',
          (isDepends ? '依赖校验失败：' : '动作前校验失败：') + (mismatch.target || '?') + ' ' + (mismatch.field || '') +
            ' 期望 ' + JSON.stringify(mismatch.expected) + '，实际 ' + JSON.stringify(mismatch.actual),
          { mismatch, conditions, kind: isDepends ? 'depends-on' : 'expect' },
        );
      }
    }
  }
  const result = await handler(input);
  const settleMs = Number(input.settleMs);
  if (Number.isFinite(settleMs) && settleMs > 0) {
    const wait = Math.min(Math.max(Math.round(settleMs), 0), 5000);
    await sleep(wait);
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      return { ...result, settledMs: wait };
    }
  }
  return result;
}

/**
 * 执行命令：带 tabId 的命令按 tabId 串行（PROTOCOL.md §3.3），无 tabId 的直接执行。
 * 返回 handle 后的最终结果 Promise。
 */
// Agent 自己通过 CDP 派发的可信鼠标/键盘事件也会触发页面 isTrusted=true，
// 记下这些命令的执行窗口，后台据此忽略“自产”的 human.input，避免误自动暂停会话。
const agentInputWindows = new Map(); // tabId -> { start, end }
const AGENT_INPUT_METHODS = new Set([
  'click', 'hover', 'fill', 'press', 'select', 'drag', 'wheel', 'upload', 'download', 'click-point',
]);

export function isAgentInputWindow(tabId, at) {
  const window = agentInputWindows.get(Number(tabId));
  if (!window) return false;
  const timestamp = Number(at) || Date.now();
  const end = window.end === Infinity ? Date.now() : window.end;
  return timestamp >= window.start - 50 && timestamp <= end + 500;
}

export function runSerialized(method, params) {
  const input = params && typeof params === 'object' ? params : {};
  const tabId = Number.isInteger(input.tabId) ? input.tabId : null;
  const track = () => {
    if (tabId != null && AGENT_INPUT_METHODS.has(method)) agentInputWindows.set(tabId, { start: Date.now(), end: Infinity });
  };
  const untrack = () => {
    const window = tabId != null ? agentInputWindows.get(tabId) : null;
    if (window) window.end = Date.now();
  };
  if (tabId == null || UNSERIALIZED_METHODS.has(method)) {
    track();
    return dispatchCommand(method, input).finally(untrack);
  }

  const previous = tabChains.get(tabId) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => {
    track();
    return dispatchCommand(method, input).finally(untrack);
  });
  tabChains.set(tabId, current);
  current
    .catch(() => {})
    .finally(() => {
      if (tabChains.get(tabId) === current) tabChains.delete(tabId);
    });
  log(`命令排队 ${method} tab=${tabId}`);
  return current;
}
