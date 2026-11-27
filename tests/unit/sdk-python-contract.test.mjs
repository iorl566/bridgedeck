// tests/unit/sdk-python-contract.test.mjs —— Python SDK ↔ Node SDK ↔ 协议单源的契约对齐。
//
// Python 不能 import JS，所以 Python SDK 用带标记的 begin/end 区块内嵌契约表；
// 本测试解析这些区块，与 lib/method-catalog.mjs、lib/error-codes.mjs、Node SDK 逐项比对。
// 只改 Python 一侧而忘记同步（或反之）都会失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERROR_CODE_LIST, ERROR_CODES, ERROR_RECOVERY } from '../../lib/error-codes.mjs';
import {
  FEATURE_FLOORS,
  METHOD_FEATURE,
  METHOD_PARTIAL,
  PROTOCOL_BASELINE,
  PROTOCOL_CURRENT,
} from '../../lib/method-catalog.mjs';
import { TOOL_PAGINATION } from '../../sdk/index.mjs';
import { listToolSpecs } from '../../sdk/tool-catalog.mjs';
import { TOOLS } from '../../mcp/server.mjs';
import { policyFor } from '../../mcp/tool-policy.mjs';
import {
  CATALOG_BEGIN,
  CATALOG_END,
  checkToolCatalog,
  pythonToolCatalog,
  renderToolCatalogBlock,
} from '../../sdk/python/gen-tool-catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PY = fs.readFileSync(path.join(ROOT, 'sdk', 'python', 'browser_bridge.py'), 'utf8');

function normalizeType(type) {
  // “无 type”（协议 schema 用 {} 表示任意值）在 Node SDK 目录里是 null、原始 schema 里是
  // undefined；两侧都归一成 null 再比较，语义一致（Python 目录显式写 null）。
  if (type === undefined || type === null) return null;
  return Array.isArray(type) ? [...type] : type;
}

function block(begin, end) {
  const start = PY.indexOf(begin);
  const stop = PY.indexOf(end);
  assert.ok(start >= 0 && stop > start, 'Python SDK 缺少标记块 ' + begin + ' … ' + end);
  return PY.slice(start + begin.length, stop);
}

function parseStringDict(text) {
  const out = {};
  for (const match of text.matchAll(/'([^']+)':\s*'([^']*)'/g)) out[match[1]] = match[2];
  return out;
}

function parseFrozenset(text) {
  return [...text.matchAll(/'([^']+)'/g)].map((match) => match[1]).sort();
}

function parsePaginatedTools(text) {
  const out = {};
  for (const match of text.matchAll(/'([^']+)':\s*\(([^)]*)\)/g)) {
    out[match[1]] = [...match[2].matchAll(/'([^']+)'/g)].map((row) => row[1]).sort();
  }
  return out;
}

function parseRecovery(text) {
  const out = {};
  for (const match of text.matchAll(/'([^']+)':\s*\('([^']+)',\s*"([^"]*)"\)/g)) {
    out[match[1]] = { retry: match[2], hint: match[3] };
  }
  return out;
}

test('Python FEATURE_FLOORS 与协议单源一致', () => {
  const floors = parseStringDict(block('# feature-floors:begin', '# feature-floors:end'));
  assert.deepEqual(floors, { ...FEATURE_FLOORS });
  assert.equal(Object.keys(floors).length, Object.keys(FEATURE_FLOORS).length);
});

test('Python METHOD_FEATURE 与协议单源一致', () => {
  const features = parseStringDict(block('# method-features:begin', '# method-features:end'));
  assert.deepEqual(features, { ...METHOD_FEATURE });
  assert.equal(Object.keys(features).length, Object.keys(METHOD_FEATURE).length);
});

test('Python PARTIAL_METHODS 与协议单源一致', () => {
  const partial = parseFrozenset(block('# partial-methods:begin', '# partial-methods:end'));
  assert.deepEqual(partial, [...METHOD_PARTIAL].sort());
  assert.ok(partial.includes('observe'));
  assert.ok(partial.includes('network.waterfall'));
});

test('Python PAGINATED_TOOLS 与 Node SDK 分页标记一致', () => {
  const pythonTools = parsePaginatedTools(block('# paginated-tools:begin', '# paginated-tools:end'));
  const nodeTools = Object.fromEntries(Object.entries(TOOL_PAGINATION)
    .filter(([, pagination]) => pagination.partial)
    .map(([name, pagination]) => [name, [...pagination.methods].sort()]));
  assert.deepEqual(pythonTools, nodeTools);
  assert.ok(Object.keys(pythonTools).length >= 6);
});

