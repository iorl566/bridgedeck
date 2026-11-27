import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROGRAM_CODES,
  PROGRAM_LIMITS,
  STEP_KINDS,
  buildRecordProgram,
  mergeRecordPrograms,
  mergeTextDiff,
  normalizeStepNode,
  preflightReplay,
  programDiff,
  programFingerprint,
  summarizeRecordProgram,
  validateRecordProgram,
  validateRecordStep,
} from '../../extension/src/record-program.js';

let refCounter = 0;
function step(overrides = {}) {
  refCounter += 1;
  const base = {
    model: 2,
    ref: 'r' + refCounter,
    kind: 'action',
    type: 'action',
    method: 'click',
    params: { selector: '#go' },
    target: { selector: '#go' },
    idempotent: false,
    fallback: { onError: 'stop', skipReason: '' },
    risk: 'browser_mutation',
    evidence: { seq: refCounter, index: refCounter - 1, frameId: 0, documentId: 'doc-1', revision: 1, actor: 'human', url: 'https://a.test/f', at: 1_700_000_000_000 + refCounter },
    sourceKind: 'click',
  };
  return {
    ...base,
    ...overrides,
    params: { ...base.params, ...(overrides.params || {}) },
    evidence: { ...base.evidence, ...(overrides.evidence || {}) },
  };
}

function navigateStep(overrides = {}) {
  return step({
    kind: 'branch',
    type: 'branch',
    method: 'navigate',
    params: { url: 'https://a.test/next' },
    idempotent: true,
    fallback: { onError: 'retry', retries: 1, retryDelayMs: 400 },
    risk: 'read_only',
    expect: { urlIncludes: '/next' },
    branch: { boundary: 'document', source: 'navigation', url: 'https://a.test/next' },
    sourceKind: 'navigate',
    ...overrides,
  });
}

function observeStep(overrides = {}) {
  return step({
    kind: 'observe',
    type: 'observe',
    method: 'observe',
    params: { refs: 12 },
    idempotent: true,
    fallback: { onError: 'retry', retries: 2, retryDelayMs: 300 },
    risk: 'read_only',
    sourceKind: 'state',
    ...overrides,
  });
}

test('normalizeStepNode：step → node，node 原样，非法返回 null', () => {
  const source = step({ ref: 'alpha' });
  const node = normalizeStepNode(source, 3);
  assert.equal(node.ref, 'alpha');
  assert.equal(node.kind, 'action');
  assert.equal(node.signature.includes('click'), true);
  assert.equal(node.documentId, 'doc-1');
  assert.equal(node.seq > 0, true);
  assert.equal(normalizeStepNode(null), null);
  assert.equal(normalizeStepNode(42), null);

  const already = { node: true, index: 5, ref: 'n1', kind: 'action', method: 'click', signature: 'action|click|x', idempotent: false };
  assert.equal(normalizeStepNode(already, 9).index, 5);
});

