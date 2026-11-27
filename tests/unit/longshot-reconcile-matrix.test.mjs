// tests/unit/longshot-reconcile-matrix.test.mjs
// 第十一批-E 矩阵：帧对账 × DPR/固定带/重叠/夹取的组合，验证结论确定且不抛。
import test from 'node:test';
import assert from 'node:assert/strict';

import { planLongshotSegments } from '../../extension/src/lib/longshot-segments.js';
import {
  LONGSHOT_FRAME_CODES,
  describeLongshotFrames,
  planFrameRepairs,
  reconcileLongshotFrames,
} from '../../extension/src/lib/longshot-frame-reconcile.js';
import { planLongshotRepaint } from '../../extension/src/lib/longshot-repaint.js';

const DPRS = [1, 1.25, 1.5, 2, 2.625];

function tilesFromPlan(plan, { missing = [], shift = 0, dropBands = false } = {}) {
  return plan.segments
    .filter((segment) => !missing.includes(segment.index))
    .map((segment) => ({
      index: segment.index,
      drawY: segment.drawY + shift,
      pageY: segment.pageY + shift,
      height: segment.drawHeight,
      pageHeight: segment.pageHeight,
      width: segment.width,
      bytes: 1000,
      hash: 'hash' + segment.index,
      fixedTop: dropBands ? 0 : segment.fixedTop,
      fixedBottom: dropBands ? 0 : segment.fixedBottom,
    }));
}

test('矩阵：5 档 DPR 下完整分段 → ok/accept，finding=0', () => {
  for (const dpr of DPRS) {
    const plan = planLongshotSegments({
      deviceWidth: Math.round(1241 * dpr),
      deviceHeight: Math.round(22500 * dpr),
      dpr,
      fixedTop: Math.round(56 * dpr),
      fixedBottom: Math.round(80 * dpr),
    });
    const report = reconcileLongshotFrames({ plan, tiles: tilesFromPlan(plan) });
    assert.equal(report.ok, true, 'dpr=' + dpr);
    assert.equal(report.action, 'accept', 'dpr=' + dpr);
    assert.equal(report.severity, 'none', 'dpr=' + dpr);
    assert.match(describeLongshotFrames(report), /ok/);
  }
});

test('矩阵：缺中间段 → repaint-selective（有可复用帧）且修复目标=缺号', () => {
  const plan = planLongshotSegments({ deviceWidth: 1241, deviceHeight: 100_000, dpr: 1, maxSegmentHeight: 20_000, minSegmentHeight: 256 });
  assert.ok(plan.totalSegments >= 3);
  const report = reconcileLongshotFrames({ plan, tiles: tilesFromPlan(plan, { missing: [1] }) });
  assert.ok(['repaint-missing', 'repaint-selective'].includes(report.action));
  const repairs = planFrameRepairs(report);
  assert.ok(repairs.some((item) => item.index === 1), '缺失段必须进重绘目标');
});

test('矩阵：段整体偏移（drawY 平移）→ misaligned + 重绘目标覆盖全部段', () => {
  const plan = planLongshotSegments({ deviceWidth: 1241, deviceHeight: 45_000, dpr: 1 });
  const report = reconcileLongshotFrames({ plan, tiles: tilesFromPlan(plan, { shift: 7 }), tolerance: 0 });
  assert.equal(report.ok, false);
  assert.ok(report.mismatched.length >= 1);
  const repairs = planFrameRepairs(report);
  assert.ok(repairs.length >= 1);
  assert.ok(repairs.every((item) => item.reasons.length >= 1));
});

test('矩阵：固定带丢失 → warn（ok 不变），但不进重绘目标（信息级）', () => {
  const plan = planLongshotSegments({ deviceWidth: 1241, deviceHeight: 22_500, dpr: 1.5, fixedTop: 84, fixedBottom: 120 });
  const report = reconcileLongshotFrames({ plan, tiles: tilesFromPlan(plan, { dropBands: true }) });
  assert.equal(report.ok, true);
  const bandFindings = report.findings.filter((finding) => finding.code === LONGSHOT_FRAME_CODES.BAND_MISSING);
  assert.equal(bandFindings.length >= 2, true, '首段顶带 + 末段底带都丢失');
  const repairs = planFrameRepairs(report);
  assert.equal(repairs.length >= 1, true, '固定带缺失也值得重绘（warn 级目标）');
  assert.ok(repairs.some((item) => (item.reasons || []).some((reason) => String(reason).startsWith('band:'))));
});

