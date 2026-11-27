#!/usr/bin/env node
// sdk/python/gen-tool-catalog.mjs —— 生成 Python SDK 的 67 工具目录（单一来源）。
//
// 为什么需要：Python 不能 import JS，所以 Python SDK 必须有一份可离线校验/审批/分页的
// 工具目录；手抄必然漂移。这里从 sdk/tool-catalog.mjs（它本身从 mcp/tools-*.mjs 派生）
// 生成确定性的 Python 数据块，嵌进 sdk/python/browser_bridge.py 的
// `# tool-catalog:begin` / `# tool-catalog:end` 标记之间。
//
// 用法：
//   node sdk/python/gen-tool-catalog.mjs --check   # 只比对（门禁用；漂移时 exit 1）
//   node sdk/python/gen-tool-catalog.mjs --write   # 重新生成写入 browser_bridge.py
//
// 调用点：
//   - tests/unit/sdk-python-contract.test.mjs（import renderToolCatalogBlock 做漂移门禁）；
//   - Python 运行时消费 TOOL_CATALOG（参数校验/审批/超时/分页），见 browser_bridge.py。
//
// 生成物只包含数据（无逻辑），确定性输出（无时间戳），因此可以逐字节比对。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_NAMES, listToolSpecs, toolSpec } from '../tool-catalog.mjs';
import { APPROVAL_ALWAYS } from '../../mcp/tool-policy.mjs';
import { PROTOCOL_CURRENT } from '../../lib/method-catalog.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PYTHON_SDK_FILE = path.join(HERE, 'browser_bridge.py');
export const CATALOG_BEGIN = '# tool-catalog:begin';
export const CATALOG_END = '# tool-catalog:end';

/** Python 字符串字面量（单引号；转义反斜杠与单引号）。 */
function pyString(value) {
  return "'" + String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n') + "'";
}

function pyValue(value) {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return pyString(value);
  if (Array.isArray(value)) return '(' + value.map(pyValue).join(', ') + (value.length === 1 ? ',' : '') + ')';
  if (typeof value === 'object') {
    const entries = Object.entries(value).map(([key, item]) => pyString(key) + ': ' + pyValue(item));
    return '{' + entries.join(', ') + '}';
  }
  return pyString(String(value));
}

/** 单工具 schema 的精简形态：只保留运行时校验需要的字段。 */
function compactProps(schema) {
  const rows = [];
  for (const [name, definition] of Object.entries((schema && schema.properties) || {})) {
    // 协议 schema 允许“无 type 的属性”（如 debug.stop.trace 这类留待后续细化的对象/任意值）。
    // 不能默认成 string：Node 校验器/SDK 目录对 {} 用 null 表示“任意值”，Python 侧保持一致。
    const row = { type: definition.type === undefined ? null : definition.type };
    if (Array.isArray(definition.enum)) row.enum = [...definition.enum];
    if (definition.minimum !== undefined) row.minimum = definition.minimum;
    if (definition.maximum !== undefined) row.maximum = definition.maximum;
    if (definition.minLength !== undefined) row.minLength = definition.minLength;
    if (definition.maxLength !== undefined) row.maxLength = definition.maxLength;
    if (definition.minItems !== undefined) row.minItems = definition.minItems;
    if (definition.maxItems !== undefined) row.maxItems = definition.maxItems;
    if (definition.items) row.items_type = definition.items.type === undefined ? null : definition.items.type;
    rows.push([name, row]);
  }
  return rows;
}

/** 与 Python TOOL_CATALOG 结构等价的纯数据（Node 契约测试直接比对，避免解析 Python 文本）。 */
export function pythonToolCatalog() {
  return listToolSpecs().map((spec) => {
    const raw = toolSpec(spec.name).tool.inputSchema;
    return {
      name: spec.name,
      tier: spec.tier,
      approvalRequired: spec.approvalRequired,
      approvalAlways: APPROVAL_ALWAYS.includes(spec.name),
      timeoutMs: spec.timeoutMs,
      methods: [...spec.methods],
      required: [...(raw.required || [])],
      // 与 JSON Schema 同义：false 表示拒绝未声明参数（缺省 true）。
      additionalProperties: raw.additionalProperties === false ? false : true,
      props: compactProps(raw),
      pagination: spec.pagination.partial
        ? {
          partial: true,
          methods: [...spec.pagination.methods],
          cursorParam: spec.pagination.cursorParam,
          resultFields: [...spec.pagination.resultFields],
        }
        : null,
      openWorld: spec.openWorld,
      idempotent: spec.idempotent,
    };
  });
}