test('validateRecordStep：action/branch/human-gate/retry/seq/limit 规则', () => {
  const actionNoMethod = validateRecordStep(step({ method: '' }));
  assert.equal(actionNoMethod.ok, false);
  assert.equal(actionNoMethod.codes.includes(PROGRAM_CODES.ACTION_NO_METHOD), true);

  const retrySideEffect = validateRecordStep(step({ method: 'click', idempotent: false, fallback: { onError: 'retry', retries: 2 } }));
  assert.equal(retrySideEffect.ok, false);
  assert.equal(retrySideEffect.codes.includes(PROGRAM_CODES.RETRY_NON_IDEMPOTENT), true);

  const retryIdempotent = validateRecordStep(step({ method: 'hover', idempotent: true, fallback: { onError: 'retry', retries: 1 } }));
  assert.equal(retryIdempotent.ok, true);
  assert.equal(retryIdempotent.codes.includes(PROGRAM_CODES.RETRY_WITHOUT_RETRIES), false);

  const retryNoRetries = validateRecordStep(step({ method: 'hover', idempotent: true, fallback: { onError: 'retry' } }));
  assert.equal(retryNoRetries.codes.includes(PROGRAM_CODES.RETRY_WITHOUT_RETRIES), true);

  const unknownFallback = validateRecordStep(step({ fallback: { onError: 'explode' } }));
  assert.equal(unknownFallback.codes.includes(PROGRAM_CODES.FALLBACK_UNKNOWN), true);

  const branchNoUrl = validateRecordStep(navigateStep({ params: {}, branch: { boundary: 'document' } }));
  assert.equal(branchNoUrl.ok, false);
  assert.equal(branchNoUrl.codes.includes(PROGRAM_CODES.BRANCH_NAVIGATE_NO_URL), true);

  const branchMissing = validateRecordStep(step({ kind: 'branch', method: 'navigate' }));
  assert.equal(branchMissing.codes.includes(PROGRAM_CODES.BRANCH_MISSING), true);

  const switchNoTarget = validateRecordStep(step({ kind: 'branch', method: '', idempotent: true, branch: { boundary: 'tab-switch' } }));
  assert.equal(switchNoTarget.codes.includes(PROGRAM_CODES.BRANCH_SWITCH_NO_TARGET), true);

  const humanGate = validateRecordStep(step({
    kind: 'action',
    method: 'fill',
    idempotent: false,
    target: null,
    params: { selector: '' },
    humanGate: {},
    risk: 'human_gate',
  }));
  assert.equal(humanGate.codes.includes(PROGRAM_CODES.HUMAN_GATE_NO_REASON), true);
  assert.equal(humanGate.codes.includes(PROGRAM_CODES.HUMAN_GATE_NO_VALUE_KIND), true);
  assert.equal(humanGate.codes.includes(PROGRAM_CODES.HUMAN_GATE_NO_TARGET), true);

  const seqRegression = validateRecordStep(step({ evidence: { seq: 5 } }), { previous: step({ evidence: { seq: 9 } }) });
  assert.equal(seqRegression.codes.includes(PROGRAM_CODES.SEQ_REGRESSION), true);

  const refDuplicate = validateRecordStep(step({ ref: 'same' }), { previous: step({ ref: 'same' }) });
  assert.equal(refDuplicate.codes.includes(PROGRAM_CODES.STEP_REF_DUPLICATE), true);

  const longLoop = validateRecordStep(step({ repeat: 500 }), { options: { maxLoopIterations: 10 } });
  assert.equal(longLoop.ok, false);
  assert.equal(longLoop.codes.includes(PROGRAM_CODES.LOOP_TOO_LONG), true);

  const longWait = validateRecordStep(step({ waitBeforeMs: 120_000 }), { options: { maxWaitMs: 60_000 } });
  assert.equal(longWait.codes.includes(PROGRAM_CODES.WAIT_TOO_LONG), true);

  const badExpect = validateRecordStep(step({ expect: [] }));
  assert.equal(badExpect.codes.includes(PROGRAM_CODES.EXPECT_SHAPE), true);

  const unknownKind = validateRecordStep(step({ kind: 'teleport' }));
  assert.equal(unknownKind.codes.includes(PROGRAM_CODES.UNKNOWN_STEP_KIND), true);
  assert.equal(STEP_KINDS.includes('teleport'), false);

  const missingRef = validateRecordStep(step({ ref: '' }));
  assert.equal(missingRef.codes.includes(PROGRAM_CODES.STEP_REF_MISSING), true);
});

