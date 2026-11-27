// src/debugger.js —— CDP 会话驱动（每个 tab 只 attach 一次，动作结束进入空闲软分离）
//
// 设计要点：
// * 每个 tab 只 attach 一次；动作结束不立即 detach，而是进入 75s 空闲软分离窗口。
// * 长生命周期 feature（dialog/network/video/emulate/session 等）持有期间不分离。
// * 会话标签页 attach 后启用 Emulation.setFocusEmulationEnabled，让后台 Agent Window
//   可以直接接收原生输入，不需要切 tab / 抢窗口焦点。
// * session 停止或 tab 关闭时强制 detach，并关闭焦点仿真。
import { bridgeError, mapChromeError } from './errors.js';
import { log } from './log.js';
import { runCdpCommand } from './browser-driver/command-deadline.js';
import { DEFAULT_DEBUGGER_IDLE_MS, shouldIdleDetach } from './debugger-idle.js';
import { sameSignature, signatureOfTab } from './lib/soft-detach-signature.js';

const states = new Map(); // tabId -> { tabId, handlers: Map<method, Set<fn>>, onDetach }
const users = new Map(); // tabId -> Set<feature>
const lastActivity = new Map(); // tabId -> 最近一次 attach/acquire/send/release 时间
const idleTimers = new Map(); // tabId -> setTimeout
const emulatedTabs = new Set(); // 已启用焦点仿真的 tab
const detachEpoch = new Map(); // tabId -> 强制分离代数，用于取消迟到的 arm
// 软分离/外部 detach 后待恢复的持有者与焦点仿真：下次 attach 时对账恢复。
const pendingUsers = new Map(); // tabId -> Set<feature>
const pendingEmulated = new Set(); // tabId
const pendingSignatures = new Map(); // tabId -> 分离时页面签名
const intentionalDetach = new Set(); // tabId（显式 detach 不参与恢复）

function bumpEpoch(tabId) {
  detachEpoch.set(tabId, (detachEpoch.get(tabId) || 0) + 1);
}

function touch(tabId) {
  if (!Number.isInteger(tabId)) return;
  lastActivity.set(tabId, Date.now());
  scheduleIdleDetach(tabId);
}

function scheduleIdleDetach(tabId) {
  const previous = idleTimers.get(tabId);
  if (previous) clearTimeout(previous);
  if (!states.has(tabId)) return;
  const timer = setTimeout(() => {
    void softDetachWhenIdle(tabId);
  }, DEFAULT_DEBUGGER_IDLE_MS);
  timer.unref?.();
  idleTimers.set(tabId, timer);
}

async function softDetachWhenIdle(tabId) {
  idleTimers.delete(tabId);
  if (!states.has(tabId)) return;
  const detachNow = shouldIdleDetach({
    attached: true,
    lastActivity: lastActivity.get(tabId) || 0,
    now: Date.now(),
    activeFeatures: activeFeatures(tabId),
  });
  if (!detachNow) {
    scheduleIdleDetach(tabId);
    return;
  }
  log('debugger 空闲软分离 tab=' + tabId);
  await detach(tabId);
}

// 单元测试环境可能只 stub 了 chrome.tabs：监听器按需注册，避免模块加载即崩。
const debuggerApi = typeof chrome !== 'undefined' ? chrome.debugger : undefined;
if (debuggerApi && debuggerApi.onEvent) {
  debuggerApi.onEvent.addListener((source, method, params) => {
    const state = states.get(source.tabId);
    if (!state) return;
    const handlers = state.handlers.get(method);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(params || {});
      } catch (error) {
        log('debugger 事件处理异常 ' + method + '：' + ((error && error.message) || error));
      }
    }
  });
}

if (debuggerApi && debuggerApi.onDetach) {
  debuggerApi.onDetach.addListener((source, reason) => {
    const state = states.get(source.tabId);
    if (!state) return;
    if (intentionalDetach.has(source.tabId)) {
      intentionalDetach.delete(source.tabId);
    } else {
      // 外部分离（DevTools 接管、渲染进程重建、浏览器侧回收）：保存持有者，重挂时恢复。
      const held = users.get(source.tabId);
      if (held && held.size) pendingUsers.set(source.tabId, new Set(held));
      if (emulatedTabs.has(source.tabId)) pendingEmulated.add(source.tabId);
      // 记录分离时页面签名：重挂时若 URL/title 已变，不再恢复旧持有者。
      try {
        chrome.tabs.get(source.tabId).then((tab) => {
          const signature = signatureOfTab(tab);
          if (signature) pendingSignatures.set(source.tabId, signature);
        }).catch(() => {});
      } catch { /* 测试环境无 tabs */ }
    }
    states.delete(source.tabId);
    users.delete(source.tabId);
    emulatedTabs.delete(source.tabId);
    const timer = idleTimers.get(source.tabId);
    if (timer) clearTimeout(timer);
    idleTimers.delete(source.tabId);
    lastActivity.delete(source.tabId);
    log('debugger 已分离 tab=' + source.tabId + ' reason=' + reason);
    if (typeof state.onDetach === 'function') {
      try {
        state.onDetach(reason);
      } catch (error) {
        log('onDetach 回调异常', error && error.message);
      }
    }
  });
}

