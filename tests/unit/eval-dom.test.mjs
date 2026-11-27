// tests/unit/eval-dom.test.mjs —— DOM 层 oracle：事实提取、断言、证据降级 + 真实 headless Chromium 验收。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOM_FAIL_MARKER,
  DOM_OK_MARKER,
  DomHarnessError,
  buildDomResult,
  evaluateDomCase,
  evaluateDomLayer,
  extractDomFacts,
  readFact,
  runDomLayer,
} from '../../lib/eval-e2e-dom.mjs';
import { loadCorpusLayers } from '../../lib/eval-e2e-corpus.mjs';
import { findBrowser } from '../../tools/lib/overlay-dom-harness.mjs';

const ROOT = process.cwd();
const CASES = loadCorpusLayers(ROOT, [{ layer: 'dom', file: 'tests/eval/cases/dom-cases.json' }], { knownTools: null })[0].cases;
const browser = findBrowser();
const skipWithoutBrowser = browser ? false : '未找到 Edge/Chrome，跳过真实 headless DOM 用例';

test('readFact：平铺字面 key 与嵌套点号路径都能读取，缺失返回 undefined', () => {
  const facts = { 'modal.open': true, nested: { a: { b: 2 } }, list: [{ x: 1 }] };
  assert.equal(readFact(facts, 'modal.open'), true);
  assert.equal(readFact(facts, 'nested.a.b'), 2);
  assert.equal(readFact(facts, 'list.0.x'), 1);
  assert.equal(readFact(facts, 'nested.missing'), undefined);
  assert.equal(readFact(null, 'a'), undefined);
});

test('evaluateDomCase：assert/contains 通过、缺失事实失败、证据缺失升 unverified', () => {
  const facts = { 'modal.open': true, 'toast.text': 'saved', 'rtl.rightGap': 22 };
  const pass = evaluateDomCase({
    id: 'c1',
    assert: { 'modal.open': true, 'rtl.rightGap': 22 },
    contains: { 'toast.text': 'sav' },
    evidence: ['modal.open'],
  }, facts);
  assert.equal(pass.checks.length, 3);
  assert.ok(pass.checks.every((check) => check.ok === true));
  assert.deepEqual(pass.unverified, []);
  assert.deepEqual(pass.evidence, { 'modal.open': true });

  const fail = evaluateDomCase({ id: 'c2', assert: { 'modal.open': false } }, facts);
  assert.equal(fail.checks[0].ok, false);
  assert.deepEqual(fail.checks[0].evidence, { path: 'modal.open', expected: false, actual: true });

  const missing = evaluateDomCase({ id: 'c3', assert: { 'missing.fact': 1 } }, facts);
  assert.equal(missing.checks[0].ok, false);
  assert.equal(missing.checks[0].evidence.actual, undefined);

  const unverified = evaluateDomCase({ id: 'c4', assert: { 'modal.open': true }, evidence: ['missing.fact'] }, facts);
  assert.equal(unverified.unverified.length, 1);
  assert.equal(unverified.unverified[0].reason, 'missing dom fact');
});

test('buildDomResult：三态判定与证据规则随 case 元数据保留', () => {
  const item = { id: 'c5', title: 'x', capability: 'overlay.rtl', oracleLevel: 'dom-real', expectedStatus: 'passed', evidenceRule: '规则', negative: false };
  const passed = buildDomResult(item, evaluateDomCase({ id: 'c5', assert: { 'a.b': 1 } }, { 'a.b': 1 }), 3);
  assert.equal(passed.status, 'passed');
  assert.equal(passed.layer, 'dom');
  assert.equal(passed.oracleLevel, 'dom-real');
  assert.equal(passed.capability, 'overlay.rtl');
  assert.equal(passed.evidenceRule, '规则');
  assert.equal(passed.durationMs, 3);
  assert.equal(passed.checks[0].ok, true);
  const failed = buildDomResult({ ...item, expectedStatus: 'failed', negative: true }, evaluateDomCase({ id: 'c5', assert: { 'a.b': 2 } }, { 'a.b': 1 }), 1);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.checks[0].ok, false);
  const unverified = buildDomResult({ ...item, expectedStatus: 'unverified' }, evaluateDomCase({ id: 'c5', assert: { 'a.b': 1 }, evidence: ['x.y'] }, { 'a.b': 1 }), 1);
  assert.equal(unverified.status, 'unverified');
});

