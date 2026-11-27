import test from 'node:test';
import assert from 'node:assert/strict';
import {
  persistRecordFragments,
  persistSummaryOf,
  persistenceBrief,
  persistenceRecoveryView,
  persistenceVerifyView,
  sealPersistenceFromFragments,
} from '../../extension/src/lib/video-persist-view.js';
import { createPersistenceSession, persistenceRecordFields } from '../../extension/src/lib/video-persist.js';

const NOW = 1_700_000_000_000;

function fragmentsOf(count, { bytes = 50_000 } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    index,
    bytes,
    sha256: ('sha' + index).padEnd(16, '0'),
    durationMs: 200,
    tMs: index * 200,
    keyframe: index % 3 === 0,
  }));
}

function sessionWith(count) {
  let session = createPersistenceSession({ recordingId: 'rec-1', now: NOW, mime: 'video/mp4', budget: { maxTotalBytes: 64 * 1024 * 1024 } });
  const parts = fragmentsOf(count).map((fragment) => ({
    index: fragment.index,
    bytes: fragment.bytes,
    hash: fragment.sha256,
    tMs: fragment.tMs,
    durationMs: fragment.durationMs,
    keyframe: fragment.keyframe,
    frames: [{ pts: fragment.tMs, durationMs: fragment.durationMs, keyframe: fragment.keyframe, bytes: fragment.bytes, checksum: fragment.sha256 }],
  }));
  // 复用纯函数入口，保持与运行时同一条路径
  return { session, parts };
}

test('persistenceBrief：空会话 → 零值证据（不编造帧结论）', () => {
  const { session } = sessionWith(0);
  const brief = persistenceBrief(session);
  assert.equal(brief.state, 'recording');
  assert.equal(brief.segments, 0);
  assert.equal(brief.bytes, 0);
  assert.equal(brief.journal_entries, 0);
  assert.equal(brief.frames, 0);
  assert.equal(brief.frames_playable, null);
  assert.equal(brief.seal_ok, null);
  assert.equal(persistenceBrief(null), null);
});

test('persistenceBrief：有帧时给出可播/fps 结论', () => {
  const { session, parts } = sessionWith(0);
  const sealed = sealPersistenceFromFragments(session, fragmentsOf(4), { now: NOW + 5000, totalBytes: 200_000 });
  const brief = persistenceBrief(sealed.session);
  assert.equal(brief.state, 'sealed');
  assert.equal(brief.segments, 4);
  assert.equal(brief.bytes, 200_000);
  assert.ok(brief.journal_entries >= 1);
  assert.equal(typeof brief.journal_chain, 'string');
  assert.equal(brief.frames > 0, true);
  assert.equal(brief.seal_ok, true);
  assert.ok(Array.isArray(parts));
});

test('persistSummaryOf：老记录没有 persist_* 时返回 null（不伪造）', () => {
  assert.equal(persistSummaryOf(null), null);
  assert.equal(persistSummaryOf({}), null);
  assert.equal(persistSummaryOf({ id: 'x' }), null);
  const summary = persistSummaryOf({
    persist_state: 'sealed',
    persist_segments: 4,
    persist_bytes: 1000,
    persist_journal_entries: 4,
    persist_journal_missing: [],
    persist_frames: 12,
    persist_frames_playable: true,
    persist_frames_digest: 'abcd',
    persist_seal_ok: true,
  });
  assert.deepEqual(summary, {
    state: 'sealed',
    segments: 4,
    bytes: 1000,
    journal_entries: 4,
    journal_valid: true,
    frames: 12,
    frames_playable: true,
    frames_digest: 'abcd',
    seal_ok: true,
  });
  const missingJournal = persistSummaryOf({ persist_state: 'open', persist_journal_missing: [1] });
  assert.equal(missingJournal.journal_valid, false);
});

