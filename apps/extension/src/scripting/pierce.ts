// src/scripting/pierce.ts —— CDP DOM.pierce：closed shadow 树里的点击/读取/枚举（20u、20v）。
//
// 背景：closed shadow root 对页面 JS 不可见（`element.shadowRoot === null`），隔离世界也拿不到；
// 但 CDP 的 `DOM.getDocument({ depth:-1, pierce:true })` 会返回 `shadowRootType:'closed'` 的子树，
// 这是 closed shadow 唯一可信的访问路径。
//
// 流程（与 JS 参考 extension/src/tools/shadow.js 同口径）：
//   DOM.enable → DOM.getDocument(pierce) → 递归找候选交互元素 → DOM.resolveNode
//   → Runtime.callFunctionOn 读 textContent/visibility → 命中后 Input.dispatchMouseEvent 点击。
//
// 本模块提供两套入口：
// - `shadowClick` / `shadowRead`：按可见文本查找（CLI `--closed-shadow-text`）；
// - `browseClosedShadow`：枚举 closed shadow 内可见可交互元素（供 observe --closed-shadow / ref 表接线）；
// - `clickRefNode` / `readRefNode`：按 backendNodeId 点击/读取（20v 的 @eN ref 路径）。

import type { CdpChannel } from '../debug/cdp-channel.ts';
import type { InputService } from './input.ts';

export interface ClosedShadowEntry {
  /** 元素文本（trim + 截断 120/160 字符）。 */
  text: string;
  /** 小写标签名。 */
  tag: string;
  visible: boolean;
  backendNodeId: number;
  nodeId: number;
}

export interface PierceServiceOptions {
  client: CdpChannel;
  /** 可信输入服务；缺省时按 backendNodeId 点击会退化为 Runtime 派发（仍可坐标点击）。 */
  input?: Pick<InputService, 'clickBackendNode'> | null;
  now?: () => number;
}

const INTERACTIVE_TAGS = /^(BUTTON|A|INPUT|SELECT|TEXTAREA|LABEL|SUMMARY|DETAILS|OPTION)$/;
const MAX_CANDIDATES = 300;

interface DomNode {
  nodeId?: number;
  backendNodeId?: number;
  nodeType?: number;
  nodeName?: string;
  nodeValue?: string;
  children?: DomNode[];
  shadowRoots?: DomNode[];
  contentDocument?: DomNode;
  shadowRootType?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** 递归收集 closed shadow 内的候选交互元素（只收 closed 子树）。 */
export function collectClosedShadowCandidates(root: unknown): DomNode[] {
  const candidates: DomNode[] = [];
  const walk = (node: DomNode | null | undefined, inClosed: boolean): void => {
    if (!node || typeof node !== 'object') return;
    if (inClosed && node.nodeType === 1 && typeof node.nodeName === 'string' && INTERACTIVE_TAGS.test(node.nodeName)) {
      candidates.push(node);
    }
    for (const child of Array.isArray(node.children) ? node.children : []) walk(child, inClosed);
    for (const shadow of Array.isArray(node.shadowRoots) ? node.shadowRoots : []) walk(shadow, inClosed || shadow.shadowRootType === 'closed');
    if (node.contentDocument) walk(node.contentDocument, false);
  };
  walk(root as DomNode | null | undefined, false);
  return candidates;
}

/** 读取候选元素的 text/tag/visible（Runtime.callFunctionOn）。 */
export async function describeCandidate(
  client: CdpChannel,
  tabId: number,
  node: DomNode,
  maxText = 160,
): Promise<ClosedShadowEntry | null> {
  const backendNodeId = Number(node.backendNodeId);
  if (!Number.isInteger(backendNodeId) || backendNodeId <= 0) return null;
  const resolved = await client.send<Record<string, unknown>>(tabId, 'DOM.resolveNode', { backendNodeId });
  const objectId = String(asRecord(resolved['object'])['objectId'] ?? '');
  if (!objectId) return null;
  try {
    const info = await client.send<Record<string, unknown>>(tabId, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function(limit){ return { text: String(this.textContent || "").trim().slice(0, limit), tag: String(this.tagName || "").toLowerCase(), visible: !!(this.offsetWidth || this.offsetHeight || this.getClientRects().length) }; }',
      arguments: [{ value: maxText }],
      returnByValue: true,
    });
    const value = asRecord(asRecord(info['result'])['value']);
    return {
      text: String(value['text'] ?? ''),
      tag: String(value['tag'] ?? ''),
      visible: value['visible'] === true,
      backendNodeId,
      nodeId: Number(node.nodeId ?? 0),
    };
  } catch {
    return null;
  } finally {
    await client.send(tabId, 'Runtime.releaseObject', { objectId }).catch(() => undefined);
  }
}

