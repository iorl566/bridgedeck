// src/tabs.js —— tab / window / agent 窗口相关操作
import { bridgeError, mapChromeError } from './errors.js';
import { readSettings } from './settings.js';
import { withTimeout } from './timeout.js';
import { log } from './log.js';
import { execPage } from './inject.js';
import { armTab } from './debugger.js';
import { showTakeover, hideTakeover } from './takeover.js';
import { restrictedUrlReason } from './lib/page-policy.js';
import { closeOverlay, openOverlay } from './overlay-state.js';
import { expectedTabMoves } from './session-manager/tab-moves.js';
import { clearActionNotification, notifyActionRequest } from './action-notifications.js';
import { borrowBanner, borrowToast, helpOverlayFunc } from './overlay-ui.js';
import { overlayTexts } from './overlay-texts.js';
import { OVERLAY_THEME } from './overlay-theme.js';

const AGENT_WINDOW_KEY = 'bb.agentWindowId';
const DEFAULT_SESSION_AREA = chrome.storage.session;

// Track our own tab moves so unrelated detach/attach events are not mistaken
// for explicit moves. The event handlers are idempotent and only used for
// attribution; the actual move still goes through chrome.tabs.move below.
chrome.tabs.onDetached?.addListener((tabId, info) => expectedTabMoves.onDetached(tabId, info.oldWindowId));
chrome.tabs.onAttached?.addListener((tabId, info) => expectedTabMoves.onAttached(tabId, info.newWindowId));
chrome.tabs.onRemoved?.addListener((tabId) => expectedTabMoves.forget(tabId));

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 取回 tab 对象；不存在时抛 E_NO_TAB。 */
export async function getTab(tabId) {
  try {
    return await withTimeout(chrome.tabs.get(tabId), 5000, 'tabs.get');
  } catch {
    throw bridgeError('E_NO_TAB', `tabId ${tabId} 不存在或已关闭`);
  }
}

export async function getAgentWindowId() {
  return readAgentWindowId();
}

async function readAgentWindowId() {
  try {
    const stored = await DEFAULT_SESSION_AREA.get(AGENT_WINDOW_KEY);
    return stored && stored[AGENT_WINDOW_KEY] ? stored[AGENT_WINDOW_KEY] : null;
  } catch {
    return null;
  }
}

async function writeAgentWindowId(windowId) {
  try {
    await DEFAULT_SESSION_AREA.set({ [AGENT_WINDOW_KEY]: windowId });
  } catch (error) {
    log('保存 agent 窗口 id 失败', error && error.message);
  }
}

// ---------------------------------------------------------------------------
// 每任务一个专属窗口：窗口注册表（session 级隔离）
// ---------------------------------------------------------------------------
const AGENT_WINDOWS_KEY = 'bb.agentWindowIds';

/** 所有仍属于 Agent 的窗口 id（每个 session 一个）。 */
export async function readAgentWindows() {
  try {
    const stored = await DEFAULT_SESSION_AREA.get(AGENT_WINDOWS_KEY);
    const list = stored && stored[AGENT_WINDOWS_KEY];
    return Array.isArray(list) ? list.filter((id) => Number.isInteger(id)) : [];
  } catch {
    return [];
  }
}

async function writeAgentWindows(ids) {
  try {
    await DEFAULT_SESSION_AREA.set({ [AGENT_WINDOWS_KEY]: ids });
  } catch (error) {
    log('保存 agent 窗口列表失败', error && error.message);
  }
}

export async function addAgentWindow(windowId) {
  if (!Number.isInteger(windowId)) return;
  const ids = await readAgentWindows();
  if (!ids.includes(windowId)) await writeAgentWindows([...ids, windowId]);
}

export async function removeAgentWindow(windowId) {
  if (!Number.isInteger(windowId)) return;
  const ids = await readAgentWindows();
  if (ids.includes(windowId)) await writeAgentWindows(ids.filter((id) => id !== windowId));
}

export async function isAgentWindow(windowId) {
  if (!Number.isInteger(windowId)) return false;
  return (await readAgentWindows()).includes(windowId);
}

