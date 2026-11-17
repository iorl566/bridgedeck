// src/refs/resolve-backend.js —— 由主文档选择器补 backendNodeId。
import { acquire, release, send } from '../debugger.js';

export async function resolveBackendId(tabId, selector) {
  if (!Number.isInteger(Number(tabId)) || typeof selector !== 'string' || !selector) return null;
  await acquire(tabId, 'ref-backend');
  try {
    await send(tabId, 'DOM.enable').catch(() => {});
    const doc = await send(tabId, 'DOM.getDocument', { depth: 0, pierce: false });
    const rootId = doc && doc.root && doc.root.nodeId;
    if (!rootId) return null;
    const found = await send(tabId, 'DOM.querySelector', { nodeId: rootId, selector });
    const nodeId = found && found.nodeId;
    if (!Number.isInteger(nodeId) || nodeId <= 0) return null;
    const described = await send(tabId, 'DOM.describeNode', { nodeId, depth: 0 });
    const backendNodeId = described && described.node && described.node.backendNodeId;
    return Number.isInteger(backendNodeId) ? backendNodeId : null;
  } catch {
    return null;
  } finally {
    await release(tabId, 'ref-backend').catch(() => {});
  }
}
