// 真实 Chromium 证据：长截图 W2-A 五件套在真实 DOM + 真实 Canvas 字节上跑一遍。
//   * 固定顶/底带高度来自真实 getBoundingClientRect（不是手写数字）；
//   * manifest 的 hash 来自真实 <canvas>.toDataURL('image/png') 解出的 PNG 字节；
//   * 恢复计划用真实画布重新拼接并校验字节数；
//   * 状态机/预算/碎片并发是同一份运行时模块。
// 成功 title = LONGSHOT_PIPE_OK:<断言数>；失败 title = LONGSHOT_PIPE_FAIL:<message>。
// 说明：刻意只用同步 Canvas API（toDataURL/drawImage），避免 headless virtual-time
// 下 createImageBitmap/convertToBlob 的真实异步任务导致 --dump-dom 提前快照。
import {
  createLongshotStateMachine,
  LONGSHOT_EVENTS,
} from '../../extension/src/lib/longshot-state.js';
import {
  planFixedBands,
  planLongshotSegments,
  tileRectsForSegment,
  validateSegmentPlan,
} from '../../extension/src/lib/longshot-segments.js';
import {
  buildLongshotManifest,
  appendSegment,
  sealManifest,
  hashLongshotBytes,
  resumeLongshotManifest,
  manifestSummary,
} from '../../extension/src/lib/longshot-manifest.js';
import {
  planLongshotRecovery,
  applyRecoveryVerification,
  buildRecoveryResult,
} from '../../extension/src/lib/longshot-recovery.js';
import { estimateLongshotBudget, budgetReport, mapWithConcurrency } from '../../extension/src/lib/longshot-budget.js';

let passed = 0;
const expect = (value, message) => {
  if (!value) throw new Error(message);
  passed += 1;
};
const setTitle = (text) => {
  document.title = text;
};

function drawSegment(width, height, color) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.fillStyle = color;
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#ffffff';
  for (let y = 0; y < height; y += 40) context.fillRect(0, y, width, 2);
  const dataUrl = canvas.toDataURL('image/png');
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return { canvas, dataUrl, bytes, hash: hashLongshotBytes(bytes), width, height };
}

