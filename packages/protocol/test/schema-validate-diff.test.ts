// packages/protocol/test/schema-validate-diff.test.ts —— 参数校验器 JS ↔ TS 差分测试。
//
// 口径：同一份 lib/schemas.mjs schema，validateMethodParams / validateSchema 对同一输入的
// 错误列表必须逐字符相等（顺序也一致，因为 daemon 会把它们直接拼进 E_BAD_ARG）。
//
// 覆盖边界：137 个方法 × 空参数/信封参数、必填缺失、类型错误、数值/长度/枚举边界、嵌套数组
// （plan/upload/refs.negotiate）、pattern（transferId）、未知方法（通用信封）、非对象参数、
// 以及 validateSchema 直接吃原始 schema 的矩阵（含未知关键字忽略行为）。

import test from 'node:test';
import assert from 'node:assert/strict';

import * as ts from '../src/index.ts';
import type { JsonSchema } from '../src/index.ts';

const js: any = await import('../../../lib/schemas.mjs');

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 断言 TS 与 JS 的错误列表逐字符相等（顺序敏感）。 */
function assertSameErrors(label: string, actual: readonly string[], expected: readonly string[]): void {
  assert.deepEqual(clone(actual), clone(expected), label + ' 的校验错误不一致');
}

const METHOD_NAMES = Object.keys(ts.METHOD_SCHEMAS) as (keyof typeof ts.METHOD_SCHEMAS)[];

/** 每种方法的合法参数样例（覆盖 required + 嵌套结构）。 */
const VALID_CASES: readonly { label: string; params: Record<string, unknown> }[] = [
  { label: 'observe 全字段', params: {
    session: 's1', sessionId: 's1', tabId: 1, probeHover: true, debugSurfaces: false, vom: true,
    vomProfile: 'compact', vomPerGroup: 4, vomTop: 10, vomMinScore: -5, vomMaxNodes: 100,
    vomMaxTokens: 2000, maxTokens: 500, maxDepth: 4, cursor: 'c1', force: true, delta: true,
  } },
  { label: 'navigate', params: { url: 'https://example.test/', tabId: 0 } },
  { label: 'click', params: { ref: 'e1', waitTimeoutMs: 0, trusted: true } },
  { label: 'fill', params: { selector: '#a', value: '', noClear: true } },
  { label: 'press', params: { key: 'Enter' } },
  { label: 'plan', params: { steps: [{ method: 'click', params: { ref: 'e1' } }, { method: 'wait-ms', params: { ms: 10 } }] } },
  { label: 'screenshot', params: { scope: 'full', fullPage: true, gridStep: 50, region: { x: 0, y: 0, width: 10, height: 10 } } },
  { label: 'transfer.chunk', params: { transferId: 'tr_0123456789abcdef', offset: 0, dataBase64: 'AA==' } },
  { label: 'upload', params: { target: 'input[type=file]', files: ['C:\\a.txt'] } },
  { label: 'pdf margins', params: { margins: { top: 1, right: 2, bottom: 3, left: 4 }, paperWidth: 8.5, scale: 1 } },
  { label: 'refs.negotiate', params: { stableRefs: ['r1'] } },
  { label: 'evaluate', params: { expression: '1+1', unverified: true } },
  { label: 'webmcp.call', params: { name: 'tool', input: { a: 1 } } },
  { label: 'tab.new', params: { url: 'about:blank', newWindow: true, incognito: false } },
  { label: 'network.list', params: { since: 0, limit: 1, filter: { url: 'x' } } },
];

