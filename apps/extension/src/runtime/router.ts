// src/runtime/router.ts —— daemon `cmd` 帧 → 扩展命令处理器（含同 tab 串行与超时）。
//
// PROTOCOL.md §3.3 的三条硬要求在这里落地：
// 1) 未知 method 必须回 E_UNKNOWN_METHOD（不能挂到 daemon 超时）；
// 2) 同一 tab 的命令串行（`Map<tabId, Promise>` 链）—— 只读/等待类命令显式豁免，
//    否则 observe 会排在自家动作后面自锁；与 JS 扩展 dispatch.js 的 UNSERIALIZED_METHODS 同义；
// 3) 必须在 daemon 的 timeoutMs 内回包；这里加一个本地超时把“处理器卡死”变成结构化
//    E_TIMEOUT，而不是等 daemon 丢弃迟到回包。
//
// Router 不直接碰 WebSocket：`handle(frame)` 返回结构化结果，background 用
// socket.sendCommandResult/sendCommandError 回包；单测可以完全离线驱动。

import type { DaemonCommandFrame } from '../daemon/ws.ts';
import type { DaemonErrorPayload } from '../daemon/types.ts';
import { rpcErrorPayloadOf } from '../rpc/registry.ts';

export interface CommandContext {
  method: string;
  params: Record<string, unknown>;
  /** daemon 给的回包预算（含 grace）；用作本地硬上限。 */
  timeoutMs: number;
  requestId: string;
  now: number;
}

export type CommandHandler = (context: CommandContext) => unknown | Promise<unknown>;

export interface CommandRegistrationOptions {
  /** 显式指定是否按 tabId 串行；缺省按 tabId 是否存在决定。 */
  serialized?: boolean;
  /** 本地超时覆盖（缺省用 frame.timeoutMs）。 */
  timeoutMs?: number;
  description?: string;
}

export interface RegisteredCommand {
  method: string;
  handler: CommandHandler;
  serialized: boolean;
  timeoutMs: number | null;
  description: string;
}

export interface CommandReply {
  ok: true;
  result: unknown;
}

export interface CommandFailure {
  ok: false;
  error: DaemonErrorPayload;
}

export type CommandOutcome = CommandReply | CommandFailure;

export interface DaemonCommandResponder {
  sendCommandResult(id: string, result: unknown): boolean;
  sendCommandError(id: string, error: DaemonErrorPayload): boolean;
}

export interface CommandRouterOptions {
  now?: () => number;
  /** 缺省本地超时（daemon 帧没带 timeoutMs 时使用）。 */
  defaultTimeoutMs?: number;
}

const DEFAULT_LOCAL_TIMEOUT_MS = 60_000;

