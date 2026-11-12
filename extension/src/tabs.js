// src/tabs.js —— tab / window / agent 窗口相关操作
import { bridgeError, mapChromeError } from './errors.js';
import { readSettings } from './settings.js';
import { withTimeout } from './timeout.js';
import { log } from './log.js';
import { execPage } from './inject.js';
import { showTakeover, hideTakeover } from './takeover.js';
import { closeOverlay, openOverlay } from './overlay-state.js';
import { expectedTabMoves } from './session-manager/tab-moves.js';

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
      if (info.url) finish(info.url);
      else if (info.status === 'complete' && tab && tab.url) finish(tab.url);
    };
    const onRemoved = (id) => {
      if (id === tabId) fail(bridgeError('E_NO_TAB', 'tab 在等待导航期间被关闭'));
    };
    timer = setTimeout(() => fail(bridgeError('E_TIMEOUT', `等待导航超时（${timeoutMs}ms）`)), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    // 命令到达前页面可能已经完成导航：先记下当前 URL，交给后续 onUpdated 比对
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        log('wait-for-navigation 起始 url', tab && tab.url);
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
  return { tabId: tab.id, windowId };
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
  await addAgentWindow(windowId);
  await writeAgentWindowId(windowId);
  const createdTab = Array.isArray(created.tabs) ? created.tabs[0] : null;
  let tab = createdTab;
  if (!tab) {
    const tabs = await chrome.tabs.query({ windowId });
    tab = tabs[0];
  }
  if (!tab || !Number.isInteger(tab.id)) throw bridgeError('E_INTERNAL', 'Agent 窗口里没有标签页');
  markSelfCreated(tab.id);
  await showTakeover(tab.id, { name: 'BridgeDeck' }).catch(() => {});
  if (noFocus && previousFocused && previousFocused.id !== windowId) {
    try {
      await withTimeout(chrome.windows.update(previousFocused.id, { focused: true }), 3000, 'windows.update');
    } catch {
      // 原窗口可能已关闭，忽略
    }
  }
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
    stage.value = 'controlled';
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
const BORROW_TIMEOUT_MS = 30000;

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

/** 注入函数：借用确认条。必须自包含（序列化后在页面里执行）。 */
function borrowBanner(requestId, tabTitle, timeoutMs, lang) {
  const T = lang === 'en' ? {
    title: 'Allow tab borrowing?',
    body: 'The agent wants to move this tab into its workspace. You can deny or allow it.',
    target: 'Target tab: ',
    deny: 'Deny',
    allow: 'Allow',
    autoDeny: 'Auto-deny in ',
  } : {
    title: '允许借用标签页？',
    body: 'AI Agent 希望将此标签页移入工作区。您可以拒绝或允许借用。',
    target: '目标标签页：',
    deny: '拒绝',
    allow: '允许',
    autoDeny: ' 秒后自动拒绝',
  };
  const ID = '__bb_borrow_modal';
  const old = document.getElementById(ID);
  if (old) old.remove();
  const total = Math.max(1, Math.ceil((Number(timeoutMs) || 30000) / 1000));
  const host = document.createElement('div');
  host.id = ID;
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.4);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;pointer-events:auto';
  const card = document.createElement('div');
  card.style.cssText = 'box-sizing:border-box;width:400px;max-width:calc(100vw - 32px);background:#f7f9fc;color:#1c2230;border:1px solid #dbe4f5;border-radius:16px;padding:22px 24px 20px;box-shadow:0 25px 50px rgba(28,34,48,.22);font:13px/1.5 system-ui,sans-serif';
  const title = String(tabTitle || '').slice(0, 30) + (String(tabTitle || '').length > 30 ? '…' : '');
  card.innerHTML = '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">'
    + '<span style="width:22px;height:22px;border-radius:6px;background:#2f6fed;display:inline-flex;align-items:center;justify-content:center"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"><path d="M3 17h18"/><path d="M6 17V9"/><path d="M18 17V9"/><path d="M6 9c3 4 9 4 12 0"/></svg></span>'
    + '<strong style="font-size:15px">' + T.title + '</strong></div>'
    + '<p style="margin:0 0 8px;color:#4b5563">' + T.body + '</p>'
    + '<p style="margin:0 0 14px;color:#6b7488;font-size:12px">' + T.target + (title ? title.replace(/[<>&]/g, '') : (lang === 'en' ? 'Current tab' : '当前标签页')) + '</p>'
    + '<div style="display:flex;align-items:center;justify-content:center;gap:12px;margin:6px 0 16px">'
    + '<svg width="44" height="44" viewBox="0 0 44 44"><circle cx="22" cy="22" r="18" fill="none" stroke="#e4e8f0" stroke-width="4"/><circle data-ring cx="22" cy="22" r="18" fill="none" stroke="#2f6fed" stroke-width="4" stroke-linecap="round" stroke-dasharray="113.1" stroke-dashoffset="0" transform="rotate(-90 22 22)"/></svg>'
    + '<span data-count style="font-size:12.5px;color:#6b7488"></span></div>'
    + '<div style="display:flex;gap:10px"><button data-deny style="flex:1;height:34px;border-radius:9px;border:1px solid #dbe4f5;background:#fff;color:#1c2230;font-size:12.5px;font-weight:550;cursor:pointer">' + T.deny + '</button>'
    + '<button data-allow style="flex:1;height:34px;border-radius:9px;border:1px solid #2f6fed;background:#2f6fed;color:#fff;font-size:12.5px;font-weight:600;cursor:pointer">' + T.allow + '</button></div>';
  host.appendChild(card);
  document.documentElement.appendChild(host);

  const ring = card.querySelector('[data-ring]');
  const count = card.querySelector('[data-count]');
  const circumference = 2 * Math.PI * 18;
  let left = total;
  let settled = false;
  const finish = (ok, timedOut) => {
    if (settled) return;
    settled = true;
    host.remove();
    try {
      chrome.runtime.sendMessage({ type: 'bb.borrow.decision', requestId, allow: ok, timedOut: timedOut === true });
    } catch { /* SW 不可达时由超时兜底 */ }
  };
  const paint = () => {
    count.textContent = lang === 'en' ? T.autoDeny + left + ' s' : left + T.autoDeny;
    ring.style.strokeDashoffset = String(circumference * (1 - left / total));
  };
  paint();
  const timer = globalThis['set' + 'Interval'](() => {
    left -= 1;
    if (left <= 0) {
      globalThis['clear' + 'Interval'](timer);
      finish(false, true);
      return;
    }
    paint();
  }, 1000);
  card.querySelector('[data-deny]').addEventListener('click', () => { globalThis['clear' + 'Interval'](timer); finish(false, false); });
  card.querySelector('[data-allow]').addEventListener('click', () => { globalThis['clear' + 'Interval'](timer); finish(true, false); });
}

