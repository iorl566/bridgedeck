// tests/unit/eval-corpus.test.mjs —— 分层语料/元数据校验 + 离线层执行（fake adapter）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CAPABILITIES,
  CAPABILITY_IDS,
  CorpusError,
  ORACLE_LEVELS,
  assertCases,
  inferCapability,
  loadCorpusFile,
  loadCorpusLayers,
  loadPluginToolNames,
  normalizeCase,
  runOfflineLayer,
  summarizeCorpus,
  validateCases,
  validateResults,
} from '../../lib/eval-e2e-corpus.mjs';

const ROOT = process.cwd();
const FAKE_CORE = 'tests/eval/cases/fake-core.json';
const OFFLINE_EXTENDED = 'tests/eval/cases/offline-extended.json';
const DOM_CASES = 'tests/eval/cases/dom-cases.json';

let pluginAvailable = true;
try {
  await loadPluginToolNames();
} catch {
  pluginAvailable = false;
}
const skipWithoutPlugin = pluginAvailable ? false : 'dsh-plugin/lib/tools.mjs 当前不可用，跳过依赖插件的执行型用例';

function load(name) {
  return loadCorpusLayers(ROOT, [{ layer: path.basename(name).startsWith('dom') ? 'dom' : 'offline', file: name }], { knownTools: null })[0].cases;
}

test('元数据目录：capability/oracleLevel 登记完整且不可被随意扩展', () => {
  assert.ok(CAPABILITY_IDS.length >= 25, 'capability 目录太少：' + CAPABILITY_IDS.length);
  assert.ok(CAPABILITY_IDS.every((id) => id.includes('.') && CAPABILITIES[id].length >= 8));
  assert.deepEqual(Object.keys(ORACLE_LEVELS), ['offline-fake', 'dom-real', 'e2e-real']);
  assert.ok(ORACLE_LEVELS['offline-fake'].rank < ORACLE_LEVELS['dom-real'].rank);
  assert.ok(ORACLE_LEVELS['dom-real'].rank < ORACLE_LEVELS['e2e-real'].rank);
});

test('遗留 fake-core：15 case 归一化后全部带 id/capability/oracleLevel/expectedStatus/evidence 规则', () => {
  const cases = load(FAKE_CORE);
  assert.equal(cases.length, 15);
  for (const item of cases) {
    assert.equal(typeof item.id, 'string');
    assert.ok(CAPABILITIES[item.capability], item.id + ' capability=' + item.capability);
    assert.equal(item.oracleLevel, 'offline-fake');
    assert.equal(item.expectedStatus, item.expect);
    assert.ok(['passed', 'failed', 'unverified'].includes(item.expectedStatus));
    assert.ok(item.evidenceRule.length > 0);
    assert.ok(Array.isArray(item.evidence));
  }
  const byId = Object.fromEntries(cases.map((item) => [item.id, item]));
  assert.equal(byId['cli-fallback-status'].capability, 'plugin.offline-fallback');
  assert.equal(byId['timeout-adapter'].capability, 'plugin.timeout');
  assert.equal(byId['error-forbidden'].capability, 'plugin.error-mapping');
  assert.equal(byId['fail-value-mismatch'].capability, 'plugin.negative-selfcheck');
  assert.equal(byId['unverified-no-evidence'].capability, 'plugin.tool-contract');
});

test('扩展离线语料：≥40 case，覆盖三态与 7 类插件能力，且 rpc/cli 断言声明合法', () => {
  const cases = load(OFFLINE_EXTENDED);
  assert.ok(cases.length >= 40, '扩展离线语料不足：' + cases.length);
  const statuses = new Set(cases.map((item) => item.expectedStatus));
  assert.deepEqual([...statuses].sort(), ['failed', 'passed', 'unverified']);
  const capabilities = new Set(cases.map((item) => item.capability));
  for (const expected of [
    'plugin.rpc-routing',
    'plugin.cli-mapping',
    'plugin.error-mapping',
    'plugin.offline-fallback',
    'plugin.timeout',
    'plugin.evidence',
    'plugin.negative-selfcheck',
  ]) {
    assert.ok(capabilities.has(expected), '缺少能力覆盖：' + expected);
  }
  for (const item of cases) {
    assert.equal(item.oracleLevel, 'offline-fake');
    assert.equal(item.expect, item.expectedStatus);
    assert.ok(item.evidenceRule.length > 0);
    assert.ok(['tool', 'rpc'].includes(item.mode));
    if (item.mode === 'tool') assert.equal(typeof item.tool, 'string');
    if (item.mode === 'rpc') assert.equal(typeof item.rpc.method, 'string');
    if (item.expectedStatus === 'failed') assert.equal(item.negative, true, item.id + ' 负向自检必须显式 negative=true');
  }
  const rpcAsserted = cases.filter((item) => Array.isArray(item.expectRpc) && item.expectRpc.length);
  const cliAsserted = cases.filter((item) => Array.isArray(item.expectCli) && item.expectCli.length);
  assert.ok(rpcAsserted.length >= 10, 'rpc 参数断言太少：' + rpcAsserted.length);
  assert.ok(cliAsserted.length >= 10, 'CLI argv 断言太少：' + cliAsserted.length);
  assert.ok(cases.filter((item) => item.expectedStatus === 'failed' && item.negative).length >= 3);
});

