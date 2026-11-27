import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FEATURE_FLOORS,
  FEATURE_NAMES,
  METHOD_CATALOG,
  METHOD_COUNT,
  METHOD_FEATURE,
  METHOD_FEATURE_FLOOR,
  METHOD_PARTIAL,
  METHOD_STATE,
  METHOD_UNKNOWN,
  PROTOCOL_BASELINE,
  PROTOCOL_CURRENT,
  describeMethod,
  methodStateOf,
} from '../../lib/method-catalog.mjs';
import {
  auditSingleSource,
  collectSingleSourceInputs,
  parseDocsIndex,
} from '../../tools/protocol-single-source.mjs';
import { TOOLS } from '../../mcp/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('单一目录：165 个 canonical 方法、15 个 feature floor、五维状态齐全', () => {
  assert.equal(METHOD_COUNT, 165);
  assert.equal(METHOD_CATALOG.length, 165);
  assert.equal(new Set(METHOD_CATALOG.map((row) => row.method)).size, 165);
  const owners = new Set(METHOD_CATALOG.map((row) => row.owner));
  for (const row of METHOD_CATALOG) assert.ok(owners.has(row.owner), row.method + ' owner 缺失');
  assert.deepEqual([...owners].sort(), ['instance', 'local', 'session']);
  assert.equal(Object.keys(FEATURE_FLOORS).length, 15);
  for (const [feature, version] of Object.entries(FEATURE_FLOORS)) assert.equal(version, '1.9', feature);
  assert.deepEqual([...FEATURE_NAMES].sort(), Object.keys(FEATURE_FLOORS).sort());
  for (const [method, feature] of Object.entries(METHOD_FEATURE)) {
    assert.equal(METHOD_FEATURE_FLOOR[method], FEATURE_FLOORS[feature], method);
  }
  assert.equal(Object.keys(METHOD_STATE).length, 165);
  assert.equal(METHOD_PARTIAL.length, 12);
  assert.equal(METHOD_UNKNOWN.length, 75);
  assert.equal(PROTOCOL_BASELINE, '1.8');
  assert.equal(PROTOCOL_CURRENT, '1.9');
  // catalog 解释入口与旧字段兼容（包括新增五维）
  assert.equal(describeMethod('click').receipt, true);
  assert.equal(describeMethod('click').owner, 'session');
  assert.equal(describeMethod('read').floor, '1.9');
  assert.equal(describeMethod('cooperate.sync').feature, 'cooperation');
  assert.equal(describeMethod('video.start').partial, false);
  assert.equal(describeMethod('video.start').unknown, true);
  assert.equal(describeMethod('video.start').floor, '1.9');
  assert.equal(methodStateOf('video.start').reconcile.method, 'video.status');
});

test('真实仓库审计通过：catalog 与手工表/生成物/文档/MCP 映射/schema/兼容矩阵/运行时派生一致', async () => {
  const inputs = await collectSingleSourceInputs();
  const report = auditSingleSource(inputs);
  assert.deepEqual(report.differences, [], JSON.stringify(report.differences.slice(0, 5)));
  assert.equal(report.ok, true);
  assert.equal(report.counts.methods, 165);
  assert.equal(report.counts.floors, 15);
  assert.equal(report.counts.gatedMethods, 29);
  assert.equal(report.counts.mcpTools, TOOLS.length);
  assert.equal(report.counts.states, 165);
  assert.equal(report.counts.partial, 12);
  assert.equal(report.counts.unknown, 75);
  assert.equal(report.counts.schemaKeys, 155);
  assert.equal(report.counts.paramAliases, 155);
  assert.deepEqual(report.counts.runtimeMethodLiterals, { protocol: 0, methods: 1 });
  assert.equal(parseDocsIndex('| `click` | mutation | session |').length, 1);
  // 每个审计段都必须真实执行（空 inputs 不产生段，防止“跳过即通过”）。
  const names = report.checks.map((check) => check.name);
  for (const name of ['catalog', 'effect', 'owner', 'mutating', 'feature-floor', 'state', 'schema', 'generated', 'schema-generated', 'docs', 'mcp', 'compat', 'runtime']) {
    assert.ok(names.includes(name), '缺少审计段 ' + name);
  }
  assert.equal(report.checks.every((check) => check.ok), true);
  // runtime 段确有内容：源码快照/预算/派生值/冻结标志都进了输入。
  assert.equal(typeof inputs.runtime.sources.protocol, 'string');
  assert.equal(typeof inputs.runtime.sources.methods, 'string');
  assert.equal(typeof inputs.runtime.sources.catalog, 'string');
  assert.equal(inputs.runtime.frozen.methodEffect, true);
  assert.equal(inputs.runtime.methodCount, 165);
  assert.deepEqual(report.differences.filter((item) => item.scope.startsWith('runtime')), []);
});

test('审计 CLI --json：可运行、退出码 0、报告 165/15/29 + 状态/schema/运行时计数', () => {
  const result = spawnSync(process.execPath, ['tools/protocol-single-source.mjs', '--json'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, String(result.stderr || ''));
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.counts.methods, 165);
  assert.equal(report.counts.floors, 15);
  assert.equal(report.counts.mcpTools, TOOLS.length);
  assert.equal(report.counts.states, 165);
  assert.equal(report.counts.gatedMethods, 29);
  assert.equal(report.counts.schemaKeys, 155);
  assert.equal(report.counts.paramAliases, 155);
  assert.deepEqual(report.counts.runtimeMethodLiterals, { protocol: 0, methods: 1 });
  assert.equal(report.differences.length, 0);
  const runtimeCheck = report.checks.find((check) => check.name === 'runtime');
  assert.ok(runtimeCheck, 'CLI 报告缺少 runtime 段');
  assert.equal(runtimeCheck.ok, true);
});

