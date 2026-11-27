// src/tools/webmcp.js —— 读取/调用页面通过 WebMCP 注册的工具（navigator.modelContext）。
import { bridgeError } from '../errors.js';
import { evaluate } from './read.js';

const LIST_EXPR = `(async () => {
  const context = document.modelContext || navigator.modelContext;
  if (!context || typeof context.getTools !== 'function') return { available: false, tools: [] };
  let tools = [];
  try { tools = await context.getTools(); } catch { tools = []; }
  tools = Array.isArray(tools) ? tools : [];
  return {
    available: true,
    tools: tools.filter((tool) => !('window' in tool) || tool.window === window).map((tool) => {
      let inputSchema = tool.inputSchema;
      if (typeof inputSchema === 'string') { try { inputSchema = JSON.parse(inputSchema); } catch { inputSchema = undefined; } }
      return {
        name: typeof tool.name === 'string' ? tool.name : '',
        ...(typeof tool.title === 'string' ? { title: tool.title } : {}),
        description: typeof tool.description === 'string' ? tool.description : '',
        ...(inputSchema === undefined ? {} : { inputSchema }),
        ...(tool.annotations ? { annotations: {
          readOnly: Boolean(tool.annotations.readOnlyHint || tool.annotations.readOnly),
          untrustedContent: Boolean(tool.annotations.untrustedContentHint || tool.annotations.untrustedContent),
          consequential: Boolean(tool.annotations.consequentialHint || tool.annotations.consequential),
        } } : {}),
        ...(typeof tool.origin === 'string' ? { origin: tool.origin } : {}),
      };
    }),
  };
})()`;

function callExpr(name, input) {
  return `(async () => {
    const context = document.modelContext || navigator.modelContext;
    if (!context || typeof context.getTools !== 'function') throw new Error('WebMCP 在该页面不可用');
    const tools = await context.getTools();
    const tool = (tools || []).filter((candidate) => !('window' in candidate) || candidate.window === window)
      .find((candidate) => candidate.name === ${JSON.stringify(name)});
    if (!tool) throw new Error('找不到 WebMCP 工具：' + ${JSON.stringify(name)});
    const input = ${JSON.stringify(input)};
    let result;
    if (typeof context.executeTool === 'function') {
      try { result = await context.executeTool(tool, input); }
      catch (error) {
        const message = String(error && error.message || error);
        if (!/parameter 2|parse input/i.test(message)) throw error;
        result = await context.executeTool(tool, JSON.stringify(input));
      }
    } else if (typeof context.invokeTool === 'function') {
      result = await context.invokeTool(${JSON.stringify(name)}, input);
    } else if (typeof tool.execute === 'function') {
      result = await tool.execute(input);
    } else {
      throw new Error('该页面不支持执行 WebMCP 工具');
    }
    if (typeof result !== 'string') return result === undefined ? null : result;
    try { return JSON.parse(result); } catch { return result; }
  })()`;
}

/** 工具名/描述/参数都来自页面，属于不可信内容。 */
export async function webmcpList(params = {}) {
  const result = await evaluate({ ...params, expression: LIST_EXPR, unverified: true });
  const value = result && result.value;
  if (!value || typeof value !== 'object') return { available: false, tools: [], untrusted: true };
  return {
    available: value.available === true,
    tools: Array.isArray(value.tools) ? value.tools : [],
    untrusted: true,
  };
}

export async function webmcpCall(params = {}) {
  const name = String(params.name || '').trim();
  if (!name) throw bridgeError('E_BAD_ARG', 'webmcp call 需要工具名');
  const input = params.input && typeof params.input === 'object' ? params.input : {};
  const result = await evaluate({ ...params, expression: callExpr(name, input), unverified: true });
  return { ok: true, name, result: result && result.value !== undefined ? result.value : null, untrusted: true };
}
