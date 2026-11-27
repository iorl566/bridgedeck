// src/actions/receipts.ts —— 观察收据 / 协作 context / 期望校验的扩展侧状态与错误映射。
//
// 为什么要单独一层：`--observation`、`--node-scope`、`--context`、`--expect`、`--depends-on`
// 在 JS 扩展里属于“动作派发前的闸门”。TS 运行时没有 CDP，但**页面事实足够**：
// - observation 收据：observe/cooperate.sync 时记录 documentId + revision + 页面指纹 +
//   ref→节点签名；动作时用内容脚本的 page-state 复核；同一 tab 产生新观察后旧收据作废；
// - node-scope：只校验目标节点自身（detached / text+value 变化），页面其它变化放行；
// - context：cooperate.sync 换发、单次使用（strict）、导航后文档变化即失效；
// - expect/depends-on：内容脚本 check-facts 做字段校验，不派发动作。
//
// 证据字段（observed_changes/kind）按 E2E 契约给出，便于调用方解释失败原因。

import { RpcMethodError } from '../rpc/registry.ts';

export interface NodeSignatureView {
  attached: boolean;
  tag: string;
  id: string | null;
  text: string;
  value: string | null;
  checked: boolean | null;
  signature: string;
}

export interface ObservationReceipt {
  observationId: string;
  tabId: number;
  documentId: string;
  revision: number;
  url: string;
  fingerprint: string;
  signatures: Record<string, NodeSignatureView>;
  createdAt: number;
  current: boolean;
}

export interface ContextReceipt {
  contextId: string;
  tabId: number;
  documentId: string;
  url: string;
  generation: number;
  policy: 'auto' | 'strict' | 'target';
  used: boolean;
  current: boolean;
  createdAt: number;
}

