// tools/quality/gates/determinism.mjs —— 确定性门禁。
//
// 目标：关键纯函数/规划器"同输入 N 次 → 指纹一致"，并证明跨进程同 seed 稳定。
// 做法不是手写 N 份断言，而是把可确定性输入抽成 FINGERPRINT_TARGETS：
//   * 进程内：每个 target 跑 repeats 次，规范化 JSON 指纹必须全等；
//   * 跨进程：run.mjs --fingerprint-suite 用同一套 targets 生成 suite，
//     本 gate spawn 两个独立 node 进程比较逐字节结果；
//   * 反空洞：内置"故意不稳定"的负控制，若探测器放行负控制则门禁失败。
//
// 注意边界：执行器（executeHarReplayPlan）天然带耗时字段，不能用严格指纹；
// 对它的确定性断言是 compareReplayRuns（耗时无关的等价性），单独一条检查覆盖。

import { ERROR_CODE_LIST, normalizeErrorCode, recoveryHint } from '../../../lib/error-codes.mjs';
import {
  buildHarReplayPlan,
  compareReplayRuns,
  executeHarReplayPlan,
  normalizeReplayEntry,
  replayIdOf,
  summarizeHarReplayPlan,
} from '../../../lib/har-plan.mjs';
import { parseHarReplayEntries, planHarReplay } from '../../../lib/har-replay.mjs';
import { compactTrace, planTraceExport, sampleTraceEvents, summarizeTraceSampling } from '../../../lib/trace-budget.mjs';
import { normalizePlanStep, normalizePlanSteps } from '../../../lib/plan-steps.mjs';
import { SessionRunLog } from '../../../lib/run-log.mjs';
import {
  canonicalJson,
  fingerprint,
  firstDifference,
  multisetFingerprint,
  rotateKeys,
  stableSortBy,
} from '../lib/canonical.mjs';
import {
  buildHarFixture,
  buildLedgerOperations,
  buildRawReplayEntries,
  buildRecipeFixture,
  buildTraceFixture,
  projectReplayPlan,
  replayPlanOptionVariants,
  samplingOptionVariants,
} from '../lib/fixtures.mjs';
import { createFixedClock } from '../lib/prng.mjs';
import { runFingerprintSuite } from '../lib/child.mjs';
import { fail, makeFinding, pass } from '../lib/result.mjs';

export const DETERMINISM_GATE_ID = 'determinism';

/** 把一个"输入 seed → 纯输出"的可确定目标登记成 target。 */
function target(name, build, describe) {
  return { name, build, describe: describe || '' };
}

/**
 * 确定性目标清单：进程内重复与跨进程 suite 共用同一份定义（避免两套口径）。
 * 所有 build(seed) 必须只依赖 seed（可再加常量），不得读时钟/随机/环境。
 */