test('extractDomFacts：成功标记 + JSON 事实；缺标记/坏 JSON/夹具异常都抛 DomHarnessError', () => {
  const good = {
    title: DOM_OK_MARKER + '2',
    stdout: '<html><head><title>' + DOM_OK_MARKER + '2</title></head><body><script type="application/json" id="eval-facts">{"a":1,"b":"x"}</script></body></html>',
    stderr: '',
    code: 0,
  };
  assert.deepEqual(extractDomFacts(good), { a: 1, b: 'x' });
  const noMarker = { title: 'EVAL_DOM_PENDING', stdout: '', stderr: 'boom', code: 0 };
  assert.throws(() => extractDomFacts(noMarker), (error) => error instanceof DomHarnessError && error.code === 'E_EVAL_DOM_NO_MARKER');
  const failMarker = { title: DOM_FAIL_MARKER + 'boom', stdout: '', stderr: '' };
  assert.throws(() => extractDomFacts(failMarker), (error) => error.code === 'E_EVAL_DOM_FIXTURE');
  const badJson = { title: DOM_OK_MARKER + '1', stdout: '<script type="application/json" id="eval-facts">{oops</script>', stderr: '' };
  assert.throws(() => extractDomFacts(badJson), (error) => error.code === 'E_EVAL_DOM_BAD_JSON');
  const noFacts = { title: DOM_OK_MARKER + '1', stdout: '<html></html>', stderr: '' };
  assert.throws(() => extractDomFacts(noFacts), (error) => error.code === 'E_EVAL_DOM_NO_FACTS');
  const fixtureError = { title: DOM_OK_MARKER + '1', stdout: '<script type="application/json" id="eval-facts">{"__error":"kaboom","__stack":"s"}</script>', stderr: '' };
  assert.throws(() => extractDomFacts(fixtureError), (error) => error.code === 'E_EVAL_DOM_FIXTURE' && /kaboom/.test(error.message));
});

test('evaluateDomLayer：一次提取 facts 后批量判定，不重复启动浏览器', () => {
  const inline = [
    { id: 'd-pass', title: 'pass', capability: 'overlay.rtl', oracleLevel: 'dom-real', expectedStatus: 'passed', assert: { 'a.b': 1 }, evidence: ['a.b'], evidenceRule: 'r' },
    { id: 'd-fail', title: 'fail', capability: 'dom.negative-selfcheck', oracleLevel: 'dom-real', expectedStatus: 'failed', negative: true, assert: { 'a.b': 2 }, evidence: ['a.b'], evidenceRule: 'r' },
    { id: 'd-skip', title: 'skip', capability: 'dom.negative-selfcheck', oracleLevel: 'dom-real', expectedStatus: 'unverified', assert: { 'a.b': 1 }, evidence: ['a.missing'], evidenceRule: 'r' },
  ];
  const results = evaluateDomLayer(inline, { 'a.b': 1 });
  assert.deepEqual(results.map((item) => item.status), ['passed', 'failed', 'unverified']);
  assert.equal(results[0].checks.length, 1);
  assert.equal(results[1].negative, true);
  assert.equal(results[2].unverified[0].reason, 'missing dom fact');
});

test('runDomLayer：可注入 runPage（不启动浏览器也能验证判定链路）', async () => {
  const runPage = async () => ({
    title: DOM_OK_MARKER + '1',
    stdout: '<script type="application/json" id="eval-facts">{"a.b":1}</script>',
    stderr: '',
    code: 0,
  });
  const item = { id: 'd1', title: 'x', capability: 'overlay.rtl', oracleLevel: 'dom-real', expectedStatus: 'passed', assert: { 'a.b': 1 }, evidenceRule: 'r' };
  const results = await runDomLayer([item], { runPage });
  assert.equal(results[0].status, 'passed');
  await assert.rejects(
    () => runDomLayer([item], { runPage: async () => ({ title: 'EVAL_DOM_PENDING', stdout: '', stderr: '' }) }),
    (error) => error instanceof DomHarnessError,
  );
});

test('真实 headless Chromium：deterministic DOM 层 12 case 三态与期望一致', { skip: skipWithoutBrowser }, async () => {
  const results = await runDomLayer(CASES);
  assert.equal(results.length, 12);
  const counts = { passed: 0, failed: 0, unverified: 0 };
  for (const item of results) {
    counts[item.status] += 1;
    assert.equal(item.status, item.expectedStatus, item.id + ' 三态与期望不符');
    assert.equal(item.layer, 'dom');
    assert.equal(item.oracleLevel, 'dom-real');
  }
  assert.deepEqual(counts, { passed: 9, failed: 2, unverified: 1 });
  const negative = results.filter((item) => item.expectedStatus === 'failed');
  assert.equal(negative.length, 2);
  for (const item of negative) {
    const failed = item.checks.filter((check) => check.status === 'fail');
    assert.equal(failed.length, 1, item.id + ' 负向自检应恰好一个失败断言');
    assert.ok('expected' in failed[0].evidence && 'actual' in failed[0].evidence, item.id + ' 失败证据不可复现');
  }
  const unverified = results.find((item) => item.expectedStatus === 'unverified');
  assert.ok(unverified.unverified.some((entry) => entry.reason === 'missing dom fact'));
});
