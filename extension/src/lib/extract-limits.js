// lib/extract-limits.js —— 结构化提取的帧/target/预览列与预算上限（纯函数）。
//
// 提取上限（16 帧 / 32 target / 8 预览列），并把“行/字节/单元格”预算
// 统一成可测的规范化逻辑。页面侧（page-lib）不能 import 模块，常量在那里有一份
// 镜像；扩展侧的判定全部走这里，避免两处漂移（单测覆盖）。

export const EXTRACT_LIMITS = Object.freeze({
  frames: 16,
  targets: 32,
  previewColumns: 8,
  previewSampleRows: 1,
  rows: 500,
  bytes: 256 * 1024,
  cells: 20000,
});

function clampInt(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.min(Math.max(Math.round(num), min), max);
}

/** 主文档优先，其余按 frameId 升序；去重、只保留整数。 */
export function orderFrameIds(ids = []) {
  const seen = new Set();
  const list = [];
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id < 0 || seen.has(id)) continue;
    seen.add(id);
    list.push(id);
  }
  const hasMain = seen.has(0);
  const rest = list.filter((id) => id !== 0).sort((a, b) => a - b);
  return hasMain ? [0, ...rest] : rest;
}

/** 选取要扫描的 frame，超过上限时截断并标记。 */
export function selectFrameIds(ids = [], max = EXTRACT_LIMITS.frames) {
  const ordered = orderFrameIds(ids);
  const limit = clampInt(max, EXTRACT_LIMITS.frames, 1, 200);
  return {
    frameIds: ordered.slice(0, limit),
    framesSeen: ordered.length,
    truncated: ordered.length > limit,
    limit,
  };
}

function capPreview(preview, columns) {
  if (!preview || typeof preview !== 'object') return null;
  const list = Array.isArray(preview.columns) ? preview.columns.slice(0, columns).map((item) => String(item).slice(0, 60)) : [];
  const sample = Array.isArray(preview.sample) ? preview.sample.slice(0, columns).map((item) => String(item).slice(0, 80)) : [];
  return { columns: list, sample: sample };
}

/**
 * 合并各 frame 的 discover 结果。
 * @param {Array<{frameId:number,result?:{targets?:object[]},error?:string}>} frames
 * @param {{maxTargets?:number,previewColumns?:number,framesSeen?:number}} options
 */
export function mergeDiscoverFrames(frames = [], options = {}) {
  const maxTargets = clampInt(options.maxTargets, EXTRACT_LIMITS.targets, 1, 200);
  const previewColumns = clampInt(options.previewColumns, EXTRACT_LIMITS.previewColumns, 1, 32);
  const list = Array.isArray(frames) ? frames : [];
  const targets = [];
  let frameCount = 0;
  let truncated = false;
  let dropped = 0;
  for (const frame of list) {
    if (!frame || !frame.result || !Array.isArray(frame.result.targets)) continue;
    frameCount += 1;
    const frameId = Number.isInteger(frame.frameId) ? frame.frameId : 0;
    for (const target of frame.result.targets) {
      if (!target || typeof target !== 'object') continue;
      if (targets.length >= maxTargets) {
        truncated = true;
        dropped += 1;
        continue;
      }
      targets.push({
        ...target,
        frameId,
        ...(frame.result.url ? { frameUrl: String(frame.result.url).slice(0, 300) } : {}),
        preview: capPreview(target.preview, previewColumns),
      });
    }
    if (frame.result.truncated === true) truncated = true;
  }
  return {
    targets,
    frameCount,
    framesScanned: frameCount,
    framesSeen: Number.isInteger(options.framesSeen) ? options.framesSeen : frameCount,
    truncated,
    dropped,
    limits: { maxFrames: clampInt(options.maxFrames, EXTRACT_LIMITS.frames, 1, 200), maxTargets, previewColumns },
  };
}

/** 归一化 --max-rows/--max-bytes/--max-cells（与页面侧 bounded* 保持同一组边界）。 */
export function normalizeExtractBudget(params = {}) {
  return {
    maxRows: clampInt(params.maxRows, EXTRACT_LIMITS.rows, 1, 5000),
    maxBytes: clampInt(params.maxBytes, EXTRACT_LIMITS.bytes, 1024, 4 * 1024 * 1024),
    maxCells: clampInt(params.maxCells, EXTRACT_LIMITS.cells, 1, 200000),
  };
}

/** 提取结果的预算证据：返回条数/单元格数/字节数/停止原因。 */
export function summarizeExtractBudget(result, budget = {}) {
  const normalized = normalizeExtractBudget(budget);
  const rows = Array.isArray(result && result.rows) ? result.rows.length : 0;
  const cells = Number.isFinite(result && result.cells) ? result.cells : rows;
  let bytes = 0;
  try {
    const text = JSON.stringify(result === undefined ? null : result);
    bytes = typeof Buffer !== 'undefined' ? Buffer.byteLength(text, 'utf8') : new TextEncoder().encode(text).length;
  } catch { bytes = 0; }
  const stopReason = (result && result.stopReason) || (result && result.truncated === true ? 'max-rows' : 'end');
  return {
    maxRows: normalized.maxRows,
    maxBytes: normalized.maxBytes,
    maxCells: normalized.maxCells,
    rows,
    cells,
    bytes,
    stopReason,
  };
}