// 用户手动关掉 Agent 窗口时同步注销，避免注册表累积失效 id。
try {
  chrome.windows.onRemoved?.addListener((windowId) => {
    void removeAgentWindow(windowId);
  });
} catch {
  // 运行时不提供该事件时忽略
}

/** 等待 tab 加载完成；超时返回 null（不抛错）。 */
export function waitForLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      if (timer) clearTimeout(timer);
    };
    const finish = (tab) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(tab || null);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onUpdated = (id, info, tab) => {
      if (id !== tabId) return;
      if (info.status === 'complete') finish(tab);
    };
    const onRemoved = (id) => {
      if (id === tabId) fail(bridgeError('E_NO_TAB', 'tab 在加载过程中被关闭'));
    };
    timer = setTimeout(() => finish(null), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab && tab.status === 'complete') finish(tab);
      })
      .catch(() => fail(bridgeError('E_NO_TAB', `tabId ${tabId} 不存在或已关闭`)));
  });
}

/** 等待 tab 发生一次导航（URL 变化）；超时抛 E_TIMEOUT。 */
export function waitForNavigation(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let sawStart = false;
    let startUrl = '';
    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      if (timer) clearTimeout(timer);
    };
    const finish = (url) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ url });
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onUpdated = (id, info, tab) => {
      if (id !== tabId) return;
      // 导航已经开始（loading 或 pendingUrl）：旧页面即使还是 complete 也不能算到达。
      if (info.status === 'loading' || (tab && tab.pendingUrl)) sawStart = true;
      if (info.url) {
        if (sawStart || info.url !== startUrl) finish(info.url);
      } else if (info.status === 'complete' && tab && tab.url && !tab.pendingUrl && (sawStart || tab.url !== startUrl)) {
        finish(tab.url);
      }
    };
    const onRemoved = (id) => {
      if (id === tabId) fail(bridgeError('E_NO_TAB', 'tab 在等待导航期间被关闭'));
    };
    timer = setTimeout(() => fail(bridgeError('E_TIMEOUT', `等待导航超时（${timeoutMs}ms）`)), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    // 命令到达前页面可能已经完成导航：先读一次状态。只有"没有在途导航"时，
    // 才在短暂宽限后按当前 URL 结束；pendingUrl/loading 说明导航还在路上，必须等后继文档。
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        startUrl = (tab && tab.url) || '';
        log('wait-for-navigation 起始 url', startUrl, 'pending', tab && tab.pendingUrl);
        if (!tab || tab.pendingUrl || tab.status === 'loading') return;
        setTimeout(() => {
          if (settled) return;
          chrome.tabs.get(tabId).then((now) => {
            if (!now || now.pendingUrl || now.status === 'loading') return;
            if (!sawStart) finish(now.url || startUrl);
          }).catch(() => {});
        }, 100);
      })
      .catch(() => fail(bridgeError('E_NO_TAB', `tabId ${tabId} 不存在或已关闭`)));
  });
}

