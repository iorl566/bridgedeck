// tests/unit/replay-execution-wiring.test.mjs —— 第二轮接线：真实命令路径附加执行/观测/边界/矩阵字段。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as R from '../../extension/src/replay.js';
import { planBoundaryRestoration } from '../../extension/src/lib/replay-boundary-plan.js';
import { recordExecutionOutcomes } from '../../extension/src/lib/replay-executor.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function successResult(overrides = {}) {
  return {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json', 'x-app': 'v1' },
    body: '{"ok":true}',
    durationMs: 5,
    url: 'https://a.test/api',
    ...overrides,
  };
}

function executeReturning(result, counter) {
  return async () => {
    if (counter) counter.calls += 1;
    return { ...result };
  };
}

function networkParams(overrides = {}) {
  return { tabId: 1, request: { url: 'https://a.test/api', method: 'GET' }, ...overrides };
}

function boundarySteps() {
  return [
    {
      ref: 'r1',
      kind: 'action',
      method: 'click',
      params: { selector: '#a' },
      target: { selector: '#a' },
      idempotent: true,
      evidence: { documentId: 'doc-1', frameId: 0, revision: 1, url: 'https://a.test/' },
      boundary: { documentId: 'doc-1', frameId: 0, revision: 1, url: 'https://a.test/' },
    },
    {
      ref: 'r2',
      kind: 'branch',
      method: 'navigate',
      params: {},
      target: null,
      idempotent: true,
      branch: { boundary: 'document', url: 'https://b.test/' },
      evidence: { documentId: 'doc-2', frameId: 0, revision: 1, url: 'https://b.test/' },
      boundary: { documentId: 'doc-2', frameId: 0, revision: 1, url: 'https://b.test/' },
    },
  ];
}

function traceEntries() {
  return [
    { kind: 'identity', documentId: 'doc-1', frameId: 0, url: 'https://a.test/' },
    { kind: 'identity', documentId: 'doc-2', frameId: 0, url: 'https://b.test/' },
  ];
}

// ---------------------------------------------------------------------------
// 版本 / 能力
// ---------------------------------------------------------------------------

test('第二轮导出：执行/边界/观测/矩阵版本与字段名', () => {
  assert.equal(R.REPLAY_EXECUTION_VERSION, 2);
  assert.equal(R.REPLAY_EXECUTION_FIELD, 'replayExecution');
  assert.equal(R.REPLAY_BOUNDARY_EXECUTION_VERSION, 2);
  assert.equal(R.REPLAY_OBSERVATION_EXEC_VERSION, 2);
  assert.equal(R.REPLAY_FAILURE_MATRIX_VERSION_OUT, 2);
  assert.equal(R.REPLAY_MATRIX_CODES.TIMEOUT, 'MATRIX_TIMEOUT');
  assert.equal(typeof R.replayExecutionOf, 'function');
});

test('replayExecutionCapabilities / replayCapabilities：既有字段不变，新能力只加字段', () => {
  const capabilities = R.replayCapabilities();
  assert.equal(capabilities.plan, true);
  assert.equal(capabilities.determinism, true);
  assert.equal(capabilities.execution, true);
  assert.equal(capabilities.boundaryExecution, true);
  assert.equal(capabilities.observationDiff, true);
  assert.equal(capabilities.failureMatrix, true);
  assert.equal(capabilities.executionVersion, 2);
  assert.deepEqual(capabilities.sources, [R.REPLAY_SOURCES.NETWORK, R.REPLAY_SOURCES.DEBUG, R.REPLAY_SOURCES.RECORD]);
  assert.equal(capabilities.commandPaths.length, R.REPLAY_COMMAND_PATHS.length);

  const execution = R.replayExecutionCapabilities();
  assert.equal(execution.version, 2);
  assert.equal(execution.execution.deterministic, true);
  assert.equal(execution.execution.hasWallClock, false);
  assert.equal(execution.failureMatrix.catalogOk, true);
  assert.equal(execution.failureMatrix.cells, 17);
  assert.deepEqual(execution.boundaryExecution.actions, ['navigate', 'frame-switch', 'tab-switch', 'resume']);
  assert.equal(execution.commands.includes('replayNetworkCommandTwice'), true);
});

// ---------------------------------------------------------------------------
// replayNetworkCommand：真实路径只执行一次 + 只加字段
// ---------------------------------------------------------------------------

