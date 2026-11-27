// src/actions/backend-locator.ts —— 动作层的 CDP DOM 节点定位（7/7b/20z/35b 的底座）。
//
// 背景：内容脚本的 @eN 只是页面内的短期句柄，CDP 的 Input.dispatchMouseEvent 需要
// 真实坐标 / backendNodeId。JS 兼容目标的做法是「页面侧生成稳定 selector → CDP
// DOM.querySelector 解析 backendNodeId」，TS 运行时没有页面侧 ref-selector op，
// 因此这里用两条等价路径：
//   1) selector / 元素 id → DOM.querySelector（便宜、精确）；
//   2) 元素描述符（tag + id/role/name，来自内容脚本 element-state）→ DOM.getDocument
//      (depth:-1, pierce:true) 遍历 shadow 树匹配（覆盖 open/closed shadow 内元素）。
// 另外提供三件动作层需要的事实：
//   - `point()`：节点中心的视口坐标（可 scrollIntoView），CDP Input 的坐标来源；
//   - `hitTest()`：点击点命中测试（self/descendant/host/obstructed），35b 的 E_OCCLUDED
//     与 35d 的 fail-closed 语义不因换到 CDP 而丢失；
//   - `describeValue()` / `focus()`：fill/press 的读回与无指针聚焦（press 不能点目标）。
//
// 所有 CDP 失败都收敛成 null（调用方回退内容脚本路径）；只有「遮挡」这种权威业务
// 结论由上层（trusted-input.ts）抛结构化错误。

import type { CdpChannel } from '../debug/cdp-channel.ts';

/** 目标描述（selector 或 内容脚本 element-state 给出的事实）。 */
export interface BackendTargetDescriptor {
  /** CSS selector（与 ref 二选一；selector 精确匹配主文档）。 */
  selector?: string | null;
  /** 页面内 ref（只用于证据，不参与 CDP 解析）。 */
  ref?: string | null;
  tag?: string | null;
  id?: string | null;
  role?: string | null;
  name?: string | null;
  /** 同 tag/id/role/name 的第几个匹配（0 起；缺省取第一个）。 */
  occurrence?: number;
}

/** 定位命中（节点身份 + shadow 归属）。 */
export interface BackendNodeHit {
  backendNodeId: number;
  nodeId: number;
  tag: string;
  id: string | null;
  role: string | null;
  name: string | null;
  attributes: Record<string, string>;
  /** 节点位于 closed shadow 子树（ref 路径应报 via='closed-shadow-ref'）。 */
  inClosedShadow: boolean;
  /** 节点位于 open shadow 子树。 */
  inOpenShadow: boolean;
}

export type HitRelation = 'self' | 'descendant' | 'host' | 'obstructed' | 'unknown';

export interface HitTestResult {
  relation: HitRelation;
  /** 遮挡元素（obstructed 时尽量给出；拿不到是 null，不伪造）。 */
  occludedBy: { tag: string; id: string | null; role: string | null; name: string | null } | null;
}

export interface NodePoint {
  x: number;
  y: number;
  width: number;
  height: number;
  tag: string;
  connected: boolean;
}

export interface NodeValueView {
  tag: string;
  value: string;
  editable: boolean;
  readOnly: boolean;
  disabled: boolean;
  type: string;
}

/** 动作层只依赖这份窄接口（单测注入假定位器）。 */
export interface BackendNodeLocatorPort {
  locate(tabId: number, target: BackendTargetDescriptor): Promise<BackendNodeHit | null>;
  point(tabId: number, backendNodeId: number, options?: { scroll?: boolean }): Promise<NodePoint | null>;
  hitTest(
    tabId: number,
    target: { backendNodeId: number; nodeId: number },
    point: { x: number; y: number },
  ): Promise<HitTestResult>;
  describeValue(tabId: number, backendNodeId: number): Promise<NodeValueView | null>;
  /** 无指针事件聚焦（DOM.focus）：press --ref 不能用点击代替（会产生额外 pointer 事件）。 */
  focus(tabId: number, backendNodeId: number): Promise<boolean>;
  /** 把输入框光标移到末尾（fill --no-clear 的追加语义；contenteditable 落到末子节点）。 */
  caretToEnd(tabId: number, backendNodeId: number): Promise<boolean>;
}

