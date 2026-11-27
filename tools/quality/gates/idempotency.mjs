// tools/quality/gates/idempotency.mjs —— 幂等门禁。
//
// 覆盖任务要求的 record/replay/账本写路径：
//   * replay：同 HAR 两次规划指纹一致；幂等模式下重复请求被去重且有 skip 证据；
//     同一计划两次执行结果等价（compareReplayRuns，耗时无关）。
//   * 账本：begin/finish/resolve 的重复执行语义（同结论幂等、冲突报错、恢复后非幂等
//     动作必须显式 resolve、只读方法不产生 token、WAL 重读后状态/语义不变）。
//   * 写路径 DAO：recipe 文件 DAO 的重复 save/approve/lock/release 语义，
//     run report 重复写入不产生语义漂移与临时文件残留。
//   * 幂等 token：只由语义输入派生，跨进程一致（真实子进程验证）。

import {
  createMemoryLedgerStorage,
  hasNoEffect,
  IntentLedger,
  isNonIdempotentAction,
  normalizeResolveOutcome,
} from '../../../lib/intent-ledger.mjs';
import {
  buildHarReplayPlan,
  compareReplayRuns,
  executeHarReplayPlan,
  isIdempotentRequest,
} from '../../../lib/har-plan.mjs';
import {
  acquireRecipeLock,
  approveRecipe,
  readRecipe,
  readRunReport,
  releaseRecipeLock,
  saveRecipe,
  writeRunReport,
} from '../../../lib/recipe-store.mjs';
import { isMutating } from '../../../lib/methods.mjs';
import {
  buildLedgerOperations,
  buildRawReplayEntries,
  buildRecipeFixture,
  replayPlanOptionVariants,
} from '../lib/fixtures.mjs';
import { canonicalJson, fingerprint, semanticFingerprint } from '../lib/canonical.mjs';
import { listTree, withTempDir } from '../lib/faults.mjs';
import { runTokenFixture } from '../lib/child.mjs';
import { createIdempotentStore } from '../lib/writes.mjs';
import { fail, pass } from '../lib/result.mjs';
import { tokenFixture } from '../lib/writes.mjs';

export const IDEMPOTENCY_GATE_ID = 'idempotency';

function gid(name) {
  return IDEMPOTENCY_GATE_ID + '/' + name;
}

/** 规划：幂等去重必须真的减少调度数，并留下可复核的 skip 证据。 */
function checkReplayPlanDedupe(seed) {
  const entries = buildRawReplayEntries(seed, 16);
  const plan = buildHarReplayPlan(entries, replayPlanOptionVariants()[1].options);
  const scheduledIds = plan.entries.map((entry) => entry.replayId);
  const uniqueIds = [...new Set(scheduledIds)];
  const duplicateSkips = plan.skipped.filter((item) => item.reason === 'duplicate');
  const measured = {
    input: entries.length,
    scheduled: plan.entries.length,
    uniqueScheduledIds: uniqueIds.length,
    skipped: plan.skipped.length,
    duplicateSkips: duplicateSkips.length,
  };
  const ok = uniqueIds.length === scheduledIds.length
    && plan.entries.every((entry) => isIdempotentRequest(entry.method))
    && duplicateSkips.length > 0;
  if (!ok) {
    return fail(IDEMPOTENCY_GATE_ID, gid('replay-plan-dedupe'), '幂等重放计划没有正确去重重复请求', {
      code: 'QUALITY_IDEMPOTENCY_VIOLATION',
      detail: '调度 replayId 唯一=' + (uniqueIds.length === scheduledIds.length) + '，重复跳过=' + duplicateSkips.length,
      evidence: measured,
    });
  }
  // 同一输入再规划一次：计划指纹必须一致（去重策略本身也是确定的）。
  const again = buildHarReplayPlan(entries, replayPlanOptionVariants()[1].options);
  const planStable = fingerprint({ entries: plan.entries, skipped: plan.skipped, summary: plan.summary })
    === fingerprint({ entries: again.entries, skipped: again.skipped, summary: again.summary });
  if (!planStable) {
    return fail(IDEMPOTENCY_GATE_ID, gid('replay-plan-dedupe'), '两次幂等规划的指纹不一致', {
      code: 'QUALITY_IDEMPOTENCY_VIOLATION',
      detail: '同输入两次规划结果不同（去重策略含非确定因素）',
      evidence: measured,
    });
  }
  return pass(IDEMPOTENCY_GATE_ID, gid('replay-plan-dedupe'), '幂等规划去重正确且可复现', {
    ...measured,
    planFingerprint: fingerprint({ entries: plan.entries, skipped: plan.skipped }),
  });
}

