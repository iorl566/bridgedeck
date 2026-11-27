// src/dispatch.js —— 命令分发：方法表 + 同一 tabId 串行
import { bridgeError, toWireError } from './errors.js';
import { beginCooperationPassthrough, endCooperationPassthrough } from './cooperation.js';
import { showTargetMarker } from './target-marker-client.js';
import { checkTabPolicy } from './tab-policy.js';
import { getTakeoverState } from './takeover.js';
import { normalizeCompatParams } from './lib/compat-params.js';
import { cancelWait, observe, observeSmart, observeFrames, resolveFrameAlias, shadowClick, shadowRead, snapshot, getHtml, click, clickBackend, hover, fill, actionable, press, select, focus, scrollTo, evaluate, consoleEntries, navigate, reload, goBack, goForward, waitMs, waitForElement, waitForNavigationCmd, read, extract, extractDiscover, extractList, extractTable, drag, wheel, blur, upload, visualScan } from './actions.js';
import { normalizeParams } from './generated/protocol.js';
import { ensureAgent, newAgentWindow, windowClose, sleep, tabList, tabNew, tabClose, tabSelect, tabMove, tabPolicy, tabAlias, tabCleanup, windowList, windowFocus, windowResize } from './tabs.js';
import { tabBorrow, tabReturn } from './tabs-borrow.js';
import { controlHint, requestHelp } from './tabs-help.js';
import { settingsGet, settingsSet } from './settings.js';
import { clickByImage, screenshotRead, screenshotRelease, takeScreenshot } from './screenshot.js';
import { ruleAdd, ruleClear, ruleExport, ruleImport, ruleList, ruleRemove, ruleSetEnabled } from './rules.js';
import { fetchProbe } from './fetch-probe.js';
import { download } from './files.js';
import { manualFrame, manualSave, manualStart } from './quick.js';
import { dialogAccept, dialogArm, dialogDisarm, dialogDismiss, dialogHandle, dialogList, dialogStatus, forgetDialogTab } from './dialogs.js';
import { awaitOperation, cancelOperation } from './operations.js';
import { checkControl, checkControlRevision, cooperateHandback, cooperateHold, cooperateSync, cooperateWait, TAB_METHODS } from './control.js';
import { controlGeneration } from './control-generation.js';
import { needsReceipt } from './lib/receipt-methods.js';
import { refRegistry } from './tools/state.js';
import { verifyVideo } from './video.js';
import { webmcpCall, webmcpList } from './tools/webmcp.js';
import { attachReceipt, buildActionReceipt } from './lib/action-receipt.js';
import { isFullRefKey } from './refs/ref-registry.js';
import { resolveBackendId } from './refs/resolve-backend.js';
import { execPage } from './inject.js';
import { activeRecordings, listRecordings, startRecording, stopRecording } from './ops.js';
import { debugCapabilities, debugCoverage, debugCurrent, debugDelete, debugHistory, debugHistoryDetail, debugPerformance, debugPin, debugPinned, debugRequest, debugStart, debugStop } from './debug.js';
import { discardVideo, fetchVideo, listVideos, recoverVideo, startVideo, stopVideo, videoPrune, videoState, videoStatus } from './video.js';
import { emulate, forgetEmulateTab } from './emulate.js';
import { networkDetail, networkList, networkWaterfall, networkStart, networkStop, forgetNetworkTab } from './network.js';
import { replayNetworkCommand } from './replay.js';
import { traceStart, traceStop, traceStatus } from './tracing.js';
import { printPdf } from './pdf.js';
import { negotiateRefs } from './tools/refs-negotiate.js';
import { recoverLongshot } from './longshot-recover.js';
import { detach, simulateExternalDetach } from './debugger.js';
import { uiDiagnostics, uiOpen } from './diagnostics.js';
import { log } from './log.js';
import { borrowGate } from './lib/borrow-confirm.js';
import { suppressionScope, SUPPRESSION_KINDS } from './lib/suppression-scope.js';
import { controllerState } from './lib/controller-state.js';
import { armCooperationExpectation } from './cooperation.js';

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
  'tab.policy': tabPolicy,
  'tab.alias': tabAlias,
  'tab.cleanup': tabCleanup,
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
  observe: (params = {}) => (params && params.visualOnly === true)
    ? visualScan(params)
    : (params && (params.closedShadow || params.cursor || params.maxTokens || params.vom || params.vomDeep || params.ax || params.facts || params.fallbackAx || params.compareAx || params.pipeline || params.delta)) ? observe(params) : observeSmart(params),
  snapshot,
  'get-html': getHtml,
  screenshot: takeScreenshot,
  'screenshot.read': screenshotRead,
  'screenshot.release': screenshotRelease,
  'click-point': clickByImage,
  'screenshot.manual.start': manualStart,
  'screenshot.manual.frame': manualFrame,
  'screenshot.manual.save': manualSave,
  click,
  'click-backend': clickBackend,
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
  'webmcp.list': webmcpList,
  'webmcp.call': webmcpCall,
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
  'video.verify': verifyVideo,
  'video.list': () => listVideos(),
  'video.fetch': fetchVideo,
  'video.discard': discardVideo,
  'video.prune': videoPrune,
  'record.start': (params) => startRecording({ tabId: params.tabId, screenshots: params.screenshots === true, includeAgent: params.includeAgent === true, purpose: params.purpose, redactValues: params.redactValues === true, maxPageTokens: params.maxPageTokens, traceVersion: params.traceVersion, supportsTabSwitchSteps: params.supportsTabSwitchSteps === true }),
  'record.stop': (params) => stopRecording({ tabId: params.tabId }),
  'record.status': () => activeRecordings(),
  'record.list': () => listRecordings(),
  'cooperate.sync': cooperateSync,
  'cooperate.hold': cooperateHold,
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
  'network.replay': (params) => replayNetworkCommand(params),
  'network.waterfall': networkWaterfall,
  'trace.start': traceStart,
  'trace.stop': traceStop,
  'trace.status': traceStatus,
  pdf: printPdf,
  upload,
  'refs.negotiate': negotiateRefs,
  'longshot.recover': recoverLongshot,
  'debugger.detach': debuggerDetach,
  'debugger.simulate-detach': debuggerSimulateDetach,
  'debug.start': debugStart,
  'debug.stop': debugStop,
  'debug.current': debugCurrent,
  'debug.request': debugRequest,
  'debug.performance': debugPerformance,
  'debug.coverage': debugCoverage,
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

