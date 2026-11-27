// tests/unit/record-exec-replay.test.mjs —— 回放会话（前置/游标/取消/checkpoint）与实跑对账：
//   1) beginReplay 继承 record-program.preflightReplay 的阻断与幂等 token；
//   2) ack 游标语义（顺序/重复/越界/结束态）；
//   3) checkpoint → restore（digest 校验）与取消（abort/skip/continue）；
//   4) finish 对账：状态 drift / 少 ack / 多 ack / 取消 / 实跑轨迹 diff；
//   5) 证据证书、计划键、轨迹封存、会话工厂与文本输出。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REPLAY_CODES,
  REPLAY_LIMITS,
  REPLAY_SESSION_VERSION,
  REPLAY_STATUS,
  ackBatch,
  beginReplay,
  cancelReplay,
  checkpointReplay,
  createReplaySessions,
  describeReplaySession,
  finishReplay,
  formatReplaySession,
  replayEvidence,
  replayPlanKey,
  replaySequence,
  restoreSession,
  sealReplayTrace,
  sessionStats,
  summarizeReplaySession,
  summarizeReplayTrace,
  verifyReplayEvidence,
  verifyReplayTrace,
} from '../../extension/src/lib/record-exec-replay.js';
import { buildStepGraph, PARALLEL_ROLES } from '../../extension/src/lib/record-step-graph.js';
import { buildRecordProgram } from '../../extension/src/record-program.js';