/** 窗口.ensureAgent：复用或新建 agent 窗口，返回其 tab。 */
export async function ensureAgent(params = {}) {
  const noFocus = params.noFocus === true;

  if (params.incognito === true) {
    let allowed = true;
    try {
      allowed = await chrome.extension.isAllowedIncognitoAccess();
    } catch {
      allowed = true;
    }
    if (!allowed) {
      throw bridgeError(
        'E_INCOGNITO_UNAVAILABLE',
        '扩展未获准在无痕/InPrivate 模式运行：请在扩展详情页打开「允许在 InPrivate 模式中运行」后重试',
      );
    }
    const created = await withTimeout(
      chrome.windows.create({ url: 'about:blank', type: 'normal', incognito: true, focused: !noFocus }),
      10000,
      'windows.create(incognito)',
    ).catch((error) => {
      const message = String((error && error.message) || error);
      if (/incognito|inprivate/i.test(message)) {
        throw bridgeError('E_INCOGNITO_UNAVAILABLE', '浏览器拒绝创建无痕窗口：' + message);
      }
      throw mapChromeError(error, '创建无痕窗口失败');
    });
    const incognitoTabs = await chrome.tabs.query({ windowId: created.id });
    const incognitoTab = incognitoTabs[0];
    if (!incognitoTab) throw bridgeError('E_INTERNAL', '无痕窗口里没有标签页');
    markSelfCreatedWindow(created.id);
    markSelfCreated(incognitoTab.id);
    return {
      ok: true,
      tabId: incognitoTab.id,
      windowId: created.id,
      url: incognitoTab.url || 'about:blank',
      title: incognitoTab.title || '',
      incognito: true,
    };
  }
  let previousFocused = null;
  try {
    previousFocused = await chrome.windows.getLastFocused();
  } catch {
    previousFocused = null;
  }

  let windowId = await readAgentWindowId();
  let win = null;
  if (windowId) {
    try {
      win = await chrome.windows.get(windowId);
    } catch {
      win = null;
    }
  }
  let tabs = win ? await chrome.tabs.query({ windowId: win.id }) : [];
  let windowWasCreated = false;
  if (!win || win.type !== 'normal' || tabs.length === 0) {
    windowWasCreated = true;
    if (win) log(`agent 窗口 ${win.id} 不可复用（type=${win.type} tabs=${tabs.length}），新建`);
    const created = await withTimeout(
      chrome.windows.create({ url: 'about:blank', type: 'normal', focused: !noFocus }),
      10000,
      'windows.create',
    ).catch((error) => {
      throw mapChromeError(error, '创建 agent 窗口失败');
    });
    win = created;
    windowId = created.id;
    markSelfCreatedWindow(windowId);
    const createdTab = Array.isArray(created.tabs) ? created.tabs[0] : null;
    if (createdTab) markSelfCreated(createdTab.id);
    await writeAgentWindowId(windowId);
    tabs = await chrome.tabs.query({ windowId });
    if (!createdTab) markSelfCreated(tabs[0] && tabs[0].id);
    log(`新建 agent 窗口 windowId=${windowId} tabId=${tabs[0] && tabs[0].id}`);
    if (noFocus && previousFocused && previousFocused.id !== windowId) {
      try {
        await withTimeout(chrome.windows.update(previousFocused.id, { focused: true }), 3000, 'windows.update');
      } catch {
        // 原窗口可能已关闭，忽略
      }
    }
  }

  // 一个 session 一个自己的标签页：session.start 传 newTab，避免两个会话共用同一 tab
  //（否则停掉其中一个会把另一个的页面也关掉）。刚建好的窗口直接用它自带的空 tab，
  // 不再额外新开一个，避免每建一次窗口就留下一个永久 about:blank。
  let sessionTab = null;
  if (params.newTab === true && !windowWasCreated) {
    try {
      const created = await chrome.tabs.create({ windowId, url: 'about:blank', active: !noFocus });
      if (created && Number.isInteger(created.id)) {
        markSelfCreated(created.id);
        sessionTab = created;
      }
    } catch (error) {
      throw mapChromeError(error, '为新会话创建标签页失败');
    }
  }

  const tab = sessionTab || tabs.find((item) => item.active) || tabs[0];
  if (!tab) throw bridgeError('E_INTERNAL', 'agent 窗口里没有可用 tab');
  await showTakeover(tab.id, { name: 'BridgeDeck' });
  if (!noFocus) {
    try {
      await chrome.windows.update(windowId, { focused: true });
      await chrome.tabs.update(tab.id, { active: true });
    } catch {
      // 忽略置前失败，不影响后续命令
    }
  }
  groupAgentWindowTabs(windowId).catch(() => {});
  return { tabId: tab.id, windowId };
}

/** 把 Agent 窗口的标签页收进一个同名标签组；权限/API 不可用时静默跳过。 */
export async function groupAgentWindowTabs(windowId) {
  if (!Number.isInteger(windowId)) return null;
  if (!chrome.tabs || typeof chrome.tabs.group !== 'function' || !chrome.tabGroups) return null;
  try {
    if (!(await isAgentWindow(windowId))) return null;
    const tabs = await chrome.tabs.query({ windowId });
    const tabIds = tabs.map((tab) => tab.id).filter((id) => Number.isInteger(id));
    if (!tabIds.length) return null;
    const groups = await chrome.tabGroups.query({ windowId });
    const existing = groups.find((group) => group.title === 'BridgeDeck');
    const groupId = existing
      ? await chrome.tabs.group({ groupId: existing.id, tabIds })
      : await chrome.tabs.group({ tabIds, createProperties: { windowId } });
    if (!existing) await chrome.tabGroups.update(groupId, { title: 'BridgeDeck', color: 'blue' }).catch(() => {});
    return groupId;
  } catch {
    return null;
  }
}