/** 挂上 debugger；同一 tab 并发 attach 复用同一个进行中的 promise（避免 “Another debugger is already attached”）。 */
const attachInFlight = new Map();
export async function attach(tabId) {
  const existing = states.get(tabId);
  if (existing) return existing;
  const pending = attachInFlight.get(tabId);
  if (pending) return pending;
  const task = (async () => {
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
    } catch (error) {
      const message = String((error && error.message) || error);
      if (/another debugger|already attached/i.test(message)) {
        throw bridgeError('E_DEBUGGER_BUSY', 'tab ' + tabId + ' 已被其它调试会话占用');
      }
      throw mapChromeError(error, '挂载调试器失败');
    }
    const state = { tabId, handlers: new Map(), onDetach: null };
    states.set(tabId, state);
    touch(tabId);
    // 对账：上次软分离/外部分离时保存的持有者与焦点仿真，在重挂后恢复。
    let signatureChanged = false;
    const pendingSignature = pendingSignatures.get(tabId);
    if (pendingSignature) {
      pendingSignatures.delete(tabId);
      try {
        const tab = await chrome.tabs.get(tabId);
        signatureChanged = !sameSignature(pendingSignature, signatureOfTab(tab));
      } catch {
        signatureChanged = false;
      }
      if (signatureChanged) {
        pendingUsers.delete(tabId);
        pendingEmulated.delete(tabId);
        log('debugger 重挂签名变化，丢弃旧恢复状态 tab=' + tabId);
      }
    }
    const held = signatureChanged ? null : pendingUsers.get(tabId);
    if (held && held.size) {
      users.set(tabId, new Set(held));
      pendingUsers.delete(tabId);
      log('debugger 重挂后恢复持有者 tab=' + tabId + ' features=' + [...held].join(','));
    }
    if (!signatureChanged && pendingEmulated.has(tabId)) {
      pendingEmulated.delete(tabId);
      try {
        await chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true });
        emulatedTabs.add(tabId);
        log('debugger 重挂后恢复焦点仿真 tab=' + tabId);
      } catch (restoreError) {
        log('重挂后恢复焦点仿真失败 tab=' + tabId + '：' + ((restoreError && restoreError.message) || restoreError));
      }
    }
    log('debugger 已挂载 tab=' + tabId);
    return state;
  })();
  attachInFlight.set(tabId, task);
  try {
    return await task;
  } finally {
    if (attachInFlight.get(tabId) === task) attachInFlight.delete(tabId);
  }
}

export function isAttached(tabId) {
  return states.has(Number(tabId));
}

/** 谁在用 debugger：长任务持有期间不进入空闲分离。 */
export async function acquire(tabId, feature) {
  const state = await attach(tabId);
  touch(tabId);
  let set = users.get(tabId);
  if (!set) {
    set = new Set();
    users.set(tabId, set);
  }
  set.add(feature);
  return state;
}

/** 释放 feature；不立即 detach，交给 75s 空闲软分离（长任务仍持有则不分离）。 */
export async function release(tabId, feature) {
  const set = users.get(tabId);
  if (!set) return;
  set.delete(feature);
  if (set.size === 0) users.delete(tabId);
  touch(tabId);
}

export function activeFeatures(tabId) {
  const set = users.get(tabId);
  return set ? [...set] : [];
}

export function onEvent(state, method, handler) {
  let set = state.handlers.get(method);
  if (!set) {
    set = new Set();
    state.handlers.set(method, set);
  }
  set.add(handler);
  return () => {
    const current = state.handlers.get(method);
    if (current) current.delete(handler);
  };
}

const NOT_ATTACHED_RE = /debugger is not attached|not attached to the tab/i;

export async function send(tabId, method, params) {
  touch(tabId);
  const call = () => runCdpCommand({ tabId }, method, () => chrome.debugger.sendCommand({ tabId }, method, params || {}));
  try {
    return await call();
  } catch (error) {
    if (!NOT_ATTACHED_RE.test(String((error && error.message) || error))) throw error;
    // 本地还记着"已挂载"，浏览器侧却已经分离（service worker 休眠后状态丢失、
    // 渲染进程重建、错误页接管等）。丢掉陈旧状态、重新 attach，再试一次。
    log('debugger 状态陈旧（' + method + '），重新挂载 tab=' + tabId);
    const held = users.get(tabId);
    if (held && held.size) pendingUsers.set(tabId, new Set(held));
    if (emulatedTabs.has(tabId)) pendingEmulated.add(tabId);
    states.delete(tabId);
    users.delete(tabId);
    emulatedTabs.delete(tabId);
    await attach(tabId);
    return call();
  }
}

/** 向子 target（OOPIF 等 flatten session）发命令。 */
export async function sendToTarget(tabId, sessionId, method, params) {
  if (!sessionId) return send(tabId, method, params);
  touch(tabId);
  const target = { tabId, sessionId };
  return runCdpCommand(target, method, () => chrome.debugger.sendCommand(target, method, params || {}));
}

