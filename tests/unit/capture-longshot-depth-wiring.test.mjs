// tests/unit/capture-longshot-depth-wiring.test.mjs
// 第十批-D 运行时接线与“默认路径不变”证据：
//   1) 新模块被真实运行时文件 import（longshot-recover.js / longshot-render.js / capture-freshness.js /
//      longshot-segments.js / video.js），不是“只写不接”；
//   2) screenshot --full-page 的默认调用点（planCaptureTiles/nextGrowthTiles/tileForScroll/
//      layoutCanvas/planFinalExposure/staleMetrics）保持存在，且默认输入下输出逐字段不变（只加字段）；
//   3) 既有 longshot.* / video.* 命令路径的结果字段只增不改。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { planCaptureTiles, sameFrame, pruneCaptures } from '../../extension/src/longshot.js';
import { layoutCanvas, planStitch } from '../../extension/src/longshot-render.js';
import { nextGrowthTiles, tileForScroll } from '../../extension/src/longshot-schedule.js';
import { planFinalExposure } from '../../extension/src/lib/longshot-final.js';
import {
  planFixedBands,
  planLongshotSegments,
  validateSegmentPlan,
} from '../../extension/src/lib/longshot-segments.js';
import { staleMetrics, planStaleRecovery } from '../../extension/src/lib/capture-freshness.js';
import { estimateLongshotBudget, budgetReport } from '../../extension/src/lib/longshot-budget.js';
import { buildLongshotManifest, appendSegment, sealManifest } from '../../extension/src/lib/longshot-manifest.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const NEW_MODULES = [
  'extension/src/lib/longshot-bands.js',
  'extension/src/lib/longshot-dpr.js',
  'extension/src/lib/longshot-shard.js',
  'extension/src/lib/longshot-resume.js',
  'extension/src/lib/longshot-stale.js',
  'extension/src/lib/longshot-degrade.js',
  'extension/src/lib/longshot-stitch.js',
  'extension/src/lib/video-journal.js',
  'extension/src/lib/video-frames.js',
  'extension/src/lib/video-persist.js',
  'extension/src/lib/video-persist-view.js',
];

test('十个新模块都存在且被至少一个运行时文件 import（防“只写不接”）', () => {
  const runtimeFiles = [
    'extension/src/screenshot.js',
    'extension/src/tiled-capture.js',
    'extension/src/longshot-recover.js',
    'extension/src/longshot-render.js',
    'extension/src/lib/capture-freshness.js',
    'extension/src/lib/longshot-segments.js',
    'extension/src/video.js',
    'extension/src/dispatch.js',
    'extension/src/capture-persist.js',
    'extension/src/lib/video-persist.js',
    'extension/src/lib/video-persist-view.js',
  ].map((file) => ({ file, text: read(file) }));
  for (const modulePath of NEW_MODULES) {
    assert.ok(fs.existsSync(path.join(ROOT, modulePath)), '模块不存在：' + modulePath);
    const base = path.basename(modulePath);
    const consumers = runtimeFiles.filter((entry) => entry.text.includes(base));
    assert.ok(consumers.length > 0, base + ' 没有被任何运行时文件 import');
  }
});
test('longshot-recover 接 shard/resume/dpr/degrade/stitch（longshot.recover 真实路径）', () => {
  const source = read('extension/src/longshot-recover.js');
  for (const token of [
    "from './lib/longshot-shard.js'",
    "from './lib/longshot-resume.js'",
    "from './lib/longshot-dpr.js'",
    "from './lib/longshot-degrade.js'",
    "from './lib/longshot-stitch.js'",
    'planShards(',
    'checkpointFromManifest(',
    'planResume(',
    'planFractionalCanvas(',
    'planLongshotDegrade(',
    'analyzePlacements(',
    'result.recovery.shards',
    'result.recovery.checkpoint',
    'result.recovery.resume_decision',
    'result.recovery.canvas',
    'result.recovery.degrade',
    'result.recovery.stitch',
  ]) {
    assert.ok(source.includes(token), 'longshot-recover 缺少：' + token);
  }
  // 既有恢复语义不能被删：画布构造/重建结果/状态登记仍在
  for (const token of [
    'new OffscreenCanvas(width, height)',
    'buildRecoveryResult(',
    'planLongshotRecovery(',
    'applyRecoveryVerification(',
    'resumeLongshotManifest(',
    'result.state = longshotRuns.evidence(captureId)',
    'RECOVER_BEGIN',
  ]) {
    assert.ok(source.includes(token), 'longshot-recover 丢了既有语义：' + token);
  }
  assert.ok(read('extension/src/dispatch.js').includes("'longshot.recover': recoverLongshot"), 'dispatch 没有挂 longshot.recover');
});

