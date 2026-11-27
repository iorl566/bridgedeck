// src/cross-frame-geometry.js —— 跨源 OOPIF 的 CDP owner 投影。
// 页面内 page-lib 只能读同源 contentDocument；OOPIF 需要 CDP 的 frame owner。
import { acquire, release, send } from './debugger.js';
import { projectQuadPoint } from './lib/frame-matrix.js';

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
      const style = getComputedStyle(el);
      const borderLeft = Number.parseFloat(style.borderLeftWidth) || 0;
      const borderTop = Number.parseFloat(style.borderTopWidth) || 0;
      const width = Number(el.offsetWidth) || Number(el.clientWidth) || el.getBoundingClientRect().width;
      const height = Number(el.offsetHeight) || Number(el.clientHeight) || el.getBoundingClientRect().height;
      const transform = style.transform && style.transform !== 'none' ? style.transform : null;
      let base = el.getBoundingClientRect();
      let matrix = null;
      let originX = 0;
      let originY = 0;
      if (transform) {
        try {
          matrix = new DOMMatrixReadOnly(transform);
          const origin = String(style.transformOrigin || '').split(' ').map((part) => Number.parseFloat(part));
          originX = Number.isFinite(origin[0]) ? origin[0] : 0;
          originY = Number.isFinite(origin[1]) ? origin[1] : 0;
          // transform 不参与布局：临时清掉自身 transform，取回未变换的边框盒位置。
          const previous = el.style.transform;
          el.style.transform = 'none';
          base = el.getBoundingClientRect();
          el.style.transform = previous;
        } catch { matrix = null; }
      }
      // 祖先 perspective：3D 旋转会产生 z，浏览器在祖先处做透视除法。
      let perspective = 0;
      let hostRect = null;
      let perspectiveX = 0;
      let perspectiveY = 0;
      for (let node = el.parentElement; node && node.nodeType === 1; node = node.parentElement) {
        const hostStyle = getComputedStyle(node);
        const value = hostStyle.perspective && hostStyle.perspective !== 'none' ? Number.parseFloat(hostStyle.perspective) : 0;
        if (!(value > 0)) continue;
        perspective = value;
        hostRect = node.getBoundingClientRect();
        const hostOrigin = String(hostStyle.perspectiveOrigin || '50% 50%').split(' ').map((part) => Number.parseFloat(part));
        perspectiveX = hostRect.left + (Number.isFinite(hostOrigin[0]) ? hostOrigin[0] : hostRect.width / 2);
        perspectiveY = hostRect.top + (Number.isFinite(hostOrigin[1]) ? hostOrigin[1] : hostRect.height / 2);
        break;
      }
      const project = (x, y) => {
        if (!matrix) return { x: base.left + x, y: base.top + y };
        const dx = x - originX;
        const dy = y - originY;
        const px = base.left + originX + matrix.a * dx + matrix.c * dy + matrix.e;
        const py = base.top + originY + matrix.b * dx + matrix.d * dy + matrix.f;
        if (!(perspective > 0)) return { x: px, y: py };
        const z = (matrix.m13 || 0) * dx + (matrix.m23 || 0) * dy + (matrix.m43 || 0);
        const w = 1 - z / perspective;
        if (!Number.isFinite(w) || Math.abs(w) < 1e-6) return { x: px, y: py };
        return { x: perspectiveX + (px - perspectiveX) / w, y: perspectiveY + (py - perspectiveY) / w };
      };
      const quad = { p1: project(0, 0), p2: project(width, 0), p4: project(0, height), width, height, borderLeft, borderTop };
      if (perspective > 0) quad.p3 = project(width, height);
      return quad;
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
      const owner = await ownerRect(tabId, child.id);
      if (!owner) return null;
      const projected = projectQuadPoint(owner, { x: currentX, y: currentY });
      if (!projected) return null;
      currentX = projected.x;
      currentY = projected.y;
      owners.push({
        url: child.url,
        rect: { x: owner.p1.x, y: owner.p1.y, width: owner.width, height: owner.height },
      });
    }
    return { x: currentX, y: currentY, via: 'cdp-frame-owner', owners };
  } catch {
    return null;
  } finally {
    await release(tabId, 'cross-frame-geometry').catch(() => {});
  }
}