/** 诊断用：模拟 DevTools 接管（不写 intentional 标记），验证重挂恢复持有者与焦点仿真。 */
async function debuggerSimulateDetach(params = {}) {
  const tabId = Number(params.tabId);
  if (!Number.isInteger(tabId)) throw bridgeError('E_BAD_ARG', 'debugger.simulate-detach 需要 tabId');
  await simulateExternalDetach(tabId);
  return { ok: true, tabId };
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

/** 动作后同步观察一次：plan/step 共用，返回变化行数供 CLI 直接展示。 */
async function observeAfterAction(tabId) {
  if (!Number.isInteger(tabId)) return null;
  try {
    // plan/step 的同步观察要全文，不走 unchanged（否则返回空文本）。
    const observation = await execPage(tabId, 'observe', { probeHover: false, force: true });
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
      text: observation.observation,
      refs: observation.refs,
      changed,
      url: observation.url,
    };
  } catch {
    return null;
  }
}

async function plan(params = {}) {
  const steps = Array.isArray(params.steps) ? params.steps : null;
  if (!steps) throw bridgeError('E_BAD_ARG', 'plan 需要 steps 数组');
  if (!steps.length) throw bridgeError('E_BAD_ARG', 'plan 的 steps 不能为空');
  if (steps.length > 50) throw bridgeError('E_BAD_ARG', 'plan 单次最多 50 步');
  const results = [];
  let failedAt = null;
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index] && typeof steps[index] === 'object' ? steps[index] : {};
    // 三种写法都接受：{method,params}；{action:"fill",ref,value}（技能文档旧写法）；
    // {action:{method,params}}。统一整理后再执行，避免"照文档写就报错"。
    let method = typeof step.method === 'string' ? step.method : '';
    let stepParams = step.params && typeof step.params === 'object' ? { ...step.params } : {};
    if (typeof step.action === 'string' && step.action) {
      if (!method) method = step.action;
      const flat = { ...step };
      delete flat.action;
      delete flat.method;
      delete flat.params;
      stepParams = { ...flat, ...stepParams };
    } else if (step.action && typeof step.action === 'object') {
      if (!method && typeof step.action.method === 'string') method = step.action.method;
      const nested = step.action.params && typeof step.action.params === 'object' ? step.action.params : {};
      stepParams = { ...nested, ...stepParams };
    }
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
  // 一次调用就返回同步状态：省掉调用方"plan 完再 observe"的一次往返。
  // --fast：跳过收尾的同步观察（省一次 observe 往返；调用方自己需要时再 observe）。
  const observation = params.observeAfter === false ? null : await observeAfterAction(Number.isInteger(params.tabId) ? params.tabId : null);
  return {
    steps: results,
    completed: results.filter((item) => item.ok).length,
    failedAt,
    ...(observation ? { observation } : {}),
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
  const observation = await observeAfterAction(tabId);
  return { action: result, observation };
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
  const input = normalizeCompatParams(method, normalizeParams(method, params || {}));
  if (input.synthetic === true) { input.trusted = false; }
  if (!input.ref && typeof input.stableRef === 'string' && /^s-[A-Za-z0-9]+$/.test(input.stableRef)) {
    const stableEntry = refRegistry.getByStableRef(input.tabId, input.stableRef);
    if (!stableEntry) throw bridgeError('E_STALE_REF', 'stableRef 不在当前观察里，请重新 observe');
    input.ref = stableEntry.ref;
  }
  if (typeof input.ref === 'string') {
    const aliased = /^@e\d+$/.test(input.ref) ? resolveFrameAlias(input.tabId, input.ref) : null;
    if (aliased) {
      input.frameId = aliased.frameId;
      if (aliased.url) input.frameUrl = aliased.url;
      if (aliased.documentId) input.documentId = aliased.documentId;
      input.ref = aliased.localRef;
    }
    const framed = /^@f(\d+)e(\d+)$/.exec(input.ref);
    if (framed) {
      input.frameId = Number(framed[1]);
      input.ref = '@e' + framed[2];
    }
  }
  if (typeof input.ref === 'string' && /^@e\d+$/.test(input.ref) && input.expectRevision !== undefined) {
    const entry = refRegistry.get(input.tabId, input.ref);
    const expected = Number(input.expectRevision);
    if (entry && Number.isInteger(expected) && entry.key.revision !== expected) {
      throw bridgeError('E_STALE_REF', 'ref 与 expectRevision 不匹配，请重新 observe');
    }
  }
  if (TAB_METHODS.has(method)) {
    const unverified = method === 'evaluate' && input.unverified === true;
    if (unverified) {
      const conditions = Array.isArray(input.expect) ? input.expect : Array.isArray(input.dependsOn) ? input.dependsOn : [];
      if (conditions.length || input.observation != null) {
        throw bridgeError('E_BAD_ARG', 'evaluate --unverified 不能与 --expect/--depends-on/--observation 同时使用');
      }
      checkControl({ ...input, method });
    } else {
      checkControl({ ...input, method });
      await checkControlRevision({ ...input, method });
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
            { mismatch, conditions, kind: isDepends ? 'depends-on' : 'expect', dispatched: false, phase: 'precondition',
              retry_after_ms: 0,
              observed_changes: {
                checked: conditions.length,
                mismatched: 1,
                examples: [{ target: mismatch.target || null, field: mismatch.field || null, expected: mismatch.expected, actual: mismatch.actual }],
              } },
          );
        }
      }
    }
  }
  // 读取类方法默认不做观察代际校验；显式 --node-scope 时按节点级签名校验目标
  // （target_detached / 节点级 observed_changes），整页其他位置变化不拦读取。
  if (!TAB_METHODS.has(method) && input.nodeScope === true && (method === 'read' || method === 'get-html')) {
    checkControl({ ...input, method });
    await checkControlRevision({ ...input, method });
  }
  if (typeof input.ref === 'string' && /^@e\d+$/.test(input.ref)) {
    const entry = refRegistry.get(input.tabId, input.ref);
    if (entry && isFullRefKey(entry.key)) {
      input.backendNodeId = entry.key.backendNodeId;
      input.refKey = entry.key;
    } else if (entry && method === 'click' && !input.synthetic && Number(input.frameId || 0) === 0) {
      // 自动补 backend：先用页面侧生成稳定 selector，再由 CDP 解析真实 backendNodeId。
      try {
        const meta = await execPage(input.tabId, 'ref-selector', { ref: input.ref }, 0);
        if (meta && meta.selector) {
          const backendNodeId = await resolveBackendId(input.tabId, meta.selector);
          if (backendNodeId) {
            const key = refRegistry.upgradeBackend(input.tabId, input.ref, backendNodeId);
            if (key) { input.backendNodeId = key.backendNodeId; input.refKey = key; }
          }
        }
      } catch { /* 补全失败走 page-lib 回退 */ }
    }
  }
  const entry = typeof input.ref === 'string' ? refRegistry.get(input.tabId, input.ref) : null;
  const receiptTarget = entry
    ? {
      ref: input.ref || null,
      ...(entry.stableRef ? { stableRef: entry.stableRef } : {}),
      ...(entry.role ? { role: entry.role } : {}),
      ...(entry.name ? { name: entry.name } : {}),
      ...(input.selector ? { selector: input.selector } : {}),
    }
    : (input.selector ? { selector: input.selector } : (input.text ? { text: input.text } : null));
  let result;
  try {
    result = await handler(input);
  } catch (error) {
    if (error && typeof error === 'object' && needsReceipt(method)) {
      // 事务一旦开始（有 tx/journal），即使错误里标的是 effect_state:none，
      // 浏览器侧是否已产生副作用也无法证明 —— 回执必须按 unknown 记，禁止谎报 clean。
      const rawState = error.data && error.data.effect_state;
      const began = Boolean(error.data && (error.data.tx_id || error.data.journal_id));
      const effectState = began && (!rawState || rawState === 'none') ? 'unknown' : (rawState || 'unknown');
      const errorReceipt = buildActionReceipt({ method, ref: input.ref, frameId: input.frameId || 0, revision: entry ? entry.key.revision : (input.expectRevision != null ? Number(input.expectRevision) : null), effectState, target: receiptTarget });
      error.data = { ...(error.data && typeof error.data === 'object' ? error.data : {}), receipt: errorReceipt };
    }
    throw error;
  }
  const receipt = needsReceipt(method)
    ? buildActionReceipt({ method, ref: input.ref, frameId: input.frameId || 0, revision: entry ? entry.key.revision : (input.expectRevision != null ? Number(input.expectRevision) : null), effectState: result && result.effectState, via: result && result.via, target: receiptTarget })
    : null;
  const withReceipt = receipt ? attachReceipt(result, receipt) : result;
  const settleMs = Number(input.settleMs);
  if (Number.isFinite(settleMs) && settleMs > 0) {
    const wait = Math.min(Math.max(Math.round(settleMs), 0), 5000);
    await sleep(wait);
    if (withReceipt && typeof withReceipt === 'object' && !Array.isArray(withReceipt)) {
      return { ...withReceipt, settledMs: wait };
    }
  }
  return withReceipt;
}

