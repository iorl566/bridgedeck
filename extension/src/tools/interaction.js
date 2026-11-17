// src/tools/interaction.js —— 点击/输入/按键/选择/拖拽/滚轮/滚动。
import { bridgeError } from '../errors.js';
import { execPage, waitForPaint } from '../inject.js';
import { sleep } from '../tabs.js';
import { acquire, isTabArmed, release, send as cdpSend } from '../debugger.js';
import { withForegroundTab } from '../background-execution.js';
import { withOverlaysHidden } from '../overlay-suppress.js';
import { acquireInputLease, releaseInputLease } from '../input-lease.js';
import { pageAction } from './page-action.js';
import { requireTabId } from './shared.js';
import { shadowRefClick } from './shadow.js';
import { inputFocusCache, recentFillFocus, shadowRefs } from './state.js';
import { resolveCapturePoint, verifyVisualHit } from '../screenshot.js';
import { log } from '../log.js';
const rawClick = pageAction('click');
const rawHover = pageAction('hover');

const TARGET_RETRY_CODES = new Set(['E_NOT_FOUND', 'E_STALE_REF']);

/**
 * 显式 waitTimeoutMs 时，对 selector 目标做短暂重试：
 * SPA 重新渲染/懒加载造成目标短暂消失时，等它回来再动作；默认（未显式给）仍立即失败。
 */
async function retryTarget(params, run) {
  const waitMs = Number(params && params.waitTimeoutMs);
  if (!(waitMs > 0) || !(params && params.selector)) return run();
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return await run();
    } catch (error) {
      if (!error || !TARGET_RETRY_CODES.has(error.code) || Date.now() >= deadline) throw error;
      await sleep(Math.min(50, Math.max(0, deadline - Date.now())));
    }
  }
}

/**
 * 可信输入前置：把目标标签页切到前台。
 * 后台标签页收不到 CDP 原生鼠标/键盘事件（事件会被浏览器丢弃），
 * 表现就是 --trusted 返回成功但页面 trustedMoves=0。只影响显式 --trusted。
 */
async function ensureInputFocus(tabId) {
  // 会话 CDP 已启用焦点仿真：页面自认可见，直接派发原生输入，不切 tab/窗口。
  if (isTabArmed(tabId)) return true;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab) {
        if (tab.active === false) await chrome.tabs.update(tabId, { active: true });
        if (Number.isInteger(tab.windowId)) {
          try {
            const win = await chrome.windows.get(tab.windowId);
            if (win && win.state === 'minimized') await chrome.windows.update(tab.windowId, { state: 'normal' });
          } catch { /* 窗口状态读取失败时仍尝试聚焦 */ }
          await chrome.windows.update(tab.windowId, { focused: true });
        }
      }
    } catch {
      // 标签/窗口已关闭或权限受限：继续尝试派发，失败会回退到页面内动作
    }
    try {
      const state = await evalInMain(tabId, 'document.visibilityState');
      if (state && state.value === 'visible') {
        // visibilityState 可能在合成器尚未提交时仍为 visible；等两帧后再确认一次。
        await waitForPaint(tabId).catch(() => sleep(32));
        const settled = await evalInMain(tabId, 'document.visibilityState').catch(() => null);
        if (settled && settled.value === 'visible') return true;
      }
    } catch {
      // 注入失败时按不可见处理，继续重试
    }
    await sleep(120);
  }
  return false;
}

