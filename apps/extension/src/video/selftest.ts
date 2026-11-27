// src/video/selftest.ts —— 视频页自测编排（纯逻辑 + 注入依赖，Node 单测可完整驱动）。
//
// 两条流程与 tools/e2e.mjs 的 35/35r 断言一一对应：
// - selftest=1：真实录制（video.start → 等 → video.stop）→ 读回落库记录 → 标题
//   `SELFTEST:ok:video:<count>:<mp4|webm>:<bytes>`；
// - selftest=seed：页面用真实 MediaRecorder 生成一小段视频 → 按两个分片写分片库
//   （供 `bridge video recover` 扫描拼回）→ 标题 `SELFTEST:ok:seed:<id>:<bytes>:<mp4|webm>`。
//
// 页面（record.ts）只负责把浏览器的真实能力注入进来；这里的逻辑失败一律抛错，
// 由页面 reportSelftest(..., ok=false) 变成 SELFTEST:fail:（绝不伪造 ok 标题）。

import { containerOfMime } from './mp4.ts';

/** 标签页最小形状（chrome.tabs.query 的返回子集）。 */
export interface TargetTabLike {
  id?: number | null;
  url?: string;
  title?: string;
  lastAccessed?: number;
}

/** 录制记录的最小形状（页面读 IndexedDB 后的子集）。 */
export interface SelftestRecordLike {
  id: string;
  mime: string;
  bytes: number;
  startedAt?: number;
  endedAt?: number;
}

/** 扩展自身页面前缀：录制目标必须是普通网页，不能是扩展页。 */
const SELF_PREFIX_FALLBACK = 'chrome-extension://';

/**
 * 选录制目标：优先显式 preferredTabId；否则取「最近访问过的普通网页」
 * （过滤扩展页、chrome/edge/about 等受限页；与 JS 0.3.0 tab-picker.js 同口径）。
 */
export function pickRecordTarget(
  tabs: TargetTabLike[],
  options: { selfPrefix?: string; preferredTabId?: number | null } = {},
): number | null {
  const selfPrefix = typeof options.selfPrefix === 'string' && options.selfPrefix ? options.selfPrefix : SELF_PREFIX_FALLBACK;
  const usable = (Array.isArray(tabs) ? tabs : [])
    .filter((tab): tab is TargetTabLike & { id: number } => Number.isInteger(Number(tab?.id)) && Number(tab?.id) >= 0)
    .filter((tab) => {
      const url = String(tab.url ?? '');
      if (!url) return false;
      if (selfPrefix && url.startsWith(selfPrefix)) return false;
      return !/^(chrome|edge|about|devtools|view-source|moz-extension):/i.test(url);
    })
    .sort((a, b) => (Number(b.lastAccessed) || 0) - (Number(a.lastAccessed) || 0));
  const preferred = Number(options.preferredTabId);
  if (Number.isInteger(preferred) && preferred >= 0) {
    const found = usable.find((tab) => tab.id === preferred);
    if (found) return found.id;
  }
  return usable[0]?.id ?? null;
}

/** 标题详情：`<count>:<mp4|webm>:<bytes>`（配合 reportSelftest('video', detail)）。 */
export function buildRecordSelftestDetail(records: SelftestRecordLike[], recordingId = ''): string {
  const list = Array.isArray(records) ? records : [];
  const id = String(recordingId);
  const latest = (id ? list.find((item) => item.id === id) : null)
    ?? list.slice().sort((a, b) => (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0))[0]
    ?? null;
  if (!latest) throw new Error('录制没有落库（记录列表为空）');
  const bytes = Number(latest.bytes) || 0;
  if (!(bytes > 0)) throw new Error('录出来的视频是空文件（0 字节）');
  return String(list.length) + ':' + containerOfMime(latest.mime) + ':' + String(bytes);
}

/** 标题详情：`<id>:<bytes>:<mp4|webm>`（配合 reportSelftest('seed', detail)）。 */
export function buildSeedSelftestDetail(id: string, bytes: number, mime: string): string {
  const size = Number(bytes) || 0;
  if (!id) throw new Error('seed 缺少 recordingId');
  if (!(size > 0)) throw new Error('seed 分片为空（0 字节）');
  return String(id) + ':' + String(size) + ':' + containerOfMime(mime);
}

// ---------------------------------------------------------------------------
// selftest=1：真实录制 → 停止 → 读回落库记录
// ---------------------------------------------------------------------------

export interface RecordSelftestStartResult {
  recordingId?: string;
  mime?: string;
  mode?: string;
}

