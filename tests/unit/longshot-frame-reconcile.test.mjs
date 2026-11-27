// tests/unit/longshot-frame-reconcile.test.mjs
// 第十一批-E：长截图帧级对账（lib/longshot-frame-reconcile.js）。
// 覆盖：段→帧身份、期望帧/实采帧反建、专项检查（固定带/接缝/尾部/夹取/角色）、
//       对账结论→重绘目标、manifest 自对账、wire/describe、空输入降级。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LONGSHOT_FRAME_CODES,
  LONGSHOT_RECONCILE_VERSION,
  capturedFramesFromTiles,
  describeLongshotFrames,
  expectedFramesFromSegments,
  longshotFrameWire,
  planFrameRepairs,
  reconcileLongshotFrames,
  reconcileManifestFrames,
  segmentFrame,
  segmentFrameIdentity,
} from '../../extension/src/lib/longshot-frame-reconcile.js';

function segment(index, pageY, pageHeight, extra = {}) {
  return {
    index,
    role: extra.role || (index === 0 ? 'first' : 'middle'),
    pageY,
    pageHeight,
    drawY: pageY,
    drawHeight: pageHeight,
    width: 800,
    dpr: 1,
    fixedTop: extra.fixedTop || 0,
    fixedBottom: extra.fixedBottom || 0,
    overlapTop: extra.overlapTop || 0,
    ...extra,
  };
}

test('常量与版本', () => {
  assert.equal(LONGSHOT_RECONCILE_VERSION, 1);
  for (const code of Object.values(LONGSHOT_FRAME_CODES)) assert.match(code, /^longshot\.frame\./);
});

test('segmentFrame：把段的固定带/重叠/角色带进帧事实', () => {
  const frame = segmentFrame(segment(0, 0, 200, { fixedTop: 20, overlapTop: 0 }), { dpr: 1.5 });
  assert.equal(frame.kind, 'longshot-segment');
  assert.equal(frame.index, 0);
  assert.equal(frame.role, 'first');
  assert.equal(frame.dpr, 1.5);
  assert.equal(frame.meta.fixedTop, 20);
  assert.ok(frame.flags.includes('fixed-top'));
  assert.equal(frame.state, 'planned');
  const captured = segmentFrame(segment(1, 200, 100, { fixedBottom: 10 }), { captured: true });
  assert.equal(captured.state, 'captured');
  assert.ok(captured.flags.includes('fixed-bottom'));
  assert.equal(captured.meta.source, 'disk');
  assert.equal(segmentFrame(null), null);
});

test('segmentFrameIdentity：稳定 frame_id/frame_sig/角色/带', () => {
  const identity = segmentFrameIdentity(segment(2, 400, 200, { fixedBottom: 12 }));
  assert.equal(identity.frame_id, 'longshot-segment#2');
  assert.match(identity.frame_sig, /^[0-9a-f]{16}$/);
  assert.equal(identity.frame_role, 'middle');
  assert.equal(identity.frame_band, 'bottom');
  const missing = segmentFrameIdentity(null);
  assert.equal(missing.frame_id, 'longshot-segment#0');
  assert.match(missing.frame_sig, /^[0-9a-f]{16}$/);
});

test('expectedFramesFromSegments：角色/固定带/坐标按段计划派生', () => {
  const frames = expectedFramesFromSegments({
    dpr: 1,
    segments: [segment(0, 0, 200, { fixedTop: 20 }), segment(1, 200, 100, { fixedBottom: 10 })],
  });
  assert.equal(frames.length, 2);
  assert.equal(frames[0].state, 'planned');
  assert.equal(frames[0].meta.fixedTop, 20);
  assert.equal(frames[1].pageY, 200);
  assert.equal(frames[1].meta.fixedBottom, 10);
  assert.deepEqual(expectedFramesFromSegments(null), []);
});