async function trustedOrFallback(kind, params, fallback) {
  const tabId = requireTabId(params);
  // 复合 frame ref 的坐标是 frame-local；先投影到顶层，再派发 trusted 点击。
  if (Number.isInteger(Number(params.frameId)) && Number(params.frameId) > 0) {
    if (kind === 'click' && params.frameUrl) {
      try {
        const local = await execPage(tabId, 'point', params, Number(params.frameId));
        const projected = await execPage(tabId, 'frame-project-point', { url: params.frameUrl, x: local.x, y: local.y }, 0);
        if (projected && Number.isFinite(projected.x) && Number.isFinite(projected.y)) {
          const lease = acquireInputLease(tabId, 'trusted:frame-click');
          try { await trustedClickPoint(tabId, projected); } finally { releaseInputLease(tabId, lease.token); }
          return { ok: true, trusted: true, via: 'frame-projected', x: projected.x, y: projected.y, frameUrl: projected.frameUrl };
        }
      } catch {
        // 投影失败时回退 frame 内 page-lib 点击。
      }
    }
    return fallback(params);
  }
  if (kind === 'click' && params && params.ref) {
    const map = shadowRefs.get(tabId);
    const entry = map && map.get(params.ref);
    if (entry) {
      const point = await shadowRefClick(tabId, entry).catch(() => null);
      if (point) return { ok: true, trusted: true, via: 'closed-shadow-ref', x: point.x, y: point.y };
    }
  }
  if (!(params && params.trusted === true)) return fallback(params);
  if (params && (params.modifiers || (params.button && params.button !== 'left'))) return fallback(params);
  await ensureInputFocus(tabId);
  const target = params && params.ref ? { ref: params.ref } : (params && params.selector ? { selector: params.selector } : null);
  if (target && params.force !== true) {
    const hit = await execPage(tabId, 'hit-test', target).catch(() => null);
    if (hit && (hit.state === 'blocked' || hit.state === 'pointer-events-none')) {
      throw bridgeError(
        'E_OCCLUDED',
        '目标在动作前被遮挡（' + hit.state + '）：请先关闭浮层/弹窗，或用 --force 强制派发',
        { hitTest: hit.state, occludedBy: hit.occludedBy || null, rect: hit.rect || null, dispatched: false },
      );
    }
  }
  if (target) {
    let point = null;
    try {
      point = await execPage(tabId, 'point', target);
    } catch {
      point = null;
    }
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
      const lease = acquireInputLease(tabId, 'trusted:' + kind);
      try {
        try {
          await acquire(tabId, 'input');
          try {
            await cdpSend(tabId, 'Page.bringToFront').catch(() => {});
            await cdpSend(tabId, 'Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
            await cdpSend(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
            const path = kind === 'click'
              ? [[point.x - 36, point.y - 18], [point.x - 18, point.y - 6], [point.x, point.y]]
              : [[point.x - 24, point.y - 10], [point.x, point.y]];
            for (const [mx, my] of path) {
              await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: mx, y: my, button: 'none', buttons: 0, clickCount: 0 });
            }
            if (kind === 'click') {
              let pressed = false;
              try {
                await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
                pressed = true;
                await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
                pressed = false;
              } finally {
                if (pressed) await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 }).catch(() => {});
              }
            }
            return { ok: true, trusted: true, x: point.x, y: point.y };
          } finally {
            if (!isTabArmed(tabId)) void cdpSend(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
            await release(tabId, 'input').catch(() => {});
          }
        } catch {
          // debugger 不可用：回退到页面内点击
        }
      } finally {
        releaseInputLease(tabId, lease.token);
      }
    }
  }
  return fallback(params);
}