/** 用 CDP DOM pierce 枚举 closed shadow 内的可见交互元素（observe --closed-shadow 的数据源）。 */
export async function browseClosedShadow(
  client: CdpChannel,
  tabId: number,
  options: { limit?: number } = {},
): Promise<ClosedShadowEntry[]> {
  const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0 ? Math.floor(Number(options.limit)) : 50;
  await client.acquire(tabId, 'closed-shadow');
  try {
    await client.send(tabId, 'DOM.enable', {}).catch(() => undefined);
    const document = await client.send<Record<string, unknown>>(tabId, 'DOM.getDocument', { depth: -1, pierce: true });
    const candidates = collectClosedShadowCandidates(document['root']).slice(0, MAX_CANDIDATES);
    const entries: ClosedShadowEntry[] = [];
    for (const candidate of candidates) {
      if (entries.length >= limit) break;
      const described = await describeCandidate(client, tabId, candidate);
      if (described && described.visible && described.text) entries.push(described);
    }
    return entries;
  } finally {
    client.release(tabId, 'closed-shadow');
  }
}

/** 在 closed shadow 内按文本找第一个可见可交互元素。 */
export async function findClosedShadowByText(
  client: CdpChannel,
  tabId: number,
  text: string,
): Promise<ClosedShadowEntry | null> {
  const needle = String(text ?? '').trim();
  if (!needle) return null;
  await client.acquire(tabId, 'closed-shadow');
  try {
    await client.send(tabId, 'DOM.enable', {}).catch(() => undefined);
    const document = await client.send<Record<string, unknown>>(tabId, 'DOM.getDocument', { depth: -1, pierce: true });
    const candidates = collectClosedShadowCandidates(document['root']).slice(0, MAX_CANDIDATES);
    for (const candidate of candidates) {
      const described = await describeCandidate(client, tabId, candidate);
      if (described && described.visible && described.text.includes(needle)) return described;
    }
    return null;
  } finally {
    client.release(tabId, 'closed-shadow');
  }
}

/** closed shadow 服务（RPC 面：shadow.click / shadow.read；ref 面：clickRefNode / readRefNode）。 */
export class PierceService {
  private readonly client: CdpChannel;
  private readonly input: Pick<InputService, 'clickBackendNode'> | null;
  private readonly now: () => number;

  constructor(options: PierceServiceOptions) {
    if (!options || !options.client) throw new TypeError('PierceService 需要 CdpChannel');
    this.client = options.client;
    this.input = options.input ?? null;
    this.now = options.now ?? Date.now;
  }

  /** 枚举 closed shadow 内的可见交互元素（limit 默认 50）。 */
  entries(tabId: number, limit = 50): Promise<ClosedShadowEntry[]> {
    return browseClosedShadow(this.client, tabId, { limit });
  }

  /** shadow.click：按可见文本点击 closed shadow 内元素。 */
  async shadowClick(rawParams: unknown): Promise<Record<string, unknown>> {
    const params = asRecord(rawParams);
    const tabId = Number(params['tabId']);
    if (!Number.isInteger(tabId) || tabId <= 0) throw Object.assign(new Error('shadow.click 需要正整数 tabId'), { code: 'E_BAD_ARG' });
    const text = String(params['text'] ?? '').trim();
    if (!text) throw Object.assign(new Error('shadow-click 需要 --closed-shadow-text <文本>'), { code: 'E_BAD_ARG' });
    const found = await findClosedShadowByText(this.client, tabId, text);
    if (!found) throw Object.assign(new Error('closed shadow 内没有匹配文本的元素：' + text), { code: 'E_NOT_FOUND' });
    const point = await this.clickRefNode(tabId, found.backendNodeId).catch(() => null);
    if (!point) throw Object.assign(new Error('closed shadow 元素当前不可点击'), { code: 'E_NOT_ACTIONABLE' });
    return {
      ok: true,
      matched: found.text,
      tag: found.tag,
      trusted: true,
      via: 'cdp-closed-shadow',
      x: point.x,
      y: point.y,
      at: this.now(),
    };
  }

