/** 后台与 UI / 内容脚本之间的类型化消息契约。 */
import { PROTOCOL_VERSION, CANONICAL_METHOD_COUNT, MCP_TOOL_COUNT } from './constants.ts';
import type { BridgeSettings } from './settings.ts';

export interface StatusPayload {
  name: string;
  version: string;
  protocol: string;
  canonicalMethods: number;
  mcpTools: number;
  openTabs: number;
  uptimeMs: number;
  runtime: 'ts';
}

/** bb.rpc：把只读的 daemon 调用转发到 background（feature gate + 白名单在 src/rpc）。 */
export interface BridgeRpcMessage {
  type: 'bb.rpc';
  method: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
  /** 调用方自带的关联 id，回包原样带回（可选）。 */
  id?: string;
}

export type ExtensionMessage =
  | { type: 'bb.status' }
  | { type: 'bb.ping'; nonce: string }
  | { type: 'bb.settings.get' }
  | BridgeRpcMessage;

export type ExtensionReply =
  | { ok: true; type: 'status'; status: StatusPayload }
  | { ok: true; type: 'pong'; nonce: string; at: number }
  | { ok: true; type: 'settings'; settings: BridgeSettings }
  | { ok: true; type: 'rpc'; result: unknown; id?: string }
  | { ok: false; code: string; message: string; data?: unknown; id?: string };

const PROVIDED_VERSION = PROTOCOL_VERSION;

export function buildStatus(openTabs: number, startedAt: number, version: string): StatusPayload {
  return {
    name: 'BridgeDeck',
    version,
    protocol: PROVIDED_VERSION,
    canonicalMethods: CANONICAL_METHOD_COUNT,
    mcpTools: MCP_TOOL_COUNT,
    openTabs,
    uptimeMs: Math.max(0, Date.now() - startedAt),
    runtime: 'ts',
  };
}

/** 运行时校验：只接受已知消息类型，未知输入返回结构化错误而不是抛异常。 */
export function parseMessage(input: unknown): ExtensionMessage | null {
  if (!input || typeof input !== 'object') return null;
  const type = (input as { type?: unknown }).type;
  if (type === 'bb.status') return { type };
  if (type === 'bb.ping') {
    const nonce = (input as { nonce?: unknown }).nonce;
    if (typeof nonce !== 'string' || nonce.length === 0) return null;
    return { type, nonce };
  }
  if (type === 'bb.settings.get') return { type };
  if (type === 'bb.rpc') return parseRpcMessage(input);
  return null;
}

/**
 * bb.rpc 入参校验：
 * - method 非空且 ≤128 字符；
 * - params 若提供必须是普通对象（数组/null 拒绝）；
 * - timeoutMs 若提供必须是正数；
 * - id 若提供必须是非空字符串。
 * 与 src/rpc/registry.ts 的 parseRpcRequest 保持同一口径（这里先挡掉明显非法消息，
 * 注册表再做一次权威校验）。
 */
function parseRpcMessage(input: object): BridgeRpcMessage | null {
  const bag = input as { method?: unknown; params?: unknown; timeoutMs?: unknown; id?: unknown };
  if (typeof bag.method !== 'string') return null;
  const method = bag.method.trim();
  if (method.length === 0 || method.length > 128) return null;

  if (bag.params !== undefined && bag.params !== null && (!bag.params || typeof bag.params !== 'object' || Array.isArray(bag.params))) {
    return null;
  }
  if (bag.timeoutMs !== undefined && bag.timeoutMs !== null) {
    const timeoutMs = Number(bag.timeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return null;
  }
  if (bag.id !== undefined && bag.id !== null && (typeof bag.id !== 'string' || bag.id.length === 0)) return null;

  const message: BridgeRpcMessage = { type: 'bb.rpc', method };
  if (bag.params && typeof bag.params === 'object' && !Array.isArray(bag.params)) {
    message.params = bag.params as Record<string, unknown>;
  }
  if (bag.timeoutMs !== undefined && bag.timeoutMs !== null) message.timeoutMs = Math.floor(Number(bag.timeoutMs));
  if (typeof bag.id === 'string') message.id = bag.id;
  return message;
}