async function trustedDrag(params, fallback) {
  const tabId = requireTabId(params);
  await ensureInputFocus(tabId);
  let start;
  if (params.fromPoint && Number.isFinite(params.fromPoint.x) && Number.isFinite(params.fromPoint.y)) {
    // 视觉坐标拖拽：起点已经由 resolveCapturePoint 换算好，不需要再查元素。
    start = { x: params.fromPoint.x, y: params.fromPoint.y };
  } else {
    const fromPoint = await execPage(tabId, 'point', params.from).catch(() => null);
    if (!fromPoint) return fallback(params);
    start = {
      x: fromPoint.x + (Number(params.fromOffsetX) || 0),
      y: fromPoint.y + (Number(params.fromOffsetY) || 0),
    };
  }
  let toPoint = null;
  if (params.to) toPoint = await execPage(tabId, 'point', params.to).catch(() => null);
  const end = toPoint
    ? { x: toPoint.x + (Number(params.toOffsetX) || 0), y: toPoint.y + (Number(params.toOffsetY) || 0) }
    : { x: start.x + (Number(params.dx) || 0), y: start.y + (Number(params.dy) || 0) };
  const steps = Math.max(2, Math.min(60, Number(params.steps) || 10));
  const modifiers = Number(params.modifiers) || 0;
  const holdMs = Math.max(0, Math.min(5000, Number(params.holdMs) || 0));
  const durationMs = Math.max(0, Math.min(5000, Number(params.durationMs) || 0));
  const pause = durationMs > 0 ? Math.min(200, Math.round(durationMs / steps)) : 0;
  const lease = acquireInputLease(tabId, 'trusted:drag', 30000);
  try {
    await acquire(tabId, 'input');
    try {
      await cdpSend(tabId, 'Page.bringToFront').catch(() => {});
      await cdpSend(tabId, 'Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
      await cdpSend(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
      await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y, button: 'none', buttons: 0, clickCount: 0, modifiers });
      let pressed = false;
      try {
        await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', buttons: 1, clickCount: 1, modifiers });
        pressed = true;
        if (holdMs > 0) await sleep(holdMs);
        for (let i = 1; i <= steps; i += 1) {
          const t = i / steps;
          const x = start.x + (end.x - start.x) * t;
          const y = start.y + (end.y - start.y) * t;
          await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1, modifiers });
          if (pause > 0) await sleep(pause);
        }
        await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: end.x, y: end.y, button: 'left', buttons: 0, clickCount: 1, modifiers });
        pressed = false;
      } finally {
        if (pressed) await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: end.x, y: end.y, button: 'left', buttons: 0, clickCount: 1, modifiers }).catch(() => {});
      }
      return { ok: true, trusted: true, from: start, to: end, hit: params.hitAt || undefined };
    } finally {
      if (!isTabArmed(tabId)) void cdpSend(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
      await release(tabId, 'input').catch(() => {});
    }
  } finally {
    releaseInputLease(tabId, lease.token);
  }
}

export async function click(params = {}) {
  return retryTarget(params, () => {
    if (params && params.trusted === true && Number.isInteger(params.tabId)) {
      return withForegroundTab(params.tabId, () => withOverlaysHidden(params.tabId, () => trustedOrFallback('click', params, rawClick)));
    }
    return trustedOrFallback('click', params, rawClick);
  });
}

/**
 * click-backend：按 backendNodeId 点击 AX/DOMSnapshot 发现、但没有 @eN ref 的元素
 *（closed shadow、page-lib 漏掉的节点）。动作前做滚动/可见性/遮挡检查，
 * 然后派发 CDP 原生鼠标事件（isTrusted=true）。
 */
export async function clickBackend(params = {}) {
  const tabId = requireTabId(params);
  const backendId = Number(params.backendId);
  if (!Number.isInteger(backendId) || backendId <= 0) {
    throw bridgeError('E_BAD_ARG', 'click-backend 需要 backendId 正整数');
  }
  await acquire(tabId, 'click-backend');
  await ensureInputFocus(tabId).catch(() => {});
  await cdpSend(tabId, 'Page.bringToFront').catch(() => {});
  await cdpSend(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  try {
    await cdpSend(tabId, 'DOM.enable').catch(() => {});
    const resolved = await cdpSend(tabId, 'DOM.resolveNode', { backendNodeId: backendId });
    const objectId = resolved && resolved.object && resolved.object.objectId;
    if (!objectId) throw bridgeError('E_NOT_FOUND', 'backendNodeId 已失效或不在当前文档');
    const checked = await cdpSend(tabId, 'Runtime.callFunctionOn', {
      objectId,
      returnByValue: true,
      awaitPromise: false,
      functionDeclaration: `function () {
        const el = this;
        if (!el || !el.isConnected) return { ok: false, reason: 'detached' };
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return { ok: false, reason: 'zero-size' };
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || style.pointerEvents === 'none') {
          return { ok: false, reason: 'not-actionable' };
        }
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const root = el.getRootNode();
        if (root === document) {
          const hit = document.elementFromPoint(x, y);
          if (!hit) return { ok: false, reason: 'no-hit' };
          if (hit !== el && !el.contains(hit)) return { ok: false, reason: 'occluded', by: hit.tagName };
        }
        return { ok: true, x, y };
      }`,
    });
    const value = checked && checked.result ? checked.result.value : null;
    if (!value || value.ok !== true) {
      const reason = value && value.reason ? value.reason : 'unknown';
      if (reason === 'occluded') {
        throw bridgeError('E_OCCLUDED', '目标被遮挡：' + (value.by || 'unknown'), {
          hitTest: 'blocked', backendNodeId: backendId, dispatched: false,
        });
      }
      throw bridgeError('E_NOT_ACTIONABLE', 'backend 节点当前不可点击（' + reason + '）', {
        backendNodeId: backendId, reason, dispatched: false,
      });
    }
    const x = Math.round(Number(value.x) * 100) / 100;
    const y = Math.round(Number(value.y) * 100) / 100;
    await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    let pressed = false;
    try {
      await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      pressed = true;
      await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
      pressed = false;
    } finally {
      if (pressed) await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }).catch(() => {});
    }
    return { ok: true, trusted: true, via: 'cdp-backend', backendNodeId: backendId, x, y };
  } finally {
    if (!isTabArmed(tabId)) await cdpSend(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
    await release(tabId, 'click-backend').catch(() => {});
  }
}

