// tests/browser/longshot-recovery-pipeline.js —— 真实 Chromium 崩溃恢复回归。
//
// 覆盖（全部跑真实运行时模块，不重写受测逻辑）：
//   1) 真实 DOM 固定带几何 + 真实 Canvas PNG 字节；
//   2) 未 sealed manifest（拍到一半）→ 恢复计划 recovered/rebuild-partial；
//   3) 分片 hash 被篡改（模拟磁盘分片被覆盖）→ applyRecoveryVerification 给出 refetch；
//   4) 重取/重写分片后校验通过，缺口只来自 missing 段；
//   5) 补齐并 seal → already-sealed，不再重复恢复；
//   6) 可读摘要（文本 + JSON）与失败原因分类，供单测断言。
//
// 成功：document.title = LONGSHOT_RECOVERY_OK:<断言数>；失败：LONGSHOT_RECOVERY_FAIL:<message>。
// 刻意只用同步 Canvas API（toDataURL/drawImage/getImageData），避免 headless --dump-dom 在
// 异步任务完成前快照。
import {
  buildLongshotManifest,
  appendSegment,
  sealManifest,
  hashLongshotBytes,
  manifestSummary,
  missingSegmentIndexes,
} from '../../extension/src/lib/longshot-manifest.js';
import {
  planLongshotRecovery,
  applyRecoveryVerification,
  buildRecoveryResult,
  describeRecovery,
  normalizeRecoveryTiles,
} from '../../extension/src/lib/longshot-recovery.js';

let passed = 0;
const expect = (value, message) => {
  if (!value) throw new Error(message);
  passed += 1;
};
const setTitle = (value) => { document.title = value; };

const SEGMENT_WIDTH = 240;
const SEGMENT_HEIGHT = 160;

/** 画一段“页面”，返回真实 canvas / PNG 字节 / hash。 */
function drawSegment(label, color) {
  const canvas = document.createElement('canvas');
  canvas.width = SEGMENT_WIDTH;
  canvas.height = SEGMENT_HEIGHT;
  const context = canvas.getContext('2d');
  context.fillStyle = color;
  context.fillRect(0, 0, SEGMENT_WIDTH, SEGMENT_HEIGHT);
  context.fillStyle = '#ffffff';
  context.fillRect(12, 12, 120, 20);
  context.fillRect(12, 48, 200, 8);
  context.fillStyle = '#0f172a';
  context.font = '16px monospace';
  context.fillText(label, 16, 110);
  const dataUrl = canvas.toDataURL('image/png');
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return { canvas, dataUrl, bytes, hash: hashLongshotBytes(bytes) };
}

function tileOf(segment, index) {
  return {
    index,
    x: 0,
    y: index * SEGMENT_HEIGHT,
    drawY: index * SEGMENT_HEIGHT,
    width: SEGMENT_WIDTH,
    height: SEGMENT_HEIGHT,
    bytes: segment.bytes.byteLength,
    hash: segment.hash,
    at: 1000 + index,
    blob: segment.canvas,
  };
}

/** 失败原因分类：恢复计划里的 reason 归入稳定类别（可读摘要用）。 */
const RECOVERY_REASON_CATEGORIES = {
  missing: 'missing-segment',
  'hash-mismatch': 'stale-or-corrupted',
  'bytes-mismatch': 'truncated-or-corrupted',
  'index-mismatch': 'misordered',
  'not-in-manifest': 'unindexed',
};
function classifyRecoveryReason(reason) {
  return RECOVERY_REASON_CATEGORIES[reason] || 'unknown';
}

