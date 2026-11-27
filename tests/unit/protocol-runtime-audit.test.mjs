// tests/unit/protocol-runtime-audit.test.mjs —— 运行时单源审计（手工表回流检测）的纯函数与负例测试。
//
// 覆盖三部分：
//  1. 轻量词法器 scanSourceText / stripSourceComments / maskSourceText / importSpecifiers：
//     注释、字符串、模板串、正则、转义、CRLF、行号；
//  2. 手工表检测 countMethodLiterals / findMethodLiteralGroups：字面量预算、结构扫描、
//     嵌套括号、阈值、真表 vs 注释/正则/比较表达式（避免误报）；
//  3. auditSingleSource 的 runtime 段：真实仓库必须 ok；20+ 个负例（手工表回流、
//     依赖反向、effect/owner/bypass/mutating/scope 漂移、冻结丢失、预算收紧等）都必须 fail。
// 负例全部用 structuredClone 修改内存输入，不写真实文件。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  METHOD_NAMES,
  METHOD_CATALOG,
  SESSION_QUEUE_BYPASS_METHODS,
} from '../../lib/method-catalog.mjs';
import {
  RUNTIME_EFFECT_PROBES,
  RUNTIME_SOURCE_BUDGETS,
  RUNTIME_UNKNOWN_METHODS,
  auditSingleSource,
  collectSingleSourceInputs,
  countMethodLiterals,
  findMethodLiteralGroups,
  importSpecifiers,
  maskSourceText,
  scanSourceText,
  stripSourceComments,
} from '../../tools/protocol-single-source.mjs';

const checks = (inputs) => auditSingleSource(inputs).checks.map((check) => check.name);
const runtimeDifferences = (report) => report.differences.filter((item) => item.scope === 'runtime' || item.scope.startsWith('runtime.'));
const hasScope = (report, scope) => report.differences.some((item) => item.scope === scope || item.scope.startsWith(scope + '.'));

// ---------------------------------------------------------------------------
// 1) 词法器
// ---------------------------------------------------------------------------

test('scanSourceText：跳过行/块注释，保留字符串/模板串与行号', () => {
  const source = [
    '// \'click\' 在注释里不算',
    "const a = 'fill';",
    '/* \'press\'',
    " * 'select' */",
    'const b = "drag";',
    'const c = `wheel ${name}`;',
    "const d = 'it\\'s';",
  ].join('\n');
  const scan = scanSourceText(source);
  const values = scan.literals.map((literal) => literal.value);
  assert.deepEqual(values, ['fill', 'drag', 'wheel ${}', "it\\'s"]);
  assert.deepEqual(scan.literals.map((literal) => literal.line), [2, 5, 6, 7]);
  assert.deepEqual(scan.literals.map((literal) => literal.kind), ['string', 'string', 'template', 'string']);
  assert.equal(scan.hidden.length, 2, '应识别出两段注释');
});

test('scanSourceText：正则里的引号/括号不当成字符串或结构', () => {
  const source = "const re = /['\"]click['\"]/g;\nconst x = 'fill';";
  const scan = scanSourceText(source);
  assert.deepEqual(scan.literals.map((literal) => literal.value), ['fill']);
  assert.equal(scan.literals[0].line, 2);
  const { masked } = maskSourceText(source);
  assert.equal(masked.length, source.length);
  assert.ok(masked.includes('fill') === false, '字面量内容应被遮蔽');
  // 正则里的括号被隐藏，不应造成括号配对错乱。
  assert.deepEqual(findMethodLiteralGroups(source, ['click', 'fill'], { minEntries: 1 }), []);
});

test('stripSourceComments：去注释但保留字符串内容与换行', () => {
  const source = "const url = 'http://x//y';\n// comment\nconst a = 1; /* block */";
  const stripped = stripSourceComments(source);
  assert.ok(stripped.includes("'http://x//y'"), '字符串里的 // 不能被当注释');
  assert.ok(!stripped.includes('comment'));
  assert.ok(!stripped.includes('block'));
  assert.equal(stripped.split('\n').length, source.split('\n').length);
});