const KEY_CODES = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Esc: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
};

// US 布局标点的物理键码：快捷键处理器常检查 event.code（Ctrl+/、Ctrl+[ 等），
// 只给 key 不够。Shifted 符号映射到基础键位并自动补 shift 修饰。
const PUNCTUATION = {
  '`': ['Backquote', 192], '~': ['Backquote', 192, true],
  '-': ['Minus', 189], '_': ['Minus', 189, true],
  '=': ['Equal', 187], '+': ['Equal', 187, true],
  '[': ['BracketLeft', 219], '{': ['BracketLeft', 219, true],
  ']': ['BracketRight', 221], '}': ['BracketRight', 221, true],
  '\\': ['Backslash', 220], '|': ['Backslash', 220, true],
  ';': ['Semicolon', 186], ':': ['Semicolon', 186, true],
  "'": ['Quote', 222], '"': ['Quote', 222, true],
  ',': ['Comma', 188], '<': ['Comma', 188, true],
  '.': ['Period', 190], '>': ['Period', 190, true],
  '/': ['Slash', 191], '?': ['Slash', 191, true],
};

function punctuationInfo(ch) {
  const entry = PUNCTUATION[ch];
  if (!entry) return null;
  return { key: ch, code: entry[0], vk: entry[1], shift: entry[2] === true };
}

function parseKeySpec(spec) {
  const parts = String(spec || '').split('+').map((item) => item.trim()).filter(Boolean);
  if (!parts.length) throw bridgeError('E_BAD_ARG', 'press 需要 key');
  const keyName = parts.pop();
  let modifiers = 0;
  for (const part of parts) {
    const token = part.toLowerCase();
    if (token === 'ctrl' || token === 'control') modifiers |= 2;
    else if (token === 'alt' || token === 'option') modifiers |= 1;
    else if (token === 'shift') modifiers |= 8;
    else if (token === 'meta' || token === 'cmd' || token === 'win') modifiers |= 4;
  }
  let info = KEY_CODES[keyName] || KEY_CODES[keyName.charAt(0).toUpperCase() + keyName.slice(1)];
  if (!info && keyName.length === 1) {
    const ch = keyName;
    const upper = ch.toUpperCase();
    const isDigit = /[0-9]/.test(ch);
    const punct = punctuationInfo(ch);
    info = punct
      ? { key: punct.key, code: punct.code, vk: punct.vk, text: punct.shift ? undefined : ch }
      : {
        key: ch,
        code: isDigit ? 'Digit' + ch : (/[a-zA-Z]/.test(ch) ? 'Key' + upper : ''),
        vk: isDigit ? ch.charCodeAt(0) : (upper.charCodeAt(0) || 0),
        text: ch,
      };
    if (punct && punct.shift) modifiers |= 8;
  }
  if (!info) throw bridgeError('E_BAD_ARG', '不支持的按键：' + spec);
  return { ...info, modifiers };
}

