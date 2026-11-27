// tests/unit/replay-explain.test.mjs —— 失败可解释：错误码目录/分类/解释/报告/脱敏。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../../extension/src/lib/replay-explain.js';

test('错误码目录：形状完整、code 对齐、类目合法、建议有界', () => {
  const codes = E.catalogCodes();
  assert.equal(codes.length >= 40, true);
  const categories = new Set(E.FAILURE_CATEGORIES);
  for (const code of codes) {
    const entry = E.REPLAY_ERROR_CODES[code];
    assert.equal(entry.code, code);
    assert.equal(categories.has(entry.category), true, code);
    assert.equal(typeof entry.title, 'string');
    assert.equal(entry.title.length > 0, true);
    assert.equal(typeof entry.detail, 'string');
    assert.equal(typeof entry.hint, 'string');
    assert.equal(Array.isArray(entry.remediation), true);
    assert.equal(entry.remediation.length <= E.EXPLAIN_LIMITS.maxRemediation, true);
    assert.equal(['info', 'warning', 'error'].includes(entry.severity), true);
    assert.equal(typeof entry.retriable, 'boolean');
    assert.equal(typeof entry.needsHuman, 'boolean');
    assert.equal(typeof entry.sideEffectPossible, 'boolean');
  }
  const byCategory = E.catalogByCategory();
  assert.equal(Object.keys(byCategory).length >= 7, true);
  assert.equal(byCategory.boundary.length > 0, true);
  assert.equal(E.getErrorEntry('TARGET_NOT_FOUND').category, 'target');
  assert.equal(E.getErrorEntry('missing'), null);
});

test('canonicalCode：目录码原样、别名映射、E_ 前缀归为参数错误', () => {
  assert.equal(E.canonicalCode('TARGET_NOT_FOUND'), 'TARGET_NOT_FOUND');
  assert.equal(E.canonicalCode('REPLAY_SIDE_EFFECT'), 'PLAN_SIDE_EFFECT');
  assert.equal(E.canonicalCode('PLAN_HUMAN_VALUE_MISSING'), 'PLAN_HUMAN_REQUIRED');
  assert.equal(E.canonicalCode('DIFF_VALUE_MISMATCH'), 'DIFF_EXPECTATION_FAILED');
  assert.equal(E.canonicalCode('TARGET_ONLY_HIDDEN'), 'TARGET_ONLY_HIDDEN');
  assert.equal(E.canonicalCode('E_BAD_ARG'), 'PLAN_INVALID_INPUT');
  assert.equal(E.canonicalCode('SOMETHING_ELSE'), 'SOMETHING_ELSE');
  assert.equal(E.canonicalCode(''), '');
});

test('redactMessage：token/cookie/密码/JWT/长 hex/邮箱 全部脱敏且有界', () => {
  const text = E.redactMessage('Authorization: Bearer abc.def.ghi password=hunter2 Cookie: sid=1; a=2 email a@b.com token=xyz&next=1');
  assert.equal(text.includes('hunter2'), false);
  assert.equal(text.includes('sid=1'), false);
  assert.equal(text.includes('a@b.com'), false);
  assert.equal(text.includes('***@b.com'), true);
  assert.equal(text.includes('xyz'), false);
  assert.equal(text.includes('next=1'), true);
  const jwt = E.redactMessage('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturepart');
  assert.equal(jwt.includes('eyJhbGciOiJIUzI1NiJ9'), false);
  const hex = E.redactMessage('id ' + 'a1b2c3d4'.repeat(6));
  assert.equal(hex.includes('a1b2c3d4a1b2c3d4'), false);
  assert.equal(E.redactMessage('x'.repeat(500)).length <= E.EXPLAIN_LIMITS.maxText + 1, true);
  assert.equal(E.redactMessage(null), '');
});

