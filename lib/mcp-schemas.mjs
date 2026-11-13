// lib/mcp-schemas.mjs —— 从 lib/schemas.mjs 的规范参数生成 MCP inputSchema。
//
// MCP 的入参是 snake_case，协议内部是 camelCase；这里集中做一次映射，
// 避免同一动作在 daemon 校验、CLI 帮助、MCP 工具 schema 三处各写一份。

import { METHOD_SCHEMAS } from './schemas.mjs';

const SNAKE_NAMES = {
  tabId: 'tab_id',
  noClear: 'no_clear',
  fullPage: 'full_page',
  timeoutMs: 'timeout_ms',
  waitTimeoutMs: 'wait_timeout',
  settleMs: 'settle_ms',
  maxTokens: 'max_tokens',
  maxDepth: 'max_depth',
  maxRows: 'max_rows',
  maxBytes: 'max_bytes',
  itemSelector: 'item_selector',
  waitUntil: 'wait_until',
  probeHover: 'probe_hover',
  debugSurfaces: 'debug_surfaces',
  closedShadow: 'closed_shadow',
  fieldsJson: 'fields_json',
  noFocus: 'no_focus',
};

/** camelCase → MCP 的 snake_case。 */
export function snakeName(name) {
  if (SNAKE_NAMES[name]) return SNAKE_NAMES[name];
  return String(name).replace(/[A-Z]/g, (character) => '_' + character.toLowerCase());
}

/**
 * 由规范 schema 生成 MCP inputSchema。
 * @param {string} method 规范方法名（如 click / fill / observe）
 * @param {{ omit?: string[], extra?: Record<string, unknown>, required?: string[] }} [options]
 */
export function mcpInputSchema(method, options = {}) {
  const schema = METHOD_SCHEMAS[method];
  if (!schema) throw new Error('没有方法 schema：' + method);
  const omit = new Set(options.omit || []);
  const properties = {};
  for (const [name, value] of Object.entries(schema.properties || {})) {
    if (omit.has(name)) continue;
    properties[snakeName(name)] = value;
  }
  Object.assign(properties, options.extra || {});
  if (!properties.session) properties.session = { type: 'string' };
  const required = [...new Set([...(schema.required || []), ...(options.required || [])])]
    .map(snakeName)
    .filter((name) => properties[name] !== undefined);
  const result = { type: 'object', properties, additionalProperties: false };
  if (required.length) result.required = required;
  return result;
}