async function trustedKey(tabId, spec) {
  const info = parseKeySpec(spec);
  const base = {
    modifiers: info.modifiers,
    key: info.key,
    code: info.code || '',
    windowsVirtualKeyCode: info.vk || 0,
    nativeVirtualKeyCode: info.vk || 0,
  };
  const withText = info.text !== undefined && (info.modifiers & (2 | 4)) === 0;
  await pipeCdp(tabId, [
    ['Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(withText ? { text: info.text } : {}) }],
    ['Input.dispatchKeyEvent', { type: 'keyUp', ...base }],
  ]);
}

async function trustedFocusPoint(tabId, params) {
  const target = params && params.ref
    ? { ref: params.ref }
    : (params && params.selector ? { selector: params.selector } : (params && params.text ? { text: params.text } : null));
  if (!target) return null;
  return execPage(tabId, 'point', target).catch(() => null);
}

/** 同一条 CDP 会话上的命令按发送顺序执行；无需逐条等待响应，可省往返。 */
function pipeCdp(tabId, commands) {
  return Promise.all(commands.map(([method, params]) => cdpSend(tabId, method, params)));
}

async function trustedClickPoint(tabId, point) {
  await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0, clickCount: 0 });
  let pressed = false;
  try {
    await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
    pressed = true;
    await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
    pressed = false;
  } finally {
    if (pressed) await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 }).catch(() => {});
  }
}

/**
 * 3–4 步 fast path：页面内聚焦并选中 → CDP insertText → 页面内校验。
 * 省掉鼠标点击、Ctrl+A、焦点仿真与置前；不适合的控件返回 null 走原 trustedFill。
 */
/** fill 校验结果的对外字段：敏感字段只回 formatted，其余回 actual_value（截断 200）。 */
function fillVerifyFields(verified) {
  if (!verified) return {};
  if (verified.sensitive === true) return { formatted: verified.formatted === true };
  const actualText = verified.value != null ? String(verified.value) : '';
  return {
    actual_value: actualText.slice(0, 200),
    ...(actualText.length > 200 ? { actual_value_truncated: true } : {}),
    formatted: verified.formatted === true,
  };
}

function fillVerifyTargets(params) {
  return params.ref ? { ref: params.ref } : (params.selector ? { selector: params.selector } : {});
}

async function trustedFillFast(params) {
  const tabId = requireTabId(params);
  const target = params.ref ? { ref: params.ref } : (params.selector ? { selector: params.selector } : null);
  if (!target) return null;
  const now = Date.now();
  const cachedFocus = inputFocusCache.get(tabId);
  if (!cachedFocus || now - cachedFocus > 1000) {
    const focused = await ensureInputFocus(tabId);
    if (!focused) return null;
    inputFocusCache.set(tabId, now);
  }
  const raw = await execPage(tabId, 'fill-focus', { ...target, noClear: params.noClear === true }).catch((error) => { throw error; });
  const prep = raw && raw.value && typeof raw.value === 'object' ? raw.value : raw;
  if (prep && prep.textLike === false) return { __programmatic: true, reason: prep.reason || 'programmatic-only', inputType: prep.inputType || '' };
  if (!prep || prep.textLike !== true) return null;
  // 焦点没有真正落到目标上（常见于 closed shadow / 页面抢焦点）：不要 insertText 到错误元素，回退 trusted 点选路径。
  if (prep.focused === false) return null;
  if (prep.occluded === true && params.force !== true) {
    throw bridgeError('E_NOT_ACTIONABLE', '目标被遮挡（occluded），可用 --force 强制填写');
  }

  const value = String(params.value === undefined ? '' : params.value);
  const lease = acquireInputLease(tabId, 'trusted:fill');
  try {
    await acquire(tabId, 'input');
    try {
      await cdpSend(tabId, 'Input.insertText', { text: value });
    } finally {
      await release(tabId, 'input').catch(() => {});
    }
  } finally {
    releaseInputLease(tabId, lease.token);
  }
  const verified = await execPage(tabId, 'fill-verify', { ...target, expected: value }).catch(() => null);
  return {
    ok: true,
    trusted: true,
    fast: true,
    ...fillVerifyFields(verified),
  };
}

