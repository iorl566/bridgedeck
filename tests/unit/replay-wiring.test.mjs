// tests/unit/replay-wiring.test.mjs —— 回放接线层：既有命令路径的消费点守卫 + 端到端包装。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as R from '../../extension/src/replay.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function source(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function requireFile(relative) {
  assert.equal(fs.existsSync(path.join(ROOT, relative)), true, '缺少文件 ' + relative);
}

test('既有回放命令路径仍然存在（接线目标守卫）', () => {
  requireFile('extension/src/dispatch.js');
  requireFile('extension/src/network.js');
  requireFile('extension/src/bridge.js');
  requireFile('extension/src/debug.js');
  requireFile('extension/src/record-program.js');
  requireFile('extension/src/record-events.js');
  requireFile('cli/commands/network.mjs');
  requireFile('cli/commands/debug.mjs');
  requireFile('mcp/tools-debug-a.mjs');

  // 接线后命令表指向包装层（还原计划/解释/差异校验），包装层内部仍调用既有 networkReplay。
  assert.equal(source('extension/src/dispatch.js').includes("'network.replay': (params) => replayNetworkCommand(params)"), true);
  assert.equal(source('extension/src/network.js').includes('export async function networkReplay(params = {})'), true);
  assert.equal(source('extension/src/bridge.js').includes("'bb.debug.replay'"), true);
  assert.equal(source('extension/src/bridge.js').includes('replayDebugCommand({ tabId: message.tabId, id: message.id, overrides: message.overrides })'), true);
  assert.equal(source('extension/src/debug.js').includes("'replay',"), true);
  assert.equal(source('extension/src/debug.js').includes('replay: true'), true);
  assert.equal(source('extension/src/record-program.js').includes('export function preflightReplay(stepsOrProgram, options = {})'), true);
  assert.equal(source('extension/src/record-events.js').includes('export function summarizeRecording(events)'), true);
  assert.equal(source('cli/commands/network.mjs').includes("callRpc('network.replay'"), true);
  assert.equal(source('cli/commands/debug.mjs').includes("callRpc('network.replay'"), true);
  assert.equal(source('mcp/tools-debug-a.mjs').includes("rpc('network.replay'"), true);
});

test('接线元数据：命令路径声明与文件一致；lib/replay-* 都被消费（防死代码）', () => {
  assert.equal(R.REPLAY_COMMAND_PATHS.length, 9);
  for (const entry of R.REPLAY_COMMAND_PATHS) {
    assert.equal(typeof entry.command, 'string');
    assert.equal(typeof entry.symbol, 'string');
    assert.equal(fs.existsSync(path.join(ROOT, entry.file)), true, '命令路径文件不存在：' + entry.file);
  }
  // 每个 lib/replay-*.js 都必须被 replay.js 或另一个 replay 模块 import（与 unused-extension-modules 审计口径一致）。
  const libDir = path.join(ROOT, 'extension', 'src', 'lib');
  const replayLibs = fs.readdirSync(libDir).filter((name) => /^replay-.*\.js$/.test(name));
  assert.equal(replayLibs.length >= 9, true);
  const consumers = [source('extension/src/replay.js'), source('extension/src/replay-plan.js'), source('extension/src/replay-execution.js')];
  for (const name of replayLibs) consumers.push(source('extension/src/lib/' + name));
  const corpus = consumers.join('\n');
  for (const name of replayLibs) {
    assert.equal(corpus.includes("'./" + name + "'") || corpus.includes("'./lib/" + name + "'"), true, '未被消费：' + name);
  }
  // 单测必须是 chrome 无关的；但 MV3 service worker 禁止动态 import()，
  // 因此命令包装层对 ./network.js 必须是静态 import（曾经的动态 import 在真实 SW 里
  // 会抛 "import() is disallowed on ServiceWorkerGlobalScope"，E2E 20b/33d 已复现）。
  const replaySource = source('extension/src/replay.js');
  assert.equal(/^import\s+.*from\s+'\.\/network\.js'/m.test(replaySource), true);
  assert.equal(replaySource.includes('await import('), false);
});

