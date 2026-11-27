import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DPR_DEFAULTS,
  DPR_PROFILES,
  alignCeil,
  alignFloor,
  alignRound,
  compensateClip,
  describeDprPlan,
  detectDprDrift,
  dprErrorTable,
  dprPlanWire,
  dprSignature,
  isFractionalDpr,
  normalizeDprForPlan,
  planDeviceSegments,
  planFractionalCanvas,
  quantizeDpr,
  tileClipsForSegment,
} from '../../extension/src/lib/longshot-dpr.js';

test('DPR_PROFILES：Chromium 常见档位齐全且单调', () => {
  assert.deepEqual(DPR_PROFILES.map((item) => item.dpr), [1, 1.25, 1.5, 1.75, 2, 2.5, 2.625, 3]);
  for (let index = 1; index < DPR_PROFILES.length; index += 1) {
    assert.ok(DPR_PROFILES[index].dpr > DPR_PROFILES[index - 1].dpr);
  }
});

test('quantizeDpr：命中档位/就近档位/越界收敛', () => {
  const exact = quantizeDpr(1.5);
  assert.equal(exact.dpr, 1.5);
  assert.equal(exact.exact, true);
  assert.equal(exact.delta, 0);
  const near = quantizeDpr(1.4);
  assert.equal(near.dpr, 1.5);
  assert.equal(near.exact, false);
  assert.equal(near.delta, 0.1);
  assert.equal(quantizeDpr(0.2).dpr, 1);
  assert.equal(quantizeDpr(9).dpr, 3);
  assert.equal(normalizeDprForPlan(1.5000004), 1.5);
});

test('isFractionalDpr：整数/分数判定', () => {
  assert.equal(isFractionalDpr(1), false);
  assert.equal(isFractionalDpr(2), false);
  assert.equal(isFractionalDpr(1.5), true);
  assert.equal(isFractionalDpr(2.625), true);
  assert.equal(isFractionalDpr(undefined), false);
});

test('alignFloor/alignCeil/alignRound：三种取整口径', () => {
  // 1241 CSS @1.5 = 1861.5 设备像素
  assert.equal(alignFloor(1241, 1.5), 1861);
  assert.equal(alignCeil(1241, 1.5), 1862);
  assert.equal(alignRound(1241, 1.5), 1862);
  assert.equal(alignFloor(0, 1.5), 0);
  assert.equal(alignCeil(-5, 1.5), 0);
  assert.equal(alignRound('x', 1.5), 0);
  // 浮点误差不应让 0.1+0.2 这种值多进一位
  assert.equal(alignCeil(0.2 * 3, 1.5), 1);
});

test('planDeviceSegments：分数 DPR 下段边界首尾相接（无缝隙无重叠）', () => {
  const plan = planDeviceSegments({ cssWidth: 1241, cssHeight: 22500, dpr: 1.5, maxSegmentCssHeight: 8000 });
  assert.equal(plan.ok, true);
  assert.equal(plan.fractional, true);
  assert.ok(plan.segments.length >= 3);
  let expectedY = 0;
  for (const segment of plan.segments) {
    assert.equal(segment.deviceY, expectedY, '段 ' + segment.index + ' 起点应等于上一段终点');
    assert.ok(segment.deviceHeight > 0);
    expectedY += segment.deviceHeight;
  }
  assert.equal(expectedY, plan.deviceHeight);
  assert.equal(plan.totalDeviceHeight, plan.deviceHeight);
  assert.ok(Math.abs(plan.deviceHeight - Math.ceil(22500 * 1.5) + (22500 * 1.5 % 1 ? 1 : 0)) <= 1 || plan.deviceHeight === 33750);
});

test('planDeviceSegments：CSS 高度/设备高度两种输入给出同一结果', () => {
  const fromCss = planDeviceSegments({ cssWidth: 800, cssHeight: 3000, dpr: 2, maxSegmentCssHeight: 1000 });
  const fromDevice = planDeviceSegments({ deviceWidth: 1600, deviceHeight: 6000, dpr: 2, maxSegmentCssHeight: 1000 });
  assert.equal(fromCss.deviceHeight, fromDevice.deviceHeight);
  assert.deepEqual(fromCss.segments.map((item) => item.deviceHeight), fromDevice.segments.map((item) => item.deviceHeight));
});

test('planDeviceSegments：最后一段过短时从上一段匀过来', () => {
  // 10000 CSS，段上限 9000 → 两段，最后一段 1000 不会过短；
  // 再用 90000/45000 这种“最后一段刚好略小”的场景确认不出现 1px 段。
  const plan = planDeviceSegments({ cssWidth: 100, cssHeight: 9001, dpr: 1, maxSegmentCssHeight: 9000 });
  assert.equal(plan.segments.length, 2);
  assert.ok(plan.segments[1].deviceHeight >= 1);
  assert.equal(plan.segments[0].deviceHeight + plan.segments[1].deviceHeight, plan.deviceHeight);
  const tiny = planDeviceSegments({ cssWidth: 100, cssHeight: 18001, dpr: 1, maxSegmentCssHeight: 9000, minSegmentCssHeight: 512 });
  assert.ok(tiny.segments.every((segment) => segment.deviceHeight >= 512), JSON.stringify(tiny.segments.map((s) => s.deviceHeight)));
});

test('planDeviceSegments：缺高度时 ok=false 并说明原因', () => {
  const plan = planDeviceSegments({ cssWidth: 100, dpr: 1 });
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.segments, []);
  assert.ok(plan.notes[0].includes('页面高度'));
});

