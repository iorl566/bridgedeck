import test from 'node:test';
import assert from 'node:assert/strict';
import { projectQuadPoint, quadFromBoxQuads } from '../../extension/src/lib/frame-matrix.js';

const quad = (p1, p2, p4, width, height, extras = {}) => ({ p1, p2, p4, width, height, ...extras });

test('仿射投影：无变换时等于 rect 平移', () => {
  const projected = projectQuadPoint(quad({ x: 10, y: 20 }, { x: 110, y: 20 }, { x: 10, y: 70 }, 100, 50), { x: 10, y: 10 });
  assert.deepEqual(projected, { x: 20, y: 30 });
});

test('仿射投影：scale 时按向量缩放', () => {
  const projected = projectQuadPoint(quad({ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 0, y: 100 }, 100, 50), { x: 10, y: 10 });
  assert.deepEqual(projected, { x: 20, y: 20 });
});

test('仿射投影：rotate 90° 时坐标轴互换', () => {
  const projected = projectQuadPoint(quad({ x: 0, y: 0 }, { x: 0, y: 100 }, { x: -50, y: 0 }, 100, 50), { x: 10, y: 10 });
  assert.deepEqual(projected, { x: -10, y: 10 });
});

test('仿射投影：skew 保留两条轴向量', () => {
  const projected = projectQuadPoint(quad({ x: 0, y: 0 }, { x: 100, y: 20 }, { x: 10, y: 50 }, 100, 50), { x: 20, y: 10 });
  assert.deepEqual(projected, { x: 20 + 2, y: 4 + 10 });
});

test('仿射投影：边框偏移沿旋转后的轴', () => {
  const projected = projectQuadPoint(
    quad({ x: 0, y: 0 }, { x: 0, y: 100 }, { x: -50, y: 0 }, 100, 50, { borderLeft: 2, borderTop: 4 }),
    { x: 0, y: 0 },
  );
  // ux=(0,1), uy=(-1,0)：2*ux + 4*uy = (-4, 2)
  assert.deepEqual(projected, { x: -4, y: 2 });
});

test('仿射投影：非法输入返回 null', () => {
  assert.equal(projectQuadPoint(null, { x: 0, y: 0 }), null);
  assert.equal(projectQuadPoint(quad({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, 0, 1), { x: 0, y: 0 }), null);
  assert.equal(projectQuadPoint(quad({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, 1, 1), { x: NaN, y: 0 }), null);
});

test('投影四边形：四角与中心走 homography', () => {
  const border = { width: 100, height: 50 };
  const p1 = { x: 0, y: 0 };
  const p2 = { x: 100, y: 0 };
  const p3 = { x: 80, y: 60 };
  const p4 = { x: 0, y: 60 };
  const projected = (x, y) => projectQuadPoint({ ...border, p1, p2, p3, p4 }, { x, y });
  assert.deepEqual(projected(0, 0), p1);
  assert.deepEqual(projected(100, 0), p2);
  assert.deepEqual(projected(100, 50), p3);
  assert.deepEqual(projected(0, 50), p4);
  const center = projected(50, 25);
  assert(center.x > 40 && center.x < 60, '中心 x 不在四边形内：' + JSON.stringify(center));
  assert(center.y > 20 && center.y < 40, '中心 y 不在四边形内：' + JSON.stringify(center));
});

test('quadFromBoxQuads 只保留仿射所需字段', () => {
  const value = quadFromBoxQuads({ p1: { x: 1, y: 2, z: 0 }, p2: { x: 3, y: 2 }, p4: { x: 1, y: 4 } }, { width: 2, height: 2, borderLeft: 1 });
  assert.deepEqual(value, { p1: { x: 1, y: 2 }, p2: { x: 3, y: 2 }, p4: { x: 1, y: 4 }, width: 2, height: 2, borderLeft: 1, borderTop: 0 });
});
