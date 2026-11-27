import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const NEW_MODULES = [
  'extension/src/lib/longshot-state.js',
  'extension/src/lib/longshot-segments.js',
  'extension/src/lib/longshot-manifest.js',
  'extension/src/lib/longshot-recovery.js',
  'extension/src/lib/longshot-budget.js',
];

test('五个新模块都被至少一个运行时文件 import（防"只写不接线"）', () => {
  const runtimeFiles = [
    'extension/src/tiled-capture.js',
    'extension/src/longshot-recover.js',
    'extension/src/lib/longshot-store.js',
    'extension/src/screenshot.js',
    'extension/src/dispatch.js',
    'extension/src/capture-persist.js',
  ].map((file) => ({ file, text: read(file) }));
  for (const modulePath of NEW_MODULES) {
    const base = path.basename(modulePath);
    const consumers = runtimeFiles.filter((entry) => entry.text.includes(base));
    assert.ok(consumers.length > 0, base + ' 没有被任何运行时文件 import');
  }
  const tiled = read('extension/src/tiled-capture.js');
  for (const token of [
    "from './lib/longshot-state.js'",
    "from './lib/longshot-segments.js'",
    "from './lib/longshot-manifest.js'",
    "from './lib/longshot-budget.js'",
    "from './lib/longshot-store.js'",
  ]) {
    assert.ok(tiled.includes(token), 'tiled-capture 缺少 import：' + token);
  }
  const recover = read('extension/src/longshot-recover.js');
  for (const token of [
    "from './lib/longshot-recovery.js'",
    "from './lib/longshot-manifest.js'",
    "from './lib/longshot-state.js'",
    "from './lib/longshot-store.js'",
  ]) {
    assert.ok(recover.includes(token), 'longshot-recover 缺少 import：' + token);
  }
});

test('tiled-capture 消费五项能力的运行时调用点', () => {
  const source = read('extension/src/tiled-capture.js');
  const calls = [
    // 1) 状态机
    'longshotRuns.transition(captureId, LONGSHOT_EVENTS.CAPTURE_BEGIN',
    'LONGSHOT_EVENTS.STITCH_BEGIN',
    'LONGSHOT_EVENTS.STALE_DETECTED',
    'LONGSHOT_EVENTS.STALE_RETRY',
    'LONGSHOT_EVENTS.SEAL',
    'LONGSHOT_EVENTS.FAIL',
    // 2) 多段固定带 + 分数 DPR
    'planLongshotSegments(',
    'planFixedBands(',
    'tileRectsForSegment(',
    'redrawSegmentBand(',
    'bandRedrawRect(',
    // 3) manifest
    'buildLongshotManifest(',
    'appendSegment(',
    'sealManifest(',
    'hashLongshotBytes(',
    'manifestSummary(',
    'saveLongshotManifest(',
    'cleanupLongshotManifests(',
    // 4) 崩溃恢复（tile 读回 + hash 校验失败重取）
    'listLongshotTiles(',
    '分片 hash 校验未通过',
    'refetched',
    // 5) 预算
    'estimateLongshotBudget(',
    'budgetReport(',
    'describeBudget(',
    'chooseTileConcurrency(',
    'mapWithConcurrency(',
  ];
  for (const token of calls) {
    assert.ok(source.includes(token), 'tiled-capture 缺少运行时调用：' + token);
  }
  for (const field of ['budget:', 'degraded:', 'truncated:', 'state:', 'manifest:', 'manifest_verified:', 'segment_count:', 'fixedTop:', 'fixedFooter:']) {
    assert.ok(source.includes(field), '结果缺少字段：' + field);
  }
});

test('longshot-recover 复用旧恢复语义并接 manifest/恢复计划/状态机', () => {
  const source = read('extension/src/longshot-recover.js');
  for (const token of [
    'listLongshotTiles(',
    'getLongshotManifest(',
    'parseLongshotManifest(',
    'resumeLongshotManifest(',
    'planLongshotRecovery(',
    'applyRecoveryVerification(',
    'buildRecoveryResult(',
    'RECOVER_BEGIN',
    "createImageBitmap(tile.blob)",
    'OffscreenCanvas(width, height)',
    'recovery.resume',
    'result.state',
  ]) {
    assert.ok(source.includes(token), 'longshot-recover 缺少：' + token);
  }
  assert.ok(read('extension/src/dispatch.js').includes("'longshot.recover': recoverLongshot"), 'dispatch 没有挂 longshot.recover');
});

