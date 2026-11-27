// tests/unit/video-wiring-e11.test.mjs
// 第十一批-E 视频接线证据：
//   1) video.js 的真实结果视图（video-persist-view.js）与 recover 摘要（video-restore.js）
//      已 import 新模块：帧时间轴 / 转码预算 / 封装预算 / 分片存储压缩；
//   2) video.* 结果字段只增不改（persistenceBrief 旧字段、summarizeRestore 旧字段）；
//   3) 新字段有真实内容（不是 null 占位），并随会话数据变化；
//   4) 新模块在 1100 行预算内。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  persistenceBrief,
  persistenceVerifyView,
} from '../../extension/src/lib/video-persist-view.js';
import { createPersistenceSession, persistPart, sealPersistence } from '../../extension/src/lib/video-persist.js';
import { planPartialReassembly, summarizeRestore } from '../../extension/src/lib/video-restore.js';
import { persistRecordFragments } from '../../extension/src/lib/video-persist-view.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const NEW_MODULES = [
  'extension/src/lib/video-frame-reconcile.js',
  'extension/src/lib/video-transcode-budget.js',
  'extension/src/lib/video-mux-budget.js',
  'extension/src/lib/video-segment-compress.js',
];

const NOW = 1_700_000_000_000;

function fragments(count, { bytes = 50_000 } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    index,
    bytes,
    sha256: ('sha' + index).padEnd(16, '0'),
    durationMs: 200,
    tMs: index * 200,
    keyframe: index % 5 === 0,
  }));
}

function sessionWithFrames() {
  let session = createPersistenceSession({
    recordingId: 'rec-e11',
    now: NOW,
    mime: 'video/mp4',
    budget: { maxTotalBytes: 64 * 1024 * 1024 },
  });
  for (const fragment of fragments(6)) {
    session = persistPart(session, {
      index: fragment.index,
      bytes: fragment.bytes,
      hash: fragment.sha256,
      tMs: fragment.tMs,
      durationMs: fragment.durationMs,
      keyframe: fragment.keyframe,
      frames: Array.from({ length: 6 }, (_, offset) => ({
        pts: fragment.tMs + offset * 33,
        durationMs: 33,
        bytes: Math.round(fragment.bytes / 6),
        checksum: fragment.sha256,
        keyframe: offset === 0 && fragment.keyframe,
      })),
    }, { now: NOW + fragment.index * 200 }).session;
  }
  return session;
}

test('新模块存在、被运行时视图 import、不是占位', () => {
  const consumers = [
    'extension/src/lib/video-persist-view.js',
    'extension/src/lib/video-restore.js',
  ].map((file) => read(file)).join('\n');
  for (const modulePath of NEW_MODULES) {
    assert.ok(fs.existsSync(path.join(ROOT, modulePath)), '模块不存在：' + modulePath);
    const source = read(modulePath);
    assert.ok(source.split('\n').length >= 150, modulePath + ' 过短');
    assert.ok(source.includes('export '), modulePath + ' 没有导出');
    assert.doesNotMatch(source, /\bTODO\b|\bFIXME\b/, modulePath + ' 含占位');
    assert.ok(consumers.includes(path.basename(modulePath)), path.basename(modulePath) + ' 没有被运行时视图 import');
  }
});

test('video.js 的 real 接线点仍在：persistenceBrief/persistenceVerifyView 被 start/stop/verify 消费', () => {
  const video = read('extension/src/video.js');
  for (const token of [
    "from './lib/video-persist-view.js'",
    'persistenceBrief(persistenceSession)',
    'persistenceVerifyView(',
    'persistSummaryOf(record)',
    "...journalFields(record),",
  ]) {
    assert.ok(video.includes(token), 'video.js 缺接线点：' + token);
  }
  const view = read('extension/src/lib/video-persist-view.js');
  for (const token of [
    "from './video-frame-reconcile.js'",
    "from './video-transcode-budget.js'",
    "from './video-mux-budget.js'",
    "from './video-segment-compress.js'",
    'frame_axis:',
    'mux_budget:',
    'segment_budget:',
    'video_evidence: mergeVideoEvidence(',
  ]) {
    assert.ok(view.includes(token), 'video-persist-view 缺接线：' + token);
  }
  const restore = read('extension/src/lib/video-restore.js');
  for (const token of [
    "from './video-mux-budget.js'",
    "from './video-segment-compress.js'",
    'mux_budget:',
    'segment_budget:',
  ]) {
    assert.ok(restore.includes(token), 'video-restore 缺接线：' + token);
  }
  // video.recover 消费 summarizeRestore（video.js:714 附近）
  assert.ok(video.includes('summarizeRestore('), 'video.js 没消费 summarizeRestore');
});