async function trustedFill(params, fallback) {
  const tabId = requireTabId(params);
  const now = Date.now();
  const cachedFocus = inputFocusCache.get(tabId);
  if (!cachedFocus || now - cachedFocus > 1000) {
    const focused = await ensureInputFocus(tabId);
    if (focused) inputFocusCache.set(tabId, now);
  }
  const point = await trustedFocusPoint(tabId, params);
  if (!point) return fallback(params);
  const lease = acquireInputLease(tabId, 'trusted:fill');
  try {
    await acquire(tabId, 'input');
    try {
      // 三个 CDP 设置互不依赖，合并为一次往返；后台标签才需要 bringToFront/lifecycle。
      const setup = [];
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab || tab.active === false) {
        setup.push(cdpSend(tabId, 'Page.bringToFront').catch(() => {}));
        setup.push(cdpSend(tabId, 'Page.setWebLifecycleState', { state: 'active' }).catch(() => {}));
      }
      setup.push(cdpSend(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {}));
      await Promise.all(setup);
      await trustedClickPoint(tabId, point);
      if (params.noClear !== true) {
        await trustedKey(tabId, 'Control+a');
      } else {
        await trustedKey(tabId, 'End');
      }
      await cdpSend(tabId, 'Input.insertText', { text: String(params.value === undefined ? '' : params.value) });
    } finally {
      if (!isTabArmed(tabId)) void cdpSend(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
      await release(tabId, 'input').catch(() => {});
    }
  } finally {
    releaseInputLease(tabId, lease.token);
  }
  const fillTarget = fillVerifyTargets(params);
  const verified = await execPage(tabId, 'fill-verify', {
    ...fillTarget,
    expected: String(params.value === undefined ? '' : params.value),
  }).catch(() => null);
  return {
    ok: true,
    trusted: true,
    ...fillVerifyFields(verified),
  };
}

