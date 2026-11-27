// tests/unit/longshot-wiring-e11.test.mjs
// 第十一批-E 长截图接线证据：
//   1) 新模块（帧对账/重绘/压缩/分片恢复/存储预算）被真实运行时模块 import（不是“只写不接”）；
//   2) screenshot --full-page 的两个调用点（captureTiledFullPage / captureFullPage）链路上，
//      新字段确实从 lib 派生进入结果（segmentPlanWire / manifestSummary / layoutCanvas）；
//   3) longshot.recover 链路上 recovery.frames/repaint/shard_recovery/storage 都有值；
//   4) 既有字段与默认输出逐字段不变（只加字段）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { layoutCanvas } from '../../extension/src/longshot-render.js';
import { planLongshotSegments, segmentPlanWire } from '../../extension/src/lib/longshot-segments.js';
import {
  appendSegment,
  buildLongshotManifest,
  manifestSummary,
  sealManifest,
} from '../../extension/src/lib/longshot-manifest.js';
import { buildRecoveryResult, planLongshotRecovery } from '../../extension/src/lib/longshot-recovery.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const NEW_MODULES = [
  'extension/src/lib/capture-frame-ledger.js',
  'extension/src/lib/longshot-frame-reconcile.js',
  'extension/src/lib/longshot-repaint.js',
  'extension/src/lib/longshot-compress.js',
  'extension/src/lib/longshot-shard-recover.js',
  'extension/src/lib/capture-storage-budget.js',
];

test('新模块存在、有导出、不是占位，且被运行时模块 import（防“只写不接”）', () => {
  const consumers = [
    'extension/src/lib/longshot-segments.js',
    'extension/src/lib/longshot-frame-reconcile.js',
    'extension/src/lib/longshot-compress.js',
    'extension/src/lib/video-frame-reconcile.js',
    'extension/src/lib/video-segment-compress.js',
    'extension/src/lib/longshot-manifest.js',
    'extension/src/lib/longshot-recovery.js',
    'extension/src/longshot-render.js',
    'extension/src/lib/video-persist-view.js',
  ].map((file) => read(file)).join('\n');
  for (const modulePath of NEW_MODULES) {
    assert.ok(fs.existsSync(path.join(ROOT, modulePath)), '模块不存在：' + modulePath);
    const source = read(modulePath);
    assert.ok(source.split('\n').length >= 150, modulePath + ' 过短');
    assert.ok(source.includes('export '), modulePath + ' 没有导出');
    assert.doesNotMatch(source, /\bTODO\b|\bFIXME\b/, modulePath + ' 含占位');
    assert.ok(consumers.includes(path.basename(modulePath)), path.basename(modulePath) + ' 没有被运行时模块 import');
  }
});

test('--full-page 的两个调用点仍在：screenshot.js 的 captureFullPage/tiled 分支 + tiled-capture 的段/索引产物', () => {
  const screenshot = read('extension/src/screenshot.js');
  for (const token of [
    'layoutCanvas(frames.map',
    'captureTiledFullPage(tabId, tab.url',
    'planCaptureTiles({',
    'planFinalExposure({',
  ]) {
    assert.ok(screenshot.includes(token), 'screenshot.js 缺默认 full-page 调用点：' + token);
  }
  const tiled = read('extension/src/tiled-capture.js');
  for (const token of [
    'segmentPlanWire(segment)',
    'manifestSummary(manifest)',
    "from './lib/longshot-segments.js'",
    "from './lib/longshot-manifest.js'",
  ]) {
    assert.ok(tiled.includes(token), 'tiled-capture.js 缺接线点：' + token);
  }
  // screenshot.js:12 的 import → layoutCanvas 内派生帧对账/重绘字段
  assert.ok(screenshot.includes("from './longshot-render.js'"), 'screenshot 没有 import longshot-render');
  const render = read('extension/src/longshot-render.js');
  for (const token of [
    "from './lib/longshot-frame-reconcile.js'",
    "from './lib/longshot-repaint.js'",
    'longshotFrameWire(framesReport)',
    'repaintWire(repaint)',
  ]) {
    assert.ok(render.includes(token), 'longshot-render 缺接线：' + token);
  }
  // longshot.recover 链路：dispatch → longshot-recover → longshot-recovery → 新模块
  assert.ok(read('extension/src/dispatch.js').includes("'longshot.recover': recoverLongshot"));
  const recover = read('extension/src/longshot-recover.js');
  assert.ok(recover.includes('buildRecoveryResult('), 'longshot-recover 没调用 buildRecoveryResult');
  const recoveryLib = read('extension/src/lib/longshot-recovery.js');
  for (const token of [
    "from './longshot-frame-reconcile.js'",
    "from './longshot-repaint.js'",
    "from './longshot-shard-recover.js'",
    "from './longshot-compress.js'",
    'frames: derived.frames',
    'shard_recovery: derived.shard',
  ]) {
    assert.ok(recoveryLib.includes(token), 'longshot-recovery 缺接线：' + token);
  }
});