test('矩阵：重叠段位置正确 → 无 seam 错误；位置错误 → SEAM_OVERLAP', () => {
  const plan = planLongshotSegments({
    deviceWidth: 800,
    deviceHeight: 60_000,
    dpr: 1,
    maxSegmentHeight: 30_000,
    overlap: 600,
  });
  assert.equal(plan.overlap, 600);
  const correct = reconcileLongshotFrames({ plan, tiles: tilesFromPlan(plan) });
  assert.equal(correct.ok, true, '按计划重叠落盘不应报错');
  const wrong = tilesFromPlan(plan);
  wrong[1].drawY -= 50;
  const report = reconcileLongshotFrames({ plan, tiles: wrong });
  assert.ok(report.findings.some((finding) => finding.code === LONGSHOT_FRAME_CODES.SEAM_OVERLAP));
});

test('矩阵：帧顶到画布外 → CLAMPED；总高未知时不误报', () => {
  const plan = planLongshotSegments({ deviceWidth: 800, deviceHeight: 5000, dpr: 1 });
  const tiles = tilesFromPlan(plan);
  tiles[0].drawY = 4990;
  const report = reconcileLongshotFrames({ plan, tiles, totalHeight: 5000 });
  assert.ok(report.findings.some((finding) => finding.code === LONGSHOT_FRAME_CODES.CLAMPED));
  const expectedNoTotal = plan.segments.map((segment) => ({
    index: segment.index,
    pageY: segment.pageY,
    pageHeight: segment.pageHeight,
    drawY: segment.drawY,
    drawHeight: segment.drawHeight,
    width: segment.width,
  }));
  const noTotal = reconcileLongshotFrames({ expected: expectedNoTotal, tiles });
  assert.equal(noTotal.findings.some((finding) => finding.code === LONGSHOT_FRAME_CODES.CLAMPED), false, '总高未知时不能猜夹取');
});

test('矩阵：对账 → 重绘计划确定性（同输入两次 digest 一致）', () => {
  const plan = planLongshotSegments({ deviceWidth: 1241, deviceHeight: 90_000, dpr: 1.5, fixedTop: 84, fixedBottom: 120 });
  const tiles = tilesFromPlan(plan, { missing: [0], shift: 3 });
  const first = reconcileLongshotFrames({ plan, tiles, now: 111 });
  const second = reconcileLongshotFrames({ plan, tiles, now: 222 });
  assert.equal(first.capturedSignature, second.capturedSignature);
  const repairs = planFrameRepairs(first);
  const repaintA = planLongshotRepaint({ repairs }, { dpr: 1.5, width: plan.width, now: 111 });
  const repaintB = planLongshotRepaint({ repairs }, { dpr: 1.5, width: plan.width, now: 222 });
  assert.equal(repaintA.digest, repaintB.digest);
  assert.deepEqual(repaintA.counts, repaintB.counts);
});

test('矩阵：空计划/空 tile/全量非法输入不抛', () => {
  const empty = reconcileLongshotFrames({ plan: { segments: [] }, tiles: [] });
  assert.equal(empty.action, 'nothing');
  const garbage = reconcileLongshotFrames({
    plan: { segments: [null, 1, 'x'] },
    tiles: [null, 1, 'x'],
  });
  assert.equal(typeof garbage.ok, 'boolean');
  const noPlan = reconcileLongshotFrames({ tiles: [{ index: 0, drawY: 0, height: 100, width: 10 }] });
  assert.equal(noPlan.expectedFrames, 0);
  assert.equal(noPlan.extra.length, 1);
});
