import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LONG_SHOT_DEGRADE_ACTIONS,
  LONG_SHOT_DEGRADE_LADDER,
  LONG_SHOT_DEGRADE_VERSION,
  applyLongshotDegrade,
  degradeLevelOf,
  describeLongshotDegrade,
  longshotDegradeWire,
  planLongshotDegrade,
  restoreLongshotParams,
} from '../../extension/src/lib/longshot-degrade.js';

test('planLongshotDegrade：预算内 → continue（不降级）', () => {
  const plan = planLongshotDegrade({ scrollWidth: 1241, scrollHeight: 800, dpr: 1 });
  assert.equal(plan.ok, true);
  assert.equal(plan.action, 'continue');
  assert.equal(plan.level, 'none');
  assert.deepEqual(plan.steps, []);
  assert.equal(plan.version, LONG_SHOT_DEGRADE_VERSION);
  assert.match(describeLongshotDegrade(plan), /未超限/);
});

test('planLongshotDegrade：超预算按阶梯降级（记录每级收益）', () => {
  // 500000 CSS 高 @ dpr3 → 设备高 1.5M > maxTotalDeviceHeight 160000，必须降级/截断。
  const plan = planLongshotDegrade({ scrollWidth: 2000, scrollHeight: 500000, dpr: 3 });
  assert.ok(['degrade', 'truncate'].includes(plan.action), plan.action);
  assert.ok(plan.steps.length > 0);
  assert.ok(plan.after.megabytes <= plan.before.megabytes);
  for (const step of plan.steps) {
    assert.ok(LONG_SHOT_DEGRADE_LADDER.some((item) => item.step === step.step) || step.step === 'segmentHeight');
    assert.ok(step.after.totalPixels <= step.before.totalPixels);
  }
  assert.ok(plan.reasons.length > 0);
  assert.equal(plan.truncated, plan.action === 'truncate' || plan.after.truncated === true);
});

test('planLongshotDegrade：自定义预算下 overlap/tile/bands/frames 依次生效', () => {
  // 1000 CSS 宽 @dpr3、30000 CSS 高：raw = 3000x90000 = 270M 像素，60M 预算下必须降级。
  const plan = planLongshotDegrade({
    scrollWidth: 1000,
    scrollHeight: 30000,
    dpr: 3,
    overlap: 64,
    keepBands: true,
    maxTiles: 64,
    budget: {
      maxTotalPixels: 60_000_000,
      maxTotalDeviceHeight: 400000,
      maxDeviceDimension: 40000,
      minDpr: 1,
      maxDpr: 3,
    },
  });
  assert.equal(plan.action, 'degrade', plan.action + ':' + plan.reasons.join('|'));
  const steps = plan.steps.map((step) => step.step);
  assert.equal(steps[0], 'overlap', JSON.stringify(steps));
  assert.ok(steps.includes('dpr'), JSON.stringify(steps));
  assert.ok(plan.after.totalPixels <= 60_000_000, '降级后像素 ' + plan.after.totalPixels + ' 应回到预算内');
  assert.ok(plan.after.totalPixels < plan.before.totalPixels);
  // 非 DPR 步骤不重复
  assert.equal(steps.filter((step) => step === 'tileSize').length <= 1, true);
  const applied = applyLongshotDegrade({ overlap: 64, tileSize: 512, keepBands: true, maxTiles: 64, dpr: 3 }, plan);
  assert.equal(applied.overlap, 0);
  assert.ok(applied.dpr < 3);
  assert.equal(applied.degradedLevel, plan.level);
  assert.equal(applied.degradedAction, plan.action);
});

test('planLongshotDegrade：重拍超宽无法降级 → abort', () => {
  const plan = planLongshotDegrade({
    scrollWidth: 100000,
    scrollHeight: 1000,
    dpr: 3,
    budget: { maxDeviceDimension: 40000, maxTotalPixels: 400_000_000, maxTotalDeviceHeight: 160000, minDpr: 1 },
  });
  assert.equal(plan.action, 'abort');
  assert.equal(plan.ok, false);
  assert.ok(plan.reasons.some((reason) => reason.includes('超过上限')));
  assert.equal(degradeLevelOf(plan), 'abort');
});

test('planLongshotDegrade：估算已截断时如实标 truncate', () => {
  const plan = planLongshotDegrade({
    scrollWidth: 1241,
    scrollHeight: 300000,
    dpr: 2,
  });
  // 300000*2 = 600000 > 160000 上限 → 估算侧截断
  assert.equal(plan.action, 'truncate');
  assert.equal(plan.truncated, true);
  assert.equal(degradeLevelOf(plan), 'truncate');
});

test('restoreLongshotParams：按阶梯反向还原原始请求', () => {
  const plan = {
    steps: [
      { step: 'overlap', from: 64, to: 0 },
      { step: 'tileSize', from: 512, to: 384 },
      { step: 'dpr', from: 2, to: 1.5 },
    ],
    action: 'degrade',
    level: 'dpr',
  };
  assert.deepEqual(restoreLongshotParams(plan), { dpr: 2, tileSize: 512, overlap: 64 });
  assert.deepEqual(restoreLongshotParams(null), {});
});

test('longshotDegradeWire：协议字段（steps/before/after/truncated）', () => {
  const plan = planLongshotDegrade({ scrollWidth: 1241, scrollHeight: 300000, dpr: 2 });
  const wire = longshotDegradeWire(plan);
  assert.equal(wire.version, LONG_SHOT_DEGRADE_VERSION);
  assert.equal(wire.action, 'truncate');
  assert.equal(wire.truncated, true);
  assert.ok(wire.before && wire.after);
  assert.ok(wire.reasons.length > 0);
  const empty = longshotDegradeWire(null);
  assert.equal(empty.action, 'continue');
  assert.deepEqual(empty.steps, []);
  assert.ok(LONG_SHOT_DEGRADE_ACTIONS.includes(wire.action));
});

test('degradeLevelOf/describeLongshotDegrade：级别与日志', () => {
  assert.equal(degradeLevelOf(null), 'none');
  assert.equal(degradeLevelOf({ action: 'continue' }), 'none');
  assert.equal(degradeLevelOf({ action: 'degrade', level: 'dpr' }), 'dpr');
  const plan = planLongshotDegrade({ scrollWidth: 2000, scrollHeight: 500000, dpr: 3 });
  assert.match(describeLongshotDegrade(plan), /长截图预算降级/);
  assert.match(describeLongshotDegrade(null), /无降级规划/);
});

test('阶梯顺序稳定（文档/日志按这个顺序解释）', () => {
  assert.deepEqual(LONG_SHOT_DEGRADE_LADDER.map((item) => item.step), [
    'overlap', 'tileSize', 'bands', 'frames', 'dpr', 'segmentHeight',
  ]);
});