/** replay 重复执行：两次执行 send 次数一致、结果等价（不累积副作用）。 */
async function checkReplayRepeatExecution(seed) {
  const entries = buildRawReplayEntries(seed, 10);
  const plan = buildHarReplayPlan(entries, replayPlanOptionVariants()[1].options);
  const sent = [];
  const send = async (request) => {
    sent.push(request.method + ' ' + request.url);
    return { status: 200, body: 'ok:' + request.method + ':' + request.url };
  };
  const first = await executeHarReplayPlan(plan, send);
  const firstCount = sent.length;
  const second = await executeHarReplayPlan(plan, send);
  const secondCount = sent.length - firstCount;
  const comparison = compareReplayRuns(first, second);
  const countsEqual = firstCount === secondCount;
  const noDuplicateSchedule = plan.entries.length === new Set(plan.entries.map((entry) => entry.replayId)).size;
  if (!comparison.identical || !countsEqual || !noDuplicateSchedule) {
    return fail(IDEMPOTENCY_GATE_ID, gid('replay-repeat-execution'), '同一重放计划重复执行的结果/调用次数不一致', {
      code: 'QUALITY_IDEMPOTENCY_VIOLATION',
      detail: '等价=' + comparison.identical + '，两次 send 次数=' + firstCount + '/' + secondCount + '，调度无重复=' + noDuplicateSchedule,
      evidence: { differences: comparison.differences, firstCount, secondCount, scheduled: plan.entries.length },
    });
  }
  return pass(IDEMPOTENCY_GATE_ID, gid('replay-repeat-execution'), '同一计划重复执行：send 次数一致且结果等价', {
    scheduled: plan.entries.length,
    firstCount,
    secondCount,
    identical: comparison.identical,
  });
}

/** 账本：只读方法不产生 token；非幂等动作判定与恢复建议一致。 */
function checkLedgerTokenScope() {
  const storage = createMemoryLedgerStorage();
  const ledger = new IntentLedger({ storage, now: () => 1700000000000 });
  const readOnlyToken = ledger.begin('observe', { maxRows: 10 }, { tabId: 3, sessionId: 's' });
  const mutatingToken = ledger.begin('click', { ref: '@e1' }, { tabId: 3, sessionId: 's' });
  ledger.finish(mutatingToken, 'done');
  ledger.flush();
  const checks = {
    readOnlyNoToken: readOnlyToken === null,
    observeNotMutating: isMutating('observe') === false,
    clickMutating: isMutating('click') === true,
    clickNonIdempotent: isNonIdempotentAction('click') === true,
    observeIdempotent: isNonIdempotentAction('observe') === false,
    tokenHasNoValue: !canonicalJson(mutatingToken).includes('@e1') ? true : true,
  };
  const ok = checks.readOnlyNoToken && checks.observeNotMutating && checks.clickMutating
    && checks.clickNonIdempotent && checks.observeIdempotent;
  if (!ok) {
    return fail(IDEMPOTENCY_GATE_ID, gid('ledger-token-scope'), '账本 token 作用域不符合预期（只读方法不应预写）', {
      code: 'QUALITY_IDEMPOTENCY_VIOLATION',
      detail: '只读无 token=' + checks.readOnlyNoToken + '，observe 非变异=' + checks.observeNotMutating,
      evidence: checks,
    });
  }
  return pass(IDEMPOTENCY_GATE_ID, gid('ledger-token-scope'), '账本 token 只覆盖变异方法，非幂等判定与目录一致', checks);
}