export const FINGERPRINT_TARGETS = Object.freeze([
  target('har-plan-sequential', (seed) => projectReplayPlan(buildHarReplayPlan(
    parseHarReplayEntries(buildHarFixture(seed)),
    replayPlanOptionVariants()[0].options,
  )), 'HAR 重放计划：顺序模式'),
  target('har-plan-idempotent', (seed) => projectReplayPlan(buildHarReplayPlan(
    parseHarReplayEntries(buildHarFixture(seed)),
    replayPlanOptionVariants()[1].options,
  )), 'HAR 重放计划：幂等去重模式'),
  target('har-plan-time-order', (seed) => projectReplayPlan(planHarReplay(
    buildHarFixture(seed),
    replayPlanOptionVariants()[2].options,
  )), 'HAR 重放计划：时间排序模式'),
  target('har-plan-idempotent-first', (seed) => projectReplayPlan(buildHarReplayPlan(
    parseHarReplayEntries(buildHarFixture(seed)),
    replayPlanOptionVariants()[3].options,
  )), 'HAR 重放计划：幂等优先 + 截断'),
  target('har-replay-entries', (seed) => parseHarReplayEntries(buildHarFixture(seed)), 'HAR → 可重放条目'),
  target('replay-id-projection', (seed) => buildRawReplayEntries(seed).map((entry) => normalizeReplayEntry(entry, entry.index))
    .map((entry) => ({ index: entry.index, replayId: entry.replayId, method: entry.method, resourceType: entry.resourceType })), '重放标识投影'),
  target('replay-plan-summary', (seed) => summarizeHarReplayPlan(buildHarReplayPlan(
    parseHarReplayEntries(buildHarFixture(seed)),
    replayPlanOptionVariants()[1].options,
  )), '计划摘要统计'),
  target('trace-plan', (seed) => planTraceExport(buildTraceFixture(seed), {
    maxEvents: 120,
    maxSpans: 20,
    maxSteps: 8,
    maxStateChars: 120,
    maxScreenshots: 2,
  }), 'trace 导出预算计划'),
  target('trace-sampling-uniform', (seed) => summarizeTraceSampling(sampleTraceEvents(
    buildTraceFixture(seed).traceEvents,
    samplingOptionVariants()[1].options,
  )), 'trace 均匀采样（seed 固定）'),
  target('trace-sampling-duration', (seed) => summarizeTraceSampling(sampleTraceEvents(
    buildTraceFixture(seed).traceEvents,
    samplingOptionVariants()[0].options,
  )), 'trace 时长优先采样'),
  target('trace-compact', (seed) => {
    const result = compactTrace(buildTraceFixture(seed), { maxEvents: 80, maxSpans: 8, maxSteps: 5, force: true });
    return { trace: result.trace, plan: result.plan };
  }, 'trace 体积降级（compact）'),
  target('plan-steps', (seed) => normalizePlanSteps(buildRecipeFixture(seed).steps.concat([
    { action: 'fill', ref: '@e9', value: 'x' },
    { action: { method: 'click', params: { ref: '@e10' } } },
  ])), 'plan 步骤归一化'),
  target('plan-step-single', (seed) => normalizePlanStep({ action: 'fill', ref: '@e9', value: 'x' }), '单步 plan 归一化'),
  target('run-log-snapshot', (seed) => {
    const log = new SessionRunLog({ now: createFixedClock(1700000000000).now });
    for (const operation of buildLedgerOperations(seed)) {
      log.record({
        method: operation.method,
        target: { ref: '@e1', selector: '#submit' },
        url: 'https://fixture.invalid/a/b?q=secret',
        revision: 2,
        tabId: operation.tabId,
      });
    }
    return log.snapshot();
  }, '会话运行日志（固定时钟）'),
  target('error-recovery', () => {
    const codes = stableSortBy(ERROR_CODE_LIST, (code) => code);
    return codes.map((code) => ({
      code,
      retry: recoveryHint(code).retry,
      normalized: normalizeErrorCode(code),
      hintHash: fingerprint(recoveryHint(code).hint || ''),
    }));
  }, '错误码恢复建议（全量码表）'),
]);

/** 目标在 repeats 次调用下的指纹证据。 */
export function evaluateTarget(entry, { seed = 'quality', repeats = 5 } = {}) {
  const values = [];
  const prints = [];
  const times = Math.max(2, Math.floor(Number(repeats) || 5));
  for (let index = 0; index < times; index += 1) {
    const value = entry.build(seed);
    values.push(value);
    prints.push(fingerprint(value));
  }
  let mismatch = null;
  for (let index = 1; index < prints.length; index += 1) {
    if (prints[index] !== prints[0]) {
      mismatch = firstDifference(values[0], values[index]);
      break;
    }
  }
  return {
    name: entry.name,
    repeats: times,
    fingerprint: prints[0],
    stable: mismatch == null,
    mismatch,
    distinctFingerprints: [...new Set(prints)],
  };
}

/** 夹具指纹块（供跨进程 suite 与"不同 seed 确实不同"检查）。 */
export function fixtureDigestBlock(seed) {
  return {
    har: fingerprint(buildHarFixture(seed)),
    trace: fingerprint(buildTraceFixture(seed)),
    recipe: fingerprint(buildRecipeFixture(seed)),
    ledgerOps: fingerprint(buildLedgerOperations(seed)),
  };
}

/**
 * 跨进程 fingerprint suite：run.mjs --fingerprint-suite 与本 gate 的跨进程检查共用。
 * 输出不含时间/路径/随机；同一 seed 的两个进程必须逐字节一致。
 */
export function buildFingerprintSuite({ seed = 'quality', repeats = 5 } = {}) {
  const targets = {};
  for (const entry of FINGERPRINT_TARGETS) {
    const result = evaluateTarget(entry, { seed, repeats });
    targets[result.name] = {
      fingerprint: result.fingerprint,
      stable: result.stable,
      repeats: result.repeats,
      distinctFingerprints: result.distinctFingerprints,
    };
  }
  const fixtures = fixtureDigestBlock(seed);
  const suite = {
    schema: 'bb.quality-fingerprint/1',
    seed: String(seed),
    repeats: Math.max(2, Math.floor(Number(repeats) || 5)),
    fixtures,
    targets,
  };
  suite.digest = fingerprint({ fixtures, targets });
  return suite;
}

function gateId(id) {
  return DETERMINISM_GATE_ID + '/' + id;
}

