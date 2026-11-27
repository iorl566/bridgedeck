// src/tabs-borrow.js —— tab.borrow / tab.return 业务主体（借用确认、接管、归还）。
import { bridgeError } from './errors.js';
import { readSettings } from './settings.js';
import { withTimeout } from './timeout.js';
import { log } from './log.js';
import { getTab, isAgentWindow } from './tabs.js';
import { readControlledTabs, writeControlledTabs } from './controlled-tabs.js';
import { showTakeover, hideTakeover } from './takeover.js';
import { clearActionNotification, notifyActionRequest } from './action-notifications.js';
import { borrowUiRequests, injectBorrowModal, injectBorrowToast, readUiLang, releaseBorrowUi } from './borrow-ui.js';
import { waitHumanDecision } from './human-decisions.js';
import { borrowGate } from './lib/borrow-confirm.js';
import { controllerState } from './lib/controller-state.js';

const BORROW_TIMEOUT_MS = 60000;

/** tab.borrow：标记接管用户标签页；borrowConfirm 打开时必须由用户点「允许」。 */
const borrowInFlight = new Set();

async function tabBorrowInner(params, stage) {
  const tabId = Number(params && params.tabId);
  if (!Number.isInteger(tabId)) return tabBorrowInnerUnlocked(params, stage);
  if (borrowInFlight.has(tabId)) {
    throw bridgeError('E_BORROW_CONFLICT', '该标签页已有借用确认进行中，请等待当前请求结束');
  }
  borrowInFlight.add(tabId);
  try {
    return await tabBorrowInnerUnlocked(params, stage);
  } finally {
    borrowInFlight.delete(tabId);
  }
}

async function tabBorrowInnerUnlocked(params, stage) {
  const tabId = params.tabId;
  if (!Number.isInteger(tabId)) throw bridgeError('E_BAD_ARG', 'tab.borrow 需要一个 tabId');
  stage.value = 'getTab';
  const tab = await getTab(tabId);
  stage.value = 'settings';
  const settings = await readSettings();
  // 安全策略：借用前确认只听浏览器里保存的设置；命令行/助手传入的 borrowConfirm 不能降级。
  const confirm = settings.borrowConfirm !== false;
  const controlled = await readControlledTabs();
  if (!controlled.includes(tabId)) {
    const isExtPage = /^(chrome|edge)-extension:\/\//i.test(tab.url || '');
    if (await isAgentWindow(tab.windowId)) {
      throw bridgeError('E_FORBIDDEN', '不能借用 Agent 窗口内的标签页，请先把标签页移到普通浏览器窗口');
    }
    if (confirm && !isExtPage) {
      stage.value = 'banner';
      const requestId = crypto.randomUUID();
      const req = {
        requestId,
        targetTabId: tabId,
        windowId: tab.windowId,
        title: tab.title || '',
        lang: await readUiLang(),
        timeoutMs: BORROW_TIMEOUT_MS,
        surface: null,
        surfaceTabId: null,
      };
      // 确认闸门：从这里到用户点「允许」之前，任何打到该 tab 的动作都会被 dispatch 拒绝
      //（E_BORROW_CONFLICT + requestId/等待时长证据），不会在“未确认”状态下动用户页面。
      const gate = borrowGate.request(tabId, {
        requestId,
        timeoutMs: BORROW_TIMEOUT_MS,
        windowId: tab.windowId,
        title: tab.title || '',
      });
      if (!gate.ok) {
        throw bridgeError('E_BORROW_CONFLICT', '借用确认登记失败：' + String(gate.error || gate.code || 'unknown'), gate.evidence || { tabId, requestId });
      }
      borrowUiRequests.set(requestId, req);
      const pending = waitHumanDecision(requestId, BORROW_TIMEOUT_MS, () => ({ decision: 'timeout' }));
      try {
        let activeTab = null;
        try {
          const activeTabs = await chrome.tabs.query({ active: true, windowId: tab.windowId });
          activeTab = (activeTabs || [])[0] || null;
        } catch { /* 查询失败按目标标签处理 */ }
        const targetIsActive = activeTab && Number(activeTab.id) === tabId;
        if (targetIsActive) {
          await injectBorrowModal(req, { focus: true });
        } else if (activeTab && Number.isInteger(Number(activeTab.id))) {
          try {
            await injectBorrowToast(req, Number(activeTab.id));
          } catch {
            // 活动标签不可注入（chrome:// 等）时退回目标标签模态，不能没有可见确认。
            try { await withTimeout(chrome.tabs.update(tabId, { active: true }), 3000, 'tabs.update'); } catch { /* 忽略 */ }
            await injectBorrowModal(req, { focus: true });
          }
        } else {
          await injectBorrowModal(req, { focus: true });
        }
        // Toast 已经显示在当前标签页右下角；再发系统通知会在同一位置盖住它
        // （本机 Edge 实测）。只有模态确认才额外发系统通知，保证两处不互相遮挡。
        if (req.surface === 'modal') {
          try {
            await notifyActionRequest('borrow', { requestId, tabId, title: tab.title || '', lang: req.lang });
          } catch { /* 通知失败不影响页面确认 */ }
        }
        const answer = await pending;
        clearActionNotification('borrow', requestId);
        // 结算闸门：allow 才把 controller 推到 borrowed 并放行动作；deny/timeout 保持终态证据。
        const decided = borrowGate.resolve(requestId, answer);
        if (!decided.allowed) {
          const timedOut = decided.status === 'timeout';
          throw bridgeError(
            timedOut ? 'E_BORROW_TIMEOUT' : 'E_BORROW_DENIED',
            timedOut ? '借用确认 ' + BORROW_TIMEOUT_MS + 'ms 内没有响应' : '用户拒绝了借用请求',
            decided.evidence,
          );
        }
      } finally {
        clearActionNotification('borrow', requestId);
        // 异常/中断路径不能留下 pending 闸门（否则该 tab 的动作会被永久拒绝）。
        const status = borrowGate.status(tabId);
        if (status && status.status === 'pending') {
          borrowGate.cancel(tabId, 'borrow-aborted');
          borrowGate.clear(tabId);
        }
        await releaseBorrowUi(requestId);
      }
    }
    stage.value = 'takeover';
    controlled.push(tabId);
    // 浮层只是提示，不能阻塞借用本身；脚本注入异常/挂起时按无浮层继续。
    await withTimeout(showTakeover(tabId, { name: settings.instanceLabel || 'BridgeDeck', subtitle: 'Agent 已接管该标签页；你随时可以收回控制。' }), 5000, 'borrow takeover').catch((error) => log('借用浮层注入失败：' + ((error && error.message) || error)));
    await writeControlledTabs(controlled);
    // 确认已通过时 controller 已经是 borrowed（borrowGate.resolve 推的）；确认被设置关闭、
    // 或目标页是扩展页时没有确认请求，这里用 adopt 记录“借用以隐式确认完成”的事实。
    if (controllerState.get(tabId) !== 'borrowed') {
      controllerState.adopt(tabId, 'borrowed', { event: 'borrow.implicit', source: 'tab.borrow' });
    }
  } else if (controllerState.get(tabId) == null) {
    // service worker 重启后 controller 状态丢了：已受控 tab 按 borrowed 恢复。
    controllerState.adopt(tabId, 'borrowed', { event: 'borrow.restore', source: 'tab.borrow' });
  }
  stage.value = 'done';
  log('借用标签页 tab=' + tabId + ' window=' + tab.windowId);
  return {
    tabId: tabId,
    windowId: tab.windowId,
    originalWindowId: tab.windowId,
    originalIndex: tab.index,
    url: tab.url || '',
    title: tab.title || '',
  };
}