test('screenshot --full-page 默认调用点仍在，且新增覆盖分析只加字段', () => {
  const screenshot = read('extension/src/screenshot.js');
  for (const token of [
    'planCaptureTiles({',
    'nextGrowthTiles(positions',
    'tileForScroll(current',
    'layoutCanvas(frames.map',
    'planFinalExposure({',
    'staleMetrics(metrics, afterMetrics',
    'captureTiledFullPage(tabId, tab.url',
  ]) {
    assert.ok(screenshot.includes(token), 'screenshot 默认 full-page 路径缺：' + token);
  }
  // longshot-render.js 是 screenshot.js:12 的 import，覆盖分析在它内部执行
  const render = read('extension/src/longshot-render.js');
  assert.ok(render.includes("from './lib/longshot-stitch.js'"), 'longshot-render 没有接 longshot-stitch');
  assert.ok(render.includes('analyzePlacements('), 'longshot-render 没调用 analyzePlacements');
});

test('默认输出不变：planCaptureTiles / nextGrowthTiles / tileForScroll / planFinalExposure', () => {
  // 与既有 tests/unit/longshot.test.mjs 的断言逐字相同（这里的目的是“改动后仍成立”）
  assert.deepEqual(planCaptureTiles({ scrollHeight: 250, viewportHeight: 100 }), [0, 100, 200]);
  assert.deepEqual(planCaptureTiles({ scrollHeight: 200, viewportHeight: 100, overlap: 20 }), [0, 80, 160]);
  assert.deepEqual(planCaptureTiles({ scrollHeight: 1000, viewportHeight: 100, maxTiles: 3 }), [0, 100, 200]);
  assert.deepEqual(planCaptureTiles({ scrollHeight: 0, viewportHeight: 100 }), [0]);
  assert.deepEqual(
    nextGrowthTiles([0], { scrollHeight: 350, step: 100 }),
    [0, 100, 200, 300],
  );
  assert.equal(tileForScroll(123, 100, 2), 123);
  assert.equal(tileForScroll(undefined, 100, 2), 200);
  // final exposure 默认返回形状仍是 {scrollY, drawY} 两键（不接受新选项时不变）
  assert.deepEqual(planFinalExposure({ scrollHeight: 3000, innerHeight: 800, scale: 2, lastBottom: 3000, viewportHeight: 1600 }), {
    scrollY: 2200,
    drawY: 4400,
  });
  assert.equal(planFinalExposure({ scrollHeight: 3000, innerHeight: 800, lastBottom: 3000, viewportHeight: 800 }), null);
  assert.equal(sameFrame({ scrollHeight: 1, innerHeight: 1, bodyLength: 1 }, { scrollHeight: 1, innerHeight: 1, bodyLength: 1 }), true);
  const captures = new Map([['a', { at: 100 }], ['b', { at: 10 }]]);
  pruneCaptures(captures, { now: 200, ttlMs: 1000, max: 1 });
  assert.deepEqual([...captures.keys()], ['a']);
});

test('默认输出不变：layoutCanvas 既有字段 + 只新增 coverage/stitch', () => {
  const layout = layoutCanvas([
    { drawY: 0, bitmapHeight: 100 },
    { drawY: 90, bitmapHeight: 100 },
  ], { width: 800, totalHeight: 150 });
  // 旧字段
  assert.equal(layout.width, 800);
  assert.equal(layout.height, 150);
  assert.deepEqual(layout.placements, [
    { index: 0, drawY: 0, bitmapHeight: 100 },
    { index: 1, drawY: 50, bitmapHeight: 100 },
  ]);
  // 新字段（只加）
  const keys = Object.keys(layout).sort();
  assert.deepEqual(keys, ['coverage', 'frames', 'height', 'placements', 'repaint', 'stitch', 'width']);
  const empty = layoutCanvas([], { width: 10, totalHeight: 0 });
  assert.equal(empty.width, 10);
  assert.equal(empty.height, 1);
  assert.deepEqual(empty.placements, []);
  const stitch = planStitch([{ height: 100 }, { height: 50 }], { width: 10 });
  assert.equal(stitch.height, 150);
  assert.deepEqual(stitch.placements.map((item) => item.drawY), [0, 100]);
});

