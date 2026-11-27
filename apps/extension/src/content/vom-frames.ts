// src/content/vom-frames.ts —— observe --frames --vom 的跨帧子图装配（内容侧投影）。
//
// 每帧的内容脚本只产出本帧的 `vom.graph`（vom-page-graph → packages/vom.buildVomGraph）。
// background 的 frames 服务收集各帧结果后调用本模块，得到：
//   - frames[i].vom = {frameId,url,available,frameNodeId,nodes,edges,roots,counts,truncated}
//   - 顶层 vomFrames = {count,nodes,edges,truncated,links,unlinked}
//   - 顶层 vomLimits = {frames:16,nodes:400,edges:800}
// 真正的子图规范化/命名空间/frame 边逻辑在 packages/vom/src/frame-vom.ts（单一实现，
// 与 extension/src/lib/frame-vom.js 逐字段对拍），本文件只做输入形状适配。
//
// 接线点（lead 集成）：background 的 `observe-frames` 路由把 `vom:true` 透传给
// FrameObservationService.observeFrames；frames/service.ts 在 requestInFrame 里加
// `vom: true`，并从 `payload.richResult.vom.graph` 取每帧图，最后调用本函数合并。

import { buildFrameVomGraphs, FRAME_VOM_LIMITS } from '../../../../packages/vom/src/frame-vom.ts';
import type { FrameVomGraph, FrameVomSummary, FrameVomResult } from '../../../../packages/vom/src/frame-vom.ts';
import type { VomGraphObservedNode, VomGraphPayload } from '../../../../packages/vom/src/graph.ts';

/** 单帧采集结果（frames/service.ts 从内容脚本回包整理）。 */
export interface VomFrameCapture {
  frameId: number;
  url: string;
  parentFrameId: number;
  hidden?: boolean;
  /** 本帧 richResult.vom.graph（公开图）；缺省/不可用时该帧 available=false。 */
  graph?: VomGraphPayload | null;
  /** 本帧 richResult.vom.nodes（已观察节点；用于 ref/stableRef 映射）。 */
  nodes?: readonly VomGraphObservedNode[] | null;
}

/** 跨帧 VOM 汇总（observe --frames --vom 的顶层字段）。 */
export interface VomFramesBundle {
  /** frameId → 该帧子图（写回 frames[i].vom）。 */
  frames: Map<number, FrameVomGraph>;
  vomFrames: FrameVomSummary;
  vomLimits: { frames: number; nodes: number; edges: number };
}

/** 从各帧采集结果构建跨帧子图（隐藏帧不参与 owner 匹配，但其子图仍然保留）。 */
export function buildVomFramesFromCaptures(
  captures: readonly VomFrameCapture[],
  options: { limits?: { frames?: number; nodes?: number; edges?: number } | null } = {},
): VomFramesBundle {
  const childFrames = captures.map((capture) => ({
    frameId: capture.frameId,
    url: capture.url,
    parentFrameId: capture.parentFrameId,
    hidden: capture.hidden === true,
  }));
  const entries = captures.map((capture) => ({
    frameId: capture.frameId,
    url: capture.url,
    parentFrameId: Number.isInteger(capture.parentFrameId) ? capture.parentFrameId : 0,
    graph: capture.graph ?? null,
    nodes: capture.nodes ?? [],
  }));
  const result: FrameVomResult = buildFrameVomGraphs(entries, {
    ...(options.limits ? { limits: options.limits } : {}),
    childFrames,
  });
  const frames = new Map<number, FrameVomGraph>();
  for (const graph of result.graphs) frames.set(graph.frameId, graph);
  return {
    frames,
    vomFrames: result.summary,
    vomLimits: { ...FRAME_VOM_LIMITS, ...result.limits },
  };
}

/** 默认跨帧上限（E2E 断言 vomLimits.frames === 16）。 */
export const VOM_FRAME_LIMITS: Readonly<{ frames: number; nodes: number; edges: number }> = FRAME_VOM_LIMITS;