test('replayNetworkCommand：成功路径只调一次执行器，既有结果字段逐字保留', async () => {
  const counter = { calls: 0 };
  const original = successResult();
  const result = await R.replayNetworkCommand(networkParams(), { execute: executeReturning(original, counter) });
  assert.equal(counter.calls, 1); // 绝不因为附加执行证据而双发请求
  const { replay, ...rest } = result;
  assert.deepEqual(rest, original);
  assert.equal(replay.executed, true);
  assert.equal(replay.version, R.REPLAY_WIRING_VERSION);
  assert.equal(replay.execution.ok, true);
  assert.equal(replay.execution.passed, 1);
  assert.equal(replay.execution.planned, 1);
  assert.equal(replay.executionEnvelope.deterministic, true);
  assert.equal(replay.executionEnvelope.hasWallClock, false);
  assert.equal(replay.executionEnvelope.fingerprint, replay.execution.envelopeFingerprint);
  assert.equal(replay.observation.status, 200);
  assert.equal(replay.observation.ok, true);
  assert.equal(replay.verdict.ok, true);
  assert.equal(replay.verdict.summary.checked, 0);
  assert.equal(replay.network.method, 'GET');
});

test('replayNetworkCommand：同一输入两次 → 同计划指纹/同执行信封/同副作用语义', async () => {
  const run = () => R.replayNetworkCommand(networkParams(), { execute: executeReturning(successResult()) });
  const first = await run();
  const second = await run();
  assert.equal(first.replay.token, second.replay.token);
  assert.equal(first.replay.fingerprint, second.replay.fingerprint);
  assert.equal(first.replay.executionEnvelope.fingerprint, second.replay.executionEnvelope.fingerprint);
  assert.equal(first.replay.execution.envelopeFingerprint, second.replay.execution.envelopeFingerprint);
  assert.deepEqual(first.replay.executionEnvelope.sideEffects, second.replay.executionEnvelope.sideEffects);
  assert.equal(first.replay.observation.bodyDigest, second.replay.observation.bodyDigest);
  assert.equal(first.replay.execution.semanticFingerprint, second.replay.execution.semanticFingerprint);
});

test('replayNetworkCommand：POST 有计划摘要、执行账本与副作用语义（写请求）', async () => {
  const params = { tabId: 1, request: { url: 'https://a.test/api', method: 'POST', body: '{"a":1}' } };
  const result = await R.replayNetworkCommand(params, { execute: executeReturning(successResult({ status: 201, body: '{"id":1}' })) });
  assert.equal(result.replay.executed, true);
  assert.equal(result.replay.executionEnvelope.sideEffects.mutating, true);
  assert.equal(result.replay.executionEnvelope.sideEffects.networkRequests, 1);
  assert.equal(result.replay.execution.effects, 1);
  assert.equal(result.replay.observation.status, 201);
});

test('replayNetworkCommand：expect 判定消费真实结果（通过/不通过都不抛）', async () => {
  const pass = await R.replayNetworkCommand(networkParams(), {
    execute: executeReturning(successResult()),
    expect: { status: '2xx', bodyJson: { ok: true } },
  });
  assert.equal(pass.replay.verdict.ok, true);
  assert.equal(pass.replay.verdict.summary.checked >= 2, true);
  assert.equal(pass.replay.execution.ok, true);

  const fail = await R.replayNetworkCommand(networkParams(), {
    execute: executeReturning(successResult()),
    expect: { status: 500 },
  });
  assert.equal(fail.replay.verdict.ok, false);
  assert.equal(fail.replay.execution.ok, false);
  assert.equal(fail.replay.execution.failed, 1);
  assert.equal(fail.replay.execution.firstFailure !== null, true);
});

test('replayNetworkCommand：enrich:false 返回原结果引用（默认行为不变）', async () => {
  const raw = successResult();
  const result = await R.replayNetworkCommand(networkParams(), { execute: async () => raw, enrich: false });
  assert.equal(result, raw);
  assert.equal(result[R.REPLAY_FIELD], undefined);
});