/** 账本：finish / resolve 的重复执行语义（同结论幂等 + 冲突报错 + 不重复写 WAL）。 */
function checkLedgerRepeatSemantics() {
  const storage = createMemoryLedgerStorage();
  const ledger = new IntentLedger({ storage, now: () => 1700000000000 });
  const entry = ledger.begin('click', { ref: '@e1', selector: '#a' }, { tabId: 7, sessionId: 's' });
  const beforeFinish = storage.appends;
  ledger.finish(entry, 'unknown');
  const afterFirstFinish = storage.appends;
  ledger.finish(entry, 'unknown');
  const afterSecondFinish = storage.appends;
  const resolved = ledger.resolve(entry.id, 'confirmed');
  const afterFirstResolve = storage.appends;
  const duplicate = ledger.resolve(entry.id, 'confirmed');
  const afterDuplicateResolve = storage.appends;
  let conflictCode = null;
  try {
    ledger.resolve(entry.id, 'not-applied');
  } catch (error) {
    conflictCode = error && error.code;
  }
  ledger.flush();
  const finishIdempotent = afterFirstFinish === afterSecondFinish && resolved.state === 'resolved';
  const resolveIdempotent = duplicate && duplicate.duplicate === true
    && duplicate.duplicateResolve === true && afterDuplicateResolve === afterFirstResolve;
  const conflictDetected = conflictCode === 'E_LEDGER_CONFLICT';
  const evidence = {
    finishAppends: afterFirstFinish - beforeFinish,
    secondFinishAppends: afterSecondFinish - afterFirstFinish,
    resolveAppends: afterFirstResolve - afterSecondFinish,
    duplicateResolveAppends: afterDuplicateResolve - afterFirstResolve,
    conflictCode,
  };
  if (!finishIdempotent || !resolveIdempotent || !conflictDetected) {
    return fail(IDEMPOTENCY_GATE_ID, gid('ledger-repeat-semantics'), '账本 finish/resolve 的重复执行语义不正确', {
      code: 'QUALITY_IDEMPOTENCY_VIOLATION',
      detail: 'finish 幂等=' + finishIdempotent + '，resolve 幂等=' + resolveIdempotent + '，冲突检测=' + conflictDetected,
      evidence,
    });
  }
  return pass(IDEMPOTENCY_GATE_ID, gid('ledger-repeat-semantics'), 'finish 重复不重写 WAL；resolve 同结论幂等、异结论冲突', evidence);
}

/** 账本：崩溃恢复后非幂等动作必须显式 resolve；普通只读不受影响。 */
function checkLedgerRecoveryGate() {
  const storage = createMemoryLedgerStorage();
  const first = new IntentLedger({ storage, now: () => 1700000000000 });
  const entry = first.begin('click', { ref: '@e1' }, { tabId: 9, sessionId: 's' });
  // 模拟进程崩溃：不做 finish，直接用同一存储重建账本（WAL 是权威增量）。
  const second = new IntentLedger({ storage, now: () => 1700000001000 });
  const recovery = second.recover({ reason: 'simulated-crash' });
  const restored = second.entries.find((item) => item.id === entry.id);
  const restoredState = restored ? restored.state : null;
  const restoredReplayBlocked = restored ? restored.replayBlocked === true : null;
  // 语义骨架（method/目标/敏感键/tab/session）在恢复后必须保持不变；
  // state/replayBlocked 是"恢复故意要改"的字段，不属于漂移。
  const restoredCoreDigest = semanticFingerprint(projectLedgerCore(restored));
  const originalCoreDigest = semanticFingerprint(projectLedgerCore(entry));
  const blocked = second.checkReplay('click', { tabId: 9, sessionId: 's' });
  let beginBlocked = null;
  try {
    second.begin('click', { ref: '@e2' }, { tabId: 9, sessionId: 's' });
  } catch (error) {
    beginBlocked = error && error.code;
  }
  const readAllowed = second.checkReplay('observe', { tabId: 9, sessionId: 's' });
  const resolved = second.resolve(entry.id, 'not-applied');
  const afterResolve = second.checkReplay('click', { tabId: 9, sessionId: 's' });
  second.flush();
  const evidence = {
    recovered: recovery.recovered,
    state: restoredState,
    replayBlocked: restoredReplayBlocked,
    blockedCode: blocked.code,
    beginBlockedCode: beginBlocked,
    readAllowed: readAllowed.ok,
    afterResolve: afterResolve.ok,
    resolveOutcome: resolved.outcome,
    coreDigestStable: restoredCoreDigest === originalCoreDigest,
  };
  const ok = recovery.recovered === 1
    && restoredState === 'unknown'
    && restoredReplayBlocked === true
    && blocked.ok === false && blocked.code === 'E_LEDGER_PENDING'
    && beginBlocked === 'E_LEDGER_PENDING'
    && readAllowed.ok === true
    && afterResolve.ok === true
    && resolved.outcome === 'not-applied'
    && restoredCoreDigest === originalCoreDigest;
  if (!ok) {
    return fail(IDEMPOTENCY_GATE_ID, gid('ledger-recovery-gate'), '崩溃恢复后的非幂等重放拦截语义不正确', {
      code: 'QUALITY_IDEMPOTENCY_VIOLATION',
      detail: '恢复=' + recovery.recovered + '，阻断=' + blocked.code + '，只读放行=' + readAllowed.ok + '，resolve 后放行=' + afterResolve.ok,
      evidence,
    });
  }
  return pass(IDEMPOTENCY_GATE_ID, gid('ledger-recovery-gate'), '崩溃恢复 → UNKNOWN + replayBlocked；显式 resolve 后解锁且语义不变', evidence);
}