test('importSpecifiers：静态/裸/动态 import 都识别，注释里的不算', () => {
  const source = [
    "import fs from 'node:fs';",
    "import './side-effect.mjs';",
    "import { a } from \"./a.mjs\";",
    'const lazy = await import(/* webpackChunkName */ "./lazy.mjs");',
    "// import { bad } from './comment.mjs';",
    "/* import { bad } from './block-comment.mjs'; */",
  ].join('\n');
  const specs = importSpecifiers(source);
  assert.deepEqual(specs, ['node:fs', './a.mjs', './lazy.mjs', './side-effect.mjs']);
  assert.ok(!specs.includes('./comment.mjs'));
  assert.ok(!specs.includes('./block-comment.mjs'));
});

test('maskSourceText：长度不变、换行保留、注释/字面量内容被空格替换', () => {
  const source = "const a = 'click';\n// 'fill'\nconst b = { x: 1 };";
  const { masked } = maskSourceText(source);
  assert.equal(masked.length, source.length);
  assert.equal(masked.split('\n').length, source.split('\n').length);
  assert.ok(!masked.includes('click'));
  assert.ok(!masked.includes('fill'));
  assert.ok(masked.includes('const b = { x: 1 };'), '代码骨架应保留');
});

test('countMethodLiterals：只数精确方法名字面量，注释/正则不算，行号准确', () => {
  const source = [
    "const x = 'click';",
    "const y = 'click-handler';",
    "const z = 'read';",
    "// 'fill'",
    "const re = /'navigate'/;",
    "const tpl = `observe ${name}`;",
  ].join('\n');
  const hits = countMethodLiterals(source, ['click', 'fill', 'read', 'navigate', 'observe']);
  assert.deepEqual(hits, [
    { method: 'click', line: 1, kind: 'string' },
    { method: 'read', line: 3, kind: 'string' },
  ]);
});

test('findMethodLiteralGroups：抓出 8 项以上的方法名 MAP/Set，并给出行号与成员', () => {
  const table = ['click', 'fill', 'press', 'select', 'drag', 'wheel', 'scroll-to', 'upload'];
  const source = 'const MUTATING = new Set([\n' + table.map((method) => "  '" + method + "',").join('\n') + '\n]);';
  const groups = findMethodLiteralGroups(source, METHOD_NAMES, { minEntries: 8 });
  // `new Set(` 与 `[` 两个括号组都包含同样的 8 项（证据重复但都成立）。
  assert.equal(groups.length, 2);
  assert.ok(groups.every((group) => group.entries === 8));
  const setGroup = groups.find((group) => group.open === '[');
  assert.equal(setGroup.line, 1);
  assert.equal(setGroup.closeLine, 10);
  assert.deepEqual(setGroup.methods, table);
  // 阈值高于项数时不报。
  assert.deepEqual(findMethodLiteralGroups(source, METHOD_NAMES, { minEntries: 9 }), []);
});

test('findMethodLiteralGroups：嵌套组各自报出，对象字面量/数组/Set 都覆盖', () => {
  const methods = ['click', 'fill', 'press', 'select', 'drag', 'wheel'];
  const objectSource = 'const MAP = {\n' + methods.map((method) => '  ' + JSON.stringify(method) + ": 'browser_mutation',").join('\n') + '\n};';
  const groups = findMethodLiteralGroups(objectSource, METHOD_NAMES, { minEntries: 6 });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].open, '{');
  // 外层函数体包住内层对象：三个括号组（函数体 / Set 调用 / 数组）都满足阈值。
  const nestedSource = 'function f() {\n  const S = new Set([' + methods.map((method) => "'" + method + "'").join(', ') + ']);\n}';
  const nested = findMethodLiteralGroups(nestedSource, METHOD_NAMES, { minEntries: 6 });
  assert.equal(nested.length, 3);
  assert.ok(nested.every((group) => group.entries === 6));
  assert.deepEqual(nested.map((group) => group.open).sort(), ['(', '[', '{'].sort());
});

