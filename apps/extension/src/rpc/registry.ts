// src/rpc/registry.ts —— 扩展侧 RPC 方法注册表、feature gate、只读白名单、编解码与事件分发。
//
// 这一层要解决三个现实问题：
// 1. 方法面单源：注册表接受方法规格，未登记的方法一律 E_UNKNOWN_METHOD，避免 background
//    什么都往 daemon/扩展转发；
// 2. 派发前闸门：用 packages/protocol 的 assertProtocolCompatible 在调用前判定对端协议是否
//    支持该方法/参数需要的特性（1.8 扩展 + 1.9 特性的组合会被明确拒绝，而不是静默降级）；
// 3. 只读边界：background 的 `bb.rpc` 只允许转发 daemon §25.3 白名单里的只读方法；
//    白名单不是“排除法猜的”，直接对齐 daemon 的 WS_CALL_METHODS 六个方法。
//
// 编解码（parse/encode）在这里而不是 daemon 层：HTTP /rpc 与 WS call 两个信封形状一致，
// 且 background 收到的是浏览器 runtime 消息，需要先做一次不可信输入校验。

import {
  assertProtocolCompatible,
  catalogRow,
  METHOD_CATALOG,
  protocolGate,
  PROTOCOL_CURRENT,
  type MethodEffect,
  type MethodOwner,
  type ProtocolDecision,
  type ProtocolPass,
  type ProtocolPeer,
} from '../protocol.ts';
import { errorPayloadOf } from '../daemon/errors.ts';
import type { DaemonErrorPayload, DaemonRpcTransport } from '../daemon/types.ts';

// ---------------------------------------------------------------------------
// 只读白名单
// ---------------------------------------------------------------------------

/**
 * `bb.rpc` 可转发的只读方法：与 daemon 的 `WS_CALL_METHODS`
 * （daemon/server.mjs）和 docs/PROTOCOL.md §25.3 完全一致。
 * daemon 侧只放行这六个方法，扩展侧再收窄一次，两侧都不依赖“调用方自觉”。
 */
export const WS_READONLY_METHODS: readonly string[] = Object.freeze([
  'audit.list',
  'status',
  'session.list',
  'browsers',
  'operations.list',
  'operations.get',
]);

const WS_READONLY_METHOD_SET: ReadonlySet<string> = new Set(WS_READONLY_METHODS);

/** 目录里按 effect 判定的只读方法（passive_read / read）。 */
const CATALOG_READ_EFFECTS: ReadonlySet<string> = new Set<MethodEffect>(['passive_read', 'read']);

/** 协议目录里所有只读方法（effect = passive_read/read），按目录顺序。 */
export function catalogReadonlyMethods(): string[] {
  return METHOD_CATALOG.filter((row) => CATALOG_READ_EFFECTS.has(row.effect)).map((row) => row.method);
}

/** 该方法的目录 effect 是否是只读（未知方法返回 false）。 */
export function isCatalogReadonlyMethod(method: unknown): boolean {
  const row = catalogRow(method);
  return Boolean(row) && CATALOG_READ_EFFECTS.has(row?.effect ?? '');
}

/** 该方法是否在转发白名单内（默认 WS 六方法）。 */
export function isReadonlyMethod(method: unknown, allowlist: readonly string[] = WS_READONLY_METHODS): boolean {
  if (typeof method !== 'string' || !method) return false;
  return allowlist.includes(method);
}

/** 白名单拒绝的标准错误载荷。 */
export function readonlyRejection(method: unknown): DaemonErrorPayload {
  return {
    code: 'E_METHOD_NOT_ALLOWED',
    message: `方法 ${String(method || '')} 不在扩展只读白名单内（仅允许 ${WS_READONLY_METHODS.join(' / ')}）`,
    data: { method: String(method || ''), allowlist: [...WS_READONLY_METHODS] },
  };
}

// ---------------------------------------------------------------------------
// 类型化 RPC 错误
// ---------------------------------------------------------------------------

/** 注册表/编解码层抛出的业务错误（可安全转成 RpcReply.error）。 */
export class RpcMethodError extends Error {
  readonly code: string;
  readonly data: unknown;

  constructor(code: string, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcMethodError';
    this.code = code;
    this.data = data;
  }

  toPayload(): DaemonErrorPayload {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }
}

/** 任意异常 → RpcReply 可用的结构化错误（RpcMethodError 优先，其次协议/daemon 映射）。 */
export function rpcErrorPayloadOf(error: unknown): DaemonErrorPayload {
  if (error instanceof RpcMethodError) return error.toPayload();
  return errorPayloadOf(error);
}