test('DOM 语料：12 deterministic case 全部声明 dom-real 与证据规则', () => {
  const cases = load(DOM_CASES);
  assert.equal(cases.length, 12);
  const capabilities = new Set(cases.map((item) => item.capability));
  for (const expected of ['overlay.top-layer', 'overlay.focus', 'overlay.hit-testing', 'overlay.pointer-through', 'overlay.stacking', 'overlay.toast', 'overlay.rtl', 'overlay.shadow', 'overlay.sticky']) {
    assert.ok(capabilities.has(expected), '缺少 DOM 能力：' + expected);
  }
  for (const item of cases) {
    assert.equal(item.oracleLevel, 'dom-real');
    assert.equal(item.layer, 'dom');
    assert.ok(item.evidenceRule.length > 0);
    assert.ok(item.assert && Object.keys(item.assert).length > 0, item.id + ' 缺少 assert');
    if (item.expectedStatus === 'failed') assert.equal(item.negative, true);
  }
  assert.equal(cases.filter((item) => item.expectedStatus === 'unverified').length, 1);
});

test('loadCorpusLayers：三文件合计 70 case，且跨文件重复 id 会被拒绝', () => {
  const layers = loadCorpusLayers(ROOT, [
    { layer: 'offline', file: FAKE_CORE },
    { layer: 'offline', file: OFFLINE_EXTENDED },
    { layer: 'dom', file: DOM_CASES },
  ], { knownTools: null });
  assert.equal(layers.length, 3);
  const summary = summarizeCorpus(layers);
  assert.equal(summary.total, 70);
  assert.deepEqual(summary.byLayer, { dom: 12, offline: 58 });
  assert.deepEqual(summary.byOracleLevel, { 'dom-real': 12, 'offline-fake': 58 });
  assert.deepEqual(summary.byExpectedStatus, { passed: 58, failed: 7, unverified: 5 });
  assert.throws(
    () => loadCorpusLayers(ROOT, [{ layer: 'offline', file: FAKE_CORE }, { layer: 'offline', file: FAKE_CORE }], { knownTools: null }),
    (error) => error instanceof CorpusError && /id 重复/.test(error.message),
  );
});

test('validateCases：缺元数据/非法三态/负向自检缺标记/未知工具/坏 argv 全部被拦下', () => {
  const base = {
    id: 'case-x',
    title: '校验用例',
    layer: 'offline',
    capability: 'plugin.tool-contract',
    oracleLevel: 'offline-fake',
    expectedStatus: 'passed',
    expect: 'passed',
    mode: 'tool',
    tool: 'browser_status',
    args: {},
    evidence: [],
    evidenceRule: 'assert 即证据',
  };
  assert.deepEqual(validateCases([base]), []);
  const broken = [
    [{ ...base, id: '' }, '缺少非空 id'],
    [{ ...base, capability: 'plugin.unknown' }, '未登记的 capability'],
    [{ ...base, oracleLevel: 'unit' }, '非法 oracleLevel'],
    [{ ...base, expectedStatus: 'skipped' }, '非法 expectedStatus'],
    [{ ...base, expectedStatus: 'failed', expect: 'passed' }, 'expect 与 expectedStatus 不一致'],
    [{ ...base, expectedStatus: 'failed', expect: 'failed', negative: false }, '必须显式 negative=true'],
    [{ ...base, mode: 'rpc', tool: undefined, rpc: {} }, 'rpc 模式需要 rpc.method'],
    [{ ...base, tool: 'browser_nope' }, '引用了不存在的插件工具'],
    [{ ...base, expectCli: ['audit list'] }, 'expectCli 需要非空 argv 数组'],
    [{ ...base, expectRpc: [{ params: {} }] }, 'expectRpc 需要 method'],
    [{ ...base, expectCliCount: -1 }, 'expectCliCount 需要非负整数'],
  ];
  for (const [item, needle] of broken) {
    const problems = validateCases([{ ...base, ...item }], { knownTools: new Set(['browser_status']) });
    assert.ok(problems.some((problem) => problem.includes(needle)), needle + ' → ' + problems.join(' | '));
  }
  // 重复 id 需要由调用方传入共享 seenIds（loadCorpusLayers 内部就是这么做的）。
  const seen = new Set(['case-x']);
  const duplicates = validateCases([base], { seenIds: seen });
  assert.ok(duplicates.some((problem) => problem.includes('id 重复')));
  assert.throws(() => assertCases([{ ...base, title: '' }], { knownTools: null }), /缺少 title/);
});

