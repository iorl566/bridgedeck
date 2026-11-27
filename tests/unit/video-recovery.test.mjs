import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  RECOVERY_CODES,
  auditRecoveredRecording,
  recoveryRecordPatch,
  scanRecoveryCandidates,
  summarizeRecovery,
  summarizeScan,
} from '../../extension/src/lib/video-recovery.js';
import { VIDEO_SEGMENT_CODES, appendSegment, createSegmentManifest } from '../../extension/src/lib/video-manifest.js';

function box(type, payload = Buffer.alloc(0)) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'ascii');
  return Buffer.concat([head, payload]);
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}

function sampleMp4() {
  const mvhdPayload = Buffer.alloc(100);
  mvhdPayload.writeUInt32BE(1000, 12);
  const tkhdPayload = Buffer.alloc(84);
  tkhdPayload.writeUInt32BE(1, 8);
  const mdhdPayload = Buffer.alloc(24);
  mdhdPayload.writeUInt32BE(1000, 12);
  const hdlrPayload = Buffer.alloc(24);
  hdlrPayload.write('vide', 8, 'ascii');
  const moov = box('moov', Buffer.concat([
    box('mvhd', mvhdPayload),
    box('trak', Buffer.concat([
      box('tkhd', tkhdPayload),
      box('mdia', Buffer.concat([box('mdhd', mdhdPayload), box('hdlr', hdlrPayload)])),
    ])),
  ]));
  const moof = box('moof', box('traf', Buffer.concat([
    box('tfhd', Buffer.concat([u32(0), u32(1)])),
    box('tfdt', Buffer.concat([u32(0), u32(0)])),
    box('trun', Buffer.concat([u32(0x000100), u32(2), u32(500), u32(500)])),
  ])));
  return Buffer.concat([box('ftyp', Buffer.from('isom')), moov, moof, box('mdat', Buffer.alloc(64))]);
}

function shaOf(buffer) {
  return createHash('sha256').update(Buffer.from(buffer)).digest('hex');
}

function recordOf(buffer) {
  return {
    id: 'rec-1',
    mime: 'video/mp4',
    bytes: buffer.length,
    blob: new Blob([buffer], { type: 'video/mp4' }),
    fragments: [{ index: 0, at: 100, bytes: buffer.length, sha256: shaOf(buffer) }],
    completeness: 'partial',
    stop_reason: 'recovered',
  };
}

function manifestFor(buffer, overrides = {}) {
  const manifest = createSegmentManifest({ recordingId: 'rec-1', codec: 'avc', now: 1 });
  const appended = appendSegment(manifest, {
    index: 0,
    atMs: 0,
    bytes: buffer.length,
    codec: 'avc',
    lastFrameAt: 1000,
    checksum: shaOf(buffer),
  });
  assert.equal(appended.ok, true);
  return appended.manifest;
}

test('scanRecoveryCandidates：无依赖跳过 / 扫描失败 / 按 manifest+分片给出候选', async () => {
  const skipped = await scanRecoveryCandidates({});
  assert.equal(skipped.ok, false);
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.evidence[0].code, RECOVERY_CODES.SCAN_UNAVAILABLE);

  const failed = await scanRecoveryCandidates({ listManifests: async () => { throw new Error('opfs io'); } });
  assert.equal(failed.ok, false);
  assert.equal(failed.evidence[0].code, RECOVERY_CODES.SCAN_FAILED);

  const buffer = sampleMp4();
  const manifest = manifestFor(buffer);
  const deps = {
    listManifests: async () => [{ recordingId: 'rec-1', parts: 1 }],
    readManifest: async () => manifest,
    listParts: async () => [{ sequence: 0, position: 0, size: buffer.length }],
  };
  const scan = await scanRecoveryCandidates(deps);
  assert.equal(scan.ok, true);
  assert.equal(scan.count, 1);
  assert.equal(scan.unsealed, 1);
  assert.equal(scan.recoverable, 1);
  const candidate = scan.candidates[0];
  assert.equal(candidate.recordingId, 'rec-1');
  assert.equal(candidate.parts, 1);
  assert.equal(candidate.plan.recovered, true);
  assert.equal(candidate.plan.completeness, 'complete');
  assert.equal(scan.evidence.some((item) => item.code === RECOVERY_CODES.CANDIDATE && item.recordingId === 'rec-1'), true);

  const missingPart = await scanRecoveryCandidates({
    listManifests: async () => [manifest],
    listParts: async () => [],
  });
  assert.equal(missingPart.recoverable, 0);
  assert.equal(missingPart.candidates[0].plan.recovered, false);
  assert.equal(missingPart.evidence.some((item) => item.code === RECOVERY_CODES.FAILED), true);
});

test('auditRecoveredRecording：健康恢复 → recovered/partial、分片哈希通过', async () => {
  const buffer = sampleMp4();
  const audit = await auditRecoveredRecording(recordOf(buffer));
  assert.equal(audit.ok, true);
  assert.equal(audit.recovered, true);
  assert.equal(audit.state, 'recovered');
  assert.equal(audit.bytes, buffer.length);
  assert.equal(audit.completeness, 'partial');
  assert.equal(audit.checks.fragment_hashes, true);
  assert.equal(audit.checks.fragments, 1);
  assert.equal(audit.checks.container, 'mp4');
  assert.equal(audit.checks.journal.ok, true);
  assert.equal(audit.checks.seek.seekable, false); // 未插入 sidx 的 fMP4
  assert.equal(audit.evidence.some((item) => item.code === RECOVERY_CODES.RECOVERED), true);
  assert.equal(audit.evidence.some((item) => item.code === 'E_VIDEO_MANIFEST_MISSING'), true);
});