function targetFinding(result, repeats) {
  const id = gateId('target-' + result.name);
  if (result.stable) {
    return pass(DETERMINISM_GATE_ID, id, '确定性目标 ' + result.name + ' 重复 ' + repeats + ' 次指纹一致', {
      fingerprint: result.fingerprint,
      repeats: result.repeats,
    });
  }
  return fail(DETERMINISM_GATE_ID, id, '确定性目标 ' + result.name + ' 重复调用不一致', {
    code: 'QUALITY_DETERMINISM_MISMATCH',
    detail: '首次差异路径=' + String(result.mismatch && result.mismatch.path)
      + '，不同指纹=' + result.distinctFingerprints.join(','),
    evidence: {
      target: result.name,
      repeats: result.repeats,
      distinctFingerprints: result.distinctFingerprints,
      mismatch: result.mismatch,
    },
  });
}

/** 键顺序不敏感、数组顺序敏感（规范化本身的契约）。 */
function checkCanonicalization() {
  const base = { b: 1, a: [1, 2, 3], nested: { z: true, y: null } };
  const rotated = rotateKeys(base, 1);
  const same = fingerprint(base) === fingerprint(rotated);
  const arrayReordered = { ...base, a: [3, 2, 1] };
  const arraySensitive = fingerprint(base) !== fingerprint(arrayReordered);
  if (!same || !arraySensitive) {
    return fail(DETERMINISM_GATE_ID, gateId('canonical-form'), '规范化 JSON 的键序/数组语义不符合契约', {
      code: 'QUALITY_DETERMINISM_MISMATCH',
      detail: '键序不敏感=' + same + '，数组顺序敏感=' + arraySensitive,
      evidence: { keyOrderInsensitive: same, arrayOrderSensitive: arraySensitive },
    });
  }
  return pass(DETERMINISM_GATE_ID, gateId('canonical-form'), '规范化 JSON：键序不敏感、数组顺序敏感', {
    fingerprint: fingerprint(base),
  });
}

/** 重放标识：header 顺序/大小写不影响；body/content-type 变化必须改变 id。 */
function checkReplayIdSemantics() {
  const base = { method: 'POST', url: 'https://fixture.invalid/api/x', headers: [{ name: 'content-type', value: 'application/json' }, { name: 'x-a', value: '1' }], body: '{"a":1}' };
  const headersReordered = { ...base, headers: [...base.headers].reverse() };
  const headerCase = { ...base, headers: [{ name: 'Content-Type', value: 'application/json' }, { name: 'x-a', value: '1' }] };
  const bodyChanged = { ...base, body: '{"a":2}' };
  const contentTypeChanged = { ...base, headers: [{ name: 'content-type', value: 'text/plain' }, { name: 'x-a', value: '1' }] };
  const ids = {
    base: replayIdOf(base),
    reordered: replayIdOf(headersReordered),
    caseFolded: replayIdOf(headerCase),
    body: replayIdOf(bodyChanged),
    contentType: replayIdOf(contentTypeChanged),
  };
  const stable = ids.base === ids.reordered && ids.base === ids.caseFolded;
  const sensitive = ids.base !== ids.body && ids.base !== ids.contentType;
  if (!stable || !sensitive) {
    return fail(DETERMINISM_GATE_ID, gateId('replay-id-semantics'), 'replayId 的稳定/敏感语义不符合预期', {
      code: 'QUALITY_DETERMINISM_MISMATCH',
      detail: 'header 稳定=' + stable + '，payload 敏感=' + sensitive,
      evidence: { ids, headerStable: stable, payloadSensitive: sensitive },
    });
  }
  return pass(DETERMINISM_GATE_ID, gateId('replay-id-semantics'), 'replayId：header 顺序/大小写稳定，body/content-type 敏感', {
    replayId: ids.base,
  });
}

/** 执行器等价的确定性：耗时字段必须被等价性比较排除。 */
async function checkExecutorEquivalence(seed) {
  const plan = buildHarReplayPlan(parseHarReplayEntries(buildHarFixture(seed)), replayPlanOptionVariants()[0].options);
  const send = async (request) => ({ status: 200, body: 'echo:' + request.method + ':' + request.url });
  const first = await executeHarReplayPlan(plan, send);
  const second = await executeHarReplayPlan(plan, send);
  const comparison = compareReplayRuns(first, second);
  const projectionEqual = canonicalJson(projectRunResults(first)) === canonicalJson(projectRunResults(second));
  if (!comparison.identical || !projectionEqual) {
    return fail(DETERMINISM_GATE_ID, gateId('executor-equivalence'), '同一计划两次执行的结果不等价', {
      code: 'QUALITY_DETERMINISM_MISMATCH',
      detail: 'compareReplayRuns.identical=' + comparison.identical + '，投影相等=' + projectionEqual,
      evidence: { differences: comparison.differences, projectionEqual },
    });
  }
  const durationsPresent = first.results.every((result) => typeof result.durationMs === 'number');
  return pass(DETERMINISM_GATE_ID, gateId('executor-equivalence'), '执行器两次运行耗时无关等价（耗时字段存在但被等价性比较排除）', {
    results: first.results.length,
    compareIdentical: comparison.identical,
    durationsPresent,
  });
}