let refCounter = 0;
function step(overrides = {}) {
  refCounter += 1;
  const base = {
    model: 2,
    ref: 'v' + refCounter,
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

function click(ref, overrides = {}) {
  return step({ ref, method: 'click', params: { selector: '#' + ref }, target: { selector: '#' + ref }, ...overrides });
}

function idle(ref, overrides = {}) {
  return step({ ref, kind: 'wait', type: 'wait', method: 'wait', idempotent: true, risk: 'read_only', target: null, params: {}, fallback: { onError: 'retry', retries: 1 }, ...overrides });
}

function beginLinear(steps, options = {}) {
  return beginReplay(steps, { allowNonIdempotent: true, requireHumanValues: false, now: () => 1000, ...options });
}

test('beginReplay：线性程序 → running 会话、批次与 token 继承 preflight', () => {
  const steps = [click('a'), click('b'), idle('c')];
  const begun = beginLinear(steps);
  assert.equal(begun.ok, true);
  assert.equal(begun.code, null);
  assert.equal(begun.session.version, REPLAY_SESSION_VERSION);
  assert.equal(begun.session.status, REPLAY_STATUS.RUNNING);
  assert.equal(begun.session.total, 3);
  assert.equal(begun.session.cursor, 0);
  assert.match(begun.token, /^rp-[0-9a-f]{8}$/);
  assert.equal(begun.session.token, begun.token);
  assert.match(begun.session.fingerprint, /^p[0-9a-f]{8}-/);
  assert.deepEqual(begun.session.plan.map((batch) => batch.kind), ['serial', 'serial', 'serial']);
  assert.deepEqual(begun.session.plan.map((batch) => batch.ref), ['a', 'b', 'c']);
  assert.equal(begun.session.plan[0].expected, 'ok');
  assert.equal(begun.preflight.token, begun.token);
  assert.equal(begun.preflight.blockers, 0);
});

test('beginReplay：空程序/副作用阻断/已知 token 重复', () => {
  const empty = beginLinear([]);
  assert.equal(empty.ok, false);
  assert.equal(empty.code, REPLAY_CODES.REPLAY_EMPTY);
  assert.equal(empty.status, REPLAY_STATUS.ABORTED);
  assert.equal(empty.session.total, 0);

  const blocked = beginReplay([click('side')], { requireHumanValues: false, now: () => 1000 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, REPLAY_CODES.REPLAY_BLOCKED);
  assert.equal(blocked.session.status, REPLAY_STATUS.ABORTED);
  assert.equal(blocked.session.blocked.blockers.some((item) => item.code === 'REPLAY_SIDE_EFFECT'), true);

  const allowed = beginLinear([click('a')]);
  const duplicate = beginLinear([click('a')], { knownTokens: [allowed.token] });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, REPLAY_CODES.REPLAY_DUPLICATE);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.session.blocked.duplicate, true);
});

test('beginReplay：分支/并发批次进入计划（结构形状与执行器一致）', () => {
  const steps = [
    idle('pre'),
    step({ ref: 'nav', kind: 'branch', type: 'branch', method: 'navigate', idempotent: true, risk: 'read_only', target: null, params: { url: 'https://a.test/next' }, branch: { boundary: 'document', url: 'https://a.test/next', options: [{ label: 'go', to: 2 }] } }),
    idle('f', { parallel: { groupId: 'g', role: PARALLEL_ROLES.FORK } }),
    click('a0', { parallel: { groupId: 'g', role: PARALLEL_ROLES.ARM, arm: 0 } }),
    click('a1', { parallel: { groupId: 'g', role: PARALLEL_ROLES.ARM, arm: 1 } }),
    idle('j', { parallel: { groupId: 'g', role: PARALLEL_ROLES.JOIN } }),
  ];
  const graph = buildStepGraph(steps);
  assert.equal(graph.schedule.length, 3);
  const begun = beginLinear(steps);
  assert.equal(begun.ok, true);
  assert.equal(begun.session.total, 3);
  const branchBatch = begun.session.plan.find((batch) => batch.kind === 'branch');
  assert.ok(branchBatch);
  assert.equal(branchBatch.branchOptions.length, 1);
  const parallelBatch = begun.session.plan.find((batch) => batch.kind === 'parallel');
  assert.equal(parallelBatch.groupId, 'g');
  assert.deepEqual(parallelBatch.arms.map((arm) => arm[0]), ['a0', 'a1']);
  assert.equal(parallelBatch.waitFor, 'all');
});

test('ackBatch：顺序推进、重复/越界/乱序拒绝、结束态拒绝、计数与重试', () => {
  const begun = beginLinear([click('a'), click('b'), idle('c')]);
  const session = begun.session;
  assert.equal(ackBatch(session, { seq: 1, status: 'ok', at: 1000 }).ok, true);
  assert.equal(session.cursor, 1);
  assert.deepEqual(ackBatch(session, { seq: 1, status: 'ok' }).code, REPLAY_CODES.REPLAY_ACK_DUPLICATE);
  assert.equal(ackBatch(session, { seq: 3, status: 'ok' }).code, REPLAY_CODES.REPLAY_ACK_ORDER);
  assert.equal(ackBatch(session, { seq: 9, status: 'ok' }).code, REPLAY_CODES.REPLAY_ACK_UNKNOWN);
  const retried = ackBatch(session, { seq: 2, status: 'retry', attempts: 3, at: 1100 });
  assert.equal(retried.ok, true);
  assert.equal(retried.sessionStatus, REPLAY_STATUS.RUNNING);
  assert.equal(session.retries, 2);
  assert.equal(session.counts.retry, 1);
  const last = ackBatch(session, { seq: 3, status: 'skipped', at: 1200 });
  assert.equal(last.ok, true);
  assert.equal(last.sessionStatus, REPLAY_STATUS.COMPLETED);
  assert.equal(last.remaining, 0);
  assert.equal(session.status, REPLAY_STATUS.COMPLETED);
  assert.equal(session.finishedAt, 1200);
  assert.equal(ackBatch(session, { seq: 4 }).code, REPLAY_CODES.REPLAY_DONE);
  assert.equal(ackBatch(null, {}).code, REPLAY_CODES.REPLAY_BAD_ARG);
  // 未知状态按 ok 处理（ack 侧不做业务判断）。
  const fresh = beginLinear([click('x')]).session;
  assert.equal(ackBatch(fresh, { seq: 1, status: 'weird' }).status, 'ok');
});

test('checkpointReplay/restoreSession：往返恢复、digest 篡改检测、无计划恢复', () => {
  const steps = [click('a'), click('b'), idle('c')];
  const begun = beginLinear(steps);
  ackBatch(begun.session, { seq: 1, status: 'ok', at: 1000 });
  const saved = checkpointReplay(begun.session, { at: 1001 });
  assert.equal(saved.ok, true);
  assert.equal(saved.checkpoint.cursor, 1);
  assert.equal(saved.checkpoint.total, 3);
  assert.equal(saved.checkpoint.token, begun.token);
  assert.match(saved.checkpoint.digest, /^rs[0-9a-f]{8}$/);

  const restored = restoreSession(saved.checkpoint, { stepsOrProgram: steps });
  assert.equal(restored.ok, true);
  assert.equal(restored.session.cursor, 1);
  assert.equal(restored.session.status, REPLAY_STATUS.RUNNING);
  assert.equal(restored.session.restored, true);
  assert.equal(restored.session.plan.length, 3);
  const continued = ackBatch(restored.session, { seq: 2, status: 'ok', at: 1002 });
  assert.equal(continued.ok, true);

  const tampered = { ...saved.checkpoint, cursor: 2 };
  const rejected = restoreSession(tampered, { stepsOrProgram: steps });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, REPLAY_CODES.REPLAY_CHECKPOINT);

  const noPlan = restoreSession(saved.checkpoint);
  assert.equal(noPlan.ok, true);
  assert.equal(noPlan.session.plan.length, 0);
  assert.equal(restoreSession(null).ok, false);
});