test('normalizeReplayParams / parseReplayUrl / normalizeReplayHeaders', () => {
  const normalized = R.normalizeReplayParams({ tabId: 3, id: 7, request: { url: 'https://a.test/' }, overrides: { method: 'post' }, junk: true });
  assert.equal(normalized.tabId, 3);
  assert.equal(normalized.id, 7);
  assert.equal(normalized.junk, undefined);
  assert.deepEqual(R.normalizeReplayParams(null), {});

  const parsed = R.parseReplayUrl('https://a.test/p?q=1#h');
  assert.equal(parsed.origin, 'https://a.test');
  assert.equal(parsed.hasQuery, true);
  assert.equal(R.parseReplayUrl('ftp://a.test/'), null);
  assert.equal(R.parseReplayUrl('https://user:pass@a.test/'), null);
  assert.equal(R.parseReplayUrl('https://a.test/[redacted]'), null);
  assert.equal(R.parseReplayUrl(''), null);

  const headers = R.normalizeReplayHeaders({ Cookie: 'x', 'X-Test': 'v', 'bad\nname': 'x', 'X-Redacted': '[redacted]' });
  assert.equal(headers.headers['x-test'], 'v');
  assert.equal(headers.dropped.includes('cookie'), true);
  assert.equal(headers.invalid.includes('bad\nname'), true);
  assert.equal(headers.invalid.includes('x-redacted'), true);
});

test('extractNetworkReplay / validateNetworkReplay：request 与 id 两种既有形状', () => {
  const fromRequest = R.extractNetworkReplay({
    tabId: 1,
    request: { url: 'https://a.test/api?q=1', method: 'post', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' },
  });
  assert.equal(fromRequest.method, 'POST');
  assert.equal(fromRequest.hasBody, true);
  assert.equal(fromRequest.bodyBytes, 7);
  assert.equal(fromRequest.hasRecordedEntry, false);
  assert.equal(R.validateNetworkReplay(fromRequest).ok, true);

  const fromId = R.extractNetworkReplay({ tabId: 1, id: 5 });
  assert.equal(fromId.hasRecordedEntry, true);
  assert.equal(fromId.url, '');
  const idValidation = R.validateNetworkReplay(fromId);
  assert.equal(idValidation.ok, true);
  assert.equal(idValidation.warnings.some((warning) => warning.code === 'NETWORK_REPLAY_MISSING_ENTRY'), true);

  const badUrl = R.extractNetworkReplay({ tabId: 1, request: { url: 'ftp://x', method: 'GET' } });
  assert.equal(R.validateNetworkReplay(badUrl).blockers.some((blocker) => blocker.code === 'NETWORK_REPLAY_BAD_URL'), true);
  const badMethod = R.extractNetworkReplay({ tabId: 1, request: { url: 'https://a.test/', method: 'BREW' } });
  assert.equal(R.validateNetworkReplay(badMethod).blockers.some((blocker) => blocker.code === 'NETWORK_REPLAY_BAD_METHOD'), true);
  const getWithBody = R.extractNetworkReplay({ tabId: 1, request: { url: 'https://a.test/', method: 'GET', body: 'x' } });
  assert.equal(R.validateNetworkReplay(getWithBody).blockers.some((blocker) => blocker.code === 'NETWORK_REPLAY_BODY_UNSAFE'), true);
  const redacted = R.extractNetworkReplay({ tabId: 1, request: { url: 'https://a.test/', method: 'POST', body: '[redacted]' } });
  assert.equal(R.validateNetworkReplay(redacted).blockers.some((blocker) => blocker.code === 'NETWORK_REPLAY_REDACTED'), true);
  const crossOrigin = R.extractNetworkReplay(
    { tabId: 1, request: { url: 'https://b.test/api', method: 'GET' } },
    { current: { url: 'https://a.test/page', documentId: 'doc-1' } },
  );
  assert.equal(crossOrigin.crossOrigin, true);
  assert.equal(R.validateNetworkReplay(crossOrigin).warnings.some((warning) => warning.code === 'NETWORK_REPLAY_CROSS_ORIGIN'), true);
});

test('planNetworkReplay / planDebugReplay：计划 + network 字段，默认不阻断正常重放', () => {
  const plan = R.planNetworkReplay({ tabId: 1, id: 3, overrides: { url: 'https://a.test/api', method: 'POST', body: '{"a":1}' } });
  assert.equal(plan.ok, true);
  assert.equal(plan.source, R.REPLAY_SOURCES.NETWORK);
  assert.equal(plan.network.method, 'POST');
  assert.equal(plan.network.hasBody, true);
  assert.equal(plan.network.sideEffect, true);
  assert.equal(plan.network.urlResolved, true);
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].kind, 'network');

  const invalid = R.planNetworkReplay({ tabId: 1, request: { url: 'ftp://x', method: 'NOPE' } });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.blockers.some((blocker) => blocker.code === 'NETWORK_REPLAY_BAD_URL'), true);
  assert.equal(invalid.blockers.some((blocker) => blocker.code === 'NETWORK_REPLAY_BAD_METHOD'), true);

  const debug = R.planDebugReplay({ tabId: 9, id: 4, overrides: { url: 'https://a.test/x' } });
  assert.equal(debug.source, R.REPLAY_SOURCES.DEBUG);
  assert.equal(debug.debug.tabId, 9);
  assert.equal(debug.debug.hasOverrides, true);
  assert.equal(debug.ok, true);
});