test('capturedFramesFromTiles：只有 drawY/height 的恢复 tile 也能反建（derived 标记）', () => {
  const frames = capturedFramesFromTiles([
    { index: 0, drawY: 0, height: 100, width: 800, bytes: 10, hash: 'AABBCCDD' },
    { index: 1, drawY: 100, height: 50, width: 800, bytes: 20 },
  ], { dpr: 1.5 });
  assert.equal(frames.length, 2);
  assert.equal(frames[0].dpr, 1.5);
  assert.equal(frames[0].hash, 'aabbccdd');
  assert.equal(frames[0].meta.derived, true);
  assert.equal(frames[0].meta.source, 'tile');
  assert.deepEqual(capturedFramesFromTiles(null), []);
});

test('reconcileLongshotFrames：完全一致 → ok/accept，findings=0', () => {
  const plan = {
    dpr: 1,
    width: 800,
    height: 300,
    segments: [segment(0, 0, 200, { fixedTop: 20 }), segment(1, 200, 100, { role: 'last', fixedBottom: 10, fixedTop: 0 })],
  };
  const tiles = [
    { index: 0, drawY: 0, height: 200, width: 800, bytes: 10, fixedTop: 20 },
    { index: 1, drawY: 200, height: 100, width: 800, bytes: 10, fixedBottom: 10 },
  ];
  const report = reconcileLongshotFrames({ plan, tiles });
  assert.equal(report.scope, 'longshot');
  assert.equal(report.ok, true);
  assert.equal(report.action, 'accept');
  assert.equal(report.findingCount, 0);
  assert.equal(report.severity, 'none');
  assert.equal(report.coverage.ratio, 1);
  assert.deepEqual(report.band, { top: [0], bottom: [1] });
});

test('reconcileLongshotFrames：固定带丢失 → warn finding，但基础对账仍 ok', () => {
  const plan = { dpr: 1, width: 800, height: 200, segments: [segment(0, 0, 200, { fixedTop: 20 })] };
  const tiles = [{ index: 0, drawY: 0, height: 200, width: 800, bytes: 10 }];
  const report = reconcileLongshotFrames({ plan, tiles });
  assert.equal(report.base === undefined, true);
  assert.equal(report.ok, true, 'warn 级不翻转 ok');
  assert.equal(report.warnCount, 1);
  assert.equal(report.findings[0].code, LONGSHOT_FRAME_CODES.BAND_MISSING);
  assert.equal(report.findings[0].edge, 'top');
});

test('reconcileLongshotFrames：接缝缺口/尾部未覆盖 → error，action 变 repaint-missing', () => {
  const plan = {
    dpr: 1,
    width: 800,
    height: 300,
    segments: [segment(0, 0, 100), segment(1, 100, 100), segment(2, 200, 100, { role: 'last' })],
  };
  const tiles = [
    { index: 0, drawY: 0, height: 100, width: 800, bytes: 1 },
    { index: 1, drawY: 110, height: 90, width: 800, bytes: 1 },
  ];
  const report = reconcileLongshotFrames({ plan, tiles });
  assert.equal(report.ok, false);
  assert.equal(report.action, 'repaint-missing');
  assert.ok(report.findings.some((finding) => finding.code === LONGSHOT_FRAME_CODES.SEAM_GAP));
  assert.ok(report.findings.some((finding) => finding.code === LONGSHOT_FRAME_CODES.TAIL_UNCOVERED));
  assert.equal(report.errorCount >= 2, true);
});

test('reconcileLongshotFrames：重叠区错位与画布夹取都被点名', () => {
  const plan = {
    dpr: 1,
    width: 800,
    height: 500,
    segments: [segment(0, 0, 300), segment(1, 300, 300, { role: 'last', overlapTop: 60 })],
  };
  const tiles = [
    { index: 0, drawY: 0, height: 300, width: 800, bytes: 1 },
    { index: 1, drawY: 280, height: 300, width: 800, bytes: 1 },
  ];
  const report = reconcileLongshotFrames({ plan, tiles });
  assert.ok(report.findings.some((finding) => finding.code === LONGSHOT_FRAME_CODES.SEAM_OVERLAP));
  assert.ok(report.findings.some((finding) => finding.code === LONGSHOT_FRAME_CODES.CLAMPED));
});

