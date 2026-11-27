// src/cdp/index.ts —— CDP 通道（M-C 第六批）公开面。
//
// 使用建议：
// - 只想用 frame owner 投影 → `new FrameCdpService()`（或 createFrameCdpService）；
// - 需要更底层的 CDP（未来 debug 域：record/video/trace/pdf/Fetch…）→ `new CdpClient()`，
//   FrameCdpService 可以复用同一个 client（`new FrameCdpService({ client })`）。
//
// 单测：CdpClient / FrameCdpService 都接受注入的假 chrome.debugger（见 types.ts 的
// ChromeDebuggerApi），Node 环境不会读取真实 chrome。

export type {
  CdpAttachOptions,
  CdpAutoAttachOptions,
  CdpDetachListener,
  CdpErrorCode,
  CdpEventHandler,
  CdpEventSource,
  CdpListenerApi,
  CdpSendOptions,
  CdpStatus,
  CdpTarget,
  CdpTargetSession,
  CdpWaitSessionsOptions,
  ChromeDebuggerApi,
} from './types.ts';
export { CdpError, cdpErrorData, errorMessage, isBusyMessage, isForbiddenMessage, isNotAttachedMessage, isNoTabMessage, normalizeCdpError } from './errors.ts';
export { hasDebuggerPermission, isChromeDebuggerApi, resolveDebuggerApi } from './api.ts';
export { AUTO_ATTACH_PARAMS, AUTO_DETACH_PARAMS, CdpClient, createCdpClient } from './client.ts';
export type { CdpClientOptions } from './client.ts';
export type { CdpFrameGraph, CdpFrameNode, ReadFrameGraphOptions } from './frame-tree.ts';
export {
  buildFrameGraph,
  frameById,
  frameByUrl,
  frameChain,
  frameChainByUrl,
  normalizeUrl,
  oopifFrames,
  readFrameGraph,
  sessionOfFrame,
} from './frame-tree.ts';
export type { CdpPoint, OwnerQuad } from './frame-matrix.ts';
export { projectQuadPoint, quadScale, squareToQuad } from './frame-matrix.ts';
export type { FrameOwnerGeometry, FrameOwnerLink, FrameOwnerProjection, ProjectFrameOwnerOptions } from './frame-owner.ts';
export { frameOriginOf, frameOwnerGeometry, isCrossOriginSegment, parseOwnerQuad, projectFrameOwnerPoint } from './frame-owner.ts';
export type { FrameCdpOptions, FrameCdpPointOptions, FrameCdpSnapshotOptions, FrameCdpStatus } from './frames.ts';
export { createFrameCdpService, FrameCdpService } from './frames.ts';