test('buildRecordProgram：边界分段/循环组/human-gate/边/stats/指纹', () => {
  const steps = [
    step({ ref: 'a1' }),
    step({ ref: 'a2' }),
    navigateStep({ ref: 'nav' }),
    step({ ref: 'b1', evidence: { documentId: 'doc-2' } }),
    step({ ref: 'b2', evidence: { documentId: 'doc-2' } }),
    step({ ref: 'b3', evidence: { documentId: 'doc-2' } }),
    step({ ref: 'gate', method: 'fill', kind: 'action', idempotent: false, humanGate: { reason: '需要人工补值', valueKind: 'text' }, params: {} }),
    observeStep({ ref: 'obs' }),
  ];
  const program = buildRecordProgram(steps);
  assert.equal(program.version, 1);
  assert.equal(program.model, 2);
  assert.equal(program.nodes.length, 8);
  assert.equal(program.segments.length, 2);
  assert.equal(program.segments[0].to, 2);
  assert.equal(program.segments[0].boundary.method, 'navigate');
  assert.equal(program.segments[0].boundary.url, 'https://a.test/next');
  assert.equal(program.segments[1].steps, 5);
  assert.equal(program.humanGates.length, 1);
  assert.equal(program.humanGates[0].reason, '需要人工补值');
  assert.equal(program.humanGates[0].valueKind, 'text');
  assert.equal(program.loops.length >= 1, true, '连续同签名步骤应识别为循环组');
  assert.equal(program.stats.total, 8);
  assert.equal(program.stats.boundaries, 1);
  assert.equal(program.stats.humanGates, 1);
  assert.equal(program.stats.segments, 2);
  assert.equal(program.edges.length, 7);
  assert.equal(program.edges[2].kind, 'boundary');
  assert.match(program.fingerprint, /^p[0-9a-f]{8}-/);
  assert.equal(programFingerprint(program), program.fingerprint);
  assert.equal(programFingerprint(steps), program.fingerprint);
});

test('buildRecordProgram：指纹随操作变化，空程序也有确定指纹', () => {
  const first = buildRecordProgram([step({ ref: 'x1', method: 'click' })]);
  const second = buildRecordProgram([step({ ref: 'x2', method: 'fill', params: { selector: '#q', value: 'v' } })]);
  assert.notEqual(first.fingerprint, second.fingerprint);
  const empty = buildRecordProgram([]);
  assert.equal(empty.nodes.length, 0);
  assert.equal(empty.stats.total, 0);
  assert.equal(empty.fingerprint, programFingerprint([]));
  assert.deepEqual(summarizeRecordProgram(empty).steps, 0);
});

test('validateRecordProgram：重复 ref / 未标记文档切换 / 分支死胡同 / 程序过大', () => {
  const duplicated = validateRecordProgram([step({ ref: 'dup' }), step({ ref: 'dup' })]);
  assert.equal(duplicated.ok, false);
  assert.equal(duplicated.byCode[PROGRAM_CODES.STEP_REF_DUPLICATE] >= 1, true);

  const docSwitch = validateRecordProgram([step({ ref: 'd1', evidence: { documentId: 'doc-1' } }), step({ ref: 'd2', evidence: { documentId: 'doc-2' } })]);
  assert.equal(docSwitch.issues.some((item) => item.code === PROGRAM_CODES.DOCUMENT_SWITCH_UNMARKED), true);

  const deadEnd = validateRecordProgram([step({ ref: 'p1' }), navigateStep({ ref: 'p2' })]);
  assert.equal(deadEnd.issues.some((item) => item.code === PROGRAM_CODES.BRANCH_DEAD_END), true);

  const tooLarge = validateRecordProgram([step({ ref: 's1' }), step({ ref: 's2' }), step({ ref: 's3' })], { maxSteps: 2 });
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.byCode[PROGRAM_CODES.PROGRAM_TOO_LARGE], 1);

  const seqRegression = validateRecordProgram([step({ ref: 'q1', evidence: { seq: 9 } }), step({ ref: 'q2', evidence: { seq: 3 } })]);
  assert.equal(seqRegression.issues.some((item) => item.code === PROGRAM_CODES.SEQ_REGRESSION), true);
  assert.equal(seqRegression.ok, true, 'seq 回退只是 warning');
});

