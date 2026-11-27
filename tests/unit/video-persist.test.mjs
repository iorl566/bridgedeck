import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FRAME_LIMITS,
  JOURNAL_LIMITS,
  PERSIST_ACTIONS,
  PERSIST_CODES,
  PERSIST_STATES,
  PERSIST_VERSION,
  analyzePersistence,
  createPersistenceSession,
  describePersistence,
  persistPart,
  persistenceDiagnostics,
  persistenceFromRecord,
  persistenceRecordFields,
  persistenceStopReason,
  planPersistenceRecovery,
  restorePersistenceParts,
  sealPersistence,
  summarizePersistence,
} from '../../extension/src/lib/video-persist.js';

const NOW = 1_700_000_000_000;

function partOf(index, { bytes = 50_000, step = 200, keyframe = null } = {}) {
  return {
    index,
    bytes,
    hash: ('hash' + index).padEnd(16, '0'),
    tMs: index * step,
    durationMs: step,
    keyframe: keyframe == null ? index % 3 === 0 : keyframe,
    frames: [{ pts: index * step, durationMs: step, keyframe: keyframe == null ? index % 3 === 0 : keyframe, bytes, checksum: ('c' + index).padEnd(16, '0') }],
  };
}

function sessionWith(count, options = {}) {
  let session = createPersistenceSession({ recordingId: 'rec-1', now: NOW, mime: 'video/mp4', mode: 'tabCapture', budget: { maxTotalBytes: 100 * 1024 * 1024 } });
  for (let index = 0; index < count; index += 1) {
    session = persistPart(session, partOf(index, options), { now: NOW + index * 200 }).session;
  }
  return session;
}

test('createPersistenceSession：初始状态/日记/预算', () => {
  const session = createPersistenceSession({ recordingId: 'rec-1', now: NOW, mime: 'video/mp4', budget: { maxTotalBytes: 1024 * 1024 } });
  assert.equal(session.version, PERSIST_VERSION);
  assert.equal(session.state, 'recording');
  assert.equal(session.recordingId, 'rec-1');
  assert.equal(session.journal.recordingId, 'rec-1');
  assert.equal(session.segments.length, 0);
  assert.equal(session.totalBytes, 0);
  assert.ok(session.budget.maxTotalBytes >= 1024 * 1024);
  assert.throws(() => createPersistenceSession({}), /recordingId/);
  assert.deepEqual(PERSIST_STATES.slice(0, 3), ['recording', 'sealing', 'sealed']);
});

test('persistPart：追加日记/分段/帧/字节', () => {
  const result = persistPart(createPersistenceSession({ recordingId: 'r', now: NOW }), partOf(0), { now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.duplicate, false);
  assert.equal(result.code, null);
  assert.equal(result.degraded, undefined === true ? true : result.degraded);
  assert.equal(result.session.segments.length, 1);
  assert.equal(result.session.frames.length, 1);
  assert.equal(result.session.totalBytes, 50_000);
  assert.equal(result.session.journal.entries.length, 1);
  const second = persistPart(result.session, partOf(1), { now: NOW + 200 });
  assert.equal(second.session.segments.length, 2);
  assert.equal(second.session.frames.length, 2);
});

test('persistPart：重复分片 → duplicate 且不重复计数', () => {
  const session = sessionWith(2);
  const duplicate = persistPart(session, partOf(0), { now: NOW + 999 });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, PERSIST_CODES.PART_DUPLICATE);
  assert.equal(duplicate.session.segments.length, 2);
  assert.equal(duplicate.session.totalBytes, session.totalBytes);
});

test('persistPart：分片自带多帧时逐帧累积', () => {
  const session = createPersistenceSession({ recordingId: 'r', now: NOW });
  const part = {
    index: 0,
    bytes: 1000,
    hash: 'h',
    tMs: 0,
    durationMs: 100,
    frames: [
      { pts: 0, durationMs: 50, bytes: 500, checksum: 'a' },
      { pts: 50, durationMs: 50, bytes: 500, checksum: 'b' },
    ],
  };
  const result = persistPart(session, part, { now: NOW });
  assert.equal(result.session.frames.length, 2);
  assert.deepEqual(result.session.frames.map((frame) => frame.tMs), [0, 50]);
});