test('persistRecordFragments：fragments → 日记条目（幂等）', () => {
  const { session } = sessionWith(0);
  const first = persistRecordFragments(session, fragmentsOf(3), NOW);
  assert.equal(first.accepted, 3);
  assert.equal(first.session.journal.entries.length, 3);
  assert.equal(first.session.segments.length, 3);
  assert.equal(first.session.frames.length, 3);
  const again = persistRecordFragments(first.session, fragmentsOf(3), NOW + 100);
  assert.equal(again.accepted, 0, '同一批 fragments 再灌一次不应重复计数');
  assert.equal(again.session.journal.entries.length, 3);
  assert.equal(persistRecordFragments(null, fragmentsOf(1), NOW).accepted, 0);
});

test('sealPersistenceFromFragments：收尾一次调用给出 session/summary/fields', () => {
  const { session } = sessionWith(0);
  const result = sealPersistenceFromFragments(session, fragmentsOf(5), { now: NOW + 5000, totalBytes: 250_000 });
  assert.equal(result.ok, true);
  assert.equal(result.session.state, 'sealed');
  assert.equal(result.accepted, 5);
  assert.equal(result.summary.state, 'sealed');
  assert.equal(result.fields.persist_state, 'sealed');
  assert.equal(result.fields.persist_segments, 5);
  assert.ok(result.fields.journal_chain);
});

test('persistenceVerifyView：record → 诊断视图；无 record 返回 null', () => {
  const { session } = sessionWith(0);
  const sealed = sealPersistenceFromFragments(session, fragmentsOf(3), { now: NOW + 5000, totalBytes: 150_000 });
  const record = { id: 'rec-1', recordingId: 'rec-1', mime: 'video/mp4', startedAt: NOW, ...sealed.fields };
  const view = persistenceVerifyView(record, { now: NOW + 6000 });
  assert.equal(view.state, 'sealed');
  assert.equal(view.segments, 3);
  assert.equal(view.journal.entries, 3);
  assert.equal(view.diagnostics.journalOk, true);
  assert.equal(view.diagnostics.healthy, true);
  assert.equal(persistenceVerifyView(null), null);
  // 没有 journal_parts 的“老记录”：不抛，返回可解释的视图
  const legacy = persistenceVerifyView({ id: 'legacy', bytes: 10 }, { now: NOW });
  assert.ok(legacy === null || legacy.state === 'recording');
});

test('persistenceRecoveryView：规划恢复 + record_patch 一起给', () => {
  const { session } = sessionWith(0);
  const current = persistRecordFragments(session, fragmentsOf(4), NOW).session;
  assert.equal(current.segments.length, 4);
  const view = persistenceRecoveryView(current, { now: NOW + 5000, available: [0, 1, 2, 3] });
  assert.equal(view.view.recovery_action, 'resume');
  assert.equal(view.view.recovery_state, 'recovered');
  assert.deepEqual(view.view.recovery_missing, []);
  assert.equal(view.recordPatch.persist_action, 'resume');
  assert.equal(view.recordPatch.persist_version, 1);
  assert.equal(typeof view.recordPatch.persist_frames_digest, 'string');
});

test('persistenceRecoveryView：缺片 → rebuild，并带 repair/reasons', () => {
  const { session } = sessionWith(0);
  const current = persistRecordFragments(session, fragmentsOf(4), NOW).session;
  const view = persistenceRecoveryView(current, { now: NOW + 5000, available: [0, 2, 3] });
  assert.equal(view.view.recovery_action, 'rebuild');
  assert.deepEqual(view.view.recovery_missing, [1]);
  assert.ok(Array.isArray(view.view.reasons));
});

test('record 往返：persistenceRecordFields → persistSummaryOf 一致', () => {
  const { session } = sessionWith(0);
  const sealed = sealPersistenceFromFragments(session, fragmentsOf(2), { now: NOW + 1000, totalBytes: 100_000 });
  const record = { ...sealed.fields };
  const summary = persistSummaryOf(record);
  assert.equal(summary.state, sealed.session.state);
  assert.equal(summary.segments, 2);
  assert.equal(summary.seal_ok, sealed.ok);
  assert.deepEqual(Object.keys(persistenceRecordFields(sealed.session)).sort(), Object.keys(sealed.fields).sort());
});
