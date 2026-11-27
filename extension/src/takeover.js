// src/takeover.js —— Agent 接管浮层（BridgeDeck蓝配色）
import { log } from './log.js';
import { readSettings } from './settings.js';
import { closeOverlay, isCapturing, openOverlay } from './overlay-state.js';
import { installTakeover } from './overlay-ui.js';
import { overlayTexts, overlayA11yTexts } from './overlay-texts.js';
import { OVERLAY_THEME } from './overlay-theme.js';
import { setCooperationBlocked } from './cooperation.js';
import { bumpRevisions, controlGeneration } from './control-generation.js';
import { controllerState, transitionBumps } from './lib/controller-state.js';
import { sendDaemonEvent } from './lib/daemon-events.js';

const takeoverStates = new Map();
const takeoverVersions = new Map();
/** 显式交还控制权的时间戳（per tab）：用于丢弃交还后尾随到达的 auto pause 事件。 */
const explicitHandbacks = new Map();

/** 近期是否有“人明确交还控制权”（帮助完成 / cooperate handback）。 */
export function recentlyHandedBack(tabId, windowMs = 2000) {
  const id = Number(tabId);
  if (!Number.isInteger(id)) return false;
  const at = explicitHandbacks.get(id) || 0;
  return at > 0 && Date.now() - at <= (Number(windowMs) > 0 ? Number(windowMs) : 2000);
}

/**
 * 应用 daemon 下发的 takeover.state（paused/pausedBy/borrowed/controller）。
 * 交还窗口内丢弃尾随的 auto pause：人已经明确交还，不应被协助期间残留的 trusted
 * 输入事件重新暂停。手动暂停（pausedBy=manual）永远尊重，不会被丢弃。
 * @returns {{state: object, ignoredAutoPause: boolean}}
 */
export function applyDaemonTakeoverState(tabId, params = {}) {
  const id = Number(tabId);
  const pausedByAuto = String(params.pausedBy || '') === 'auto';
  const ignoredAutoPause = pausedByAuto && params.paused === true && recentlyHandedBack(id);
  const state = {
    sessionId: params.sessionId || '',
    paused: params.paused === true && !ignoredAutoPause,
    borrowed: params.borrowed === true,
    controller: params.controller || null,
    project: params.project || (params.controller && params.controller.project) || null,
  };
  if (Number.isInteger(id)) setTakeoverState(id, state);
  return { state, ignoredAutoPause };
}

/**
 * 浮层上的暂停/恢复是“人工接管”的入口之一（另一个是 cooperate.hold）。
 * 这里把 paused 变化对齐进 controller 状态机：held 期间 TAB_METHODS 被拒绝，
 * 恢复时按迁移表回到 agent。迁移被拒只记日志，不硬翻状态。
 */
function syncControllerFromPause(tabId, paused) {
  const id = Number(tabId);
  if (!Number.isInteger(id)) return null;
  const current = controllerState.get(id);
  let moved;
  if (paused) {
    moved = controllerState.transition(id, 'hold.engage', { source: 'takeover', reason: 'overlay-pause' });
  } else if (current === 'held') {
    moved = controllerState.transition(id, 'hold.release', { source: 'takeover', reason: 'overlay-resume' });
  } else {
    return null;
  }
  if (moved && moved.ok) {
    const delta = transitionBumps(moved);
    if (Object.keys(delta).length) bumpRevisions(id, delta);
  } else if (moved) {
    log('takeover 暂停迁移被拒绝：tab=' + id + ' code=' + moved.code + ' state=' + current);
  }
  return moved;
}

export function setTakeoverState(tabId, patch) {
  const next = { ...(takeoverStates.get(tabId) || {}), ...(patch || {}) };
  takeoverStates.set(tabId, next);
  if (patch && typeof patch.paused === 'boolean') syncControllerFromPause(tabId, patch.paused);
  return next;
}

export function getTakeoverState(tabId) {
  return takeoverStates.get(tabId) || {};
}