test('normalizeCase：缺元数据时确定性推导（capability/oracleLevel/expectedStatus/evidenceRule）', () => {
  const legacy = normalizeCase({ id: 'legacy-1', title: '导入失败重试（E_FORBIDDEN）', mode: 'tool', tool: 'browser_navigate', expect: 'passed', expectError: 'E_FORBIDDEN' }, { layer: 'offline' });
  assert.equal(legacy.oracleLevel, 'offline-fake');
  assert.equal(legacy.expectedStatus, 'passed');
  assert.equal(legacy.capability, 'plugin.error-mapping');
  assert.ok(legacy.evidenceRule.includes('E_FORBIDDEN'));
  assert.equal(legacy.negative, false);
  const dom = normalizeCase({ id: 'd1', title: 'DOM', assert: { 'a.b': 1 }, evidence: ['a.b'] }, { layer: 'dom' });
  assert.equal(dom.oracleLevel, 'dom-real');
  assert.equal(dom.expectedStatus, undefined, 'DOM case 必须显式声明 expectedStatus');
  const e2e = normalizeCase({ id: '20d6', title: 'record iframe 事件' }, { layer: 'e2e' });
  assert.equal(e2e.capability, 'e2e.record');
  assert.equal(e2e.oracleLevel, 'e2e-real');
  assert.equal(e2e.expectedStatus, 'passed');
});

test('loadCorpusFile：支持裸数组与 {cases}，坏 JSON/空语料/非数组都抛 CorpusError', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-eval-corpus-'));
  const bare = path.join(dir, 'bare.json');
  const wrapped = path.join(dir, 'wrapped.json');
  const bad = path.join(dir, 'bad.json');
  const empty = path.join(dir, 'empty.json');
  const object = path.join(dir, 'object.json');
  fs.writeFileSync(bare, '[{"id":"a"}]', 'utf8');
  fs.writeFileSync(wrapped, '{"schema":"x","cases":[{"id":"b"}]}', 'utf8');
  fs.writeFileSync(bad, '{not json', 'utf8');
  fs.writeFileSync(empty, '[]', 'utf8');
  fs.writeFileSync(object, '{"foo":1}', 'utf8');
  assert.equal(loadCorpusFile(bare).length, 1);
  assert.equal(loadCorpusFile(wrapped).length, 1);
  for (const file of [bad, empty, object]) {
    assert.throws(() => loadCorpusFile(file), (error) => error instanceof CorpusError);
  }
  assert.throws(() => loadCorpusFile(path.join(dir, 'missing.json')), (error) => error instanceof CorpusError);
});