test('replayNetworkCommand：失败保留原错误码/信息，附 replayFailure + 失败矩阵恢复建议 + 执行证据', async () => {
  const error = Object.assign(new Error('network replay 超时（15000ms）'), { code: 'E_TIMEOUT' });
  await assert.rejects(
    () => R.replayNetworkCommand(networkParams(), { execute: async () => { throw error; } }),
    (thrown) => {
      assert.equal(thrown, error);
      assert.equal(thrown.code, 'E_TIMEOUT');
      assert.equal(thrown.message, 'network replay 超时（15000ms）');
      const failure = R.replayFailureOf(thrown);
      assert.equal(Boolean(failure), true);
      assert.equal(failure.failureMatrix.code, R.REPLAY_MATRIX_CODES.TIMEOUT);
      assert.equal(failure.failureMatrix.safeToRetry, true); // GET 可安全重试
      assert.equal(failure.failureMatrix.recovery.actions[0], 'verify-side-effects');
      const evidence = R.replayExecutionOf(thrown);
      assert.equal(Boolean(evidence), true);
      assert.equal(evidence.planToken.length > 0, true);
      assert.equal(evidence.envelopeFingerprint.length > 0, true);
      assert.equal(evidence.planFingerprint.length > 0, true);
      assert.equal(evidence.failure.code, R.REPLAY_MATRIX_CODES.TIMEOUT);
      assert.equal(Object.keys(thrown).includes(R.REPLAY_EXECUTION_FIELD), false);
      return true;
    },
  );
});

test('replayNetworkCommand：opt-in 边界轨迹判定作为附加字段（不阻断既有路径）', async () => {
  const matched = await R.replayNetworkCommand(networkParams(), {
    execute: executeReturning(successResult()),
    current: { documentId: 'doc-1', frameId: 0, url: 'https://a.test/page' },
    boundaryExecution: { trace: [{ documentId: 'doc-1', frameId: 0, url: 'https://a.test/page' }] },
  });
  assert.equal(Boolean(matched.replay.boundaryExecution), true);
  assert.equal(matched.replay.boundaryExecution.ok, true);
  assert.equal(matched.replay.boundaryExecution.evaluation.matched, 1);

  const blocked = await R.replayNetworkCommand(networkParams(), {
    execute: executeReturning(successResult()),
    boundaryExecution: { trace: [] },
  });
  assert.equal(blocked.status, 200); // 仍然成功：边界判定只是附加证据
  assert.equal(blocked.replay.boundaryExecution.ok, false);
  assert.equal(blocked.replay.boundaryExecution.blocked.length > 0, true);
});

// ---------------------------------------------------------------------------
// replayDebugCommand
// ---------------------------------------------------------------------------

