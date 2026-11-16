// src/tools/closed-shadow.js —— 读取 closed shadow 树中的可交互元素。
import { send as cdpSend } from '../debugger.js';

export async function closedShadowEntries(tabId, limit = 50) {
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
  const entries = [];
  for (const node of candidates.slice(0, 300)) {
    if (entries.length >= limit) break;
    let objectId = null;
    try {
      const resolved = await cdpSend(tabId, 'DOM.resolveNode', { nodeId: node.nodeId });
      objectId = resolved && resolved.object && resolved.object.objectId;
      if (!objectId) continue;
      const info = await cdpSend(tabId, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function(){ return { text: (this.textContent || "").trim().slice(0, 120), tag: this.tagName.toLowerCase(), visible: !!(this.offsetWidth || this.offsetHeight || this.getClientRects().length) }; }',
        returnByValue: true,
      });
      const value = info && info.result && info.result.value;
      if (value && value.visible && value.text) entries.push({ ...value, backendNodeId: node.backendNodeId });
    } catch {
      // 忽略单个节点
    } finally {
      if (objectId) cdpSend(tabId, 'Runtime.releaseObject', { objectId }).catch(() => {});
    }
  }
  return entries;
}
