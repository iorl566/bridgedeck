// sdk/tool-catalog.mjs —— Node SDK 的 92 个 MCP 工具语义目录（类型/校验/分页标记）。
//
// 目标（W4-A 第 4 项）：让 Node SDK 调用方不只能 `page.click()`，还能像 MCP 客户端一样
// 使用全部 92 个工具，并且拿到与 MCP 完全一致的：
//   - 工具语义：名称/标题/描述/协议方法/特性门/最低协议版本；
//   - 分档策略：read/mutate/destructive、是否要求审批、超时；
//   - 入参：snake_case 参数表（类型/枚举/默认值/必填），复用 mcp/tool-args.mjs 的运行时校验；
//   - 分页标记：哪些工具/方法的结果可能被截断、用哪个游标参数续读。
//
// 单一来源原则：全部从 mcp/tools-*.mjs 的注册结果 / mcp/tool-methods.mjs /
// lib/method-catalog.mjs / mcp/tool-policy.mjs 派生，SDK 不手抄第二份工具表。
// 因此 MCP 侧任何 schema/映射变化都会立刻反映到 SDK；sdk/tool-runtime.mjs 负责真正调用。

import { createBrowserTools } from '../mcp/tools.mjs';
import { TOOL_METHODS } from '../mcp/tool-methods.mjs';
import { TOOL_CONTRACTS } from '../mcp/tool-contracts.mjs';
import { annotationsFor, policyFor } from '../mcp/tool-policy.mjs';
import { validateToolArgs, ToolArgumentError } from '../mcp/tool-args.mjs';
import { describeToolContract } from '../mcp/schema-audit.mjs';
import { METHOD_FEATURE, METHOD_PARTIAL, METHOD_NAMES, PROTOCOL_BASELINE, PROTOCOL_CURRENT, floorOf } from '../lib/method-catalog.mjs';

/** 纯用于读取 schema 的占位上下文：不会被执行（SDK 调用走 sdk/tool-runtime.mjs）。 */
const SCHEMA_ONLY_CTX = {
  rpc: async () => { throw new Error('SDK 工具目录不执行 RPC'); },
  ensureSession: async () => 'sdk-schema-only',
  withSession: (sessionId, params) => ({ ...params, session: sessionId }),
  parseDurationMs: () => null,
  runCliJson: async () => ({}),
  HOME: '',
  state: {},
};

const SCHEMA_TOOLS = createBrowserTools(SCHEMA_ONLY_CTX).map((tool) => ({
  ...tool,
  // 分档/特性门派生需要方法映射（与 mcp/server.mjs 的启动装配一致）。
  methods: [...(TOOL_METHODS[tool.name] || [])],
}));

/** Node SDK 可见的工具名（92，顺序与 MCP tools/list 一致）。 */
export const TOOL_NAMES = Object.freeze(SCHEMA_TOOLS.map((tool) => tool.name));

/** 分页/续读参数可能出现的字段名（协议统一用 cursor）。 */
export const PAGINATION_CURSOR_PARAM = 'cursor';

function compactProperty(definition) {
  if (!definition || typeof definition !== 'object') return Object.freeze({ type: null });
  const row = {
    type: Array.isArray(definition.type) ? [...definition.type] : (definition.type || null),
    description: typeof definition.description === 'string' ? definition.description : '',
  };
  if (Array.isArray(definition.enum)) row.enum = [...definition.enum];
  if (definition.default !== undefined) row.default = definition.default;
  if (definition.minimum !== undefined) row.minimum = definition.minimum;
  if (definition.maximum !== undefined) row.maximum = definition.maximum;
  if (definition.minItems !== undefined) row.minItems = definition.minItems;
  if (definition.maxItems !== undefined) row.maxItems = definition.maxItems;
  if (definition.items) row.items = { type: definition.items.type || null };
  return Object.freeze(row);
}

/** 单工具的分页标记：结果可能被截断时必须让调用方知道“还有下一页”。 */
export function paginationOf(name) {
  const tool = SCHEMA_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return null;
  const methods = [...(TOOL_METHODS[name] || [])];
  const partialMethods = methods.filter((method) => METHOD_PARTIAL.includes(method));
  const hasCursor = Boolean(tool.inputSchema.properties && tool.inputSchema.properties[PAGINATION_CURSOR_PARAM]);
  return Object.freeze({
    partial: partialMethods.length > 0,
    methods: Object.freeze(partialMethods),
    cursorParam: hasCursor ? PAGINATION_CURSOR_PARAM : null,
    // 结果字段约定：observe/extract/network.list 都返回 cursor/truncated/partial 之一。
    resultFields: Object.freeze(partialMethods.length ? ['cursor', 'truncated', 'partial'] : []),
    resumeHint: partialMethods.length
      ? '结果可能被截断：检查 cursor/truncated 后带上 cursor 参数再调用一次（不要假设一次拿全量）。'
      : '非分页工具：结果是全量。',
  });
}