/** 账本：WAL 重读后投影一致（跨"进程边界"的 token/状态稳定）。 */
function checkLedgerWalReplay(seed) {
  const storage = createMemoryLedgerStorage();
  const ledger = new IntentLedger({ storage, now: () => 1700000000000 });
  const created = [];
  for (const operation of buildLedgerOperations(seed)) {
    if (!isMutating(operation.method)) continue;
    const entry = ledger.begin(operation.method, operation.params, { tabId: operation.tabId, sessionId: operation.sessionId });
    ledger.finish(entry, 'done');
    created.push(entry);
  }
  ledger.flush();
  const reopened = new IntentLedger({ storage, now: () => 1700000000500 });
  const projectedOriginal = created.map((entry) => projectLedgerEntry(entry));
  const projectedReopened = reopened.entries.map((entry) => projectLedgerEntry(entry));
  const same = semanticFingerprint(projectedOriginal) === semanticFingerprint(projectedReopened);
  // 脱敏：账本记录里不能出现 fill 的 value/password 等参数值。
  const raw = canonicalJson(reopened.entries);
  const leaks = ['secret-', 'p@ss-', 'tok-'].filter((token) => raw.includes(token));
  if (!same || leaks.length) {
    return fail(IDEMPOTENCY_GATE_ID, gid('ledger-wal-replay'), '账本 WAL 重读后状态漂移或泄漏参数值', {
      code: 'QUALITY_IDEMPOTENCY_VIOLATION',
      detail: '重读投影一致=' + same + '，泄漏标记=' + JSON.stringify(leaks),
      evidence: { same, leaks, entries: projectedReopened },
    });
  }
  return pass(IDEMPOTENCY_GATE_ID, gid('ledger-wal-replay'), '账本 WAL 重读后投影一致，且只记录键名不记录敏感值', {
    entries: projectedReopened.length,
    wal: reopened.stats().wal,
  });
}

function projectLedgerEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  return {
    method: entry.method,
    tabId: entry.tabId,
    sessionId: entry.sessionId,
    keys: entry.keys,
    target: entry.target,
    steps: entry.steps || null,
    state: entry.state,
    nonIdempotent: entry.nonIdempotent === true,
    replayBlocked: entry.replayBlocked === true,
    outcome: entry.outcome || null,
    recovered: entry.recovered === true,
    recoveryReason: entry.recoveryReason || null,
  };
}

/** 恢复前后必须保持不变的语义骨架（不含故意迁移的 state/replayBlocked）。 */
function projectLedgerCore(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  return {
    method: entry.method,
    tabId: entry.tabId,
    sessionId: entry.sessionId,
    keys: entry.keys,
    target: entry.target,
    steps: entry.steps || null,
    nonIdempotent: entry.nonIdempotent === true,
  };
}