test('负例：故意构造不一致时审计 fail（临时对象，不改真实文件）', async (t) => {
  const inputs = await collectSingleSourceInputs();
  const cases = [
    { name: 'effect 被改坏', scope: 'effect', method: 'click', mutate: (x) => { x.legacy.effects.click = 'passive_read'; } },
    { name: 'owner 被挪动', scope: 'owner.session', method: 'tab.close', mutate: (x) => { x.legacy.owners.instance.delete('tab.close'); x.legacy.owners.session.add('tab.close'); } },
    { name: 'feature floor 被降低', scope: 'feature-floor', method: 'plan', mutate: (x) => { x.legacy.floors.plan = '1.8'; } },
    { name: '目录 floor 被下调（兼容策略）', scope: 'feature-floor', method: 'plan', mutate: (x) => { x.floors.plan = '1.8'; } },
    { name: '特性正向表漏方法', scope: 'feature-methods', method: 'har', mutate: (x) => { x.featureMethods.har = []; } },
    { name: '生成物 owner 表被改', scope: 'generated.owner', method: 'click', mutate: (x) => { x.generated.METHOD_OWNER.click = 'instance'; } },
    { name: '生成物过期', scope: 'generated.text', method: '<文件>', mutate: (x) => { x.generated.text += '\n'; } },
    { name: '生成物五维状态被改', scope: 'generated.state', method: 'click', mutate: (x) => { x.generated.METHOD_STATE.click.unknown = false; } },
    { name: '生成物 partial 表被改', scope: 'generated.partial', method: 'observe', mutate: (x) => { x.generated.METHOD_PARTIAL = x.generated.METHOD_PARTIAL.filter((method) => method !== 'observe'); } },
    { name: '生成物 reconcile 表被改', scope: 'generated.reconcile', method: 'video.start', mutate: (x) => { x.generated.METHOD_RECONCILE['video.start'] = 'observe'; } },
    { name: '目录状态不变量被破坏', scope: 'state.unknown', method: 'click', mutate: (x) => { x.state.click.unknown = false; } },
    { name: 'schema keys 生成物被改', scope: 'schema.keys', method: 'observe', mutate: (x) => { x.generated.METHOD_SCHEMA_KEYS.observe.properties = x.generated.METHOD_SCHEMA_KEYS.observe.properties.slice(1); } },
    { name: '参数别名生成物被改', scope: 'schema.aliases', method: 'observe', mutate: (x) => { delete x.generated.PARAM_ALIASES.observe; } },
    { name: '文档索引缺行', scope: 'docs.count', method: '<文档>', mutate: (x) => { x.docsRows = x.docsRows.slice(1); } },
    { name: '文档过期', scope: 'docs.text', method: '<文档>', mutate: (x) => { x.docsText += '\n'; } },
    { name: '兼容矩阵允许基线客户端', scope: 'compat.baseline', method: 'unverified', mutate: (x) => { x.compat.perFeature[0].baselineAllowed = true; } },
    { name: 'MCP 映射引用未知方法', scope: 'mcp', method: 'not-a-method', mutate: (x) => { x.mcp.tools[0].methods = [...x.mcp.tools[0].methods, 'not-a-method']; } },
    { name: '运行时 effect 值漂移', scope: 'runtime.effect', method: 'click', mutate: (x) => { x.runtime.protocol.methodEffect.click = 'passive_read'; } },
    { name: '运行时手工表回流', scope: 'runtime.literal-table', method: 'click', mutate: (x) => { x.runtime.sources.protocol = "import { METHOD_EFFECT_TABLE } from './method-catalog.mjs';\nconst M = ['click', 'fill', 'press', 'select', 'drag', 'wheel', 'scroll-to', 'upload'];\n"; } },
    { name: '目录反向依赖 protocol', scope: 'runtime.deps', method: 'lib/method-catalog.mjs', mutate: (x) => { x.runtime.sources.catalog = "import { METHOD_EFFECT } from './protocol.mjs';"; } },
    { name: '运行时 effect 表未冻结', scope: 'runtime.frozen', method: 'METHOD_EFFECT', mutate: (x) => { x.runtime.frozen.methodEffect = false; x.runtime.frozen.methodEffectTable = false; } },
    { name: '运行时方法数漂移', scope: 'runtime.count', method: '<运行时>', mutate: (x) => { x.runtime.methodCount = 164; } },
    { name: '队列旁路表缺方法', scope: 'runtime.bypass', method: 'operation.await', mutate: (x) => { x.runtime.methods.bypass = x.runtime.methods.bypass.filter((method) => method !== 'operation.await'); } },
  ];
  for (const item of cases) {
    await t.test(item.name, () => {
      const broken = structuredClone(inputs);
      item.mutate(broken);
      const report = auditSingleSource(broken);
      assert.equal(report.ok, false, item.name + ' 应判定为不一致');
      const scopes = report.differences.map((entry) => entry.scope);
      assert.ok(scopes.some((scope) => scope === item.scope || scope.startsWith(item.scope + '.')), item.name + ' 缺少 ' + item.scope + '；' + JSON.stringify(scopes));
      if (item.method !== 'not-a-method') {
        assert.ok(report.differences.some((entry) => entry.method === item.method), item.name + ' 未指出方法 ' + item.method);
      } else {
        assert.ok(report.differences.some((entry) => entry.method === 'not-a-method'));
      }
    });
  }
});