function buildSpec(tool) {
  const methods = [...(TOOL_METHODS[tool.name] || [])];
  const policy = policyFor(tool.name, tool);
  const contract = describeToolContract(tool, { toolMethods: TOOL_METHODS, contracts: TOOL_CONTRACTS });
  const properties = {};
  for (const [name, definition] of Object.entries(tool.inputSchema.properties || {})) {
    properties[name] = compactProperty(definition);
  }
  const featureGates = [...new Set(methods.map((method) => METHOD_FEATURE[method]).filter(Boolean))].sort();
  const floors = [...new Set(methods.map((method) => floorOf(method)).filter(Boolean))].sort();
  return Object.freeze({
    name: tool.name,
    title: policy.title,
    description: tool.description,
    methods: Object.freeze(methods),
    tier: policy.tier,
    approvalRequired: policy.approvalRequired,
    timeoutMs: policy.timeoutMs,
    idempotent: policy.idempotent,
    openWorld: policy.openWorld,
    annotations: annotationsFor(tool.name, tool),
    featureGates: Object.freeze(featureGates),
    minProtocol: floors.length ? floors[floors.length - 1] : null,
    required: Object.freeze([...(tool.inputSchema.required || [])]),
    properties: Object.freeze(properties),
    pagination: paginationOf(tool.name),
    contract: Object.freeze({
      localParams: Object.freeze(Object.entries(contract.params || {})
        .filter(([, value]) => value.kind === 'local')
        .map(([key]) => key)),
      unexposed: contract.unexposed,
      actions: contract.actions,
      localOnly: contract.localOnly,
    }),
    tool,
  });
}

const SPECS = new Map(SCHEMA_TOOLS.map((tool) => [tool.name, buildSpec(tool)]));

/** 全部工具目录（92 条；去掉内部 tool 引用，便于打印/序列化）。 */
export function listToolSpecs() {
  return [...SPECS.values()].map((spec) => {
    const { tool: _tool, ...rest } = spec;
    return rest;
  });
}

/** 单工具目录；未知工具返回 null。 */
export function toolSpec(name) {
  return SPECS.get(String(name || '')) || null;
}

/** 运行时入参校验（与 MCP server / SDK 共用同一个 mcp/tool-args.mjs 实现）。 */
export function validateToolInput(name, args) {
  const spec = toolSpec(name);
  if (!spec) {
    return { ok: false, errors: [{ code: 'E_ARG_UNEXPECTED', path: 'name', message: '未知工具 ' + name }] };
  }
  return validateToolArgs(spec.tool.inputSchema, args);
}

/** 严格校验：失败抛 ToolArgumentError（带 E_ARG_* code）。 */
export function assertToolInput(name, args) {
  const result = validateToolInput(name, args);
  if (!result.ok) {
    if (!toolSpec(name)) {
      const error = new Error('未知 MCP 工具：' + name);
      error.code = 'E_ARG_UNEXPECTED';
      throw error;
    }
    throw new ToolArgumentError(result.errors);
  }
  return args === undefined || args === null ? {} : args;
}

/** 工具分档统计（与 MCP tools/list 的 _meta 对齐）。 */
export function toolTierSummary() {
  const specs = [...SPECS.values()];
  return Object.freeze({
    total: specs.length,
    byTier: {
      read: specs.filter((spec) => spec.tier === 'read').length,
      mutate: specs.filter((spec) => spec.tier === 'mutate').length,
      destructive: specs.filter((spec) => spec.tier === 'destructive').length,
    },
    approvals: Object.freeze(specs.filter((spec) => spec.approvalRequired).map((spec) => spec.name)),
    paginated: Object.freeze(specs.filter((spec) => spec.pagination.partial).map((spec) => spec.name)),
  });
}

/**
 * SDK ↔ 协议契约快照：客户端做能力协商/错误分支/分页续读的唯一入口。
 * （sdk/contract.mjs 会把它与 error-codes 合并导出，见 SDK_CONTRACT。）
 */
export function toolContractSnapshot() {
  return Object.freeze({
    protocol: Object.freeze({ current: PROTOCOL_CURRENT, baseline: PROTOCOL_BASELINE }),
    methods: Object.freeze([...METHOD_NAMES]),
    tools: Object.freeze([...SPECS.keys()]),
    tiers: toolTierSummary(),
  });
}

export { ToolArgumentError };