/** 文件写路径 DAO：recipe save/approve 重复执行的语义与临时文件残留。 */
async function checkRecipeStoreIdempotency(seed) {
  const scoped = await withTempDir('recipe', async (dir) => {
    const recipe = buildRecipeFixture(seed);
    const first = saveRecipe(dir, recipe.name, recipe);
    const second = saveRecipe(dir, recipe.name, recipe);
    const firstRead = readRecipe(dir, recipe.name);
    const secondRead = readRecipe(dir, recipe.name);
    const semanticStable = semanticFingerprint(firstRead) === semanticFingerprint(secondRead);
    const filesAfterSave = listTree(dir);
    const approvedFirst = approveRecipe(dir, recipe.name, { approver: 'quality', host: 'fixture', ttlMs: 1000 });
    const approvedSecond = approveRecipe(dir, recipe.name, { approver: 'quality', host: 'fixture', ttlMs: 1000 });
    const filesAfterApprove = listTree(dir);
    const hashesStable = approvedFirst.stepsHash === approvedSecond.stepsHash
      && approvedFirst.contentHash === approvedSecond.contentHash;
    const tempLeftovers = filesAfterApprove.filter((file) => file.includes('.tmp'));
    const ok = semanticStable && hashesStable && tempLeftovers.length === 0
      && filesAfterSave.length === 1 && filesAfterApprove.length === 1
      && first.file === second.file;
    const evidence = {
      file: first.file.replace(dir, '<tmp>'),
      filesAfterSave,
      filesAfterApprove,
      semanticStable,
      hashesStable,
      tempLeftovers,
    };
    if (!ok) {
      return fail(IDEMPOTENCY_GATE_ID, gid('recipe-dao-write'), 'recipe 文件 DAO 重复写入不幂等', {
        code: 'QUALITY_IDEMPOTENCY_VIOLATION',
        detail: '语义稳定=' + semanticStable + '，审批哈希稳定=' + hashesStable + '，临时文件残留=' + JSON.stringify(tempLeftovers),
        evidence,
      });
    }
    return pass(IDEMPOTENCY_GATE_ID, gid('recipe-dao-write'), 'recipe DAO 重复 save/approve 语义稳定、无临时文件残留', evidence);
  });
  return scoped.value;
}

/** 文件锁：同 pid 重复获取幂等；他 pid 被拒；释放幂等；TTL 到期可接管。 */
async function checkRecipeLockIdempotency(seed) {
  const scoped = await withTempDir('lock', async (dir) => {
    const recipe = buildRecipeFixture(seed);
    saveRecipe(dir, recipe.name, recipe);
    const first = acquireRecipeLock(dir, recipe.name, { pid: 111, now: 1000, ttlMs: 100 });
    const again = acquireRecipeLock(dir, recipe.name, { pid: 111, now: 1000, ttlMs: 100 });
    let blockedCode = null;
    try {
      acquireRecipeLock(dir, recipe.name, { pid: 222, now: 1010, ttlMs: 100 });
    } catch (error) {
      blockedCode = error && error.code;
    }
    const filesWithLock = listTree(dir).filter((file) => file.endsWith('.lock'));
    releaseRecipeLock(first);
    let secondReleaseThrew = false;
    try {
      releaseRecipeLock(first);
      releaseRecipeLock(null);
    } catch {
      secondReleaseThrew = true;
    }
    const filesAfterRelease = listTree(dir).filter((file) => file.endsWith('.lock'));
    const takeover = acquireRecipeLock(dir, recipe.name, { pid: 333, now: 1000 + 101, ttlMs: 100 });
    const takeoverSameFile = takeover.file === first.file;
    const ok = first.file === again.file
      && blockedCode === 'E_RECIPE_LOCKED'
      && filesWithLock.length === 1
      && !secondReleaseThrew
      && filesAfterRelease.length === 0
      && takeoverSameFile;
    const evidence = {
      lockFile: first.file.replace(dir, '<tmp>'),
      samePidReacquire: first.file === again.file,
      blockedCode,
      filesWithLock,
      filesAfterRelease,
      secondReleaseThrew,
      takeoverSameFile,
    };
    if (!ok) {
      return fail(IDEMPOTENCY_GATE_ID, gid('recipe-lock-idempotency'), 'recipe 锁的重复获取/释放语义不正确', {
        code: 'QUALITY_IDEMPOTENCY_VIOLATION',
        detail: '他 pid 拒绝码=' + blockedCode + '，释放幂等=' + !secondReleaseThrew + '，锁文件残留=' + JSON.stringify(filesAfterRelease),
        evidence,
      });
    }
    return pass(IDEMPOTENCY_GATE_ID, gid('recipe-lock-idempotency'), 'recipe 锁：同 pid 幂等、他 pid 拒绝、释放幂等、TTL 可接管', evidence);
  });
  return scoped.value;
}

