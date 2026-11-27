// src/scripting/evaluate.ts —— evaluate 的 MAIN world 执行器（M-C 第三批）。
//
// 为什么必须换世界：M-C 第二批在内容脚本隔离世界用 `eval` 执行表达式，MV3 的扩展页 CSP
// 不含 `unsafe-eval`，于是所有 evaluate 都变成 E_EVAL_FAILED（真实 E2E 里 9 项直接失败，
// 另有大量用例因为“用 evaluate 铺场景”而连锁失败）。JS 扩展走 CDP Runtime.evaluate；
// TS 运行时明确不接 chrome.debugger，等价的正确做法是 `chrome.scripting.executeScript`
// 的 `world:'MAIN'` —— 它在页面主世界执行，不受扩展页 CSP 限制，也能看到页面自己的
// window 变量（CDP evaluate 的语义）。
//
// 页面主世界的 eval 仍受**页面** CSP 限制（`unsafe-eval` 被禁的站点会失败）。这里选择
// 如实失败并带上原因，而不是用 script 标签注入等方式绕过站点策略：
//   - 执行失败 → E_EVAL_FAILED + data.reason（包含 CSP 提示）；
//   - 返回值统一 JSON 安全化（DOM 节点退化成 {tag,id,text}，函数/循环深度截断）。
//
// 把 api 作为接口注入：单测可以断言“给的内容脚本注入参数是什么”，不需要真实浏览器。

import { RpcMethodError } from '../rpc/registry.ts';

/** chrome.scripting.executeScript 的最小形状（真实 browser 对象结构兼容）。 */
export interface ScriptingInjection {
  target: { tabId: number; frameIds?: number[] };
  world?: 'MAIN' | 'ISOLATED';
  func: (...args: never[]) => unknown;
  args?: unknown[];
}

export interface ScriptingApi {
  scripting: {
    executeScript<T = unknown>(injection: ScriptingInjection): Promise<Array<{ result?: T; error?: { message?: string } }>>;
  };
}

export interface EvaluateOutcome {
  value: unknown;
  expression: string;
  world: 'main';
  verified: false;
  at: number;
  /** 页面主世界执行被站点 CSP 拒绝时的说明（其它错误在 message 里）。 */
  note?: string;
}

interface MainWorldOutcome {
  ok: boolean;
  value?: unknown;
  message?: string;
  csp?: boolean;
}

/**
 * 主世界执行体。**必须是自包含函数**：chrome.scripting 会把它序列化后注入页面，
 * 闭包变量不会跟过去（这是常见坑，测试里也有形状断言）。
 */
function mainWorldEvaluate(source: string): MainWorldOutcome {
  const sanitize = (value: unknown, depth: number): unknown => {
    if (value === null || value === undefined) return value === undefined ? null : value;
    const type = typeof value;
    if (type === 'string' || type === 'number' || type === 'boolean') return value;
    if (type === 'bigint') return String(value);
    if (type === 'symbol' || type === 'function') return null;
    if (depth > 6) return '[max-depth]';
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (let index = 0; index < value.length && index < 1000; index += 1) out.push(sanitize(value[index], depth + 1));
      return out;
    }
    const bag = value as Record<string, unknown>;
    try {
      if (typeof (bag as { nodeType?: unknown }).nodeType === 'number') {
        const element = bag as unknown as { tagName?: string; id?: string; textContent?: string | null };
        return {
          nodeType: (bag as { nodeType?: number }).nodeType,
          tag: String(element.tagName ?? '').toLowerCase(),
          id: element.id ? String(element.id) : null,
          text: String(element.textContent ?? '').slice(0, 200),
        };
      }
      if (typeof (bag as { then?: unknown }).then === 'function') return '[promise]';
    } catch {
      return null;
    }
    const out: Record<string, unknown> = {};
    let count = 0;
    try {
      for (const key of Object.keys(bag)) {
        if (count >= 200) break;
        out[key] = sanitize(bag[key], depth + 1);
        count += 1;
      }
    } catch {
      return '[unserializable]';
    }
    return out;
  };

  try {
    const evaluator = (globalThis as { eval?: (input: string) => unknown }).eval;
    if (typeof evaluator !== 'function') return { ok: false, message: 'MAIN world 没有 eval（页面环境异常）' };
    const result = evaluator(source);
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      return { ok: true, value: '[promise]' };
    }
    return { ok: true, value: sanitize(result, 0) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message, csp: /Content Security Policy|unsafe-eval/i.test(message) };
  }
}

