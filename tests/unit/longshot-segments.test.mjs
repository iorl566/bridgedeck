import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SEGMENT_DEFAULTS,
  toDevicePx,
  canvasDevicePx,
  toCssPx,
  planFixedBands,
  splitSegmentHeights,
  planLongshotSegments,
  tileRectsForSegment,
  bandRedrawRect,
  locateSegment,
  segmentsOverlapping,
  validateSegmentPlan,
  segmentPlanWire,
  describeSegmentPlan,
} from '../../extension/src/lib/longshot-segments.js';

test('toDevicePx/canvasDevicePx/toCssPx：分数 DPR 三种取整口径', () => {
  assert.equal(toDevicePx(56, 1.5), 84);
  assert.equal(toDevicePx(80, 1.5), 120);
  assert.equal(toDevicePx(0, 1.5), 0);
  assert.equal(toDevicePx('x', 1.5), 0);
  assert.equal(canvasDevicePx(1241, 1.5), 1862);
  assert.equal(canvasDevicePx(1241, 1), 1241);
  assert.equal(canvasDevicePx(0, 1), 1);
  assert.ok(Math.abs(toCssPx(1862, 1.5) - 1241.3333) < 0.01);
  assert.equal(toCssPx(0, 1.5), 0);
});

test('planFixedBands：与 0.3.0 tiled-capture 同口径（E2E footer dpr=1.5）', () => {
  const bands = planFixedBands({ metrics: { fixedTopHeight: 56, fixedBottomHeight: 80 }, dpr: 1.5, deviceHeight: 22500 });
  assert.equal(bands.measured, true);
  assert.equal(bands.cssHeight, 15000);
  assert.equal(bands.fixedTop, 84);
  assert.equal(bands.fixedBottom, 120);
  const dpr1 = planFixedBands({ metrics: { fixedTopHeight: 56, fixedBottomHeight: 80 }, dpr: 1, deviceHeight: 15000 });
  assert.equal(dpr1.fixedTop, 56);
  assert.equal(dpr1.fixedBottom, 80);
});

test('planFixedBands：超过页高 1/3 的“固定元素”不算固定带；缺参数返回零', () => {
  const tall = planFixedBands({ metrics: { fixedTopHeight: 6000, fixedBottomHeight: 80 }, dpr: 1, deviceHeight: 15000 });
  assert.equal(tall.fixedTop, 0, '6000 > 15000/3，应视为整页容器而不是顶带');
  assert.equal(tall.fixedBottom, 80);
  const missing = planFixedBands({ metrics: null, dpr: 1, deviceHeight: 15000 });
  assert.equal(missing.measured, false);
  assert.equal(missing.fixedTop, 0);
  assert.equal(missing.fixedBottom, 0);
  const bad = planFixedBands({ metrics: { fixedTopHeight: 'x', fixedBottomHeight: NaN }, dpr: 1, deviceHeight: 15000 });
  assert.equal(bad.fixedTop, 0);
  assert.equal(bad.fixedBottom, 0);
  const disabled = planFixedBands({ metrics: { fixedTopHeight: 56 }, dpr: 1, deviceHeight: 15000, maxBandRatio: 0.001 });
  assert.equal(disabled.fixedTop, 0);
});

test('planFixedBands：透传最多 8 条 fixedBands 事实', () => {
  const fixedBands = Array.from({ length: 10 }, (_, index) => ({ edge: 'top', height: 10 + index, top: index, bottom: index + 1 }));
  const bands = planFixedBands({ metrics: { fixedTopHeight: 20, fixedBottomHeight: 10, fixedBands }, dpr: 1, deviceHeight: 15000 });
  assert.equal(bands.bands.length, 8);
  assert.equal(bands.bands[0].edge, 'top');
  assert.equal(bands.bands[9], undefined);
});