// ---------------------------------------------------------------------------
// 编解码（不可信输入 → 类型化信封）
// ---------------------------------------------------------------------------

/** 内部规范化后的请求：params 一定是对象、method 已校验。 */
export interface RpcRequest {
  method: string;
  params: Record<string, unknown>;
  timeoutMs?: number;
  id?: string;
}

export type RpcParseResult =
  | { ok: true; request: RpcRequest }
  | { ok: false; error: DaemonErrorPayload };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function badRequest(message: string, data?: unknown): RpcParseResult {
  return {
    ok: false,
    error: data === undefined
      ? { code: 'E_BAD_REQUEST', message }
      : { code: 'E_BAD_REQUEST', message, data },
  };
}

/**
 * 校验外部请求（runtime 消息 / HTTP 信封）。
 * 非对象、method 缺失/非法、params 不是对象、timeoutMs 非法都返回结构化错误；
 * 未知额外字段忽略（前向兼容），但 id 只接受字符串。
 */
export function parseRpcRequest(raw: unknown): RpcParseResult {
  if (!isRecord(raw)) return badRequest('rpc 请求必须是对象');
  const method = raw.method;
  if (typeof method !== 'string' || method.trim().length === 0) {
    return badRequest('rpc.method 必须是非空字符串');
  }
  if (method.length > 128) return badRequest('rpc.method 过长（上限 128 字符）');

  const params = raw.params;
  if (params !== undefined && params !== null && !isRecord(params)) {
    return badRequest('rpc.params 必须是对象');
  }

  let timeoutMs: number | undefined;
  if (raw.timeoutMs !== undefined && raw.timeoutMs !== null) {
    const number = Number(raw.timeoutMs);
    if (!Number.isFinite(number) || number <= 0) return badRequest('rpc.timeoutMs 必须是正数');
    timeoutMs = Math.floor(number);
  }

  let id: string | undefined;
  if (raw.id !== undefined && raw.id !== null) {
    if (typeof raw.id !== 'string' || raw.id.length === 0) return badRequest('rpc.id 必须是非空字符串');
    id = raw.id;
  }

  const request: RpcRequest = {
    method: method.trim(),
    params: isRecord(params) ? params : {},
  };
  if (timeoutMs !== undefined) request.timeoutMs = timeoutMs;
  if (id !== undefined) request.id = id;
  return { ok: true, request };
}

/** 规范化请求 → 线上信封（测试/传输用；省略空 params 字段保持与 PROTOCOL 一致）。 */
export function encodeRpcRequest(request: RpcRequest): {
  method: string;
  params: Record<string, unknown>;
  timeoutMs?: number;
  id?: string;
} {
  const encoded: { method: string; params: Record<string, unknown>; timeoutMs?: number; id?: string } = {
    method: request.method,
    params: request.params ?? {},
  };
  if (request.timeoutMs !== undefined && request.timeoutMs > 0) encoded.timeoutMs = request.timeoutMs;
  if (request.id !== undefined) encoded.id = request.id;
  return encoded;
}

/** RPC 回包（background 回放、daemon /rpc 响应同形）。 */
export type RpcReply<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; error: DaemonErrorPayload };

/** 解码回包；畸形输入返回失败信封，而不是抛异常。 */
export function parseRpcReply<T = unknown>(raw: unknown): RpcReply<T> {
  if (!isRecord(raw)) {
    return { ok: false, error: { code: 'E_BAD_RESPONSE', message: 'rpc 回包必须是对象' } };
  }
  if (raw.ok === true) {
    return { ok: true, result: raw.result as T };
  }
  if (raw.ok === false) {
    const error = raw.error;
    if (!isRecord(error) || typeof error.code !== 'string' || !error.code) {
      return { ok: false, error: { code: 'E_BAD_RESPONSE', message: 'rpc 失败回包缺少 error.code' } };
    }
    return {
      ok: false,
      error: {
        code: error.code,
        message: typeof error.message === 'string' && error.message ? error.message : error.code,
        ...(error.data !== undefined ? { data: error.data } : {}),
      },
    };
  }
  return { ok: false, error: { code: 'E_BAD_RESPONSE', message: 'rpc 回包缺少 ok 字段' } };
}

/** 编码回包为纯 JSON 对象（identity 风格，便于测试与将来跨进程传递）。 */
export function encodeRpcReply<T>(reply: RpcReply<T>): Record<string, unknown> {
  if (reply.ok) return { ok: true, result: reply.result };
  return { ok: false, error: reply.error };
}

