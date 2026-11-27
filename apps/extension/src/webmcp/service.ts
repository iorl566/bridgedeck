// src/webmcp/service.ts —— WebMCP（页面模型上下文工具）的 list/call（M-C 第四批）。
//
// WebMCP 是页面通过 `document.modelContext`（或 navigator.modelContext）暴露工具的运行期
// 约定。钩子运行在页面主世界（chrome.scripting MAIN），因此工具对象与页面自己看到的是同一份，
// 不做序列化搬运；返回结果统一 JSON 安全化（深度/条目截断），失败回结构化错误。
//
// 边界：只调用页面**已经声明**的工具（getTools/executeTool）；不注入/不伪造工具列表。

import { RpcMethodError } from '../rpc/registry.ts';
import type { ScriptingApi } from '../scripting/evaluate.ts';

function mainWorldListWebMcp(): unknown {
  const doc = document as unknown as Record<string, unknown>;
  const nav = navigator as unknown as Record<string, unknown>;
  const context = (doc.modelContext ?? nav.modelContext ?? null) as {
    getTools?: () => Promise<unknown>;
    tools?: unknown;
  } | null;
  if (!context) return { available: false, tools: [] };
  const sanitize = (value: unknown, depth = 0): unknown => {
    if (value === null || value === undefined) return value ?? null;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    if (depth > 4) return '[max-depth]';
    if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, depth + 1));
    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      let count = 0;
      for (const key of Object.keys(value as Record<string, unknown>)) {
        if (count >= 40) break;
        out[key] = sanitize((value as Record<string, unknown>)[key], depth + 1);
        count += 1;
      }
      return out;
    }
    return null;
  };
  const normalizeTools = (tools: unknown): Array<Record<string, unknown>> => {
    if (!Array.isArray(tools)) return [];
    return tools.slice(0, 64).map((tool) => {
      const bag = (tool ?? {}) as Record<string, unknown>;
      return {
        name: String(bag.name ?? ''),
        description: String(bag.description ?? ''),
        inputSchema: sanitize(bag.inputSchema ?? null),
        annotations: sanitize(bag.annotations ?? null),
      };
    });
  };
  const direct = normalizeTools(context.tools);
  if (direct.length) return { available: true, tools: direct };
  if (typeof context.getTools !== 'function') return { available: true, tools: [] };
  return Promise.resolve(context.getTools()).then((tools) => ({ available: true, tools: normalizeTools(tools) }));
}

function mainWorldCallWebMcp(args: { name: string; input: unknown }): unknown {
  const doc = document as unknown as Record<string, unknown>;
  const nav = navigator as unknown as Record<string, unknown>;
  const context = (doc.modelContext ?? nav.modelContext ?? null) as {
    getTools?: () => Promise<unknown>;
    executeTool?: (tool: unknown, input: unknown) => Promise<unknown>;
    callTool?: (name: string, input: unknown) => Promise<unknown>;
    tools?: Array<Record<string, unknown>>;
  } | null;
  if (!context) return { ok: false, code: 'E_NOT_SUPPORTED', message: '页面没有 WebMCP/modelContext' };
  const find = (tools: unknown): Record<string, unknown> | null => {
    if (!Array.isArray(tools)) return null;
    return (tools.find((tool) => tool && String((tool as Record<string, unknown>).name) === args.name) as Record<string, unknown> | undefined) ?? null;
  };
  const run = async (): Promise<unknown> => {
    if (typeof context.callTool === 'function') {
      return context.callTool(args.name, args.input);
    }
    const tools = Array.isArray(context.tools) ? context.tools : (typeof context.getTools === 'function' ? await context.getTools() : []);
    const tool = find(tools);
    if (!tool) return { ok: false, code: 'E_TOOL_NOT_FOUND', message: '页面没有工具：' + args.name };
    if (typeof context.executeTool === 'function') return context.executeTool(tool, args.input);
    if (typeof tool.execute === 'function') return (tool.execute as (input: unknown) => unknown)(args.input);
    return { ok: false, code: 'E_TOOL_NOT_CALLABLE', message: '工具不可调用：' + args.name };
  };
  return run().then((result) => ({ ok: true, result }));
}

