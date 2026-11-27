// src/tabs.js —— tab / window / agent 窗口相关操作
import { bridgeError, mapChromeError } from './errors.js';
import { setTabPolicy, getTabPolicy, clearTabPolicy } from './tab-policy.js';
import { clearTabAlias, listTabAliases, resolveTabAlias, setTabAlias } from './tab-alias.js';
import { planIdleClose } from './lib/tab-idle.js';
import { withTimeout } from './timeout.js';
import { log } from './log.js';
import { armTab } from './debugger.js';
import { showTakeover } from './takeover.js';
import { restrictedUrlReason } from './lib/page-policy.js';
import { expectedTabMoves } from './session-manager/tab-moves.js';
import { isControlledTab, markControlledTab, readControlledTabs } from './controlled-tabs.js';
import { consumeSelfCreated, isSelfCreatedWindow, markSelfCreated, markSelfCreatedWindow } from './tab-attribution.js';
import { focusRequested } from './lib/focus-policy.js';
export { consumeSelfCreated, isSelfCreatedWindow, markSelfCreated, markSelfCreatedWindow };
export { isControlledTab, markControlledTab, readControlledTabs };

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

/** 窗口.ensureAgent：复用或新建 agent 窗口，返回其 tab。默认不抢焦点（--focus 才置前）。 */
export async function ensureAgent(params = {}) {
  const noFocus = !focusRequested(params);

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

/** 新建一个专属 Agent 窗口（每个 session 一个），返回它的 tab。默认不抢焦点。 */
export async function newAgentWindow(params = {}) {
  const noFocus = !focusRequested(params);
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
  const groupTitles = new Map();
  if (chrome.tabGroups && typeof chrome.tabGroups.get === 'function') {
    const ids = new Set(filtered.map((tab) => tab.groupId).filter((id) => Number.isInteger(id) && id >= 0));
    for (const id of ids) {
      try { const group = await chrome.tabGroups.get(id); groupTitles.set(id, group && group.title ? group.title : ''); } catch { /* 组已关闭 */ }
    }
  }
  const keepOpenMap = new Map();
  for (const tab of filtered) {
    try { keepOpenMap.set(tab.id, (await getTabPolicy(tab.id)).keepOpen === true); } catch { keepOpenMap.set(tab.id, false); }
  }
  return {
    tabs: filtered.map((tab) => ({
      tabId: tab.id,
      windowId: tab.windowId,
      url: tab.url || tab.pendingUrl || '',
      title: tab.title || '',
      active: tab.active === true,
      owned: agentWindows.has(tab.windowId) ? 'agent' : 'user',
      controlled: controlled.includes(tab.id),
      keepOpen: keepOpenMap.get(tab.id) === true,
      groupId: Number.isInteger(tab.groupId) && tab.groupId >= 0 ? tab.groupId : null,
      group: tab.groupId != null && tab.groupId >= 0 ? (groupTitles.get(tab.groupId) || '') : '',
    })),
  };
}

/** tab.new 可选策略：只读 / 允许来源（逗号分隔或数组）/ keepOpen。 */
async function applyTabPolicy(tabId, params = {}) {
  const raw = params.allowedOrigins;
  const origins = Array.isArray(raw)
    ? raw
    : (typeof raw === 'string' && raw.trim() ? raw.split(',').map((item) => item.trim()).filter(Boolean) : []);
  if (params.readOnly !== true && !origins.length && params.keepOpen !== true) return;
  await setTabPolicy(tabId, { readOnly: params.readOnly === true, allowedOrigins: origins, keepOpen: params.keepOpen === true });
}

/** 把新建 tab 放进命名标签组；同名组复用，否则创建。 */
async function applyTabGroup(tab, params = {}) {
  const title = typeof params.group === 'string' ? params.group.trim().slice(0, 40) : '';
  if (!title || !chrome.tabGroups || !chrome.tabs) return null;
  try {
    let groupId = null;
    if (chrome.tabGroups.query) {
      const existing = await chrome.tabGroups.query({ windowId: tab.windowId, title });
      if (Array.isArray(existing) && existing.length) groupId = existing[0].id;
    }
    const colors = ['blue', 'green', 'yellow', 'purple', 'cyan', 'orange', 'red', 'pink'];
    let hash = 0;
    for (let index = 0; index < title.length; index += 1) hash = (hash * 31 + title.charCodeAt(index)) >>> 0;
    const color = colors[hash % colors.length];
    if (groupId == null) {
      // tab 可能已被默认的 BridgeDeck 组分走；先移出再建命名组。
      if (Number.isInteger(tab.groupId) && tab.groupId >= 0 && chrome.tabs.ungroup) {
        await chrome.tabs.ungroup(tab.id).catch(() => {});
      }
      groupId = await chrome.tabs.group({ tabIds: [tab.id] });
    } else {
      await chrome.tabs.group({ tabIds: [tab.id], groupId });
    }
    if (groupId != null && chrome.tabGroups.update) {
      await chrome.tabGroups.update(groupId, { title, color, collapsed: false }).catch(() => {});
    }
    return groupId;
  } catch {
    return null;
  }
}

/** tab.new：优先在 agent 窗口里开新 tab。 */
export async function tabNew(params = {}) {
  const url = typeof params.url === 'string' && params.url ? params.url : 'about:blank';
  const blocked = restrictedUrlReason(url);
  if (blocked) throw bridgeError('E_FORBIDDEN', '新建标签页目标受限（' + blocked + '）：BridgeDeck 不打开浏览器内部或扩展页面');
  const noFocus = !focusRequested(params);
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
    await applyTabPolicy(tab.id, params);
    const groupId = await applyTabGroup(tab, params);
    if (params.alias) await setTabAlias(tab.id, params.alias).catch(() => {});
    return { tabId: tab.id, windowId: win.id, newWindow: true, ...(groupId != null ? { groupId } : {}) };
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
  if (Number.isInteger(tab.windowId)) await groupAgentWindowTabs(tab.windowId).catch(() => {});
  await applyTabPolicy(tab.id, params);
  const groupId = await applyTabGroup(tab, params);
  if (params.alias) await setTabAlias(tab.id, params.alias).catch(() => {});
  return { tabId: tab.id, windowId: tab.windowId, ...(groupId != null ? { groupId } : {}) };
}

/** tab.policy：设置/读取/清除单个 tab 的只读与允许来源策略。 */
export async function tabPolicy(params = {}) {
  const tabId = Number(params.tabId);
  if (!Number.isInteger(tabId) || tabId <= 0) throw bridgeError('E_BAD_ARG', 'tab.policy 需要 tabId');
  if (params.clear === true) {
    clearTabPolicy(tabId);
    return { tabId, policy: { readOnly: false, allowedOrigins: [], keepOpen: false } };
  }
  const raw = params.allowedOrigins;
  const origins = Array.isArray(raw)
    ? raw
    : (typeof raw === 'string' && raw.trim() ? raw.split(',').map((item) => item.trim()).filter(Boolean) : []);
  const result = await setTabPolicy(tabId, {
    readOnly: params.readOnly === true,
    allowedOrigins: origins,
    keepOpen: params.keepOpen === true,
  });
  return { tabId, policy: await getTabPolicy(tabId) };
}

/** tab.cleanup：按空闲时间清理 Agent tab；dry-run 只返回计划。 */
export async function tabCleanup(params = {}) {
  const agentWindows = new Set(await readAgentWindows());
  const tabs = await chrome.tabs.query({});
  const keepOpen = new Set();
  for (const tab of tabs) {
    try { if ((await getTabPolicy(tab.id)).keepOpen === true) keepOpen.add(tab.id); } catch { /* 忽略 */ }
  }
  const plan = planIdleClose(tabs.map((tab) => ({
    tabId: tab.id,
    windowId: tab.windowId,
    owned: agentWindows.has(tab.windowId) ? 'agent' : 'user',
    active: tab.active === true,
    lastAccessed: tab.lastAccessed,
    keepOpen: keepOpen.has(tab.id),
  })), { idleMs: params.idleMs, now: Date.now() });
  if (params.dryRun === true) return { ok: true, dryRun: true, ...plan };
  const closed = [];
  for (const tabId of plan.close) {
    try { await chrome.tabs.remove(tabId); closed.push(tabId); } catch { /* 已关闭 */ }
  }
  return { ok: true, closed, kept: plan.keep };
}

/** tab.alias / tab.resolve / tab.aliases：命名 tab。 */
export async function tabAlias(params = {}) {
  const action = String(params.action || 'set');
  if (action === 'list') return { ok: true, aliases: await listTabAliases() };
  if (action === 'resolve') {
    const tabId = await resolveTabAlias(params.alias);
    if (!tabId) throw bridgeError('E_NOT_FOUND', '找不到 tab alias：' + String(params.alias || ''));
    return { ok: true, alias: params.alias, tabId };
  }
  if (action === 'clear') {
    const removed = await clearTabAlias(params.alias);
    return { ok: true, alias: params.alias, cleared: removed };
  }
  const result = await setTabAlias(Number(params.tabId), params.alias);
  if (!result.ok) throw bridgeError(result.code || 'E_BAD_ARG', result.message || '设置 alias 失败');
  return result;
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