/** 新建一个专属 Agent 窗口（每个 session 一个），返回它的 tab。 */
export async function newAgentWindow(params = {}) {
  const noFocus = params.noFocus === true;
  let previousFocused = null;
  if (noFocus) {
    try { previousFocused = await chrome.windows.getLastFocused(); } catch { previousFocused = null; }
  }
  const incognito = params.incognito === true;
  if (incognito) {
    let allowed = true;
    try { allowed = await chrome.extension.isAllowedIncognitoAccess(); } catch { allowed = true; }
    if (!allowed) {
      throw bridgeError('E_INCOGNITO_UNAVAILABLE', '扩展未获准在无痕/InPrivate 模式运行：请在扩展详情页打开「允许在 InPrivate 模式中运行」后重试');
    }
  }
  let created;
  try {
    created = await withTimeout(
      chrome.windows.create({ url: 'about:blank', type: 'normal', incognito, focused: !noFocus }),
      10000,
      'windows.create',
    );
  } catch (error) {
    const message = String((error && error.message) || error);
    if (incognito && /incognito|inprivate/i.test(message)) {
      throw bridgeError('E_INCOGNITO_UNAVAILABLE', '浏览器拒绝创建无痕窗口：' + message);
    }
    throw mapChromeError(error, '创建 Agent 窗口失败');
  }
  if (!created || !Number.isInteger(created.id)) throw bridgeError('E_INTERNAL', '浏览器没有返回 Agent 窗口 id');
  const windowId = created.id;
  markSelfCreatedWindow(windowId);
  await Promise.all([addAgentWindow(windowId), writeAgentWindowId(windowId)]);
  const createdTab = Array.isArray(created.tabs) ? created.tabs[0] : null;
  let tab = createdTab;
  if (!tab) {
    const tabs = await chrome.tabs.query({ windowId });
    tab = tabs[0];
  }
  if (!tab || !Number.isInteger(tab.id)) throw bridgeError('E_INTERNAL', 'Agent 窗口里没有标签页');
  markSelfCreated(tab.id);
  // 会话标签页预挂 CDP + 焦点仿真：后续 evaluate 走 Runtime.evaluate、可信输入不用切前台。
  // 不阻塞 session.start；预挂失败时动作路径自动回退到注入式/切前台。
  armTab(tab.id).catch((error) => log('会话 CDP 预挂载失败：' + ((error && error.message) || error)));
  // 浮层是可见性提示，不阻塞会话返回；注入失败不影响后续动作。
  showTakeover(tab.id, { name: 'BridgeDeck' }).catch(() => {});
  if (noFocus && previousFocused && previousFocused.id !== windowId) {
    // 后台建窗不需要等焦点回到原窗口：失败/延迟不影响会话。
    withTimeout(chrome.windows.update(previousFocused.id, { focused: true }), 3000, 'windows.update').catch(() => {});
  }
  groupAgentWindowTabs(windowId).catch(() => {});
  return { tabId: tab.id, windowId, incognito: created.incognito === true };
}

/** window.close：关闭指定窗口（session 结束时的清理路径）。 */
export async function windowClose(params = {}) {
  const windowId = Number(params.windowId);
  if (!Number.isInteger(windowId)) throw bridgeError('E_BAD_ARG', 'window.close 需要 windowId');
  try {
    await chrome.windows.remove(windowId);
  } catch (error) {
    throw mapChromeError(error, `关闭 window ${windowId} 失败`);
  }
  await removeAgentWindow(windowId);
  return { ok: true, windowId };
}
export async function refreshTakeoverForTab(tabId) {
  try {
    const agentWindows = await readAgentWindows();
    const controlled = await readControlledTabs();
    let tab = null;
    try { tab = await chrome.tabs.get(tabId); } catch { tab = null; }
    if (!tab) return;
    if (!controlled.includes(tabId) && !agentWindows.includes(tab.windowId)) return;
    await showTakeover(tabId, { name: 'BridgeDeck' });
  } catch {
    // 忽略
  }
}