test('默认输出不变：planStaleRecovery / staleMetrics 既有字段', () => {
  // 既有严格断言（capture-freshness.test.mjs）在改造后仍成立
  assert.deepEqual(
    planStaleRecovery(
      { scrollHeight: 15000, scrollWidth: 1241 },
      { scrollHeight: 18000, scrollWidth: 1241 },
      { scale: 1, device: { width: 1241, height: 15000 } },
    ),
    { action: 'extend', width: 1241, height: 18000, y0: 15000 },
  );
  assert.deepEqual(planStaleRecovery(null, null, {}), { action: 'accept' });
  const before = { scrollHeight: 15000, scrollWidth: 1241, innerWidth: 1241, innerHeight: 800 };
  const same = staleMetrics(before, { ...before }, { tolerance: 1 });
  assert.equal(same.stale, false);
  assert.deepEqual(same.changed, []);
  const grew = staleMetrics(before, { ...before, scrollHeight: 15800 });
  assert.equal(grew.stale, true);
  // 新增字段（只加）：归因不会把 stale 翻成 true
  assert.deepEqual(grew.changed, [{ field: 'scrollHeight', before: 15000, after: 15800 }]);
  assert.deepEqual(grew.kinds, ['growth']);
  assert.equal(grew.dominant, 'growth');
  assert.equal(grew.suggestion, 'extend-tail');
  assert.ok(grew.signature.before.startsWith('stale:'));
});

test('默认输出不变：planFixedBands 仍按 0.3.0 口径算 fixedTop/fixedBottom（新字段只加）', () => {
  const bands = planFixedBands({ metrics: { fixedTopHeight: 56, fixedBottomHeight: 80 }, dpr: 1.5, deviceHeight: 22500 });
  // 既有断言口径
  assert.equal(bands.measured, true);
  assert.equal(bands.fixedTop, 84);
  assert.equal(bands.fixedBottom, 120);
  assert.equal(bands.topCss, 56);
  assert.equal(bands.bottomCss, 80);
  // 新字段
  assert.equal(bands.bandCount, 2);
  assert.deepEqual(bands.bandKinds, ['fixed-top', 'fixed-bottom']);
  assert.equal(bands.bandSignature, 'bottom/fixed/120/|top/fixed/84/');
  assert.equal(bands.bandDerived, false);
  // 超页高 1/3 的固定元素仍被丢弃
  const tall = planFixedBands({ metrics: { fixedTopHeight: 6000, fixedBottomHeight: 80 }, dpr: 1, deviceHeight: 15000 });
  assert.equal(tall.fixedTop, 0);
  assert.equal(tall.fixedBottom, 80);
  // 缺 metrics 的安全返回
  const missing = planFixedBands({ metrics: null, dpr: 1, deviceHeight: 15000 });
  assert.equal(missing.fixedTop, 0);
  assert.equal(missing.bandPlan, null);
  // 显式 bandLayout 才用富带求和（opt-in，默认路径不传）
  const rich = planFixedBands({
    metrics: { fixedBands: [{ edge: 'top', height: 56, position: 'sticky' }, { edge: 'bottom', height: 80 }] },
    dpr: 1,
    deviceHeight: 15000,
    bandLayout: true,
  });
  assert.equal(rich.bandDerived, true);
  assert.equal(rich.fixedTop, 56);
  assert.equal(rich.fixedBottom, 80);
});

