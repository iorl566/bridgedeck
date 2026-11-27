import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BAND_DEFAULTS,
  BAND_KINDS,
  bandConflicts,
  bandPlanWire,
  bandRedrawRectFor,
  bandSignature,
  bandStability,
  classifyBand,
  describeBandPlan,
  describeBandConflict,
  flattenBandRedraws,
  normalizeBand,
  normalizeBands,
  planBandRedraws,
  redrawableBands,
  resolveBandPlan,
} from '../../extension/src/lib/longshot-bands.js';
import { planLongshotSegments } from '../../extension/src/lib/longshot-segments.js';

function metricsOf(extra = {}) {
  return {
    scrollHeight: 15000,
    scrollWidth: 1241,
    innerWidth: 1241,
    innerHeight: 800,
    dpr: 1,
    fixedTopHeight: 56,
    fixedBottomHeight: 80,
    ...extra,
  };
}

test('normalizeBand：edge/position/高度归一化（CSS → 设备像素）', () => {
  const top = normalizeBand({ edge: 'top', height: 56, top: 0, bottom: 56 }, 0, { dpr: 1.5 });
  assert.equal(top.edge, 'top');
  assert.equal(top.position, 'fixed');
  assert.equal(top.cssHeight, 56);
  assert.equal(top.height, 84);
  const bottom = normalizeBand({ bottom: 40, height: 40, position: 'sticky' }, 1, { dpr: 2 });
  assert.equal(bottom.edge, 'bottom');
  assert.equal(bottom.position, 'sticky');
  assert.equal(bottom.height, 80);
  // 非法输入不抛，高度归零
  assert.equal(normalizeBand(null, 0, {}).height, 0);
  assert.equal(normalizeBand({ height: 'x' }, 0, {}).cssHeight, 0);
});

test('classifyBand：fixed/sticky/整页容器分类', () => {
  assert.equal(classifyBand({ edge: 'top', height: 84, position: 'fixed' }, { deviceHeight: 15000 }), 'fixed-top');
  assert.equal(classifyBand({ edge: 'bottom', height: 120, position: 'fixed' }, { deviceHeight: 15000 }), 'fixed-bottom');
  assert.equal(classifyBand({ edge: 'top', height: 84, position: 'sticky' }, { deviceHeight: 15000 }), 'sticky-top');
  assert.equal(classifyBand({ edge: 'bottom', height: 84, position: 'sticky' }, { deviceHeight: 15000 }), 'sticky-bottom');
  // 超过页高 1/3 → 整页容器
  assert.equal(classifyBand({ edge: 'top', height: 6000, position: 'fixed' }, { deviceHeight: 15000 }), 'whole-page');
  // 接近视口高度 → 整页容器
  assert.equal(classifyBand({ edge: 'top', height: 700, position: 'fixed' }, { deviceHeight: 15000, viewportHeight: 800 }), 'whole-page');
  assert.equal(classifyBand({ edge: 'top', height: 0, position: 'fixed' }, {}), 'none');
  assert.equal(classifyBand(null, {}), 'none');
  assert.deepEqual(BAND_KINDS.slice(0, 4), ['fixed-top', 'fixed-bottom', 'sticky-top', 'sticky-bottom']);
});

test('normalizeBands：只保留可重绘的带，整页元素进 dropped', () => {
  const result = normalizeBands(metricsOf({
    fixedBands: [
      { edge: 'top', height: 56 },
      { edge: 'bottom', height: 80 },
      { edge: 'top', height: 9000 },
      { edge: 'top', height: 0 },
    ],
  }), { dpr: 1.5, deviceHeight: 22500, viewportHeight: 1200 });
  assert.equal(result.measured, true);
  assert.equal(result.bands.length, 2);
  assert.equal(result.topDev, 84);
  assert.equal(result.bottomDev, 120);
  assert.deepEqual(result.dropped.map((item) => item.reason).sort(), ['no-height', 'whole-page']);
  assert.ok(result.notes.some((note) => note.includes('丢弃')));
});

test('normalizeBands：无 fixedBands 时按 fixedTopHeight/fixedBottomHeight 退化', () => {
  const result = normalizeBands(metricsOf(), { dpr: 2, deviceHeight: 30000 });
  assert.equal(result.bands.length, 2);
  assert.equal(result.topDev, 112);
  assert.equal(result.bottomDev, 160);
  assert.ok(result.notes.some((note) => note.includes('退化')));
});

test('normalizeBands：缺 metrics / 整页比例上限可覆盖', () => {
  const empty = normalizeBands(null, {});
  assert.equal(empty.measured, false);
  assert.deepEqual(empty.bands, []);
  assert.equal(empty.topDev, 0);
  // maxBandRatio 收紧后 56px 页眉在 100px 页高上也算整页元素
  const strict = normalizeBands(metricsOf({ scrollHeight: 80, fixedTopHeight: 56, fixedBottomHeight: 0 }), {
    dpr: 1,
    deviceHeight: 80,
    maxBandRatio: 0.5,
  });
  assert.equal(strict.bands.length, 0);
  assert.equal(strict.dropped[0].reason, 'whole-page');
});