test('planDeviceSegments：单段时 role=single，clip 用 CSS 小数坐标', () => {
  const plan = planDeviceSegments({ cssWidth: 1241, cssHeight: 800, dpr: 1.5 });
  assert.equal(plan.segments.length, 1);
  assert.equal(plan.segments[0].role, 'single');
  assert.equal(plan.segments[0].clip.y, 0);
  assert.equal(plan.segments[0].clip.width, 1241);
  assert.equal(plan.segments[0].deviceHeight, 1200);
});

test('dprErrorTable：误差被吸收在 1px 以内', () => {
  const plan = planDeviceSegments({ cssWidth: 1241, cssHeight: 24000, dpr: 2.625, maxSegmentCssHeight: 4000 });
  const table = dprErrorTable(plan);
  assert.equal(table.bounded, true);
  assert.ok(table.maxAbs < 1);
  assert.equal(table.rows.length, plan.segments.length);
  assert.ok(table.rows.every((row) => Number.isFinite(row.deltaY) && Number.isFinite(row.deltaHeight)));
});

test('planFractionalCanvas：分数 DPR 向上取整，超面积上限时裁剪', () => {
  const canvas = planFractionalCanvas({ cssWidth: 1241, cssHeight: 22500, dpr: 1.5 });
  assert.equal(canvas.width, 1862);
  assert.equal(canvas.height, 33750);
  assert.equal(canvas.clamped, false);
  assert.equal(canvas.fractional, true);
  const big = planFractionalCanvas({ cssWidth: 8000, cssHeight: 80000, dpr: 1, maxCanvasPixels: 10_000_000 });
  assert.equal(big.clamped, true);
  assert.ok(big.pixels <= 10_000_000);
  assert.ok(big.height < 80000);
  assert.ok(big.cssHeightCovered > 0);
});

test('compensateClip：起点向下、尺寸向上，返回设备像素证据', () => {
  const clip = compensateClip({ x: 0, y: 100.5, width: 1241, height: 800 }, 1.5);
  assert.equal(clip.scale, 1.5);
  assert.equal(clip.device.y, Math.floor(100.5 * 1.5));
  assert.equal(clip.device.height, Math.ceil((100.5 + 800) * 1.5) - Math.floor(100.5 * 1.5));
  // 尺寸除法再乘回来有 1e-6 级浮点误差（roundDpr 精度），不是取整错误。
  assert.ok(Math.abs(clip.height * 1.5 - clip.device.height) < 1e-5);
  assert.equal(clip.fractionalDpr, true);
  const exact = compensateClip({ x: 0, y: 10, width: 100, height: 50 }, 2);
  assert.equal(exact.device.x, 0);
  assert.equal(exact.device.y, 20);
  assert.equal(exact.device.width, 200);
  assert.equal(exact.resampled, false);
  const floorMode = compensateClip({ x: 0, y: 0, width: 100, height: 100 }, 1.5, { mode: 'floor' });
  assert.equal(floorMode.device.height, 150);
});

test('detectDprDrift：跨帧 DPR 变化检测与主导值', () => {
  const stable = detectDprDrift([{ dpr: 1.5 }, { dpr: 1.5 }, { dpr: 1.5 }]);
  assert.equal(stable.stable, true);
  assert.equal(stable.dominant, 1.5);
  const drift = detectDprDrift([{ dpr: 1 }, { dpr: 1.5 }, { dpr: 1.5 }]);
  assert.equal(drift.stable, false);
  assert.equal(drift.changes.length, 1);
  assert.equal(drift.changes[0].from, 1);
  assert.equal(drift.changes[0].to, 1.5);
  assert.equal(drift.dominant, 1.5);
  assert.equal(drift.agreement, 2 / 3);
  assert.equal(detectDprDrift([]).stable, true);
  assert.equal(detectDprDrift([1, 2]).changes.length, 1);
});

test('dprPlanWire/describeDprPlan/dprSignature：协议与日志', () => {
  const plan = planDeviceSegments({ cssWidth: 1241, cssHeight: 22500, dpr: 1.5, maxSegmentCssHeight: 8000 });
  const wire = dprPlanWire(plan);
  assert.equal(wire.ok, true);
  assert.equal(wire.dpr, 1.5);
  assert.equal(wire.fractional, true);
  assert.equal(wire.segments.length, 3);
  assert.equal(wire.deviceHeight, plan.deviceHeight);
  assert.equal(dprPlanWire(null).ok, false);
  assert.match(describeDprPlan(plan), /DPR 1\.5（分数）\s*3 段/);
  assert.match(describeDprPlan(plan), /无缝隙/);
  assert.match(describeDprPlan(null), /DPR 规划 空/);
  assert.match(dprSignature(plan), /^dpr:1\.5:0\+\d+,\d+\+\d+,\d+\+\d+$/);
  assert.equal(dprSignature(null), 'dpr:none');
});

test('tileClipsForSegment：按设备 tile 尺寸给出 CSS clip 列表', () => {
  const plan = planDeviceSegments({ cssWidth: 1241, cssHeight: 1600, dpr: 1.5, deviceHeight: 2400 });
  const segment = plan.segments[0];
  const clips = tileClipsForSegment(segment, 512);
  assert.ok(clips.length >= 5, '1600 CSS / (512/1.5 CSS) ≈ 4.7 片 → 5 片');
  assert.equal(clips[0].device.y, 0);
  assert.ok(clips.every((clip) => clip.device.height > 0));
  assert.deepEqual(tileClipsForSegment(null), []);
});

test('默认常量：maxCanvasPixels 与段高上限稳定', () => {
  assert.equal(DPR_DEFAULTS.maxCanvasPixels, 268435456);
  assert.equal(DPR_DEFAULTS.maxSegmentCssHeight, 40000);
});