test('auditRecoveredRecording：manifest 完整计划 → completeness=complete；截断 → partial 但有证据', async () => {
  const buffer = sampleMp4();
  const manifest = manifestFor(buffer);
  const complete = await auditRecoveredRecording(recordOf(buffer), {
    manifest,
    availableParts: [{ index: 0, bytes: buffer.length }],
  });
  assert.equal(complete.ok, true);
  assert.equal(complete.completeness, 'complete');
  assert.equal(complete.checks.manifest.completeness, 'complete');

  const truncated = await auditRecoveredRecording(recordOf(buffer), {
    manifest,
    availableParts: [{ index: 0, bytes: buffer.length - 10 }],
  });
  assert.equal(truncated.ok, true);
  assert.equal(truncated.completeness, 'partial');
  assert.equal(truncated.evidence.some((item) => item.code === VIDEO_SEGMENT_CODES.SEGMENT_TRUNCATED), true);

  const missingFirst = await auditRecoveredRecording(recordOf(buffer), {
    manifest,
    availableParts: [],
  });
  assert.equal(missingFirst.ok, false);
  assert.equal(missingFirst.state, 'failed');
});

test('auditRecoveredRecording：哈希篡改/非视频容器/空记录 → failed', async () => {
  const buffer = sampleMp4();
  const tampered = recordOf(buffer);
  tampered.fragments = [{ index: 0, at: 0, bytes: buffer.length, sha256: 'f'.repeat(64) }];
  const hashAudit = await auditRecoveredRecording(tampered);
  assert.equal(hashAudit.ok, false);
  assert.equal(hashAudit.state, 'failed');
  assert.equal(hashAudit.evidence.some((item) => item.code === 'E_VIDEO_FRAGMENT_HASH_MISMATCH' && item.scope === 'fragments'), true);

  const junk = Buffer.from('this is not a video at all');
  const junkRecord = {
    id: 'rec-junk',
    mime: 'video/mp4',
    bytes: junk.length,
    blob: new Blob([junk]),
    fragments: [{ index: 0, at: 0, bytes: junk.length, sha256: shaOf(junk) }],
  };
  const junkAudit = await auditRecoveredRecording(junkRecord);
  assert.equal(junkAudit.ok, false);
  assert.equal(junkAudit.evidence.some((item) => item.code === RECOVERY_CODES.CONTAINER_UNKNOWN), true);

  const emptyAudit = await auditRecoveredRecording({ id: 'rec-empty', mime: 'video/mp4', bytes: 0, blob: new Blob([]), fragments: [] });
  assert.equal(emptyAudit.ok, false);
  assert.equal(emptyAudit.state, 'failed');

  const noBlobAudit = await auditRecoveredRecording({ id: 'rec-noblob', bytes: 12 });
  assert.equal(noBlobAudit.ok, false);
  assert.equal(noBlobAudit.evidence.some((item) => item.code === RECOVERY_CODES.AUDIT_FAILED), true);
});

test('recoveryRecordPatch：只带标量/数组证据（不含 blob），保持既有 recovered 字段语义', () => {
  const record = { id: 'rec-1', bytes: 100, blob: new Blob([new Uint8Array(100)]) };
  const patch = recoveryRecordPatch({
    state: 'failed',
    ok: false,
    bytes: 100,
    completeness: 'partial',
    evidence: [{ code: 'X', severity: 'error', message: 'm' }],
    checks: { fragments: 1 },
    plan: { recovered: false, completeness: 'failed', keptSegments: [], droppedSegments: [{ index: 0 }], truncatedSegments: [], bytes: 0, reason: 'unrecoverable' },
    manifestSummary: { segments: 1 },
  }, record);
  assert.equal(patch.recording_state, 'recovered'); // failed 审计也落 recovered（保留可播放文件）
  assert.equal(patch.recovered, true);
  assert.equal(patch.stop_reason, 'recovered');
  assert.equal(patch.completeness, 'partial');
  assert.equal(patch.recording_state_evidence.length, 1);
  assert.equal(patch.recovery.ok, false);
  assert.equal(patch.recovery.plan.recovered, false);
  assert.equal(patch.recovery.plan.dropped, 1);
  assert.equal(patch.segment_manifest.segments, 1);
  assert.equal('blob' in patch, false);
  assert.equal('recordingId' in patch, false);
});

test('summarizeRecovery / summarizeScan 输出紧凑摘要', () => {
  const summary = summarizeRecovery({
    ok: true,
    state: 'recovered',
    bytes: 10,
    completeness: 'partial',
    evidence: [{ code: 'a' }, { code: 'b' }],
    plan: { recovered: true, completeness: 'partial', keptSegments: [1, 2], droppedSegments: [3], truncatedSegments: [] },
  });
  assert.equal(summary.ok, true);
  assert.equal(summary.issues, 2);
  assert.equal(summary.plan.segments, 2);
  assert.equal(summary.plan.dropped, 1);
  assert.equal(summarizeRecovery(null), null);

  const scanSummary = summarizeScan({
    ok: true,
    count: 2,
    unsealed: 1,
    recoverable: 1,
    candidates: [
      { recordingId: 'a', sealed: false, parts: 2, manifest: { segments: 2, bytes: 10, sealed: false }, plan: { recovered: true, completeness: 'complete', bytes: 10, reason: 'complete' } },
      { recordingId: 'b', sealed: true, parts: 0, manifest: { segments: 0, bytes: 0, sealed: true }, plan: null },
    ],
  });
  assert.equal(scanSummary.candidates, 2);
  assert.equal(scanSummary.recordings.length, 2);
  assert.equal(scanSummary.recordings[0].plan.recovered, true);
  assert.equal(scanSummary.recordings[1].plan, null);
  assert.equal(summarizeScan(null), null);
});
