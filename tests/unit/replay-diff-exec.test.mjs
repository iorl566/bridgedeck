// tests/unit/replay-diff-exec.test.mjs —— 回放差异校验执行层（消费真实 network.replay 结果）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as D from '../../extension/src/lib/replay-diff-exec.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function replayResult(overrides = {}) {
  return {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json', 'x-app': 'v1' },
    body: '{"ok":true,"items":[1,2,3],"id":"abc"}',
    durationMs: 12,
    url: 'https://a.test/api',
    ...overrides,
  };
}

function networkPlan(expect = null) {
  return {
    version: 1,
    source: 'network.replay',
    token: 'rp1-test',
    fingerprint: 'fp-test',
    steps: [{
      index: 0,
      ref: 'network:r1',
      kind: 'network',
      method: 'network.replay',
      params: { method: 'GET', url: 'https://a.test/api' },
      expect,
    }],
    blockers: [],
    network: { method: 'GET', url: 'https://a.test/api', sideEffect: false, crossOrigin: false },
  };
}

// ---------------------------------------------------------------------------
// 常量 / header / JSON
// ---------------------------------------------------------------------------

test('观测层版本/上限/易变头清单稳定', () => {
  assert.equal(D.REPLAY_OBSERVATION_VERSION, 2);
  assert.equal(D.OBSERVATION_LIMITS.maxBodyChars, 65536);
  assert.equal(D.VOLATILE_HEADERS.includes('date'), true);
  assert.equal(D.VOLATILE_HEADERS.includes('etag'), true);
  assert.equal(D.VOLATILE_HEADERS.includes('x-request-id'), true);
  assert.equal(D.OBSERVATION_CODES.FAILED, 'OBSERVATION_FAILED');
  assert.equal(D.OBSERVATION_CODES.DETERMINISTIC, 'OBSERVATION_DETERMINISTIC');
});

test('normalizeHeaderFacts：小写键、排序、排除易变头、非法头丢弃、指纹稳定', () => {
  const facts = D.normalizeHeaderFacts({
    'Content-Type': 'application/json',
    'X-App': 'v1',
    Date: 'Wed, 01 Jan 2026 00:00:00 GMT',
    ETag: '"abc"',
    'bad\nname': 'x',
    'X-Too-Long': 'x'.repeat(D.OBSERVATION_LIMITS.maxHeaderChars + 1),
  });
  assert.equal(facts.headers['content-type'], 'application/json');
  assert.equal(facts.headers['x-app'], 'v1');
  assert.equal(facts.headers.date, undefined);
  assert.equal(facts.headers.etag, undefined);
  assert.equal(facts.volatileHeaders.includes('date'), true);
  assert.equal(facts.volatileHeaders.includes('etag'), true);
  assert.equal(facts.droppedHeaders.includes('bad\nname'), true);
  assert.equal(facts.droppedHeaders.includes('x-too-long'), true);
  assert.equal(facts.count, 2);
  assert.equal(D.normalizeHeaderFacts({ 'X-App': 'v1' }).digest, facts.digest.length > 0 ? D.normalizeHeaderFacts({ 'X-App': 'v1' }).digest : '');
  assert.equal(D.normalizeHeaderFacts(null).count, 0);
});

test('sanitizeJson：深度/条目/字符串长度有界且确定', () => {
  const nested = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };
  const sanitized = D.sanitizeJson(nested, 0, { maxJsonDepth: 2, maxJsonItems: 8 });
  assert.equal(typeof JSON.stringify(sanitized), 'string');
  const list = D.sanitizeJson({ items: new Array(500).fill(1) });
  assert.equal(list.items.length, D.OBSERVATION_LIMITS.maxJsonItems);
  assert.equal(D.sanitizeJson('x'.repeat(1000)).length, 400);
  assert.equal(D.sanitizeJson(undefined), null);
  assert.deepEqual(D.sanitizeJson(nested), D.sanitizeJson(nested));
});