test('layoutCanvas 只加字段：旧字段不变，新增 frames/repaint 有内容', () => {
  const layout = layoutCanvas([
    { drawY: 0, bitmapHeight: 100 },
    { drawY: 100, bitmapHeight: 100 },
  ], { width: 800, totalHeight: 200 });
  // 旧字段逐字不变（与第十批-D 的断言一致）
  assert.equal(layout.width, 800);
  assert.equal(layout.height, 200);
  assert.deepEqual(layout.placements, [
    { index: 0, drawY: 0, bitmapHeight: 100 },
    { index: 1, drawY: 100, bitmapHeight: 100 },
  ]);
  // 覆盖/拼接字段仍在
  assert.equal(layout.coverage.coverageRatio, 1);
  assert.equal(layout.stitch.seamless, true);
  // 新增字段：帧对账 + 重绘（默认无问题 → repaint=skip）
  assert.equal(layout.frames.version, 1);
  assert.equal(layout.frames.ok, true);
  assert.equal(layout.frames.counts.expected, 2);
  assert.equal(layout.repaint.action, 'skip');
  const empty = layoutCanvas([], { width: 10, totalHeight: 0 });
  assert.equal(empty.frames.counts.expected, 0);
  assert.equal(empty.repaint.action, 'skip');
});

test('segmentPlanWire 只加字段：既有 6 个键的值不变，新增帧身份字段', () => {
  const plan = planLongshotSegments({ deviceWidth: 1241, deviceHeight: 45000, dpr: 1, fixedTop: 84, fixedBottom: 120 });
  const wire = segmentPlanWire(plan.segments[0]);
  // 既有断言（longshot-segments.test.mjs）逐字仍成立
  assert.deepEqual(
    { index: wire.index, y: wire.y, height: wire.height, dpr: wire.dpr, fixedTop: wire.fixedTop, fixedBottom: wire.fixedBottom },
    { index: 0, y: 0, height: 40000, dpr: 1, fixedTop: 84, fixedBottom: 0 },
  );
  assert.equal(wire.offsetY, 0);
  assert.equal(wire.pageY, 0);
  assert.equal(wire.role, 'first');
  // 新增帧身份
  assert.equal(wire.frame_id, 'longshot-segment#0');
  assert.match(wire.frame_sig, /^[0-9a-f]{16}$/);
  assert.equal(wire.frame_role, 'first');
  assert.equal(wire.frame_band, 'top');
  const last = segmentPlanWire(plan.segments[1]);
  assert.equal(last.frame_band, 'bottom');
  assert.equal(segmentPlanWire(null), null);
});