test('reconcileLongshotFrames：空输入/无计划给稳定降级形状', () => {
  const empty = reconcileLongshotFrames({});
  assert.equal(empty.ok, true);
  assert.equal(empty.action, 'nothing');
  assert.deepEqual(empty.findings, []);
  assert.equal(empty.coverage.ratio, 0);
  assert.equal(empty.totalHeight, 0);
  const manifestOnly = reconcileLongshotFrames({
    segments: [segment(0, 0, 100)],
    tiles: [{ index: 0, drawY: 0, height: 100, width: 800 }],
    width: 800,
    totalHeight: 100,
  });
  assert.equal(manifestOnly.ok, true);
});

test('planFrameRepairs：missing/hash/错位/固定带 → 去重排序后的重绘目标', () => {
  const plan = {
    dpr: 1,
    width: 800,
    height: 400,
    segments: [
      segment(0, 0, 200, { fixedTop: 20 }),
      segment(1, 200, 100, { role: 'middle' }),
      segment(2, 300, 100, { role: 'last' }),
    ],
  };
  const tiles = [
    { index: 0, drawY: 0, height: 200, width: 800, bytes: 1 },
    { index: 1, drawY: 204, height: 100, width: 800, bytes: 1 },
    { index: 9, drawY: 900, height: 100, width: 800, bytes: 1 },
  ];
  const report = reconcileLongshotFrames({ plan, tiles });
  const repairs = planFrameRepairs(report);
  assert.ok(repairs.length >= 3);
  assert.ok(repairs.every((target) => Number.isInteger(target.index)));
  const errors = repairs.filter((target) => target.severity === 'error');
  assert.ok(errors.length >= 1);
  assert.deepEqual(planFrameRepairs(null), []);
});

test('reconcileManifestFrames：自洽 manifest → ok；缺号/重复/乱序 → issues', () => {
  const ok = reconcileManifestFrames({
    total: 2,
    width: 800,
    height: 300,
    segments: [{ index: 0, offset: 0, height: 200 }, { index: 1, offset: 200, height: 100 }],
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.captured, 2);
  assert.equal(ok.presentRatio, 1);
  assert.deepEqual(ok.issues, []);
  const bad = reconcileManifestFrames({
    total: 4,
    width: 800,
    height: 400,
    segments: [
      { index: 1, offset: 100, height: 100 },
      { index: 1, offset: 100, height: 100 },
      { index: 0, offset: 0, height: 100 },
      { bad: true },
    ],
  });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.duplicates, [1]);
  assert.deepEqual(bad.missing, [2, 3]);
  assert.equal(bad.ordered, false);
  assert.ok(bad.issues.includes('duplicate'));
  assert.ok(bad.issues.includes('missing'));
  assert.ok(bad.issues.includes('unordered'));
  assert.equal(reconcileManifestFrames(null).captured, 0);
});

test('longshotFrameWire/describeLongshotFrames：列表截断、计数完整', () => {
  const plan = { dpr: 1, width: 800, height: 300, segments: [segment(0, 0, 100), segment(1, 100, 100), segment(2, 200, 100)] };
  const report = reconcileLongshotFrames({ plan, tiles: [{ index: 0, drawY: 0, height: 100, width: 800 }] });
  const wire = longshotFrameWire(report, { maxListed: 2 });
  assert.equal(wire.version, LONGSHOT_RECONCILE_VERSION);
  assert.equal(wire.counts.expected, 3);
  assert.equal(wire.counts.missing, 2);
  assert.equal(wire.missing?.length, undefined, 'wire 不带 missing 全量列表');
  assert.match(wire.text, /longshot 帧对账/);
  assert.match(describeLongshotFrames(report), /findings=/);
  assert.equal(longshotFrameWire(null).ok, false);
  assert.match(describeLongshotFrames(null), /无报告/);
});