test('parseBodyJson：合法 / 非 JSON / 坏 JSON / 超大有界', () => {
  assert.equal(D.isJsonContentType('application/json; charset=utf-8'), true);
  assert.equal(D.isJsonContentType('application/problem+json'), true);
  assert.equal(D.isJsonContentType('text/html'), false);

  const good = D.parseBodyJson('{"a":1}', 'application/json');
  assert.equal(good.parsed, true);
  assert.deepEqual(good.json, { a: 1 });
  assert.equal(good.kind, 'json-object');

  const list = D.parseBodyJson('[1,2]', 'text/plain');
  assert.equal(list.parsed, true);
  assert.equal(list.kind, 'json-array');

  const html = D.parseBodyJson('<html></html>', 'text/html');
  assert.equal(html.parsed, false);
  assert.equal(html.kind, 'not-json');

  const broken = D.parseBodyJson('{bad json', 'application/json');
  assert.equal(broken.parsed, false);
  assert.equal(broken.kind, 'json-invalid');

  const huge = D.parseBodyJson('{"a":"' + 'x'.repeat(D.OBSERVATION_LIMITS.maxBodyChars) + '"}', 'application/json');
  assert.equal(huge.parsed, false);
  assert.equal(huge.kind, 'json-too-large');

  assert.equal(D.parseBodyJson('', 'application/json').kind, 'empty');
});

// ---------------------------------------------------------------------------
// 观测归一
// ---------------------------------------------------------------------------

test('normalizeReplayObservation：真实 network.replay 结果 → 有界观测 + 语义指纹', () => {
  const observation = D.normalizeReplayObservation(replayResult(), { request: { method: 'GET', url: 'https://a.test/api' } });
  assert.equal(observation.ok, true);
  assert.equal(observation.status, 200);
  assert.equal(observation.statusClass, 200);
  assert.equal(observation.urlKey, 'https://a.test/api');
  assert.equal(observation.redirected, false);
  assert.equal(observation.jsonParsed, true);
  assert.equal(observation.bodyKind, 'json-object');
  assert.equal(observation.headers['x-app'], 'v1');
  assert.equal(observation.bodyBytes > 0, true);
  assert.equal(observation.durationMs, 12);
  assert.equal(observation.hasWallClock, true);
  assert.equal(observation.digest.length > 0, true);
  assert.equal(observation.semantic.bodyDigest.length > 0, true);
  assert.equal(D.normalizeReplayObservation(replayResult()).digest, observation.digest);
});

test('normalizeReplayObservation：重定向/跨源由 request 与最终 URL 判定', () => {
  const observation = D.normalizeReplayObservation(
    replayResult({ url: 'https://b.test/landing', status: 302, body: '' }),
    { request: { method: 'GET', url: 'https://a.test/api' } },
  );
  assert.equal(observation.redirected, true);
  assert.equal(observation.crossOrigin, true);
  assert.equal(observation.requestUrlKey, 'https://a.test/api');
  assert.equal(observation.finalUrlKey, 'https://b.test/landing');
});

test('normalizeReplayObservation：错误结果 / Error 实例 / 非法值都安全收敛', () => {
  const fromErrorResult = D.normalizeReplayObservation({ error: { code: 'E_TIMEOUT', message: 'network replay 超时' } });
  assert.equal(fromErrorResult.ok, false);
  assert.equal(fromErrorResult.error.code, 'E_TIMEOUT');

  const fromThrown = D.normalizeReplayObservation(Object.assign(new Error('fetch 失败：ERR_CONNECTION_REFUSED'), { code: 'E_JS_ERROR' }));
  assert.equal(fromThrown.ok, false);
  assert.equal(fromThrown.error.message.includes('fetch 失败'), true);

  const invalid = D.normalizeReplayObservation(null);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'OBSERVATION_INVALID_RESULT');
});

test('normalizeReplayObservation：正文截断与 header 数量上限显式标记', () => {
  const observation = D.normalizeReplayObservation(replayResult({
    headers: { 'content-type': 'text/plain' },
    body: 'x'.repeat(D.OBSERVATION_LIMITS.maxBodyChars + 10),
  }));
  assert.equal(observation.bodyTruncated, true);
  assert.equal(observation.body.length, D.OBSERVATION_LIMITS.maxBodyChars);
  assert.equal(observation.bodyKind, 'text');
});

test('unwrapReplayResult：兼容直接结果与 {ok:true,result} 包装', () => {
  assert.equal(D.unwrapReplayResult({ status: 200 }).status, 200);
  assert.equal(D.unwrapReplayResult({ ok: true, result: { status: 201 } }).status, 201);
  assert.equal(D.unwrapReplayResult(null), null);
  const wrapped = D.normalizeReplayObservation({ ok: true, result: replayResult() }, { request: { url: 'https://a.test/api' } });
  assert.equal(wrapped.ok, true);
  assert.equal(wrapped.status, 200);
});