test('planRecordReplay：record export 消费（预检 token / 副作用 / 空录制）', () => {
  const step = {
    model: 2,
    ref: 'r1',
    kind: 'action',
    method: 'click',
    params: { selector: '#go' },
    target: { selector: '#go' },
    idempotent: false,
    fallback: { onError: 'stop' },
    risk: 'browser_mutation',
    evidence: { seq: 1, index: 0, frameId: 0, documentId: 'd1', revision: 1, url: 'https://a.test/', actor: 'human', at: 1 },
  };
  const blocked = R.planRecordReplay([step]);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blockers.some((blocker) => blocker.code === 'REPLAY_SIDE_EFFECT'), true);
  assert.equal(blocked.record.preflight.ok, false);

  const allowed = R.planRecordReplay([step], { allowNonIdempotent: true });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.source, R.REPLAY_SOURCES.RECORD);
  assert.equal(allowed.record.preflight.token.startsWith('rp-'), true);
  assert.equal(allowed.record.steps, 1);

  const fromEvents = R.planRecordReplay({ events: [{ recordStep: step }] }, { allowNonIdempotent: true });
  assert.equal(fromEvents.ok, true);
  assert.equal(fromEvents.record.sourceSteps, 1);

  const empty = R.planRecordReplay([]);
  assert.equal(empty.ok, false);
  assert.equal(empty.blockers.some((blocker) => blocker.code === 'PLAN_EMPTY'), true);
  assert.equal(R.extractRecordReplaySteps([]).length, 0);
  assert.equal(R.extractRecordReplaySteps(null).length, 0);
});