// ---------------------------------------------------------------------------
// 事件分发
// ---------------------------------------------------------------------------

/** 规范化后的 daemon 事件。 */
export interface RpcDaemonEvent {
  event: string;
  params: Record<string, unknown>;
  receivedAt: number;
}

export interface RpcEventDispatcherOptions {
  now?: () => number;
  /** 事件历史保留条数；0 表示不保留。默认 100。 */
  historyLimit?: number;
}

/**
 * 事件分发器：daemon 单向事件（`{type:'event', event, params}`）→ 具名订阅者。
 * 订阅者异常被隔离；未订阅的事件也会进历史，便于 debug 页回看。
 */
export class RpcEventDispatcher {
  private readonly named = new Map<string, Set<(event: RpcDaemonEvent) => void>>();
  private readonly wildcard = new Set<(event: RpcDaemonEvent) => void>();
  private readonly events: RpcDaemonEvent[] = [];
  private readonly now: () => number;
  private readonly historyLimit: number;

  constructor(options: RpcEventDispatcherOptions = {}) {
    this.now = options.now ?? Date.now;
    const limit = Number(options.historyLimit ?? 100);
    this.historyLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  }

  /** 订阅具名事件；返回取消订阅函数。 */
  on(event: string, handler: (event: RpcDaemonEvent) => void): () => void {
    const name = String(event || '');
    if (!name) throw new TypeError('RpcEventDispatcher.on: 事件名不能为空');
    let bucket = this.named.get(name);
    if (!bucket) {
      bucket = new Set();
      this.named.set(name, bucket);
    }
    bucket.add(handler);
    return () => {
      const current = this.named.get(name);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) this.named.delete(name);
    };
  }

  /** 订阅全部事件；返回取消订阅函数。 */
  onAny(handler: (event: RpcDaemonEvent) => void): () => void {
    this.wildcard.add(handler);
    return () => this.wildcard.delete(handler);
  }

  /**
   * 分发一帧事件。接受 `{event, params}` 或 `{type:'event', event, params}`；
   * 非法输入返回 null 且不分发（不抛异常，避免一条坏事件拖垮连接）。
   */
  dispatch(raw: unknown): RpcDaemonEvent | null {
    const frame = this.normalize(raw);
    if (!frame) return null;
    this.record(frame);
    const named = this.named.get(frame.event);
    if (named) {
      for (const handler of [...named]) {
        try {
          handler(frame);
        } catch {
          // 单个订阅者异常不影响其它订阅者
        }
      }
    }
    for (const handler of [...this.wildcard]) {
      try {
        handler(frame);
      } catch {
        // 同上
      }
    }
    return frame;
  }

  /** 最近事件（新的在前），limit 默认全量。 */
  history(limit?: number): RpcDaemonEvent[] {
    const count = limit === undefined ? this.events.length : Math.max(0, Math.floor(limit));
    return this.events.slice(0, count);
  }

  /** 当前订阅者数量（诊断用）。 */
  subscriberCount(): { named: number; wildcard: number } {
    let named = 0;
    for (const bucket of this.named.values()) named += bucket.size;
    return { named, wildcard: this.wildcard.size };
  }

  clear(): void {
    this.events.length = 0;
  }

  private normalize(raw: unknown): RpcDaemonEvent | null {
    if (!isRecord(raw)) return null;
    const name = raw.event;
    if (typeof name !== 'string' || name.trim().length === 0) return null;
    if (raw.type !== undefined && raw.type !== 'event') return null;
    const params = isRecord(raw.params) ? raw.params : {};
    return { event: name, params, receivedAt: this.now() };
  }

  private record(event: RpcDaemonEvent): void {
    if (this.historyLimit === 0) return;
    this.events.unshift(event);
    if (this.events.length > this.historyLimit) this.events.length = this.historyLimit;
  }
}

// ---------------------------------------------------------------------------
// 方法注册表
// ---------------------------------------------------------------------------

export interface RpcMethodSpec {
  method: string;
  /** 缺省时从协议目录行读取。 */
  effect?: MethodEffect;
  /** 缺省时从协议目录行读取；扩展自实现方法用 'extension'。 */
  owner?: MethodOwner | 'extension';
  /** 是否允许被 bb.rpc 转发；缺省按 allowlist 判定。 */
  readonly?: boolean;
  description?: string;
  /** 该方法的默认调用超时。 */
  timeoutMs?: number;
}