test('splitSegmentHeights：常规切段与“最后一段过小”重排', () => {
  assert.deepEqual(splitSegmentHeights(45000, { maxSegmentHeight: 40000, minSegmentHeight: 256 }), [40000, 5000]);
  assert.deepEqual(splitSegmentHeights(40000, { maxSegmentHeight: 40000, minSegmentHeight: 256 }), [40000]);
  assert.deepEqual(splitSegmentHeights(80000, { maxSegmentHeight: 40000, minSegmentHeight: 256 }), [40000, 40000]);
  assert.deepEqual(splitSegmentHeights(40001, { maxSegmentHeight: 40000, minSegmentHeight: 256 }), [20001, 20000]);
  assert.deepEqual(splitSegmentHeights(80001, { maxSegmentHeight: 40000, minSegmentHeight: 256 }), [26667, 26667, 26667]);
  assert.deepEqual(splitSegmentHeights(100, { maxSegmentHeight: 40000, minSegmentHeight: 256 }), [100]);
});

test('planLongshotSegments：45000@dpr1 → 2 段且自检通过', () => {
  const plan = planLongshotSegments({ deviceWidth: 1241, deviceHeight: 45000, dpr: 1, fixedTop: 84, fixedBottom: 120 });
  assert.equal(plan.ok, true);
  assert.equal(plan.totalSegments, 2);
  assert.equal(plan.dpr, 1);
  assert.equal(plan.fractional, false);
  assert.equal(plan.fixedTop, 84);
  assert.equal(plan.fixedBottom, 120);
  const [first, last] = plan.segments;
  assert.equal(first.index, 0);
  assert.equal(first.pageY, 0);
  assert.equal(first.pageHeight, 40000);
  assert.equal(first.y, 0);
  assert.equal(first.height, 40000);
  assert.equal(first.fixedTop, 84);
  assert.equal(first.fixedBottom, 0);
  assert.equal(first.role, 'first');
  assert.equal(last.index, 1);
  assert.equal(last.pageY, 40000);
  assert.equal(last.pageHeight, 5000);
  assert.equal(last.y, 40000);
  assert.equal(last.height, 5000);
  assert.equal(last.fixedTop, 0);
  assert.equal(last.fixedBottom, 120);
  assert.equal(last.role, 'last');
  assert.deepEqual(validateSegmentPlan(plan), { ok: true, errors: [], covered: 45000, height: 45000 });
  assert.match(describeSegmentPlan(plan), /2 段 \(40000\+5000, dpr=1, 顶 84\/底 120\)/);
});

test('planLongshotSegments：分数 DPR 保留 CSS/设备双坐标', () => {
  const plan = planLongshotSegments({ deviceWidth: 1862, deviceHeight: 22500, dpr: 1.5 });
  assert.equal(plan.totalSegments, 1);
  assert.equal(plan.fractional, true);
  const segment = plan.segments[0];
  assert.equal(segment.dpr, 1.5);
  assert.equal(segment.fractionalDpr, true);
  assert.equal(segment.cssY, 0);
  assert.equal(segment.cssHeight, 15000);
  assert.equal(segment.captureCssY, 0);
  assert.equal(segment.role, 'single');
  assert.match(plan.notes.join('|'), /分数 DPR/);
});

test('planLongshotSegments：重叠区只影响绘制起点，不重复覆盖页面', () => {
  const plan = planLongshotSegments({ deviceWidth: 1241, deviceHeight: 45000, dpr: 1, overlap: 512, fixedTop: 84, fixedBottom: 120 });
  assert.equal(plan.overlap, 512);
  const [first, last] = plan.segments;
  assert.equal(first.overlapTop, 0);
  assert.equal(last.overlapTop, 512);
  assert.equal(last.pageY, 40000);
  assert.equal(last.y, 40000 - 512);
  assert.equal(last.offsetY, 39488);
  assert.equal(last.height, 5000 + 512);
  assert.equal(last.drawY + last.drawHeight, 40000 + 5000);
  const validation = validateSegmentPlan(plan);
  assert.equal(validation.ok, true);
  assert.equal(validation.covered, 45000);
  assert.match(plan.notes.join('|'), /段间重叠 512/);
});