export function clearTakeoverState(tabId) {
  takeoverStates.delete(tabId);
  explicitHandbacks.delete(tabId);
}

/**
 * 人明确交还控制权（协助完成 / cooperate handback / 接管浮层“交给 Agent”）：
 * 清扩展内 paused 标记 + 把 controller 收回 agent-ready + 通知 daemon 解除会话暂停。
 *
 * 为什么需要它：会话暂停状态在 daemon（`session.paused`），扩展内只改 takeover 状态
 * 解不开；旧路径只能等下一次 cooperate.sync 的“人工静默 2s + Agent 静默 3s”自动恢复。
 * 期间帮助卡片上的人机交互可能产生 trusted 输入触发 daemon auto pause，于是
 * “完成并交还控制权”之后的下一条动作仍被 E_SESSION_PAUSED 拒绝（E2E 24b~26 级联失败的
 * 真实根因）。交还点显式 resume 才是旧实现的“人做完 → 自动 ready”语义。
 *
 * @param {number} tabId
 * @param {{source?: string, force?: boolean}} [options] force=true 时无论本地是否 paused 都通知 daemon
 */
export async function resumeTakeover(tabId, options = {}) {
  // null/''/非数字都不是合法 tabId（Number(null)===0 会把“没传”误判成 tab 0）。
  const id = tabId == null || tabId === '' ? NaN : Number(tabId);
  if (!Number.isInteger(id)) return { ok: false, code: 'E_BAD_ARG', error: 'resumeTakeover 需要整数 tabId', tabId: null };
  const source = String(options.source || 'resume-takeover');
  const current = takeoverStates.get(id) || {};
  const wasPaused = current.paused === true;
  const controllerBefore = controllerState.get(id);
  // 记下“人明确交还”的时刻：帮助卡片/浮层交互可能在交还后还产生 trusted 输入，
  // daemon 会因此再发一次 auto pause；bridge 收到后按这个窗口丢弃，避免刚 ready 又被暂停。
  explicitHandbacks.set(id, Date.now());
  // 本地先解锁：setTakeoverState 的 paused hook 会把 controller held → agent，并推进计数。
  const next = setTakeoverState(id, { paused: false });
  // controller 可能停在 human（人工刚操作过、尚未 sync）：交回控制权同样视为回到 agent。
  let moved = null;
  if (controllerState.get(id) === 'human') {
    moved = controllerState.transition(id, 'human.return', { source });
    if (moved && moved.ok) {
      const delta = transitionBumps(moved);
      if (Object.keys(delta).length) bumpRevisions(id, delta);
    }
  }
  // 通知 daemon：会话从 paused 恢复（daemon 侧是动作闸门的真正决策点）。
  let daemon = null;
  if (wasPaused || options.force === true) {
    daemon = sendDaemonEvent('takeover.pause', { tabId: id, paused: false });
    if (!daemon.ok) log('resume 通知 daemon 失败 tab=' + id + '：' + (daemon.code || 'unknown'));
  }
  const evidence = {
    tabId: id,
    source,
    previousPaused: wasPaused,
    controllerBefore,
    controllerAfter: controllerState.get(id),
    daemonEvent: daemon,
    at: Date.now(),
  };
  if (wasPaused) log('人工交回控制权 tab=' + id + '（source=' + source + '）→ 已解除暂停');
  return { ok: true, resumed: wasPaused, tabId: id, takeover: next, controller: controllerState.snapshot(id), evidence };
}


async function readUiLang() {
  try {
    const stored = await chrome.storage.local.get('bb.uiLang');
    const value = stored && stored['bb.uiLang']; return value || 'zh';
  } catch {
    return 'zh';
  }
}