export interface RpcHandlerContext {
  method: string;
  params: Record<string, unknown>;
  timeoutMs: number;
  signal: AbortSignal | undefined;
  now: number;
  requestId: string | undefined;
}

export type RpcHandler = (context: RpcHandlerContext) => unknown | Promise<unknown>;

export interface RegisteredRpcMethod {
  spec: Required<Pick<RpcMethodSpec, 'method' | 'effect' | 'owner' | 'readonly' | 'timeoutMs'>> & {
    description: string;
  };
  handler: RpcHandler;
}

export interface RpcRegistryOptions {
  /** 扩展自身协议版本投影（feature gate 的对端）；默认当前协议版本。 */
  peer?: ProtocolPeer;
  /** 转发白名单；默认 WS_READONLY_METHODS。 */
  allowlist?: readonly string[];
  now?: () => number;
  /** 默认调用超时（毫秒），默认 60000。 */
  defaultTimeoutMs?: number;
}

const DEFAULT_RPC_TIMEOUT_MS = 60_000;

/**
 * 方法注册表。
 *
 * ```ts
 * const registry = new RpcRegistry({ peer: { protocol: PROTOCOL_CURRENT } });
 * registry.register({ method: 'status' }, async () => ({ ok: true }));
 * await registry.forward(socket, { method: 'status' }); // 过白名单 + feature gate 后调用
 * ```
 */
export class RpcRegistry {
  readonly events: RpcEventDispatcher;
  private peerValue: ProtocolPeer;
  private readonly allowlistValue: readonly string[];
  private readonly now: () => number;
  private readonly defaultTimeoutMs: number;
  private readonly methods = new Map<string, RegisteredRpcMethod>();

  constructor(options: RpcRegistryOptions = {}) {
    this.peerValue = options.peer ?? { protocol: PROTOCOL_CURRENT };
    this.allowlistValue = Object.freeze([...(options.allowlist ?? WS_READONLY_METHODS)]);
    this.now = options.now ?? Date.now;
    this.defaultTimeoutMs = Number(options.defaultTimeoutMs) > 0
      ? Math.floor(Number(options.defaultTimeoutMs))
      : DEFAULT_RPC_TIMEOUT_MS;
    this.events = new RpcEventDispatcher({ now: this.now });
  }

  get peer(): ProtocolPeer {
    return this.peerValue;
  }

  get allowlist(): readonly string[] {
    return this.allowlistValue;
  }

  /** 更新对端协议投影（例如 hello-ack 之后拿到 daemon/浏览器版本）。 */
  setPeer(peer: ProtocolPeer | null | undefined): void {
    this.peerValue = peer ?? {};
  }

  /** 注册方法；重复注册或方法名非法抛 RpcMethodError。 */
  register(spec: RpcMethodSpec, handler: RpcHandler): this {
    const normalized = this.normalizeSpec(spec);
    if (this.methods.has(normalized.method)) {
      throw new RpcMethodError('E_DUPLICATE_METHOD', `方法已注册：${normalized.method}`, {
        method: normalized.method,
      });
    }
    if (typeof handler !== 'function') {
      throw new RpcMethodError('E_BAD_HANDLER', `方法 ${normalized.method} 的 handler 不是函数`);
    }
    this.methods.set(normalized.method, { spec: normalized, handler });
    return this;
  }

  /** 便捷注册：只给方法名与 handler。 */
  registerMethod(method: string, handler: RpcHandler, spec: Partial<RpcMethodSpec> = {}): this {
    return this.register({ ...spec, method }, handler);
  }

  unregister(method: string): boolean {
    return this.methods.delete(method);
  }

  has(method: unknown): boolean {
    return typeof method === 'string' && this.methods.has(method);
  }

  get(method: unknown): RegisteredRpcMethod | null {
    if (typeof method !== 'string') return null;
    return this.methods.get(method) ?? null;
  }

  methodsList(): string[] {
    return [...this.methods.keys()];
  }

  entries(): RegisteredRpcMethod[] {
    return [...this.methods.values()];
  }

  get size(): number {
    return this.methods.size;
  }

  // -----------------------------------------------------------------------
  // feature gate + 白名单
  // -----------------------------------------------------------------------

  /** 纯查询版 feature gate（不抛异常）。 */
  checkCompatible(method: unknown, params: Readonly<Record<string, unknown>> | null | undefined = {}): ProtocolDecision {
    return protocolGate(this.peerValue, method, params);
  }