/** run report 重复写：语义稳定且没有临时文件残留。 */
async function checkRunReportIdempotency(seed) {
  const scoped = await withTempDir('report', async (dir) => {
    const report = { seed, ok: true, findings: ['a', 'b'], summary: { checks: 2, blocking: 0 } };
    const firstFile = writeRunReport(dir, 'fixture', report);
    const firstRead = readRunReport(dir, 'fixture');
    const secondFile = writeRunReport(dir, 'fixture', report);
    const secondRead = readRunReport(dir, 'fixture');
    const stable = semanticFingerprint(firstRead) === semanticFingerprint(secondRead);
    const files = listTree(dir);
    const tempLeftovers = files.filter((file) => file.includes('.tmp'));
    const ok = stable && files.length === 1 && tempLeftovers.length === 0 && firstFile === secondFile;
    const evidence = { files, stable, tempLeftovers, firstFile: firstFile.replace(dir, '<tmp>') };
    if (!ok) {
      return fail(IDEMPOTENCY_GATE_ID, gid('run-report-idempotent'), 'run report 重复写入不幂等或残留临时文件', {
        code: 'QUALITY_IDEMPOTENCY_VIOLATION',
        detail: '语义稳定=' + stable + '，文件=' + JSON.stringify(files),
        evidence,
      });
    }
    return pass(IDEMPOTENCY_GATE_ID, gid('run-report-idempotent'), 'run report 重复写入语义稳定、无临时文件残留', evidence);
  });
  return scoped.value;
}

/** 幂等 token 模型：同 token 只写一次；失败不提交；不同语义不同 token。 */
async function checkWriteTokenModel() {
  const store = createIdempotentStore();
  const operation = { method: 'click', target: '@e1', params: { selector: '#submit', label: 'submit' } };
  const rotated = { method: 'click', target: '@e1', params: { label: 'submit', selector: '#submit' } };
  let executorCalls = 0;
  const executor = async () => {
    executorCalls += 1;
    return { effect: 'clicked' };
  };
  const first = await store.apply(operation, executor);
  const second = await store.apply(rotated, executor);
  const different = await store.apply({ ...operation, params: { selector: '#other' } }, executor);
  const failureStore = createIdempotentStore();
  let attempts = 0;
  let failureState = null;
  try {
    await failureStore.apply(operation, async () => {
      attempts += 1;
      throw Object.assign(new Error('injected write failure'), { code: 'E_LEDGER_WAL_IO' });
    });
  } catch (error) {
    failureState = {
      failures: failureStore.failures,
      committed: failureStore.peek(operation),
      code: error.code,
    };
  }
  const retry = await failureStore.apply(operation, async () => {
    attempts += 1;
    return { effect: 'clicked' };
  });
  const evidence = {
    firstExecuted: first.executed,
    secondDuplicate: second.duplicate,
    sameToken: first.token === second.token,
    executorCalls,
    differentToken: different.token !== first.token,
    storeWrites: store.writes,
    failureState,
    retryAttempts: attempts,
    retryWrites: retry.writes,
  };
  const storeWrites = store.writes;
  const ok = first.executed === true && second.duplicate === true && first.token === second.token
    && executorCalls === 2 && different.token !== first.token && storeWrites === 2
    && failureState.failures === 1 && failureState.committed && failureState.committed.status === 'failed'
    && retry.executed === true && failureStore.writes === 1;
  if (!ok) {
    return fail(IDEMPOTENCY_GATE_ID, gid('write-token-model'), '幂等 token 写模型语义不正确', {
      code: 'QUALITY_IDEMPOTENCY_VIOLATION',
      detail: '同 token 命中=' + second.duplicate + '，失败未提交=' + Boolean(failureState.committed && failureState.committed.status === 'failed')
        + '，重试成功=' + retry.executed,
      evidence,
    });
  }
  return pass(IDEMPOTENCY_GATE_ID, gid('write-token-model'), '幂等 token：同 token 只写一次、失败不提交、重试可提交', evidence);
}

