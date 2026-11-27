// 视觉坐标拖拽：把截图像素坐标换成页面坐标，并强制 trusted。
import { bridgeError } from '../errors.js';
import { resolveCapturePoint, verifyVisualHit } from '../screenshot.js';

export async function withImageDrag(params) {
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