test('validateRecordProgram：循环超长 / 循环内 human-gate / 循环内带重试副作用', () => {
  const repeated = [];
  for (let index = 0; index < 8; index += 1) repeated.push(step({ ref: 'loop' + index, method: 'click', evidence: { seq: index + 1 } }));
  const loop = validateRecordProgram(repeated);
  assert.equal(loop.issues.some((item) => item.code === PROGRAM_CODES.LOOP_TOO_LONG), false, '8 次未超默认 50');
  const limited = validateRecordProgram(repeated, { maxLoopIterations: 3 });
  assert.equal(limited.ok, false);
  assert.equal(limited.byCode[PROGRAM_CODES.LOOP_TOO_LONG] >= 1, true);

  const gateLoop = [
    step({ ref: 'g1', method: 'click' }),
    step({ ref: 'g2', method: 'click', humanGate: { reason: '补值', valueKind: 'text' }, params: { value: undefined } }),
    step({ ref: 'g3', method: 'click' }),
  ];
  const gateProgram = validateRecordProgram(gateLoop);
  assert.equal(gateProgram.issues.some((item) => item.code === PROGRAM_CODES.HUMAN_GATE_IN_LOOP), true);

  const retryLoop = [
    step({ ref: 'r1', method: 'hover', idempotent: true, fallback: { onError: 'retry', retries: 1 } }),
    step({ ref: 'r2', method: 'hover', idempotent: true, fallback: { onError: 'retry', retries: 1 } }),
  ];
  // 同签名 + 带重试（幂等，不是副作用）→ 不报 LOOP_RETRY_SIDE_EFFECT
  assert.equal(validateRecordProgram(retryLoop).byCode[PROGRAM_CODES.LOOP_RETRY_SIDE_EFFECT] || 0, 0);

  const badSideEffect = [
    step({ ref: 'b1', method: 'click', idempotent: false, fallback: { onError: 'retry', retries: 1 } }),
    step({ ref: 'b2', method: 'click', idempotent: false, fallback: { onError: 'retry', retries: 1 } }),
  ];
  const sideEffectProgram = validateRecordProgram(badSideEffect);
  assert.equal(sideEffectProgram.ok, false);
  assert.equal(sideEffectProgram.byCode[PROGRAM_CODES.LOOP_RETRY_SIDE_EFFECT] >= 1, true);
});

test('summarizeRecordProgram：紧凑、含指纹与问题摘要', () => {
  const program = buildRecordProgram([
    step({ ref: 's1' }),
    navigateStep({ ref: 'nav' }),
    step({ ref: 's2' }),
  ]);
  const summary = summarizeRecordProgram(program);
  assert.equal(summary.version, 1);
  assert.equal(summary.model, 2);
  assert.equal(summary.fingerprint, program.fingerprint);
  assert.equal(summary.steps, 3);
  assert.equal(summary.branches, 1);
  assert.equal(summary.segments, 2);
  assert.equal(summary.actions, 2);
  assert.equal(summary.observes, 0);
  assert.equal(typeof summary.errors, 'number');
  assert.equal(summarizeRecordProgram(null), null);
  assert.equal(JSON.stringify(summary).length < 700, true, '摘要必须足够小（挂事件上）');
});

test('programDiff：identical / added / removed / modified（同 ref 改值）', () => {
  const left = [step({ ref: 'a' }), step({ ref: 'b', method: 'fill', params: { selector: '#q', value: 'one' } }), step({ ref: 'c' })];
  const right = [step({ ref: 'a' }), step({ ref: 'b', method: 'fill', params: { selector: '#q', value: 'two' } }), step({ ref: 'c' }), step({ ref: 'd' })];

  const same = programDiff(left, left);
  assert.equal(same.equal, true);
  assert.equal(same.stats.added, 0);
  assert.equal(same.stats.removed, 0);
  assert.equal(same.stats.modified, 0);
  assert.equal(same.stats.hunks, 0);

  const short = programDiff(left, left.slice(0, 2));
  assert.equal(short.equal, false);
  assert.equal(short.stats.removed, 1);
  assert.equal(short.stats.equal, 2);
  assert.equal(short.hunks.length, 1);

  const longer = programDiff(left, right);
  assert.equal(longer.equal, false);
  assert.equal(longer.stats.added >= 1, true);
  const modified = longer.ops.find((item) => item.type === 'modified');
  assert.ok(modified, '同 ref 改值应归并成 modified');
  assert.equal(modified.type, 'modified');
  assert.equal(modified.before.params.value, 'one');
  assert.equal(modified.after.params.value, 'two');
  assert.equal(longer.fingerprints.left, programFingerprint(left));
  assert.equal(longer.fingerprints.right, programFingerprint(right));
});