interface CdpDomNode {
  nodeId?: number;
  backendNodeId?: number;
  nodeType?: number;
  nodeName?: string;
  nodeValue?: string;
  attributes?: string[];
  children?: CdpDomNode[];
  shadowRoots?: CdpDomNode[];
  contentDocument?: CdpDomNode;
  shadowRootType?: string;
  parentId?: number;
  pseudoType?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asNode(value: unknown): CdpDomNode | null {
  return isRecord(value) ? value as CdpDomNode : null;
}

function nodeIdOf(value: unknown): number {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

/** 属性数组 [name, value, ...] → 记录（CDP 的 attributes 形状）。 */
export function attributesOf(node: CdpDomNode | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const list = Array.isArray(node?.attributes) ? node.attributes : [];
  for (let index = 0; index + 1 < list.length; index += 2) {
    const key = String(list[index] ?? '');
    if (key) out[key] = String(list[index + 1] ?? '');
  }
  return out;
}

function tagOfNode(node: CdpDomNode | null | undefined): string {
  return String(node?.nodeName ?? '').toLowerCase();
}

function normalizeText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function textOfNode(node: CdpDomNode | null | undefined, limit = 240): string {
  if (!node) return '';
  const parts: string[] = [];
  const walk = (current: CdpDomNode | null | undefined, depth: number): void => {
    if (!current || depth > 8) return;
    if (current.nodeType === 3 && current.nodeValue) parts.push(String(current.nodeValue));
    for (const child of Array.isArray(current.children) ? current.children : []) walk(child, depth + 1);
    for (const shadow of Array.isArray(current.shadowRoots) ? current.shadowRoots : []) walk(shadow, depth + 1);
    if (parts.join(' ').length > limit) return;
  };
  walk(node, 0);
  return normalizeText(parts.join(' ')).slice(0, limit);
}

/**
 * 节点可访问名称的近似（CDP DOM 树里没有 AX 信息）：
 * aria-label > alt > title > placeholder > value > 文本内容。
 * 只用于「内容脚本 element-state 的 name 已经给出、需要找同一个 DOM 节点」的匹配，
 * 不会作为对外事实上报。
 */
export function accessibleNameOfNode(node: CdpDomNode | null | undefined): string {
  const attrs = attributesOf(node);
  for (const key of ['aria-label', 'alt', 'title', 'placeholder', 'value']) {
    const value = normalizeText(attrs[key]);
    if (value) return value.slice(0, 160);
  }
  return textOfNode(node, 160);
}

function roleOfNode(node: CdpDomNode | null | undefined): string | null {
  const role = normalizeText(attributesOf(node).role);
  return role || null;
}

function cssAttributeSelector(id: string): string {
  return '[id="' + id.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]';
}

function hitResult(node: CdpDomNode, inClosed: boolean, inOpen: boolean): BackendNodeHit | null {
  const backendNodeId = Number(node.backendNodeId);
  if (!Number.isInteger(backendNodeId) || backendNodeId <= 0) return null;
  const attrs = attributesOf(node);
  return {
    backendNodeId,
    nodeId: nodeIdOf(node.nodeId),
    tag: tagOfNode(node),
    id: attrs.id ?? null,
    role: attrs.role ?? null,
    name: accessibleNameOfNode(node) || null,
    attributes: attrs,
    inClosedShadow: inClosed,
    inOpenShadow: inOpen,
  };
}

/** 在 DOM 树里按描述符找节点（先精确、后包含；occurrence 选第 N 个）。 */
export function findNodeByDescriptor(
  root: CdpDomNode | null | undefined,
  target: BackendTargetDescriptor,
): BackendNodeHit | null {
  const wantedTag = normalizeText(target.tag).toLowerCase();
  const wantedId = normalizeText(target.id);
  const wantedRole = normalizeText(target.role).toLowerCase();
  const wantedName = normalizeText(target.name);
  const occurrence = Number.isInteger(target.occurrence) && Number(target.occurrence) > 0 ? Number(target.occurrence) : 0;
  const exact: BackendNodeHit[] = [];
  const loose: BackendNodeHit[] = [];
  const visit = (node: CdpDomNode, inClosed: boolean, inOpen: boolean): void => {
    const closed = inClosed || node.shadowRootType === 'closed';
    const open = inOpen || node.shadowRootType === 'open';
    if (node.nodeType === 1) {
      const tag = tagOfNode(node);
      const attrs = attributesOf(node);
      const tagOk = !wantedTag || wantedTag === tag;
      if (tagOk) {
        const idOk = !wantedId || attrs.id === wantedId;
        const role = normalizeText(attrs.role).toLowerCase();
        const roleOk = !wantedRole || !role || role === wantedRole;
        const name = accessibleNameOfNode(node);
        let nameOk = false;
        let nameLoose = false;
        if (!wantedName) {
          nameOk = true;
        } else if (name) {
          nameOk = name === wantedName;
          nameLoose = !nameOk && name.length > 0 && (name.includes(wantedName) || wantedName.includes(name));
        }
        if (idOk && roleOk && nameOk) {
          const hit = hitResult(node, closed, open);
          if (hit) exact.push(hit);
        } else if (idOk && roleOk && nameLoose) {
          const hit = hitResult(node, closed, open);
          if (hit) loose.push(hit);
        }
      }
    }
    for (const child of Array.isArray(node.children) ? node.children : []) visit(child, closed, open);
    for (const shadow of Array.isArray(node.shadowRoots) ? node.shadowRoots : []) visit(shadow, closed, open);
    // 同源 iframe 的 contentDocument 不遍历：ref 已由 frames 服务处理，跨树匹配会把
    // 「主文档 ref」误判成 iframe 内同 id 节点（宁可回退内容脚本，也不点错）。
  };
  const tree = asNode(root);
  if (!tree) return null;
  if (wantedId) {
    // 指定 id 时只在 shadow 树里补查（主文档由 querySelector 先查过）；不跨 iframe。
    const shadowOnly = (node: CdpDomNode, inClosed: boolean, inOpen: boolean): void => {
      const closed = inClosed || node.shadowRootType === 'closed';
      const open = inOpen || node.shadowRootType === 'open';
      if (node.nodeType === 1) {
        const tag = tagOfNode(node);
        const attrs = attributesOf(node);
        if ((!wantedTag || wantedTag === tag) && attrs.id === wantedId) {
          const hit = hitResult(node, closed, open);
          if (hit) exact.push(hit);
        }
      }
      for (const child of Array.isArray(node.children) ? node.children : []) shadowOnly(child, closed, open);
      for (const shadow of Array.isArray(node.shadowRoots) ? node.shadowRoots : []) shadowOnly(shadow, closed, open);
    };
    shadowOnly(tree, false, false);
  } else {
    visit(tree, false, false);
  }
  const pool = exact.length ? exact : loose;
  return pool[occurrence] ?? pool[0] ?? null;
}

/** CDP 通道失败（attach/busy/无 debugger…）→ 上层回退内容脚本。 */
export function isCdpChannelError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && code.startsWith('E_CDP');
}

