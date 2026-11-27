// src/cdp/frame-tree.ts —— CDP 帧树读取与合并（OOPIF 归属）。
//
// 只读：Page.getFrameTree 在 root target 与每个 flatten 子 session 上各取一次，
// 合并规则与 extension/src/frame-cdp.js 一致：**子 session 的树覆盖同名 frame**
// （OOPIF 的文档归子 target 所有，root 树里它只是叶子）。
//
// frameId 是 CDP 的字符串 id（不是 chrome.webNavigation 的数字 frameId），
// 两套 id 没有直接映射；跨层匹配用 URL（与 JS cross-frame-geometry.js 同口径）。

import type { CdpTargetSession } from './types.ts';
import type { CdpClient } from './client.ts';

export interface CdpFrameNode {
  /** CDP frame id（字符串）。 */
  frameId: string;
  parentFrameId: string | null;
  url: string;
  /** CDP 的 securityOrigin（部分版本提供；'' = 缺省）。 */
  securityOrigin: string;
  /** 该帧文档所在的 session：'' = root target；其它 = OOPIF 子 target。 */
  sessionId: string;
  /** 是否跨进程（OOPIF / 独立 target）。 */
  crossProcess: boolean;
}

export interface CdpFrameGraph {
  tabId: number;
  at: number;
  frames: CdpFrameNode[];
  byId: Map<string, CdpFrameNode>;
  sessions: CdpTargetSession[];
  /** 是否已打开 Target.setAutoAttach（false 时 OOPIF 可能缺失）。 */
  autoAttached: boolean;
}