test('cancelReplay：abort 结束会话并给出剩余批次；skip/continue 语义；完成后拒绝取消', () => {
  const steps = [click('a'), click('b'), click('c')];
  const abortSession = beginLinear(steps).session;
  ackBatch(abortSession, { seq: 1, status: 'ok', at: 1000 });
  const aborted = cancelReplay(abortSession, 'user-stop', { at: 1001 });
  assert.equal(aborted.ok, true);
  assert.equal(aborted.mode, 'abort');
  assert.equal(aborted.status, REPLAY_STATUS.CANCELLED);
  assert.equal(aborted.remaining, 2);
  assert.deepEqual(aborted.skipped.map((batch) => batch.seq), [2, 3]);
  assert.equal(akNull(abortSession), true);
  assert.equal(cancelReplay(abortSession, 'again').ok, false);

  const skipSession = beginLinear(steps).session;
  const skipped = cancelReplay(skipSession, 'skip-scope', { mode: 'skip' });
  assert.equal(skipped.mode, 'skip');
  assert.equal(skipped.cursor, 0);

  const continueSession = beginLinear(steps).session;
  const continued = cancelReplay(continueSession, 'record-only', { mode: 'continue' });
  assert.equal(continued.cancelled, true);
  assert.equal(continued.status, REPLAY_STATUS.RUNNING);
  assert.equal(continueSession.cancelled, true);
  assert.equal(ackBatch(continueSession, { seq: 1, status: 'ok' }).ok, true, 'continue 模式不阻断后续 ack');

  const finished = beginLinear([click('only')]).session;
  ackBatch(finished, { seq: 1, status: 'ok' });
  assert.equal(cancelReplay(finished, 'late').ok, false);
  assert.equal(cancelReplay(null, 'x').code, REPLAY_CODES.REPLAY_BAD_ARG);
});

function akNull(session) {
  return ackBatch(session, { seq: session.cursor + 1, status: 'ok' }).code === REPLAY_CODES.REPLAY_CANCELLED;
}

