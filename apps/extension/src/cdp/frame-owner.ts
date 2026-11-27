// src/cdp/frame-owner.ts —— OOPIF / 跨源 frame 的 CDP owner 投影。
//
// 背景：页面内 page-lib 只能读同源 contentDocument；跨源（OOPIF）或 owner 带 3D/perspective
// 变换时，页面侧拿不到准确的 owner 几何。这里用 CDP：
//   Page.getFrameTree（见 frame-tree.ts）拿到 frame id 链
//   → 对每一段在“父文档所在 session”上调用 DOM.getFrameOwner
//   → DOM.resolveNode + Runtime.callFunctionOn 读 owner 边框盒四角（含 matrix/perspective 修正）
//   → projectQuadPoint 逐层把 frame-local 点投影到顶层视口。
//
// 与 JS 兼容目标（extension/src/cross-frame-geometry.js + lib/frame-matrix.js）的关系：
// 语义同口径；TS 版按 owner 链逐段选择正确的 session（嵌套 OOPIF 必须走子 session），
// 并在结果里带 oopif/transformed/perspective 标志 —— frames 层据此决定
// `via: 'cdp-frame-owner'`（同源无变换的纯 rect 仍保持 `frame-projected`）。
//
// 注意：本模块只算坐标/几何，不派发 CDP Input；动作仍由内容脚本合成执行。

import type { CdpPoint, OwnerQuad } from './frame-matrix.ts';
import { projectQuadPoint, quadScale } from './frame-matrix.ts';
import type { CdpFrameGraph, CdpFrameNode } from './frame-tree.ts';
import { frameChainByUrl, normalizeUrl, sessionOfFrame } from './frame-tree.ts';
import type { CdpClient } from './client.ts';

export interface FrameOwnerLink {
  /** 该段 owner 对应的子帧 URL（从目标帧往外）。 */
  url: string;
  cdpFrameId: string;
  parentCdpFrameId: string | null;
  /** 子帧文档所在 session（'' = root target；非空 = OOPIF）。 */
  sessionId: string;
  /** owner 元素实际被解析到的 session（父文档所在 target）。 */
  ownerSessionId: string;
  /** 该段是否跨进程。 */
  oopif: boolean;
  /**
   * 该段是否跨源（child 文档 origin ≠ parent 文档 origin）。
   * 跨源时页面侧 contentDocument 不可读，只能走 CDP owner 投影（即使同进程）。
   */
  crossOrigin: boolean;
  /** owner 元素自身/祖先是否有 transform/rotate/scale。 */
  transformed: boolean;
  /** owner 祖先是否有 perspective。 */
  perspective: boolean;
  /** owner 边框盒在父视口里的矩形（未反变换的左上角 + CSS 尺寸）。 */
  rect: { x: number; y: number; width: number; height: number } | null;
  /** owner 的 scale（诊断用；有变换时不再代表视觉缩放）。 */
  scale: { x: number; y: number } | null;
  /** owner 边框盒四角（含透视时的 p3）。 */
  quad: OwnerQuad | null;
}

export interface FrameOwnerProjection {
  via: 'cdp-frame-owner';
  /** 输入的 frame-local 点投影到顶层视口后的坐标。 */
  x: number;
  y: number;
  tabId: number;
  /** 目标帧 URL（归一化）。 */
  frameUrl: string;
  /** 目标帧的 CDP frame id。 */
  cdpFrameId: string;
  /** 目标帧文档所在 session（'' = root target）。 */
  sessionId: string;
  /** owner 链上是否有跨进程段（OOPIF）。 */
  oopif: boolean;
  /** owner 链上是否有跨源段（页面侧读不到 contentDocument）。 */
  crossOrigin: boolean;
  /** owner 链上是否有 transform/rotate/scale/perspective。 */
  transformed: boolean;
  /** owner 链（从目标帧往外，[0] 是紧邻的 owner）。 */
  owners: FrameOwnerLink[];
  at: number;
}

/** frames 列表里每帧的 owner/几何（observe --frames 用；记录级最小形状）。 */
export interface FrameOwnerGeometry {
  via: 'cdp-frame-owner';
  cdpFrameId: string;
  sessionId: string;
  oopif: boolean;
  crossOrigin: boolean;
  transformed: boolean;
  /** 帧内容原点在顶层视口的投影（owner 链 0,0）。 */
  origin: CdpPoint;
  /** 紧邻父文档视口里的 owner 矩形。 */
  rect: { x: number; y: number; width: number; height: number } | null;
  chain: FrameOwnerLink[];
}

