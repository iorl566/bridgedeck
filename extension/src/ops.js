// src/ops.js —— 操作录制：把用户在页面上的点击/输入/导航记成 JSON，供 Agent 参考
import { execPage } from './inject.js';
import { log } from './log.js';
import { showRecordOverlay, hideRecordOverlay } from './record-overlay.js';

const RECORDINGS_KEY = 'bb.ops.recordings';
const MAX_EVENTS = 500;
const MAX_RECORDINGS = 20;
const MAX_SHOTS = 30;
const SHOT_MAX_WIDTH = 320;
const active = new Map(); // tabId -> { tabId, url, title, startedAt, events }

/** 可选的按步骤截图：仅当录制页是当前窗口的活动标签页时截一张缩略图。 */
async function captureStepShot(session, event) {
  if (!session.screenshots || session.shotCount >= MAX_SHOTS) return;
  try {
    const tabs = await chrome.tabs.query({ active: true, windowId: session.windowId });
    if (!tabs.length || tabs[0].id !== session.tabId) return;
    const dataUrl = await chrome.tabs.captureVisibleTab(session.windowId, { format: 'jpeg', quality: 45 });
    const base64 = String(dataUrl || '').split(',')[1] || '';
    if (!base64) return;
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    const scale = Math.min(1, SHOT_MAX_WIDTH / Math.max(1, bitmap.width));
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.round(bitmap.width * scale)),
      Math.max(1, Math.round(bitmap.height * scale)),
    );
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (typeof bitmap.close === 'function') bitmap.close();
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.4 });
    const output = new Uint8Array(await blob.arrayBuffer());
    let text = '';
    for (let i = 0; i < output.length; i += 8192) text += String.fromCharCode(...output.subarray(i, i + 8192));
    event.screenshot = 'data:image/jpeg;base64,' + btoa(text);
    session.shotCount += 1;
  } catch {
    // 截图失败不影响录制本身
  }
}

/** 注入函数：在页面里挂记录器（必须自包含）。 */
function recorderFunc() {
  if (window.__bb_ops && window.__bb_ops.active) return { active: true, existing: true };
  const state = { active: true, seq: 0 };
  const send = (payload) => {
    try {
      chrome.runtime.sendMessage(Object.assign({ type: 'bb.ops.event' }, payload));
    } catch (error) {
      // SW 不可达时丢弃
    }
  };
  const selectorOf = (el) => {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + el.id;
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 5) {
      let part = node.tagName.toLowerCase();
      if (node.getAttribute && node.getAttribute('name')) part += '[name="' + node.getAttribute('name') + '"]';
      else if (node.getAttribute && node.getAttribute('aria-label')) part += '[aria-label="' + node.getAttribute('aria-label') + '"]';
      else {
        const parent = node.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
          if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
        }
      }
      parts.unshift(part);
      if (node.id) break;
      node = node.parentElement;
      depth += 1;
    }
    return parts.join(' > ');
  };
  const textOf = (el) => String((el && (el.innerText || el.value || el.getAttribute('aria-label') || '')) || '').trim().slice(0, 80);
  const record = (kind, payload) => {
    if (!state.active) return;
    state.seq += 1;
    const seq = state.seq;
    send(Object.assign({ kind, seq, ts: Date.now(), url: location.href }, payload));
    if (kind !== 'state') scheduleState(seq);
  };
  let stateTimer = null;
  let pendingStateSeq = 0;
  const scheduleState = (seq) => {
    pendingStateSeq = seq;
    if (stateTimer) clearTimeout(stateTimer);
    stateTimer = setTimeout(async () => {
      stateTimer = null;
      if (!state.active) return;
      const api = globalThis.__BB_PAGE__;
      if (!api || typeof api.handle !== 'function') return;
      try {
        const reply = await api.handle('observe', { probeHover: false });
        if (!reply || reply.ok !== true || !reply.result) return;
        send({
          kind: 'state',
          seq: pendingStateSeq,
          ts: Date.now(),
          url: location.href,
          observation: String(reply.result.observation || '').slice(0, 20000),
          refs: Number(reply.result.refs) || 0,
          title: String(reply.result.title || ''),
        });
      } catch {
        // 页面不可观察时忽略该步状态
      }
    }, 300);
  };
  const sensitiveFields = new WeakSet();
  const isSensitiveField = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (sensitiveFields.has(el)) return true;
    const type = String(el.getAttribute('type') || '').toLowerCase();
    if (type === 'password') {
      sensitiveFields.add(el);
      return true;
    }
    const autocomplete = String(el.getAttribute('autocomplete') || '').toLowerCase();
    if (/(^|\s)(current-password|new-password|one-time-code|cc-[a-z-]+)(\s|$)/.test(autocomplete)) {
      sensitiveFields.add(el);
      return true;
    }
    return false;
  };
  const markSensitive = (event) => {
    const el = event.target;
    if (el && el.nodeType === 1) isSensitiveField(el);
  };
  document.addEventListener('focusin', markSensitive, true);
  document.addEventListener('pointerdown', markSensitive, true);

  const overlayEvent = (event) => {
    const path = event.composedPath ? event.composedPath() : [];
    return path.some((node) => node && node.id === '__bb_record_host');
  };
  const onClick = (event) => {
    const el = event.target;
    if (!el || el.nodeType !== 1) return;
    if (overlayEvent(event)) return;
    record('click', { selector: selectorOf(el), tag: el.tagName.toLowerCase(), text: textOf(el) });
  };
  const onInput = (event) => {
    const el = event.target;
    if (!el || el.nodeType !== 1) return;
    if (overlayEvent(event)) return;
    const type = String(el.getAttribute('type') || '').toLowerCase();
    const value = isSensitiveField(el) ? '********' : String(el.value == null ? '' : el.value).slice(0, 200);
    record('input', { selector: selectorOf(el), tag: el.tagName.toLowerCase(), type: type || el.tagName.toLowerCase(), value });
  };
  const onChange = (event) => {
    const el = event.target;
    if (!el || el.nodeType !== 1) return;
    if (overlayEvent(event)) return;
    if (String(el.tagName).toLowerCase() === 'select') {
      record('select', { selector: selectorOf(el), value: String(el.value || '') });
    }
  };
  document.addEventListener('click', onClick, true);
  document.addEventListener('input', onInput, true);
  document.addEventListener('change', onChange, true);
  window.__bb_ops = {
    active: true,
    get seq() { return state.seq; },
    stop() {
      state.active = false;
      window.__bb_ops.active = false;
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('input', onInput, true);
      document.removeEventListener('change', onChange, true);
      return { events: state.seq };
    },
  };
  return { active: true, existing: false };
}