function projectRunResults(run) {
  return (run.results || []).map((result) => ({
    index: result.index,
    replayId: result.replayId,
    ok: result.ok,
    status: result.status,
    bodyHash: result.bodyHash,
    attempts: result.attempts,
    error: result.error,
  }));
}

/** 探测器负控制：必须能识别不稳定样本，且不能误伤稳定样本。 */
function checkDetectorControl() {
  let counter = 0;
  const flakyEntry = target('negative-control-flaky', () => ({ tick: counter += 1, value: 7 }));
  const stableEntry = target('negative-control-stable', () => ({ value: 7, list: [1, 2, 3] }));
  const flaky = evaluateTarget(flakyEntry, { seed: 'control', repeats: 4 });
  const stable = evaluateTarget(stableEntry, { seed: 'control', repeats: 4 });
  if (flaky.stable || !stable.stable) {
    return fail(DETERMINISM_GATE_ID, gateId('detector-control'), '确定性探测器控制样本结果错误（门禁可能空转）', {
      code: 'QUALITY_DETERMINISM_DETECTOR_BLIND',
      detail: '不稳定的负控制被判稳定=' + flaky.stable + '；稳定控制被判不稳定=' + !stable.stable,
      evidence: {
        flakyStable: flaky.stable,
        stableDetected: stable.stable,
        flakyFingerprints: flaky.distinctFingerprints,
      },
    });
  }
  return pass(DETERMINISM_GATE_ID, gateId('detector-control'), '探测器负控制通过：不稳定样本被抓、稳定样本不误报', {
    flakyDistinct: flaky.distinctFingerprints.length,
    stableFingerprint: stable.fingerprint,
  });
}

/** 不同 seed 必须产生不同夹具（证明 seed 真的贯穿到输入）。 */
function checkSeedSensitivity(seed) {
  const first = fixtureDigestBlock(seed);
  const second = fixtureDigestBlock(seed + '-alt');
  const differing = Object.keys(first).filter((key) => first[key] !== second[key]);
  const same = fingerprint(first) === fingerprint(second);
  if (same || differing.length === 0) {
    return fail(DETERMINISM_GATE_ID, gateId('seed-sensitivity'), '不同 seed 的夹具指纹完全相同（seed 未贯穿输入）', {
      code: 'QUALITY_SEED_UNSTABLE',
      detail: 'seed=' + seed + ' 与 ' + seed + '-alt 的夹具 digest 相同',
      evidence: { first, second },
    });
  }
  return pass(DETERMINISM_GATE_ID, gateId('seed-sensitivity'), '不同 seed 产生不同夹具（seed 已贯穿夹具生成）', {
    differing,
    firstDigest: fingerprint(first),
    secondDigest: fingerprint(second),
  });
}