export async function showTakeover(tabId, info = {}) {
  const merged = { ...getTakeoverState(tabId), ...(info || {}) };
  info = merged;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!/^https?:/i.test(tab.url || '')) return;
  } catch {
    return;
  }
  // 「控制提示」关闭时不显示任何接管浮层/呼吸边框；状态仍然保留，
  // 重新打开后 syncControlHintsVisible 会把浮层补回来。
  const settings = await readSettings().catch(() => null);
  if (settings && settings.controlHint === false) {
    await removeTakeoverDom(tabId);
    return;
  }
  if (isCapturing(tabId)) return;
  openOverlay(tabId, 'takeover', { priority: 10 });
  const lang = await readUiLang();
  takeoverVersions.set(tabId, (takeoverVersions.get(tabId) || 0) + 1);
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: installTakeover,
      args: [{
        sessionId: info.sessionId || '',
        project: info.project || '',
        paused: info.paused === true,
        borrowed: info.borrowed === true,
        // 控制标签：agent 名称 / 项目 / 会话 id / 颜色都要传给页面浮层，
        // 漏传会让浮层永远显示默认的 "BridgeDeck"。
        controller: info.controller && typeof info.controller === 'object' ? info.controller : null,
        mode: info.mode || null,
        minimized: info.minimized === true,
      }, lang, (takeoverVersions.get(tabId) || 0) + 1, OVERLAY_THEME, overlayTexts(lang), { ...overlayA11yTexts(lang), mode: settings && settings.overlayA11y === true ? 'accessible' : 'closed' }],
    });
    // 可选输入锁：只在接管浮层可见且未暂停/未收起时锁页面；用户点暂停或
    // 收起后立即放开。设置默认关闭，避免无提示地改变现有交互。
    const guard = settings && settings.cooperationGuard === true &&
      info.paused !== true && info.minimized !== true;
    await setCooperationBlocked(tabId, guard, controlGeneration(tabId));
  } catch (error) {
    log('接管浮层注入失败 tab=' + tabId + '：' + ((error && error.message) || error));
  }
}

/** 只移除页面上的浮层 DOM，保留 tab 的接管状态（供重新打开控制提示时恢复）。 */
export async function removeTakeoverDom(tabId) {
  takeoverVersions.set(tabId, (takeoverVersions.get(tabId) || 0) + 1);
  await setCooperationBlocked(tabId, false, controlGeneration(tabId));
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: () => { window.__bbTakeoverVersion = (Number(window.__bbTakeoverVersion) || 0) + 1; const n = document.querySelector('[data-bb-ui="takeover"]') || document.getElementById('__bb_takeover_host'); if (n) n.remove(); } });
  } catch {
    // 页面可能已关闭
  }
}

export async function hideTakeover(tabId, options = {}) {
  closeOverlay(tabId, 'takeover');
  if (options.preserveState !== true) clearTakeoverState(tabId);
  await removeTakeoverDom(tabId);
}

/**
 * 「控制提示」开关：关闭时撤掉所有页面上的浮层，打开时按保留的状态补回。
 * 语义是“状态提示 + 呼吸边框”整块的显隐。
 * 注意 service worker 重启后内存里的 takeoverStates 会丢，所以这里同时参考
 * 持久化的 agent 窗口登记（bb.agentWindowIds）。
 */
export async function syncControlHintsVisible(visible) {
  if (!visible) {
    // 关闭：所有 http(s) 页都顺手清一遍（没有浮层的页面无副作用）
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id && /^https?:/i.test(tab.url || '')) await removeTakeoverDom(tab.id);
    }
    return;
  }
  const ids = new Set(takeoverStates.keys());
  try {
    const stored = await chrome.storage.session.get('bb.agentWindowIds');
    const windows = new Set(stored && Array.isArray(stored['bb.agentWindowIds']) ? stored['bb.agentWindowIds'] : []);
    if (windows.size) {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) if (tab.id && windows.has(tab.windowId)) ids.add(tab.id);
    }
  } catch {
    // 读不到登记就只恢复内存里记录的
  }
  for (const tabId of ids) await showTakeover(tabId, {});
}