/** 派发前失败（挂载/权限/标签页）——回退内容脚本是安全的；超时/中途分离不回退。 */
export function isCdpPreDispatchError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return code === 'E_CDP_UNAVAILABLE'
    || code === 'E_CDP_ATTACH'
    || code === 'E_CDP_BUSY'
    || code === 'E_CDP_FORBIDDEN'
    || code === 'E_CDP_NO_TAB';
}

interface FunctionCallOutcome {
  result?: { value?: unknown; description?: string };
  exceptionDetails?: { text?: string };
}

/**
 * CDP DOM 节点定位器。
 *
 * ```ts
 * const locator = new CdpBackendNodeLocator({ client: cdpClient });
 * const hit = await locator.locate(7, { selector: '#submit-btn' });
 * const point = hit ? await locator.point(7, hit.backendNodeId, { scroll: true }) : null;
 * ```
 */
export class CdpBackendNodeLocator implements BackendNodeLocatorPort {
  private readonly client: CdpChannel;

  constructor(options: { client: CdpChannel }) {
    if (!options || !options.client) throw new TypeError('CdpBackendNodeLocator 需要 CdpChannel');
    this.client = options.client;
  }

  private async enable(tabId: number): Promise<void> {
    await this.client.send(tabId, 'DOM.enable', {}).catch(() => undefined);
  }

