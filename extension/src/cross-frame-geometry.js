// src/cross-frame-geometry.js —— 跨源 OOPIF 的 CDP owner 投影。
// 页面内 page-lib 只能读同源 contentDocument；OOPIF 需要 CDP 的 frame owner。
import { acquire, release, send } from './debugger.js';

function normalize(value) {
  try { return new URL(String(value || '')).href; } catch { return String(value || ''); }
}

function walk(tree, out = [], parent = null) {
  if (!tree || !tree.frame) return out;
  const frame = tree.frame;
  out.push({ id: String(frame.id), parentId: frame.parentId ? String(frame.parentId) : parent, url: String(frame.url || '') });
  for (const child of tree.childFrames || []) walk(child, out, String(frame.id));
  return out;
}

function findPath(frames, targetUrl) {
  const target = frames.find((frame) => normalize(frame.url) === normalize(targetUrl));
  if (!target) return null;
  const byId = new Map(frames.map((frame) => [frame.id, frame]));
  const path = [];
  let current = target;
  while (current) {
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : null;
  }
  return path; // target -> ... -> root
}

async function ownerRect(tabId, frameId) {
  const owner = await send(tabId, 'DOM.getFrameOwner', { frameId });
  const backendNodeId = owner && owner.backendNodeId;
  if (!Number.isInteger(backendNodeId)) throw new Error('frame owner 不可用');
  const resolved = await send(tabId, 'DOM.resolveNode', { backendNodeId });
  const objectId = resolved && resolved.object && resolved.object.objectId;
  if (!objectId) throw new Error('frame owner 不可解析');
  const result = await send(tabId, 'Runtime.callFunctionOn', {
    objectId,
    returnByValue: true,
    functionDeclaration: `function () {
      const el = this;
      if (!el || !el.getBoundingClientRect) return null;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const width = Number(el.clientWidth) || rect.width;
      const height = Number(el.clientHeight) || rect.height;
      return {
        x: rect.left, y: rect.top, width: rect.width, height: rect.height,
        borderLeft: Number.parseFloat(style.borderLeftWidth) || 0,
        borderTop: Number.parseFloat(style.borderTopWidth) || 0,
        scaleX: width > 0 ? rect.width / width : 1,
        scaleY: height > 0 ? rect.height / height : 1,
      };
    }`,
  });
  return result && result.result && result.result.value;
}

/**
 * 把目标 frame 的本地坐标投影到顶层视口。
 * 目前通过 root target 的 Page.getFrameTree + DOM.getFrameOwner；失败返回 null。
 */
export async function projectCrossFramePoint(tabId, { url, x, y }) {
  if (!Number.isInteger(Number(tabId)) || !url) return null;
  const px = Number(x);
  const py = Number(y);
  if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
  await acquire(tabId, 'cross-frame-geometry');
  try {
    await send(tabId, 'DOM.enable').catch(() => {});
    const tree = await send(tabId, 'Page.getFrameTree', {});
    const frames = walk(tree && tree.frameTree);
    const path = findPath(frames, url);
    if (!path || path.length < 2) return null;
    let currentX = px;
    let currentY = py;
    const owners = [];
    // path[0] 是目标 frame；它的 owner 在 path[1] 文档里，依次向外。
    for (let index = 0; index < path.length - 1; index += 1) {
      const child = path[index];
      const rect = await ownerRect(tabId, child.id);
      if (!rect) return null;
      currentX = rect.x + rect.borderLeft + currentX * rect.scaleX;
      currentY = rect.y + rect.borderTop + currentY * rect.scaleY;
      owners.push({ url: child.url, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
    }
    return { x: currentX, y: currentY, via: 'cdp-frame-owner', owners };
  } catch {
    return null;
  } finally {
    await release(tabId, 'cross-frame-geometry').catch(() => {});
  }
}