test('默认输出不变：planLongshotSegments 旧字段 + dprProfile 只加；validateSegmentPlan 形状不变', () => {
  const plan = planLongshotSegments({ deviceWidth: 1241, deviceHeight: 45000, dpr: 1, fixedTop: 84, fixedBottom: 120 });
  assert.equal(plan.ok, true);
  assert.equal(plan.totalSegments, 2);
  assert.equal(plan.dpr, 1);
  assert.equal(plan.fractional, false);
  assert.equal(plan.fixedTop, 84);
  assert.equal(plan.fixedBottom, 120);
  assert.equal(plan.segments[0].pageY, 0);
  assert.equal(plan.segments[1].pageY, 40000);
  assert.equal(plan.dprProfile.dpr, 1);
  assert.equal(plan.fractionalDpr, false);
  // 既有严格断言：validateSegmentPlan 仍是四键对象（我们没往里加字段）
  assert.deepEqual(validateSegmentPlan(planLongshotSegments({ deviceWidth: 1241, deviceHeight: 45000, dpr: 1 })), {
    ok: true,
    errors: [],
    covered: 45000,
    height: 45000,
  });
  // 分数 DPR 的档位证据
  const fractional = planLongshotSegments({ deviceWidth: 1241, deviceHeight: 22500, dpr: 1.5 });
  assert.equal(fractional.dprProfile.dpr, 1.5);
  assert.equal(fractional.fractionalDpr, true);
});

test('默认输出不变：budgetReport 键集仍是 5 个（未偷偷加字段）', () => {
  const estimate = estimateLongshotBudget({ scrollWidth: 1241, scrollHeight: 15000, dpr: 1.5 });
  assert.deepEqual(Object.keys(budgetReport(estimate)), ['budget', 'used', 'degraded', 'reason', 'truncated']);
});

test('manifest 段形状不变（shard 视图是派生，不改 manifest）', () => {
  const manifest = buildLongshotManifest({
    captureId: 'c1',
    dpr: 1.5,
    width: 1862,
    height: 22500,
    total: 2,
  });
  const appended = appendSegment(manifest, { index: 0, offset: 0, bytes: 10, hash: 'abcdef0123456789', width: 1862, height: 750 });
  assert.deepEqual(appended.segments[0], {
    index: 0,
    offset: 0,
    bytes: 10,
    hash: 'abcdef0123456789',
    width: 1862,
    height: 750,
  });
  const sealed = sealManifest({ ...appended, total: 1 }, { now: 1000 });
  assert.equal(sealed.sealed, true);
  assert.equal(sealed.hashVerified, true);
});

test('video.js 接 video-journal/video-frames/video-persist(-view)（video.* 真实路径）', () => {
  const source = read('extension/src/video.js');
  for (const token of [
    "from './lib/video-persist.js'",
    "from './lib/video-persist-view.js'",
    'createPersistenceSession(',
    'persistenceFromRecord(',
    'persistenceRecordFields(',
    'restorePersistenceParts(',
    'persistenceBrief(',
    'persistSummaryOf(',
    'sealPersistenceFromFragments(',
    'persistenceVerifyView(',
    'persistenceRecoveryView(',
    'persistence: persistenceBrief(persistenceSession)',
    'persistence: persistenceReport',
    '...journalFields(record),',
  ]) {
    assert.ok(source.includes(token), 'video.js 缺少：' + token);
  }
  // 视图层把“分片日记 + 帧校验 + 预算”的真实实现接起来（不是空壳）
  const view = read('extension/src/lib/video-persist-view.js');
  for (const token of [
    "from './video-persist.js'",
    "from './video-journal.js'",
    "from './video-frames.js'",
    'persistPart(',
    'sealPersistence(',
    'analyzePersistence(',
    'persistenceDiagnostics(',
    'planPersistenceRecovery(',
  ]) {
    assert.ok(view.includes(token), 'video-persist-view 缺少：' + token);
  }
  // 既有导出名一个不能少（wire 层按名字调用）
  for (const name of ['startVideo', 'stopVideo', 'verifyVideo', 'recoverVideo', 'videoStatus', 'listVideos', 'videoState', 'fetchVideo']) {
    assert.ok(source.includes('export async function ' + name), 'video.js 丢了导出：' + name);
  }
  // 既有结果字段仍在（只加不改）
  for (const field of ['recordingId:', 'recording_state:', 'budget:', 'seal_check:', 'fragments:', 'journalFields(saved)']) {
    assert.ok(source.includes(field), 'video.js 丢了既有字段：' + field);
  }
  // 复杂度预算（architecture-guards 1100 行/文件）不能被这一批撑破
  assert.ok(source.split('\n').length <= 1100, 'video.js 超过 1100 行预算：' + source.split('\n').length);
});