test('findMethodLiteralGroups：恢复“收口前 165 项 METHOD_EFFECT”会被 165 项证据抓住', () => {
  const tableSource = 'const METHOD_EFFECT = {\n'
    + METHOD_CATALOG.map((row) => '  ' + JSON.stringify(row.method) + ': 1,').join('\n')
    + '\n};';
  const groups = findMethodLiteralGroups(tableSource, METHOD_NAMES, { minEntries: 8 });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].entries, 165);
  assert.deepEqual(groups[0].methods.slice(0, 3), METHOD_NAMES.slice(0, 3));
  assert.equal(countMethodLiterals(tableSource, METHOD_NAMES).length, 165);
});

test('手工表检测不误报：注释/正则/模板插值都不是手工表', () => {
  const names = METHOD_NAMES.slice(0, 20);
  const decoys = [
    '// ' + names.map((method) => "'" + method + "'").join(', '),
    '/* ' + names.join(' ') + ' */',
    'const re = /' + names.join('|') + '/;',
    'const message = `method ${method} 不在协议里`;',
  ].join('\n');
  assert.deepEqual(countMethodLiterals(decoys, METHOD_NAMES), []);
  assert.deepEqual(findMethodLiteralGroups(decoys, METHOD_NAMES, { minEntries: 3 }), []);
  // 两处方法名的比较表达式是普通代码而不是表：会被字面量预算计入（严格），但不算结构表。
  const comparisons = "if (method === 'upload' || method === 'download') return true;";
  assert.equal(countMethodLiterals(comparisons, METHOD_NAMES).length, 2);
  assert.deepEqual(findMethodLiteralGroups(comparisons, METHOD_NAMES, { minEntries: 3 }), []);
});

test('CRLF 与多行字符串：行号按 \\n 计算，不被 \\r 干扰', () => {
  const source = "const a = 1;\r\nconst b = 'click';\r\nconst c = 'fill';\r\n";
  const hits = countMethodLiterals(source, ['click', 'fill']);
  assert.deepEqual(hits.map((hit) => [hit.method, hit.line]), [['click', 2], ['fill', 3]]);
});

// ---------------------------------------------------------------------------
// 2) 真实仓库审计：runtime 段必须真实执行且通过
// ---------------------------------------------------------------------------

test('真实仓库：runtime 审计段存在且通过，运行时源码里没有手工方法表', async () => {
  const inputs = await collectSingleSourceInputs();
  const report = auditSingleSource(inputs);
  assert.equal(report.ok, true, JSON.stringify(report.differences.slice(0, 8)));
  assert.equal(report.checks.every((check) => check.ok), true);
  const names = report.checks.map((check) => check.name);
  for (const name of ['catalog', 'effect', 'owner', 'mutating', 'feature-floor', 'state', 'schema', 'generated', 'schema-generated', 'docs', 'mcp', 'compat', 'runtime']) {
    assert.ok(names.includes(name), '缺少审计段 ' + name);
  }
  assert.deepEqual(runtimeDifferences(report), []);
  // 运行时代码只剩 1 个合法碰撞字面量（remoteScopeAllows 的 'read'），protocol 为 0。
  assert.deepEqual(report.counts.runtimeMethodLiterals, { protocol: 0, methods: 1 });
  assert.deepEqual({ ...RUNTIME_SOURCE_BUDGETS.protocol }, { maxMethodLiterals: 0, maxTableEntries: 8 });
  assert.deepEqual({ ...RUNTIME_SOURCE_BUDGETS.methods }, { maxMethodLiterals: 1, maxTableEntries: 8 });
  assert.equal(RUNTIME_EFFECT_PROBES.length, 7);
  assert.equal(RUNTIME_UNKNOWN_METHODS.length, 3);
});

test('runtime 段不能“缺少输入就跳过即通过”：空 runtime 会被判 fail', () => {
  // 不传 runtime：段被跳过（check 存在但 0 问题），这是审计可被其他门禁复用的形态。
  const skipped = auditSingleSource({ rows: [] });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.checks.find((check) => check.name === 'runtime').issues, 0);
  assert.equal(checks({ rows: [] }).includes('runtime'), true);
  // 传了 runtime 但缺源码快照：必须 fail，不能把“缺输入”当通过。
  const report = auditSingleSource({ rows: [], runtime: {} });
  assert.equal(report.ok, false);
  assert.ok(hasScope(report, 'runtime.sources'));
  assert.ok(checks({ rows: [], runtime: {} }).includes('runtime'));
});

