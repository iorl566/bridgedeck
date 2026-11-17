// src/tools/shadow.js —— closed shadow 元素点击/读取。
import { bridgeError } from '../errors.js';
import { acquire, isTabArmed, release, send as cdpSend } from '../debugger.js';
import { requireTabId } from './shared.js';
async function shadowObject(tabId, entry) {
  if (!entry || !Number.isInteger(entry.backendNodeId)) return null;
  const resolved = await cdpSend(tabId, 'DOM.resolveNode', { backendNodeId: entry.backendNodeId });
  return resolved && resolved.object ? resolved.object.objectId : null;
}

export async function shadowRefClick(tabId, entry) {
  const objectId = await shadowObject(tabId, entry);
  if (!objectId) return null;
  try {
    const rect = await cdpSend(tabId, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function(){ this.scrollIntoView({ block: "center", inline: "center" }); const r = this.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }',
      returnByValue: true,
    });
    const point = rect && rect.result ? rect.result.value : null;
    if (!point) return null;
    await acquire(tabId, 'shadow-ref');
    await cdpSend(tabId, 'Page.bringToFront').catch(() => {});
    await cdpSend(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    try {
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
    } finally {
      if (!isTabArmed(tabId)) await cdpSend(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
      await release(tabId, 'shadow-ref').catch(() => {});
    }
    return point;
  } finally {
    cdpSend(tabId, 'Runtime.releaseObject', { objectId }).catch(() => {});
  }
}

export async function shadowRefRead(tabId, entry) {
  const objectId = await shadowObject(tabId, entry);
  if (!objectId) return null;
  try {
    const info = await cdpSend(tabId, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function(){ return (this.textContent || "").trim(); }',
      returnByValue: true,
    });
    return info && info.result ? info.result.value : null;
  } finally {
    cdpSend(tabId, 'Runtime.releaseObject', { objectId }).catch(() => {});
  }
}

/** 在 closed shadow 树里按文本找元素（CDP DOM.pierce + Runtime）。 */
async function findClosedShadow(tabId, text) {
  const doc = await cdpSend(tabId, 'DOM.getDocument', { depth: -1, pierce: true });
  const candidates = [];
  (function walk(node, inClosed) {
    if (!node) return;
    if (inClosed && node.nodeType === 1 && /^(BUTTON|A|INPUT|SELECT|TEXTAREA|LABEL|SUMMARY)$/.test(node.nodeName || '')) {
      candidates.push(node);
    }
    for (const child of node.children || []) walk(child, inClosed);
    for (const shadow of node.shadowRoots || []) walk(shadow, inClosed || shadow.shadowRootType === 'closed');
    if (node.contentDocument) walk(node.contentDocument, false);
  })(doc && doc.root, false);
  for (const node of candidates.slice(0, 300)) {
    let objectId = null;
    let keep = false;
    try {
      const resolved = await cdpSend(tabId, 'DOM.resolveNode', { nodeId: node.nodeId });
      objectId = resolved && resolved.object && resolved.object.objectId;
      if (!objectId) continue;
      const info = await cdpSend(tabId, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function(){ return { text: (this.textContent || "").trim().slice(0, 160), tag: this.tagName.toLowerCase(), visible: !!(this.offsetWidth || this.offsetHeight || this.getClientRects().length) }; }',
        returnByValue: true,
      });
      const value = info && info.result && info.result.value;
      if (value && value.visible && value.text.includes(text)) {
        keep = true;
        return { objectId, value, backendNodeId: node.backendNodeId };
      }
    } catch {
      // 单个节点失败继续找
    } finally {
      if (objectId && !keep) cdpSend(tabId, 'Runtime.releaseObject', { objectId }).catch(() => {});
    }
  }
  return null;
}

export async function shadowClick(params = {}) {
  const tabId = requireTabId(params);
  const text = String(params.text || '').trim();
  if (!text) throw bridgeError('E_BAD_ARG', 'shadow-click 需要 --closed-shadow-text <文本>');
  await acquire(tabId, 'closed-shadow');
  try {
    await cdpSend(tabId, 'DOM.enable').catch(() => {});
    const found = await findClosedShadow(tabId, text);
    if (!found) throw bridgeError('E_NOT_FOUND', 'closed shadow 内没有匹配文本的元素：' + text);
    const point = await shadowRefClick(tabId, { backendNodeId: found.backendNodeId }).catch(() => null);
    if (!point) throw bridgeError('E_NOT_ACTIONABLE', 'closed shadow 元素当前不可点击');
    return { ok: true, matched: found.value.text, tag: found.value.tag, trusted: true, via: 'cdp-closed-shadow', x: point.x, y: point.y };
  } finally {
    await release(tabId, 'closed-shadow').catch(() => {});
  }
}

export async function shadowRead(params = {}) {
  const tabId = requireTabId(params);
  const text = String(params.text || '').trim();
  if (!text) throw bridgeError('E_BAD_ARG', 'shadow-read 需要 --closed-shadow-text <文本>');
  await acquire(tabId, 'closed-shadow');
  try {
    await cdpSend(tabId, 'DOM.enable').catch(() => {});
    const found = await findClosedShadow(tabId, text);
    if (!found) throw bridgeError('E_NOT_FOUND', 'closed shadow 内没有匹配文本的元素：' + text);
    return { ok: true, matched: found.value.text, tag: found.value.tag, via: 'cdp-closed-shadow' };
  } finally {
    await release(tabId, 'closed-shadow').catch(() => {});
  }
}