test('normalizeBands：带数量上限截断并给出 dropped 证据', () => {
  const many = Array.from({ length: 12 }, (_, index) => ({ edge: index % 2 ? 'bottom' : 'top', height: 10 + index }));
  const result = normalizeBands(metricsOf({ fixedBands: many }), { dpr: 1, deviceHeight: 15000, maxBands: 4 });
  assert.equal(result.bands.length, 4);
  assert.ok(result.dropped.some((item) => item.reason === 'max-bands'));
});

test('planBandRedraws：fixed 顶带只在首段、fixed 底带只在末段', () => {
  const plan = planLongshotSegments({ deviceWidth: 1241, deviceHeight: 45000, dpr: 1, fixedTop: 56, fixedBottom: 80 });
  const bands = normalizeBands(metricsOf(), { dpr: 1, deviceHeight: 45000 }).bands;
  const redraws = planBandRedraws(plan, bands);
  assert.equal(redraws.ok, true);
  assert.equal(redraws.perSegment.length, 2);
  assert.equal(redraws.perSegment[0].redraws.length, 1);
  assert.equal(redraws.perSegment[0].redraws[0].edge, 'top');
  assert.equal(redraws.perSegment[0].redraws[0].rect.height, 56);
  assert.equal(redraws.perSegment[1].redraws.length, 1);
  assert.equal(redraws.perSegment[1].redraws[0].edge, 'bottom');
  assert.equal(redraws.perSegment[1].redraws[0].rect.y, 5000 - 80);
  assert.equal(redraws.total, 2);
});

test('planBandRedraws：sticky 带每段都重绘，且裁到段高内', () => {
  const plan = planLongshotSegments({ deviceWidth: 1241, deviceHeight: 45000, dpr: 1 });
  const bands = [
    { index: 0, edge: 'top', position: 'sticky', kind: 'sticky-top', height: 60 },
    { index: 1, edge: 'bottom', position: 'fixed', kind: 'fixed-bottom', height: 100 },
  ];
  const redraws = planBandRedraws(plan, bands);
  assert.equal(redraws.perSegment[0].redraws.filter((item) => item.sticky).length, 1);
  assert.equal(redraws.perSegment[1].redraws.filter((item) => item.sticky).length, 1);
  const tooTall = planBandRedraws({ segments: [{ index: 0, drawHeight: 40, width: 10, overlapTop: 0 }] }, [
    { index: 0, edge: 'top', position: 'fixed', kind: 'fixed-top', height: 100 },
  ]);
  assert.equal(tooTall.perSegment[0].redraws[0].height, 40);
});

test('planBandRedraws：没有带/没有段时返回空清单（不抛）', () => {
  assert.equal(planBandRedraws(null, []).total, 0);
  const empty = planBandRedraws({ segments: [{ index: 0, drawHeight: 100, width: 10 }] }, []);
  assert.equal(empty.perSegment.length, 1);
  assert.deepEqual(empty.perSegment[0].redraws, []);
});

test('bandConflicts：段高装不下 / 重叠覆盖 / 重复边', () => {
  const plan = {
    segments: [
      { index: 0, drawHeight: 100, width: 10, overlapTop: 0 },
      { index: 1, drawHeight: 100, width: 10, overlapTop: 50 },
    ],
  };
  const conflicts = bandConflicts(plan, [
    { index: 0, edge: 'top', position: 'fixed', height: 200 },
    { index: 1, edge: 'top', position: 'sticky', height: 40 },
    { index: 2, edge: 'bottom', position: 'fixed', height: 40 },
    { index: 3, edge: 'bottom', position: 'fixed', height: 40 },
  ]);
  const reasons = conflicts.conflicts.map((item) => item.reason);
  assert.ok(reasons.includes('exceeds-segment'));
  assert.ok(reasons.includes('overlap-cover'));
  assert.ok(reasons.includes('duplicate-edge'));
  assert.equal(conflicts.ok, false);
  assert.ok(conflicts.trimmed.length >= 1);
});

test('bandConflicts：正常带无冲突', () => {
  const plan = planLongshotSegments({ deviceWidth: 1241, deviceHeight: 45000, dpr: 1 });
  const bands = normalizeBands(metricsOf(), { dpr: 1, deviceHeight: 45000 }).bands;
  assert.equal(bandConflicts(plan, bands).ok, true);
});