/** 跨进程：两个独立 node 进程、同 seed → suite 逐字节一致；另一 seed 仍自洽。 */
function checkCrossProcess(ctx) {
  const seed = String(ctx.seed);
  const repeats = Math.max(2, Number(ctx.repeats) || 5);
  const first = runFingerprintSuite(ctx.root, seed, { repeats });
  const second = runFingerprintSuite(ctx.root, seed, { repeats });
  if (!first.ok || !second.ok || !first.json || !second.json) {
    return fail(DETERMINISM_GATE_ID, gateId('cross-process'), '跨进程 fingerprint suite 子进程失败', {
      code: 'QUALITY_CHILD_FAILED',
      detail: '第一次=' + (first.detail || 'ok') + '；第二次=' + (second.detail || 'ok'),
      evidence: { first: first.detail, second: second.detail },
    });
  }
  const sameBytes = first.stdout.trim() === second.stdout.trim();
  const sameDigest = first.json.digest === second.json.digest;
  const allTargetsStable = Object.values(first.json.targets || {}).every((entry) => entry.stable === true);
  const schemaOk = first.json.schema === 'bb.quality-fingerprint/1' && first.json.seed === seed;
  if (!sameBytes || !sameDigest || !allTargetsStable || !schemaOk) {
    return fail(DETERMINISM_GATE_ID, gateId('cross-process'), '跨进程同 seed 结果不稳定', {
      code: 'QUALITY_SEED_UNSTABLE',
      detail: '逐字节一致=' + sameBytes + '，digest 一致=' + sameDigest + '，全部 target 稳定=' + allTargetsStable + '，schema/seed 正确=' + schemaOk,
      evidence: {
        firstDigest: first.json.digest,
        secondDigest: second.json.digest,
        allTargetsStable,
        schemaOk,
      },
    });
  }
  // 另一个 seed：进程内仍必须自洽（target 全稳定），且夹具块与 seed 不同。
  const alt = runFingerprintSuite(ctx.root, seed + '-alt', { repeats });
  if (!alt.ok || !alt.json) {
    return fail(DETERMINISM_GATE_ID, gateId('cross-process-alt-seed'), '跨进程 alt-seed 子进程失败', {
      code: 'QUALITY_CHILD_FAILED',
      detail: alt.detail || 'ok',
      evidence: { seed: seed + '-alt' },
    });
  }
  const altTargetsStable = Object.values(alt.json.targets || {}).every((entry) => entry.stable === true);
  const altFixturesDiffer = fingerprint(alt.json.fixtures) !== fingerprint(first.json.fixtures);
  if (!altTargetsStable || !altFixturesDiffer) {
    return fail(DETERMINISM_GATE_ID, gateId('cross-process-alt-seed'), 'alt seed 跨进程结果不符合预期', {
      code: 'QUALITY_SEED_UNSTABLE',
      detail: 'alt target 全稳定=' + altTargetsStable + '，alt 夹具与主 seed 不同=' + altFixturesDiffer,
      evidence: { altTargetsStable, altFixturesDiffer, altDigest: alt.json.digest },
    });
  }
  return pass(DETERMINISM_GATE_ID, gateId('cross-process'), '跨进程同 seed 逐字节一致；alt seed 仍自洽且夹具不同', {
    digest: first.json.digest,
    targets: Object.keys(first.json.targets || {}).length,
    altDigest: alt.json.digest,
  });
}

/** gate 入口。ctx: {seed, repeats, root, timers?} */
export async function runDeterminismChecks(ctx = {}) {
  const seed = String(ctx.seed || 'quality');
  const repeats = Math.max(2, Number(ctx.repeats) || 5);
  const findings = [];
  for (const entry of FINGERPRINT_TARGETS) {
    findings.push(targetFinding(evaluateTarget(entry, { seed, repeats }), repeats));
  }
  findings.push(checkCanonicalization());
  findings.push(checkReplayIdSemantics());
  findings.push(await checkExecutorEquivalence(seed));
  findings.push(checkDetectorControl());
  findings.push(checkSeedSensitivity(seed));
  findings.push(checkCrossProcess({ ...ctx, seed, repeats }));
  // 目标清单契约：名字唯一、指纹是 16 hex。防止新增 target 时忘记返回值/拼错名字。
  const names = FINGERPRINT_TARGETS.map((entry) => entry.name);
  const uniqueNames = new Set(names).size === names.length;
  const digests = FINGERPRINT_TARGETS.map((entry) => evaluateTarget(entry, { seed, repeats }).fingerprint);
  const validDigests = digests.every((digest) => /^[0-9a-f]{16}$/.test(digest));
  if (!uniqueNames || !validDigests) {
    findings.push(fail(DETERMINISM_GATE_ID, gateId('target-digest-set'), '目标清单契约不成立（名字重复或指纹格式非法）', {
      code: 'QUALITY_DETERMINISM_MISMATCH',
      detail: '名字唯一=' + uniqueNames + '，指纹格式合法=' + validDigests,
      evidence: { names, digests },
    }));
  } else {
    findings.push(pass(DETERMINISM_GATE_ID, gateId('target-digest-set'), '目标清单契约成立（' + digests.length + ' 个唯一 target，指纹均 16 hex）', {
      targetSetDigest: multisetFingerprint(digests),
    }));
  }
  return findings;
}

export const GATE = {
  id: DETERMINISM_GATE_ID,
  title: '确定性（同输入 N 次指纹一致 + 跨进程 seed 稳定 + 探测器负控制）',
  consumes: [
    'lib/har-plan.mjs',
    'lib/har-replay.mjs',
    'lib/trace-budget.mjs',
    'lib/plan-steps.mjs',
    'lib/run-log.mjs',
    'lib/error-codes.mjs',
  ],
  run: runDeterminismChecks,
};

export default GATE;