test('finishReplay：全部一致 → ok；状态 drift / 缺 ack / 未计划 ack / 取消 drift', () => {
  const steps = [click('a'), click('b')];
  const good = beginLinear(steps);
  ackBatch(good.session, { seq: 1, status: 'ok', at: 1000 });
  ackBatch(good.session, { seq: 2, status: 'ok', at: 1100 });
  const goodFinish = finishReplay(good.session, { at: 1200 });
  assert.equal(goodFinish.ok, true);
  assert.equal(goodFinish.status, REPLAY_STATUS.COMPLETED);
  assert.equal(goodFinish.drift.length, 0);
  assert.equal(goodFinish.code, null);
  assert.match(goodFinish.evidence.digest, /^rv[0-9a-f]{8}$/);

  const drifted = beginLinear(steps);
  ackBatch(drifted.session, { seq: 1, status: 'failed', at: 1000 });
  ackBatch(drifted.session, { seq: 2, status: 'ok', attempts: 2, at: 1100 });
  const driftFinish = finishReplay(drifted.session, { at: 1200 });
  assert.equal(driftFinish.ok, false);
  assert.equal(driftFinish.code, REPLAY_CODES.REPLAY_DRIFT);
  assert.equal(driftFinish.drift.some((item) => item.code === 'status-drift'), true);
  assert.equal(driftFinish.drift.some((item) => item.code === 'retry-drift'), true);

  const partial = beginLinear(steps);
  ackBatch(partial.session, { seq: 1, status: 'ok' });
  const partialFinish = finishReplay(partial.session);
  assert.equal(partialFinish.status, REPLAY_STATUS.ABORTED);
  assert.equal(partialFinish.drift.some((item) => item.code === 'missing-ack'), true);

  const cancelled = beginLinear(steps);
  ackBatch(cancelled.session, { seq: 1, status: 'ok' });
  cancelReplay(cancelled.session, 'stop', { at: 1000 });
  const cancelledFinish = finishReplay(cancelled.session, { at: 1001 });
  assert.equal(cancelledFinish.status, REPLAY_STATUS.CANCELLED);
  assert.equal(cancelledFinish.drift.some((item) => item.code === 'cancelled'), true);
  assert.equal(cancelledFinish.evidence.cancelled, true);
  assert.equal(finishReplay(null).code, REPLAY_CODES.REPLAY_BAD_ARG);
});

test('finishReplay：实际轨迹参与 diff（attempts/状态差异可见）', () => {
  const steps = [click('a'), click('b')];
  const run = beginLinear(steps);
  ackBatch(run.session, { seq: 1, status: 'ok', attempts: 2, at: 1000 });
  ackBatch(run.session, { seq: 2, status: 'ok', at: 1100 });
  const actualTrace = {
    entries: [
      { index: 0, ref: 'batch-1', kind: 'action', method: 'click', phase: 'serial', status: 'ok', attempts: 1, at: 1000 },
      { index: 1, ref: 'batch-2', kind: 'action', method: 'click', phase: 'serial', status: 'skipped', attempts: 1, at: 1100 },
    ],
  };
  const finished = finishReplay(run.session, { actualTrace, at: 1300 });
  assert.ok(finished.traceDiff);
  assert.equal(finished.traceDiff.equal, false);
  assert.equal(finished.traceDiff.changed.length, 2);
  assert.equal(finished.evidence.traceDigest.length > 0, true);
});

test('replayEvidence/verifyReplayEvidence：可复算、篡改检测、空输入', () => {
  const begun = beginLinear([click('a')]);
  ackBatch(begun.session, { seq: 1, status: 'ok', at: 1000 });
  const finished = finishReplay(begun.session, { at: 1001 });
  const verified = verifyReplayEvidence(finished.evidence);
  assert.equal(verified.ok, true);
  assert.equal(verified.sessionId, finished.evidence.sessionId);
  assert.equal(verified.drift, 0);

  const tampered = { ...finished.evidence, cursor: 0 };
  assert.equal(verifyReplayEvidence(tampered).ok, false);
  assert.equal(verifyReplayEvidence(tampered).code, REPLAY_CODES.REPLAY_EVIDENCE);
  assert.equal(verifyReplayEvidence(null).ok, false);

  const direct = replayEvidence(begun.session, { at: 1100 });
  assert.equal(direct.kind, 'replay.session');
  assert.equal(replayEvidence(null), null);
});