export interface ReadFrameGraphOptions {
  timeoutMs?: number;
  settleMs?: number;
  sessionWaitMs?: number;
  /** 是否打开 autoAttach 收集 OOPIF（默认 true）。 */
  autoAttach?: boolean;
  /** 时钟注入（缓存/at 字段；默认 Date.now）。 */
  now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** URL 归一（相等判断用）；非法 URL 原样返回。 */
export function normalizeUrl(value: unknown): string {
  const text = String(value ?? '');
  if (!text) return '';
  try {
    return new URL(text).href;
  } catch {
    return text;
  }
}

function walkTree(tree: unknown, sessionId: string, parentFrameId: string | null, out: CdpFrameNode[]): void {
  if (!isRecord(tree)) return;
  const frame = isRecord(tree['frame']) ? tree['frame'] : null;
  if (!frame) return;
  const frameId = String(frame['id'] ?? '');
  if (!frameId) return;
  const explicitParent = typeof frame['parentId'] === 'string' && frame['parentId'] ? String(frame['parentId']) : null;
  const parent = explicitParent ?? parentFrameId;
  out.push({
    frameId,
    parentFrameId: parent,
    url: String(frame['url'] ?? ''),
    securityOrigin: String(frame['securityOrigin'] ?? ''),
    sessionId,
    crossProcess: sessionId !== '',
  });
  const children = Array.isArray(tree['childFrames']) ? tree['childFrames'] : [];
  for (const child of children) walkTree(child, sessionId, frameId, out);
}

/** 把多个 session 的 frame tree 合并成一张图（后写覆盖，子 session 优先）。 */
export function buildFrameGraph(
  tabId: number,
  at: number,
  sources: ReadonlyArray<{ sessionId: string; tree: unknown }>,
  sessions: CdpTargetSession[],
  autoAttached: boolean,
): CdpFrameGraph {
  const frames: CdpFrameNode[] = [];
  for (const source of sources) walkTree(source.tree, source.sessionId, null, frames);
  // 合并：后读到的树覆盖同名 frame（root 先读、子 session 后读；JS frame-cdp.js 同口径）。
  // 嵌套 OOPIF 因此由它自己的 session 归属（后附加的 session 树后处理）。
  const byId = new Map<string, CdpFrameNode>();
  for (const frame of frames) byId.set(frame.frameId, frame);
  return { tabId, at, frames: [...byId.values()], byId, sessions, autoAttached };
}

/** 读取帧图：打开 autoAttach（flatten, iframe）→ 等 session 稳定 → root+子 session 各取 frame tree。 */
export async function readFrameGraph(
  client: CdpClient,
  tabId: number,
  options: ReadFrameGraphOptions = {},
): Promise<CdpFrameGraph> {
  const id = Number(tabId);
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Math.max(1, Number(options.timeoutMs)) : 5_000;
  const settleMs = Number.isFinite(Number(options.settleMs)) ? Math.max(0, Number(options.settleMs)) : 250;
  const sessionWaitMs = Number.isFinite(Number(options.sessionWaitMs))
    ? Math.max(settleMs, Number(options.sessionWaitMs))
    : 3_000;
  const autoAttach = options.autoAttach !== false;
  const now = options.now ?? Date.now;
  if (autoAttach) {
    await client.ensureAutoAttach(id, { timeoutMs });
    await client.waitForSessions(id, { settleMs, timeoutMs: sessionWaitMs });
  }
  const sessions = client.sessions(id);
  const sources: Array<{ sessionId: string; tree: unknown }> = [];
  const rootReply = await client.send<{ frameTree?: unknown }>(id, 'Page.getFrameTree', {}, { timeoutMs });
  if (rootReply && typeof rootReply === 'object') sources.push({ sessionId: '', tree: rootReply.frameTree });
  for (const session of sessions) {
    try {
      const reply = await client.send<{ frameTree?: unknown }>(
        id,
        'Page.getFrameTree',
        {},
        { timeoutMs, sessionId: session.sessionId },
      );
      if (reply && typeof reply === 'object') sources.push({ sessionId: session.sessionId, tree: reply.frameTree });
    } catch {
      // 子 target 可能在采集期间关闭：跳过，root 树里它仍是一个叶子。
    }
  }
  return buildFrameGraph(id, now(), sources, sessions, autoAttach);
}

/** 按 frameId 取节点。 */
export function frameById(graph: CdpFrameGraph, frameId: string): CdpFrameNode | null {
  return graph.byId.get(String(frameId)) ?? null;
}

/** 某帧文档所在 session（'' = root target）；未知帧返回 null。 */
export function sessionOfFrame(graph: CdpFrameGraph, frameId: string): string | null {
  const node = graph.byId.get(String(frameId));
  return node ? node.sessionId : null;
}

/** 目标帧 → 根帧的 owner 链（[目标, 父, …, 根]）；找不到/成环返回 null。 */
export function frameChain(graph: CdpFrameGraph, frameId: string): CdpFrameNode[] | null {
  const start = graph.byId.get(String(frameId));
  if (!start) return null;
  const chain: CdpFrameNode[] = [];
  const seen = new Set<string>();
  let current: CdpFrameNode | undefined = start;
  while (current) {
    if (seen.has(current.frameId)) return null;
    seen.add(current.frameId);
    chain.push(current);
    if (!current.parentFrameId) break;
    current = graph.byId.get(current.parentFrameId);
  }
  return chain;
}

/**
 * 按 URL 找目标帧的 owner 链（目标 → … → 根）。
 * 同 URL 多帧时优先跨进程帧（OOPIF 语义更严格），否则取第一帧。
 */
export function frameChainByUrl(graph: CdpFrameGraph, url: string): CdpFrameNode[] | null {
  const target = normalizeUrl(url);
  if (!target) return null;
  const matches = graph.frames.filter((frame) => normalizeUrl(frame.url) === target);
  if (matches.length === 0) return null;
  const preferred = matches.find((frame) => frame.crossProcess) ?? matches[0];
  if (!preferred) return null;
  return frameChain(graph, preferred.frameId);
}

/** 按 URL 找节点（不建链）。 */
export function frameByUrl(graph: CdpFrameGraph, url: string): CdpFrameNode | null {
  const chain = frameChainByUrl(graph, url);
  return chain && chain[0] ? chain[0] : null;
}

/** 图中所有跨进程帧（OOPIF）。 */
export function oopifFrames(graph: CdpFrameGraph): CdpFrameNode[] {
  return graph.frames.filter((frame) => frame.crossProcess);
}