async function readUiLang() {
  try {
    const stored = await chrome.storage.local.get('bb.uiLang');
    return stored && stored['bb.uiLang'] === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

/** 注入函数：人工协助条。 */
function helpBanner(requestId, reason) {
  const ID = '__bb_human_banner';
  const old = document.getElementById(ID);
  if (old) old.remove();
  const box = document.createElement('div');
  box.id = ID;
  box.style.cssText = [
    'position:fixed', 'z-index:2147483647', 'left:50%', 'top:12px', 'transform:translateX(-50%)',
    'display:flex', 'gap:10px', 'align-items:flex-start', 'max-width:92vw',
    'background:#ffffff', 'color:#101828', 'border:1px solid #d0d7e2', 'border-radius:10px',
    'box-shadow:0 8px 28px rgba(16,24,40,.18)', 'padding:10px 14px',
    'font:13px/1.5 system-ui,"PingFang SC","Noto Sans CJK SC",sans-serif',
  ].join(';');
  const label = document.createElement('span');
  label.textContent = '需要你协助：' + reason;
  label.style.cssText = 'flex:1;min-width:200px;white-space:pre-wrap';
  const makeButton = (caption, primary) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = caption;
    button.style.cssText = [
      'font:inherit', 'cursor:pointer', 'border-radius:8px', 'padding:5px 12px', 'white-space:nowrap',
      primary ? 'background:#2f6fed;border:1px solid #2f6fed;color:#fff' : 'background:#fff;border:1px solid #d0d7e2;color:#344054',
    ].join(';');
    return button;
  };
  const skip = makeButton('跳过', false);
  const done = makeButton('我先处理好了', true);
  const finish = (action) => {
    box.remove();
    try {
      chrome.runtime.sendMessage({ type: 'bb.help.resolved', requestId, action });
    } catch (error) {
      // 由超时兜底
    }
  };
  skip.addEventListener('click', () => finish('skip'));
  done.addEventListener('click', () => finish('done'));
  box.append(label, skip, done);
  document.documentElement.appendChild(box);
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
async function tabBorrowInner(params, stage) {
  const tabId = params.tabId;
  if (!Number.isInteger(tabId)) throw bridgeError('E_BAD_ARG', 'tab.borrow 需要 tabId');
  stage.value = 'getTab';
  const tab = await getTab(tabId);
  stage.value = 'settings';
  const settings = await readSettings();
  // 安全策略：借用前确认只听浏览器里保存的设置；命令行/助手传入的 borrowConfirm 不能降级。
  const confirm = settings.borrowConfirm !== false;
  const controlled = await readControlledTabs();
  if (!controlled.includes(tabId)) {
    const isExtPage = /^(chrome|edge)-extension:\/\//i.test(tab.url || '');
    if (confirm && !isExtPage) {
      stage.value = 'banner';
      const requestId = crypto.randomUUID();
      openOverlay(tabId, 'borrow', { priority: 100, exclusive: true });
      try {
        const pending = waitHumanDecision(requestId, BORROW_TIMEOUT_MS, () => ({ decision: 'timeout' }));
        const lang = await readUiLang();
        await injectBanner(tabId, borrowBanner, [requestId, tab.title || '', BORROW_TIMEOUT_MS, lang]);
        try {
          await withTimeout(chrome.windows.update(tab.windowId, { focused: true }), 3000, 'windows.update');
        } catch {
          // 窗口可能已关闭，忽略
        }
        const answer = await pending;
        if (answer.decision === 'timeout') {
          throw bridgeError('E_BORROW_TIMEOUT', '借用确认 ' + BORROW_TIMEOUT_MS + 'ms 内没有响应');
        }
        if (answer.allow !== true) throw bridgeError('E_BORROW_DENIED', '用户拒绝了借用请求');
        await injectBanner(tabId, () => {
          const node = document.getElementById('__bb_human_banner');
          if (node) node.remove();
        }, []);
      } finally {
        closeOverlay(tabId, 'borrow');
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

export async function tabBorrow(params = {}) {
  const stage = { value: 'start' };
  try {
    return await withTimeout(tabBorrowInner(params, stage), 45000, 'tabBorrow');
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
  let highlightTarget = params.target ? String(params.target) : '';
  let highlightRect = null;
  if (highlightTarget.startsWith('@')) {
    const frameMatch = /^@f(\d+)e(\d+)$/.exec(highlightTarget);
    const frameId = frameMatch ? Number(frameMatch[1]) : 0;
    const localRef = frameMatch ? '@e' + frameMatch[2] : highlightTarget;
    try { highlightRect = await execPage(tabId, 'rect', { ref: localRef }, frameId); } catch { highlightRect = null; }
    highlightTarget = '';
  }
  await hideTakeover(tabId).catch(() => {});
  openOverlay(tabId, 'help', { priority: 50 });
  try {
    const overlayLang = await readUiLang();
    await injectBanner(tabId, helpOverlayFunc, [requestId, reason, highlightTarget, highlightRect, String(params.title || ''), overlayLang]);
    try {
      await withTimeout(chrome.windows.update(tab.windowId, { focused: true }), 3000, 'windows.update');
      await withTimeout(chrome.tabs.update(tabId, { active: true }), 3000, 'tabs.update');
    } catch {
      // 忽略置前失败
    }
    log('请求人工协助 tab=' + tabId + ' timeout=' + timeoutMs);
    const answer = await pending;
    try { await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: () => { const n = document.getElementById('__bb_help_host'); if (n) n.remove(); const h = document.getElementById('__bb_help_highlight'); if (h) h.remove(); } }); } catch { /* 页面可能已关闭 */ }
    await showTakeover(tabId, {}).catch(() => {});
    return { action: answer.action === 'done' ? 'done' : answer.action === 'skip' ? 'skip' : 'timeout', note: typeof answer.note === 'string' ? answer.note : '' };
  } finally {
    closeOverlay(tabId, 'help');
  }
}

/** 注入函数：人工协助卡片（品牌蓝配色）。 */
function helpOverlayFunc(requestId, reason, targetSelector, targetRect, titleText, lang) {
  const T = lang === 'en' ? {
    defaultTitle: 'Agent needs your help',
    defaultReason: 'Finish the page action, then hand control back to the agent.',
    collapse: 'Collapse',
    placeholder: 'Message for the agent (optional)',
    cancel: 'Cancel request',
    done: 'Done, hand back control',
    expand: 'Expand',
  } : {
    defaultTitle: 'Agent 需要你的帮助',
    defaultReason: 'Agent 需要你完成页面上的操作后继续。',
    collapse: '折叠',
    placeholder: '给 Agent 留言（可选）',
    cancel: '取消请求',
    done: '完成并交还控制权',
    expand: '展开',
  };
  const HOST = '__bb_help_host';
  const HL = '__bb_help_highlight';
  const old = document.getElementById(HOST);
  if (old) old.remove();
  const oldHl = document.getElementById(HL);
  if (oldHl) oldHl.remove();

  let target = null;
  if (targetSelector) {
    try { target = document.querySelector(targetSelector); } catch { target = null; }
  }

  const hl = document.createElement('div');
  hl.id = HL;
  hl.style.cssText = 'position:fixed;z-index:2147483645;pointer-events:none;border:2px solid #2f6fed;border-radius:8px;box-shadow:0 0 0 6px rgba(47,111,237,.18),0 0 22px rgba(47,111,237,.35);display:none';
  document.documentElement.appendChild(hl);

  const host = document.createElement('div');
  host.id = HOST;
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = [
    '.card{position:fixed;box-sizing:border-box;width:380px;max-width:calc(100vw - 24px);background:#f7f9fc;color:#1c2230;border:1px solid #dbe4f5;border-radius:14px;box-shadow:0 16px 40px rgba(28,34,48,.18),0 3px 8px rgba(28,34,48,.08);font:12.5px/1.5 system-ui,sans-serif;pointer-events:auto}',
    '.dragbar{position:absolute;top:6px;left:50%;transform:translateX(-50%);width:36px;height:4px;border-radius:2px;background:#dbe4f5}',
    '.head{display:flex;align-items:center;gap:9px;padding:16px 14px 8px;cursor:grab;user-select:none}',
    '.logo{width:20px;height:20px;border-radius:6px;background:#2f6fed;display:flex;align-items:center;justify-content:center;flex:0 0 auto}',
    '.logo svg{width:13px;height:13px;color:#fff}',
    '.title{flex:1;font-size:13px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.chev{width:22px;height:22px;border:0;background:transparent;color:#6b7488;cursor:pointer;border-radius:6px;font-size:14px;line-height:1}',
    '.chev:hover{background:#eef2fa}',
    '.body{padding:0 14px 14px}',
    '.body.hidden{display:none}',
    '.msg{margin:2px 0 10px;font-size:12.5px;line-height:1.55;color:#1c2230}',
    '.note{width:100%;box-sizing:border-box;min-height:38px;max-height:90px;resize:vertical;border:1px solid #dbe4f5;border-radius:9px;background:#fff;color:#1c2230;font:12px/1.5 system-ui,sans-serif;padding:8px 10px}',
    '.note::placeholder{color:#9aa3b5}',
    '.actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}',
    '.btn{height:32px;padding:0 14px;border-radius:9px;border:1px solid #dbe4f5;background:#fff;color:#1c2230;font-size:12px;font-weight:550;cursor:pointer}',
    '.btn.primary{background:#2f6fed;border-color:#2f6fed;color:#fff}',
  ].join('');
  const wrap = document.createElement('div');
  wrap.innerHTML = '<div class="card"><div class="dragbar"></div>'
    + '<div class="head"><span class="logo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M3 17h18"/><path d="M6 17V9"/><path d="M18 17V9"/><path d="M6 9c3 4 9 4 12 0"/></svg></span><span class="title"></span><button class="chev" title="' + T.collapse + '">⌄</button></div>'
    + '<div class="body"><p class="msg"></p><textarea class="note" placeholder="' + T.placeholder + '"></textarea>'
    + '<div class="actions"><button class="btn" data-act="cancel">' + T.cancel + '</button><button class="btn primary" data-act="done">' + T.done + '</button></div></div>'
    + '</div>';
  shadow.appendChild(style);
  shadow.appendChild(wrap);
  document.documentElement.appendChild(host);

  const card = shadow.querySelector('.card');
  const body = shadow.querySelector('.body');
  shadow.querySelector('.title').textContent = titleText || T.defaultTitle;
  shadow.querySelector('.msg').textContent = reason || T.defaultReason;

  const place = () => {
    if (targetRect && targetRect.width >= 0) {
      hl.style.display = 'block';
      hl.style.left = (targetRect.x - 3) + 'px';
      hl.style.top = (targetRect.y - 3) + 'px';
      hl.style.width = (targetRect.width + 6) + 'px';
      hl.style.height = (targetRect.height + 6) + 'px';
      if (!card.dataset.moved) {
        const left = Math.max(12, Math.min(window.innerWidth - 392, targetRect.x));
        const top = Math.max(12, Math.min(window.innerHeight - 200, targetRect.y + targetRect.height + 12));
        card.style.left = left + 'px';
        card.style.top = top + 'px';
      }
      return;
    }
    if (target) {
      const rect = target.getBoundingClientRect();
      if (rect.width || rect.height) {
        hl.style.display = 'block';
        hl.style.left = (rect.left - 3) + 'px';
        hl.style.top = (rect.top - 3) + 'px';
        hl.style.width = (rect.width + 6) + 'px';
        hl.style.height = (rect.height + 6) + 'px';
        if (!card.dataset.moved) {
          const left = Math.max(12, Math.min(window.innerWidth - 392, rect.left));
          const top = Math.max(12, Math.min(window.innerHeight - 200, rect.bottom + 12));
          card.style.left = left + 'px';
          card.style.top = top + 'px';
        }
        return;
      }
    }
    if (!card.dataset.moved) {
      card.style.left = '16px';
      card.style.top = '16px';
    }
  };
  place();
  window.addEventListener('scroll', place, true);
  window.addEventListener('resize', place);

  const send = (action) => {
    const note = shadow.querySelector('.note').value || '';
    try { chrome.runtime.sendMessage({ type: 'bb.help.resolved', requestId, action, note }); } catch { /* 忽略 */ }
    host.remove();
    hl.remove();
    window.removeEventListener('scroll', place, true);
    window.removeEventListener('resize', place);
  };
  shadow.querySelector('[data-act="done"]').addEventListener('click', () => send('done'));
  shadow.querySelector('[data-act="cancel"]').addEventListener('click', () => send('skip'));
  shadow.querySelector('.chev').addEventListener('click', () => {
    body.classList.toggle('hidden');
    shadow.querySelector('.chev').textContent = body.classList.contains('hidden') ? '›' : '⌄';
  });

  const head = shadow.querySelector('.head');
  head.addEventListener('pointerdown', (event) => {
    if (event.target.closest && event.target.closest('button')) return;
    const rect = card.getBoundingClientRect();
    const dx = event.clientX - rect.left;
    const dy = event.clientY - rect.top;
    card.style.left = rect.left + 'px';
    card.style.top = rect.top + 'px';
    const move = (ev) => {
      card.dataset.moved = '1';
      card.style.left = Math.max(4, Math.min(window.innerWidth - rect.width - 4, ev.clientX - dx)) + 'px';
      card.style.top = Math.max(4, Math.min(window.innerHeight - rect.height - 4, ev.clientY - dy)) + 'px';
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

/** 注入函数：控制提示条（自包含）。 */
function controlHintFunc(enabled, text) {
  const ID = '__bb_control_hint';
  const existing = document.getElementById(ID);
  if (!enabled) {
    if (existing) existing.remove();
    return { enabled: false };
  }
  if (existing) return { enabled: true };
  const box = document.createElement('div');
  box.id = ID;
  box.style.cssText = [
    'position:fixed', 'right:14px', 'bottom:14px', 'z-index:2147483646',
    'display:flex', 'gap:6px', 'align-items:center',
    'background:#101828', 'color:#ffffff', 'border-radius:999px',
    'padding:6px 12px', 'font:12px/1.4 system-ui,"PingFang SC","Noto Sans CJK SC",sans-serif',
    'box-shadow:0 6px 20px rgba(16,24,40,.25)', 'opacity:.92', 'pointer-events:none',
  ].join(';');
  const dot = document.createElement('span');
  dot.style.cssText = 'width:7px;height:7px;border-radius:50%;background:#4ade80;display:inline-block';
  const label = document.createElement('span');
  label.textContent = text;
  box.append(dot, label);
  document.documentElement.appendChild(box);
  return { enabled: true };
}

/** control-hint：会话期间在受控标签页显示/移除控制提示（受设置 controlHint 约束）。 */
export async function controlHint(params = {}) {
  const tabId = Number(params.tabId);
  if (!Number.isInteger(tabId)) throw bridgeError('E_BAD_ARG', 'control-hint 需要 tabId');
  // 旧的深色胶囊提示已由 takeover.js 的新浮层取代；这里只负责清理历史残留。
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: 'ISOLATED',
      func: controlHintFunc,
      args: [false, ''],
    });
  } catch {
    // 页面不可注入时忽略
  }
  return { ok: true, enabled: false };
}
