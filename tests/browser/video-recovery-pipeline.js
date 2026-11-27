// tests/browser/video-recovery-pipeline.js —— 真实 Chromium 的视频崩溃恢复回归。
//
// 真实素材：页面内用 canvas.captureStream(0) + requestFrame() 逐帧喂给 MediaRecorder，
// 得到浏览器真正编码出来的 WebM 字节（不是手写魔数）。然后：
//   1) 把真实字节切成 3 个 OPFS 分片，用 crypto.subtle 计算逐片 SHA-256 并 seal manifest；
//   2) 模拟崩溃：第 3 片只写了一半（bytes < manifest）→ planSegmentRecovery 给出 partial 前缀；
//   3) 用 scanRecoveryCandidates / auditRecoveredRecording（真实运行时模块）证明“可播放前缀”；
//   4) 恢复出的 Blob 就是真实录制字节的前缀：容器（WebM/EBML）可识别、浏览器 canPlayType 支持；
//   5) 失败原因分类：首片缺失 → 无可用前缀；校验和不匹配 → 内容损坏；扫描不可用 → 环境原因；
//   6) 可读摘要（文本 + JSON）写进页面，供单测断言。
//
// 成功：document.title = VIDEO_RECOVERY_OK:<断言数>；失败：VIDEO_RECOVERY_FAIL:<message>。
import {
  VIDEO_SEGMENT_CODES,
  createSegmentManifest,
  appendSegment,
  sealManifest,
  summarizeManifest,
} from '../../extension/src/lib/video-manifest.js';
import {
  RECOVERY_CODES,
  auditRecoveredRecording,
  recoveryRecordPatch,
  scanRecoveryCandidates,
  summarizeRecovery,
  summarizeScan,
} from '../../extension/src/lib/video-recovery.js';

let passed = 0;
const expect = (value, message) => {
  if (!value) throw new Error(message);
  passed += 1;
};
const setTitle = (value) => { document.title = value; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function byteLengthOf(value) {
  return value && typeof value.length === 'number' ? value.length : 0;
}

function sliceBytes(bytes, start, end) {
  return bytes.slice(start, Math.min(end, bytes.length));
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 真实录制：逐帧 requestFrame，MediaRecorder 编码 WebM。 */
async function recordRealWebm() {
  const canvas = document.getElementById('stage');
  const context = canvas.getContext('2d');
  const colors = ['#c0392b', '#27ae60', '#2980b9', '#8e44ad', '#d35400', '#16a085'];
  const draw = (frame) => {
    context.fillStyle = colors[frame % colors.length];
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#ffffff';
    context.fillRect(8 + (frame * 5) % 120, 20, 24, 24);
    context.fillStyle = '#0f172a';
    context.fillRect(8, 80, 144, 8);
  };
  draw(0);
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0];
  const mimeType = ['video/webm;codecs=vp8', 'video/webm'].find((candidate) => MediaRecorder.isTypeSupported(candidate));
  if (!mimeType) throw new Error('这个浏览器不支持 MediaRecorder/WebM（无法生成真实录制字节）');
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 300000 });
  const chunks = [];
  recorder.ondataavailable = (event) => { if (event.data && event.data.size > 0) chunks.push(event.data); };
  const stopped = new Promise((resolve) => { recorder.onstop = () => resolve(); });
  recorder.start(40);
  let frames = 0;
  while (frames < 24) {
    draw(frames);
    track.requestFrame();
    frames += 1;
    await sleep(8);
  }
  await sleep(40);
  recorder.stop();
  await stopped;
  const blob = new Blob(chunks, { type: mimeType });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { blob, bytes, mimeType, frames };
}

/** 失败原因分类：把 manifest/恢复 plan 的 evidence code 归入稳定类别（可读摘要用）。 */
const FAILURE_CATEGORIES = {
  recovered: 'recovered',
  segment_missing: 'missing-segment',
  segment_truncated: 'truncated-segment',
  segment_checksum_mismatch: 'corrupt-segment',
  segment_first_missing: 'no-playable-prefix',
  segment_unavailable: 'no-playable-prefix',
  scan_unavailable: 'scan-unavailable',
  scan_failed: 'scan-failed',
  manifest_missing: 'manifest-missing',
  recovery_impossible: 'no-playable-prefix',
};
function classifyRecoveryCode(code) {
  const suffix = String(code || '').toLowerCase().replace(/^e_video_/, '').replace(/^e_recovery_/, '');
  for (const [needle, category] of Object.entries(FAILURE_CATEGORIES)) {
    if (suffix.includes(needle)) return category;
  }
  return 'other';
}