test('classifyReplayError：显式 code、文案启发式、fallback 与内部错误', () => {
  const direct = E.classifyReplayError({ code: 'TARGET_AMBIGUOUS', message: 'x' });
  assert.equal(direct.code, 'TARGET_AMBIGUOUS');
  assert.equal(direct.matchedBy, 'code');

  assert.equal(E.classifyReplayError(new Error('Element not found')).code, 'TARGET_NOT_FOUND');
  assert.equal(E.classifyReplayError(new Error('replay timed out')).code, 'REPLAY_TIMEOUT');
  assert.equal(E.classifyReplayError(new Error('document changed during replay')).code, 'BOUNDARY_DOCUMENT_CHANGED');
  assert.equal(E.classifyReplayError(new Error('cross-origin blocked by CORS')).code, 'NETWORK_REPLAY_CROSS_ORIGIN');
  assert.equal(E.classifyReplayError(new Error('unexpected TypeError')).code, 'REPLAY_INTERNAL');
  assert.equal(E.classifyReplayError({}, { fallbackCode: 'NETWORK_REPLAY_LIMIT' }).code, 'NETWORK_REPLAY_LIMIT');
  assert.equal(E.classifyReplayError({ code: 'E_BAD_ARG', message: '缺少 tabId' }).code, 'PLAN_INVALID_INPUT');

  const classified = E.classifyReplayError(new Error('Element not found'), { context: { stepIndex: 3, ref: 'r3', method: 'click' } });
  assert.equal(classified.context.stepIndex, 3);
  assert.equal(classified.context.ref, 'r3');
  assert.equal(classified.message.includes('not found'), true);
});

test('explainFailure：code 解析优先级、标志、证据、建议与签名', () => {
  const fromError = E.explainFailure({ error: new Error('Element not found') });
  assert.equal(fromError.code, 'TARGET_NOT_FOUND');

  const explicit = E.explainFailure({ code: 'BOUNDARY_DOCUMENT_CHANGED', step: { index: 2, ref: 'r2', kind: 'action', method: 'click', idempotent: false } });
  assert.equal(explicit.code, 'BOUNDARY_DOCUMENT_CHANGED');
  assert.equal(explicit.category, 'boundary');
  assert.equal(explicit.step.index, 2);
  assert.equal(explicit.remediation.length > 0, true);
  assert.equal(explicit.signature.length, 8);

  const human = E.explainFailure({ step: { kind: 'human' }, code: 'REPLAY_TIMEOUT' });
  assert.equal(human.needsHuman, true);

  const risky = E.explainFailure({
    step: { index: 1, idempotent: false },
    outcome: { completed: true, severity: 'fail' },
    code: 'DIFF_OUTCOME_ERROR',
  });
  assert.equal(risky.sideEffectPossible, true);

  const ambiguous = E.explainFailure({
    code: 'TARGET_AMBIGUOUS',
    target: { status: 'ambiguous', reasonCode: 'TARGET_AMBIGUOUS', strategy: 'selector', alternatives: [{}, {}] },
  });
  assert.equal(ambiguous.evidence.target.alternatives, 2);
  assert.equal(ambiguous.remediation.some((item) => item.includes('rgba') || item.includes('selector')), true);

  const withDetail = E.explainFailure({ code: 'PLAN_BLOCKED', detail: 'password=secret' });
  assert.equal(withDetail.evidence.detail.includes('secret'), false);

  const unknown = E.explainFailure({});
  assert.equal(unknown.code, 'REPLAY_INTERNAL');
  assert.equal(unknown.category, 'internal');

  // 签名确定性：同输入同签名。
  const first = E.explainFailure({ code: 'TARGET_NOT_FOUND', step: { index: 1, ref: 'r1' } });
  const second = E.explainFailure({ code: 'TARGET_NOT_FOUND', step: { index: 1, ref: 'r1' } });
  assert.equal(first.signature, second.signature);
});