/** 非法参数矩阵（必填、类型、范围、长度、枚举、嵌套）。 */
const INVALID_CASES: readonly { label: string; method: string; params: unknown }[] = [
  { label: 'navigate 缺 url', method: 'navigate', params: {} },
  { label: 'navigate url 空串', method: 'navigate', params: { url: '' } },
  { label: 'navigate url 类型', method: 'navigate', params: { url: 42 } },
  { label: 'navigate url 超长', method: 'navigate', params: { url: 'x'.repeat(8193) } },
  { label: 'wait-ms 缺 ms', method: 'wait-ms', params: {} },
  { label: 'wait-ms ms 负数', method: 'wait-ms', params: { ms: -1 } },
  { label: 'wait-ms ms 非整数', method: 'wait-ms', params: { ms: 1.5 } },
  { label: 'fill 缺 value', method: 'fill', params: {} },
  { label: 'fill noClear 类型', method: 'fill', params: { value: 'x', noClear: 'yes' } },
  { label: 'press 缺 key', method: 'press', params: {} },
  { label: 'observe 范围', method: 'observe', params: { vomTop: 0 } },
  { label: 'observe 上限', method: 'observe', params: { vomTop: 501, vomMaxNodes: 5001, vomMaxTokens: 200001 } },
  { label: 'observe 类型', method: 'observe', params: { probeHover: 'true', vomPerGroup: 0, cursor: '' } },
  { label: 'read 信封类型', method: 'read', params: { tabId: -1, session: 42 } },
  { label: 'transferId pattern', method: 'transfer.chunk', params: { transferId: 'bad', offset: 0, dataBase64: 'x' } },
  { label: 'transfer offset 负数', method: 'transfer.chunk', params: { transferId: 'tr_0123456789abcdef', offset: -1, dataBase64: 'x' } },
  { label: 'transfer dataBase64 空', method: 'transfer.chunk', params: { transferId: 'tr_0123456789abcdef', offset: 0, dataBase64: '' } },
  { label: 'plan steps 非数组', method: 'plan', params: { steps: {} } },
  { label: 'plan steps 空数组', method: 'plan', params: { steps: [] } },
  { label: 'plan steps 51 项', method: 'plan', params: { steps: Array.from({ length: 51 }, () => ({ method: 'click' })) } },
  { label: 'plan step 缺 method', method: 'plan', params: { steps: [{ params: {} }] } },
  { label: 'plan step method 类型', method: 'plan', params: { steps: [{ method: 42 }] } },
  { label: 'pdf 数值范围', method: 'pdf', params: { paperWidth: 0, paperHeight: 200, scale: 3 } },
  { label: 'screenshot region', method: 'screenshot', params: { region: { x: 0 } } },
  { label: 'screenshot gridStep 范围', method: 'screenshot', params: { gridStep: 5, scale: 9, tileSize: 100 } },
  { label: 'refs.negotiate 超上限', method: 'refs.negotiate', params: { stableRefs: Array.from({ length: 51 }, () => 'r') } },
  { label: 'evaluate 表达式超长', method: 'evaluate', params: { expression: 'x'.repeat(200001) } },
  { label: 'webmcp.call 缺 name', method: 'webmcp.call', params: {} },
  { label: 'webmcp.call input 类型', method: 'webmcp.call', params: { name: 't', input: 'x' } },
  { label: 'pdf margins 非对象', method: 'pdf', params: { margins: 'x' } },
  { label: 'params 为 null', method: 'click', params: null },
  { label: 'params 为数组', method: 'click', params: [1, 2] },
  { label: 'params 为字符串', method: 'click', params: 'x' },
  { label: '未知字段被忽略', method: 'click', params: { ref: 'e1', unknownField: 'x', tabId: 3 } },
];