/**
 * 执行命令：带 tabId 的命令按 tabId 串行（PROTOCOL.md §3.3），无 tabId 的直接执行。
 * 返回 handle 后的最终结果 Promise。
 */
// Agent 自己通过 CDP 派发的可信鼠标/键盘事件也会触发页面 isTrusted=true，
// 记下这些命令的执行窗口，后台据此忽略“自产”的 human.input，避免误自动暂停会话。
const agentInputWindows = new Map(); // tabId -> { start, end }

const AGENT_INPUT_METHODS = new Set([
  'click', 'click-backend', 'hover', 'fill', 'press', 'select', 'drag', 'wheel', 'upload', 'download', 'click-point', 'shadow.click',
]);

export function isAgentInputWindow(tabId, at) {
  const window = agentInputWindows.get(Number(tabId));
  if (!window) return false;
  const timestamp = Number(at) || Date.now();
  const end = window.end === Infinity ? Date.now() : window.end;
  // 页面侧 human.input 的上报可能晚于命令完成（长任务/主线程繁忙时实测可到秒级），
  // 500ms 会把 Agent 自产的 trusted 事件误判成人工接管并自动暂停会话（E2E 长跑级联）。
  // 这里放宽到 2s 有界宽限：仍远小于“人真的接手后继续操作”的间隔，但能吸收事件延迟。
  return timestamp >= window.start - 50 && timestamp <= end + 2000;
}