test('observationFacts / summarizeObservation / observationDigest 有界稳定', () => {
  const observation = D.normalizeReplayObservation(replayResult());
  const facts = D.observationFacts(observation);
  assert.equal(facts.ok, true);
  assert.equal(facts.status, 200);
  assert.equal(facts.text.includes('"ok":true'), true);
  assert.equal(facts.count, undefined);

  const summary = D.summarizeObservation(observation);
  assert.equal(summary.ok, true);
  assert.equal(summary.status, 200);
  assert.equal(summary.headerCount, 2);
  assert.equal(summary.volatileHeaders.length, 0);
  assert.equal(summary.version, 2);

  assert.equal(D.observationDigest(observation), observation.digest);
  assert.equal(D.observationDigest(null), '');
  assert.equal(D.summarizeObservation(null), null);
});

// ---------------------------------------------------------------------------
// expect 归一 / JSON 子集
// ---------------------------------------------------------------------------

test('normalizeReplayExpectation：标准键 / 网络键 / 未知键分流', () => {
  const normalized = D.normalizeReplayExpectation({
    status: '2xx',
    textIncludes: 'ok',
    statusClass: '2xx',
    bodyJson: { ok: true },
    headers: { 'x-app': 'v1' },
    bodyBytes: { min: 1 },
    maxLatencyMs: 100,
    redirect: 'nope',
  });
  assert.deepEqual(Object.keys(normalized.standard).sort(), ['status', 'textIncludes']);
  assert.deepEqual(Object.keys(normalized.network).sort(), ['bodyBytes', 'bodyJson', 'headers', 'maxLatencyMs', 'statusClass']);
  assert.deepEqual(normalized.unsupported, ['redirect']);
  assert.equal(D.normalizeReplayExpectation(null).empty, true);
});

test('jsonSubsetDiff：子集匹配/缺键/类型/数组长度/volatile 路径跳过/数值容差', () => {
  const match = D.jsonSubsetDiff({ a: 1, b: 'x' }, { a: 1, b: 'x', c: 3 });
  assert.equal(match.differences.length, 0);
  assert.equal(match.compared, 2);

  const missing = D.jsonSubsetDiff({ a: 1, b: 2 }, { a: 1 });
  assert.equal(missing.differences.some((item) => item.path === 'b'), true);

  const type = D.jsonSubsetDiff({ a: { x: 1 } }, { a: 'text' });
  assert.equal(type.differences[0].kind, 'type');

  const array = D.jsonSubsetDiff({ items: [1, 2, 3] }, { items: [1] });
  assert.equal(array.differences.some((item) => item.kind === 'missing'), true);

  const volatile = D.jsonSubsetDiff({ a: 1, ts: 111 }, { a: 1, ts: 222 }, { volatileJsonPaths: ['ts'] });
  assert.equal(volatile.differences.length, 0);
  assert.equal(volatile.volatileSkipped, 1);

  const numeric = D.jsonSubsetDiff({ n: 10 }, { n: 10.0001 }, { tolerance: { numeric: { abs: 1, rel: 0 } } });
  assert.equal(numeric.differences.length, 0);
});

// ---------------------------------------------------------------------------
// expect 判定
// ---------------------------------------------------------------------------

test('evaluateReplayObservation：没有 expect → 观测本身成功即通过', () => {
  const verdict = D.evaluateReplayObservation(networkPlan(), replayResult());
  assert.equal(verdict.ok, true);
  assert.equal(verdict.severity, 'pass');
  assert.equal(verdict.code, D.OBSERVATION_CODES.OK);
  assert.equal(verdict.summary.checked, 0);
  assert.equal(verdict.explanation, null);
  assert.equal(verdict.observed.status, 200);
});