async function trustedPress(params, fallback) {
  const tabId = requireTabId(params);
  await ensureInputFocus(tabId);
  const recent = recentFillFocus.get(tabId);
  const skipClick = Boolean(params.ref && recent && recent.ref === params.ref && Date.now() - recent.at < 3000);
  const point = skipClick ? null : await trustedFocusPoint(tabId, params);
  const lease = acquireInputLease(tabId, 'trusted:press');
  try {
    await acquire(tabId, 'input');
    try {
      await cdpSend(tabId, 'Page.bringToFront').catch(() => {});
      await cdpSend(tabId, 'Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
      await cdpSend(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
      if (point) await trustedClickPoint(tabId, point);
      await trustedKey(tabId, String(params.key));
      return { ok: true, trusted: true };
    } finally {
      if (!isTabArmed(tabId)) void cdpSend(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
      await release(tabId, 'input').catch(() => {});
    }
  } finally {
    releaseInputLease(tabId, lease.token);
  }
}

const rawFill = pageAction('fill');
const rawPress = pageAction('press');
export async function actionable(params = {}) {
  const tabId = requireTabId(params);
  const target = params.ref ? { ref: params.ref } : (params.selector ? { selector: params.selector } : null);
  if (!target) throw bridgeError('E_BAD_ARG', 'actionable 需要 ref 或 selector');
  return execPage(tabId, 'actionable', target);
}

export async function fill(params = {}) {
  return retryTarget(params, async () => {
    if (!params || params.trusted !== true) {
      const result = await rawFill(params);
      if (params && params.ref) recentFillFocus.set(Number(params.tabId), { ref: params.ref, at: Date.now() });
      // 合成路径也回填校验结果：agent 不能只看 "ok" 就以为值真的写进去了。
      if (params && Number.isInteger(params.tabId)) {
        const verified = await execPage(params.tabId, 'fill-verify', {
          ...fillVerifyTargets(params),
          expected: String(params.value === undefined ? '' : params.value),
        }).catch(() => null);
        return { ...result, ...fillVerifyFields(verified) };
      }
      return result;
    }
    const run = async () => {
      const fast = await trustedFillFast(params).catch((error) => {
        // 语义错误必须让调用方看到；只有真正的环境问题才回退。
        if (error && ['E_INPUT_BUSY', 'E_NOT_ACTIONABLE', 'E_BAD_ARG', 'E_TARGET_NOT_FILLABLE', 'E_OPTION_NOT_FOUND', 'E_OPTION_AMBIGUOUS'].includes(error.code)) throw error;
        return null;
      });
      if (fast) {
        if (fast.__programmatic === true) {
          const result = await rawFill(params);
          const verified = await execPage(Number(params.tabId), 'fill-verify', {
            ...fillVerifyTargets(params),
            expected: String(params.value === undefined ? '' : params.value),
          }).catch(() => null);
          return { ...result, ...fillVerifyFields(verified), trusted: false, fallback: 'programmatic', reason: fast.reason };
        }
        if (params.ref) recentFillFocus.set(Number(params.tabId), { ref: params.ref, at: Date.now() });
        return fast;
      }
      const result = await trustedFill(params, rawFill).catch((error) => {
        if (error && error.code === 'E_INPUT_BUSY') throw error;
        return rawFill(params);
      });
      if (params.ref) recentFillFocus.set(Number(params.tabId), { ref: params.ref, at: Date.now() });
      return result;
    };
    return Number.isInteger(params.tabId) ? withForegroundTab(params.tabId, () => withOverlaysHidden(params.tabId, run)) : run();
  });
}
export async function press(params = {}) {
  return retryTarget(params, () => {
    if (!params || params.trusted !== true) return rawPress(params);
    const run = () => trustedPress(params, rawPress).catch((error) => {
      if (error && error.code === 'E_INPUT_BUSY') throw error;
      return rawPress(params);
    });
    return Number.isInteger(params.tabId) ? withForegroundTab(params.tabId, () => withOverlaysHidden(params.tabId, run)) : run();
  });
}


export async function hover(params = {}) {
  return retryTarget(params, () => {
    if (params && params.trusted === true && Number.isInteger(params.tabId)) {
      return withForegroundTab(params.tabId, () => withOverlaysHidden(params.tabId, () => trustedOrFallback('hover', params, rawHover)));
    }
    return trustedOrFallback('hover', params, rawHover);
  });
}
const rawSelect = pageAction('select');
export async function select(params = {}) {
  return retryTarget(params, () => rawSelect(params));
}
export const focus = pageAction('focus');
export const scrollTo = pageAction('scroll-to');
const rawDrag = pageAction('drag');
export async function drag(params = {}) {
  const effective = await withImageDrag(params);
  if (!effective || effective.trusted !== true) return rawDrag(effective);
  const run = () => trustedDrag(effective, rawDrag).catch((error) => {
    if (error && error.code === 'E_INPUT_BUSY') throw error;
    // 视觉坐标拖拽没有页面内等价物：起点是像素坐标，页面库拿不到元素。
    if (effective.capture != null) throw error;
    return rawDrag(effective);
  });
  return Number.isInteger(effective.tabId) ? withForegroundTab(effective.tabId, () => withOverlaysHidden(effective.tabId, run)) : run();
}

/**
 * 视觉坐标拖拽：把截图像素坐标换成页面坐标，并强制走可信输入。
 * 页面内合成事件对 canvas 验证码一类控件无效，所以这里不做回退——
 * 坐标拖拽只有 CDP 这一条路，失败就让调用方看到真实错误。
 */
async function withImageDrag(params) {
  if (!params || params.capture == null) return params;
  const imageX = Number(params.imageX);
  const imageY = Number(params.imageY);
  if (!Number.isFinite(imageX) || !Number.isFinite(imageY)) {
    throw bridgeError('E_BAD_ARG', '视觉坐标拖拽需要 imageX/imageY');
  }
  const tabId = Number(params.tabId);
  const resolved = resolveCapturePoint(
    String(params.capture),
    Number.isInteger(tabId) ? tabId : undefined,
    imageX,
    imageY,
    { consume: true },
  );
  const scale = resolved.scale || 1;
  const dx = Number.isFinite(Number(params.imageDx)) ? Number(params.imageDx) / scale : Number(params.dx) || 0;
  const dy = Number.isFinite(Number(params.imageDy)) ? Number(params.imageDy) / scale : Number(params.dy) || 0;
  if (!dx && !dy) throw bridgeError('E_BAD_ARG', '视觉坐标拖拽需要 imageDx/imageDy（图片像素位移）');
  // 派发前确认落点：坐标是外部给的，先看下面到底是什么（浮层/遮罩/空白都要拦）。
  const hit = await verifyVisualHit(resolved.capture.tabId, resolved.x, resolved.y, resolved.capture.candidateIndex);
  return {
    ...params,
    tabId: resolved.capture.tabId,
    from: undefined,
    to: undefined,
    fromPoint: { x: resolved.x, y: resolved.y },
    hitAt: hit ? { tag: hit.tag, id: hit.id, cls: hit.cls } : undefined,
    dx,
    dy,
    trusted: true,
  };
}
export const wheel = pageAction('wheel');
export const blur = pageAction('blur');