/** tab.list：scope=agent 只看 agent 窗口，user 看其余 tab，all 全给。 */
export async function tabList(params = {}) {
  const scope = params.scope === 'user' ? 'user' : (params.scope === 'all' ? 'all' : 'agent');
  const agentWindows = new Set(await readAgentWindows());
  const controlled = await readControlledTabs();
  const tabs = await chrome.tabs.query({});
  const filtered = tabs.filter((tab) => {
    const isAgent = agentWindows.has(tab.windowId);
    if (scope === 'all') return true;
    return scope === 'agent' ? isAgent : !isAgent;
  });
  return {
    tabs: filtered.map((tab) => ({
      tabId: tab.id,
      windowId: tab.windowId,
      url: tab.url || tab.pendingUrl || '',
      title: tab.title || '',
      active: tab.active === true,
      owned: agentWindows.has(tab.windowId) ? 'agent' : 'user',
      controlled: controlled.includes(tab.id),
    })),
  };
}

/** tab.new：优先在 agent 窗口里开新 tab。 */
export async function tabNew(params = {}) {
  const url = typeof params.url === 'string' && params.url ? params.url : 'about:blank';
  const blocked = restrictedUrlReason(url);
  if (blocked) throw bridgeError('E_FORBIDDEN', '新建标签页目标受限（' + blocked + '）：BridgeDeck 不打开浏览器内部或扩展页面');
  const noFocus = params.noFocus === true;
  if (params.newWindow === true) {
    let win;
    try {
      win = await chrome.windows.create({ url, focused: !noFocus });
    } catch (error) {
      throw mapChromeError(error, '新建窗口失败');
    }
    const tab = win && Array.isArray(win.tabs) ? win.tabs[0] : null;
    if (!tab) throw bridgeError('E_BROWSER', '新建窗口后没有标签页');
    markSelfCreatedWindow(win.id);
    markSelfCreated(tab.id);
    return { tabId: tab.id, windowId: win.id, newWindow: true };
  }
  const agentWindows = await readAgentWindows();
  const targetWindowId = Number.isInteger(params.windowId) && agentWindows.includes(params.windowId)
    ? params.windowId
    : (agentWindows.length ? agentWindows[agentWindows.length - 1] : await readAgentWindowId());
  const createProps = { url, active: !noFocus };
  if (targetWindowId != null) {
    try {
      await chrome.windows.get(targetWindowId);
      createProps.windowId = targetWindowId;
    } catch {
      await removeAgentWindow(targetWindowId);
      await writeAgentWindowId(null);
    }
  }
  let tab;
  try {
    tab = await chrome.tabs.create(createProps);
  } catch (error) {
    throw mapChromeError(error, '新建 tab 失败');
  }
  markSelfCreated(tab.id);
  if (Number.isInteger(tab.windowId)) groupAgentWindowTabs(tab.windowId).catch(() => {});
  return { tabId: tab.id, windowId: tab.windowId };
}

/** tab.close */
export async function tabClose(params = {}) {
  const tabId = params.tabId;
  if (!Number.isInteger(tabId)) throw bridgeError('E_BAD_ARG', 'tab.close 需要 tabId');
  try {
    await chrome.tabs.remove(tabId);
  } catch (error) {
    throw mapChromeError(error, `关闭 tab ${tabId} 失败`);
  }
  return { ok: true };
}