test('evaluateReplayObservation：标准 expect（status/textIncludes）走第一轮 diff 判决', () => {
  const pass = D.evaluateReplayObservation(networkPlan(), replayResult(), { expect: { status: '2xx', textIncludes: '"ok":true' } });
  assert.equal(pass.ok, true);
  assert.equal(pass.summary.checked >= 2, true);

  const fail = D.evaluateReplayObservation(networkPlan(), replayResult(), { expect: { status: 500, textIncludes: 'nope' } });
  assert.equal(fail.ok, false);
  assert.equal(fail.severity, 'fail');
  assert.equal(fail.differences.some((item) => String(item.code || '').startsWith('DIFF_')), true);
  assert.equal(fail.explanation !== null, true);
});

test('evaluateReplayObservation：状态族 / 正文包含 / 正文精确', () => {
  const statusClass = D.evaluateReplayObservation(networkPlan(), replayResult(), { expect: { statusClass: '2xx' } });
  assert.equal(statusClass.ok, true);
  const badClass = D.evaluateReplayObservation(networkPlan(), replayResult({ status: 404 }), { expect: { statusClass: '2xx' } });
  assert.equal(badClass.ok, false);

  const includes = D.evaluateReplayObservation(networkPlan(), replayResult(), { expect: { bodyIncludes: ['"ok":true', '"items"'] } });
  assert.equal(includes.ok, true);
  const missing = D.evaluateReplayObservation(networkPlan(), replayResult(), { expect: { bodyIncludes: 'not-there' } });
  assert.equal(missing.ok, false);
  assert.equal(missing.differences.some((item) => item.path.includes('bodyIncludes')), true);

  const bodyText = D.evaluateReplayObservation(networkPlan(), replayResult({ body: 'hello world' }), { expect: { bodyText: 'hello world' } });
  assert.equal(bodyText.ok, true);
});

test('evaluateReplayObservation：bodyJson 子集 / 非 JSON 正文', () => {
  const pass = D.evaluateReplayObservation(networkPlan(), replayResult(), { expect: { bodyJson: { ok: true, items: [1, 2, 3] } } });
  assert.equal(pass.ok, true);
  const fail = D.evaluateReplayObservation(networkPlan(), replayResult(), { expect: { bodyJson: { ok: false } } });
  assert.equal(fail.ok, false);
  assert.equal(fail.differences.some((item) => item.path.startsWith('bodyJson')), true);

  const notJson = D.evaluateReplayObservation(networkPlan(), replayResult({ headers: { 'content-type': 'text/plain' }, body: 'plain' }), { expect: { bodyJson: { ok: true } } });
  assert.equal(notJson.ok, false);
  const difference = notJson.differences.find((item) => item.path === 'bodyJson');
  assert.equal(difference.kind, 'missing');
});

test('evaluateReplayObservation：headers / contentType / bodyBytes', () => {
  const headers = D.evaluateReplayObservation(networkPlan(), replayResult(), {
    expect: { headers: { 'content-type': { includes: 'json' }, 'x-app': 'v1', 'x-missing': { exists: true } } },
  });
  assert.equal(headers.ok, false); // x-missing 不存在
  assert.equal(headers.checks.some((check) => check.key === 'headers:x-missing' && check.ok === false), true);
  assert.equal(headers.checks.some((check) => check.key === 'headers:content-type' && check.ok === true), true);

  const volatile = D.evaluateReplayObservation(networkPlan(), replayResult(), { expect: { headers: { etag: '"abc"' } } });
  assert.equal(volatile.ok, true);
  assert.equal(volatile.checks.some((check) => check.code === D.OBSERVATION_CODES.HEADER_VOLATILE && check.severity === 'warning'), true);

  const contentType = D.evaluateReplayObservation(networkPlan(), replayResult(), { expect: { contentType: 'json' } });
  assert.equal(contentType.ok, true);

  const bytes = D.evaluateReplayObservation(networkPlan(), replayResult(), { expect: { bodyBytes: { min: 1, max: 10000 } } });
  assert.equal(bytes.ok, true);
  const tooBig = D.evaluateReplayObservation(networkPlan(), replayResult(), { expect: { bodyBytes: { max: 1 } } });
  assert.equal(tooBig.ok, false);
});

