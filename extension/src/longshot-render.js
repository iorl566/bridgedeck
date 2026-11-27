// src/longshot-render.js —— 拼接画布布局（纯函数，便于单测）。
//
// 第十批-D：在既有 layoutCanvas/planStitch 之上接 lib/longshot-stitch 的覆盖分析
// （缺口/重叠/尾部未覆盖/夹取证据）。既有字段 width/height/placements 完全不变，
// 只新增 coverage/stitch 两个字段，默认路径（screenshot.captureFullPage）行为不变。
// 第十一批-E：继续**只加字段**接帧级对账与重绘计划：
//   * frames —— 布局帧 ↔ 期望帧的对账摘要（来自 lib/longshot-frame-reconcile）；
//   * repaint —— 由对账结论派生的重绘计划（来自 lib/longshot-repaint，默认 skip）。
import { analyzePlacements, stitchWire, describeStitch, planRenderLayout } from './lib/longshot-stitch.js';
import { reconcileLongshotFrames, longshotFrameWire } from './lib/longshot-frame-reconcile.js';
import { planLongshotRepaint, repaintWire } from './lib/longshot-repaint.js';

export function layoutCanvas(frames, { width, totalHeight } = {}) {
  const limit = Math.max(1, Math.round(Number(totalHeight) || 1));
  const w = Math.max(1, Math.round(Number(width) || 1));
  const source = Array.isArray(frames) ? frames : [];
  const placements = source.map((frame, index) => {
    const bitmapHeight = Math.max(1, Math.round(Number(frame && frame.bitmapHeight) || 1));
    const drawY = Math.max(0, Math.min(Math.round(Number(frame && frame.drawY) || 0), Math.max(0, limit - bitmapHeight)));
    return { index, drawY, bitmapHeight };
  });
  let capturedBottom = 0;
  for (const placement of placements) capturedBottom = Math.max(capturedBottom, placement.drawY + placement.bitmapHeight);
  // 覆盖分析：告诉调用方“拼出来的图到底覆盖了多少行、哪里缺、哪里叠”，只加字段。
  const coverage = analyzePlacements(
    placements.map((placement) => ({ drawY: placement.drawY, bitmapHeight: placement.bitmapHeight })),
    { width: w, totalHeight: limit },
  );
  // 帧级对账（第十一批-E）：把布局帧当成“实采帧”，期望帧按同一 drawY 排序生成。
  // 默认输入（只有 drawY/bitmapHeight）下对账恒为 ok，repaint 恒为 skip，既有行为不变。
  const layoutFrames = placements.map((placement) => ({
    kind: 'longshot-segment',
    index: placement.index,
    role: placement.index === 0 ? 'first' : (placement.index === placements.length - 1 ? 'last' : 'middle'),
    pageY: placement.drawY,
    drawY: placement.drawY,
    pageHeight: placement.bitmapHeight,
    drawHeight: placement.bitmapHeight,
    width: w,
    dpr: 1,
    state: 'captured',
  }));
  let framesReport = null;
  try {
    framesReport = reconcileLongshotFrames({
      expected: layoutFrames,
      captured: layoutFrames,
      width: w,
      // 布局自己的“总高”取实际拼到的底边：layoutCanvas 可能因为帧上限截断而比页面矮，
      // 那是预期行为，不应被帧对账误报成“尾部未覆盖”。
      totalHeight: capturedBottom > 0 ? Math.min(limit, capturedBottom) : limit,
    });
  } catch {
    framesReport = null;
  }
  let repaint = null;
  try {
    repaint = planLongshotRepaint(framesReport, { width: w, dpr: 1 });
  } catch {
    repaint = null;
  }
  return {
    width: w,
    height: Math.max(1, Math.min(limit, capturedBottom || limit)),
    placements,
    coverage,
    stitch: stitchWire(coverage),
    // 只加字段：既有调用方（screenshot.captureFullPage）只读 width/height/placements。
    frames: framesReport ? longshotFrameWire(framesReport) : null,
    repaint: repaint ? repaintWire(repaint) : null,
  };
}

/**
 * 恢复旧分片的拼接计划：有 drawY 时按页面坐标放，缺 drawY 时退回顺序累加。
 * @param {Array<{drawY?: number, height: number}>} frames 已持久化的分片
 * @param {{width?: number}} [options]
 */
export function planStitch(frames, { width = 1 } = {}) {
  const list = Array.isArray(frames) ? frames : [];
  const explicit = list.map((frame) => (frame && Number.isFinite(Number(frame.drawY)) ? Math.max(0, Math.round(Number(frame.drawY))) : null));
  const useDrawY = list.length > 0 && explicit.every((value) => value !== null);
  let cursor = 0;
  const source = list.map((frame, index) => {
    const height = Math.max(1, Math.round(Number(frame && frame.height) || 1));
    const drawY = useDrawY ? explicit[index] : cursor;
    cursor += height;
    return { drawY, bitmapHeight: height };
  });
  return layoutCanvas(source, { width, totalHeight: Math.max(1, cursor) });
}

/**
 * 带夹取证据的渲染布局（长截图恢复/分片重拼用）：
 * 与 layoutCanvas 同一 clamp 语义，但保留 requestedY/wasClamped，便于把“被夹过的帧”写进日志。
 */
export function planLayoutWithEvidence(frames, options = {}) {
  return planRenderLayout(frames, options);
}

/** 一行日志：'拼接 12 帧 22500px 覆盖 100%（无缝）'（layoutCanvas 结果直接吃）。 */
export function describeLayout(layout) {
  if (!layout || typeof layout !== 'object') return '拼接 无布局';
  if (layout.coverage) return describeStitch(layout.coverage);
  return '拼接 ' + (Array.isArray(layout.placements) ? layout.placements.length : 0) + ' 帧 ' + Math.round(Number(layout.height) || 0) + 'px';
}

/** 协议字段：layout 结果 → wire（只带覆盖摘要，不带 placements 全量）。 */
export function layoutWire(layout) {
  if (!layout || typeof layout !== 'object') return { width: 1, height: 1, frames: 0, coverage_ratio: 0 };
  return {
    width: Math.round(Number(layout.width) || 1),
    height: Math.round(Number(layout.height) || 1),
    frames: Array.isArray(layout.placements) ? layout.placements.length : 0,
    ...(layout.stitch ? {
      coverage_ratio: layout.stitch.coverage_ratio,
      gaps: layout.stitch.gaps,
      overlaps: layout.stitch.overlaps,
      tail: layout.stitch.tail,
      seamless: layout.stitch.seamless,
    } : {}),
  };
}