/** 原始 schema 矩阵（validateSchema 直接吃 schema；含 validator 不解释的关键字）。 */
const SCHEMA_CASES: readonly { label: string; schema: unknown; value: unknown }[] = [
  { label: 'null schema', schema: null, value: 'x' },
  { label: '空 schema', schema: {}, value: 'x' },
  { label: 'string 类型', schema: { type: 'string' }, value: 'x' },
  { label: 'string 类型不符', schema: { type: 'string' }, value: 1 },
  { label: 'integer 1.5', schema: { type: 'integer' }, value: 1.5 },
  { label: 'number NaN', schema: { type: 'number' }, value: NaN },
  { label: 'boolean', schema: { type: 'boolean' }, value: 0 },
  { label: 'array 长度', schema: { type: 'array', minItems: 2, maxItems: 3 }, value: [1] },
  { label: 'array items', schema: { type: 'array', items: { type: 'string', minLength: 2 } }, value: ['a', 'bc'] },
  { label: 'array 非数组', schema: { type: 'array' }, value: 'x' },
  { label: 'object 必填', schema: { type: 'object', required: ['a'] }, value: {} },
  { label: 'object 嵌套路径', schema: { type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'integer', minimum: 1 } } } } }, value: { a: { b: 0 } } },
  { label: 'pattern 命中', schema: { type: 'string', pattern: '^a+$' }, value: 'aaa' },
  { label: 'pattern 未命中', schema: { type: 'string', pattern: '^a+$' }, value: 'b' },
  { label: 'enum 不解释', schema: { type: 'string', enum: ['a'] }, value: 'b' },
  { label: 'additionalProperties 不解释', schema: { type: 'object', properties: {}, additionalProperties: false }, value: { extra: 1 } },
  { label: 'null 类型', schema: { type: 'null' }, value: null },
  { label: 'root 不是 object', schema: { type: 'object' }, value: [] },
  { label: 'maxLength', schema: { type: 'string', maxLength: 2 }, value: 'abc' },
  { label: 'maximum', schema: { type: 'number', maximum: 1 }, value: 2 },
];

test('137 个方法 × 空参数与信封参数：错误列表逐字符相等', () => {
  const PARAMS = [{}, { session: 's' }, { sessionId: '' }, { tabId: 1 }, { tabId: -1 }, { session: 42 }];
  for (const method of METHOD_NAMES) {
    for (const params of PARAMS) {
      const label = method + ' / ' + JSON.stringify(params);
      assertSameErrors(
        label,
        ts.validateMethodParams(method, params),
        js.validateMethodParams(method, params),
      );
    }
  }
});

test('合法参数样例：TS 与 JS 都通过（空错误列表）', () => {
  for (const { label, params } of VALID_CASES) {
    const method = label.split(' ')[0] as string;
    const actual = ts.validateMethodParams(method, params);
    assertSameErrors(label, actual, js.validateMethodParams(method, params));
    assert.deepEqual(clone(actual), [], label + ' 的合法参数被误判为错误');
  }
});

test('非法参数矩阵：必填/类型/范围/长度/枚举/嵌套逐字符相等', () => {
  // 这几个用例按基线语义会被归一成空对象/未知字段被忽略，因此不要求产生错误。
  const QUIET = new Set(['未知字段被忽略', 'params 为 null', 'params 为字符串']);
  for (const { label, method, params } of INVALID_CASES) {
    const actual = ts.validateMethodParams(method, params);
    const expected = js.validateMethodParams(method, params);
    assertSameErrors(label, actual, expected);
    if (!QUIET.has(label)) assert.ok(actual.length > 0, label + ' 应产生校验错误');
  }
});

test('未知方法走通用信封 schema（与 JS 一致）', () => {
  const unknownMethods: readonly unknown[] = ['no.such.method', '', null, undefined, 42, {}, ['x']];
  const PARAMS = [{}, { session: '' }, { sessionId: 'x', tabId: 2 }, { tabId: 'x' }, { session: null }, null, []];
  for (const method of unknownMethods) {
    for (const params of PARAMS) {
      assertSameErrors(
        'method=' + String(method) + ' / ' + JSON.stringify(params),
        ts.validateMethodParams(method, params),
        js.validateMethodParams(method, params),
      );
    }
  }
  assert.deepEqual(clone(ts.validateMethodParams('no.such.method', { session: '' })), ['params.session 长度至少 1']);
  assert.deepEqual(clone(ts.validateMethodParams('no.such.method', { tabId: 1.5 })), ['params.tabId 应为 integer']);
});

test('validateSchema：原始 schema 矩阵逐字符相等', () => {
  for (const { label, schema, value } of SCHEMA_CASES) {
    assertSameErrors(
      label,
      ts.validateSchema(schema as JsonSchema, value),
      js.validateSchema(schema, value),
    );
  }
});