test('Python RECOVERY_HINTS 与 lib 的 ERROR_RECOVERY 一致', () => {
  const hints = parseRecovery(block('# recovery-hints:begin', '# recovery-hints:end'));
  assert.ok(Object.keys(hints).length >= 10);
  for (const [code, advice] of Object.entries(hints)) {
    assert.ok(ERROR_CODES[code], '未登记错误码：' + code);
    const expected = ERROR_RECOVERY[code] || { retry: 'no', hint: '' };
    assert.deepEqual(advice, { retry: expected.retry, hint: expected.hint }, code);
  }
  assert.ok(hints.E_STALE_REF && hints.E_STALE_REF.hint.includes('observe'));
});

test('Python 错误码清单覆盖协议全量错误码', () => {
  const missing = ERROR_CODE_LIST.filter((code) => !PY.includes("'" + code + "'"));
  assert.deepEqual(missing, []);
  assert.ok(ERROR_CODE_LIST.length >= 150);
});

test('Python 协议版本常量与 SDK 能力门禁入口存在', () => {
  assert.equal(PROTOCOL_CURRENT, '1.9');
  assert.equal(PROTOCOL_BASELINE, '1.8');
  assert.ok(PY.includes("PROTOCOL_CURRENT = '1.9'"));
  assert.ok(PY.includes("PROTOCOL_BASELINE = '1.8'"));
  for (const token of ['def protocol_gate', 'def next_page_params', 'def method_floor', 'def required_floor', 'def is_partial', 'def recovery_advice', 'def normalize_error_code', 'enforce_features', 'effect_state']) {
    assert.ok(PY.includes(token), 'Python SDK 缺少 ' + token);
  }
});

test('Python BridgeError 暴露结构化错误 data', () => {
  const bridgeError = PY.slice(PY.indexOf('class BridgeError'), PY.indexOf('def default_home'));
  assert.ok(bridgeError.includes('self.data = data'));
  assert.ok(bridgeError.includes('self.effect_state'));
  assert.ok(bridgeError.includes('def to_dict'));
  assert.ok(bridgeError.includes('recovery_advice'));
});

// ---------------------------------------------------------------------------
// W5-A 第 3/4 项：Python 工具级目录（92 工具）与 Node SDK / MCP 注册表三方一致
// ---------------------------------------------------------------------------

test('Python 工具目录块由生成器产出且无漂移（逐字节）', () => {
  const check = checkToolCatalog(path.join(ROOT, 'sdk', 'python', 'browser_bridge.py'));
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.equal(check.tools, 92);
  const rendered = renderToolCatalogBlock();
  assert.ok(rendered.startsWith(CATALOG_BEGIN));
  assert.ok(rendered.endsWith(CATALOG_END));
  const body = rendered.slice(CATALOG_BEGIN.length, rendered.length - CATALOG_END.length).trim();
  assert.equal(block(CATALOG_BEGIN, CATALOG_END).trim(), body);
  assert.ok(PY.includes('TOOL_CATALOG_META'));
  assert.ok(PY.includes('browser_observe'));
});

test('Python 工具目录与 Node SDK 92 工具逐项一致（分档/方法/必填/超时/审批/分页）', () => {
  const python = pythonToolCatalog();
  const node = listToolSpecs();
  assert.equal(python.length, 92);
  assert.deepEqual(python.map((row) => row.name), node.map((spec) => spec.name));
  for (const [index, row] of python.entries()) {
    const spec = node[index];
    assert.equal(row.tier, spec.tier, row.name + '.tier');
    assert.deepEqual(row.methods, [...spec.methods], row.name + '.methods');
    assert.deepEqual(row.required, [...spec.required], row.name + '.required');
    assert.equal(row.timeoutMs, spec.timeoutMs, row.name + '.timeoutMs');
    assert.equal(row.approvalRequired, spec.approvalRequired, row.name + '.approvalRequired');
    assert.equal(row.openWorld, spec.openWorld, row.name + '.openWorld');
    assert.equal(row.idempotent, spec.idempotent, row.name + '.idempotent');
    assert.deepEqual(row.props.map(([name]) => name), Object.keys(spec.properties), row.name + '.props');
    for (const [propName, definition] of row.props) {
      const expected = spec.properties[propName];
      assert.deepEqual(normalizeType(definition.type), normalizeType(expected.type), row.name + '.' + propName + '.type');
      assert.deepEqual(definition.enum, expected.enum, row.name + '.' + propName + '.enum');
      assert.equal(definition.minimum, expected.minimum, row.name + '.' + propName + '.minimum');
      assert.equal(definition.maximum, expected.maximum, row.name + '.' + propName + '.maximum');
      assert.equal(definition.minItems, expected.minItems, row.name + '.' + propName + '.minItems');
      assert.equal(definition.maxItems, expected.maxItems, row.name + '.' + propName + '.maxItems');
    }
    if (spec.pagination.partial) {
      assert.ok(row.pagination, row.name + '.pagination');
      assert.deepEqual(row.pagination.methods, [...spec.pagination.methods], row.name + '.pagination.methods');
      assert.equal(row.pagination.cursorParam, spec.pagination.cursorParam, row.name + '.pagination.cursor');
      assert.deepEqual(row.pagination.resultFields, [...spec.pagination.resultFields]);
    } else {
      assert.equal(row.pagination, null, row.name + '.pagination');
    }
  }
});