async function main() {
  // ---------------------------------------------------------------- 1) 真实 DOM 固定带
  const headerRect = document.getElementById('fixed-header').getBoundingClientRect();
  const footerRect = document.getElementById('fixed-footer').getBoundingClientRect();
  expect(headerRect.height === 56, '页眉真实高度应为 56，实际 ' + headerRect.height);
  expect(footerRect.height === 80, '页脚真实高度应为 80，实际 ' + footerRect.height);
  const metrics = {
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
    scrollY: window.scrollY,
    dpr: window.devicePixelRatio || 1,
    fixedTopHeight: Math.round(headerRect.bottom),
    fixedBottomHeight: Math.round(window.innerHeight - footerRect.top),
    fixedBands: [
      { edge: 'top', height: 56, top: 0, bottom: 56 },
      { edge: 'bottom', height: 80, top: window.innerHeight - 80, bottom: window.innerHeight },
    ],
  };
  expect(metrics.fixedTopHeight === 56, '顶带真实高度 ' + metrics.fixedTopHeight);
  expect(metrics.fixedBottomHeight === 80, '底带真实高度 ' + metrics.fixedBottomHeight);
  const bands = planFixedBands({ metrics, dpr: 1.5, deviceHeight: 22500 });
  expect(bands.fixedTop === 84, 'dpr=1.5 时顶带应为 84，实际 ' + bands.fixedTop);
  expect(bands.fixedBottom === 120, 'dpr=1.5 时底带应为 120，实际 ' + bands.fixedBottom);
  expect(bands.bands.length === 2, '固定带事实应透传 2 条');
  const bandsDpr1 = planFixedBands({ metrics, dpr: 1, deviceHeight: 15000 });
  expect(bandsDpr1.fixedTop === 56 && bandsDpr1.fixedBottom === 80, 'dpr=1 时固定带应等于真实 CSS 高度');

  // ---------------------------------------------------------------- 2) 多段规划（分数 DPR + 固定带只画首末段）
  const plan = planLongshotSegments({
    deviceWidth: 1862,
    deviceHeight: 45000,
    dpr: 1.5,
    fixedTop: bands.fixedTop,
    fixedBottom: bands.fixedBottom,
    overlap: 64,
  });
  expect(plan.totalSegments === 2, '45000/40000 应切成 2 段，实际 ' + plan.totalSegments);
  expect(plan.fractional === true, '1.5 应标记分数 DPR');
  expect(validateSegmentPlan(plan).ok === true, '真实规划自检应通过');
  expect(plan.segments[0].fixedTop === 84 && plan.segments[0].fixedBottom === 0, '顶带只画首段');
  expect(plan.segments[1].fixedTop === 0 && plan.segments[1].fixedBottom === 120, '底带只画末段');
  expect(plan.segments[1].overlapTop === 64, '第二段应借用 64 设备像素重叠区');
  expect(plan.segments[1].y === 40000 - 64, '重叠区影响绘制起点 ' + plan.segments[1].y);
  const rects = tileRectsForSegment(plan.segments[0], 512);
  expect(rects.length > 0 && rects[0].cssWidth > 0, 'tile 矩形应为正');
  expect(Math.abs(rects[1].cssX - 512 / 1.5) < 1e-9, '第二列 CSS x 应按分数 DPR 换算');

  // ---------------------------------------------------------------- 3) 真实 Canvas 字节 → manifest hash → sealed
  const seg0 = drawSegment(300, 300, '#3355aa');
  const seg1 = drawSegment(300, 200, '#aa5533');
  expect(seg0.bytes.byteLength > 100, '真实 PNG 字节应大于 100');
  expect(seg0.bytes[1] === 0x50 && seg0.bytes[2] === 0x4e && seg0.bytes[3] === 0x47, '真实字节应是 PNG');
  expect(seg0.hash !== seg1.hash, '不同画面 hash 应不同');
  expect(seg0.hash === hashLongshotBytes(seg0.bytes), '同一份真实字节 hash 应稳定');
  let manifest = buildLongshotManifest({
    captureId: 'browser-cap',
    tabId: 1,
    url: location.href,
    dpr: 1.5,
    width: 300,
    height: 500,
    total: 2,
    segments: [],
  });
  manifest = appendSegment(manifest, { index: 0, offset: 0, bytes: seg0.bytes.byteLength, hash: seg0.hash, width: 300, height: 300 });
  manifest = appendSegment(manifest, { index: 1, offset: 300, bytes: seg1.bytes.byteLength, hash: seg1.hash, width: 300, height: 200 });
  const sealed = sealManifest(manifest, { hashVerified: true });
  expect(sealed.sealed === true, 'manifest 应能封版');
  expect(manifestSummary(sealed).hashCount === 2, '封版 manifest 应记录 2 个 hash');
  expect(manifestSummary(sealed).bytes === seg0.bytes.byteLength + seg1.bytes.byteLength, 'manifest 字节合计应等于真实 PNG 字节');
  const resume = resumeLongshotManifest(sealed, {
    available: [
      { index: 0, bytes: seg0.bytes.byteLength, hash: seg0.hash },
      { index: 1, bytes: seg1.bytes.byteLength, hash: seg1.hash },
    ],
  });
  expect(resume.action === 'sealed' && resume.complete === true, '封版 manifest 的恢复计划应为 sealed');
  expect(resume.reuse.length === 2, '两段都应按 hash 命中');

  // ---------------------------------------------------------------- 4) hash 校验失败 → refetch 重取
  const tamperedHash = hashLongshotBytes(seg1.bytes.slice(0, seg1.bytes.length - 1));
  const tampered = resumeLongshotManifest(sealed, {
    available: [
      { index: 0, bytes: seg0.bytes.byteLength, hash: seg0.hash },
      { index: 1, bytes: seg1.bytes.byteLength, hash: tamperedHash },
    ],
  });
  expect(tampered.refetch.length === 1 && tampered.refetch[0].reason === 'hash-mismatch', '篡改分片应进入 refetch');
  expect(tampered.refetch[0].expected.hash === seg1.hash, 'refetch 应带期望 hash');

  // ---------------------------------------------------------------- 5) 真实画布重拼 + 恢复结果
  const tiles = [
    { index: 0, x: 0, y: 0, drawY: 0, width: 300, height: 300, bytes: seg0.bytes.byteLength, hash: seg0.hash, blob: seg0.canvas },
    { index: 1, x: 0, y: 300, drawY: 300, width: 300, height: 200, bytes: seg1.bytes.byteLength, hash: seg1.hash, blob: seg1.canvas },
  ];
  let recovery = planLongshotRecovery({ manifest: sealed, tiles });
  expect(recovery.ok === true && recovery.complete === true, '真实 tile 计划应完整');
  expect(recovery.segments.length === 2, '恢复计划应含 2 段');
  const verified = applyRecoveryVerification(recovery, { manifest: sealed, tiles });
  expect(verified.verification.hashVerified === true, '真实字节 hash 校验应通过');
  const rebuilt = document.createElement('canvas');
  rebuilt.width = 300;
  rebuilt.height = 500;
  const rebuiltContext = rebuilt.getContext('2d');
  for (const tile of tiles) rebuiltContext.drawImage(tile.blob, tile.x, tile.drawY);
  const rebuiltDataUrl = rebuilt.toDataURL('image/png');
  const rebuiltBase64 = rebuiltDataUrl.slice(rebuiltDataUrl.indexOf(',') + 1);
  const rebuiltBytes = Uint8Array.from(atob(rebuiltBase64), (character) => character.charCodeAt(0));
  const recoveryResult = buildRecoveryResult({
    captureId: 'browser-cap',
    plan: verified.plan,
    width: 300,
    height: 500,
    bytes: rebuiltBytes.byteLength,
    dataUrl: 'data:image/png;base64,' + rebuiltBase64.slice(0, 40),
  });
  expect(recoveryResult.width === 300 && recoveryResult.height === 500, '恢复尺寸应为 300x500');
  expect(recoveryResult.complete === true && recoveryResult.sealed === true, '恢复结果应标记 complete/sealed');
  expect(recoveryResult.tiles === 2, '恢复结果应记录 2 块');
  expect(rebuiltBytes[1] === 0x50 && rebuiltBytes[2] === 0x4e && rebuiltBytes[3] === 0x47, '重拼产物应是真实 PNG');

  // ---------------------------------------------------------------- 6) 状态机：正常 + stale 重试 + 快照
  const machine = createLongshotStateMachine();
  expect(machine.transition('browser-cap', LONGSHOT_EVENTS.CAPTURE_BEGIN, { tabId: 1, totalSegments: 2 }).ok === true, 'capture.begin 应成功');
  expect(machine.transition('browser-cap', LONGSHOT_EVENTS.CAPTURE_PROGRESS, { tiles: 8 }).ok === true, 'capture.progress 应成功');
  expect(machine.transition('browser-cap', LONGSHOT_EVENTS.STALE_DETECTED, { changed: ['scrollHeight'] }).to === 'stale', '应进入 stale');
  expect(machine.transition('browser-cap', LONGSHOT_EVENTS.STALE_RETRY, { attempts: 1, maxStaleAttempts: 3 }).to === 'capturing', 'stale.retry 应回采集');
  expect(machine.transition('browser-cap', LONGSHOT_EVENTS.STITCH_BEGIN, { tiles: 8, segments: 1 }).to === 'stitching', '应进入 stitching');
  const rejectedSeal = machine.transition('browser-cap', LONGSHOT_EVENTS.SEAL, { totalSegments: 2, sealedSegments: 1 });
  expect(rejectedSeal.ok === false && rejectedSeal.code === 'LONGSHOT_INCOMPLETE', '分片不齐应拒绝封版');
  expect(Array.isArray(rejectedSeal.evidence.allowed) && rejectedSeal.evidence.allowed.length > 0, '拒绝证据应带 allowed');
  const sealedState = machine.transition('browser-cap', LONGSHOT_EVENTS.SEAL, { totalSegments: 2, sealedSegments: 2, hashVerified: true });
  expect(sealedState.to === 'sealed', '补齐后应能封版');
  expect(machine.snapshot('browser-cap').staleRetries === 1, '快照应记录 stale 重试次数');

  // ---------------------------------------------------------------- 7) 预算与真实并发执行器
  const budget = estimateLongshotBudget({ scrollWidth: 1241, scrollHeight: 45000, dpr: 1 });
  expect(budget.degraded === false && budget.totalSegments === 2, '45000@dpr1 预算不应降级');
  expect(budgetReport(budget).used.segments === 2, '预算报告段数应为 2');
  const degraded = estimateLongshotBudget({ scrollWidth: 8000, scrollHeight: 60000, dpr: 1 });
  expect(degraded.degraded === true && degraded.truncated === true, '超预算应降级且截断');
  const active = { current: 0, max: 0 };
  const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (value) => {
    active.current += 1;
    active.max = Math.max(active.max, active.current);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active.current -= 1;
    return value * 3;
  });
  expect(active.max === 2, '真实异步并发上限应为 2，实际 ' + active.max);
  expect(results.join(',') === '3,6,9,12,15,18', '并发结果应保序：' + results.join(','));

  setTitle('LONGSHOT_PIPE_OK:' + passed);
}

main().catch((error) => {
  setTitle('LONGSHOT_PIPE_FAIL:' + (error && error.message ? error.message : String(error)));
});
