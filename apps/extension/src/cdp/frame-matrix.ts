// src/cdp/frame-matrix.ts —— iframe owner 的仿射/投影数学（纯函数，无 CDP/DOM 依赖）。
//
// 输入 quad 是 owner 边框盒在父视口里的角点：p1 左上、p2 右上、p4 左下；
// 有 p3（右下）时是透视四边形（3D/perspective），用 homography；否则用双线性仿射。
// 移植自 extension/src/lib/frame-matrix.js（只读参考；TS 侧重写并补齐类型/边界检查）。

export interface CdpPoint {
  x: number;
  y: number;
}

export interface OwnerQuad {
  p1: CdpPoint;
  p2: CdpPoint;
  p4: CdpPoint;
  /** 透视/3D 时存在：右下角。 */
  p3?: CdpPoint;
  /** owner 的 CSS 边框盒尺寸（offsetWidth/offsetHeight）。 */
  width: number;
  height: number;
  borderLeft: number;
  borderTop: number;
}

type Homography = readonly [number, number, number, number, number, number, number, number];

/** 从单位正方形四角求投影矩阵（Heckbert），返回 [a,b,c,d,e,f,g,h]；退化时 null。 */
export function squareToQuad(p00: CdpPoint, p10: CdpPoint, p11: CdpPoint, p01: CdpPoint): Homography | null {
  const dx1 = p10.x - p11.x;
  const dx2 = p01.x - p11.x;
  const sx = p00.x - p10.x + p11.x - p01.x;
  const dy1 = p10.y - p11.y;
  const dy2 = p01.y - p11.y;
  const sy = p00.y - p10.y + p11.y - p01.y;
  const det = dx1 * dy2 - dx2 * dy1;
  if (!det) return null;
  const g = (sx * dy2 - dx2 * sy) / det;
  const h = (dx1 * sy - sx * dy1) / det;
  return [
    p10.x - p00.x + g * p10.x, p01.x - p00.x + h * p01.x, p00.x,
    p10.y - p00.y + g * p10.y, p01.y - p00.y + h * p01.y, p00.y,
    g, h,
  ];
}

function finitePoint(value: unknown): CdpPoint | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const x = Number(record['x']);
  const y = Number(record['y']);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

/** 把 owner 边框盒内的局部点 (x,y) 投影到父视口坐标；退化/非法输入返回 null。 */
export function projectQuadPoint(quad: OwnerQuad | null | undefined, point: CdpPoint): CdpPoint | null {
  if (!quad) return null;
  const p1 = finitePoint(quad.p1);
  const p2 = finitePoint(quad.p2);
  const p4 = finitePoint(quad.p4);
  if (!p1 || !p2 || !p4) return null;
  const width = Number(quad.width);
  const height = Number(quad.height);
  if (!(width > 0) || !(height > 0)) return null;
  const x = Number(point.x);
  const y = Number(point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const borderLeft = Number(quad.borderLeft) || 0;
  const borderTop = Number(quad.borderTop) || 0;
  // 有 p3 时是透视四边形（perspective/3D）：用 homography，而不是仿射。
  const p3 = finitePoint(quad.p3);
  if (p3) {
    const matrix = squareToQuad(p1, p2, p3, p4);
    if (!matrix) return null;
    const [a, b, c, d, e, f, g, h] = matrix;
    const u = (borderLeft + x) / width;
    const v = (borderTop + y) / height;
    const denom = g * u + h * v + 1;
    if (!denom) return null;
    return { x: (a * u + b * v + c) / denom, y: (d * u + e * v + f) / denom };
  }
  const ux = { x: (p2.x - p1.x) / width, y: (p2.y - p1.y) / width };
  const uy = { x: (p4.x - p1.x) / height, y: (p4.y - p1.y) / height };
  const localX = borderLeft + x;
  const localY = borderTop + y;
  return {
    x: p1.x + ux.x * localX + uy.x * localY,
    y: p1.y + ux.y * localX + uy.y * localY,
  };
}

/** 由 owner 四角算平移/缩放（诊断字段用）。 */
export function quadScale(quad: OwnerQuad): { x: number; y: number } | null {
  const p1 = finitePoint(quad.p1);
  const p2 = finitePoint(quad.p2);
  const p4 = finitePoint(quad.p4);
  if (!p1 || !p2 || !p4) return null;
  const width = Number(quad.width);
  const height = Number(quad.height);
  if (!(width > 0) || !(height > 0)) return null;
  return {
    x: Math.hypot((p2.x - p1.x) / width, (p2.y - p1.y) / width),
    y: Math.hypot((p4.x - p1.x) / height, (p4.y - p1.y) / height),
  };
}