test('mergeTextDiff：单边不变/同变更/冲突（prefer 左右）/插入删除', () => {
  const base = 'a\nb\nc';
  const leftUnchanged = mergeTextDiff(base, base, 'a\nB\nc');
  assert.equal(leftUnchanged.ok, true);
  assert.equal(leftUnchanged.merged, 'a\nB\nc');

  const rightUnchanged = mergeTextDiff(base, 'a\nB\nc', base);
  assert.equal(rightUnchanged.ok, true);
  assert.equal(rightUnchanged.merged, 'a\nB\nc');

  const same = mergeTextDiff(base, 'a\nB\nc', 'a\nB\nc');
  assert.equal(same.ok, true);
  assert.equal(same.merged, 'a\nB\nc');

  const conflict = mergeTextDiff(base, 'a\nL\nc', 'a\nR\nc');
  assert.equal(conflict.ok, false);
  assert.equal(conflict.conflicts.length, 1);
  assert.equal(conflict.conflicts[0].baseLines[0], 'b');
  assert.equal(conflict.merged, 'a\nL\nc', '默认 prefer=left');
  const preferRight = mergeTextDiff(base, 'a\nL\nc', 'a\nR\nc', { prefer: 'right' });
  assert.equal(preferRight.merged, 'a\nR\nc');
  assert.equal(preferRight.stats.prefer, 'right');

  const insert = mergeTextDiff('a\nc', 'a\nb\nc', 'a\nc');
  assert.equal(insert.ok, true);
  assert.equal(insert.merged, 'a\nb\nc');

  const remove = mergeTextDiff('a\nb\nc', 'a\nc', 'a\nb\nc');
  assert.equal(remove.ok, true);
  assert.equal(remove.merged, 'a\nc');

  const emptyBase = mergeTextDiff('', 'x', '');
  assert.equal(emptyBase.ok, true);
  assert.equal(emptyBase.merged, 'x');

  const tooLarge = mergeTextDiff('a\nb\nc', 'a\nb2\nc', 'a\nb3\nc', { maxMergeLines: 1 });
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.conflicts[0].reason, 'too_large');
});

test('mergeRecordPrograms：按 ref 对齐、补空字段、冲突记录', () => {
  const left = [step({ ref: 'm1' }), step({ ref: 'm2', method: 'fill', params: { selector: '#q' }, expect: null })];
  const right = [
    step({ ref: 'm1' }),
    step({ ref: 'm2', method: 'fill', params: { selector: '#q', value: 'v' }, expect: { selectorValue: 'v' } }),
    step({ ref: 'm3' }),
  ];
  const merged = mergeRecordPrograms([{ source: 'content', steps: left }, { source: 'injected', steps: right }]);
  assert.equal(merged.stats.sources, 2);
  assert.equal(merged.stats.steps, 3);
  assert.equal(merged.stats.duplicates, 2);
  assert.equal(merged.program.stats.total, 3);
  assert.deepEqual(merged.program.nodes[0].sources, ['content', 'injected']);
  assert.equal(merged.conflicts.length, 0);

  // 同 ref 不同签名 → 冲突但保留先到者
  const conflicting = mergeRecordPrograms([
    { source: 'a', steps: [step({ ref: 'c1', method: 'click' })] },
    { source: 'b', steps: [step({ ref: 'c1', method: 'fill' })] },
  ]);
  assert.equal(conflicting.ok, false);
  assert.equal(conflicting.conflicts.length, 1);
  assert.equal(conflicting.conflicts[0].field, 'signature');
  assert.equal(conflicting.program.nodes[0].method, 'click');

  const single = mergeRecordPrograms([{ source: 'only', steps: [step({ ref: 'x' })] }]);
  assert.equal(single.ok, true);
  assert.equal(single.program.stats.total, 1);
});

