// src/tools/observation-visual.js —— 分层 L2 事实与视觉候选/VOM 融合（从 observation 拆出）。
import { execPage } from '../inject.js';
import { buildVisualObjects } from '../lib/visual-objects.js';
import { requireTabId } from './shared.js';

/** 分层文档 L2：优先使用 AX 阻挡层，没有时退回页面侧 blocking 提示。 */
export function buildLayerFacts(blockingLayers, base = {}) {
  return Array.isArray(blockingLayers) && blockingLayers.length
    ? blockingLayers.map((layer) => ({
      level: 'L2',
      role: layer.role,
      name: layer.name,
      backendNodeId: layer.backendNodeId,
      bounds: layer.bounds,
      coverage: layer.coverage,
    }))
    : (base.blocking
      ? [{ level: 'L2', role: base.blocking.role || base.blocking.tag, name: base.blocking.label || '', coverage: null }]
      : []);
}

export async function visualScan(params = {}) {
  const tabId = requireTabId(params);
  const result = await execPage(tabId, 'visual-scan', {});
  const candidates = result && Array.isArray(result.candidates) ? result.candidates : [];
  return {
    ok: true,
    candidates,
    viewport: (result && result.viewport) || null,
    hint: '用 screenshot --visual <index> 只拍该区域并绑定坐标；随后 click/drag --capture <id> --image-x/--image-y',
  };
}

/** VOM 观察同时收集视觉候选区域（canvas/图片/自绘区域）。 */
export async function collectVisualFacts(tabId) {
  let regions = null;
  let refs = null;
  try {
    [regions, refs] = await Promise.all([
      visualScan({ tabId }).catch(() => null),
      execPage(tabId, 'visual-refs', {}).catch(() => null),
    ]);
  } catch {
    regions = null;
    refs = null;
  }
  return {
    visualObjects: buildVisualObjects({ regions, refs }),
    visualRegions: regions,
    visualRefs: refs,
  };
}

export function emptyVisualObjects() {
  return buildVisualObjects({ regions: null, refs: null });
}