test('manifestSummary 只加字段：旧汇总键不变，新增 frames 自对账与 storage 压缩预算', () => {
  // 封版要求分片数 == total：这里用单段完整 manifest 验证既有汇总字段。
  const manifest = sealManifest(appendSegment(buildLongshotManifest({
    captureId: 'cap-1',
    dpr: 1,
    width: 800,
    height: 200,
    total: 1,
  }), { index: 0, offset: 0, bytes: 1000, hash: 'aaaaaaaaaaaaaaaa', width: 800, height: 200 }), { now: 1000 });
  const summary = manifestSummary(manifest);
  // 既有字段（longshot-manifest.test.mjs 口径）
  assert.equal(summary.version, 1);
  assert.equal(summary.captureId, 'cap-1');
  assert.equal(summary.total, 1);
  assert.equal(summary.captured, 1);
  assert.equal(summary.sealed, true);
  assert.equal(summary.bytes, 1000);
  assert.equal(summary.hashCount, 1);
  // 新增字段：帧自对账 + 存储压缩预算
  assert.equal(summary.frames.ok, true);
  assert.equal(summary.frames.presentRatio, 1);
  assert.equal(summary.storage.version, 1);
  assert.ok(summary.storage.totalBytes > 0);
  // 未封版且缺号的 manifest：frames 能点名缺号（只读派生，不伪造）
  const draft = appendSegment(buildLongshotManifest({
    captureId: 'cap-1b', dpr: 1, width: 800, height: 200, total: 2,
  }), { index: 0, offset: 0, bytes: 1000, hash: 'aaaaaaaaaaaaaaaa', width: 800, height: 100 });
  const draftSummary = manifestSummary(draft);
  assert.equal(draftSummary.frames.ok, false);
  assert.deepEqual(draftSummary.frames.missing, [1]);
  assert.equal(draftSummary.sealed, false);
  assert.equal(manifestSummary(null), null);
});

test('longshot.recover 结果：旧字段不变，recovery 里新增四块证据', () => {
  const manifest = appendSegment(buildLongshotManifest({
    captureId: 'cap-2',
    dpr: 1,
    width: 800,
    height: 200,
    total: 2,
  }), { index: 0, offset: 0, bytes: 1000, hash: 'aaaaaaaaaaaaaaaa', width: 800, height: 100 });
  const tiles = [{ index: 0, x: 0, y: 0, drawY: 0, width: 800, height: 100, bytes: 1000, hash: 'aaaaaaaaaaaaaaaa' }];
  const plan = planLongshotRecovery({ manifest, tiles });
  const result = buildRecoveryResult({ captureId: 'cap-2', plan, width: 800, height: 200, bytes: 10, dataUrl: 'data:x' });
  // 既有字段不变（未封版、缺 1 段 → rebuild-partial）
  assert.equal(result.ok, true);
  assert.equal(result.longshotId, 'cap-2');
  assert.equal(result.width, 800);
  assert.equal(result.height, 200);
  assert.equal(result.tiles, 1);
  assert.deepEqual(result.gaps, []);
  assert.equal(result.sealed, false);
  assert.equal(result.complete, false);
  assert.deepEqual(result.recovery.missing, [1]);
  // 新增四块：帧对账 / 重绘 / 分片恢复强化 / 存储压缩预算
  assert.equal(result.recovery.frames.version, 1);
  assert.equal(result.recovery.frames.counts.expected, 2);
  assert.equal(result.recovery.frames.counts.missing, 1);
  assert.equal(typeof result.recovery.repaint.action, 'string');
  assert.equal(result.recovery.shard_recovery.version, 1);
  assert.equal(result.recovery.shard_recovery.total, 2);
  assert.equal(result.recovery.shard_recovery.action, 'recover-partial');
  assert.equal(result.recovery.storage.version, 1);
  assert.ok(result.recovery.storage.totalBytes > 0);
  // 无计划时既有降级不变
  const empty = buildRecoveryResult({});
  assert.equal(empty.dataUrl, '');
  assert.equal(empty.recovery, null);
});

test('接线涉及文件都在 1100 行复杂度预算内', () => {
  for (const relative of [
    'extension/src/longshot-render.js',
    'extension/src/lib/longshot-segments.js',
    'extension/src/lib/longshot-manifest.js',
    'extension/src/lib/longshot-recovery.js',
    'extension/src/lib/video-persist-view.js',
    'extension/src/lib/video-restore.js',
    ...NEW_MODULES,
  ]) {
    const lines = read(relative).split('\n').length;
    assert.ok(lines <= 1100, relative + ' 超过 1100 行预算：' + lines);
  }
});
