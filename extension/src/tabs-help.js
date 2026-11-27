// src/tabs-help.js —— request-help / control-hint。
import { bridgeError } from './errors.js';
import { readSettings } from './settings.js';
import { withTimeout } from './timeout.js';
import { log } from './log.js';
import { execPage } from './inject.js';
import { getTab, sleep } from './tabs.js';
import { hideTakeover, resumeTakeover, showTakeover } from './takeover.js';
import { closeOverlay, openOverlay } from './overlay-state.js';
import { clearActionNotification, notifyActionRequest } from './action-notifications.js';
import { helpOverlayFunc } from './overlay-ui.js';
import { overlayTexts } from './overlay-texts.js';
import { OVERLAY_THEME } from './overlay-theme.js';
import { waitHumanDecision } from './human-decisions.js';
import { injectBanner, readUiLang } from './borrow-ui.js';

export async function requestHelp(params = {}) {
  const tabId = params.tabId;
  if (!Number.isInteger(tabId)) throw bridgeError('E_BAD_ARG', 'request-help 需要 tabId');
  const reason = String(params.reason || '').trim();
  if (!reason) throw bridgeError('E_BAD_ARG', 'request-help 需要 reason');
  const settings = await readSettings();
  if (!settings.allowHelp) throw bridgeError('E_HELP_DISABLED', '设置里关闭了人工协助');
  const tab = await getTab(tabId);
  const rawTimeout = Number(params.timeoutMs);
  const timeoutMs = Math.min(Math.max(Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 180000, 5000), 600000);
  const requestId = crypto.randomUUID();
  const pending = waitHumanDecision(requestId, timeoutMs, () => ({ action: 'timeout' }));
  // 完成条件：人工完成页面操作后自动交还，不必再点卡片按钮。
  const criteria = (Array.isArray(params.criteria) ? params.criteria : [])
    .filter((item) => item && typeof item === 'object')
    .slice(0, 10)
    .map((item) => {
      const kind = String(item.kind || item.type || '');
      if (kind === 'selector_exists' || kind === 'selector_visible') return { kind, selector: String(item.selector || '') };
      if (kind === 'text_exists') return { kind, text: String(item.text || '') };
      if (kind === 'url_contains') return { kind, text: String(item.text || '') };
      return { kind, unsupported: true };
    })
    .filter((item) => !item.unsupported && (item.selector || item.text));
  let stopCriteriaPolling = false;
  let criteriaPoller = null;
  let criteriaLast = null;
  if (criteria.length) {
    criteriaPoller = (async () => {
      while (!stopCriteriaPolling) {
        await sleep(400);
        if (stopCriteriaPolling) return null;
        let currentUrl = '';
        try {
          const current = await chrome.tabs.get(tabId);
          currentUrl = current && current.url ? String(current.url) : '';
        } catch {
          // 标签页可能已关闭：交给 pending 的超时/关闭逻辑
        }
        const urlOk = criteria
          .filter((item) => item.kind === 'url_contains')
          .every((item) => currentUrl.includes(String(item.text || '')));
        if (!urlOk) continue;
        const pageCriteria = criteria.filter((item) => item.kind !== 'url_contains');
        if (!pageCriteria.length) return { action: 'done', note: 'completion criteria satisfied' };
        try {
          const checked = await execPage(tabId, 'help-criteria-check', { criteria: pageCriteria });
          criteriaLast = checked;
          if (checked && checked.ok === true) return { action: 'done', note: 'completion criteria satisfied' };
        } catch (error) {
          criteriaLast = { error: String((error && error.message) || error), code: error && error.code };
          // 页面暂时不可执行：下一轮再试
        }
      }
      return null;
    })();
  }
  let highlightTarget = params.target ? String(params.target) : '';
  let highlightRect = null;
  if (highlightTarget.startsWith('@')) {
    const frameMatch = /^@f(\d+)e(\d+)$/.exec(highlightTarget);
    const frameId = frameMatch ? Number(frameMatch[1]) : 0;
    const localRef = frameMatch ? '@e' + frameMatch[2] : highlightTarget;
    try { highlightRect = await execPage(tabId, 'rect', { ref: localRef }, frameId); } catch { highlightRect = null; }
    highlightTarget = '';
  }
  await hideTakeover(tabId, { preserveState: true }).catch(() => {});
  openOverlay(tabId, 'help', { priority: 50 });
  try {
    const overlayLang = await readUiLang();
    await injectBanner(tabId, helpOverlayFunc, [requestId, reason, highlightTarget, highlightRect, String(params.title || ''), overlayLang, OVERLAY_THEME, overlayTexts(overlayLang)]);
    try {
      await notifyActionRequest('help', { requestId, tabId, title: params.title || '', lang: overlayLang });
    } catch { /* 通知失败不影响页面协助 */ }
    try {
      await withTimeout(chrome.windows.update(tab.windowId, { focused: true }), 3000, 'windows.update');
      await withTimeout(chrome.tabs.update(tabId, { active: true }), 3000, 'tabs.update');
    } catch {
      // 忽略置前失败
    }
    log('请求人工协助 tab=' + tabId + ' timeout=' + timeoutMs + (criteria.length ? ' criteria=' + criteria.length : ''));
    let answer;
    try {
      answer = criteriaPoller ? await Promise.race([pending, criteriaPoller]) : await pending;
    } finally {
      stopCriteriaPolling = true;
    }
    clearActionNotification('help', requestId);
    try { await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: () => { const n = document.getElementById('__bb_help_host'); if (n) n.remove(); const h = document.getElementById('__bb_help_highlight'); if (h) h.remove(); } }); } catch { /* 页面可能已关闭 */ }
    // 用户点“完成并交还控制权”（或完成条件满足）＝明确把控制权交回 Agent：
    // 解除可能由协助期间人工输入触发的 daemon auto pause，并把 controller 收回 agent-ready。
    if (answer.action === 'done') {
      // force：即使本地还没收到 daemon 的 auto pause 事件（交还先于事件到达），也要显式
      // 发 resume；daemon 会把会话从 paused 恢复，尾随的 auto pause 由 bridge 的交还窗口丢弃。
      await resumeTakeover(tabId, { source: 'request-help.done', force: true }).catch(() => {});
    }
    await showTakeover(tabId, {}).catch(() => {});
    return { action: answer.action === 'done' ? 'done' : answer.action === 'skip' ? 'skip' : 'timeout', note: typeof answer.note === 'string' ? answer.note : '' };
  } finally {
    closeOverlay(tabId, 'help');
  }
}

export async function controlHint(params = {}) {
  const tabId = Number(params.tabId);
  if (!Number.isInteger(tabId)) throw bridgeError('E_BAD_ARG', 'control-hint 需要 tabId');
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: 'ISOLATED',
      func: () => { document.getElementById('__bb_control_hint')?.remove(); },
    });
  } catch {
    // 页面不可注入时忽略
  }
  return { ok: true, enabled: false };
}