// ---------------------------------------------------------------------------
// 3) runtime 段负例：任一非法漂移必须 fail（structuredClone 内存输入，不改真实文件）
// ---------------------------------------------------------------------------

const validRuntimeTemplate = () => ({
  methodCount: 165,
  sources: {
    protocol: "import { FILE_TRANSFER_METHODS, METHOD_EFFECT_TABLE } from './method-catalog.mjs';\nexport const METHOD_EFFECT = METHOD_EFFECT_TABLE;",
    methods: "import { OWNER_METHODS } from './method-catalog.mjs';\nimport { METHOD_EFFECT } from './protocol.mjs';\nexport const LOCAL_METHODS = new Set([...OWNER_METHODS.local]);",
    catalog: 'export const METHOD_CATALOG = [];',
  },
  budgets: {
    protocol: { maxMethodLiterals: 0, maxTableEntries: 8 },
    methods: { maxMethodLiterals: 1, maxTableEntries: 8 },
  },
  frozen: { methodEffect: true, methodEffectTable: true },
  protocol: {
    methodEffect: Object.fromEntries(METHOD_CATALOG.map((row) => [row.method, row.effect])),
    methodEffectKeys: METHOD_CATALOG.map((row) => row.method),
    effectProbes: RUNTIME_EFFECT_PROBES.map((method) => ({
      method,
      effect: Object.prototype.hasOwnProperty.call(Object.fromEntries(METHOD_CATALOG.map((row) => [row.method, row.effect])), method)
        ? Object.fromEntries(METHOD_CATALOG.map((row) => [row.method, row.effect]))[method]
        : 'browser_mutation',
    })),
  },
  methods: {
    local: [...METHOD_CATALOG.filter((row) => row.owner === 'local').map((row) => row.method), 'command.cancel', 'inflight.list', 'ledger.resolve', 'ledger.status', 'pair.rotate', 'cancel', 'ledger.request'],
    session: METHOD_CATALOG.filter((row) => row.owner === 'session').map((row) => row.method),
    instance: METHOD_CATALOG.filter((row) => row.owner === 'instance').map((row) => row.method),
    ext: METHOD_CATALOG.filter((row) => row.owner !== 'local').map((row) => row.method),
    bypass: [...SESSION_QUEUE_BYPASS_METHODS],
    mutating: {
      ...Object.fromEntries(METHOD_CATALOG.map((row) => [row.method, Boolean(row.effect === 'browser_mutation' || row.effect === 'transient_input' || ['session.start', 'session.start_tracked', 'session.stop', 'session.rebind', 'session.pause', 'plan'].includes(row.method))])),
      back: true,
      'debug.replay': true,
      forward: true,
      type: true,
      'window.ensure': true,
      'window.new': true,
    },
    scope: Object.fromEntries([...METHOD_CATALOG.map((row) => [row.method, row.owner]), ...[['command.cancel', 'local'], ['inflight.list', 'local'], ['ledger.resolve', 'local'], ['ledger.status', 'local'], ['pair.rotate', 'local'], ['cancel', 'local'], ['ledger.request', 'local']]]),
    scopeProbes: RUNTIME_UNKNOWN_METHODS.map((method) => ({ method, scope: null })),
    validateErrors: [],
  },
});

test('runtime 模板自检：合法输入在最小 rows 上通过（防止负例测试自身写错）', async () => {
  const inputs = await collectSingleSourceInputs();
  const runtime = validRuntimeTemplate();
  const report = auditSingleSource({
    rows: inputs.rows,
    daemonOnly: inputs.daemonOnly,
    legacy: inputs.legacy,
    generated: inputs.generated,
    docsRows: inputs.docsRows,
    state: inputs.state,
    partial: inputs.partial,
    unknown: inputs.unknown,
    reconcile: inputs.reconcile,
    featureMethods: inputs.featureMethods,
    runtime,
  });
  // 只断言 runtime 段（其他段依赖的输入不全会失败，与本测试无关）。
  const runtimeCheck = report.checks.find((check) => check.name === 'runtime');
  assert.ok(runtimeCheck);
  assert.deepEqual(report.differences.filter((item) => item.scope.startsWith('runtime')), []);
});