  /** shadow.read：按可见文本读取 closed shadow 内元素文本。 */
  async shadowRead(rawParams: unknown): Promise<Record<string, unknown>> {
    const params = asRecord(rawParams);
    const tabId = Number(params['tabId']);
    if (!Number.isInteger(tabId) || tabId <= 0) throw Object.assign(new Error('shadow.read 需要正整数 tabId'), { code: 'E_BAD_ARG' });
    const text = String(params['text'] ?? '').trim();
    if (!text) throw Object.assign(new Error('shadow-read 需要 --closed-shadow-text <文本>'), { code: 'E_BAD_ARG' });
    const found = await findClosedShadowByText(this.client, tabId, text);
    if (!found) throw Object.assign(new Error('closed shadow 内没有匹配文本的元素：' + text), { code: 'E_NOT_FOUND' });
    return { ok: true, matched: found.text, tag: found.tag, via: 'cdp-closed-shadow', backendNodeId: found.backendNodeId, at: this.now() };
  }

  /** 按 backendNodeId 可信点击（closed shadow ref 路径；via='closed-shadow-ref'）。 */
  async clickRefNode(tabId: number, backendNodeId: number): Promise<Record<string, unknown>> {
    const id = Number(tabId);
    const backendId = Number(backendNodeId);
    if (this.input) {
      const clicked = await this.input.clickBackendNode(id, backendId);
      return {
        ok: true,
        trusted: clicked['trusted'] === true,
        via: 'closed-shadow-ref',
        x: clicked['x'],
        y: clicked['y'],
        backendNodeId: backendId,
        at: this.now(),
      };
    }
    // 没有 InputService 时的兜底：Runtime 计算坐标后由调用方（actions）派发。
    const resolved = await this.client.send<Record<string, unknown>>(id, 'DOM.resolveNode', { backendNodeId: backendId });
    const objectId = String(asRecord(resolved['object'])['objectId'] ?? '');
    if (!objectId) throw Object.assign(new Error('ref 指向的节点已失效'), { code: 'E_STALE_REF' });
    try {
      const boxed = await this.client.send<Record<string, unknown>>(id, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function(){ this.scrollIntoView({ block: "center", inline: "center" }); const r = this.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }',
        returnByValue: true,
      });
      const value = asRecord(asRecord(boxed['result'])['value']);
      const x = Number(value['x']);
      const y = Number(value['y']);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw Object.assign(new Error('ref 节点没有可点击坐标'), { code: 'E_NOT_ACTIONABLE' });
      return { ok: true, trusted: false, via: 'closed-shadow-ref', x, y, backendNodeId: backendId, at: this.now() };
    } finally {
      await this.client.send(id, 'Runtime.releaseObject', { objectId }).catch(() => undefined);
    }
  }

  /** 按 backendNodeId 读取文本（closed shadow ref 读取路径）。 */
  async readRefNode(tabId: number, backendNodeId: number): Promise<Record<string, unknown>> {
    const id = Number(tabId);
    const backendId = Number(backendNodeId);
    const resolved = await this.client.send<Record<string, unknown>>(id, 'DOM.resolveNode', { backendNodeId: backendId });
    const objectId = String(asRecord(resolved['object'])['objectId'] ?? '');
    if (!objectId) throw Object.assign(new Error('ref 指向的节点已失效'), { code: 'E_STALE_REF' });
    try {
      const info = await this.client.send<Record<string, unknown>>(id, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function(){ return { text: String(this.textContent || "").trim(), tag: String(this.tagName || "").toLowerCase() }; }',
        returnByValue: true,
      });
      const value = asRecord(asRecord(info['result'])['value']);
      return {
        ok: true,
        matched: String(value['text'] ?? ''),
        value: String(value['text'] ?? ''),
        tag: String(value['tag'] ?? ''),
        via: 'closed-shadow-ref',
        backendNodeId: backendId,
        at: this.now(),
      };
    } finally {
      await this.client.send(id, 'Runtime.releaseObject', { objectId }).catch(() => undefined);
    }
  }
}

/** 便捷工厂。 */
export function createPierceService(options: PierceServiceOptions): PierceService {
  return new PierceService(options);
}