test('Python 工具目录与 MCP 注册表一致（schema/策略超时/审批）', () => {
  const python = pythonToolCatalog();
  assert.equal(TOOLS.length, 92);
  assert.deepEqual(python.map((row) => row.name), TOOLS.map((tool) => tool.name));
  for (const [index, row] of python.entries()) {
    const tool = TOOLS[index];
    const schema = tool.inputSchema;
    assert.equal(row.name, tool.name);
    assert.deepEqual(row.required, [...(schema.required || [])], row.name + '.required');
    assert.equal(row.additionalProperties, schema.additionalProperties === false ? false : true, row.name + '.additionalProperties');
    assert.deepEqual(row.props.map(([name]) => name), Object.keys(schema.properties || {}), row.name + '.props');
    for (const [propName, definition] of Object.entries(schema.properties || {})) {
      const pythonProp = row.props.find(([name]) => name === propName)[1];
      assert.deepEqual(normalizeType(pythonProp.type), normalizeType(definition.type), row.name + '.' + propName + '.type');
      assert.deepEqual(pythonProp.enum, definition.enum, row.name + '.' + propName + '.enum');
    }
    const policy = policyFor(tool.name, tool);
    assert.equal(row.tier, policy.tier, row.name + '.tier');
    assert.equal(row.timeoutMs, policy.timeoutMs, row.name + '.timeoutMs');
    assert.equal(row.approvalRequired, policy.approvalRequired, row.name + '.approvalRequired');
    assert.equal(row.approvalAlways, ['browser_update'].includes(row.name), row.name + '.approvalAlways');
  }
});

test('Python 工具级调用面 API 入口存在（call_tool/分页/校验/MCP 客户端）', () => {
  for (const token of [
    'class McpToolClient',
    'class StdioMcpTransport',
    'class ToolArgumentError',
    'class ToolCallError',
    'def call_tool',
    'def call_tool_paged',
    'def validate_tool_args',
    'def assert_tool_args',
    'def list_tools',
    'def tool_tier_summary',
    'def read_resource',
    'def get_prompt',
    'MCP_SERVER_PATH',
    'TOOL_CATALOG_META',
    'TOOL_APPROVAL_ALWAYS',
  ]) {
    assert.ok(PY.includes(token), 'Python SDK 缺少 ' + token);
  }
  // 参数错误码必须与 MCP/Node 同名
  for (const code of ['E_ARG_MISSING', 'E_ARG_TYPE', 'E_ARG_ENUM', 'E_ARG_RANGE', 'E_ARG_UNEXPECTED']) {
    assert.ok(PY.includes(code), 'Python SDK 缺少参数错误码 ' + code);
  }
});

test('Python 生成器包含 92 工具且目录顺序稳定', () => {
  const catalog = pythonToolCatalog();
  assert.equal(catalog.length, 92);
  assert.equal(new Set(catalog.map((row) => row.name)).size, 92);
  assert.deepEqual(catalog.map((row) => row.tier).filter((tier) => tier === 'read').length, 36);
  assert.deepEqual(catalog.filter((row) => row.pagination).map((row) => row.name), [
    'browser_brief',
    'browser_observe',
    'browser_extract',
    'browser_screenshot',
    'browser_longshot_recover',
    'browser_network_waterfall',
    'browser_network_list',
    'browser_console',
  ]);
});