/** tab.select */
export async function tabSelect(params = {}) {
  const tabId = params.tabId;
  if (!Number.isInteger(tabId)) throw bridgeError('E_BAD_ARG', 'tab.select 需要 tabId');
  const tab = await getTab(tabId);
  try {
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch (error) {
    throw mapChromeError(error, `切换 tab ${tabId} 失败`);
  }
  return { ok: true };
}

/** tab.move */
export async function tabMove(params = {}) {
  const tabId = params.tabId;
  const windowId = params.windowId;
  if (!Number.isInteger(tabId) || !Number.isInteger(windowId)) {
    throw bridgeError('E_BAD_ARG', 'tab.move 需要 tabId 与 windowId');
  }
  try {
    const current = await chrome.tabs.get(tabId);
    await expectedTabMoves.run(
      { tabId, fromWindowId: current.windowId, toWindowId: windowId },
      () => chrome.tabs.move(tabId, { windowId, index: Number.isInteger(params.index) ? params.index : -1 }),
    );
  } catch (error) {
    throw mapChromeError(error, `移动 tab ${tabId} 到 window ${windowId} 失败`);
  }
  return { ok: true, tabId, windowId };
}

/** window.list */
export async function windowList() {
  const windows = await chrome.windows.getAll({ populate: true });
  return {
    windows: windows.map((win) => ({
      windowId: win.id,
      focused: win.focused === true,
      incognito: win.incognito === true,
      type: win.type || 'normal',
      tabs: (win.tabs || []).map((tab) => ({
        tabId: tab.id,
        active: tab.active === true,
        url: tab.url || '',
        title: tab.title || '',
      })),
    })),
  };
}

/** window.focus */
export async function windowFocus(params = {}) {
  const windowId = params.windowId;
  if (!Number.isInteger(windowId)) throw bridgeError('E_BAD_ARG', 'window.focus 需要 windowId');
  try {
    await chrome.windows.update(windowId, { focused: true });
  } catch (error) {
    throw mapChromeError(error, `聚焦 window ${windowId} 失败`);
  }
  return { ok: true, windowId };
}

/** window.resize */
export async function windowResize(params = {}) {
  const tabId = params.tabId;
  if (!Number.isInteger(tabId)) throw bridgeError('E_BAD_ARG', 'window.resize 需要 tabId');
  const width = Number(params.width);
  const height = Number(params.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw bridgeError('E_BAD_ARG', 'window.resize 需要正的 width/height');
  }
  const tab = await getTab(tabId);
  try {
    await chrome.windows.update(tab.windowId, {
      width: Math.round(width),
      height: Math.round(height),
    });
  } catch (error) {
    throw mapChromeError(error, '调整窗口大小失败');
  }
  return { ok: true };
}
// ---------------------------------------------------------------------------
// v0.2：受控标签页登记 / 借用 / 归还 / 人工协助
// ---------------------------------------------------------------------------

const CONTROLLED_KEY = 'bb.controlledTabs';
const BORROW_TIMEOUT_MS = 60000;

/** 扩展自己创建的标签页（tab.new / agent 窗口），页面守卫不能把它当外部标签页移走。 */
const selfCreated = new Map();

export function markSelfCreated(tabId) {
  if (!Number.isInteger(tabId)) return;
  const now = Date.now();
  selfCreated.set(tabId, now);
  for (const entry of selfCreated) {
    if (now - entry[1] > 15000) selfCreated.delete(entry[0]);
  }
}

export function consumeSelfCreated(tabId) {
  const ts = selfCreated.get(tabId);
  if (ts == null) return false;
  selfCreated.delete(tabId);
  return Date.now() - ts < 15000;
}

/**
 * 扩展自己新建的窗口（Agent Window）：页面守卫必须放行。
 *
 * 只靠 tabId 标记会输给 onCreated 的时序：窗口刚建好、tab 还没标上时，
 * 页面守卫可能已经按「外部标签页」把它移回用户窗口，结果 Agent 反而跑在用户页面里。
 * 窗口维度在建窗返回时同步登记，覆盖这个竞态。
 */
const selfCreatedWindows = new Map();

export function markSelfCreatedWindow(windowId) {
  if (!Number.isInteger(windowId)) return;
  const now = Date.now();
  selfCreatedWindows.set(windowId, now);
  for (const entry of selfCreatedWindows) {
    if (now - entry[1] > 15000) selfCreatedWindows.delete(entry[0]);
  }
}

export function isSelfCreatedWindow(windowId) {
  if (!Number.isInteger(windowId)) return false;
  const ts = selfCreatedWindows.get(windowId);
  if (ts == null) return false;
  if (Date.now() - ts > 15000) { selfCreatedWindows.delete(windowId); return false; }
  return true;
}

/** 借用确认与人工协助的等待者：requestId -> { resolve, timer } */
const humanWaiters = new Map();

/** 内容脚本回传用户决定（borrow 允许/拒绝、help 完成/跳过）。 */
export function resolveHumanDecision(message) {
  const requestId = message && message.requestId;
  if (!requestId) return false;
  const waiter = humanWaiters.get(requestId);
  if (!waiter) return false;
  humanWaiters.delete(requestId);
  clearTimeout(waiter.timer);
  waiter.resolve(message);
  return true;
}

export async function readControlledTabs() {
  try {
    const stored = await withTimeout(chrome.storage.session.get(CONTROLLED_KEY), 3000, 'session tabs read');
    const list = stored ? stored[CONTROLLED_KEY] : null;
    return Array.isArray(list) ? list.filter((id) => Number.isInteger(id)) : [];
  } catch {
    return [];
  }
}

async function writeControlledTabs(list) {
  const unique = [...new Set(list.filter((id) => Number.isInteger(id)))];
  try {
    await withTimeout(chrome.storage.session.set({ [CONTROLLED_KEY]: unique }), 3000, 'session tabs write');
  } catch (error) {
    log('保存受控标签页失败', error && error.message);
  }
  return unique;
}

export async function isControlledTab(tabId) {
  const list = await readControlledTabs();
  return list.includes(tabId);
}

/** 将 Agent 自己打开的新标签页登记为受控，避免自动跟随时再次弹借用确认。 */
export async function markControlledTab(tabId) {
  if (!Number.isInteger(tabId)) return;
  const list = await readControlledTabs();
  if (!list.includes(tabId)) await writeControlledTabs([...list, tabId]);
}

async function clearBorrowToast(tabId, requestId) {
  if (!tabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (rid) => {
        const host = document.getElementById('__bb_borrow_toast_host');
        if (!host) return;
        for (const el of Array.from(host.querySelectorAll('[data-request]'))) {
          if (el.dataset.request === rid) el.remove();
        }
        if (!host.children.length) host.remove();
      },
      args: [requestId],
    });
  } catch {
    // 标签页可能已关闭。
  }
}