  async locate(tabId: number, target: BackendTargetDescriptor): Promise<BackendNodeHit | null> {
    const id = Number(tabId);
    if (!Number.isInteger(id) || id <= 0 || !target || typeof target !== 'object') return null;
    const selector = typeof target.selector === 'string' && target.selector.trim() ? target.selector.trim() : '';
    const wantedId = normalizeText(target.id);
    if (!selector && !wantedId && !normalizeText(target.tag) && !normalizeText(target.name)) return null;
    try {
      await this.client.acquire(id, 'action-backend');
    } catch {
      return null;
    }
    try {
      await this.enable(id);
      if (selector) {
        const document = await this.client.send<Record<string, unknown>>(id, 'DOM.getDocument', { depth: 0, pierce: false });
        const rootId = nodeIdOf(asNode(document['root'])?.nodeId);
        if (!rootId) return null;
        const found = await this.client.send<Record<string, unknown>>(id, 'DOM.querySelector', { nodeId: rootId, selector });
        const nodeId = nodeIdOf(found['nodeId']);
        if (!nodeId) return null;
        const described = await this.client.send<Record<string, unknown>>(id, 'DOM.describeNode', { nodeId, depth: 0 });
        const node = asNode(described['node']);
        const hit = node ? hitResult(node, false, false) : null;
        return hit;
      }
      if (wantedId) {
        // id 快捷路径：主文档（含 open shadow 外）精确命中；closed shadow 内由遍历兜底。
        try {
          const document = await this.client.send<Record<string, unknown>>(id, 'DOM.getDocument', { depth: 0, pierce: false });
          const rootId = nodeIdOf(asNode(document['root'])?.nodeId);
          if (rootId) {
            const found = await this.client.send<Record<string, unknown>>(id, 'DOM.querySelector', { nodeId: rootId, selector: cssAttributeSelector(wantedId) });
            const nodeId = nodeIdOf(found['nodeId']);
            if (nodeId) {
              const described = await this.client.send<Record<string, unknown>>(id, 'DOM.describeNode', { nodeId, depth: 0 });
              const node = asNode(described['node']);
              const hit = node ? hitResult(node, false, false) : null;
              if (hit && (!target.tag || hit.tag === normalizeText(target.tag).toLowerCase())) return hit;
            }
          }
        } catch {
          // querySelector 失败（非法 id/受限页面）时继续走遍历
        }
      }
      const document = await this.client.send<Record<string, unknown>>(id, 'DOM.getDocument', { depth: -1, pierce: true });
      return findNodeByDescriptor(asNode(document['root']), target);
    } catch {
      return null;
    } finally {
      this.client.release(id, 'action-backend');
    }
  }