test('evaluateReplayObservation：latency / redirected / finalUrl', () => {
  const latencyOk = D.evaluateReplayObservation(networkPlan(), replayResult(), { expect: { maxLatencyMs: 100 } });
  assert.equal(latencyOk.ok, true);
  const latencyBad = D.evaluateReplayObservation(networkPlan(), replayResult(), { expect: { maxLatencyMs: 1 } });
  assert.equal(latencyBad.ok, false);
  const unmeasured = D.evaluateReplayObservation(networkPlan(), replayResult({ durationMs: undefined }), { expect: { maxLatencyMs: 1 } });
  assert.equal(unmeasured.ok, true);
  assert.equal(unmeasured.checks.some((check) => check.code === D.OBSERVATION_CODES.LATENCY_UNMEASURED && check.severity === 'warning'), true);

  const redirected = D.evaluateReplayObservation(networkPlan(), replayResult({ url: 'https://b.test/x' }), { expect: { redirected: true } });
  assert.equal(redirected.ok, true);
  const notRedirected = D.evaluateReplayObservation(networkPlan(), replayResult(), { expect: { redirected: true } });
  assert.equal(notRedirected.ok, false);

  const finalUrl = D.evaluateReplayObservation(networkPlan(), replayResult({ url: 'https://a.test/other' }), { expect: { finalUrlIncludes: '/other' } });
  assert.equal(finalUrl.ok, true);
});

test('evaluateReplayObservation：观测失败 → OBSERVATION_FAILED + 可解释', () => {
  const verdict = D.evaluateReplayObservation(networkPlan(), { error: { code: 'E_JS_ERROR', message: 'fetch 失败：net::ERR_FAILED' } });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, D.OBSERVATION_CODES.FAILED);
  assert.equal(verdict.explanation.code, 'PLAN_INVALID_INPUT'); // E_* 未知码按目录归一到 plan 类
  assert.equal(verdict.explanation.category, 'plan');
  assert.equal(verdict.observed.ok, false);
});

test('evaluateReplayObservation：plan.steps[0].expect 被默认消费', () => {
  const plan = networkPlan({ status: 200, textIncludes: '"ok":true' });
  const pass = D.evaluateReplayObservation(plan, replayResult());
  assert.equal(pass.ok, true);
  const fail = D.evaluateReplayObservation(plan, replayResult({ status: 500 }));
  assert.equal(fail.ok, false);
});

test('evaluateReplayObservation：未知 expect 键显式 unsupported（不静默通过）', () => {
  const verdict = D.evaluateReplayObservation(networkPlan(), replayResult(), { expect: { status: 200, totallyUnknown: 1 } });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.unsupported, ['totallyUnknown']);
  assert.equal(verdict.summary.unsupported, 1);
});

// ---------------------------------------------------------------------------
// 确定性 diff（两次真实回放）
// ---------------------------------------------------------------------------

test('diffReplayObservations：完全一致 → deterministic；易变 header/耗时不影响', () => {
  const left = replayResult({ headers: { 'content-type': 'application/json', 'x-app': 'v1', date: 'now', etag: 'a' }, durationMs: 10 });
  const right = replayResult({ headers: { 'content-type': 'application/json', 'x-app': 'v1', date: 'later', etag: 'b' }, durationMs: 99, body: left.body });
  const diff = D.diffReplayObservations(left, right);
  assert.equal(diff.same, true);
  assert.equal(diff.deterministic, true);
  assert.equal(diff.code, D.OBSERVATION_CODES.DETERMINISTIC);
  assert.equal(diff.ignored.latency, true);
  assert.equal(diff.ignored.headers.includes('date'), true);
  assert.equal(diff.digests.left, diff.digests.right);
});

test('diffReplayObservations：状态/正文/header 任一不同 → diverged 且路径可定位', () => {
  const base = replayResult();
  const statusDiff = D.diffReplayObservations(base, replayResult({ status: 500 }));
  assert.equal(statusDiff.deterministic, false);
  assert.equal(statusDiff.differences.some((item) => item.path === 'status'), true);

  const bodyDiff = D.diffReplayObservations(base, replayResult({ body: '{"ok":false}' }));
  assert.equal(bodyDiff.deterministic, false);
  assert.equal(bodyDiff.differences.some((item) => item.path.startsWith('bodyJson')), true);

  const headerDiff = D.diffReplayObservations(base, replayResult({ headers: { 'content-type': 'application/json', 'x-app': 'v2' } }));
  assert.equal(headerDiff.deterministic, false);
  assert.equal(headerDiff.differences.some((item) => item.path === 'headers.x-app'), true);
});

