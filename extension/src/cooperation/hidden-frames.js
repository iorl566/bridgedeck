import { COOPERATION_OWNERS } from './types.js';

const OWNER_ELEMENTS = new Set(['iframe', 'frame', 'object', 'embed', 'fencedframe']);
const OWNER_REPLY_MS = 1200;
const MAX_OWNERS = 4096;

/** Runs in the parent document's collector; reports layout facts only. */
export function describeFrameOwners(root, shadowRoot) {
  const focusPath = new Set();
  for (let active = root.activeElement; active && !focusPath.has(active); active = shadowRoot(active)?.activeElement ?? null) focusPath.add(active);
  const owners = [];
  const visit = (scope) => {
    for (const element of scope.querySelectorAll('*')) {
      if (OWNER_ELEMENTS.has(element.localName)) owners.push(element);
      const nested = shadowRoot(element);
      if (nested) visit(nested);
    }
  };
  visit(root);
  return owners.map((element) => {
    const box = element.getBoundingClientRect();
    const visible = typeof element.checkVisibility !== 'function' || element.checkVisibility({ visibilityProperty: true });
    let url = null;
    try {
      const href = element.contentWindow?.location.href;
      if (typeof href === 'string') url = href;
    } catch { /* cross-origin */ }
    return {
      hidden: !focusPath.has(element) && (element.getClientRects().length === 0 || box.width <= 0 || box.height <= 0 || !visible),
      url,
    };
  });
}

function validOwners(value) {
  return Array.isArray(value) && value.length <= MAX_OWNERS && value.every((owner) => !!owner && typeof owner === 'object' && typeof owner.hidden === 'boolean' && (owner.url === null || typeof owner.url === 'string'));
}

export function children(inventory, parent) {
  return inventory.filter((frame) => frame.parentFrameId === parent.frameId && (frame.parentDocumentId === undefined || frame.parentDocumentId === parent.documentId));
}

export function signature(frames) {
  return frames.map((frame) => `${frame.frameId}\n${frame.documentId}\n${frame.url}`).sort().join('\n\n');
}

/** True only when the frame's element in its parent must be one of the hidden ones. */
export function ownedByHiddenElement(frame, owners, siblings) {
  if (owners.length !== siblings.length || !siblings.some((sibling) => sibling.frameId === frame.frameId)) return false;
  const others = new Map();
  for (const sibling of siblings) {
    if (sibling.frameId !== frame.frameId) others.set(sibling.url, (others.get(sibling.url) ?? 0) + 1);
  }
  for (const owner of owners) {
    if (owner.hidden) continue;
    if (owner.url === null || owner.url === frame.url) return false;
    const count = others.get(owner.url) ?? 0;
    if (!count) return false;
    others.set(owner.url, count - 1);
  }
  return true;
}

async function readOwners(tabId, parent) {
  let timer;
  try {
    const reply = await Promise.race([
      chrome.tabs.sendMessage(tabId, { kind: COOPERATION_OWNERS }, { documentId: parent.documentId }),
      new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), OWNER_REPLY_MS); }),
    ]);
    return validOwners(reply) ? reply : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Of candidates without a working collector, return frames proven hidden in a parent. */
export async function provenHiddenFrames(tabId, inventory, candidates, known = new Set()) {
  const proven = new Set();
  const byId = new Map(inventory.map((frame) => [frame.frameId, frame]));
  const failing = new Set(candidates.map((frame) => frame.frameId));
  const depth = (frame) => {
    let count = 0;
    for (let parent = byId.get(frame.parentFrameId); parent && count <= inventory.length; parent = byId.get(parent.parentFrameId)) count += 1;
    return count;
  };
  const queried = new Map();
  for (const frame of [...candidates].sort((a, b) => depth(a) - depth(b))) {
    const parent = byId.get(frame.parentFrameId);
    if (frame.frameId === 0 || !parent) continue;
    if (known.has(parent.frameId) || proven.has(parent.frameId)) { proven.add(frame.frameId); continue; }
    if (failing.has(parent.frameId)) continue;
    let owners = queried.get(parent.frameId);
    if (!owners) {
      owners = readOwners(tabId, parent);
      queried.set(parent.frameId, owners);
    }
    const facts = await owners;
    if (facts && ownedByHiddenElement(frame, facts, children(inventory, parent))) proven.add(frame.frameId);
  }
  if (!queried.size || !proven.size) return proven;
  const current = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => undefined);
  for (const parentId of queried.keys()) {
    const parent = byId.get(parentId);
    const now = current?.find((frame) => frame.frameId === parentId);
    if (!current || now?.documentId !== parent.documentId || signature(children(current, parent)) !== signature(children(inventory, parent))) return new Set();
  }
  return proven;
}