test('runOfflineLayer：真实 fake adapter 跑通 58 case，三态矩阵与期望一致', { skip: skipWithoutPlugin }, async () => {
  const knownTools = await loadPluginToolNames();
  const layers = loadCorpusLayers(ROOT, [
    { layer: 'offline', file: FAKE_CORE },
    { layer: 'offline', file: OFFLINE_EXTENDED },
  ], { knownTools });
  const cases = layers.flatMap((layer) => layer.cases);
  const results = await runOfflineLayer(cases);
  assert.equal(results.length, 58);
  const counts = { passed: 0, failed: 0, unverified: 0 };
  for (const item of results) {
    counts[item.status] += 1;
    assert.equal(item.status, item.expectedStatus, item.id + ' 三态与期望不符');
    assert.ok(item.capability && item.oracleLevel === 'offline-fake');
    assert.ok(Array.isArray(item.checks) && item.checks.length >= 1, item.id + ' 缺少检查');
    assert.ok(Object.keys(item.evidence).length >= 0);
    if (item.expectedStatus === 'failed') {
      assert.equal(item.negative, true);
      const failed = item.checks.filter((check) => check.status === 'fail');
      assert.ok(failed.length >= 1, item.id + ' 负向自检没有失败检查');
      assert.ok(failed.some((check) => check.evidence && ('expected' in check.evidence || 'expectedParams' in check.evidence || 'expectedArgv' in check.evidence)), item.id + ' 失败证据不可复现');
    }
    if (item.expectedStatus === 'unverified') assert.ok(item.unverified.length >= 1);
  }
  assert.deepEqual(counts, { passed: 49, failed: 5, unverified: 4 });
  assert.deepEqual(validateResults(results), []);
});

test('runOfflineLayer：rpc 参数/CLI argv 断言能真的抓到错配（负向用例构造）', { skip: skipWithoutPlugin }, async () => {
  const good = {
    id: 'inline-rpc-good',
    title: '内联 rpc 正确断言',
    mode: 'tool',
    tool: 'browser_act',
    args: { action: 'fill', ref: '@e1', value: 'v', sessionId: 's1' },
    script: { handlers: { fill: { result: { ok: true, value: 'v' } } } },
    expect: 'passed',
    expectRpc: [{ method: 'fill', params: { value: 'v' } }],
  };
  const bad = {
    id: 'inline-rpc-bad',
    title: '内联 rpc 错误断言',
    mode: 'tool',
    tool: 'browser_act',
    args: { action: 'fill', ref: '@e1', value: 'v', sessionId: 's1' },
    script: { handlers: { fill: { result: { ok: true, value: 'v' } } } },
    expect: 'failed',
    negative: true,
    expectRpc: [{ method: 'fill', params: { value: 'other' } }],
  };
  const results = await runOfflineLayer([
    normalizeCase(good, { layer: 'offline' }),
    normalizeCase(bad, { layer: 'offline' }),
  ]);
  assert.equal(results[0].status, 'passed');
  assert.equal(results[1].status, 'failed');
  const failedCheck = results[1].checks.find((check) => check.status === 'fail');
  assert.ok(failedCheck.id.includes(':rpc:fill'));
  assert.deepEqual(failedCheck.evidence.expectedParams, { value: 'other' });
});

test('runOfflineLayer：E_FORBIDDEN 不回退 CLI（adapter 1 次 / cli 0 次）', { skip: skipWithoutPlugin }, async () => {
  const cases = load(OFFLINE_EXTENDED);
  const item = cases.find((candidate) => candidate.id === 'offline-no-fallback-on-forbidden');
  assert.ok(item, '语料缺少 offline-no-fallback-on-forbidden');
  const [result] = await runOfflineLayer([item]);
  assert.equal(result.status, 'passed');
  assert.equal(result.adapterCalls.length, 1);
  assert.equal(result.cliCalls.length, 0);
  assert.equal(result.error.code, 'E_FORBIDDEN');
});

test('inferCapability：E2E 标题确定性推导（不依赖执行）', () => {
  const samples = [
    ['20d6', 'record iframe 事件（frameId + documentId）', 'e2e.record'],
    ['29d', 'ar/he RTL 界面真实渲染', 'e2e.rtl'],
    ['35', '视频录制页（真实 MP4 落库）', 'e2e.capture.video'],
    ['29c', 'adversarial：CLI 不能用 daemonUrl 完成本机配对（E_FORBIDDEN）', 'e2e.pairing'],
    ['23p3', '真正 OOPIF CDP owner 投影', 'e2e.iframe'],
    ['20j', 'MCP server observe/click/screenshot', 'e2e.plugin'],
    ['31c', '超长页面 CDP 分块拼接', 'e2e.capture.screenshot'],
    ['20s1', 'seeded fixture 可复现', 'e2e.general'],
  ];
  for (const [id, title, expected] of samples) {
    assert.equal(inferCapability(id, title), expected, id + ' ' + title);
  }
});