test('diffReplayObservations：volatile JSON 路径与 ignoreHeaders/ignoreQuery 可豁免', () => {
  const left = replayResult({ body: '{"ok":true,"ts":100,"id":"x"}' });
  const right = replayResult({ body: '{"ok":true,"ts":200,"id":"x"}' });
  const strict = D.diffReplayObservations(left, right);
  assert.equal(strict.deterministic, false);
  const withVolatile = D.diffReplayObservations(left, right, { volatileJsonPaths: ['ts'] });
  assert.equal(withVolatile.deterministic, true);

  const headers = D.diffReplayObservations(replayResult(), replayResult({ headers: { 'content-type': 'application/json', 'x-app': 'v2' } }), { ignoreHeaders: ['x-app'] });
  assert.equal(headers.deterministic, true);

  const queries = D.diffReplayObservations(
    replayResult({ url: 'https://a.test/api?page=1' }),
    replayResult({ url: 'https://a.test/api?page=2' }),
    { ignoreQuery: true },
  );
  assert.equal(queries.deterministic, true);
});

test('diffReplayObservations：两侧同样的失败 → deterministic；成功 vs 失败 → diverged', () => {
  const bothTimeout = D.diffReplayObservations({ error: { code: 'E_TIMEOUT', message: 'timeout' } }, { error: { code: 'E_TIMEOUT', message: 'timeout again' } });
  assert.equal(bothTimeout.deterministic, true);
  assert.equal(bothTimeout.compared.errorOnly, true);

  const mixed = D.diffReplayObservations(replayResult(), { error: { code: 'E_TIMEOUT', message: 'timeout' } });
  assert.equal(mixed.deterministic, false);
  assert.equal(mixed.differences.some((item) => item.path === 'error.code'), true);
});

// ---------------------------------------------------------------------------
// 消费入口 / 摘要 / 文本
// ---------------------------------------------------------------------------

test('consumeReplayObservation：单次成功 → ok；挂到字段的 observed/digest 稳定', () => {
  const plan = networkPlan({ status: '2xx' });
  const first = D.consumeReplayObservation(plan, { result: replayResult() });
  const second = D.consumeReplayObservation(plan, { result: replayResult() });
  assert.equal(first.ok, true);
  assert.equal(first.verdict.ok, true);
  assert.equal(first.determinism, null);
  assert.equal(first.observed.status, 200);
  assert.equal(first.digest, second.digest);
});

test('consumeReplayObservation：两次回放 → 确定性字段；失败/发散都判 ok=false', () => {
  const plan = networkPlan({ status: '2xx' });
  const stable = D.consumeReplayObservation(plan, { result: replayResult(), secondResult: replayResult() });
  assert.equal(stable.ok, true);
  assert.equal(stable.determinism.deterministic, true);

  const diverged = D.consumeReplayObservation(plan, { result: replayResult({ status: 500 }), secondResult: replayResult() });
  assert.equal(diverged.ok, false);
  assert.equal(diverged.determinism.deterministic, false);

  const failed = D.consumeReplayObservation(plan, { error: { code: 'E_TIMEOUT', message: 'timeout' } });
  assert.equal(failed.ok, false);
  assert.equal(failed.verdict.code, D.OBSERVATION_CODES.FAILED);
});

test('formatObservationDiff / summarizeObservationVerdict 有界稳定', () => {
  const diff = D.diffReplayObservations(replayResult(), replayResult({ status: 500 }));
  const text = D.formatObservationDiff(diff);
  assert.equal(text.includes('不一致'), true);
  assert.equal(text.split('\n').length <= 20, true);
  assert.equal(D.formatObservationDiff(null), '观测 diff：无结果');

  const verdict = D.evaluateReplayObservation(networkPlan(), replayResult(), { expect: { status: 500 } });
  const summary = D.summarizeObservationVerdict(verdict);
  assert.equal(summary.ok, false);
  assert.equal(summary.differences.total >= 1, true);
  assert.equal(summary.observed.status, 200);
  assert.equal(D.summarizeObservationVerdict(null), null);
});

test('差异执行层源码确定性门禁：不含 Date.now / Math.random', () => {
  const source = fs.readFileSync(path.join(ROOT, 'extension/src/lib/replay-diff-exec.js'), 'utf8');
  assert.equal(/Date\.now\s*\(/.test(source), false);
  assert.equal(/Math\.random\s*\(/.test(source), false);
});