test('planLongshotSegments：重叠区不能越过页面顶部', () => {
  const plan = planLongshotSegments({ deviceWidth: 100, deviceHeight: 300, dpr: 1, overlap: 500, maxSegmentHeight: 200, minSegmentHeight: 1 });
  assert.equal(plan.totalSegments, 2);
  assert.equal(plan.segments[0].overlapTop, 0);
  assert.ok(plan.segments[1].overlapTop <= plan.segments[1].pageY);
  assert.ok(plan.segments[1].overlapTop < plan.segments[0].pageHeight);
  assert.equal(validateSegmentPlan(plan).ok, true);
});

test('planLongshotSegments：固定带高度不超过段高', () => {
  const plan = planLongshotSegments({ deviceWidth: 100, deviceHeight: 12000, dpr: 1, fixedTop: 99999, fixedBottom: 99999, maxSegmentHeight: 10000 });
  const [first, last] = plan.segments;
  assert.equal(first.fixedTop, 10000);
  assert.equal(last.fixedBottom, 2000);
  assert.equal(validateSegmentPlan(plan).ok, true);
});

test('tileRectsForSegment：分数 DPR 下本地/设备/CSS 坐标一致', () => {
  const plan = planLongshotSegments({ deviceWidth: 1000, deviceHeight: 1000, dpr: 1.5 });
  const segment = plan.segments[0];
  const rects = tileRectsForSegment(segment, 512);
  assert.equal(rects.length, 4, '2x2 tile');
  const first = rects[0];
  assert.deepEqual({ x: first.x, y: first.y, width: first.width, height: first.height }, { x: 0, y: 0, width: 512, height: 512 });
  assert.equal(first.deviceY, 0);
  assert.equal(first.cssX, 0);
  assert.equal(first.cssY, 0);
  assert.ok(Math.abs(first.cssWidth - 512 / 1.5) < 1e-9);
  const corner = rects[3];
  assert.equal(corner.x, 512);
  assert.equal(corner.y, 512);
  assert.equal(corner.width, 488);
  assert.equal(corner.height, 488);
  assert.ok(Math.abs(corner.cssY - 512 / 1.5) < 1e-9);
  assert.ok(Math.abs(corner.cssWidth - 488 / 1.5) < 1e-9);
});

test('tileRectsForSegment：段绘制起点参与设备坐标换算（含重叠区）', () => {
  const plan = planLongshotSegments({ deviceWidth: 100, deviceHeight: 300, dpr: 1, overlap: 50, maxSegmentHeight: 200, minSegmentHeight: 1 });
  const last = plan.segments[1];
  const rects = tileRectsForSegment(last, 100);
  assert.equal(rects[0].y, 0);
  assert.equal(rects[0].deviceY, last.drawY);
  assert.ok(rects.length >= 2);
});

test('bandRedrawRect：顶带贴段顶、底带贴段底', () => {
  const plan = planLongshotSegments({ deviceWidth: 1241, deviceHeight: 45000, dpr: 1, fixedTop: 84, fixedBottom: 120 });
  assert.deepEqual(bandRedrawRect(plan.segments[0], 'top'), { x: 0, y: 0, width: 1241, height: 84 });
  assert.equal(bandRedrawRect(plan.segments[0], 'bottom'), null);
  assert.deepEqual(bandRedrawRect(plan.segments[1], 'bottom'), { x: 0, y: 5000 - 120, width: 1241, height: 120 });
  assert.equal(bandRedrawRect(plan.segments[1], 'top'), null);
  assert.equal(bandRedrawRect(plan.segments[0], 'left'), null);
  assert.equal(bandRedrawRect(null, 'top'), null);
});