export interface ObservationRecordInput {
  observationId: string;
  documentId: string;
  revision: number;
  url: string;
  fingerprint: string;
  signatures: Record<string, NodeSignatureView>;
  nodeScope?: { count: number; signatures: Record<string, NodeSignatureView> };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 把内容脚本的签名载荷收敛成类型化视图（畸形条目丢弃，不抛异常）。 */
export function normalizeSignatures(raw: unknown): Record<string, NodeSignatureView> {
  const out: Record<string, NodeSignatureView> = {};
  if (!isRecord(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    out[key] = {
      attached: value.attached === true,
      tag: typeof value.tag === 'string' ? value.tag : '',
      id: typeof value.id === 'string' ? value.id : null,
      text: typeof value.text === 'string' ? value.text : '',
      value: typeof value.value === 'string' ? value.value : null,
      checked: typeof value.checked === 'boolean' ? value.checked : null,
      signature: typeof value.signature === 'string' ? value.signature : '',
    };
  }
  return out;
}

export class ReceiptStore {
  private readonly observations = new Map<number, ObservationReceipt[]>();
  private readonly contexts = new Map<number, ContextReceipt[]>();
  private readonly policy = new Map<number, 'auto' | 'strict' | 'target'>();
  private readonly now: () => number;
  private readonly limit: number;

  constructor(options: { now?: () => number; limit?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.limit = Number(options.limit) > 0 ? Math.floor(Number(options.limit)) : 8;
  }

  setPolicy(tabId: number, policy: string): void {
    const normalized = policy === 'strict' ? 'strict' : policy === 'target' ? 'target' : 'auto';
    this.policy.set(Number(tabId), normalized);
  }

  getPolicy(tabId: number): 'auto' | 'strict' | 'target' {
    return this.policy.get(Number(tabId)) ?? 'auto';
  }

  /** 记录一次观察；同 tab 的更早收据标记为非当前（旧 observation 立即失效）。 */
  addObservation(tabId: number, input: ObservationRecordInput): ObservationReceipt {
    const list = this.observations.get(Number(tabId)) ?? [];
    for (const item of list) item.current = false;
    const receipt: ObservationReceipt = {
      observationId: input.observationId,
      tabId: Number(tabId),
      documentId: input.documentId,
      revision: input.revision,
      url: input.url,
      fingerprint: input.fingerprint,
      signatures: input.nodeScope ? { ...input.signatures, ...input.nodeScope.signatures } : input.signatures,
      createdAt: this.now(),
      current: true,
    };
    list.push(receipt);
    while (list.length > this.limit) list.shift();
    this.observations.set(Number(tabId), list);
    return receipt;
  }

  getObservation(tabId: number, observationId: string): { receipt: ObservationReceipt | null; superseded: boolean; known: boolean } {
    const list = this.observations.get(Number(tabId)) ?? [];
    const found = list.find((item) => item.observationId === observationId) ?? null;
    return { receipt: found, superseded: Boolean(found) && found?.current !== true, known: list.some((item) => item.observationId === observationId) };
  }

  /** 记录协作 context；新一次 sync 会让旧 context 失效。 */
  addContext(tabId: number, input: Omit<ContextReceipt, 'used' | 'current' | 'createdAt' | 'tabId'> & { policy?: 'auto' | 'strict' | 'target' }): ContextReceipt {
    const list = this.contexts.get(Number(tabId)) ?? [];
    for (const item of list) item.current = false;
    const receipt: ContextReceipt = {
      contextId: input.contextId,
      tabId: Number(tabId),
      documentId: input.documentId,
      url: input.url,
      generation: input.generation,
      policy: input.policy ?? this.getPolicy(tabId),
      used: false,
      current: true,
      createdAt: this.now(),
    };
    list.push(receipt);
    while (list.length > this.limit) list.shift();
    this.contexts.set(Number(tabId), list);
    return receipt;
  }

  getContext(tabId: number, contextId: string): ContextReceipt | null {
    const list = this.contexts.get(Number(tabId)) ?? [];
    return list.find((item) => item.contextId === contextId) ?? null;
  }

  markContextUsed(tabId: number, contextId: string): void {
    const found = this.getContext(tabId, contextId);
    if (found) found.used = true;
  }

  pruneTab(tabId: number): void {
    this.observations.delete(Number(tabId));
    this.contexts.delete(Number(tabId));
    this.policy.delete(Number(tabId));
  }
}

export function staleObservation(reason: string, data: Record<string, unknown> = {}): RpcMethodError {
  return new RpcMethodError('E_OBSERVATION_STALE', '观察收据已失效（' + reason + '），请重新 observe', {
    reason,
    ...data,
  });
}

export function staleContext(reason: string, data: Record<string, unknown> = {}): RpcMethodError {
  return new RpcMethodError('E_CONTEXT_STALE', '协作 context 已失效（' + reason + '），请重新 cooperate sync', {
    reason,
    ...data,
  });
}

export function observationChanged(kinds: string[], data: Record<string, unknown> = {}): RpcMethodError {
  return new RpcMethodError(
    'E_OBSERVATION_CHANGED',
    '目标节点在观察后发生变化（' + kinds.join(',') + '）；请重新 observe 或去掉 --node-scope',
    { observed_changes: { scope: 'node', kinds, ...data } },
  );
}

export function targetDetached(data: Record<string, unknown> = {}): RpcMethodError {
  return new RpcMethodError('E_TARGET_DETACHED', '目标节点已从文档移除（target_detached）', {
    observed_changes: { scope: 'node', kinds: ['detached'] },
    ...data,
  });
}

/** expect/depends-on 失败：message 里带期望值（E2E 会断言 message 含 __never__）。 */
export function expectFailed(
  source: 'expect' | 'depends-on',
  mismatches: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
): RpcMethodError {
  const code = source === 'expect' ? 'E_EXPECT_FAILED' : 'E_DEPENDS_FAILED';
  const first = mismatches[0] ?? {};
  const label = source === 'expect' ? '--expect 事实校验失败' : '--depends-on 依赖校验失败';
  const message = label + '：' + String(first.target ?? '') + '.' + String(first.field ?? '')
    + ' 期望 ' + JSON.stringify(first.expected) + '，实际 ' + JSON.stringify(first.actual ?? null);
  return new RpcMethodError(code, message, {
    mismatch: {
      target: first.target ?? '',
      field: first.field ?? '',
      expected: first.expected,
      actual: first.actual,
      ...(mismatches.length > 1 ? { all: mismatches.slice(0, 8) } : {}),
    },
    effect_state: 'none',
    dispatched: false,
    ...extra,
  });
}

/** --expect/--depends-on 参数归一：接受数组或 JSON 字符串；非法形态回 E_BAD_ARG。 */
export function normalizeChecks(raw: unknown, source: string): Array<{ target: string; field: string; equals: unknown }> {
  if (raw === undefined || raw === null) return [];
  let list: unknown = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw);
    } catch {
      throw new RpcMethodError('E_BAD_ARG', source + ' 不是合法 JSON 数组', { value: raw });
    }
  }
  if (!Array.isArray(list)) throw new RpcMethodError('E_BAD_ARG', source + ' 需要数组');
  const out: Array<{ target: string; field: string; equals: unknown }> = [];
  for (const item of list.slice(0, 16)) {
    if (!isRecord(item)) throw new RpcMethodError('E_BAD_ARG', source + ' 的每一项都必须是对象');
    const target = typeof item.target === 'string' ? item.target : '';
    if (!target) throw new RpcMethodError('E_BAD_ARG', source + ' 的每一项都需要 target');
    out.push({
      target,
      field: typeof item.field === 'string' && item.field ? item.field : 'exists',
      equals: item.equals,
    });
  }
  return out;
}