test('preflightReplay：副作用阻断/允许、human-gate、幂等 token、空程序、重试预算', () => {
  const steps = [
    step({ ref: 'p1' }),
    navigateStep({ ref: 'pnav' }),
    step({ ref: 'p2', method: 'fill', params: { selector: '#q', value: 'x' } }),
  ];
  const blocked = preflightReplay(steps);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.blockers.some((item) => item.code === PROGRAM_CODES.REPLAY_SIDE_EFFECT), true);
  assert.match(blocked.token, /^rp-[0-9a-f]{8}$/);

  const allowed = preflightReplay(steps, { allowNonIdempotent: true, requireHumanValues: false });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.replayPlan.filter((item) => item.kind === 'action').length, 2);
  assert.equal(allowed.replayPlan.filter((item) => item.kind === 'branch').length, 1);
  assert.equal(allowed.stats.retryBudget, 1);

  const duplicate = preflightReplay(steps, { allowNonIdempotent: true, requireHumanValues: false, knownTokens: [allowed.token] });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.blockers.some((item) => item.code === PROGRAM_CODES.REPLAY_DUPLICATE), true);

  const override = preflightReplay(steps, { allowNonIdempotent: true, requireHumanValues: false, token: allowed.token, allowDuplicate: true });
  assert.equal(override.duplicate, false);
  assert.equal(override.ok, true);

  const human = preflightReplay([step({ ref: 'h1', method: 'fill', humanGate: { reason: '补值', valueKind: 'text' }, params: { selector: '#pwd' } })], { allowNonIdempotent: true });
  assert.equal(human.ok, false);
  assert.equal(human.requiresHuman.length, 1);
  assert.equal(human.requiresHuman[0].valueKind, 'text');
  assert.equal(human.blockers.some((item) => item.code === PROGRAM_CODES.REPLAY_HUMAN_REQUIRED), true);

  const humanWithValue = preflightReplay([step({ ref: 'h2', method: 'fill', humanGate: { reason: '补值', valueKind: 'text' }, params: { selector: '#pwd', value: 'secret' } })], { allowNonIdempotent: true });
  assert.equal(humanWithValue.requiresHuman.length, 0);
  assert.equal(humanWithValue.ok, true);

  const empty = preflightReplay([]);
  assert.equal(empty.ok, false);
  assert.equal(empty.blockers.some((item) => item.code === PROGRAM_CODES.REPLAY_EMPTY), true);

  const retryHeavy = Array.from({ length: 4 }, () => step({ method: 'hover', idempotent: true, fallback: { onError: 'retry', retries: 6 } }));
  const retry = preflightReplay(retryHeavy, { maxReplayRetries: 5 });
  assert.equal(retry.blockers.some((item) => item.code === PROGRAM_CODES.REPLAY_RETRY_BUDGET), true);

  const invalid = preflightReplay([step({ ref: 'bad', method: '' })], { allowNonIdempotent: true, requireHumanValues: false });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.blockers.some((item) => item.code === PROGRAM_CODES.REPLAY_VALIDATION), true);

  assert.equal(PROGRAM_LIMITS.maxSteps >= 100, true);
  assert.equal(allowed.program.fingerprint, programFingerprint(steps));
  assert.equal(preflightReplay(buildRecordProgram(steps), { allowNonIdempotent: true, requireHumanValues: false }).token, allowed.token);
});