/** 注入函数：停止记录器。 */
function stopperFunc() {
  if (window.__bb_ops && typeof window.__bb_ops.stop === 'function') return window.__bb_ops.stop();
  return { events: 0 };
}

async function execFunc(tabId, func, args) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    world: 'ISOLATED',
    func,
    args: args || [],
  });
  const first = Array.isArray(results) ? results[0] : null;
  return first ? first.result : null;
}

async function execFuncAllFrames(tabId, func, args) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: 'ISOLATED',
    func,
    args: args || [],
  });
  return Array.isArray(results) ? results : [];
}

function pushEvent(tabId, event) {
  const session = active.get(tabId);
  if (!session) return;
  if (event && event.kind === 'state') {
    const frameId = Number(event.frameId) || 0;
    const target = [...session.events].reverse().find((item) =>
      item.seq <= event.seq &&
      item.kind !== 'state' &&
      (Number(item.frameId) || 0) === frameId);
    if (target) {
      target.observation = String(event.observation || '').slice(0, 20000);
      target.refs = Number(event.refs) || 0;
      target.stateAt = event.ts || Date.now();
      target.stateUrl = event.url || target.url || '';
    }
    return;
  }
  if (session.events.length >= MAX_EVENTS) return;
  session.events.push(event);
  if (session.screenshots && session.shotCount < MAX_SHOTS) {
    const task = captureStepShot(session, event);
    session.pendingShots.add(task);
    task.finally(() => session.pendingShots.delete(task));
  }
}

export async function startRecording(params = {}) {
  const tabId = Number(params.tabId);
  if (!Number.isInteger(tabId)) throw new Error('需要 tabId');
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new Error('标签页不存在或已关闭');
  }
  const url = String(tab.url || '');
  if (/^(chrome|edge|about|devtools|view-source|chrome-extension):/i.test(url)) {
    throw new Error('受限页面不能录制');
  }
  active.set(tabId, {
    tabId,
    windowId: tab.windowId,
    url,
    title: tab.title || '',
    startedAt: Date.now(),
    events: [],
    screenshots: params.screenshots === true,
    shotCount: 0,
    pendingShots: new Set(),
  });
  try {
    try {
      await execFuncAllFrames(tabId, recorderFunc);
    } catch {
      await execFunc(tabId, recorderFunc);
    }
  } catch (error) {
    active.delete(tabId);
    throw new Error('注入记录器失败：' + ((error && error.message) || error));
  }
  void showRecordOverlay(tabId, active.get(tabId).startedAt);
  log('操作录制开始 tab=' + tabId);
  return { ok: true, tabId, startedAt: Date.now() };
}