test('longshot-store v3 增加 manifests store 与清理/写入 API', () => {
  const source = read('extension/src/lib/longshot-store.js');
  assert.match(source, /const VERSION = 3;/);
  assert.match(source, /const MANIFEST_STORE = 'manifests';/);
  for (const name of ['saveLongshotManifest', 'getLongshotManifest', 'listLongshotManifests', 'deleteLongshotManifest', 'cleanupLongshotManifests']) {
    assert.ok(source.includes('export async function ' + name), 'store 缺少 ' + name);
  }
  assert.ok(source.includes("import { pruneLongshotManifests as pruneManifestList } from './longshot-manifest.js'"), 'store 清理没有复用 manifest 的 prune');
  assert.ok(source.includes('hash: String(tile.hash'), 'tile 没有记录 hash');
  assert.ok(source.includes('at: Number(tile.at) || Date.now()'), 'tile 没有记录写入时间');
});

test('manifest 结构是 index.json 等价物（字段齐）', () => {
  const source = read('extension/src/lib/longshot-manifest.js');
  for (const token of ['version:', 'captureId', 'total', 'dpr', 'segments', 'sealed', 'createdAt', 'sealedAt']) {
    assert.ok(source.includes(token), 'manifest 缺少字段 ' + token);
  }
  for (const fn of ['buildLongshotManifest', 'appendSegment', 'sealManifest', 'validateManifest', 'resumeLongshotManifest', 'pruneLongshotManifests', 'hashLongshotBytes', 'verifyLongshotSegment']) {
    assert.ok(source.includes('export function ' + fn), 'manifest 缺少 ' + fn);
  }
});

test('状态机模块写明 7 状态/非法迁移证据字段', () => {
  const source = read('extension/src/lib/longshot-state.js');
  for (const state of ['idle', 'capturing', 'stitching', 'stale', 'sealed', 'recovered', 'failed']) {
    assert.ok(source.includes("'" + state + "'"), '缺少状态 ' + state);
  }
  for (const field of ['from:', 'to:', 'event:', 'allowed:', 'code:', 'facts:']) {
    assert.ok(source.includes(field), '拒绝证据缺少字段 ' + field);
  }
  assert.ok(source.includes('LONGSHOT_STALE_BUDGET'), '缺少 stale 重试上限闸门');
  assert.ok(source.includes('LONGSHOT_INCOMPLETE'), '缺少封版完整性闸门');
});

test('新模块没有 TODO/占位断言/空函数体', () => {
  for (const modulePath of NEW_MODULES) {
    const source = read(modulePath);
    assert.doesNotMatch(source, /\bTODO\b|\bFIXME\b|assert\.ok\(true\)/, modulePath + ' 含占位内容');
    assert.ok(source.split('\n').length >= 120, modulePath + ' 过短，疑似占位');
    assert.ok(source.includes('export '), modulePath + ' 没有导出');
  }
});

test('动态 import：新模块的对外 API 真实可调用', async () => {
  const state = await import('../../extension/src/lib/longshot-state.js');
  const segments = await import('../../extension/src/lib/longshot-segments.js');
  const manifest = await import('../../extension/src/lib/longshot-manifest.js');
  const recovery = await import('../../extension/src/lib/longshot-recovery.js');
  const budget = await import('../../extension/src/lib/longshot-budget.js');
  assert.equal(typeof state.createLongshotStateMachine, 'function');
  assert.equal(typeof state.longshotRuns.transition, 'function');
  assert.equal(typeof segments.planLongshotSegments, 'function');
  assert.equal(typeof segments.validateSegmentPlan, 'function');
  assert.equal(typeof manifest.sealManifest, 'function');
  assert.equal(typeof manifest.resumeLongshotManifest, 'function');
  assert.equal(typeof recovery.planLongshotRecovery, 'function');
  assert.equal(typeof budget.estimateLongshotBudget, 'function');
  assert.equal(typeof budget.mapWithConcurrency, 'function');
});

test('screenshot.js 的 full-page 路径仍然走 captureTiledFullPage（只读接线检查）', () => {
  const source = read('extension/src/screenshot.js');
  assert.ok(source.includes("import { captureTiledFullPage } from './tiled-capture.js'"));
  assert.ok(source.includes('captureTiledFullPage(tabId, tab.url'));
  assert.ok(source.includes('segmented: params.segmented !== false'));
  assert.ok(source.includes('staleAttempts: params.staleAttempts'));
});