test('validateSchema：自定义 path 与嵌套错误路径格式一致', () => {
  const schema = {
    type: 'object',
    required: ['a'],
    properties: {
      a: { type: 'array', minItems: 1, items: { type: 'object', properties: { b: { type: 'string', minLength: 3 } } } },
    },
  };
  const value = { a: [{ b: 'x' }, { b: 2 }] };
  for (const path of ['params', 'call.params', '']) {
    assertSameErrors(
      'path=' + path,
      ts.validateSchema(schema as JsonSchema, value, path),
      js.validateSchema(schema, value, path),
    );
  }
  assert.deepEqual(clone(ts.validateSchema(schema as JsonSchema, {}, 'root')), ['root.a 缺失']);
});

test('校验器只解释文档化的关键字（未知关键字不产生错误）', () => {
  const schema = {
    type: 'object',
    properties: { a: { type: 'string', enum: ['x'], additionalProperties: true } },
    additionalProperties: false,
  };
  assert.deepEqual(clone(ts.validateSchema(schema as JsonSchema, { a: 'y', extra: 1 })), []);
  assertSameErrors(
    '未知关键字',
    ts.validateSchema(schema as JsonSchema, { a: 'y', extra: 1 }),
    js.validateSchema(schema, { a: 'y', extra: 1 }),
  );
});

test('upload schema 被后续 Object.assign 覆盖为宽松形态（与 JS 基线一致）', () => {
  // lib/schemas.mjs 先在 METHOD_SCHEMAS 里写了 upload 的严格 schema（required target/files），
  // 随后又被 withTarget({files, paths}) 覆盖，因此运行期不强制 files 非空；这里固化该差异，
  // 一旦有人只改生成端/TS 端就会失败。
  const uploadSchema = clone(ts.METHOD_SCHEMAS.upload);
  assert.equal(uploadSchema.required, undefined, 'upload 运行期 schema 无 required（基线覆盖结果）');
  assert.deepEqual(clone(uploadSchema.properties?.files), { type: 'array' });
  assert.equal(uploadSchema.properties?.target?.minLength, undefined, 'upload.target 运行期无长度约束');
  const cases: readonly Record<string, unknown>[] = [{}, { target: 'a', files: [] }, { target: 'a', files: ['f'.repeat(5000)] }];
  for (const params of cases) {
    const actual = ts.validateMethodParams('upload', params);
    assertSameErrors('upload ' + JSON.stringify(params), actual, js.validateMethodParams('upload', params));
    assert.deepEqual(clone(actual), []);
  }
  assert.deepEqual(clone(ts.METHOD_SCHEMAS.upload), clone(js.METHOD_SCHEMAS.upload));
});

test('enum 关键字不参与校验（与 JS 基线一致，枚举只能在生成端/业务端约束）', () => {
  const enumCases: readonly { method: string; params: Record<string, unknown> }[] = [
    { method: 'observe', params: { vomProfile: 'huge', vomBillingModel: 'nope' } },
    { method: 'session.control_mode', params: { mode: 'shared' } },
    { method: 'screenshot', params: { scope: 'mega' } },
    { method: 'video.start', params: { encoder: 'vp9' } },
  ];
  for (const { method, params } of enumCases) {
    const actual = ts.validateMethodParams(method, params);
    assertSameErrors(method + ' 枚举', actual, js.validateMethodParams(method, params));
    assert.deepEqual(clone(actual), [], method + ' 的 enum 不应产生校验错误（基线行为）');
  }
  assert.deepEqual(clone(ts.METHOD_SCHEMAS.observe.properties?.vomProfile?.enum), ['balanced', 'compact', 'all']);
});

test('生成物里的 schema 与 JS 单源在同一方法上逐字段一致（抽查结构差异）', () => {
  for (const method of ['observe', 'navigate', 'plan', 'transfer.chunk', 'pdf', 'upload', 'screenshot', 'network.rule_add']) {
    assert.deepEqual(
      clone(ts.METHOD_SCHEMAS[method as keyof typeof ts.METHOD_SCHEMAS]),
      clone(js.METHOD_SCHEMAS[method]),
      method + ' schema 不一致',
    );
  }
});