test('persistenceBrief 只加字段：旧字段值不变，新字段有内容', () => {
  const session = sessionWithFrames();
  const brief = persistenceBrief(session);
  // 既有字段（video-persist-view.test.mjs 口径）
  assert.equal(brief.state, 'recording');
  assert.equal(brief.segments, 6);
  assert.equal(brief.bytes, 6 * 50_000);
  assert.equal(brief.journal_entries >= 1, true);
  assert.equal(brief.frames, 36);
  assert.equal(typeof brief.frames_fps, 'number');
  assert.equal(brief.seal_ok, null, '未封版仍为 null（不伪造）');
  // 新增字段
  assert.equal(brief.frame_axis.version, 1, '帧时间轴对账 wire');
  assert.equal(brief.mux_budget.version, 1, '封装预算 wire');
  assert.equal(brief.segment_budget.version, 1, '分片存储预算 wire');
  assert.equal(brief.video_evidence.storage.action, 'keep');
  assert.equal(Array.isArray(brief.video_evidence.repair.ranges), true);
  assert.equal(persistenceBrief(null), null);
  const empty = persistenceBrief(createPersistenceSession({ recordingId: 'r', now: NOW }));
  assert.equal(empty.frame_axis.counts.frames, 0, '空会话不伪造帧');
  assert.equal(empty.segment_budget.action, 'keep');
});

test('sealed 会话：persistenceBrief 的 frames/seal 与新增预算字段同时成立', () => {
  const session = sessionWithFrames();
  const sealed = sealPersistence(session, { now: NOW + 10_000, totalBytes: 300_000 });
  const brief = persistenceBrief(sealed.session);
  assert.equal(brief.state, 'sealed');
  assert.equal(brief.seal_ok, true);
  assert.equal(brief.frames, 36);
  assert.equal(brief.frame_axis.counts.frames, 36);
  assert.equal(brief.mux_budget.fragmentCount >= 1, true);
  assert.equal(brief.segment_budget.segments, sealed.session.segments.length);
});

test('persistenceVerifyView 只加字段：旧诊断字段不变，新证据随 record 维度出现', () => {
  const session = sessionWithFrames();
  const sealed = sealPersistence(session, { now: NOW + 10_000, totalBytes: 300_000 });
  const record = {
    id: 'rec-e11',
    recordingId: 'rec-e11',
    mime: 'video/mp4',
    width: 1280,
    height: 720,
    durationMs: 6000,
    startedAt: NOW,
    ...persistRecordFragments(session, fragments(6), NOW).session
      ? { ...sealed.fields }
      : {},
  };
  const view = persistenceVerifyView(record, { now: NOW + 20_000 });
  assert.equal(view.state, 'sealed');
  assert.equal(view.journal.entries >= 1, true);
  assert.equal(view.diagnostics.healthy, true);
  // 新增字段
  assert.equal(view.frame_axis.version, 1);
  assert.equal(view.mux_budget.version, 1);
  assert.equal(view.segment_budget.version, 1);
  assert.equal(view.video_evidence.version, 1);
  // 有宽高时才有转码预算（无维度不伪造）
  assert.notEqual(view.transcode_budget, null);
  assert.equal(['skip', 'transcode', 'downgrade', 'reject'].includes(view.transcode_budget.action), true);
  const noSize = persistenceVerifyView({ ...record, width: 0, height: 0 }, { now: NOW + 20_000 });
  assert.equal(noSize.transcode_budget, null);
  assert.equal(persistenceVerifyView(null), null);
});

test('video.recover 的 summarizeRestore 只加字段：旧摘要不变，新增封装/存储预算', () => {
  const manifest = {
    version: 2,
    recordingId: 'rec-e11',
    sealed: false,
    segments: fragments(3).map((fragment) => ({
      index: fragment.index,
      bytes: fragment.bytes,
      checksum: fragment.sha256,
      tMs: fragment.tMs,
      durationMs: fragment.durationMs,
    })),
  };
  const parts = fragments(3).map((fragment) => ({
    index: fragment.index,
    bytes: fragment.bytes,
    checksum: fragment.sha256,
    position: fragment.index * fragment.bytes,
  }));
  const plan = planPartialReassembly(manifest, parts, { recordingId: 'rec-e11', now: NOW + 1000 });
  const summary = summarizeRestore(plan);
  // 既有字段（video-restore.test.mjs 口径）
  assert.equal(summary.strategy, plan.strategy);
  assert.equal(summary.segments, plan.segments);
  assert.equal(summary.totalSegments, 3);
  assert.equal(summary.sealed, false);
  assert.equal(typeof summary.issues, 'number');
  // 新增字段
  assert.equal(summary.mux_budget.version, 1);
  assert.equal(summary.segment_budget.version, 1);
  assert.equal(summary.segment_budget.segments, plan.segments);
  assert.equal(summarizeRestore(null), null);
});

test('接线涉及文件都在 1100 行复杂度预算内', () => {
  for (const relative of [
    'extension/src/lib/video-persist-view.js',
    'extension/src/lib/video-restore.js',
    ...NEW_MODULES,
  ]) {
    const lines = read(relative).split('\n').length;
    assert.ok(lines <= 1100, relative + ' 超过 1100 行预算：' + lines);
  }
  // video.js 本身也不能因接线被撑破（1100 行预算）
  assert.ok(read('extension/src/video.js').split('\n').length <= 1100);
});