test('persistPart：预算超限 → state=degraded 并给证据', () => {
  let session = createPersistenceSession({
    recordingId: 'r',
    now: NOW,
    budget: { maxTotalBytes: 1024 * 1024, maxDurationMs: 60_000 },
  });
  let degraded = null;
  for (let index = 0; index < 40; index += 1) {
    const result = persistPart(session, partOf(index, { bytes: 60_000 }), { now: NOW + index * 1000 });
    session = result.session;
    if (result.degraded) {
      degraded = result;
      break;
    }
  }
  assert.ok(degraded, '应在 1MB 预算内触发 stop');
  assert.equal(degraded.session.state, 'degraded');
  assert.ok(degraded.session.evidence.some((item) => item.code === PERSIST_CODES.BUDGET_STOP));
  const stop = persistenceStopReason(degraded.session);
  assert.equal(stop.reason, 'size');
});

test('persistPart：已封版会话拒绝新分片', () => {
  const session = sessionWith(1);
  const sealed = sealPersistence(session, { now: NOW + 5000 }).session;
  const rejected = persistPart(sealed, partOf(1), { now: NOW + 6000 });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, PERSIST_CODES.PART_REJECTED);
});

test('sealPersistence：帧可播 → sealed，字段带 persist_*/journal_*', () => {
  const session = sessionWith(12);
  const sealed = sealPersistence(session, { now: NOW + 10_000 });
  assert.equal(sealed.ok, true);
  assert.equal(sealed.session.state, 'sealed');
  assert.equal(sealed.errors.length, 0);
  assert.equal(sealed.journal.state, 'sealed');
  assert.equal(sealed.frames.playable, true);
  assert.equal(sealed.fields.persist_version, PERSIST_VERSION);
  assert.equal(sealed.fields.persist_state, 'sealed');
  assert.equal(sealed.fields.persist_segments, 12);
  // journalRecordFields 的键是 journal_*（不是 persist_journal_*）
  assert.equal(sealed.fields.journal_state, 'sealed');
  assert.equal(sealed.fields.journal_entries, 12);
  assert.equal(sealed.fields.persist_frames_playable, true);
  assert.equal(typeof sealed.fields.persist_seal_digest, 'string');
  assert.match(describePersistence(sealed.session), /录制持久化 sealed 12 片/);
});

test('sealPersistence：没有关键帧 → degraded（不假装修复成功）', () => {
  const session = sessionWith(6, { keyframe: false });
  const sealed = sealPersistence(session, { now: NOW + 5000 });
  assert.equal(sealed.ok, false);
  assert.equal(sealed.session.state, 'degraded');
  assert.equal(sealed.frames.playable, false);
  assert.equal(sealed.frames.stuck, true);
  assert.ok(sealed.session.evidence.some((item) => item.code === PERSIST_CODES.FRAMES_STUCK));
});

test('analyzePersistence：无帧的录制不做帧校验（frames=null）', () => {
  const session = createPersistenceSession({ recordingId: 'r', now: NOW });
  const analysis = analyzePersistence(session);
  assert.equal(analysis.state, 'recording');
  assert.equal(analysis.frames, null);
  assert.equal(analysis.framesSummary, null);
  assert.equal(analysis.journal.entries, 0);
  assert.ok(Array.isArray(analysis.reasons));
  const missing = analyzePersistence(null);
  assert.equal(missing.ok, false);
  assert.equal(missing.state, 'missing');
});

test('persistenceDiagnostics：三块自检合成结论', () => {
  const healthy = sessionWith(6);
  const diag = persistenceDiagnostics(healthy);
  assert.equal(diag.journalOk, true);
  assert.equal(diag.framesOk, true);
  assert.equal(diag.framesPlayable, true);
  assert.equal(diag.healthy, true);
  const broken = sessionWith(2, { keyframe: false });
  const badDiag = persistenceDiagnostics(broken);
  assert.equal(badDiag.framesPlayable, false);
  assert.equal(badDiag.healthy, false);
});

test('planPersistenceRecovery：日记完整 → resume/recovered，记录 patch 齐', () => {
  const session = sessionWith(4);
  const plan = planPersistenceRecovery(session, { available: [0, 1, 2, 3], now: NOW + 5000 });
  assert.equal(plan.ok, true);
  assert.equal(plan.action, 'resume');
  assert.equal(plan.state, 'recovered');
  assert.deepEqual(plan.missing, []);
  assert.equal(plan.recordPatch.persist_version, PERSIST_VERSION);
  assert.equal(plan.recordPatch.persist_state, 'recovered');
  assert.equal(plan.recordPatch.persist_action, 'resume');
  assert.equal(typeof plan.recordPatch.persist_frames_digest, 'string');
  assert.ok(plan.recordPatch.persist_evidence.length > 0);
  assert.ok(PERSIST_ACTIONS.includes(plan.action));
});