/** 可读摘要：文本行 + 机器可读 JSON（单测从 DOM 里解析它）。 */
function buildRecoverySummary(plan, verification, extra = {}) {
  const reasons = (plan.refetch || []).map((item) => classifyRecoveryReason(item.reason));
  const byReason = {};
  for (const reason of reasons) byReason[reason] = (byReason[reason] || 0) + 1;
  const mismatched = verification && Array.isArray(verification.mismatched) ? verification.mismatched : [];
  return {
    ok: plan.ok === true,
    action: plan.action,
    sealed: plan.sealed === true,
    recovered: plan.recovered === true,
    complete: plan.complete === true,
    tiles: plan.tiles,
    missing: plan.missing,
    nextIndex: plan.nextIndex,
    hashVerified: plan.hashVerified,
    checked: plan.checked,
    refetch: (plan.refetch || []).map((item) => ({ index: item.index, reason: item.reason, category: classifyRecoveryReason(item.reason) })),
    mismatched: mismatched.map((item) => ({ index: item.index, reason: item.reason, category: classifyRecoveryReason(item.reason) })),
    byReason,
    text: describeRecovery(plan),
    ...extra,
  };
}

function main() {
  // ---------------------------------------------------------------- 1) 真实 DOM 几何
  const headerRect = document.getElementById('fixed-header').getBoundingClientRect();
  const footerRect = document.getElementById('fixed-footer').getBoundingClientRect();
  expect(headerRect.height === 56, '页眉真实高度应为 56，实际 ' + headerRect.height);
  expect(footerRect.height === 80, '页脚真实高度应为 80，实际 ' + footerRect.height);
  expect(headerRect.top === 0, '页眉应贴顶，实际 top=' + headerRect.top);
  expect(Math.round(window.innerHeight - footerRect.top) === 80, '页脚贴底高度应为 80');
  expect(document.documentElement.scrollHeight > window.innerHeight, '页面应可滚动（真实文档高度）');
  expect(getComputedStyle(document.getElementById('fixed-header')).position === 'fixed', '页眉应是 fixed 定位');

  // ---------------------------------------------------------------- 2) 真实 PNG 字节
  const seg0 = drawSegment('segment-0', '#3355aa');
  const seg1 = drawSegment('segment-1', '#aa5533');
  const seg2 = drawSegment('segment-2', '#33aa55');
  const tampered = drawSegment('segment-1-overwritten', '#aa3333');
  expect(seg0.bytes.byteLength > 100, '真实 PNG 字节应大于 100');
  expect(seg0.bytes[1] === 0x50 && seg0.bytes[2] === 0x4e && seg0.bytes[3] === 0x47, '真实字节应是 PNG');
  expect(seg0.hash === hashLongshotBytes(seg0.bytes), '同一份真实字节 hash 应稳定');
  expect(seg0.hash !== seg1.hash && seg1.hash !== seg2.hash, '不同画面 hash 应不同');
  expect(tampered.hash !== seg1.hash, '被覆盖的分片 hash 应与原分片不同');

  // ---------------------------------------------------------------- 3) 未 sealed manifest：拍到一半
  let manifest = buildLongshotManifest({
    captureId: 'cap-crash',
    tabId: 7,
    url: location.href,
    dpr: 1,
    width: SEGMENT_WIDTH,
    height: SEGMENT_HEIGHT * 3,
    total: 3,
    now: 2_000_000,
    segments: [],
  });
  manifest = appendSegment(manifest, {
    index: 0, offset: 0, bytes: seg0.bytes.byteLength, hash: seg0.hash, width: SEGMENT_WIDTH, height: SEGMENT_HEIGHT,
  }, { now: 2_000_001 });
  manifest = appendSegment(manifest, {
    index: 1, offset: SEGMENT_HEIGHT, bytes: seg1.bytes.byteLength, hash: seg1.hash, width: SEGMENT_WIDTH, height: SEGMENT_HEIGHT,
  }, { now: 2_000_002 });
  const crashedTiles = [tileOf(seg0, 0), tileOf(seg1, 1)];
  let plan = planLongshotRecovery({ manifest, tiles: crashedTiles, now: 2_000_100 });
  expect(plan.ok === true, '崩溃后应能给出恢复计划');
  expect(plan.recovered === true, '未 sealed 的现场应标记 recovered');
  expect(plan.sealed === false, '未 seal 的 manifest 应标记 sealed=false');
  expect(plan.action === 'rebuild-partial', '缺第 3 段时应重建部分结果，实际 ' + plan.action);
  expect(plan.tiles === 2, '应识别 2 个已落盘分片');
  expect(plan.missing.length === 1 && plan.missing[0] === 2, '应缺第 2 段（0 基），实际 ' + JSON.stringify(plan.missing));
  expect(plan.nextIndex === 2, '下一步应重取第 2 段');
  expect(plan.gaps.length === 0, '磁盘分片位置连续时旧 gaps 应为空');
  expect(plan.width === SEGMENT_WIDTH, '恢复宽度应来自真实 tile 几何');
  expect(plan.height === SEGMENT_HEIGHT * 2, '恢复高度应来自真实 tile 几何');
  expect(plan.manifestSummary.captureId === 'cap-crash', '计划应带 manifest 摘要');
  expect(plan.manifestSummary.sealed === false, '摘要应反映未 seal');
  expect(plan.evidence.manifest === true && plan.evidence.tiles === 2, '计划证据应记录 manifest 与 tile 数');

  // ---------------------------------------------------------------- 4) hash 校验通过：只缺段
  let applied = applyRecoveryVerification(plan, { manifest, tiles: crashedTiles });
  expect(applied.verification.checked === 2, '应校验 2 个已存在分片');
  expect(applied.verification.hashVerified === true, '真实字节 hash 应全部通过');
  expect(applied.verification.mismatched.length === 0, '不应有 hash 不匹配');
  expect(applied.plan.segments.every((segment) => segment.verified === true), '每段都应有 verified 证据');
  expect(applied.plan.refetch.length === 1, '只应重取缺失段');
  expect(applied.plan.refetch[0].index === 2 && applied.plan.refetch[0].reason === 'missing', '缺口原因应为 missing');
  expect(applied.plan.complete === false, '缺段时不应 complete');
  expect(applied.plan.action === 'rebuild-partial', '缺段时动作应为 rebuild-partial');

  // ---------------------------------------------------------------- 5) 真实画布重拼（已落盘两段）
  const rebuilt = document.createElement('canvas');
  rebuilt.width = plan.width;
  rebuilt.height = plan.height;
  const rebuiltContext = rebuilt.getContext('2d');
  for (const tile of crashedTiles) rebuiltContext.drawImage(tile.blob, tile.x, tile.drawY);
  const rebuiltDataUrl = rebuilt.toDataURL('image/png');
  const rebuiltBinary = atob(rebuiltDataUrl.slice(rebuiltDataUrl.indexOf(',') + 1));
  const rebuiltBytes = Uint8Array.from(rebuiltBinary, (character) => character.charCodeAt(0));
  expect(rebuilt.width === SEGMENT_WIDTH && rebuilt.height === SEGMENT_HEIGHT * 2, '重拼画布尺寸应等于计划尺寸');
  expect(rebuiltBytes[1] === 0x50 && rebuiltBytes[2] === 0x4e && rebuiltBytes[3] === 0x47, '重拼产物应是真实 PNG');
  const pixel = rebuiltContext.getImageData(4, 4, 1, 1).data;
  expect(pixel[3] === 255, '重拼后的像素应完全不透明（真实绘制发生）');
  const resultPartial = buildRecoveryResult({
    captureId: 'cap-crash',
    plan: applied.plan,
    width: rebuilt.width,
    height: rebuilt.height,
    bytes: rebuiltBytes.byteLength,
    dataUrl: rebuiltDataUrl.slice(0, 64),
    gaps: applied.plan.gaps,
  });
  expect(resultPartial.ok === true && resultPartial.longshotId === 'cap-crash', '恢复结果应兼容旧字段');
  expect(resultPartial.recovered === true && resultPartial.sealed === false, '恢复结果应标记 recovered/unsealed');
  expect(resultPartial.complete === false, '缺段时 complete 应为 false');
  expect(resultPartial.tiles === 2, '恢复结果应记录 2 块');
  expect(resultPartial.recovery.refetch.length === 1, '恢复结果应透出 refetch 计划');

  // ---------------------------------------------------------------- 6) 分片 hash 篡改 → refetch
  // 同尺寸覆盖：模拟磁盘分片被等长写坏（字节数一致，只有 hash 能证明内容变了）。
  const tamperedTiles = [tileOf(seg0, 0), { ...tileOf(tampered, 1), bytes: seg1.bytes.byteLength, hash: tampered.hash }];
  const tamperedPlan = planLongshotRecovery({ manifest, tiles: tamperedTiles, now: 2_000_200 });
  expect(tamperedPlan.ok === true && tamperedPlan.recovered === true, '篡改现场仍应给出恢复计划');
  const tamperedApplied = applyRecoveryVerification(tamperedPlan, { manifest, tiles: tamperedTiles });
  expect(tamperedApplied.verification.hashVerified === false, '被覆盖的分片应校验失败');
  expect(tamperedApplied.verification.mismatched.length === 1, '应恰好 1 个分片不匹配');
  expect(tamperedApplied.verification.mismatched[0].index === 1, '不匹配的应是第 1 段');
  expect(tamperedApplied.verification.mismatched[0].reason === 'hash-mismatch', '原因应为 hash-mismatch');
  expect(tamperedApplied.verification.mismatched[0].expected.hash === seg1.hash, '不匹配证据应带期望 hash');
  const refetchIndexes = tamperedApplied.plan.refetch.map((item) => [item.index, item.reason]);
  expect(JSON.stringify(refetchIndexes) === JSON.stringify([[1, 'hash-mismatch'], [2, 'missing']]), 'refetch 应同时覆盖被篡改段与缺失段，实际 ' + JSON.stringify(refetchIndexes));
  expect(tamperedApplied.plan.segments[1].verified === false, '被篡改段应标 verified=false');
  expect(tamperedApplied.plan.segments[1].refetchReason === 'hash-mismatch', '被篡改段应记录 refetchReason');
  expect(tamperedApplied.plan.complete === false, '篡改后不应 complete');
  expect(tamperedApplied.plan.action === 'rebuild-partial', '篡改后动作应为 rebuild-partial');

  // ---------------------------------------------------------------- 7) 重取/重写后恢复通过
  const repairedManifest = appendSegment(manifest, {
    index: 1, offset: SEGMENT_HEIGHT, bytes: seg1.bytes.byteLength, hash: seg1.hash, width: SEGMENT_WIDTH, height: SEGMENT_HEIGHT,
  }, { now: 2_000_300 });
  const repairedTiles = [tileOf(seg0, 0), tileOf(seg1, 1)];
  const repairedPlan = planLongshotRecovery({ manifest: repairedManifest, tiles: repairedTiles, now: 2_000_400 });
  const repairedApplied = applyRecoveryVerification(repairedPlan, { manifest: repairedManifest, tiles: repairedTiles });
  expect(repairedApplied.verification.hashVerified === true, '重写正确分片后 hash 校验应通过');
  expect(repairedApplied.plan.refetch.length === 1 && repairedApplied.plan.refetch[0].index === 2, '重写后只应缺第 2 段');
  expect(describeRecovery(repairedApplied.plan).includes('gaps=0'), '可读摘要应包含 gaps 计数');
  expect(describeRecovery(repairedApplied.plan).includes('sealed=false'), '可读摘要应包含 sealed 状态');
  expect(describeRecovery(repairedApplied.plan).includes('hash=ok'), '可读摘要应包含 hash 结论');
  const repairedSummary = buildRecoverySummary(repairedApplied.plan, repairedApplied.verification);
  expect(repairedSummary.refetch.length === 1 && repairedSummary.refetch[0].category === 'missing-segment', '可读 JSON 应给缺口分类');
  expect(repairedSummary.byReason['missing-segment'] === 1, 'JSON 分类计数应正确');
  expect(repairedSummary.hashVerified === true, 'JSON 应带 hashVerified');
  expect(repairedSummary.nextIndex === 2, 'JSON 应带 nextIndex');

  // ---------------------------------------------------------------- 8) 补齐并 seal → already-sealed
  const completeManifest = sealManifest(appendSegment(repairedManifest, {
    index: 2, offset: SEGMENT_HEIGHT * 2, bytes: seg2.bytes.byteLength, hash: seg2.hash, width: SEGMENT_WIDTH, height: SEGMENT_HEIGHT,
  }, { now: 2_000_500 }), { now: 2_000_600 });
  expect(completeManifest.sealed === true, '补齐后 manifest 应能 seal');
  expect(missingSegmentIndexes(completeManifest).length === 0, 'sealed manifest 不应缺段');
  expect(manifestSummary(completeManifest).hashCount === 3, 'seal 后应记录 3 个 hash');
  const allTiles = [tileOf(seg0, 0), tileOf(seg1, 1), tileOf(seg2, 2)];
  const sealedPlan = planLongshotRecovery({ manifest: completeManifest, tiles: allTiles, now: 2_000_700 });
  expect(sealedPlan.sealed === true, 'sealed manifest 的恢复计划应标记 sealed');
  expect(sealedPlan.recovered === false, '已 sealed 的现场不再标记 recovered');
  expect(sealedPlan.action === 'already-sealed', '已 sealed 的动作应为 already-sealed');
  expect(sealedPlan.complete === true && sealedPlan.missing.length === 0, 'sealed 现场应 complete 且无缺段');
  const sealedApplied = applyRecoveryVerification(sealedPlan, { manifest: completeManifest, tiles: allTiles });
  expect(sealedApplied.verification.hashVerified === true, 'sealed 现场 3 段 hash 应全通过');
  expect(sealedApplied.plan.refetch.length === 0, 'sealed 现场不应再 refetch');
  const resultSealed = buildRecoveryResult({ captureId: 'cap-crash', plan: sealedApplied.plan, width: SEGMENT_WIDTH, height: SEGMENT_HEIGHT * 3 });
  expect(resultSealed.complete === true && resultSealed.sealed === true, 'sealed 恢复结果应 complete/sealed');
  expect(resultSealed.manifest.hashCount === 3, '恢复结果的 manifest 摘要应含 3 个 hash');

  // ---------------------------------------------------------------- 9) 失败原因分类 + 可读摘要 JSON
  const tamperedSummary = buildRecoverySummary(tamperedApplied.plan, tamperedApplied.verification, { scenario: 'hash-tampered' });
  expect(tamperedSummary.mismatched.length === 1 && tamperedSummary.mismatched[0].category === 'stale-or-corrupted', '篡改应归类为 stale-or-corrupted');
  expect(tamperedSummary.byReason['stale-or-corrupted'] === 1 && tamperedSummary.byReason['missing-segment'] === 1, '分类计数应同时覆盖篡改与缺段');
  const jsonNode = document.getElementById('recovery-summary-json');
  jsonNode.textContent = JSON.stringify({ scenario: 'crash-recovery', repaired: repairedSummary, tampered: tamperedSummary });
  const parsed = JSON.parse(jsonNode.textContent);
  expect(parsed.repaired.action === 'rebuild-partial' && parsed.tampered.action === 'rebuild-partial', 'JSON 摘要应记录动作');
  expect(parsed.tampered.mismatched[0].reason === 'hash-mismatch', 'JSON 摘要应保留原始 reason');
  expect(typeof parsed.repaired.text === 'string' && parsed.repaired.text.includes('恢复 cap-crash'), 'JSON 摘要应带文本摘要');
  const normalized = normalizeRecoveryTiles(crashedTiles);
  expect(normalized.tiles.length === 2 && normalized.duplicates.length === 0 && normalized.invalid.length === 0, '真实 tile 规整应无丢弃');

  setTitle('LONGSHOT_RECOVERY_OK:' + passed);
}

try {
  main();
} catch (error) {
  setTitle('LONGSHOT_RECOVERY_FAIL:' + (error && error.message ? error.message : String(error)));
}