async function readUiLang() {
  try {
    const stored = await chrome.storage.local.get('bb.uiLang');
    const value = stored && stored['bb.uiLang']; return value || 'zh';
  } catch {
    return 'zh';
  }
}


async function injectBanner(tabId, func, args) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'ISOLATED', func, args });
    return true;
  } catch (error) {
    throw mapChromeError(error, '注入确认条失败（受限页面无法借用）');
  }
}

function waitHumanDecision(requestId, timeoutMs, onTimeout) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (humanWaiters.delete(requestId)) resolve(onTimeout());
    }, timeoutMs);
    humanWaiters.set(requestId, { resolve, timer });
  });
}

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


// ── 借用确认的全局请求列表 ──────────────────────────────────────
// 每个请求记住自己的目标窗口和当前展示面（模态/Toast）。标签切换时，
// 由 rehomeBorrowUi 按当前活动标签重新分配，避免 Toast 留在已经切走的标签里。
const borrowUiRequests = new Map();
let borrowRehomeChain = Promise.resolve();

async function injectBorrowModal(req, { focus = false } = {}) {
  if (req.surface === 'modal' && req.surfaceTabId === req.targetTabId) return;
  await clearBorrowUiSurface(req);
  if (focus) {
    try { await withTimeout(chrome.windows.update(req.windowId, { focused: true }), 3000, 'windows.update'); } catch { /* 忽略 */ }
  }
  openOverlay(req.targetTabId, 'borrow', { priority: 100, exclusive: true });
  await injectBanner(req.targetTabId, borrowBanner, [req.requestId, req.title, req.timeoutMs, req.lang, OVERLAY_THEME, overlayTexts(req.lang)]);
  req.surface = 'modal';
  req.surfaceTabId = req.targetTabId;
}

async function injectBorrowToast(req, toastTabId) {
  if (req.surface === 'toast' && req.surfaceTabId === toastTabId) return;
  await clearBorrowUiSurface(req);
  await injectBanner(toastTabId, borrowToast, [req.requestId, req.title, req.timeoutMs, req.lang, OVERLAY_THEME]);
  openOverlay(toastTabId, 'borrow-toast', { priority: 100 });
  req.surface = 'toast';
  req.surfaceTabId = toastTabId;
}