test('prepareReplay：来源分发与未知来源的显式失败', () => {
  assert.equal(R.prepareReplay('network', { tabId: 1, id: 1 }).source, R.REPLAY_SOURCES.NETWORK);
  assert.equal(R.prepareReplay('debug', { tabId: 1, id: 1 }).source, R.REPLAY_SOURCES.DEBUG);
  assert.equal(R.prepareReplay('record', [], { allowNonIdempotent: true }).source, R.REPLAY_SOURCES.RECORD);
  const unknown = R.prepareReplay('mystery', {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.blockers.some((blocker) => blocker.code === 'PLAN_INVALID_INPUT'), true);
});

test('withReplayFields：默认行为不变（null 返回同一引用）、只加字段、不改入参', () => {
  const result = { ok: true, status: 200, body: { a: 1 } };
  assert.equal(R.withReplayFields(result, null), result);
  assert.equal(R.withReplayFields(result, undefined), result);
  assert.equal(R.withReplayFields('text', { x: 1 }), 'text');
  const field = { token: 'rp1-x', ok: true };
  const attached = R.withReplayFields(result, field);
  assert.notEqual(attached, result);
  assert.equal(attached.ok, true);
  assert.equal(attached.status, 200);
  assert.deepEqual(attached[R.REPLAY_FIELD], field);
  assert.equal(result[R.REPLAY_FIELD], undefined);
  assert.equal(R.withReplayFields(result, field, { field: 'extra' }).extra.token, 'rp1-x');
  assert.equal(R.replayFieldOf(attached).token, 'rp1-x');
  assert.equal(R.replayFieldOf(result), null);
});

test('buildReplayField：有界、稳定、含计划摘要与 network/record 字段', () => {
  const plan = R.planNetworkReplay({ tabId: 1, id: 2, overrides: { url: 'https://a.test/api' } });
  const field = R.buildReplayField(plan, { executed: true });
  assert.equal(field.version, R.REPLAY_WIRING_VERSION);
  assert.equal(field.executed, true);
  assert.equal(field.token, plan.token);
  assert.equal(field.network.method, 'GET');
  assert.equal(field.boundaries.version, 1);
  assert.equal(field.targets.version, 1);
  assert.equal(field.blockers.length <= 8, true);
  assert.equal(R.serializeReplayField(field), R.serializeReplayField(field));

  const withOutcome = R.buildReplayField(plan, { outcome: { ok: true, status: 200 }, step: {} });
  assert.equal(withOutcome.outcome.ok, true);
  assert.equal(withOutcome.outcome.severity, 'pass');
  const executed = R.consumeReplayResult({ ok: true, status: 200 }, plan, { executed: true });
  assert.equal(executed.replay.executed, true);
  const untouched = { ok: true };
  assert.equal(R.consumeReplayResult(untouched, null), untouched);
});

test('attachReplayFailure / explainReplayError：原错误码与 message 不变，只加不可枚举字段', () => {
  const error = Object.assign(new Error('boom'), { code: 'E_BAD_ARG' });
  const explained = R.explainReplayError(error, null);
  assert.equal(explained, error);
  assert.equal(error.code, 'E_BAD_ARG');
  assert.equal(error.message, 'boom');
  assert.equal(error[R.REPLAY_FAILURE_FIELD].code, 'PLAN_INVALID_INPUT');
  assert.equal(Object.keys(error).includes(R.REPLAY_FAILURE_FIELD), false);
  const frozen = Object.freeze(new Error('frozen'));
  assert.equal(R.attachReplayFailure(frozen, { code: 'X' }), frozen);
  assert.equal(R.attachReplayFailure('string', { code: 'X' }), 'string');
});

test('replayNetworkCommand / replayDebugCommand：走既有 networkReplay，失败保留原错误并附解释', async () => {
  await assert.rejects(
    () => R.replayNetworkCommand({}),
    (error) => {
      assert.equal(error.code, 'E_BAD_ARG');
      assert.equal(Boolean(error[R.REPLAY_FAILURE_FIELD]), true);
      assert.equal(error[R.REPLAY_FAILURE_FIELD].category, 'plan');
      assert.equal(R.replayFailureOf(error).category, 'plan');
      return true;
    },
  );
  await assert.rejects(
    () => R.replayDebugCommand({}),
    (error) => {
      assert.equal(error.code, 'E_BAD_ARG');
      assert.equal(Boolean(error[R.REPLAY_FAILURE_FIELD]), true);
      assert.equal(R.replayFailureOf(error).code, 'PLAN_INVALID_INPUT');
      return true;
    },
  );
  assert.equal(R.replayFailureOf(null), null);
  assert.equal(R.replayFailureOf(new Error('plain')), null);
});

test('consumeRecordExport / replayCapabilities / replayReport / checkReplayPlan', () => {
  const exportResult = { ok: true };
  assert.equal(R.consumeRecordExport(exportResult, null), exportResult);
  const exported = R.consumeRecordExport({ ok: true, steps: 1 }, [{ recordStep: { ref: 'r1', kind: 'action', method: 'click', params: { selector: '#a' }, target: { selector: '#a' }, idempotent: true, evidence: { documentId: 'd', frameId: 0, revision: 1, url: 'https://a.test/' } } }], { allowNonIdempotent: true });
  assert.equal(exported.ok, true);
  assert.equal(exported.replay.source, R.REPLAY_SOURCES.RECORD);

  const capabilities = R.replayCapabilities();
  assert.equal(capabilities.plan, true);
  assert.equal(capabilities.determinism, true);
  assert.deepEqual(capabilities.sources, [R.REPLAY_SOURCES.NETWORK, R.REPLAY_SOURCES.DEBUG, R.REPLAY_SOURCES.RECORD]);
  assert.equal(capabilities.commandPaths.length, R.REPLAY_COMMAND_PATHS.length);
  assert.equal(capabilities.fields.result, R.REPLAY_FIELD);

  const plan = R.planNetworkReplay({ tabId: 1, id: 1, overrides: { url: 'https://a.test/' } });
  const report = R.replayReport(plan, [{ index: 0, ok: true, severity: 'pass', code: 'DIFF_OK' }]);
  assert.equal(typeof report.ok, 'boolean');
  assert.equal(typeof report.plan.token, 'string');
  assert.equal(Array.isArray(report.checks), true);
  assert.equal(report.plan.token, plan.token);
  assert.equal(R.checkReplayPlan(plan).ok, true);
});
