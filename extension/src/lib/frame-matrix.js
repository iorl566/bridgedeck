// src/lib/frame-matrix.js —— iframe owner 的仿射投影（支持 scale / rotate / skew / 滚动容器）。
// 输入 quad 是 owner 边框盒在父视口里的三个角：p1 左上、p2 右上、p4 左下；
// width/height 是 owner 的 CSS 边框盒尺寸（offsetWidth/offsetHeight）。
/** 从单位正方形四角求投影矩阵（Heckbert），返回 [a,b,c,d,e,f,g,h]。 */
function squareToQuad(p00, p10, p11, p01) {
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

export function projectQuadPoint(quad, point = {}) {
  if (!quad || !quad.p1 || !quad.p2 || !quad.p4) return null;
  const width = Number(quad.width);
  const height = Number(quad.height);
  if (!(width > 0) || !(height > 0)) return null;
  const x = Number(point.x);
  const y = Number(point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const borderLeft = Number(quad.borderLeft) || 0;
  const borderTop = Number(quad.borderTop) || 0;
  // 有 p3 时是投影四边形（perspective/3D）：用 homography，而不是仿射。
  if (quad.p3) {
    const matrix = squareToQuad(quad.p1, quad.p2, quad.p3, quad.p4);
    if (!matrix) return null;
    const u = (borderLeft + x) / width;
    const v = (borderTop + y) / height;
    const [a, b, c, d, e, f, g, h] = matrix;
    const denom = g * u + h * v + 1;
    if (!denom) return null;
    return { x: (a * u + b * v + c) / denom, y: (d * u + e * v + f) / denom };
  }
  const ux = { x: (quad.p2.x - quad.p1.x) / width, y: (quad.p2.y - quad.p1.y) / width };
  const uy = { x: (quad.p4.x - quad.p1.x) / height, y: (quad.p4.y - quad.p1.y) / height };
  const localX = borderLeft + x;
  const localY = borderTop + y;
  return {
    x: quad.p1.x + ux.x * localX + uy.x * localY,
    y: quad.p1.y + ux.y * localX + uy.y * localY,
  };
}

/** 把 getBoxQuads 的第一个四边形转成 projectQuadPoint 需要的形状。 */
export function quadFromBoxQuads(quad, { width, height, borderLeft = 0, borderTop = 0 } = {}) {
  if (!quad || !quad.p1 || !quad.p2 || !quad.p4) return null;
  return {
    p1: { x: quad.p1.x, y: quad.p1.y },
    p2: { x: quad.p2.x, y: quad.p2.y },
    p4: { x: quad.p4.x, y: quad.p4.y },
    width,
    height,
    borderLeft,
    borderTop,
  };
}