/** tab 关闭时清掉按 tabId 记账的输入窗口/串行链，避免长生命周期实例里无界增长。 */
export function forgetAgentInput(tabId) {
  const id = Number(tabId);
  if (!Number.isInteger(id)) return;
  agentInputWindows.delete(id);
  passthroughTokens.delete(id);
  tabChains.delete(id);
}

const passthroughTokens = new Map();
const TARGET_MARKER_METHODS = new Set(['click', 'click-point', 'click-backend', 'hover']);

// capture suppression 的接线表：截图类整段按 capture 抑制，原生输入按 native-input 抑制。
// 这些方法在 runSerialized 里 acquire，在 finally 里 release（失败/超时也释放，见
// lib/suppression-scope.js 的看门狗与 outcome 证据）。
const SUPPRESS_METHOD_KINDS = new Map();
for (const method of ['click', 'click-backend', 'hover', 'fill', 'press', 'select', 'drag', 'wheel', 'upload', 'download', 'shadow.click']) {
  SUPPRESS_METHOD_KINDS.set(method, SUPPRESSION_KINDS.NATIVE_INPUT);
}
for (const method of ['screenshot', 'screenshot.manual.start', 'screenshot.manual.frame', 'screenshot.manual.save']) {
  SUPPRESS_METHOD_KINDS.set(method, SUPPRESSION_KINDS.CAPTURE);
}