  async point(tabId: number, backendNodeId: number, options: { scroll?: boolean } = {}): Promise<NodePoint | null> {
    const id = Number(tabId);
    const backendId = Number(backendNodeId);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(backendId) || backendId <= 0) return null;
    try {
      await this.client.acquire(id, 'action-backend');
    } catch {
      return null;
    }
    try {
      await this.enable(id);
      const resolved = await this.client.send<Record<string, unknown>>(id, 'DOM.resolveNode', { backendNodeId: backendId });
      const object = isRecord(resolved['object']) ? resolved['object'] as Record<string, unknown> : {};
      const objectId = String(object['objectId'] ?? '');
      if (!objectId) return null;
      try {
        const boxed = await this.client.send<FunctionCallOutcome>(id, 'Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: 'function(scroll){ if (scroll) { try { this.scrollIntoView({ block: "center", inline: "center" }); } catch (error) {} } const r = this.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height, tag: String(this.tagName || "").toLowerCase(), connected: this.isConnected !== false }; }',
          arguments: [{ value: options.scroll === true }],
          returnByValue: true,
        });
        const value = isRecord(boxed.result?.value) ? boxed.result?.value as Record<string, unknown> : {};
        const x = Number(value['x']);
        const y = Number(value['y']);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        return {
          x,
          y,
          width: Number(value['width']) || 0,
          height: Number(value['height']) || 0,
          tag: String(value['tag'] ?? ''),
          connected: value['connected'] !== false,
        };
      } finally {
        await this.client.send(id, 'Runtime.releaseObject', { objectId }).catch(() => undefined);
      }
    } catch {
      return null;
    } finally {
      this.client.release(id, 'action-backend');
    }
  }

  async describeValue(tabId: number, backendNodeId: number): Promise<NodeValueView | null> {
    const id = Number(tabId);
    const backendId = Number(backendNodeId);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(backendId) || backendId <= 0) return null;
    try {
      await this.client.acquire(id, 'action-backend');
    } catch {
      return null;
    }
    try {
      await this.enable(id);
      const resolved = await this.client.send<Record<string, unknown>>(id, 'DOM.resolveNode', { backendNodeId: backendId });
      const object = isRecord(resolved['object']) ? resolved['object'] as Record<string, unknown> : {};
      const objectId = String(object['objectId'] ?? '');
      if (!objectId) return null;
      try {
        const boxed = await this.client.send<FunctionCallOutcome>(id, 'Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: 'function(){ const t = String(this.tagName || "").toLowerCase(); const raw = this.value; const value = typeof raw === "string" ? raw : (this.isContentEditable === true ? String(this.textContent || "") : ""); return { tag: t, value: value, editable: (t === "input" || t === "textarea") || this.isContentEditable === true, readOnly: this.readOnly === true || this.getAttribute("readonly") !== null, disabled: this.disabled === true, type: String(this.type || "") }; }',
          returnByValue: true,
        });
        const value = isRecord(boxed.result?.value) ? boxed.result?.value as Record<string, unknown> : null;
        if (!value) return null;
        return {
          tag: String(value['tag'] ?? ''),
          value: String(value['value'] ?? ''),
          editable: value['editable'] === true,
          readOnly: value['readOnly'] === true,
          disabled: value['disabled'] === true,
          type: String(value['type'] ?? ''),
        };
      } finally {
        await this.client.send(id, 'Runtime.releaseObject', { objectId }).catch(() => undefined);
      }
    } catch {
      return null;
    } finally {
      this.client.release(id, 'action-backend');
    }
  }

  async focus(tabId: number, backendNodeId: number): Promise<boolean> {
    const id = Number(tabId);
    const backendId = Number(backendNodeId);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(backendId) || backendId <= 0) return false;
    try {
      await this.client.acquire(id, 'action-backend');
    } catch {
      return false;
    }
    try {
      await this.enable(id);
      await this.client.send(id, 'DOM.focus', { backendNodeId: backendId });
      return true;
    } catch {
      return false;
    } finally {
      this.client.release(id, 'action-backend');
    }
  }

  async caretToEnd(tabId: number, backendNodeId: number): Promise<boolean> {
    const id = Number(tabId);
    const backendId = Number(backendNodeId);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(backendId) || backendId <= 0) return false;
    try {
      await this.client.acquire(id, 'action-backend');
    } catch {
      return false;
    }
    try {
      await this.enable(id);
      const resolved = await this.client.send<Record<string, unknown>>(id, 'DOM.resolveNode', { backendNodeId: backendId });
      const object = isRecord(resolved['object']) ? resolved['object'] as Record<string, unknown> : {};
      const objectId = String(object['objectId'] ?? '');
      if (!objectId) return false;
      try {
        const boxed = await this.client.send<FunctionCallOutcome>(id, 'Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: 'function(){ try { this.focus(); } catch (error) {} const tag = String(this.tagName || "").toLowerCase(); if (tag === "input" || tag === "textarea") { const length = String(this.value || "").length; try { this.setSelectionRange(length, length); return true; } catch (error) { return false; } } if (this.isContentEditable === true && typeof window !== "undefined" && window.getSelection) { const range = document.createRange(); range.selectNodeContents(this); range.collapse(false); const selection = window.getSelection(); if (selection) { selection.removeAllRanges(); selection.addRange(range); return true; } } return false; }',
          returnByValue: true,
        });
        return boxed.result?.value === true;
      } finally {
        await this.client.send(id, 'Runtime.releaseObject', { objectId }).catch(() => undefined);
      }
    } catch {
      return false;
    } finally {
      this.client.release(id, 'action-backend');
    }
  }

  /** 命中测试：点击点命中的节点是否就是目标本身/其后代/其祖先。 */
  async hitTest(
    tabId: number,
    target: { backendNodeId: number; nodeId: number },
    point: { x: number; y: number },
  ): Promise<HitTestResult> {
    const id = Number(tabId);
    const targetBackend = Number(target?.backendNodeId);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(targetBackend) || targetBackend <= 0) {
      return { relation: 'unknown', occludedBy: null };
    }
    try {
      await this.client.acquire(id, 'action-backend');
    } catch {
      return { relation: 'unknown', occludedBy: null };
    }
    try {
      await this.enable(id);
      const located = await this.client.send<Record<string, unknown>>(id, 'DOM.getNodeForLocation', {
        x: Math.round(point.x),
        y: Math.round(point.y),
        includeUserAgentShadowDOM: false,
        ignorePointerEventsNone: false,
      });
      const hitBackend = Number(located['backendNodeId']);
      const hitNodeId = nodeIdOf(located['nodeId']);
      if (!Number.isInteger(hitBackend) || hitBackend <= 0) return { relation: 'unknown', occludedBy: null };
      if (hitBackend === targetBackend) return { relation: 'self', occludedBy: null };
      if (hitNodeId > 0) {
        const targetNodeId = nodeIdOf(target?.nodeId);
        const ancestorsOf = async (start: number): Promise<number[]> => {
          const chain: number[] = [];
          let current = start;
          for (let guard = 0; guard < 64 && current > 0; guard += 1) {
            chain.push(current);
            const described = await this.client.send<Record<string, unknown>>(id, 'DOM.describeNode', { nodeId: current, depth: 0 });
            const node = asNode(described['node']);
            current = nodeIdOf(node?.parentId);
          }
          return chain;
        };
        const hitChain = await ancestorsOf(hitNodeId);
        if (targetNodeId > 0 && hitChain.includes(targetNodeId)) return { relation: 'descendant', occludedBy: null };
        const targetChain = targetNodeId > 0 ? await ancestorsOf(targetNodeId) : [];
        if (targetChain.includes(hitNodeId)) return { relation: 'host', occludedBy: null };
      }
      const occludedBy = await this.describeOccluder(id, hitBackend);
      return { relation: 'obstructed', occludedBy };
    } catch {
      return { relation: 'unknown', occludedBy: null };
    } finally {
      this.client.release(id, 'action-backend');
    }
  }

  private async describeOccluder(tabId: number, backendNodeId: number): Promise<HitTestResult['occludedBy']> {
    try {
      const described = await this.client.send<Record<string, unknown>>(tabId, 'DOM.describeNode', { backendNodeId, depth: 0 });
      const node = asNode(described['node']);
      if (!node) return null;
      const attrs = attributesOf(node);
      return {
        tag: tagOfNode(node),
        id: attrs.id ?? null,
        role: attrs.role ?? null,
        name: accessibleNameOfNode(node) || null,
      };
    } catch {
      return null;
    }
  }
}

/** 便捷工厂（background 注入用）。 */
export function createBackendNodeLocator(options: { client: CdpChannel }): CdpBackendNodeLocator {
  return new CdpBackendNodeLocator(options);
}