  /**
   * 派发前闸门：不兼容直接抛 ProtocolError（message/data 与 daemon/CLI 侧逐字段一致）。
   * 这是“1.8 旧扩展不能静默忽略 1.9 参数”的硬保证。
   */
  assertCompatible(method: unknown, params: Readonly<Record<string, unknown>> | null | undefined = {}): ProtocolPass {
    return assertProtocolCompatible(this.peerValue, method, params);
  }

  /** 当前 peer 下各特性的可用性快照（诊断/设置页展示）。 */
  allowedMethods(): string[] {
    return this.methodsList().filter((method) => this.isAllowed(method));
  }

  isAllowed(method: unknown): boolean {
    return isReadonlyMethod(method, this.allowlistValue);
  }

  assertAllowed(method: unknown): void {
    if (this.isAllowed(method)) return;
    const rejection = readonlyRejection(method);
    throw new RpcMethodError(rejection.code, rejection.message, rejection.data);
  }

  // -----------------------------------------------------------------------
  // 派发（本地注册的方法）
  // -----------------------------------------------------------------------

  /**
   * 分发一个外部请求到本地注册的 handler：
   * 解码 → E_UNKNOWN_METHOD 校验 → feature gate → handler → 结构化回包。
   * 与 `forward` 的区别：dispatch 执行**本扩展实现**的方法，forward 转发到 daemon。
   */
  async dispatch(
    raw: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<RpcReply> {
    const parsed = parseRpcRequest(raw);
    if (!parsed.ok) return parsed;
    const { request } = parsed;
    const entry = this.methods.get(request.method);
    if (!entry) {
      return {
        ok: false,
        error: {
          code: 'E_UNKNOWN_METHOD',
          message: `扩展未注册方法：${request.method}`,
          data: { method: request.method },
        },
      };
    }
    try {
      this.assertCompatible(request.method, request.params);
    } catch (error) {
      return { ok: false, error: rpcErrorPayloadOf(error) };
    }
    const timeoutMs = request.timeoutMs ?? entry.spec.timeoutMs ?? this.defaultTimeoutMs;
    try {
      const result = await entry.handler({
        method: request.method,
        params: request.params,
        timeoutMs,
        signal: options.signal,
        now: this.now(),
        requestId: request.id,
      });
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: rpcErrorPayloadOf(error) };
    }
  }

  // -----------------------------------------------------------------------
  // 转发（daemon 只读通道）
  // -----------------------------------------------------------------------

  /**
   * 转发到 daemon：解码 → 只读白名单 → feature gate → transport.call → 结构化回包。
   * 传输可以是 HTTP 客户端或 WS socket；错误统一映射成 RpcReply.error。
   */
  async forward(
    transport: DaemonRpcTransport,
    raw: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<RpcReply> {
    const parsed = parseRpcRequest(raw);
    if (!parsed.ok) return parsed;
    const { request } = parsed;
    try {
      this.assertAllowed(request.method);
      this.assertCompatible(request.method, request.params);
    } catch (error) {
      return { ok: false, error: rpcErrorPayloadOf(error) };
    }
    const callOptions: { signal?: AbortSignal; timeoutMs?: number } = {};
    if (options.signal) callOptions.signal = options.signal;
    const timeoutMs = request.timeoutMs ?? options.timeoutMs;
    if (timeoutMs !== undefined) callOptions.timeoutMs = timeoutMs;
    try {
      const result = await transport.call<unknown>(request.method, request.params, callOptions);
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: rpcErrorPayloadOf(error) };
    }
  }

  // -----------------------------------------------------------------------

  private normalizeSpec(spec: RpcMethodSpec): RegisteredRpcMethod['spec'] {
    const method = typeof spec.method === 'string' ? spec.method.trim() : '';
    if (!method) throw new RpcMethodError('E_BAD_METHOD', '方法名不能为空');
    const row = catalogRow(method);
    const effect = spec.effect ?? row?.effect ?? 'browser_mutation';
    const owner = spec.owner ?? row?.owner ?? 'extension';
    return {
      method,
      effect,
      owner,
      readonly: spec.readonly ?? this.isAllowed(method),
      timeoutMs: Number(spec.timeoutMs) > 0 ? Math.floor(Number(spec.timeoutMs)) : this.defaultTimeoutMs,
      description: spec.description ?? '',
    };
  }
}

/** 便捷工厂。 */
export function createRpcRegistry(options: RpcRegistryOptions = {}): RpcRegistry {
  return new RpcRegistry(options);
}

/** 目录签名辅助：是否登记了该方法（协议单源口径）。 */
export function isCatalogMethod(method: unknown): boolean {
  return Boolean(catalogRow(method));
}