/** 读类/控制类命令不排队：避免 observe 等自家动作、dialog/取消等被动作阻塞。 */
const DEFAULT_UNSERIALIZED: ReadonlySet<string> = new Set([
  'observe',
  'read',
  'get-html',
  'evaluate',
  'window.list',
  'window.ensureAgent',
  'window.focus',
  'tab.list',
  'settings.get',
  'diagnostics.ui',
  'control-hint',
  // 取消类必须绕过同 tab 串行队：否则 operation.cancel 会排在它要取消的等待命令之后，
  // 表现成“取消永远找不到进行中的 operation”（真实 E2E 20t 踩到）。
  'cancel',
  'operation.cancel',
  'cooperate.wait',
  'cooperate.handback',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 命令路由器。
 *
 * ```ts
 * const router = new CommandRouter();
 * for (const cmd of createRuntimeCommands(deps)) router.register(cmd.method, cmd.handler, cmd);
 * const outcome = await router.handle({ type:'cmd', id:'c1', method:'window.list', params:{}, timeoutMs:5000 });
 * ```
 */
export class CommandRouter {
  private readonly commands = new Map<string, RegisteredCommand>();
  private readonly tabChains = new Map<number, Promise<unknown>>();
  private readonly now: () => number;
  private readonly defaultTimeoutMs: number;

  constructor(options: CommandRouterOptions = {}) {
    this.now = options.now ?? Date.now;
    this.defaultTimeoutMs = Number(options.defaultTimeoutMs) > 0
      ? Math.floor(Number(options.defaultTimeoutMs))
      : DEFAULT_LOCAL_TIMEOUT_MS;
  }

  get size(): number {
    return this.commands.size;
  }

  register(method: string, handler: CommandHandler, options: CommandRegistrationOptions = {}): this {
    const name = typeof method === 'string' ? method.trim() : '';
    if (!name) throw new TypeError('CommandRouter.register: 方法名不能为空');
    if (typeof handler !== 'function') throw new TypeError('CommandRouter.register: handler 不是函数');
    if (this.commands.has(name)) throw new Error('CommandRouter.register: 方法已注册：' + name);
    this.commands.set(name, {
      method: name,
      handler,
      serialized: options.serialized ?? !DEFAULT_UNSERIALIZED.has(name),
      timeoutMs: Number(options.timeoutMs) > 0 ? Math.floor(Number(options.timeoutMs)) : null,
      description: options.description ?? '',
    });
    return this;
  }

  registerAll(commands: readonly RegisteredCommand[]): this {
    for (const command of commands) {
      this.register(command.method, command.handler, {
        serialized: command.serialized,
        ...(command.timeoutMs !== null ? { timeoutMs: command.timeoutMs } : {}),
        description: command.description,
      });
    }
    return this;
  }

  has(method: unknown): boolean {
    return typeof method === 'string' && this.commands.has(method);
  }

  methods(): string[] {
    return [...this.commands.keys()];
  }

  /** 处理一帧 cmd；永不抛异常（所有失败都转成结构化结果）。 */
  async handle(frame: DaemonCommandFrame): Promise<CommandOutcome> {
    const method = typeof frame?.method === 'string' ? frame.method : '';
    const params = isRecord(frame?.params) ? frame.params : {};
    const requestId = typeof frame?.id === 'string' ? frame.id : '';
    if (!method) return { ok: false, error: { code: 'E_BAD_REQUEST', message: 'cmd 帧缺少 method' } };
    const command = this.commands.get(method);
    if (!command) {
      return {
        ok: false,
        error: { code: 'E_UNKNOWN_METHOD', message: '扩展未实现命令：' + method, data: { method } },
      };
    }
    const timeoutMs = command.timeoutMs ?? (Number(frame.timeoutMs) > 0 ? Math.floor(Number(frame.timeoutMs)) : this.defaultTimeoutMs);
    const context: CommandContext = { method, params, timeoutMs, requestId, now: this.now() };
    const tabId = Number(params.tabId);
    const run = (): Promise<CommandOutcome> => this.runHandler(command, context);

    // 同一 tab 的命令串行（PROTOCOL §3.3）；读类命令豁免，避免自锁。
    if (command.serialized && Number.isInteger(tabId) && tabId > 0) {
      const previous = this.tabChains.get(tabId) ?? Promise.resolve();
      const current = previous.catch(() => undefined).then(run, run);
      this.tabChains.set(tabId, current);
      try {
        return await current;
      } finally {
        if (this.tabChains.get(tabId) === current) this.tabChains.delete(tabId);
      }
    }
    return run();
  }

  /** 处理一帧并通过 responder 回包；返回是否成功发送（连接可能已断）。 */
  async respond(frame: DaemonCommandFrame, responder: DaemonCommandResponder): Promise<boolean> {
    const outcome = await this.handle(frame);
    try {
      if (outcome.ok) return responder.sendCommandResult(frame.id, outcome.result);
      return responder.sendCommandError(frame.id, outcome.error);
    } catch {
      return false;
    }
  }

  /** 当前排队的 tab 数（诊断用）。 */
  queuedTabs(): number {
    return this.tabChains.size;
  }

  private async runHandler(command: RegisteredCommand, context: CommandContext): Promise<CommandOutcome> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<CommandOutcome>((resolve) => {
      timer = setTimeout(() => {
        resolve({
          ok: false,
          error: {
            code: 'E_TIMEOUT',
            message: '扩展命令 ' + command.method + ' 本地超时（' + String(context.timeoutMs) + 'ms）',
            data: { method: command.method, timeoutMs: context.timeoutMs },
          },
        });
      }, Math.max(1, context.timeoutMs));
    });
    const execution = (async (): Promise<CommandOutcome> => {
      try {
        const result = await command.handler(context);
        return { ok: true, result: result === undefined ? { ok: true } : result };
      } catch (error) {
        return { ok: false, error: rpcErrorPayloadOf(error) };
      }
    })();
    try {
      return await Promise.race([execution, timeout]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
}

/** 便捷工厂。 */
export function createCommandRouter(options: CommandRouterOptions = {}): CommandRouter {
  return new CommandRouter(options);
}