/** 借用确认闸门：确认未完成（handoff）时动作被拒绝，并给出 requestId/等待时长证据。 */
function assertBorrowAllowed(tabId, method) {
  if (tabId == null || !TAB_METHODS.has(String(method))) return;
  const gate = borrowGate.check(tabId, method);
  if (gate.allowed) return;
  throw bridgeError(
    gate.code,
    '借用确认未完成（requestId=' + String(gate.evidence.requestId || '?') + '，已等待 ' + Math.round(Number(gate.evidence.pendingMs) || 0) + 'ms）：等用户点「允许」或超时后重试',
    gate.evidence,
  );
}

// 归因时钟：按动作类型给内容脚本一个"这是 Agent 输入"的期待窗口。
const INPUT_EXPECTATIONS = new Map([
  ['click', ['pointer', 'focus', 'scroll']],
  ['click-point', ['pointer', 'focus', 'scroll']],
  ['click-backend', ['pointer', 'focus', 'scroll']],
  ['hover', ['pointer', 'scroll']],
  ['drag', ['pointer', 'scroll']],
  ['wheel', ['pointer', 'scroll']],
  ['fill', ['focus', 'key', 'input', 'change', 'scroll']],
  ['press', ['focus', 'key', 'scroll']],
  ['select', ['focus', 'input', 'change', 'scroll']],
  ['upload', ['focus', 'input', 'change', 'scroll']],
  ['focus', ['focus', 'scroll']],
  ['blur', ['focus', 'scroll']],
]);
function expectationForMethod(method) {
  const kinds = INPUT_EXPECTATIONS.get(String(method));
  return kinds ? { kinds } : null;
}