export const WEBMCP_LIST_SOURCE = mainWorldListWebMcp.toString();
export const WEBMCP_CALL_SOURCE = mainWorldCallWebMcp.toString();

export class WebMcpService {
  private readonly scripting: ScriptingApi | null;
  private readonly now: () => number;

  constructor(options: { scripting?: ScriptingApi | null; now?: () => number }) {
    this.scripting = options.scripting ?? null;
    this.now = options.now ?? Date.now;
  }

  private async run<T>(tabId: number, func: (...args: never[]) => unknown, args: unknown[] = []): Promise<T> {
    if (!Number.isInteger(tabId) || tabId <= 0) throw new RpcMethodError('E_BAD_ARG', 'webmcp 需要正整数 tabId');
    if (!this.scripting || typeof this.scripting.scripting.executeScript !== 'function') {
      throw new RpcMethodError('E_EVAL_UNAVAILABLE', '当前运行时没有 chrome.scripting，无法调用页面 WebMCP', { tabId });
    }
    try {
      const results = await this.scripting.scripting.executeScript<T>({
        target: { tabId, frameIds: [0] },
        world: 'MAIN',
        func: func as unknown as (...args: never[]) => unknown,
        args,
      });
      const first = Array.isArray(results) ? results[0] : null;
      if (!first) throw new RpcMethodError('E_EVAL_FAILED', 'WebMCP 主世界执行没有返回结果', { tabId });
      if (first.error && first.error.message) throw new RpcMethodError('E_EVAL_FAILED', 'WebMCP 执行失败：' + first.error.message, { tabId });
      return first.result as T;
    } catch (error) {
      if (error instanceof RpcMethodError) throw error;
      throw new RpcMethodError('E_EVAL_FAILED', 'WebMCP 执行失败：' + (error instanceof Error ? error.message : String(error)), { tabId });
    }
  }

  async list(rawParams: unknown): Promise<Record<string, unknown>> {
    const params = (rawParams && typeof rawParams === 'object' ? rawParams : {}) as Record<string, unknown>;
    const tabId = Number(params.tabId);
    const outcome = await this.run<{ available?: boolean; tools?: Array<Record<string, unknown>> }>(tabId, mainWorldListWebMcp);
    const tools = Array.isArray(outcome?.tools) ? outcome.tools : [];
    return {
      ok: true,
      available: outcome?.available === true,
      tools,
      count: tools.length,
      source: 'document.modelContext',
      at: this.now(),
    };
  }

  async call(rawParams: unknown): Promise<Record<string, unknown>> {
    const params = (rawParams && typeof rawParams === 'object' ? rawParams : {}) as Record<string, unknown>;
    const tabId = Number(params.tabId);
    const name = typeof params.name === 'string' ? params.name : '';
    if (!name) throw new RpcMethodError('E_BAD_ARG', 'webmcp call 需要工具名');
    let input: unknown = params.input;
    if (typeof input === 'string') {
      try {
        input = input.trim() ? JSON.parse(input) : {};
      } catch {
        throw new RpcMethodError('E_BAD_ARG', 'webmcp call --input 不是合法 JSON');
      }
    }
    const outcome = await this.run<{ ok?: boolean; result?: unknown; code?: string; message?: string }>(
      tabId,
      mainWorldCallWebMcp,
      [{ name, input: input ?? {} }],
    );
    if (!outcome || outcome.ok !== true) {
      throw new RpcMethodError(
        outcome?.code ?? 'E_TOOL_FAILED',
        outcome?.message ?? 'WebMCP 工具执行失败：' + name,
        { name, tabId },
      );
    }
    return {
      ok: true,
      name,
      result: outcome.result ?? null,
      source: 'document.modelContext',
      at: this.now(),
    };
  }
}