export interface ProjectFrameOwnerOptions {
  /** 目标帧 URL（与 alias.url 同口径）。 */
  url: string;
  /** frame-local 视口坐标（默认 0,0 = 内容原点）。 */
  point?: CdpPoint;
  timeoutMs?: number;
}

const OWNER_GEOMETRY_FUNCTION = `function () {
  const el = this;
  if (!el || !el.getBoundingClientRect) return null;
  const style = getComputedStyle(el);
  const borderLeft = Number.parseFloat(style.borderLeftWidth) || 0;
  const borderTop = Number.parseFloat(style.borderTopWidth) || 0;
  const width = Number(el.offsetWidth) || Number(el.clientWidth) || el.getBoundingClientRect().width;
  const height = Number(el.offsetHeight) || Number(el.clientHeight) || el.getBoundingClientRect().height;
  const transform = style.transform && style.transform !== 'none' ? style.transform : null;
  const rotate = style.rotate && style.rotate !== 'none' ? style.rotate : null;
  const scale = style.scale && style.scale !== 'none' ? style.scale : null;
  let base = el.getBoundingClientRect();
  let matrix = null;
  let originX = 0;
  let originY = 0;
  if (transform) {
    try {
      matrix = new DOMMatrixReadOnly(transform);
      const origin = String(style.transformOrigin || '').split(' ').map((part) => Number.parseFloat(part));
      originX = Number.isFinite(origin[0]) ? origin[0] : 0;
      originY = Number.isFinite(origin[1]) ? origin[1] : 0;
      const previous = el.style.transform;
      el.style.transform = 'none';
      base = el.getBoundingClientRect();
      el.style.transform = previous;
    } catch (error) { matrix = null; }
  }
  let perspective = 0;
  let hostRect = null;
  let perspectiveX = 0;
  let perspectiveY = 0;
  let ancestorTransformed = false;
  for (let node = el.parentElement; node && node.nodeType === 1; node = node.parentElement) {
    const hostStyle = getComputedStyle(node);
    const hostTransform = hostStyle.transform && hostStyle.transform !== 'none' ? hostStyle.transform : null;
    const hostRotate = hostStyle.rotate && hostStyle.rotate !== 'none' ? hostStyle.rotate : null;
    const hostScale = hostStyle.scale && hostStyle.scale !== 'none' ? hostStyle.scale : null;
    if (hostTransform || hostRotate || hostScale) ancestorTransformed = true;
    if (perspective > 0) continue;
    const value = hostStyle.perspective && hostStyle.perspective !== 'none' ? Number.parseFloat(hostStyle.perspective) : 0;
    if (!(value > 0)) continue;
    perspective = value;
    hostRect = node.getBoundingClientRect();
    const hostOrigin = String(hostStyle.perspectiveOrigin || '50% 50%').split(' ').map((part) => Number.parseFloat(part));
    perspectiveX = hostRect.left + (Number.isFinite(hostOrigin[0]) ? hostOrigin[0] : hostRect.width / 2);
    perspectiveY = hostRect.top + (Number.isFinite(hostOrigin[1]) ? hostOrigin[1] : hostRect.height / 2);
  }
  const project = (x, y) => {
    if (!matrix) return { x: base.left + x, y: base.top + y };
    const dx = x - originX;
    const dy = y - originY;
    const px = base.left + originX + matrix.a * dx + matrix.c * dy + matrix.e;
    const py = base.top + originY + matrix.b * dx + matrix.d * dy + matrix.f;
    if (!(perspective > 0)) return { x: px, y: py };
    const z = (matrix.m13 || 0) * dx + (matrix.m23 || 0) * dy + (matrix.m43 || 0);
    const w = 1 - z / perspective;
    if (!Number.isFinite(w) || Math.abs(w) < 1e-6) return { x: px, y: py };
    return { x: perspectiveX + (px - perspectiveX) / w, y: perspectiveY + (py - perspectiveY) / w };
  };
  const quad = {
    p1: project(0, 0),
    p2: project(width, 0),
    p4: project(0, height),
    width,
    height,
    borderLeft,
    borderTop,
    transformed: Boolean(transform || rotate || scale || ancestorTransformed),
    perspective: perspective > 0,
  };
  if (perspective > 0) quad.p3 = project(width, height);
  return quad;
}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pointOf(value: unknown): CdpPoint | null {
  if (!isRecord(value)) return null;
  const x = finiteNumber(value['x']);
  const y = finiteNumber(value['y']);
  if (x === null || y === null) return null;
  return { x, y };
}

function urlOriginOf(url: string): string | null {
  try {
    const parsed = new URL(String(url ?? ''));
    return parsed.origin && parsed.origin !== 'null' ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** frame 的文档源：优先 CDP securityOrigin（含端口；'null' = opaque origin），否则 URL origin。 */
export function frameOriginOf(frame: Pick<CdpFrameNode, 'url' | 'securityOrigin'>): string | null {
  const security = String(frame.securityOrigin ?? '');
  if (security) return security;
  return urlOriginOf(frame.url);
}

/**
 * child 文档与 parent 文档是否跨源。
 * 判定顺序：CDP securityOrigin（含 opaque 'null'；两个 opaque origin 互不同源）→ URL origin。
 * 任一源未知时保守返回 false（不影响正确性：只是不升级 via 标记）。
 */
export function isCrossOriginSegment(child: CdpFrameNode, parent: CdpFrameNode): boolean {
  const childSecurity = String(child.securityOrigin ?? '');
  const parentSecurity = String(parent.securityOrigin ?? '');
  if (childSecurity && parentSecurity) {
    // 两个 opaque origin（'null'）互不同源：sandbox iframe 必须走 CDP。
    if (childSecurity === 'null' || parentSecurity === 'null') return true;
    return childSecurity !== parentSecurity;
  }
  const childOrigin = urlOriginOf(child.url);
  const parentOrigin = urlOriginOf(parent.url);
  if (!childOrigin || !parentOrigin) return false;
  return childOrigin !== parentOrigin;
}

/** 解析 Runtime.callFunctionOn 的返回值；结构不合法返回 null（不伪造几何）。 */
export function parseOwnerQuad(value: unknown): { quad: OwnerQuad; transformed: boolean; perspective: boolean } | null {
  if (!isRecord(value)) return null;
  const p1 = pointOf(value['p1']);
  const p2 = pointOf(value['p2']);
  const p4 = pointOf(value['p4']);
  const width = finiteNumber(value['width']);
  const height = finiteNumber(value['height']);
  if (!p1 || !p2 || !p4) return null;
  if (width === null || height === null || !(width > 0) || !(height > 0)) return null;
  const p3 = pointOf(value['p3']);
  const quad: OwnerQuad = {
    p1,
    p2,
    p4,
    width,
    height,
    borderLeft: finiteNumber(value['borderLeft']) ?? 0,
    borderTop: finiteNumber(value['borderTop']) ?? 0,
    ...(p3 ? { p3 } : {}),
  };
  return {
    quad,
    transformed: value['transformed'] === true,
    perspective: value['perspective'] === true,
  };
}

async function ensureDomEnabled(
  client: CdpClient,
  tabId: number,
  sessionId: string,
  timeoutMs: number,
  enabled: Set<string>,
): Promise<void> {
  const key = sessionId || '';
  if (enabled.has(key)) return;
  enabled.add(key);
  try {
    await client.send(tabId, 'DOM.enable', {}, { timeoutMs, ...(sessionId ? { sessionId } : {}) });
  } catch {
    // DOM.enable 失败不致命（部分 target 上 getFrameOwner 仍可用）。
  }
}

/**
 * 读一段 owner 几何：owner 元素在 parent 文档里，所以优先在 parent 文档所在 session 上解析；
 * 失败时依次回退 child session / root（不同 Chromium 版本对 OOPIF owner 的归属实现有差异）。
 */
async function readOwnerQuad(
  client: CdpClient,
  tabId: number,
  cdpFrameId: string,
  sessions: readonly string[],
  timeoutMs: number,
  enabledSessions: Set<string>,
): Promise<{ quad: OwnerQuad; transformed: boolean; perspective: boolean } | null> {
  const seen = new Set<string>();
  for (const sessionId of sessions) {
    const key = sessionId || '';
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      await ensureDomEnabled(client, tabId, sessionId, timeoutMs, enabledSessions);
      const owner = await client.send<{ backendNodeId?: unknown }>(
        tabId,
        'DOM.getFrameOwner',
        { frameId: cdpFrameId },
        { timeoutMs, ...(sessionId ? { sessionId } : {}) },
      );
      const backendNodeId = Number(owner?.backendNodeId);
      if (!Number.isInteger(backendNodeId) || backendNodeId <= 0) continue;
      const resolved = await client.send<{ object?: { objectId?: unknown } }>(
        tabId,
        'DOM.resolveNode',
        { backendNodeId },
        { timeoutMs, ...(sessionId ? { sessionId } : {}) },
      );
      const objectId = resolved?.object?.objectId;
      if (typeof objectId !== 'string' || !objectId) continue;
      const reply = await client.send<{ result?: { value?: unknown } }>(
        tabId,
        'Runtime.callFunctionOn',
        {
          objectId,
          returnByValue: true,
          awaitPromise: false,
          functionDeclaration: OWNER_GEOMETRY_FUNCTION,
        },
        { timeoutMs, ...(sessionId ? { sessionId } : {}) },
      );
      const parsed = parseOwnerQuad(reply?.result?.value);
      if (parsed) return parsed;
    } catch {
      // 该 session 解析不到 owner：换下一个候选
    }
  }
  return null;
}

function ownerSessionCandidates(graph: CdpFrameGraph, parentFrameId: string | null, childSessionId: string): string[] {
  const parentSession = parentFrameId ? sessionOfFrame(graph, parentFrameId) : null;
  return [...new Set([parentSession ?? '', childSessionId, ''])];
}

/**
 * 把目标帧内的点投影到顶层视口。
 * 目标帧找不到 / owner 解析失败 / 数学退化时返回 null（调用方回退 frame-projected）。
 */
export async function projectFrameOwnerPoint(
  client: CdpClient,
  graph: CdpFrameGraph,
  options: ProjectFrameOwnerOptions,
): Promise<FrameOwnerProjection | null> {
  const chain = frameChainByUrl(graph, options.url);
  if (!chain || chain.length < 2) return null;
  const point = pointOf(options.point) ?? { x: 0, y: 0 };
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : 5_000;
  const enabledSessions = new Set<string>();
  let currentX = point.x;
  let currentY = point.y;
  let oopif = false;
  let crossOrigin = false;
  let transformed = false;
  const owners: FrameOwnerLink[] = [];
  for (let index = 0; index < chain.length - 1; index += 1) {
    const child = chain[index];
    const parent = chain[index + 1];
    if (!child || !parent) return null;
    const candidates = ownerSessionCandidates(graph, parent.frameId, child.sessionId);
    const quadResult = await readOwnerQuad(client, graph.tabId, child.frameId, candidates, timeoutMs, enabledSessions);
    if (!quadResult) return null;
    const projected = projectQuadPoint(quadResult.quad, { x: currentX, y: currentY });
    if (!projected) return null;
    currentX = projected.x;
    currentY = projected.y;
    const segmentCrossOrigin = isCrossOriginSegment(child, parent);
    oopif = oopif || child.crossProcess;
    crossOrigin = crossOrigin || segmentCrossOrigin;
    transformed = transformed || quadResult.transformed || quadResult.perspective;
    const scale = quadScale(quadResult.quad);
    owners.push({
      url: child.url,
      cdpFrameId: child.frameId,
      parentCdpFrameId: parent.frameId,
      sessionId: child.sessionId,
      ownerSessionId: candidates[0] ?? '',
      oopif: child.crossProcess,
      crossOrigin: segmentCrossOrigin,
      transformed: quadResult.transformed,
      perspective: quadResult.perspective,
      rect: {
        x: quadResult.quad.p1.x,
        y: quadResult.quad.p1.y,
        width: quadResult.quad.width,
        height: quadResult.quad.height,
      },
      scale,
      quad: quadResult.quad,
    });
  }
  const target = chain[0];
  if (!target) return null;
  return {
    via: 'cdp-frame-owner',
    x: currentX,
    y: currentY,
    tabId: graph.tabId,
    frameUrl: normalizeUrl(options.url),
    cdpFrameId: target.frameId,
    sessionId: target.sessionId,
    oopif,
    crossOrigin,
    transformed,
    owners,
    at: graph.at,
  };
}

/** frames 列表用：只要 owner 几何（不关心具体点），失败返回 null。 */
export async function frameOwnerGeometry(
  client: CdpClient,
  graph: CdpFrameGraph,
  url: string,
  timeoutMs = 5_000,
): Promise<FrameOwnerGeometry | null> {
  const projection = await projectFrameOwnerPoint(client, graph, { url, point: { x: 0, y: 0 }, timeoutMs });
  if (!projection) return null;
  const first = projection.owners[0] ?? null;
  return {
    via: 'cdp-frame-owner',
    cdpFrameId: projection.cdpFrameId,
    sessionId: projection.sessionId,
    oopif: projection.oopif,
    crossOrigin: projection.crossOrigin,
    transformed: projection.transformed,
    origin: { x: projection.x, y: projection.y },
    rect: first ? first.rect : null,
    chain: projection.owners,
  };
}