test('新模块没有 TODO 占位且达到最小体量（防“只写骨架”）', () => {
  for (const modulePath of NEW_MODULES) {
    const source = read(modulePath);
    assert.doesNotMatch(source, /\bTODO\b|\bFIXME\b|assert\.ok\(true\)/, modulePath + ' 含占位内容');
    assert.ok(source.split('\n').length >= 150, modulePath + ' 过短：' + source.split('\n').length + ' 行');
    assert.ok(source.includes('export '), modulePath + ' 没有导出');
    assert.doesNotMatch(source, /\bconsole\.log\(/, modulePath + ' 不应在库里打日志');
  }
});

test('新模块动态 import 的真实 API 可调用（不是空壳）', async () => {
  const bands = await import('../../extension/src/lib/longshot-bands.js');
  const dpr = await import('../../extension/src/lib/longshot-dpr.js');
  const shard = await import('../../extension/src/lib/longshot-shard.js');
  const resume = await import('../../extension/src/lib/longshot-resume.js');
  const stale = await import('../../extension/src/lib/longshot-stale.js');
  const degrade = await import('../../extension/src/lib/longshot-degrade.js');
  const stitch = await import('../../extension/src/lib/longshot-stitch.js');
  const journal = await import('../../extension/src/lib/video-journal.js');
  const frames = await import('../../extension/src/lib/video-frames.js');
  const persist = await import('../../extension/src/lib/video-persist.js');
  assert.equal(typeof bands.resolveBandPlan, 'function');
  assert.equal(typeof dpr.planDeviceSegments, 'function');
  assert.equal(typeof shard.planShards, 'function');
  assert.equal(typeof resume.planResume, 'function');
  assert.equal(typeof stale.planStaleRetry, 'function');
  assert.equal(typeof degrade.planLongshotDegrade, 'function');
  assert.equal(typeof stitch.analyzePlacements, 'function');
  assert.equal(typeof journal.createJournal, 'function');
  assert.equal(typeof frames.frameReport, 'function');
  assert.equal(typeof persist.planPersistenceRecovery, 'function');
  // 真跑一遍端到端纯函数链（不允许只是声明）
  const plan = dpr.planDeviceSegments({ cssWidth: 1241, cssHeight: 22500, dpr: 1.5, maxSegmentCssHeight: 8000 });
  assert.equal(plan.segments.length, 3);
  const segments = shard.planShards({ captureId: 'c', dpr: 1.5, width: 1862, height: 33750, total: 3, sealed: false, segments: plan.segments.map((segment, index) => ({ index, offset: segment.deviceY, bytes: 100, hash: 'h' + index, width: 1862, height: segment.deviceHeight })) });
  assert.equal(segments.shards.length, 1);
  const checkpoint = resume.createCheckpoint({ captureId: 'c', total: 3, done: [0], now: 1000 });
  assert.equal(resume.planResume({ checkpoint, available: [0], now: 2000 }).action, 'resume');
  assert.equal(resume.planResume({ checkpoint, available: [0], now: 2000 }).pending.length, 2);
  const degradePlan = degrade.planLongshotDegrade({ scrollWidth: 1241, scrollHeight: 22500, dpr: 1.5 });
  assert.equal(degradePlan.action, 'continue');
  const journalDoc = journal.createJournal({ recordingId: 'r', now: 1000 });
  const appended = journal.appendEntry(journalDoc, { index: 0, bytes: 10, hash: 'h' }, { now: 1000 });
  assert.equal(appended.accepted, true);
  const session = persist.createPersistenceSession({ recordingId: 'r', now: 1000 });
  assert.equal(persist.persistPart(session, { index: 0, bytes: 10, hash: 'h', tMs: 0, durationMs: 100, frames: [{ pts: 0, durationMs: 100, bytes: 10, checksum: 'c' }] }, { now: 1100 }).ok, true);
});
