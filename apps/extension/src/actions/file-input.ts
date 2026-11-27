// src/actions/file-input.ts —— 超大文件（>8MB）直接写 file input 的 CDP 兜底（18e）。
//
// 背景：内容脚本只能拿到 daemon 内联的 base64 字节（≤8MB）；超过阈值的文件由 daemon
// staging 成本机路径，扩展侧唯一能把这些路径交给页面的通道是 CDP
// `DOM.setFileInputFiles`（`files` 必须是扩展进程可访问的本机绝对路径）。
//
// 本模块只做「本机路径 → file input」这一段，并如实区分三种结果：
// - 成功：回 via:'input-path' + 页面读回的文件名/大小（CDP 写完后回读校验，不假成功）；
// - 目标不是 file input：E_NOT_ACTIONABLE（data.alternatives 给出 chooser/内容脚本路径）；
// - 没有 CDP/没有本机路径：E_UNSUPPORTED_CAPABILITY（data.alternatives 明确替代方案）。
//
// 接线（lead）：`src/native/service.ts` 的 upload 在「没有内联字节但有 paths」分支调用
// `FileInputService`；daemon 已把 transferId 换成 staging 绝对路径（daemon/transfer.mjs）。

import type { CdpChannel } from '../debug/cdp-channel.ts';
import { RpcMethodError } from '../rpc/registry.ts';

export interface FileInputRequest {
  tabId: number;
  selector?: string | null;
  ref?: string | null;
  /** daemon staging 的本机绝对路径（最多 8 个，与 upload 上限一致）。 */
  paths?: readonly unknown[];
  /** 仅用于文件名证据/回退建议（没有 paths 时不能直接写 input）。 */
  files?: ReadonlyArray<{ name?: unknown; size?: unknown; base64?: unknown }> | null;
  mode?: string | null;
}

export interface FileInputServiceOptions {
  /** CDP 窄通道；缺省（null）时 upload 明确 E_UNSUPPORTED_CAPABILITY。 */
  client?: CdpChannel | null;
  now?: () => number;
}

export interface AppliedFileView {
  name: string;
  size: number;
  type: string;
}