/** 从 chrome/edge 抛出的错误里提取可读文案。 */
function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return String(error);
}

/**
 * 在页面主世界执行表达式。
 *
 * ```ts
 * const out = await evaluateInMainWorld(browser, 7, 'document.title');
 * // { value: 'BridgeDeck E2E 夹具页', world: 'main', ... }
 * ```
 *
 * @throws RpcMethodError E_BAD_ARG（空表达式）/ E_EVAL_FAILED（页面执行失败）/
 *   E_EVAL_UNAVAILABLE（没有 scripting API）
 */
export async function evaluateInMainWorld(
  api: ScriptingApi | null | undefined,
  tabId: number,
  expression: unknown,
  now: () => number = Date.now,
): Promise<EvaluateOutcome> {
  if (!Number.isInteger(tabId) || tabId <= 0) {
    throw new RpcMethodError('E_BAD_ARG', 'evaluate 需要正整数 tabId', { tabId });
  }
  const source = typeof expression === 'string' ? expression.trim() : '';
  if (!source) throw new RpcMethodError('E_BAD_ARG', 'evaluate 需要非空 expression');
  if (!api || !api.scripting || typeof api.scripting.executeScript !== 'function') {
    throw new RpcMethodError('E_EVAL_UNAVAILABLE', '当前运行时没有 chrome.scripting，无法在主世界执行 evaluate', {
      hasApi: Boolean(api),
      hasScripting: Boolean(api?.scripting),
      executeScriptType: typeof (api as { scripting?: { executeScript?: unknown } } | null | undefined)?.scripting?.executeScript,
      chromeScripting: typeof (globalThis as { chrome?: { scripting?: unknown } }).chrome?.scripting,
    });
  }
  let results: Array<{ result?: MainWorldOutcome; error?: { message?: string } }>;
  try {
    results = await api.scripting.executeScript<MainWorldOutcome>({
      target: { tabId, frameIds: [0] },
      world: 'MAIN',
      func: mainWorldEvaluate as unknown as ScriptingInjection['func'],
      args: [source],
    });
  } catch (error) {
    throw new RpcMethodError('E_EVAL_FAILED', '主世界注入失败：' + errorMessageOf(error), {
      expression: source,
      tabId,
      reason: errorMessageOf(error),
    });
  }
  const first = Array.isArray(results) ? results[0] : null;
  if (!first) {
    throw new RpcMethodError('E_EVAL_FAILED', '主世界执行没有返回结果（页面可能正在导航）', { expression: source, tabId });
  }
  if (first.error && first.error.message) {
    throw new RpcMethodError('E_EVAL_FAILED', 'evaluate 抛错：' + first.error.message, {
      expression: source,
      tabId,
      reason: first.error.message,
    });
  }
  const outcome = first.result;
  if (!outcome || typeof outcome !== 'object') {
    throw new RpcMethodError('E_EVAL_FAILED', '主世界执行返回了非法结果', { expression: source, tabId });
  }
  if (outcome.ok !== true) {
    const message = String(outcome.message ?? '未知错误');
    throw new RpcMethodError('E_EVAL_FAILED', 'evaluate 抛错：' + message, {
      expression: source,
      tabId,
      reason: message,
      ...(outcome.csp ? { csp: 'unsafe-eval' } : {}),
    });
  }
  return {
    value: outcome.value ?? null,
    expression: source,
    world: 'main',
    verified: false,
    at: now(),
  };
}

/** 导出给单测：确认自包含执行体的代码里没有闭包引用（形状断言）。 */
export const MAIN_WORLD_EVALUATOR_SOURCE = mainWorldEvaluate.toString();