/** 渲染 Python 数据块（含 begin/end 标记，可直接写入文件）。 */
export function renderToolCatalogBlock() {
  const rows = pythonToolCatalog();
  const byTier = { read: 0, mutate: 0, destructive: 0 };
  for (const row of rows) byTier[row.tier] += 1;
  const lines = [];
  lines.push(CATALOG_BEGIN);
  lines.push('TOOL_CATALOG_META = {');
  lines.push("    'tool_count': " + rows.length + ',');
  lines.push("    'protocol': " + pyString(PROTOCOL_CURRENT) + ',');
  lines.push("    'tiers': " + pyValue(byTier) + ',');
  lines.push("    'order': " + pyValue(rows.map((row) => row.name)) + ',');
  lines.push('}');
  lines.push('TOOL_APPROVAL_ALWAYS = ' + pyValue([...APPROVAL_ALWAYS]));
  lines.push('TOOL_CATALOG = {');
  for (const row of rows) {
    lines.push('    ' + pyString(row.name) + ': {');
    lines.push("        'tier': " + pyString(row.tier) + ", 'approval_required': " + pyValue(row.approvalRequired)
      + ", 'approval_always': " + pyValue(row.approvalAlways) + ", 'timeout_ms': " + row.timeoutMs + ',');
    lines.push("        'methods': " + pyValue(row.methods) + ', ' + "'required': " + pyValue(row.required)
      + ", 'additional_properties': " + pyValue(row.additionalProperties) + ',');
    lines.push("        'open_world': " + pyValue(row.openWorld) + ", 'idempotent': " + pyValue(row.idempotent) + ',');
    if (row.props.length) {
      lines.push("        'props': (");
      for (const [name, definition] of row.props) lines.push('            (' + pyString(name) + ', ' + pyValue(definition) + '),');
      lines.push('        ),');
    } else {
      lines.push("        'props': (),");
    }
    if (row.pagination) {
      lines.push("        'pagination': {");
      lines.push("            'partial': True,");
      lines.push("            'methods': " + pyValue(row.pagination.methods) + ',');
      lines.push("            'cursor_param': " + pyValue(row.pagination.cursorParam) + ',');
      lines.push("            'result_fields': " + pyValue(row.pagination.resultFields) + ',');
      lines.push('        },');
    } else {
      lines.push("        'pagination': None,");
    }
    lines.push('    },');
  }
  lines.push('}');
  lines.push(CATALOG_END);
  return lines.join('\n');
}

/** 用新生成块替换源码里的 begin/end 之间内容；缺少标记时报错（防止静默追加）。 */
export function applyToolCatalog(source) {
  const start = source.indexOf(CATALOG_BEGIN);
  const stop = source.indexOf(CATALOG_END);
  if (start < 0 || stop <= start) throw new Error('browser_bridge.py 缺少 ' + CATALOG_BEGIN + ' / ' + CATALOG_END + ' 标记');
  const before = source.slice(0, start);
  const after = source.slice(stop + CATALOG_END.length);
  return before + renderToolCatalogBlock() + after;
}

/** 只读校验：文件里的块是否与生成结果逐字节一致。 */
export function checkToolCatalog(file = PYTHON_SDK_FILE) {
  const source = fs.readFileSync(file, 'utf8');
  const expected = renderToolCatalogBlock();
  const start = source.indexOf(CATALOG_BEGIN);
  const stop = source.indexOf(CATALOG_END);
  if (start < 0 || stop <= start) return { ok: false, reason: 'missing-markers', file };
  const actual = source.slice(start, stop + CATALOG_END.length);
  if (actual !== expected) {
    const actualLines = actual.split('\n');
    const expectedLines = expected.split('\n');
    let firstDiff = 0;
    while (firstDiff < actualLines.length && firstDiff < expectedLines.length && actualLines[firstDiff] === expectedLines[firstDiff]) firstDiff += 1;
    return {
      ok: false,
      reason: 'drift',
      file,
      line: firstDiff + 1,
      expected: expectedLines[firstDiff] || '<end>',
      actual: actualLines[firstDiff] || '<end>',
    };
  }
  return { ok: true, file, tools: pythonToolCatalog().length };
}

/** 写入生成块；返回写入的工具数。 */
export function writeToolCatalog(file = PYTHON_SDK_FILE) {
  const source = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, applyToolCatalog(source), 'utf8');
  return pythonToolCatalog().length;
}

const IS_MAIN = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) {
  const args = process.argv.slice(2);
  if (args.includes('--write')) {
    const count = writeToolCatalog();
    console.log('tool catalog: wrote ' + count + ' tools → ' + path.relative(process.cwd(), PYTHON_SDK_FILE));
  } else if (args.includes('--check')) {
    const result = checkToolCatalog();
    if (!result.ok) {
      console.error('tool catalog drift: ' + result.reason + ' @ ' + (result.line ? 'line ' + result.line : 'file'));
      if (result.reason === 'drift') {
        console.error('  expected: ' + result.expected);
        console.error('  actual:   ' + result.actual);
      }
      process.exit(1);
    }
    console.log('tool catalog: clean (' + result.tools + ' tools)');
  } else {
    console.error('用法：node sdk/python/gen-tool-catalog.mjs --check|--write');
    process.exit(2);
  }
}

export { TOOL_NAMES };