async function clearBorrowUiSurface(req) {
  if (!req || !req.surface) return;
  const surface = req.surface;
  const surfaceTabId = req.surfaceTabId;
  req.surface = null;
  req.surfaceTabId = null;
  if (surface === 'modal') {
    await clearBorrowBanner(req.targetTabId).catch(() => {});
    closeOverlay(req.targetTabId, 'borrow');
  } else if (surface === 'toast') {
    await clearBorrowToast(surfaceTabId, req.requestId).catch(() => {});
    closeOverlay(surfaceTabId, 'borrow-toast');
  }
}

async function releaseBorrowUi(requestId) {
  const req = borrowUiRequests.get(requestId);
  if (!req) return;
  await clearBorrowUiSurface(req);
  borrowUiRequests.delete(requestId);
}

async function rehomeBorrowUiNow(windowId) {
  const reqs = [...borrowUiRequests.values()].filter((req) => req.windowId === Number(windowId));
  if (!reqs.length) return;
  let activeTab = null;
  try {
    const activeTabs = await chrome.tabs.query({ active: true, windowId: Number(windowId) });
    activeTab = (activeTabs || [])[0] || null;
  } catch { /* 窗口已关闭 */ }
  if (!activeTab || !Number.isInteger(Number(activeTab.id))) return;
  const activeId = Number(activeTab.id);
  for (const req of reqs) {
    try {
      if (req.targetTabId === activeId) {
        await injectBorrowModal(req, { focus: false });
      } else if (req.surface === 'modal' || (req.surface === 'toast' && req.surfaceTabId !== activeId)) {
        await injectBorrowToast(req, activeId);
      }
    } catch (error) {
      log('借用确认重新分配失败 tab=' + req.targetTabId + '：' + ((error && error.message) || error));
    }
  }
}

export function rehomeBorrowUi(windowId) {
  borrowRehomeChain = borrowRehomeChain
    .then(() => rehomeBorrowUiNow(windowId))
    .catch((error) => log('借用确认重新分配异常：' + ((error && error.message) || error)));
  return borrowRehomeChain;
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
        if (answer.decision === 'timeout') {
          throw bridgeError('E_BORROW_TIMEOUT', '借用确认 ' + BORROW_TIMEOUT_MS + 'ms 内没有响应');
        }
        if (answer.allow !== true) throw bridgeError('E_BORROW_DENIED', '用户拒绝了借用请求');
      } finally {
        clearActionNotification('borrow', requestId);
        await releaseBorrowUi(requestId);
      }
    }
    stage.value = 'takeover';
    controlled.push(tabId);
    // 浮层只是提示，不能阻塞借用本身；脚本注入异常/挂起时按无浮层继续。
    await withTimeout(showTakeover(tabId, { name: settings.instanceLabel || 'BridgeDeck', subtitle: 'Agent 已接管该标签页；你随时可以收回控制。' }), 5000, 'borrow takeover').catch((error) => log('借用浮层注入失败：' + ((error && error.message) || error)));
    await writeControlledTabs(controlled);
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

async function clearBorrowBanner(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: 'ISOLATED',
      func: () => {
        for (const id of ['__bb_borrow_modal', '__bb_human_banner']) {
          const node = document.getElementById(id);
          if (node) node.remove();
        }
      },
    });
  } catch { /* 页面可能已关闭 */ }
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
  let windowId = null;
  try {
    const tab = await chrome.tabs.get(tabId);
    windowId = tab.windowId;
  } catch {
    windowId = null;
  }
  log('归还标签页 tab=' + tabId + (windowId != null ? ' window=' + windowId : '（已关闭）'));
  return { ok: true, windowId: windowId };
}

/** request-help：在页面上放一条协助条，等用户点按钮。 */
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
    await showTakeover(tabId, {}).catch(() => {});
    return { action: answer.action === 'done' ? 'done' : answer.action === 'skip' ? 'skip' : 'timeout', note: typeof answer.note === 'string' ? answer.note : '' };
  } finally {
    closeOverlay(tabId, 'help');
  }
}

/** control-hint：旧的深色胶囊提示已由 takeover.js 的浮层取代，这里只清理历史残留。 */
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