export function runSerialized(method, params) {
  const input = params && typeof params === 'object' ? params : {};
  const tabId = Number.isInteger(input.tabId) ? input.tabId : null;
  const policyCheck = tabId != null ? checkTabPolicy(tabId, method, input) : Promise.resolve();
  const markTarget = async (result) => {
    if (!result || !TARGET_MARKER_METHODS.has(method)) return result;
    if (tabId == null) { result.targetMarker = 'no-tab'; return result; }
    if (!getTakeoverState(tabId)) { result.targetMarker = 'no-takeover'; return result; }
    let x = Number(result.x);
    let y = Number(result.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      const target = input.ref ? { ref: input.ref } : (input.selector ? { selector: input.selector } : null);
      if (!target) { result.targetMarker = 'no-target'; return result; }
      const point = await execPage(tabId, 'point', target).catch(() => null);
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) { result.targetMarker = 'no-point'; return result; }
      x = point.x;
      y = point.y;
    }
    result.targetMarker = (await showTargetMarker(tabId, x, y).catch(() => false)) ? 'shown' : 'failed';
    return result;
  };
  let suppressionScopeRef = null; // 本次动作的 capture 抑制引用（finally 里 release）
  const track = async () => {
    if (tabId == null) return;
    // 【接线】截图/原生输入开始时 acquire capture 抑制：整段动作（包括后续的
    // withOverlaysHidden / CDP 截图 / 原生输入派发）都处在抑制窗口内。
    const suppressKind = SUPPRESS_METHOD_KINDS.get(method);
    if (suppressKind) {
      suppressionScopeRef = suppressionScope.begin(tabId, { kind: suppressKind, method, owner: 'dispatch' });
      if (!suppressionScopeRef.ok && suppressionScopeRef.code === 'E_CAPTURE_LIMIT') {
        log('dispatch capture 抑制引用超上限，按不抑制继续：tab=' + tabId + ' method=' + method);
      }
    }
    if (!AGENT_INPUT_METHODS.has(method)) return;
    agentInputWindows.set(tabId, { start: Date.now(), end: Infinity });
    // 在页面上标记“接下来是 Agent 输入”：trusted 路径由扩展直接发 CDP 事件，不经过 page-lib 的
    // actionClick/actionPress，必须在这里先写标记，否则页面会把自己的 trusted 事件当成人工接管。
    await execPage(tabId, 'mark-agent-input', {}).catch(() => {});
    try {
      const lease = await beginCooperationPassthrough(tabId, controlGeneration(tabId), expectationForMethod(method));
      if (lease) passthroughTokens.set(tabId, lease);
    } catch (error) {
      // authority 无法对齐时 fail closed：继续动作会在输入锁下静默失败/误点。
      if (error && error.code === 'E_COOPERATION_STALE') throw error;
    }
    // 归因时钟：贴近派发时刻再登记一次 expectation（±1.5ms 时间戳归因的基准时间）。
    // 指针类动作随后会带坐标再登记一次，以后者为准。
    const expectation = expectationForMethod(method);
    if (expectation) await armCooperationExpectation(tabId, expectation).catch(() => {});
    controllerState.noteAction(tabId, method);
  };
  const untrack = (outcome = 'ok') => {
    if (tabId != null && suppressionScopeRef) {
      // 【接线】finally 释放；失败/超时也走这里，证据（outcome/heldMs/expired）留在作用域历史里。
      const ended = suppressionScope.end(tabId, { scopeId: suppressionScopeRef.scopeId, outcome });
      if (ended && ended.evidence && ended.evidence.expired) {
        log('dispatch capture 抑制看门狗超时释放：tab=' + tabId + ' method=' + method);
      }
      suppressionScopeRef = null;
    }
    const window = tabId != null ? agentInputWindows.get(tabId) : null;
    if (window) window.end = Date.now();
    const lease = tabId != null ? passthroughTokens.get(tabId) : null;
    if (lease) {
      passthroughTokens.delete(tabId);
      void endCooperationPassthrough(tabId, lease);
    }
  };
  if (tabId == null || UNSERIALIZED_METHODS.has(method)) {
    return (async () => {
      await policyCheck;
      assertBorrowAllowed(tabId, method);
      try {
        await track();
        const result = await markTarget(await dispatchCommand(method, input));
        untrack('ok');
        return result;
      } catch (error) {
        // track 里失败（authority 无法对齐）或 handler 抛错：抑制/租约/输入窗口都必须释放。
        untrack('error');
        throw error;
      }
    })();
  }

  const previous = tabChains.get(tabId) || Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    await policyCheck;
    assertBorrowAllowed(tabId, method);
    try {
      await track();
      const result = await markTarget(await dispatchCommand(method, input));
      untrack('ok');
      return result;
    } catch (error) {
      untrack('error');
      throw error;
    }
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