function buildPlanSummary(plan, extra = {}) {
  const codes = (plan && Array.isArray(plan.evidence) ? plan.evidence : []).map((item) => item && item.code).filter(Boolean);
  const byCategory = {};
  for (const code of codes) {
    const category = classifyRecoveryCode(code);
    byCategory[category] = (byCategory[category] || 0) + 1;
  }
  return {
    recovered: Boolean(plan && plan.recovered),
    completeness: plan ? plan.completeness : null,
    reason: plan ? plan.reason : null,
    bytes: plan ? plan.bytes : 0,
    segments: plan ? (plan.keptSegments || []).length : 0,
    truncated: plan ? (plan.truncatedSegments || []).length : 0,
    dropped: plan ? (plan.droppedSegments || []).length : 0,
    codes,
    byCategory,
    ...extra,
  };
}

async function main() {
  // ---------------------------------------------------------------- 1) 真实录制字节
  const recording = await recordRealWebm();
  const bytes = recording.bytes;
  expect(byteLengthOf(bytes) > 200, '真实 WebM 字节应大于 200，实际 ' + byteLengthOf(bytes));
  expect(recording.frames === 24, '应逐帧喂入 24 帧，实际 ' + recording.frames);
  expect(bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3, '真实字节应是 EBML/WebM 魔数');
  expect(recording.blob.type.includes('webm'), '真实 Blob MIME 应是 webm，实际 ' + recording.blob.type);
  const videoSupport = document.createElement('video').canPlayType('video/webm; codecs="vp8"');
  expect(videoSupport !== '', '浏览器应声明支持 WebM/VP8（可播放性前提）');
  document.getElementById('status').textContent = 'recorded ' + bytes.length + ' bytes';

  // ---------------------------------------------------------------- 2) 切成 3 个 OPFS 分片（真实哈希 + seal）
  const third = Math.floor(bytes.length / 3);
  const bounds = [[0, third], [third, third * 2], [third * 2, bytes.length]];
  const parts = bounds.map(([start, end], index) => ({ index, bytes: bytes.slice(start, end), start, end }));
  expect(parts.every((part) => part.bytes.length > 0), '每个分片都应有真实字节');
  const checksums = [];
  for (const part of parts) checksums.push(await sha256Hex(part.bytes));
  expect(new Set(checksums).size === 3, '三个真实分片的 SHA-256 应各不相同');
  let manifest = createSegmentManifest({ recordingId: 'rec-browser', codec: 'vp8', mime: recording.blob.type, now: 10_000 });
  for (const [index, part] of parts.entries()) {
    const appended = appendSegment(manifest, {
      index,
      atMs: index * 1000,
      bytes: part.bytes.length,
      codec: 'vp8',
      lastFrameAt: (index + 1) * 1000,
      checksum: checksums[index],
    }, { requireChecksum: true, now: 10_001 + index });
    expect(appended.ok === true, '第 ' + index + ' 片应能追加进 manifest');
    manifest = appended.manifest;
  }
  expect(manifest.segments.length === 3, 'manifest 应记录 3 片');
  const sealed = await sealManifest(manifest, { now: 10_100 });
  expect(sealed.ok === true, 'manifest 应能 seal：' + JSON.stringify(sealed.problems || []));
  const sealedManifest = sealed.sealed;
  expect(sealedManifest.sealed === true && sealedManifest.state === 'sealed', 'seal 后状态应为 sealed');
  expect(sealedManifest.seal.durability === 'verified', '逐片校验和齐全时 durability 应为 verified');
  expect(sealedManifest.totalBytes === bytes.length, 'seal 记录的总字节应等于真实字节数');
  expect(summarizeManifest(sealedManifest).segments === 3, 'manifest 摘要应含 3 片');

  // ---------------------------------------------------------------- 3) 崩溃现场：第 3 片写一半
  const truncatedLength = Math.max(1, parts[2].bytes.length - 32);
  const crashedParts = [
    { index: 0, bytes: parts[0].bytes.length, checksum: checksums[0] },
    { index: 1, bytes: parts[1].bytes.length, checksum: checksums[1] },
    // 截断分片没有落盘校验和（写入中断，checksum 未生成）。
    { index: 2, bytes: truncatedLength },
  ];
  const scanDeps = {
    listManifests: async () => [{ recordingId: 'rec-browser', sealed: true }],
    readManifest: async () => sealedManifest,
    listParts: async () => crashedParts,
  };
  const scan = await scanRecoveryCandidates(scanDeps);
  expect(scan.ok === true && scan.skipped === false, '真实依赖注入时扫描应成功');
  expect(scan.count === 1, '应扫描到 1 个候选录制');
  expect(scan.recoverable === 1, '存在可播放前缀时应标记可恢复');
  expect(scan.unsealed === 0, 'manifest 已 seal，unsealed 应为 0');
  const candidatePlan = scan.candidates[0].plan;
  expect(candidatePlan.recovered === true, '截断分片仍应能重建可播放前缀');
  expect(candidatePlan.completeness === 'partial', '截断时完整性应为 partial，实际 ' + candidatePlan.completeness);
  expect(candidatePlan.truncatedSegments.length === 1, '应记录 1 个截断分片');
  expect(candidatePlan.keptSegments.length === 3, '保留前三片（第 3 片只保留已写入部分）');
  expect(candidatePlan.bytes === parts[0].bytes.length + parts[1].bytes.length + truncatedLength, '可播放前缀字节数应等于分片实际字节之和');
  expect(scan.evidence.some((item) => item.code === RECOVERY_CODES.CANDIDATE), '扫描证据应包含候选记录');
  expect(scan.evidence.some((item) => item.code === VIDEO_SEGMENT_CODES.SEGMENT_TRUNCATED), '扫描证据应包含截断原因');

  // ---------------------------------------------------------------- 4) 恢复出的真实 Blob（可播放前缀）
  const recoveredBytes = sliceBytes(bytes, 0, candidatePlan.bytes);
  expect(recoveredBytes.length === candidatePlan.bytes, '恢复字节数应等于计划前缀字节数');
  expect(recoveredBytes[0] === 0x1a && recoveredBytes[1] === 0x45, '恢复前缀应保留 WebM 头');
  const recoveredBlob = new Blob([recoveredBytes], { type: recording.blob.type });
  expect(recoveredBlob.size === recoveredBytes.length, '恢复 Blob 大小应等于前缀字节数');
  const recoveredUrl = URL.createObjectURL(recoveredBlob);
  expect(recoveredUrl.startsWith('blob:'), '恢复文件应能生成可播放 URL');
  const videoElement = document.createElement('video');
  videoElement.muted = true;
  videoElement.src = recoveredUrl;
  expect(videoElement.src === recoveredUrl, 'video 元素应指向恢复出的 Blob');

  // ---------------------------------------------------------------- 5) 逐片哈希审计
  const recoveredFragments = [];
  let offset = 0;
  for (const [index, length] of [parts[0].bytes.length, parts[1].bytes.length, truncatedLength].entries()) {
    const slice = sliceBytes(recoveredBytes, offset, offset + length);
    recoveredFragments.push({ index, at: index * 1000, bytes: length, sha256: await sha256Hex(slice) });
    offset += length;
  }
  expect(offset === recoveredBytes.length, '片段字节应完整覆盖恢复文件');
  const record = {
    id: 'rec-browser',
    mime: recording.blob.type,
    bytes: recoveredBlob.size,
    blob: recoveredBlob,
    fragments: recoveredFragments,
    completeness: 'partial',
    stop_reason: 'recovered',
  };
  const audit = await auditRecoveredRecording(record, { manifest: sealedManifest, availableParts: crashedParts });
  expect(audit.ok === true, '截断但前缀可播放时审计应通过：' + JSON.stringify(audit.evidence.slice(-3)));
  expect(audit.recovered === true && audit.state === 'recovered', '审计结论应为 recovered');
  expect(audit.completeness === 'partial', '审计完整性应为 partial');
  expect(audit.checks.fragment_hashes === true, '真实逐片 SHA-256 应全部通过');
  expect(audit.checks.fragments === 3, '审计应覆盖 3 个片段');
  expect(audit.checks.container === 'webm', '恢复文件容器应识别为 webm');
  expect(audit.checks.manifest.completeness === 'partial', 'manifest 计划应为 partial');
  expect(audit.evidence.some((item) => item.code === RECOVERY_CODES.RECOVERED), '审计证据应包含 recovered');
  expect(audit.evidence.some((item) => item.code === VIDEO_SEGMENT_CODES.SEGMENT_TRUNCATED), '审计证据应保留截断原因');
  expect(audit.bytes === recoveredBlob.size, '审计字节应等于恢复文件大小');

  // ---------------------------------------------------------------- 6) 紧凑摘要 + 记录补丁
  const recoverySummary = summarizeRecovery(audit);
  expect(recoverySummary.ok === true && recoverySummary.state === 'recovered', '紧凑摘要应反映 recovered');
  expect(recoverySummary.completeness === 'partial', '紧凑摘要完整性应为 partial');
  expect(recoverySummary.plan.truncated === 1, '紧凑摘要应记录 1 个截断分片');
  const scanSummary = summarizeScan(scan);
  expect(scanSummary.candidates === 1 && scanSummary.recoverable === 1, '扫描摘要应记录 1 个可恢复候选');
  expect(scanSummary.recordings[0].plan.completeness === 'partial', '扫描摘要应透出 partial');
  const patch = recoveryRecordPatch(audit, record);
  expect(patch.recording_state === 'recovered', '记录补丁应标记 recovered');
  expect(patch.completeness === 'partial', '记录补丁完整性应为 partial');
  expect(patch.recovery.plan.truncated === 1, '记录补丁应记录截断分片数');
  expect('blob' in patch === false, '记录补丁不应携带 blob');

  // ---------------------------------------------------------------- 7) 失败原因分类（首片缺失 / 校验和损坏 / 扫描不可用）
  const firstMissingPlan = (await scanRecoveryCandidates({
    listManifests: async () => [sealedManifest],
    listParts: async () => crashedParts.slice(1),
  })).candidates[0].plan;
  expect(firstMissingPlan.recovered === false, '首片缺失时无法重建可播放前缀');
  expect(firstMissingPlan.reason === 'first_segment_missing', '首片缺失原因应为 first_segment_missing');
  expect(firstMissingPlan.evidence.some((item) => item.code === VIDEO_SEGMENT_CODES.SEGMENT_FIRST_MISSING), '首片缺失应带结构化证据');
  const corruptParts = [{ index: 0, bytes: parts[0].bytes.length, checksum: 'f'.repeat(64) }, crashedParts[1], crashedParts[2]];
  const corruptPlan = (await scanRecoveryCandidates({
    listManifests: async () => [sealedManifest],
    listParts: async () => corruptParts,
  })).candidates[0].plan;
  expect(corruptPlan.recovered === false, '首片校验和不匹配时不可恢复');
  expect(corruptPlan.evidence.some((item) => item.code === VIDEO_SEGMENT_CODES.SEGMENT_CHECKSUM_MISMATCH), '校验和不匹配应带结构化证据');
  const unavailableScan = await scanRecoveryCandidates({});
  expect(unavailableScan.ok === false && unavailableScan.skipped === true, '无 OPFS 能力时应跳过而不是崩溃');
  expect(unavailableScan.evidence[0].code === RECOVERY_CODES.SCAN_UNAVAILABLE, '跳过原因应为 SCAN_UNAVAILABLE');

  const planSummary = buildPlanSummary(candidatePlan);
  const missingSummary = buildPlanSummary(firstMissingPlan);
  const corruptSummary = buildPlanSummary(corruptPlan);
  expect(planSummary.byCategory['truncated-segment'] === 1, '截断现场分类应含 truncated-segment');
  expect(missingSummary.byCategory['no-playable-prefix'] >= 1, '首片缺失应归类为 no-playable-prefix');
  expect(corruptSummary.byCategory['corrupt-segment'] === 1, '校验和损坏应归类为 corrupt-segment');
  expect(classifyRecoveryCode(RECOVERY_CODES.SCAN_UNAVAILABLE) === 'scan-unavailable', '扫描不可用应归类为 scan-unavailable');
  expect(classifyRecoveryCode(RECOVERY_CODES.RECOVERED) === 'recovered', '已恢复应归类为 recovered');

  // ---------------------------------------------------------------- 8) 可读摘要 JSON（单测解析）
  const summaryPayload = {
    scenario: 'video-crash-recovery',
    mimeType: recording.mimeType,
    bytes: bytes.length,
    recoveredBytes: recoveredBytes.length,
    canPlayType: videoSupport,
    scan: scanSummary,
    recovery: recoverySummary,
    patch: { recording_state: patch.recording_state, completeness: patch.completeness },
    scenarios: {
      truncated: planSummary,
      firstMissing: missingSummary,
      corrupt: corruptSummary,
      scanUnavailable: buildPlanSummary({ evidence: unavailableScan.evidence, recovered: false, completeness: 'failed', reason: 'scan_unavailable' }),
    },
  };
  document.getElementById('recovery-summary-json').textContent = JSON.stringify(summaryPayload);
  expect(JSON.parse(document.getElementById('recovery-summary-json').textContent).recovery.state === 'recovered', 'JSON 摘要应可解析且含 recovered 状态');
  document.getElementById('status').textContent = 'recovered prefix ' + recoveredBytes.length + '/' + bytes.length + ' bytes';

  setTitle('VIDEO_RECOVERY_OK:' + passed);
}

main().catch((error) => {
  setTitle('VIDEO_RECOVERY_FAIL:' + (error && error.message ? error.message : String(error)));
});