interface CdpDomNode {
  nodeId?: number;
  backendNodeId?: number;
  nodeType?: number;
  nodeName?: string;
  attributes?: string[];
  children?: CdpDomNode[];
  shadowRoots?: CdpDomNode[];
  shadowRootType?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nodeIdOf(value: unknown): number {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

function attributesOf(node: CdpDomNode | null | undefined): Record<string, string> {
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

function isFileInputNode(node: CdpDomNode | null | undefined): boolean {
  if (!node) return false;
  // DOM.describeNode/getDocument 都会带 nodeType；个别精简通道缺省时按元素处理。
  if (node.nodeType !== undefined && node.nodeType !== 1) return false;
  return tagOfNode(node) === 'input' && String(attributesOf(node).type ?? '').toLowerCase() === 'file';
}

/** 深度遍历找第一个 file input（selector 精确匹配失败时与 JS 兼容目标同口径）。 */
export function findFirstFileInput(root: unknown): CdpDomNode | null {
  const visit = (node: CdpDomNode | null | undefined): CdpDomNode | null => {
    if (!node || typeof node !== 'object') return null;
    if (isFileInputNode(node)) return node;
    for (const child of Array.isArray(node.children) ? node.children : []) {
      const found = visit(child);
      if (found) return found;
    }
    for (const shadow of Array.isArray(node.shadowRoots) ? node.shadowRoots : []) {
      const found = visit(shadow);
      if (found) return found;
    }
    return null;
  };
  return visit(isRecord(root) ? root as CdpDomNode : null);
}

function baseName(path: string): string {
  const parts = String(path ?? '').split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

function normalizePaths(raw: readonly unknown[] | undefined): string[] {
  return (Array.isArray(raw) ? raw : [])
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
    .slice(0, 8);
}

/**
 * 超大文件直接 input 赋值（CDP `DOM.setFileInputFiles`）。
 *
 * ```ts
 * const files = new FileInputService({ client: cdpClient });
 * const applied = await files.upload({ tabId: 7, selector: '#file', paths: ['C:\\...\\big.bin'] });
 * // => { ok: true, via: 'input-path', names: ['big.bin'], files: [...], verified: true }
 * ```
 */
export class FileInputService {
  private readonly client: CdpChannel | null;
  private readonly now: () => number;

  constructor(options: FileInputServiceOptions = {}) {
    this.client = options.client ?? null;
    this.now = options.now ?? Date.now;
  }

  /** 有 CDP 通道才可能写本机路径。 */
  available(): boolean {
    return this.client !== null;
  }

  /** 本次 upload 是否走 CDP（有本机路径 + 目标模式是 input）。 */
  canHandle(request: FileInputRequest): boolean {
    if (!this.client) return false;
    if (!request || request.mode === 'drop') return false;
    return normalizePaths(request.paths).length > 0;
  }

  private unsupported(reason: string, data: Record<string, unknown> = {}): RpcMethodError {
    return new RpcMethodError(
      'E_UNSUPPORTED_CAPABILITY',
      '超大文件需要 CDP DOM.setFileInputFiles（本机路径直写 file input）；当前不可用：' + reason,
      {
        capability: 'DOM.setFileInputFiles',
        reason,
        alternatives: [
          '≤8MB 的文件由 daemon 内联 base64，走内容脚本 DataTransfer（--file 同一台机器）',
          '目标不是 input[type=file] 时用内容脚本 chooser/hidden-input 路径（≤8MB）',
          '确认扩展 manifest 有 debugger 权限且当前标签页允许挂载（chrome:// 等受限页不可挂）',
        ],
        effect_state: 'none',
        dispatched: false,
        ...data,
      },
    );
  }

  private async withClient<T>(tabId: number, feature: string, run: (client: CdpChannel) => Promise<T>): Promise<T> {
    const client = this.client;
    if (!client) throw this.unsupported('no-cdp-channel');
    await client.acquire(tabId, feature);
    try {
      return await run(client);
    } finally {
      client.release(tabId, feature);
    }
  }

  /**
   * 把本机路径写进 file input。
   *
   * 目标解析顺序：selector 精确匹配 → ref 的 id（调用方可给 selector 形式）→ 全文档第一个
   * file input。找不到/不是 file input 时明确失败（不静默写错控件）。
   */
  async upload(request: FileInputRequest): Promise<Record<string, unknown>> {
    const tabId = Number(request?.tabId);
    if (!Number.isInteger(tabId) || tabId <= 0) throw new RpcMethodError('E_BAD_ARG', 'upload 需要正整数 tabId', { tabId: request?.tabId ?? null });
    if (!this.client) throw this.unsupported('no-cdp-channel');
    if (request.mode === 'drop') throw this.unsupported('drop-needs-content-datatransfer', { mode: 'drop' });
    const paths = normalizePaths(request.paths);
    if (!paths.length) {
      throw this.unsupported('no-local-paths', {
        names: (Array.isArray(request.files) ? request.files : []).map((file) => String(file?.name ?? '')),
        limitation: 'daemon 没有为本文件提供 staging 路径（只有内联字节或 transferId 未解析）',
      });
    }
    return this.withClient(tabId, 'upload-file-input', async (client) => {
      await client.send(tabId, 'DOM.enable', {}).catch(() => undefined);
      const target = await this.resolveTarget(client, tabId, request);
      if (!target) {
        throw new RpcMethodError('E_NOT_FOUND', '没有找到可赋值的 input[type=file]', {
          selector: request.selector ?? null,
          ref: request.ref ?? null,
          alternatives: ['先用 selector/ref 指向 input[type=file]', '目标不是 file input 时走内容脚本 chooser 路径'],
          effect_state: 'none',
          dispatched: false,
        });
      }
      if (!target.isFileInput) {
        throw new RpcMethodError('E_NOT_ACTIONABLE', '目标不是 input[type=file]，不能直接写本机路径', {
          reason: 'not-file-input',
          tag: target.tag,
          selector: request.selector ?? null,
          ref: request.ref ?? null,
          alternatives: [
            '用内容脚本上传路径（≤8MB 走 DataTransfer）',
            '按钮类目标需要 chooser 拦截（CDP Page.setInterceptFileChooserDialog + DOM.setFileInputFiles）',
          ],
          effect_state: 'none',
          dispatched: false,
        });
      }
      await client.send(tabId, 'DOM.setFileInputFiles', { files: paths, backendNodeId: target.backendNodeId });
      // 回读校验：页面实际拿到的文件名/大小必须与写入路径一致（不把“命令返回成功”当成功）。
      const applied = await this.readFiles(client, tabId, target.backendNodeId);
      const expectedNames = paths.map(baseName);
      const names = applied.map((file) => file.name);
      const verified = applied.length === expectedNames.length && expectedNames.every((name, index) => names[index] === name);
      if (!verified) {
        throw new RpcMethodError('E_NOT_ACTIONABLE', 'DOM.setFileInputFiles 后页面文件列表与请求不一致（未生效）', {
          reason: 'files-not-applied',
          expected: expectedNames,
          actual: names,
          backendNodeId: target.backendNodeId,
          effect_state: 'unknown',
          dispatched: true,
        });
      }
      return {
        ok: true,
        via: 'input-path',
        names,
        files: applied,
        count: applied.length,
        verified: true,
        trusted: true,
        synthetic: false,
        backendNodeId: target.backendNodeId,
        inputMode: 'cdp-file-input',
        effectState: 'committed',
        evidence: {
          inputMode: 'cdp-file-input',
          verified: true,
          paths: paths.length,
          at: this.now(),
        },
      };
    });
  }

  private async resolveTarget(
    client: CdpChannel,
    tabId: number,
    request: FileInputRequest,
  ): Promise<{ backendNodeId: number; tag: string; isFileInput: boolean } | null> {
    const selector = typeof request.selector === 'string' && request.selector.trim() ? request.selector.trim() : '';
    if (selector) {
      try {
        const document = await client.send<Record<string, unknown>>(tabId, 'DOM.getDocument', { depth: 0, pierce: false });
        const rootId = nodeIdOf((document['root'] as Record<string, unknown> | undefined)?.['nodeId']);
        if (rootId) {
          const found = await client.send<Record<string, unknown>>(tabId, 'DOM.querySelector', { nodeId: rootId, selector });
          const nodeId = nodeIdOf(found['nodeId']);
          if (nodeId) {
            const described = await client.send<Record<string, unknown>>(tabId, 'DOM.describeNode', { nodeId, depth: 0 });
            const node = (described['node'] ?? null) as CdpDomNode | null;
            const backendNodeId = Number(node?.backendNodeId);
            if (Number.isInteger(backendNodeId) && backendNodeId > 0) {
              return { backendNodeId, tag: tagOfNode(node), isFileInput: isFileInputNode(node) };
            }
          }
        }
      } catch {
        // selector 找不到时退回第一个 file input（与 JS 参考的 hidden-input 兜底同口径）
      }
    }
    const document = await client.send<Record<string, unknown>>(tabId, 'DOM.getDocument', { depth: -1, pierce: true });
    const first = findFirstFileInput(document['root']);
    const backendNodeId = Number(first?.backendNodeId);
    if (!Number.isInteger(backendNodeId) || backendNodeId <= 0) return null;
    return { backendNodeId, tag: tagOfNode(first), isFileInput: true };
  }

  private async readFiles(client: CdpChannel, tabId: number, backendNodeId: number): Promise<AppliedFileView[]> {
    const resolved = await client.send<Record<string, unknown>>(tabId, 'DOM.resolveNode', { backendNodeId });
    const object = isRecord(resolved['object']) ? resolved['object'] as Record<string, unknown> : {};
    const objectId = String(object['objectId'] ?? '');
    if (!objectId) return [];
    try {
      const boxed = await client.send<{ result?: { value?: unknown } }>(tabId, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function(){ const list = this.files ? Array.from(this.files) : []; return list.map((file) => ({ name: String(file.name || ""), size: Number(file.size) || 0, type: String(file.type || "") })); }',
        returnByValue: true,
      });
      const value = boxed.result?.value;
      if (!Array.isArray(value)) return [];
      return value.filter((item): item is Record<string, unknown> => isRecord(item)).map((item) => ({
        name: String(item['name'] ?? ''),
        size: Number(item['size']) || 0,
        type: String(item['type'] ?? ''),
      }));
    } finally {
      await client.send(tabId, 'Runtime.releaseObject', { objectId }).catch(() => undefined);
    }
  }
}

/** 便捷工厂（background 注入用）。 */
export function createFileInputService(options: FileInputServiceOptions = {}): FileInputService {
  return new FileInputService(options);
}