test('explainBoundaryComparison / explainTargetFailure / explainDiffVerdict', () => {
  assert.equal(E.explainBoundaryComparison({ relation: 'document-changed', detail: 'x' }).code, 'BOUNDARY_DOCUMENT_CHANGED');
  assert.equal(E.explainBoundaryComparison({ relation: 'frame-changed' }).code, 'BOUNDARY_FRAME_CHANGED');
  assert.equal(E.explainBoundaryComparison({ relation: 'revision-changed' }).code, 'BOUNDARY_REVISION_CHANGED');
  assert.equal(E.explainBoundaryComparison({ relation: 'url-changed' }).code, 'BOUNDARY_URL_CHANGED');
  assert.equal(E.explainBoundaryComparison({ relation: 'missing-boundary' }).code, 'BOUNDARY_MISSING');
  assert.equal(E.explainBoundaryComparison(null).code, 'BOUNDARY_MISSING');

  assert.equal(E.explainTargetFailure({ status: 'ambiguous', reasonCode: 'TARGET_AMBIGUOUS' }).code, 'TARGET_AMBIGUOUS');
  assert.equal(E.explainTargetFailure({ status: 'forbidden', reasonCode: 'TARGET_ANONYMOUS' }).code, 'TARGET_ANONYMOUS');
  assert.equal(E.explainTargetFailure({ status: 'missing', reasonCode: 'TARGET_NO_MATCH' }).code, 'TARGET_NOT_FOUND');
  assert.equal(E.explainTargetFailure({ status: 'missing', reasonCode: 'TARGET_ONLY_HIDDEN' }).code, 'TARGET_ONLY_HIDDEN');
  assert.equal(E.explainTargetFailure({ status: 'planned', reasonCode: 'TARGET_NO_SNAPSHOT' }).code, 'TARGET_NO_SNAPSHOT');

  assert.equal(E.explainDiffVerdict({ ok: false, code: 'DIFF_VALUE_MISMATCH' }).code, 'DIFF_EXPECTATION_FAILED');
  assert.equal(E.explainDiffVerdict({ ok: false, code: 'DIFF_MISSING_ACTUAL' }).code, 'DIFF_MISSING_ACTUAL');
  assert.equal(E.explainDiffVerdict({ ok: true, severity: 'pass' }).code, 'REPLAY_NOT_ATTEMPTED');
});

test('explainOutcome：成功返回 null，失败给目录码（含 human/observation 补充）', () => {
  assert.equal(E.explainOutcome({ index: 0 }, { ok: true, severity: 'pass', code: 'DIFF_OK' }), null);
  const failed = E.explainOutcome({ index: 1, kind: 'action' }, { ok: false, severity: 'fail', code: 'DIFF_VALUE_MISMATCH' });
  assert.equal(failed.code, 'DIFF_EXPECTATION_FAILED');
  const missing = E.explainOutcome({ index: 0 }, null);
  assert.equal(missing.code, 'DIFF_MISSING_ACTUAL');
  const human = E.explainOutcome({ index: 0, kind: 'human' }, { ok: false, severity: 'fail', code: 'X' });
  assert.equal(human.code, 'DIFF_EXPECTATION_FAILED');
  assert.equal(human.needsHuman, true);
  const warned = E.explainOutcome({ index: 0 }, { ok: true, severity: 'warning', code: 'DIFF_UNSUPPORTED_EXPECTATION' });
  assert.equal(warned.code, 'DIFF_UNSUPPORTED_EXPECTATION');
  const observation = E.explainOutcome({ index: 0 }, { ok: false, severity: 'fail', code: 'DIFF_OBSERVATION_CHANGED', observation: { changed: true } });
  assert.equal(observation.remediation.some((item) => item.includes('hunks')), true);
});

test('explainPlanBlockers：把 PROGRAM_CODES/PLAN_CODES 映射成目录解释', () => {
  const explanations = E.explainPlanBlockers([
    { code: 'REPLAY_SIDE_EFFECT', index: 0, message: '非幂等副作用' },
    { code: 'REPLAY_HUMAN_REQUIRED', index: 1, message: '需要人工' },
    { code: 'REPLAY_EMPTY', index: -1, message: '空' },
    { code: 'TARGET_NO_MATCH', index: 2, message: '找不到' },
    { code: 'BOUNDARY_URL_MISSING', index: 3, message: '缺 URL' },
    { code: 'UNKNOWN_CODE', index: 4, message: '未知' },
    null,
  ]);
  assert.equal(explanations.length, 6);
  assert.equal(explanations[0].code, 'PLAN_SIDE_EFFECT');
  assert.equal(explanations[0].sideEffectPossible, true);
  assert.equal(explanations[1].code, 'PLAN_HUMAN_REQUIRED');
  assert.equal(explanations[2].code, 'PLAN_EMPTY');
  assert.equal(explanations[3].code, 'TARGET_NOT_FOUND');
  assert.equal(explanations[4].code, 'BOUNDARY_URL_MISSING');
  assert.equal(explanations[5].code, 'PLAN_BLOCKED');
  assert.equal(E.explainPlanBlockers(null).length, 0);
});