test('replayDebugCommand：成功时补 {ok:true} 并附加执行/观测字段；失败保留原错', async () => {
  const result = await R.replayDebugCommand(
    { tabId: 9, id: 4, overrides: { url: 'https://a.test/api' } },
    { execute: executeReturning(successResult()) },
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.replay.source, R.REPLAY_SOURCES.DEBUG);
  assert.equal(result.replay.executed, true);
  assert.equal(result.replay.execution.ok, true);

  const error = Object.assign(new Error('找不到网络记录 id=4'), { code: 'E_NOT_FOUND' });
  await assert.rejects(
    () => R.replayDebugCommand({ tabId: 9, id: 4 }, { execute: async () => { throw error; } }),
    (thrown) => {
      assert.equal(thrown.code, 'E_NOT_FOUND');
      assert.equal(Boolean(R.replayFailureOf(thrown)), true);
      assert.equal(Boolean(R.replayExecutionOf(thrown)), true);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// replayNetworkCommandTwice：确定性证明
// ---------------------------------------------------------------------------

test('replayNetworkCommandTwice：同输入两次 → 计划/信封/副作用/执行语义全同', async () => {
  const counter = { calls: 0 };
  const report = await R.replayNetworkCommandTwice(networkParams(), {
    execute: executeReturning(successResult(), counter),
  });
  assert.equal(counter.calls, 2);
  assert.equal(report.ok, true);
  assert.equal(report.deterministic, true);
  assert.equal(report.plans.same, true);
  assert.equal(report.envelopes.same, true);
  assert.equal(report.sideEffects.same, true);
  assert.equal(report.comparison.deterministic, true);
  assert.equal(report.observationDiff.deterministic, true);
  assert.equal(report.first.ok, true);
  assert.equal(report.second.ok, true);
  assert.equal(typeof report.digest, 'string');

  const again = await R.replayNetworkCommandTwice(networkParams(), { execute: executeReturning(successResult()) });
  assert.equal(again.digest, report.digest);
});

test('replayNetworkCommandTwice：响应不同 → 计划确定性通过但观测 diff 标记发散', async () => {
  let run = 0;
  const report = await R.replayNetworkCommandTwice(networkParams(), {
    execute: async () => {
      run += 1;
      return run === 1 ? successResult() : successResult({ status: 500, body: '{"ok":false}' });
    },
  });
  assert.equal(report.deterministic, true); // 计划/副作用语义仍确定
  assert.equal(report.plans.same, true);
  assert.equal(report.observationDiff.deterministic, false);
  assert.equal(report.observationDiff.differences.some((item) => item.path === 'status'), true);
});

test('replayNetworkCommandTwice：两次同样失败 → 确定性通过但 ok=false，失败可解释', async () => {
  const report = await R.replayNetworkCommandTwice(networkParams(), {
    execute: async () => { throw Object.assign(new Error('network replay 超时'), { code: 'E_TIMEOUT' }); },
  });
  assert.equal(report.ok, false);
  assert.equal(report.deterministic, true);
  assert.equal(report.first.ok, false);
  assert.equal(report.first.failure.code, R.REPLAY_MATRIX_CODES.TIMEOUT);
  assert.equal(report.first.explanation.code, 'PLAN_INVALID_INPUT'); // E_* 归一到目录码
  assert.equal(report.first.explanation.failureMatrix.code, R.REPLAY_MATRIX_CODES.TIMEOUT);
  assert.equal(report.observationDiff, null);
});

// ---------------------------------------------------------------------------
// replayBoundaryCommand
// ---------------------------------------------------------------------------

test('replayBoundaryCommand：真实轨迹判定 + resume（不执行 providers）', async () => {
  const boundaryPlan = planBoundaryRestoration(boundarySteps(), {
    current: { documentId: 'doc-1', frameId: 0, url: 'https://a.test/' },
  });
  const report = await R.replayBoundaryCommand({ boundaryPlan, trace: traceEntries() });
  assert.equal(report.ok, true);
  assert.equal(report.evaluation.ok, true);
  assert.equal(report.evaluation.matched, 2);
  assert.equal(report.execution, null);
  assert.equal(report.resume.ok, true);
  assert.equal(report.resume.fromIndex, boundaryPlan.epochs[1].startIndex);
});

test('replayBoundaryCommand：执行 navigate provider 并用真实身份证明；缺证据时带阻断解释', async () => {
  const boundaryPlan = planBoundaryRestoration(boundarySteps(), {
    current: { documentId: 'doc-1', frameId: 0, url: 'https://a.test/' },
  });
  // 轨迹只覆盖第一个 epoch：进入第二个 epoch 需要真实执行 navigate
  const partialTrace = [traceEntries()[0]];
  const executed = await R.replayBoundaryCommand({
    boundaryPlan,
    trace: partialTrace,
    providers: {
      navigate: async () => ({ ok: true }),
      sampleIdentity: async () => ({ documentId: 'doc-new-2', frameId: 0, url: 'https://b.test/' }),
    },
  });
  assert.equal(executed.ok, true);
  assert.equal(executed.execution.ok, true);
  assert.equal(executed.execution.actions.length, 1);
  assert.equal(executed.execution.actions[0].code, 'BOUNDARY_EXEC_NAVIGATE_OK');

  const blockedPlan = planBoundaryRestoration(
    [boundarySteps()[0], {
      ...boundarySteps()[1],
      branch: undefined,
      evidence: { documentId: 'doc-1', frameId: 7, revision: 2, url: 'https://a.test/frame' },
      boundary: { documentId: 'doc-1', frameId: 7, revision: 2, url: 'https://a.test/frame' },
    }],
    { current: { documentId: 'doc-1', frameId: 0, url: 'https://a.test/' }, frames: [{ frameId: 0, parentFrameId: -1, url: 'https://a.test/' }] },
  );
  const blocked = await R.replayBoundaryCommand({ boundaryPlan: blockedPlan, trace: partialTrace });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.explanation.code, 'BOUNDARY_FRAME_UNAVAILABLE');
});

// ---------------------------------------------------------------------------
// replayObservationCommand / replayFailureMatrixCommand
// ---------------------------------------------------------------------------

test('replayObservationCommand：单次/两次真实结果消费，expect 与确定性并报', () => {
  const plan = R.planNetworkReplay({ tabId: 1, id: 1, overrides: { url: 'https://a.test/api' } });
  const single = R.replayObservationCommand({
    plan,
    result: successResult(),
    expect: { status: '2xx', bodyJson: { ok: true } },
  });
  assert.equal(single.ok, true);
  assert.equal(single.verdict.ok, true);
  assert.equal(single.determinism, null);
  assert.equal(single.observed.status, 200);

  const twice = R.replayObservationCommand({
    plan,
    result: successResult(),
    secondResult: successResult(),
  });
  assert.equal(twice.ok, true);
  assert.equal(twice.determinism.deterministic, true);

  const failedExpect = R.replayObservationCommand({ plan, result: successResult(), expect: { status: 500 } });
  assert.equal(failedExpect.ok, false);
  assert.equal(failedExpect.verdict.code.startsWith('DIFF_'), true);
});

test('replayFailureMatrixCommand：默认全本地注入、POST 计划标记副作用风险', () => {
  const matrix = R.replayFailureMatrixCommand({ tabId: 1, id: 2, overrides: { url: 'https://a.test/api', method: 'POST' } });
  assert.equal(matrix.ok, true);
  assert.equal(matrix.total, 17);
  assert.equal(matrix.explained, 17);
  assert.equal(matrix.networkUsed, 'local-injection');
  assert.equal(matrix.method, 'POST');
  assert.equal(matrix.sideEffectRisk > 0, true);
  assert.equal(matrix.byCode[R.REPLAY_MATRIX_CODES.TIMEOUT], 1);
  assert.equal(typeof matrix.advice.firstAction, 'string');

  const again = R.replayFailureMatrixCommand({ tabId: 1, id: 2, overrides: { url: 'https://a.test/api', method: 'POST' } });
  assert.equal(again.digest, matrix.digest);
});

test('buildReplayField：不传新字段时键集与第一轮一致；传了新字段才出现', () => {
  const plan = R.planNetworkReplay({ tabId: 1, id: 3, overrides: { url: 'https://a.test/api' } });
  const plain = R.buildReplayField(plan, { executed: true });
  assert.equal('execution' in plain, false);
  assert.equal('observation' in plain, false);
  assert.equal('verdict' in plain, false);
  assert.equal('executionEnvelope' in plain, false);
  assert.equal('sideEffects' in plain, false);
  assert.equal('boundaryExecution' in plain, false);

  const execution = recordExecutionOutcomes(plan, [{ value: successResult() }]);
  const enriched = R.buildReplayField(plan, {
    executed: true,
    execution,
    observation: { version: 2, ok: true, status: 200 },
    boundaryExecution: { ok: true, evaluation: { ok: true, matched: 1, needsAction: 0, blocked: 0 }, trace: { digest: 'abc' }, actions: [] },
  });
  assert.equal(enriched.execution.ok, true);
  assert.equal(enriched.execution.envelopeFingerprint, execution.envelope.fingerprint);
  assert.equal(enriched.observation.status, 200);
  assert.equal(enriched.boundaryExecution.ok, true);
  assert.equal(enriched.executionFingerprint, execution.digest);
});

// ---------------------------------------------------------------------------
// 源码守卫
// ---------------------------------------------------------------------------

test('接线层：第二轮 lib 全部被静态消费，无动态 import/时钟/随机', () => {
  // 第十二批为文件预算把执行包装拆到 replay-execution.js；两份都是“接线层”，
  // 四个第二轮 lib 必须由它们之一静态消费（不得动态 import/挂钟/随机）。
  const wiring = ['extension/src/replay.js', 'extension/src/replay-execution.js']
    .map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8'));
  const source = wiring.join('\n');
  for (const name of ['replay-executor.js', 'replay-boundary-exec.js', 'replay-diff-exec.js', 'replay-failure-matrix.js']) {
    assert.equal(source.includes("'./lib/" + name + "'"), true, '缺少静态 import：' + name);
    assert.equal(fs.existsSync(path.join(ROOT, 'extension/src/lib', name)), true);
  }
  for (const file of wiring) {
    assert.equal(/await import\s*\(/.test(file), false);
    assert.equal(/Date\.now\s*\(/.test(file), false);
    assert.equal(/Math\.random\s*\(/.test(file), false);
  }
  // lib 目录里所有 replay-*.js 仍被 replay.js 或其它 replay 模块消费（与 unused 审计口径一致）
  const libDir = path.join(ROOT, 'extension/src/lib');
  const libs = fs.readdirSync(libDir).filter((name) => /^replay-.*\.js$/.test(name));
  const rootWiring = ['extension/src/replay.js', 'extension/src/replay-plan.js', 'extension/src/replay-execution.js']
    .map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8'));
  const corpus = [source, ...rootWiring, ...libs.map((name) => fs.readFileSync(path.join(libDir, name), 'utf8'))].join('\n');
  for (const name of libs) {
    assert.equal(corpus.includes("'./" + name + "'") || corpus.includes("'./lib/" + name + "'"), true, '未被消费：' + name);
  }
});