export async function stopRecording(params = {}) {
  const tabId = Number(params.tabId);
  const session = active.get(tabId);
  if (!session) return { ok: false, error: '该标签页没有进行中的录制' };
  if (session.pendingShots && session.pendingShots.size) {
    await Promise.allSettled([...session.pendingShots]);
  }
  try {
    try {
      await execFuncAllFrames(tabId, stopperFunc);
    } catch {
      await execFunc(tabId, stopperFunc);
    }
  } catch {
    // 页面可能已关闭
  }
  let finalObservation = null;
  try {
    const observation = await execPage(tabId, 'observe', { probeHover: false });
    finalObservation = {
      text: String(observation.observation || ''),
      url: observation.url || session.url,
      title: observation.title || session.title,
      refs: Number(observation.refs) || 0,
      at: Date.now(),
    };
  } catch {
    // 录制页面可能已导航/关闭，允许没有最终观察
  }
  if (finalObservation && session.events.length) {
    const last = [...session.events].reverse().find((event) => event && event.kind !== 'state');
    if (last && !last.observation) {
      last.observation = String(finalObservation.text || '').slice(0, 20000);
      last.refs = Number(finalObservation.refs) || 0;
      last.stateAt = finalObservation.at || Date.now();
      last.stateUrl = finalObservation.url || last.url || '';
    }
  }
  active.delete(tabId);
  void hideRecordOverlay(tabId);
  const stored = await chrome.storage.local.get(RECORDINGS_KEY);
  const list = Array.isArray(stored && stored[RECORDINGS_KEY]) ? stored[RECORDINGS_KEY] : [];
  const recording = {
    id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
    tabId,
    url: session.url,
    title: session.title,
    startedAt: session.startedAt,
    endedAt: Date.now(),
    events: session.events,
    finalObservation,
  };
  list.unshift(recording);
  // 持久化失败（如配额不足）时重试一次并裁剪，确保已捕获的步骤不丢。
  let saved = false;
  let saveError = '';
  for (let attempt = 0; attempt < 2 && !saved; attempt += 1) {
    try {
      await chrome.storage.local.set({ [RECORDINGS_KEY]: list.slice(0, MAX_RECORDINGS) });
      saved = true;
    } catch (error) {
      saveError = String((error && error.message) || error);
      if (attempt === 0) {
        for (const item of list) {
          if (item && Array.isArray(item.events)) item.events = item.events.slice(-200);
          if (item && item.finalObservation && item.finalObservation.text) item.finalObservation.text = String(item.finalObservation.text).slice(0, 2000);
        }
        for (const item of list.slice(1)) {
          if (item && Array.isArray(item.events)) for (const event of item.events) if (event) delete event.screenshot;
        }
        list.splice(1);
      }
    }
  }
  log('操作录制结束 tab=' + tabId + ' events=' + recording.events.length + (saved ? '' : '（持久化失败：' + saveError + '）'));
  return {
    ok: true,
    recording: { id: recording.id, events: recording.events.length },
    ...(saved ? {} : { persisted: false, warning: saveError }),
  };
}

/** 录制过程中切换标签页：在当前录制里记一条 tab-switch 并尝试抓新页状态。 */
export async function recordTabSwitch(tabId) {
  for (const session of active.values()) {
    if (session.tabId === tabId) continue;
    let tab = null;
    try { tab = await chrome.tabs.get(tabId); } catch { continue; }
    const seq = session.events.length + 1;
    const crossWindow = Number.isInteger(session.windowId) && Number.isInteger(tab.windowId) && tab.windowId !== session.windowId;
    const event = {
      kind: crossWindow ? 'window-switch' : 'tab-switch',
      seq,
      ts: Date.now(),
      url: tab.url || '',
      title: tab.title || '',
      fromTabId: session.tabId,
      toTabId: tabId,
      fromWindowId: session.windowId,
      toWindowId: tab.windowId,
    };
    session.events.push(event);
    try {
      const observation = await execPage(tabId, 'observe', { probeHover: false });
      event.observation = String(observation.observation || '').slice(0, 20000);
      event.refs = Number(observation.refs) || 0;
      event.stateAt = Date.now();
      event.stateUrl = observation.url || event.url;
    } catch {
      // 新标签页可能是受限页面，保留 tab-switch 元数据即可
    }
  }
}

export async function listRecordings() {  const stored = await chrome.storage.local.get(RECORDINGS_KEY);
  const list = Array.isArray(stored && stored[RECORDINGS_KEY]) ? stored[RECORDINGS_KEY] : [];
  return { ok: true, recordings: list };
}

export async function deleteRecording(params = {}) {
  const id = String(params.id || '');
  const stored = await chrome.storage.local.get(RECORDINGS_KEY);
  const list = Array.isArray(stored && stored[RECORDINGS_KEY]) ? stored[RECORDINGS_KEY] : [];
  const next = list.filter((item) => item.id !== id);
  await chrome.storage.local.set({ [RECORDINGS_KEY]: next });
  return { ok: true, removed: list.length - next.length };
}

export function activeRecordings() {
  return { ok: true, active: [...active.values()].map((session) => ({ tabId: session.tabId, url: session.url, startedAt: session.startedAt, events: session.events.length })) };
}

export function collectEvent(tabId, event) {
  pushEvent(tabId, event);
}

/** 页面导航后自动补挂记录器（同一个 tab 仍在录制时）。 */
export async function reattach(tabId) {
  const session = active.get(tabId);
  if (!session) return;
  try {
    try {
      await execFuncAllFrames(tabId, recorderFunc);
    } catch {
      await execFunc(tabId, recorderFunc);
    }
    log('操作录制：tab=' + tabId + ' 导航后重新挂载');
  } catch {
    // 页面可能还没准备好，下一次导航再试
  }
}