test('replaySequence：一次跑完（含 skipped 状态）并给出 drift', () => {
  const steps = [click('a'), click('b'), click('c')];
  const allOk = replaySequence(steps, ['ok', 'ok', 'ok'], { allowNonIdempotent: true, requireHumanValues: false, at: 2000 });
  assert.equal(allOk.ok, true);
  assert.equal(allOk.acks, 3);
  assert.equal(allOk.status, REPLAY_STATUS.COMPLETED);
  assert.equal(allOk.drift.length, 0);

  const withSkip = replaySequence(steps, ['ok', 'skipped'], { allowNonIdempotent: true, requireHumanValues: false, at: 2000 });
  assert.equal(withSkip.acks, 2);
  assert.equal(withSkip.status, REPLAY_STATUS.ABORTED);
  assert.equal(withSkip.drift.some((item) => item.code === 'missing-ack'), true);

  const blocked = replaySequence([click('side')], [], { requireHumanValues: false });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.acks, 0);
});

test('createReplaySessions：工厂 begin/ack/cancel/finish/restore/snapshot/list/stats/reset', () => {
  const factory = createReplaySessions({ now: () => 3000 });
  const begun = factory.begin([click('a'), click('b')], { allowNonIdempotent: true, requireHumanValues: false });
  assert.equal(begun.ok, true);
  const sessionId = begun.session.sessionId;
  assert.equal(factory.ack(sessionId, { seq: 1, status: 'ok', at: 3000 }).ok, true);
  assert.equal(factory.ack('missing', { seq: 1 }).code, REPLAY_CODES.REPLAY_BAD_ARG);
  assert.equal(factory.snapshot(sessionId).cursor, 1);
  assert.equal(factory.list().length, 1);
  const finished = factory.finish(sessionId, { at: 3001 });
  assert.equal(finished.ok, false, '少 ack 时 finish 不通过');
  assert.equal(factory.stats().completed, 0);

  const toCancel = factory.begin([click('c'), click('d')], { allowNonIdempotent: true, requireHumanValues: false });
  const cancelled = factory.cancel(toCancel.session.sessionId, 'user');
  assert.equal(cancelled.ok, true);
  assert.equal(factory.stats().cancelled, 1);
  assert.equal(factory.cancel('missing', 'x').ok, false);

  const dup = factory.begin([click('a'), click('b')], { allowNonIdempotent: true, requireHumanValues: false });
  assert.equal(dup.code, REPLAY_CODES.REPLAY_DUPLICATE);
  assert.equal(factory.stats().dupes >= 1, true);

  const snapshot = factory.snapshot(sessionId);
  assert.equal(snapshot.cursor, 1);
  assert.equal(snapshot.total, 2);
  const rawSession = factory.get(sessionId);
  assert.equal(rawSession.sessionId, sessionId);
  const restored = factory.restore(checkpointReplay(rawSession, {}).checkpoint, { stepsOrProgram: [click('a'), click('b')] });
  assert.equal(restored.ok, true);
  assert.equal(factory.stats().restored, 1);
  assert.equal(factory.get('missing'), null);
  assert.equal(factory.reset().cleared >= 1, true);
  assert.equal(factory.list().length, 0);
});

test('replayPlanKey/sealReplayTrace/verifyReplayTrace/summarizeReplayTrace：计划键与轨迹封存', () => {
  const steps = [click('a'), click('b')];
  const key = replayPlanKey(steps);
  assert.match(key, /^rk1-[0-9a-f]{8}$/);
  assert.equal(replayPlanKey(steps), key, '同计划 key 稳定');
  assert.notEqual(replayPlanKey([click('a'), click('c')]), key);

  const begun = beginLinear(steps);
  ackBatch(begun.session, { seq: 1, status: 'ok', at: 1000 });
  ackBatch(begun.session, { seq: 2, status: 'failed', at: 1100 });
  const sealed = sealReplayTrace(begun.session);
  assert.equal(sealed.sealed, true);
  assert.equal(sealed.count, 2);
  assert.equal(sealed.extra.sessionId, begun.session.sessionId);
  assert.equal(verifyReplayTrace(sealed).ok, true);
  const tampered = { ...sealed, entries: sealed.entries.map((entry, index) => (index === 0 ? { ...entry, status: 'skipped' } : entry)) };
  assert.equal(verifyReplayTrace(tampered).ok, false);

  const summary = summarizeReplayTrace(begun.session);
  assert.equal(summary.count, 2);
  assert.equal(summary.byStatus.failed, 1);
  assert.equal(summary.sealed.count, 2);
  assert.equal(verifyReplayTrace(sealReplayTrace(null)).ok, true, '空会话也能封存校验');
});