test('bandStability：同一批带多次采样稳定；高度漂移给出建议值', () => {
  const stable = bandStability([
    metricsOf({ fixedTopHeight: 56 }),
    metricsOf({ fixedTopHeight: 56 }),
  ], { dpr: 1 });
  assert.equal(stable.stable, true);
  assert.equal(stable.suggested.top, 56);
  const drifted = bandStability([
    metricsOf({ fixedTopHeight: 56, fixedBands: [{ edge: 'top', height: 56 }] }),
    metricsOf({ fixedTopHeight: 20, fixedBands: [{ edge: 'top', height: 20 }] }),
    metricsOf({ fixedTopHeight: 20, fixedBands: [{ edge: 'top', height: 20 }] }),
  ], { dpr: 1, driftTolerance: 2 });
  assert.equal(drifted.stable, false);
  assert.ok(drifted.drifts.some((item) => item.field === 'height'));
  assert.equal(drifted.suggested.top, 20);
});

test('bandStability：空采样与签名', () => {
  const empty = bandStability([], {});
  assert.equal(empty.stable, true);
  assert.equal(empty.samples, 0);
  assert.equal(empty.signature, 'bands:none');
  assert.equal(bandSignature(null), 'bands:none');
  assert.equal(bandSignature([]), 'bands:none');
  assert.equal(bandSignature([{ edge: 'top', height: 84, position: 'fixed' }]), 'top/fixed/84/');
  assert.equal(bandSignature({ top: 84, bottom: 120, count: 2 }), 'bands:84x120x2');
});

test('resolveBandPlan：组合入口带重绘 + 冲突 + 稳定性 + 日志', () => {
  const plan = planLongshotSegments({ deviceWidth: 1241, deviceHeight: 45000, dpr: 1.5, fixedTop: 84, fixedBottom: 120 });
  const bandPlan = resolveBandPlan({
    metrics: metricsOf({ fixedBands: [{ edge: 'top', height: 56 }, { edge: 'bottom', height: 80 }] }),
    plan,
    samples: [metricsOf(), metricsOf()],
  });
  assert.equal(bandPlan.ok, true);
  assert.equal(bandPlan.bands.length, 2);
  assert.equal(bandPlan.redraws.total, 2);
  assert.equal(bandPlan.stability.stable, true);
  assert.match(describeBandPlan(bandPlan), /固定带 顶 84\/底 120/);
  const wire = bandPlanWire(bandPlan);
  assert.equal(wire.measured, true);
  assert.equal(wire.redraws, 2);
  assert.equal(wire.stable, true);
  assert.match(wire.signature, /^bottom\/fixed\/120/);
  assert.ok(redrawableBands(bandPlan).length === 2);
  assert.equal(flattenBandRedraws(bandPlan).length, 2);
  assert.deepEqual(flattenBandRedraws(bandPlan).map((item) => item.segment), [0, 1]);
});

test('resolveBandPlan：无 metrics/plan 也不抛，给空证据', () => {
  const empty = resolveBandPlan({});
  assert.equal(empty.measured, false);
  assert.deepEqual(empty.bands, []);
  assert.equal(empty.redraws.total, 0);
  assert.equal(bandPlanWire(null).measured, false);
  assert.equal(describeBandPlan(null), '固定带 无');
  assert.equal(describeBandPlan({}), '固定带 无');
});

test('describeBandConflict：每种原因都有中文说明', () => {
  assert.match(describeBandConflict({ reason: 'exceeds-segment', edge: 'top', index: 1, height: 200, drawHeight: 100 }), /第 1 段顶带/);
  assert.match(describeBandConflict({ reason: 'sum-exceeds-segment', edge: 'bottom', used: 80, height: 40 }), /累加超过段高/);
  assert.match(describeBandConflict({ reason: 'overlap-cover', edge: 'top', overlapTop: 50 }), /重叠区/);
  assert.match(describeBandConflict({ reason: 'duplicate-edge', edge: 'bottom' }), /重复登记/);
  assert.match(describeBandConflict({ reason: 'weird' }), /冲突：weird/);
  assert.match(describeBandConflict(null), /未知固定带冲突/);
});

test('默认值常量稳定（运行时日志/协议依赖）', () => {
  assert.equal(BAND_DEFAULTS.maxBands, 8);
  assert.equal(BAND_DEFAULTS.driftTolerance, 2);
  assert.ok(Math.abs(BAND_DEFAULTS.maxBandRatio - 1 / 3) < 1e-9);
});

test('bandRedrawRectFor：按段取出顶/底带矩形（sticky 每段可取）', () => {
  const bandPlan = resolveBandPlan({
    metrics: metricsOf({ fixedBands: [{ edge: 'top', height: 56 }, { edge: 'bottom', height: 80 }] }),
    plan: planLongshotSegments({ deviceWidth: 1241, deviceHeight: 45000, dpr: 1, fixedTop: 56, fixedBottom: 80 }),
  });
  const top = bandRedrawRectFor(bandPlan, 0, 'top');
  assert.deepEqual(top, { x: 0, y: 0, width: 1241, height: 56 });
  assert.equal(bandRedrawRectFor(bandPlan, 0, 'bottom'), null);
  const bottom = bandRedrawRectFor(bandPlan, 1, 'bottom');
  assert.equal(bottom.y, 5000 - 80);
  assert.equal(bandRedrawRectFor(bandPlan, 9, 'top'), null);
});