export interface RecordSelftestDeps {
  /** 选目标标签页（页面用 chrome.tabs.query + pickRecordTarget 实现）。 */
  pickTargetTab(): Promise<number | null>;
  /** 真实 video.start（页面经 bb.ui op；测试用 fake）。 */
  start(params: { tabId: number; durationMs?: number; forceFrames?: boolean }): Promise<RecordSelftestStartResult>;
  /** 真实 video.stop。 */
  stop(params: { recording: string }): Promise<Record<string, unknown>>;
  /** 读回记录（页面读 IndexedDB；测试用内存）。 */
  listRecords(): Promise<SelftestRecordLike[]>;
  /** 可选：真实 video.status（验证停止后 active=false 的 ready 态）。 */
  status?(recordingId: string): Promise<Record<string, unknown>>;
  /** 可选：把落库记录读回来验容器魔数（页面「保存/回读」这一步，不伪造）。 */
  inspectRecord?(recordingId: string): Promise<{ bytes: number; container: 'mp4' | 'webm' | 'unknown' }>;
  sleep(ms: number): Promise<void>;
  /** 录制时长（毫秒）；默认 1200ms，够编码器出帧又不拖慢 E2E。 */
  recordMs?: number;
}

/**
 * 跑一次真实录制自测，返回标题详情（count:mp4:bytes）。
 * 流程与 deliverable 对齐：start → 录一段 → stop → status（可选）→ 读回记录 → 校验容器（可选）。
 * 任何一步失败都抛错（页面转成 SELFTEST:fail:video:*）。
 */
export async function runRecordSelftest(deps: RecordSelftestDeps): Promise<string> {
  const tabId = await deps.pickTargetTab();
  if (tabId === null || tabId === undefined || !Number.isInteger(Number(tabId)) || Number(tabId) < 0) {
    throw new Error('没有可录制的标签页（先打开一个普通网页）');
  }
  const recordMs = Number.isFinite(Number(deps.recordMs)) && Number(deps.recordMs) > 0 ? Number(deps.recordMs) : 1200;
  const started = await deps.start({ tabId: Number(tabId), durationMs: 0 });
  const recordingId = typeof started?.recordingId === 'string' ? started.recordingId : '';
  if (!recordingId) throw new Error('video.start 没有返回 recordingId');
  try {
    await deps.sleep(recordMs);
  } finally {
    // 即使等待被中断也要尝试收尾，避免页面关闭后离屏还在录。
    await deps.stop({ recording: recordingId }).catch(() => { /* 尽力而为；读回阶段仍会给出真实失败 */ });
  }
  if (deps.status) {
    const state = await deps.status(recordingId);
    if (state && state.active === true) throw new Error('video.stop 之后录制仍处于活动态');
  }
  const records = await deps.listRecords();
  const detail = buildRecordSelftestDetail(records, recordingId);
  if (deps.inspectRecord) {
    const inspected = await deps.inspectRecord(recordingId);
    if (!(Number(inspected?.bytes) > 0)) throw new Error('读回的录制文件是空文件');
    if (inspected.container !== 'mp4' && inspected.container !== 'webm') {
      throw new Error('读回的录制容器不可识别（不是 mp4/webm）');
    }
  }
  return detail;
}

// ---------------------------------------------------------------------------
// selftest=seed：生成可恢复分片（页面生成真实视频字节，按两片写分片库）
// ---------------------------------------------------------------------------

export interface SeedClip {
  bytes: Uint8Array;
  mime: string;
}

export interface SeedChunkWrite {
  recordingId: string;
  bytes: Uint8Array;
  mime: string;
  startedAt: number;
}

export interface SeedSelftestDeps {
  /** 用真实 canvas.captureStream + MediaRecorder 生成一小段视频。 */
  recordClip(options: { ms: number }): Promise<SeedClip>;
  /** 把字节按 index 切成两片写入分片库（meta 带 mime/startedAt）。 */
  saveChunks(input: SeedChunkWrite): Promise<void>;
  now(): number;
  /** 录制时长（毫秒）；默认 1000ms。 */
  recordMs?: number;
}

/** 把字节按两片切开（至少各 1 字节；1 字节输入时只切一片）。 */
export function splitSeedChunks(bytes: Uint8Array): Array<{ index: number; data: Uint8Array }> {
  const total = bytes.length;
  if (total <= 0) return [];
  if (total < 2) return [{ index: 0, data: bytes.slice(0, total) }];
  const half = Math.floor(total / 2);
  return [
    { index: 0, data: bytes.slice(0, half) },
    { index: 1, data: bytes.slice(half) },
  ];
}

/**
 * 生成恢复演练分片，返回标题详情（id:bytes:mp4|webm）。
 * 分类账：id 由 now 派生（测试固定时钟 → 稳定 id），字节数就是分片总和。
 */
export async function runSeedSelftest(deps: SeedSelftestDeps): Promise<string> {
  const recordMs = Number.isFinite(Number(deps.recordMs)) && Number(deps.recordMs) > 0 ? Number(deps.recordMs) : 1000;
  const clip = await deps.recordClip({ ms: recordMs });
  const bytes = clip?.bytes instanceof Uint8Array ? clip.bytes : new Uint8Array(0);
  if (bytes.length === 0) throw new Error('没有录到任何分片');
  const mime = typeof clip.mime === 'string' && clip.mime ? clip.mime : 'video/webm';
  const startedAt = deps.now();
  const id = 'recover-drill-' + startedAt.toString(36);
  if (splitSeedChunks(bytes).length === 0) throw new Error('seed 分片切分失败');
  await deps.saveChunks({ recordingId: id, bytes, mime, startedAt });
  return buildSeedSelftestDetail(id, bytes.length, mime);
}