test('locateSegment/segmentsOverlapping：页面 y 定位到段与局部坐标', () => {
  const plan = planLongshotSegments({ deviceWidth: 1241, deviceHeight: 45000, dpr: 1 });
  assert.equal(locateSegment(plan, 0).index, 0);
  assert.equal(locateSegment(plan, 39999).index, 0);
  assert.equal(locateSegment(plan, 40000).index, 1);
  assert.equal(locateSegment(plan, 40000).localY, 0);
  assert.equal(locateSegment(plan, 44999).index, 1);
  assert.equal(locateSegment(plan, 45000), null);
  assert.equal(locateSegment(plan, -5).index, 0);
  assert.equal(locateSegment(null, 0), null);
  assert.deepEqual(segmentsOverlapping(plan, { pageY: 39000, pageHeight: 2000 }).map((item) => item.index), [0, 1]);
  assert.deepEqual(segmentsOverlapping(plan, { pageY: 40000, pageHeight: 10 }).map((item) => item.index), [1]);
  assert.deepEqual(segmentsOverlapping(plan, { pageY: 0, pageHeight: 0 }).map((item) => item.index), [0]);
  assert.deepEqual(segmentsOverlapping(plan, { pageY: 50000, pageHeight: 1 }), []);
});

test('validateSegmentPlan：能抓出段起点断层/固定带错位/覆盖不足', () => {
  const base = planLongshotSegments({ deviceWidth: 100, deviceHeight: 45000, dpr: 1, fixedTop: 10, fixedBottom: 10 });
  const tampered = JSON.parse(JSON.stringify(base));
  tampered.segments[1].pageY -= 1;
  const gap = validateSegmentPlan(tampered);
  assert.equal(gap.ok, false);
  assert.ok(gap.errors.some((error) => error.code === 'gap'));
  const band = JSON.parse(JSON.stringify(base));
  band.segments[1].fixedTop = 10;
  assert.ok(validateSegmentPlan(band).errors.some((error) => error.code === 'band-top'));
  const shrunk = JSON.parse(JSON.stringify(base));
  shrunk.segments.pop();
  assert.ok(validateSegmentPlan(shrunk).errors.some((error) => error.code === 'coverage'));
  assert.equal(validateSegmentPlan(null).ok, false);
  assert.equal(validateSegmentPlan(null).errors[0].code, 'not-plan');
});

test('segmentPlanWire：每段输出 {index,y,height,dpr,fixedTop,fixedBottom}', () => {
  const plan = planLongshotSegments({ deviceWidth: 1241, deviceHeight: 45000, dpr: 1, fixedTop: 84, fixedBottom: 120 });
  const wire = segmentPlanWire(plan.segments[0]);
  for (const key of ['index', 'y', 'height', 'dpr', 'fixedTop', 'fixedBottom']) {
    assert.ok(Object.prototype.hasOwnProperty.call(wire, key), '缺少字段 ' + key);
  }
  assert.deepEqual(
    { index: wire.index, y: wire.y, height: wire.height, dpr: wire.dpr, fixedTop: wire.fixedTop, fixedBottom: wire.fixedBottom },
    { index: 0, y: 0, height: 40000, dpr: 1, fixedTop: 84, fixedBottom: 0 },
  );
  assert.equal(segmentPlanWire(null), null);
  assert.equal(segmentPlanWire(plan.segments[1]).y, 40000);
});

test('describeSegmentPlan：空规划与非空规划', () => {
  assert.equal(describeSegmentPlan(null), '无分段');
  assert.equal(describeSegmentPlan({ segments: [] }), '无分段');
  const plan = planLongshotSegments({ deviceWidth: 100, deviceHeight: 45000, dpr: 1, overlap: 64 });
  assert.match(describeSegmentPlan(plan), /2 段/);
  assert.match(describeSegmentPlan(plan), /重叠 64/);
});

test('SEGMENT_DEFAULTS：默认段高/最小段高/固定带比例', () => {
  assert.equal(SEGMENT_DEFAULTS.maxSegmentHeight, 40000);
  assert.equal(SEGMENT_DEFAULTS.minSegmentHeight, 256);
  assert.equal(SEGMENT_DEFAULTS.overlap, 0);
  assert.equal(SEGMENT_DEFAULTS.maxBandRatio, 1 / 3);
});