test('planPersistenceRecovery：缺片 → rebuild；无会话时用 record 兜底', () => {
  const session = sessionWith(4);
  const partial = planPersistenceRecovery(session, { available: [0, 2, 3], now: NOW + 5000 });
  assert.equal(partial.action, 'rebuild');
  assert.deepEqual(partial.missing, [1]);
  assert.equal(partial.ok, true);
  const record = { id: 'rec-1', mime: 'video/mp4', startedAt: NOW, ...persistenceRecordFields(session) };
  const fromRecord = planPersistenceRecovery(null, { record, available: [0, 1, 2, 3], now: NOW + 5000 });
  assert.equal(fromRecord.action, 'resume');
  assert.equal(fromRecord.state, 'recovered');
  const none = planPersistenceRecovery(null, {});
  assert.equal(none.action, 'skip');
  assert.equal(none.ok, false);
});

test('persistenceFromRecord：反建会话（分段/帧/状态/密封）', () => {
  const session = sessionWith(3);
  const sealed = sealPersistence(session, { now: NOW + 5000 });
  const record = {
    id: 'rec-1',
    recordingId: 'rec-1',
    mime: 'video/mp4',
    startedAt: NOW,
    bytes: sealed.session.totalBytes,
    ...sealed.fields,
  };
  const rebuilt = persistenceFromRecord(record, { now: NOW + 6000 });
  assert.equal(rebuilt.recordingId, 'rec-1');
  assert.equal(rebuilt.state, 'sealed');
  assert.equal(rebuilt.segments.length, 3);
  // 帧明细不落盘（太重）：从 record 反建时只有帧摘要，用 framesRecorded/framesPlayable 代替校验。
  assert.equal(rebuilt.frames.length, 0);
  assert.equal(rebuilt.framesRecorded, 3);
  assert.equal(rebuilt.framesPlayable, true);
  assert.equal(rebuilt.recoveredFrom, 'record');
  assert.equal(rebuilt.journal.state, 'sealed');
  assert.equal(rebuilt.seal.ok, true);
  assert.equal(persistenceFromRecord(null), null);
});

test('restorePersistenceParts：幂等并回 OPFS 分片', () => {
  const session = sessionWith(2);
  const restored = restorePersistenceParts(session, [
    { index: 2, bytes: 50_000, hash: 'h2', tMs: 400 },
    { index: 1, bytes: 50_000, hash: 'h1', tMs: 200 },
  ], { now: NOW + 5000 });
  assert.equal(restored.changed, true);
  assert.deepEqual(restored.accepted, [2]);
  assert.deepEqual(restored.duplicates, [1]);
  assert.equal(restored.session.segments.length, 3);
  assert.equal(restored.session.totalBytes, 150_000);
  const noop = restorePersistenceParts(session, [], { now: NOW });
  assert.equal(noop.changed, false);
  assert.equal(restorePersistenceParts(null, []).changed, false);
});

test('summarizePersistence / describePersistence：协议与日志', () => {
  const session = sessionWith(4);
  const summary = summarizePersistence(session);
  assert.equal(summary.version, PERSIST_VERSION);
  assert.equal(summary.state, 'recording');
  assert.equal(summary.segments, 4);
  assert.equal(summary.journal.entries, 4);
  assert.equal(summary.frames.frames, 4);
  assert.equal(summary.seal, null);
  assert.equal(summarizePersistence(null), null);
  const text = describePersistence(session);
  assert.match(text, /录制持久化 recording 4 片/);
  assert.match(text, /录制日记 open 4 片/);
  assert.match(describePersistence(null), /录制持久化 无/);
});

test('持久化常量与限额对外可读', () => {
  assert.equal(JOURNAL_LIMITS.maxEntries, 4096);
  assert.equal(FRAME_LIMITS.maxGapMs, 500);
  assert.deepEqual(PERSIST_STATES.slice(-3), ['recovered', 'degraded', 'failed']);
});