/**
 * 会话 CDP 就绪：attach + 焦点仿真。后台 Agent Window 的原生输入因此无需切前台。
 * 失败时返回 false，调用方沿用旧的切前台兜底路径。
 */
export async function armTab(tabId) {
  if (!Number.isInteger(tabId)) return false;
  const epoch = detachEpoch.get(tabId) || 0;
  await acquire(tabId, 'session');
  if ((detachEpoch.get(tabId) || 0) !== epoch) {
    // 预挂期间 session 已停止：撤销这次迟到的 attach。
    await detach(tabId).catch(() => {});
    return false;
  }
  try {
    await send(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true });
  } catch (error) {
    log('焦点仿真启用失败 tab=' + tabId + '：' + ((error && error.message) || error));
    await release(tabId, 'session');
    return false;
  }
  if ((detachEpoch.get(tabId) || 0) !== epoch) {
    await detach(tabId).catch(() => {});
    return false;
  }
  emulatedTabs.add(tabId);
  log('会话 CDP 就绪（焦点仿真）tab=' + tabId);
  return true;
}

export function isTabArmed(tabId) {
  const id = Number(tabId);
  return emulatedTabs.has(id) && states.has(id);
}

/** 诊断：模拟 DevTools/浏览器侧接管导致的 detach（不写 intentional 标记），用于验证重挂对账。 */
export async function simulateExternalDetach(tabId) {
  const id = Number(tabId);
  if (!Number.isInteger(id) || !states.has(id)) {
    throw bridgeError('E_BAD_ARG', '当前标签页没有挂载 debugger');
  }
  await chrome.debugger.detach({ tabId: id });
  return { ok: true };
}

export async function detach(tabId) {
  bumpEpoch(tabId);
  // 显式分离不参与"重挂恢复"：清掉待恢复项，并标记本次 onDetach 是预期的。
  intentionalDetach.add(tabId);
  pendingUsers.delete(tabId);
  pendingEmulated.delete(tabId);
  const clearIntent = setTimeout(() => intentionalDetach.delete(tabId), 1000);
  clearIntent.unref?.();
  const attaching = attachInFlight.get(tabId);
  if (attaching) {
    await attaching.catch(() => {});
  }
  const timer = idleTimers.get(tabId);
  if (timer) clearTimeout(timer);
  idleTimers.delete(tabId);
  if (!states.has(tabId)) {
    emulatedTabs.delete(tabId);
    return false;
  }
  if (emulatedTabs.has(tabId)) {
    emulatedTabs.delete(tabId);
    try {
      await send(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: false });
    } catch {
      // 页面可能已关闭；继续 detach
    }
  }
  try {
    await chrome.debugger.detach({ tabId });
  } catch (error) {
    log('分离 debugger 失败 tab=' + tabId + '：' + ((error && error.message) || error));
  }
  states.delete(tabId);
  users.delete(tabId);
  lastActivity.delete(tabId);
  const pendingTimer = idleTimers.get(tabId);
  if (pendingTimer) clearTimeout(pendingTimer);
  idleTimers.delete(tabId);
  return true;
}

export function detachAll() {
  for (const tabId of [...states.keys()]) {
    detach(tabId).catch(() => {});
  }
  users.clear();
  lastActivity.clear();
  emulatedTabs.clear();
  pendingUsers.clear();
  pendingEmulated.clear();
}

/** 空闲 sweeper：service worker 被挂起后补扫，会话租约与长任务不分离。 */
async function sweepIdleDebuggers() {
  if (!chrome.tabs || typeof chrome.tabs.get !== 'function') return;
  const now = Date.now();
  for (const tabId of [...states.keys()]) {
    if (emulatedTabs.has(tabId)) continue;
    try {
      await chrome.tabs.get(tabId);
    } catch {
      await detach(tabId);
      continue;
    }
    const detachNow = shouldIdleDetach({
      attached: true,
      lastActivity: lastActivity.get(tabId) || 0,
      now,
      activeFeatures: activeFeatures(tabId),
    });
    if (!detachNow) continue;
    log('debugger 空闲软分离 tab=' + tabId);
    await detach(tabId);
  }
}

const IDLE_ALARM = 'bb-debugger-idle';
try {
  if (chrome.alarms && typeof chrome.alarms.create === 'function' && chrome.alarms.onAlarm) {
    // MV3 service worker 会被挂起，用 alarms 而不是 setInterval 保证 sweeper 能醒来。
    chrome.alarms.create(IDLE_ALARM, { periodInMinutes: 0.5 });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm && alarm.name === IDLE_ALARM) void sweepIdleDebuggers();
    });
  }
} catch (error) {
  log('注册 debugger 空闲 sweeper 失败（保留即时分离兜底）：' + ((error && error.message) || error));
}

/** 测试/诊断用：当前 attach 数量。 */
export function attachedCount() {
  return states.size;
}