test('summarize/describe/format/sessionStats：紧凑摘要与文本上限', () => {
  const begun = beginLinear([click('a'), click('b')]);
  ackBatch(begun.session, { seq: 1, status: 'ok', at: 1000 });
  const summary = summarizeReplaySession(begun.session);
  assert.equal(summary.version, REPLAY_SESSION_VERSION);
  assert.equal(summary.cursor, 1);
  assert.equal(summary.total, 2);
  assert.equal(summary.status, REPLAY_STATUS.RUNNING);
  assert.equal(summary.counts.ok, 1);
  assert.equal(summary.batches, 2);
  assert.ok(JSON.stringify(summary).length < 600);
  assert.equal(summarizeReplaySession(null), null);

  const described = describeReplaySession(begun.session);
  assert.match(described, /^replay=running/);
  assert.match(described, /cursor=1\/2/);
  assert.match(described, /ok=1/);
  assert.match(described, /token=/);
  assert.equal(describeReplaySession(null), 'replay: 无会话');
  const lines = formatReplaySession(begun.session, { maxLines: 2 });
  assert.equal(lines.length, 2);
  assert.match(lines[1], /#1 serial/);
  assert.deepEqual(formatReplaySession(null), ['replay: 无会话']);

  const stats = sessionStats([begun.session, { status: REPLAY_STATUS.CANCELLED, acks: [], drift: [] }, { status: REPLAY_STATUS.ABORTED, acks: [] }]);
  assert.equal(stats.total, 3);
  assert.equal(stats.running, 1);
  assert.equal(stats.cancelled, 1);
  assert.equal(stats.aborted, 1);
  assert.equal(stats.acks, 1);
  assert.ok(REPLAY_LIMITS.maxBatches >= 100);
});

test('beginReplay：接受已构建 program（nodes）并复用其指纹；计划键对 program 也稳定', () => {
  const steps = [click('a'), idle('b')];
  const program = buildRecordProgram(steps);
  const begun = beginReplay(program, { allowNonIdempotent: true, requireHumanValues: false, now: () => 5000 });
  assert.equal(begun.ok, true);
  assert.equal(begun.session.fingerprint, program.fingerprint);
  assert.equal(begun.session.total, 2);
  assert.equal(begun.session.plan[0].ref, 'a');
  assert.equal(replayPlanKey(program), replayPlanKey(steps));
  assert.equal(begun.session.graph.nodes, 2);
});

test('restoreSession：显式 plan 恢复 + 完成态恢复 + 空 stats', () => {
  const steps = [click('a'), click('b')];
  const begun = beginLinear(steps);
  ackBatch(begun.session, { seq: 1, status: 'ok', at: 1000 });
  ackBatch(begun.session, { seq: 2, status: 'ok', at: 1100 });
  const saved = checkpointReplay(begun.session, { at: 1200 });
  assert.equal(saved.checkpoint.status, REPLAY_STATUS.COMPLETED);
  const restored = restoreSession(saved.checkpoint, { plan: begun.session.plan });
  assert.equal(restored.ok, true);
  assert.equal(restored.session.status, REPLAY_STATUS.COMPLETED);
  assert.equal(restored.session.plan.length, 2);
  assert.equal(ackBatch(restored.session, { seq: 3 }).code, REPLAY_CODES.REPLAY_DONE);

  assert.equal(sessionStats([]).total, 0);
  assert.equal(sessionStats(null).acks, 0);
  assert.equal(sessionStats([{ status: 'weird' }]).aborted, 1);
});

test('checkpoint 上限：多次保存只保留最近 maxCheckpoints 个', () => {
  const begun = beginLinear([click('a'), click('b')]);
  for (let index = 0; index < REPLAY_LIMITS.maxCheckpoints + 4; index += 1) {
    checkpointReplay(begun.session, { at: 1000 + index });
  }
  assert.equal(begun.session.checkpoints.length, REPLAY_LIMITS.maxCheckpoints);
  assert.equal(checkpointReplay(null).ok, false);
});