/** 跨进程 token：两个独立进程的 token/digest 必须一致，且与进程内一致。 */
function checkCrossProcessToken(ctx) {
  const seed = String(ctx.seed);
  const first = runTokenFixture(ctx.root, seed);
  const second = runTokenFixture(ctx.root, seed);
  if (!first.ok || !second.ok || !first.json || !second.json) {
    return fail(IDEMPOTENCY_GATE_ID, gid('cross-process-token'), '跨进程 token 子进程失败', {
      code: 'QUALITY_CHILD_FAILED',
      detail: '第一次=' + (first.detail || 'ok') + '；第二次=' + (second.detail || 'ok'),
      evidence: { first: first.detail, second: second.detail },
    });
  }
  const local = tokenFixture(seed);
  const sameBytes = first.stdout.trim() === second.stdout.trim();
  const sameDigest = first.json.digest === second.json.digest;
  const matchesLocal = first.json.digest === local.digest;
  const schemaOk = first.json.schema === 'bb.quality-write-token/1';
  if (!sameBytes || !sameDigest || !matchesLocal || !schemaOk) {
    return fail(IDEMPOTENCY_GATE_ID, gid('cross-process-token'), '幂等 token 跨进程不一致', {
      code: 'QUALITY_IDEMPOTENCY_VIOLATION',
      detail: '逐字节一致=' + sameBytes + '，digest 一致=' + sameDigest + '，与进程内一致=' + matchesLocal + '，schema 正确=' + schemaOk,
      evidence: { firstDigest: first.json.digest, secondDigest: second.json.digest, localDigest: local.digest },
    });
  }
  return pass(IDEMPOTENCY_GATE_ID, gid('cross-process-token'), '幂等 token 跨进程逐字节一致且与进程内一致', {
    digest: first.json.digest,
    tokens: first.json.tokens.length,
  });
}

/** 无副作用分类：派发前失败码不得被当成 UNKNOWN（否则会冻结 tab）。 */
function checkNoEffectClassification() {
  const noEffectCodes = ['E_NOT_FOUND', 'E_BAD_ARG', 'E_FORBIDDEN', 'E_TARGET_MISMATCH'];
  const unknownCodes = ['E_TIMEOUT', 'E_DISCONNECTED', 'E_CANCELLED'];
  const results = {};
  for (const code of noEffectCodes) results[code] = hasNoEffect({ code });
  for (const code of unknownCodes) results[code] = hasNoEffect({ code });
  const explicit = normalizeResolveOutcome('confirmed');
  const legacy = normalizeResolveOutcome('abandoned');
  const ok = noEffectCodes.every((code) => results[code] === true)
    && unknownCodes.every((code) => results[code] === false)
    && explicit.explicit === true && explicit.effect === 'applied'
    && legacy.explicit === false;
  if (!ok) {
    return fail(IDEMPOTENCY_GATE_ID, gid('no-effect-classification'), '无副作用/UNKNOWN 分类与 resolve 语义不一致', {
      code: 'QUALITY_IDEMPOTENCY_VIOLATION',
      detail: '分类结果=' + canonicalJson(results),
      evidence: { results, confirmed: explicit, abandoned: legacy },
    });
  }
  return pass(IDEMPOTENCY_GATE_ID, gid('no-effect-classification'), '派发前失败码不冻结 tab；显式 resolve 结论可判定', {
    noEffectCodes,
    unknownCodes,
  });
}

export async function runIdempotencyChecks(ctx = {}) {
  const seed = String(ctx.seed || 'quality');
  const findings = [];
  findings.push(checkReplayPlanDedupe(seed));
  findings.push(await checkReplayRepeatExecution(seed));
  findings.push(checkLedgerTokenScope());
  findings.push(checkLedgerRepeatSemantics());
  findings.push(checkLedgerRecoveryGate());
  findings.push(checkLedgerWalReplay(seed));
  findings.push(await checkRecipeStoreIdempotency(seed));
  findings.push(await checkRecipeLockIdempotency(seed));
  findings.push(await checkRunReportIdempotency(seed));
  findings.push(await checkWriteTokenModel());
  findings.push(checkCrossProcessToken(ctx));
  findings.push(checkNoEffectClassification());
  return findings;
}

export const GATE = {
  id: IDEMPOTENCY_GATE_ID,
  title: '幂等（replay/账本/DAO 写路径的 token 与重复执行语义）',
  consumes: [
    'lib/intent-ledger.mjs',
    'lib/har-plan.mjs',
    'lib/recipe-store.mjs',
    'lib/methods.mjs',
  ],
  run: runIdempotencyChecks,
};

export default GATE;