export async function tabBorrow(params = {}) {
  const stage = { value: 'start' };
  try {
    return await withTimeout(tabBorrowInner(params, stage), 75000, 'tabBorrow');
  } catch (error) {
    if (error && !String(error.message || '').includes('[stage=')) error.message = String(error.message || error) + ' [stage=' + stage.value + ']';
    throw error;
  }
}

/** tab.return：只清标记，不移动也不关闭标签页。 */
export async function tabReturn(params = {}) {
  const tabId = params.tabId;
  if (!Number.isInteger(tabId)) throw bridgeError('E_BAD_ARG', 'tab.return 需要 tabId');
  const controlled = await readControlledTabs();
  const next = controlled.filter((id) => id !== tabId);
  await writeControlledTabs(next);
  await hideTakeover(tabId);
  // 归还：清借用确认记录 + controller 从 borrowed 回到 idle（迁移表里唯一允许的出口）。
  borrowGate.clear(tabId);
  const moved = controllerState.transition(tabId, 'borrow.return', { source: 'tab.return' });
  if (!moved || !moved.ok) controllerState.adopt(tabId, 'idle', { event: 'borrow.return', source: 'tab.return' });
  let windowId = null;
  try {
    const tab = await chrome.tabs.get(tabId);
    windowId = tab.windowId;
  } catch {
    windowId = null;
  }
  log('归还标签页 tab=' + tabId + (windowId != null ? ' window=' + windowId : '（已关闭）'));
  return {
    ok: true,
    windowId: windowId,
    controller: controllerState.snapshot(tabId),
    borrow: borrowGate.status(tabId),
    evidence: moved && moved.evidence ? moved.evidence : null,
  };
}
