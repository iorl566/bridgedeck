// tests/unit/eval-fake.test.mjs —— fake adapter + 离线三态 eval 的回归单测（无 daemon/无浏览器）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { judge, judgeCheck } from '../../lib/eval-oracle.mjs';
import { createFakeAdapter } from '../../dsh-plugin/lib/fake-adapter.mjs';
import { DEFAULT_CASES_PATH, evaluateCase, loadCorpus, runCorpus } from '../../tools/eval-fake.mjs';

test('fake 语料：≥8 case、id 唯一、覆盖成功/失败/unverified/错误码/超时', () => {
  const cases = loadCorpus(DEFAULT_CASES_PATH);
  assert.ok(cases.length >= 8, '语料太少：' + cases.length);
  const statuses = new Set(cases.map((item) => item.expect));
  assert.deepEqual([...statuses].sort(), ['failed', 'passed', 'unverified'], '语料未覆盖三态');
  const errorCodes = new Set(cases.filter((item) => item.expectError).map((item) => item.expectError));
  assert.ok(errorCodes.has('E_FORBIDDEN'), '缺少业务错误码用例');
  assert.ok(errorCodes.has('E_TIMEOUT'), '缺少超时用例');
  assert.ok(cases.some((item) => item.script && item.script.unavailable === true), '缺少 daemon 不可用用例');
  assert.ok(cases.some((item) => item.mode === 'rpc'), '缺少直接 rpc 用例');
  for (const item of cases) {
    assert.ok(item.title && item.title.length >= 6, item.id + ' 缺少 title');
    assert.ok(Array.isArray(item.evidence) || item.assert || item.expectError, item.id + ' 没有任何判定依据');
  }
});

test('fake 语料跑通：期望矩阵一致，三态计数含 failed 与 unverified，失败项可复现', async () => {
  const report = await runCorpus(DEFAULT_CASES_PATH);
  assert.equal(report.ok, true, '存在与期望不符的 case：' + report.unexpected.map((item) => item.id).join(', '));
  assert.equal(report.unexpected.length, 0);
  assert.deepEqual(report.counts, report.expected, '实际三态与期望矩阵不一致');
  assert.ok(report.counts.passed >= 1, '没有 passed 用例');
  assert.ok(report.counts.failed >= 1, '没有 failed 用例（负向自检）');
  assert.ok(report.counts.unverified >= 1, '没有 unverified 用例');
  for (const result of report.results.filter((item) => item.status === 'failed')) {
    assert.ok(result.negative === true, result.id + ' 非负向用例不应失败');
    const withEvidence = result.checks.filter((check) => check.ok === false && check.evidence && 'actual' in check.evidence);
    assert.ok(withEvidence.length >= 1, result.id + ' 失败项缺少可复现证据');
  }
  for (const result of report.results.filter((item) => item.status === 'unverified')) {
    assert.ok(result.unverified.length >= 1, result.id + ' unverified 缺少原因');
  }
});

test('runCorpus：未期望失败 → ok=false（运行器据此以非 0 退出）', async () => {
  const report = await runCorpus([
    {
      id: 'unexpected-failure',
      title: '构造未期望失败',
      mode: 'tool',
      tool: 'browser_status',
      args: {},
      script: { handlers: { status: { result: { port: 1, version: 'x', browsers: [], sessions: [] } } } },
      expect: 'passed',
      assert: { port: 2 },
    },
  ]);
  assert.equal(report.ok, false);
  assert.equal(report.unexpected.length, 1);
  assert.equal(report.unexpected[0].id, 'unexpected-failure');
  assert.equal(report.unexpected[0].status, 'failed');
  assert.equal(report.unexpected[0].expect, 'passed');
});

test('evaluateCase：单 case 返回三态、证据与 fake adapter 调用序列', async () => {
  const result = await evaluateCase({
    id: 'inline-status',
    title: '内联 status 用例',
    mode: 'tool',
    tool: 'browser_status',
    args: {},
    script: { handlers: { status: { result: { port: 52900, version: '0.3.0', browsers: [], sessions: [] } } } },
    expect: 'passed',
    assert: { port: 52900 },
    evidence: ['port'],
  });
  assert.equal(result.status, 'passed');
  assert.equal(result.evidence.port, 52900);
  assert.equal(result.adapter.calls[0].method, 'status');
  assert.equal(result.adapter.calls[0].status, 'ok');
  assert.equal(result.cliCalls.length, 0);
});

test('fake adapter：未注册方法默认 E_UNKNOWN_METHOD，并记录调用序列', async () => {
  const adapter = createFakeAdapter({ handlers: { observe: { result: { refs: 1 } } } });
  assert.deepEqual(await adapter.call('observe', { session: 's1' }, { timeoutMs: 1000 }), { refs: 1 });
  await assert.rejects(() => adapter.call('missing.method'), (error) => error && error.code === 'E_UNKNOWN_METHOD');
  assert.equal(adapter.calls.length, 2);
  assert.equal(adapter.calls[0].method, 'observe');
  assert.equal(adapter.calls[0].status, 'ok');
  assert.equal(adapter.calls[1].status, 'error');
  assert.equal(adapter.calls[1].code, 'E_UNKNOWN_METHOD');
  assert.equal(adapter.callsFor('observe').length, 1);
  assert.equal(adapter.lastCall().method, 'missing.method');
  assert.equal(adapter.toJSON().count, 2);
  adapter.reset();
  assert.equal(adapter.calls.length, 0);
});

test('fake adapter：预设错误 / 延迟超时 / 整体离线', async () => {
  const adapter = createFakeAdapter({
    handlers: {
      'error.method': { error: { code: 'E_FORBIDDEN', message: '安全策略拒绝' } },
      'slow.method': { delayMs: 40, result: { ok: true } },
    },
  });
  await assert.rejects(
    () => adapter.call('error.method'),
    (error) => error && error.code === 'E_FORBIDDEN' && /安全策略拒绝/.test(error.message),
  );
  await assert.rejects(
    () => adapter.call('slow.method', {}, { timeoutMs: 5 }),
    (error) => error && error.code === 'E_TIMEOUT',
  );
  const offline = createFakeAdapter({ unavailable: true });
  await assert.rejects(() => offline.call('status'), (error) => error && error.code === 'E_DAEMON');
  assert.equal(offline.calls[0].code, 'E_DAEMON');
});

test('三态判定：缺证据降级 unverified，unverified 绝不算 pass', () => {
  assert.equal(judgeCheck({ ok: true, evidence: 'x', evidenceRequired: true }).status, 'pass');
  assert.equal(judgeCheck({ ok: true, evidenceRequired: true }).status, 'unverified');
  assert.equal(judgeCheck({ ok: true, evidence: '', evidenceRequired: true }).status, 'unverified');
  assert.equal(judgeCheck({ ok: true, evidence: 0, evidenceRequired: true }).status, 'pass', '0 也是有效证据');
  assert.equal(judgeCheck({ ok: true }).status, 'pass');
  assert.equal(judgeCheck({ ok: false, evidenceRequired: true }).status, 'fail');
  assert.equal(judgeCheck({}).status, 'unverified');
  const unverified = judge({ checks: [{ ok: true }], unverified: [{ id: 'x', reason: 'missing evidence' }] });
  assert.equal(unverified.status, 'unverified');
  assert.notEqual(unverified.status, 'passed');
  assert.equal(judge({ checks: [{ ok: false }, { ok: true }], unverified: ['x'] }).status, 'failed');
  assert.equal(judge({ checks: [] }).status, 'unverified');
});