test('runtime 负例矩阵：手工表回流/依赖反向/派生漂移/冻结丢失等都必须 fail', async (t) => {
  const inputs = await collectSingleSourceInputs();
  const cases = [
    {
      name: 'protocol 手写 METHOD_EFFECT 表回流',
      scope: 'runtime.literal-table',
      method: 'click',
      mutate: (x) => {
        const names = ['click', 'fill', 'press', 'select', 'drag', 'wheel', 'scroll-to', 'upload', 'download', 'navigate', 'reload', 'hover'];
        x.runtime.sources.protocol = "import { METHOD_EFFECT_TABLE } from './method-catalog.mjs';\n"
          + 'export const METHOD_EFFECT = {\n' + names.map((method) => "  '" + method + "': 'browser_mutation',").join('\n') + '\n};';
      },
    },
    {
      name: 'methods 手写 MUTATING Set 回流',
      scope: 'runtime.literal-table',
      method: 'fill',
      mutate: (x) => {
        x.runtime.sources.methods = "import { OWNER_METHODS } from './method-catalog.mjs';\n"
          + "import { METHOD_EFFECT } from './protocol.mjs';\n"
          + "const MUTATING = new Set(['click', 'fill', 'press', 'select', 'drag', 'wheel', 'scroll-to', 'upload', 'download']);";
      },
    },
    {
      name: '目录反向 import protocol（循环）',
      scope: 'runtime.deps',
      method: 'lib/method-catalog.mjs',
      mutate: (x) => { x.runtime.sources.catalog = "import { METHOD_EFFECT } from './protocol.mjs';\nexport const X = 1;"; },
    },
    {
      name: 'protocol 不再从目录派生',
      scope: 'runtime.deps',
      method: 'lib/protocol.mjs',
      mutate: (x) => { x.runtime.sources.protocol = 'export const METHOD_EFFECT = {};'; },
    },
    {
      name: 'methods 不再从目录派生',
      scope: 'runtime.deps',
      method: 'lib/methods.mjs',
      mutate: (x) => { x.runtime.sources.methods = 'export const LOCAL_METHODS = new Set();'; },
    },
    {
      name: '运行时 effect 值漂移',
      scope: 'runtime.effect',
      method: 'click',
      mutate: (x) => { x.runtime.protocol.methodEffect.click = 'passive_read'; },
    },
    {
      name: 'METHOD_EFFECT 键序漂移',
      scope: 'runtime.effect.order',
      method: 'METHOD_EFFECT',
      mutate: (x) => {
        const keys = x.runtime.protocol.methodEffectKeys;
        [keys[0], keys[1]] = [keys[1], keys[0]];
      },
    },
    {
      name: 'effectOf 未知方法探针漂移',
      scope: 'runtime.effect.probe',
      method: 'no.such.method',
      mutate: (x) => {
        const probe = x.runtime.protocol.effectProbes.find((item) => item.method === 'no.such.method');
        probe.effect = 'read';
      },
    },
    {
      name: 'LOCAL_METHODS 多出方法',
      scope: 'runtime.owner.local',
      method: 'ghost.method',
      mutate: (x) => { x.runtime.methods.local.push('ghost.method'); },
    },
    {
      name: 'EXT_METHODS 缺少方法',
      scope: 'runtime.owner.ext',
      method: 'tab.close',
      mutate: (x) => { x.runtime.methods.ext = x.runtime.methods.ext.filter((method) => method !== 'tab.close'); },
    },
    {
      name: 'SESSION_QUEUE_BYPASS 缺少方法',
      scope: 'runtime.bypass',
      method: 'operation.await',
      mutate: (x) => { x.runtime.methods.bypass = x.runtime.methods.bypass.filter((method) => method !== 'operation.await'); },
    },
    {
      name: 'isMutating 判定翻转',
      scope: 'runtime.mutating',
      method: 'click',
      mutate: (x) => { x.runtime.methods.mutating.click = false; },
    },
    {
      name: 'methodScope owner 漂移',
      scope: 'runtime.scope',
      method: 'click',
      mutate: (x) => { x.runtime.methods.scope.click = 'local'; },
    },
    {
      name: '未知方法 scope 不再是 null',
      scope: 'runtime.scope.probe',
      method: 'no.such.method',
      mutate: (x) => { x.runtime.methods.scopeProbes[0].scope = 'local'; },
    },
    {
      name: 'validateMethodRegistry 报错未清空',
      scope: 'runtime.validate',
      method: '<派生清单>',
      mutate: (x) => { x.runtime.methods.validateErrors.push('模拟派生清单漂移'); },
    },
    {
      name: '运行时 effect 表未冻结',
      scope: 'runtime.frozen',
      method: 'METHOD_EFFECT',
      mutate: (x) => { x.runtime.frozen.methodEffect = false; },
    },
    {
      name: '运行时方法数漂移',
      scope: 'runtime.count',
      method: '<运行时>',
      mutate: (x) => { x.runtime.methodCount = 164; },
    },
    {
      name: '缺少运行时源码快照',
      scope: 'runtime.sources',
      method: 'lib/protocol.mjs',
      mutate: (x) => { delete x.runtime.sources.protocol; },
    },
    {
      name: '缺少运行时派生快照（LOCAL_METHODS）',
      scope: 'runtime.exports',
      method: 'LOCAL_METHODS',
      mutate: (x) => { delete x.runtime.methods.local; },
    },
    {
      name: '缺少 METHOD_EFFECT 派生快照',
      scope: 'runtime.exports',
      method: 'METHOD_EFFECT',
      mutate: (x) => { delete x.runtime.protocol.methodEffect; },
    },
    {
      name: '缺少运行时方法数快照',
      scope: 'runtime.exports',
      method: 'methodCount',
      mutate: (x) => { delete x.runtime.methodCount; },
    },
    {
      name: '字面量预算收紧后合法碰撞也 fail',
      scope: 'runtime.literal-budget',
      method: 'read',
      mutate: (x) => { x.runtime.budgets.methods.maxMethodLiterals = 0; },
    },
    {
      name: '结构阈值收紧后 2 项小表也 fail',
      scope: 'runtime.literal-table',
      method: 'click',
      mutate: (x) => {
        x.runtime.sources.protocol = "import { METHOD_EFFECT_TABLE } from './method-catalog.mjs';\nconst pair = ['click', 'fill'];";
        x.runtime.budgets.protocol.maxTableEntries = 2;
      },
    },
  ];
  for (const item of cases) {
    await t.test(item.name, () => {
      const broken = structuredClone(inputs);
      item.mutate(broken);
      const report = auditSingleSource(broken);
      assert.equal(report.ok, false, item.name + ' 应判定为不一致');
      assert.ok(hasScope(report, item.scope), item.name + ' 缺少 ' + item.scope + '：'
        + JSON.stringify(report.differences.filter((difference) => difference.scope.startsWith('runtime')).slice(0, 6)));
      if (item.method) {
        assert.ok(report.differences.some((difference) => difference.method === item.method),
          item.name + ' 未指出 ' + item.method);
      }
    });
  }
});

test('runtime 负例：注释/正则里的方法名不会被误判为手工表', async () => {
  const inputs = await collectSingleSourceInputs();
  const broken = structuredClone(inputs);
  const names = METHOD_NAMES.slice(0, 20);
  broken.runtime.sources.methods = "import { OWNER_METHODS } from './method-catalog.mjs';\n"
    + "import { METHOD_EFFECT } from './protocol.mjs';\n"
    + '// ' + names.map((method) => "'" + method + "'").join(', ') + '\n'
    + '/* ' + names.join(' ') + ' */\n'
    + 'const re = /' + names.join('|') + '/;\n'
    + 'const message = `method ${method} 不在协议里`;\n'
    + "if (method === 'read') return true;\n";
  const report = auditSingleSource(broken);
  assert.deepEqual(runtimeDifferences(report), [], JSON.stringify(runtimeDifferences(report).slice(0, 5)));
});