test('groupFailures / hasSideEffectRisk / isRetriable', () => {
  const failures = [
    E.explainFailure({ code: 'TARGET_NOT_FOUND', step: { index: 1, ref: 'r1' } }),
    E.explainFailure({ code: 'TARGET_NOT_FOUND', step: { index: 4, ref: 'r4' } }),
    E.explainFailure({ code: 'DIFF_OUTCOME_ERROR', step: { index: 2, ref: 'r2' }, outcome: { completed: true }, }),
  ];
  const groups = E.groupFailures(failures);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].count, 2);
  assert.equal(groups[0].firstIndex, 1);
  assert.equal(E.groupFailures([]).length, 0);
  assert.equal(E.hasSideEffectRisk(failures), true);
  assert.equal(E.hasSideEffectRisk([]), false);
  assert.equal(E.isRetriable([E.explainFailure({ code: 'REPLAY_TIMEOUT' })]), true);
  assert.equal(E.isRetriable([E.explainFailure({ code: 'PLAN_HUMAN_REQUIRED' })]), false);
  assert.equal(E.isRetriable([]), false);
});

test('buildFailureReport / formatFailureReport：根因、风险、建议、稳定签名', () => {
  const failures = [
    E.explainFailure({ code: 'BOUNDARY_DOCUMENT_CHANGED', step: { index: 0 } }),
    E.explainFailure({ code: 'TARGET_AMBIGUOUS', step: { index: 2 }, target: { status: 'ambiguous', reasonCode: 'TARGET_AMBIGUOUS' } }),
    E.explainFailure({ code: 'DIFF_OUTCOME_ERROR', step: { index: 3, idempotent: false }, outcome: { completed: true } }),
  ];
  const report = E.buildFailureReport(failures, { plan: { token: 'rp1-x' } });
  assert.equal(report.total, 3);
  assert.equal(report.ok, false);
  assert.equal(report.planToken, 'rp1-x');
  assert.equal(report.sideEffectAtRisk, true);
  assert.equal(report.rootCause.index === undefined || report.rootCause.step.index >= 0, true);
  assert.equal(report.byCategory.boundary, 1);
  assert.equal(report.remediation.length > 0, true);
  assert.equal(report.signature.length, 8);
  const second = E.buildFailureReport(failures, { plan: { token: 'rp1-x' } });
  assert.equal(report.signature, second.signature);

  const text = E.formatFailureReport(report);
  assert.match(text, /回放失败 3 处/);
  assert.match(text, /副作用/);
  assert.match(text, /建议/);
  assert.equal(text.split('\n').length <= E.EXPLAIN_LIMITS.maxReportLines, true);
  assert.equal(E.formatFailureReport(null), '回放失败：无报告');
  const empty = E.buildFailureReport([]);
  assert.equal(empty.ok, true);
  assert.equal(empty.total, 0);
});

test('summarizeFailure / summarizeFailureReport：有界字段', () => {
  const failure = E.explainFailure({ code: 'TARGET_AMBIGUOUS', step: { index: 5, ref: 'r5' } });
  const summary = E.summarizeFailure(failure);
  assert.equal(summary.code, 'TARGET_AMBIGUOUS');
  assert.equal(summary.stepIndex, 5);
  assert.equal(summary.remediation.length <= 3, true);
  assert.equal(summary.signature.length, 8);
  assert.equal(E.summarizeFailure(null), null);

  const report = E.buildFailureReport([failure], { plan: { token: 'rp1-y' } });
  const compact = E.summarizeFailureReport(report);
  assert.equal(compact.total, 1);
  assert.equal(compact.planToken, 'rp1-y');
  assert.equal(compact.rootCause.code, 'TARGET_AMBIGUOUS');
  assert.equal(E.summarizeFailureReport(null), null);
});
