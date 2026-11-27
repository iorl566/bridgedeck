/**
 * tools/eval/corpus/protocol-state.mjs -- invariants for the protocol state
 * machine and the method proof/state-machine layer:
 *
 *   lib/protocol.mjs          version parse/compare/band/skew + handshake decision
 *   lib/protocol-features.mjs feature floors, preflight gate, negotiation verdict
 *   lib/method-catalog.mjs    single source of method proofs (pre/post/recovery)
 *   lib/method-state-machine.mjs tri-state pre/post checks, replay decision,
 *                                recovery plans, simulation
 *
 * The catalog is fixed (165 methods), so part of the corpus is exhaustive over
 * it; the generated part varies versions, parameter flags, contexts and RPC
 * result shapes. All assertions target documented state transitions (tri-state
 * honesty, replay safety, feature-floor monotonicity), not literal snapshots.
 */

import { defineProperty } from '../lib/property.mjs';
import {
  PROTOCOL_BANDS,
  compareProtocol,
  handshakeMatrix,
  isProtocolKnown,
  isSameProtocolMajor,
  negotiateHandshake,
  parseProtocol,
  protocolBand,
  protocolSkew,
} from '../../../lib/protocol.mjs';
import {
  FEATURE_MIN_PROTOCOL,
  FEATURE_NAMES_IN_ORDER,
  PROTOCOL_UNSUPPORTED,
  compatibilityReport,
  degradationForFeature,
  featureMatrix,
  featureShortfall,
  featuresForCall,
  methodFeature,
  negotiate,
  protocolGate,
  requiredFloorFor,
} from '../../../lib/protocol-features.mjs';
import {
  METHOD_NAMES,
  PROTOCOL_BASELINE,
  PROTOCOL_CURRENT,
  proofOf,
  validateMethodProofs,
} from '../../../lib/method-catalog.mjs';
import {
  CHECK_STATES,
  RECOVERY_SEVERITIES,
  SIMULATION_OUTCOMES,
  VERIFY_STATES,
  auditMethodStateMachine,
  checkPreconditions,
  describeEffectState,
  effectStateOf,
  isIdempotent,
  isReplayable,
  listMethodProofs,
  proofMatrix,
  recoveryPlan,
  replayDecision,
  simulateBatch,
  simulateCall,
  verifyPostcondition,
  verifyPostconditions,
} from '../../../lib/method-state-machine.mjs';
import { ALPHABETS, array, boolean, constant, integer, natural, oneOf, record, string } from '../lib/gen.mjs';
import { assert, assertDeepEqual, assertEqual, assertIn, assertJsonSafe } from '../lib/assert.mjs';

const PROTOCOL_PARSE = { file: 'lib/protocol.mjs', symbol: 'parseProtocol' };
const PROTOCOL_COMPARE = { file: 'lib/protocol.mjs', symbol: 'compareProtocol' };
const PROTOCOL_SKEW = { file: 'lib/protocol.mjs', symbol: 'protocolSkew' };
const PROTOCOL_HANDSHAKE = { file: 'lib/protocol.mjs', symbol: 'negotiateHandshake' };
const PROTOCOL_MATRIX = { file: 'lib/protocol.mjs', symbol: 'handshakeMatrix' };
const FEATURE_GATE = { file: 'lib/protocol-features.mjs', symbol: 'protocolGate' };
const FEATURE_NEGOTIATE = { file: 'lib/protocol-features.mjs', symbol: 'negotiate' };
const FEATURE_MATRIX = { file: 'lib/protocol-features.mjs', symbol: 'compatibilityReport' };
const FEATURE_CALL = { file: 'lib/protocol-features.mjs', symbol: 'featuresForCall' };
const CATALOG_PROOFS = { file: 'lib/method-catalog.mjs', symbol: 'validateMethodProofs' };
const STATE_PRE = { file: 'lib/method-state-machine.mjs', symbol: 'checkPreconditions' };
const STATE_POST = { file: 'lib/method-state-machine.mjs', symbol: 'verifyPostconditions' };
const STATE_REPLAY = { file: 'lib/method-state-machine.mjs', symbol: 'replayDecision' };
const STATE_RECOVERY = { file: 'lib/method-state-machine.mjs', symbol: 'recoveryPlan' };
const STATE_SIMULATE = { file: 'lib/method-state-machine.mjs', symbol: 'simulateCall' };
const STATE_AUDIT = { file: 'lib/method-state-machine.mjs', symbol: 'auditMethodStateMachine' };

const MATRIX_METHODS = [
  'observe', 'click', 'fill', 'navigate', 'session.start', 'status', 'tab.list', 'screenshot',
  'video.start', 'download', 'upload', 'dialog.accept', 'scroll', 'press', 'select', 'hover',
  'drag', 'transfer.begin', 'tab.close', 'window.new', 'network.start', 'trace.start',
].filter((method) => METHOD_NAMES.includes(method));
const methodGen = oneOf(MATRIX_METHODS.map((method) => constant(method)));
const versionGen = oneOf([
  constant(PROTOCOL_BASELINE), constant(PROTOCOL_CURRENT), constant('1.7'), constant('1.10'),
  constant('2.0'), constant('1.9.1'), constant('0.9'), constant('x'), constant(''), constant('1'),
]);

const FACT_KEYS = [
  'daemon', 'instanceConnected', 'browserReady', 'sessionActive', 'sessionUnpaused', 'tabBound',
  'controlHeld', 'observationFresh', 'recording', 'debuggerIdle', 'dialogPending', 'transferOpen',
  'networkCapturing', 'traceActive', 'planApproved', 'pairAvailable', 'artifactPresent',
  'cooperationAligned', 'uiAttached', 'transportLocal',
];
const factKeyGen = oneOf(FACT_KEYS.map((key) => constant(key)));
const contextGen = record({
  truthy: array(factKeyGen, { maxLength: 6 }),
  falsy: array(factKeyGen, { maxLength: 6 }),
  target: boolean(),
});

function buildContext(value) {
  const context = {};
  for (const key of value.truthy) context[key] = true;
  for (const key of value.falsy) context[key] = false;
  context.params = value.target ? { ref: '@e1' } : {};
  return context;
}

const paramsGen = record({
  unverified: boolean(),
  expect: array(string({ minLength: 1, maxLength: 3, alphabet: 'ab' }), { maxLength: 2 }),
  delta: boolean(),
  stream: boolean(),
  segmented: boolean(),
  staleAttempts: oneOf([constant(null), natural({ max: 5 })]),
});

function featureParams(value) {
  const params = {};
  if (value.unverified) params.unverified = true;
  if (value.expect.length) params.expect = value.expect;
  if (value.delta) params.delta = true;
  if (value.stream) params.stream = true;
  if (value.segmented) params.segmented = true;
  if (value.staleAttempts !== null) params.staleAttempts = value.staleAttempts;
  return params;
}

const resultGen = oneOf([
  constant(null),
  constant(true),
  constant(false),
  constant({}),
  integer({ min: -10, max: 10 }),
  string({ minLength: 0, maxLength: 4, alphabet: ALPHABETS.alnum }),
  array(integer({ min: 0, max: 3 }), { maxLength: 3 }),
  record({ ok: boolean(), tabId: oneOf([constant(null), integer({ min: 0, max: 9 })]), path: oneOf([constant(null), string({ maxLength: 4, alphabet: 'abc' })]) }),
  record({ sessionId: oneOf([constant(null), string({ maxLength: 3, alphabet: 'ab' })]), created: boolean() }),
]);

const ERROR_CODES = ['E_TIMEOUT', 'E_BAD_ARG', 'E_NOT_FOUND', 'E_FORBIDDEN', 'E_LEDGER_PENDING', 'E_LEDGER_CONFLICT', 'E_LEDGER_RESOLVE_REQUIRED', 'E_PROTOCOL_UNSUPPORTED', 'E_BOGUS_CODE'];
const errorCodeGen = oneOf(ERROR_CODES.map((code) => constant(code)));

function sign(value) {
  return value > 0 ? 1 : value < 0 ? -1 : 0;
}

export const area = {
  area: 'protocol-state',
  title: '协议状态：版本协商/特性闸门/方法证明/三态前置后置/重放与恢复',
  properties: [
    defineProperty({
      id: 'protocol-state/version-parse-compare',
      title: '版本解析/比较：可解析版本自比相等，比较反对称',
      area: 'protocol-state',
      gen: record({ a: versionGen, b: versionGen }),
      consumes: [PROTOCOL_PARSE, PROTOCOL_COMPARE],
      check: ({ a, b }) => {
        const parsed = parseProtocol(a);
        if (parsed !== null) {
          assert(Number.isInteger(parsed.major) && Number.isInteger(parsed.minor), '解析结果缺少 major/minor', { actual: parsed });
          assertEqual(isProtocolKnown(a), true, '可解析版本被判定为 unknown');
          assertEqual(compareProtocol(a, a), 0, '版本自比不为 0');
        } else {
          assertEqual(isProtocolKnown(a), false, '不可解析版本被判定为 known');
        }
        const order = compareProtocol(a, b);
        const reverse = compareProtocol(b, a);
        if (parsed === null || parseProtocol(b) === null) {
          assertEqual(order, null, '存在不可解析版本时比较结果不为 null');
          assertEqual(reverse, null, '存在不可解析版本时反向比较不为 null');
          return true;
        }
        if (sign(order) === 0) assertEqual(sign(reverse), 0, '等价版本反向比较不为 0');
        else assertEqual(sign(reverse), -sign(order), '版本比较不反对称');
        assertEqual(isSameProtocolMajor(a, b), parsed.major === parseProtocol(b).major, 'major 判定不符');
        assertEqual(sign(compareProtocol(PROTOCOL_CURRENT, PROTOCOL_CURRENT)), 0, '当前版本自比不为 0');
        return true;
      },
    }),
    defineProperty({
      id: 'protocol-state/band-and-skew',
      title: 'band/skew：已知版本有稳定分带与方向，未知版本诚实标 unknown',
      area: 'protocol-state',
      gen: versionGen,
      consumes: [PROTOCOL_SKEW, { file: 'lib/protocol.mjs', symbol: 'protocolBand' }],
      check: (version) => {
        const band = protocolBand(version);
        assertIn(PROTOCOL_BANDS, band, 'band 不在枚举内');
        const skew = protocolSkew(version, PROTOCOL_CURRENT);
        assertIn(['none', 'info', 'warn', 'fatal'], skew.severity, 'skew.severity 非法');
        if (!skew.known) {
          assertEqual(skew.order, null, '未知版本 order 不为 null');
          assertEqual(skew.band, 'unknown', '未知版本 band 不是 unknown');
          return true;
        }
        const order = compareProtocol(version, PROTOCOL_CURRENT);
        assertEqual(skew.order, order, 'skew.order 与 compareProtocol 不一致');
        assertEqual(skew.band, protocolBand(version), 'skew.band 与 protocolBand 不一致');
        if (order === 0) {
          assertIn(['same', 'equal'], skew.relation, '同版本 relation 不是 same/equal');
          assertEqual(skew.severity, 'none', '同版本 severity 不是 none');
        } else if (!isSameProtocolMajor(version, PROTOCOL_CURRENT)) {
          assertEqual(skew.relation, 'major-skew', 'major 不同时 relation 不是 major-skew');
        } else {
          assertIn(['actual-older', 'actual-newer'], skew.relation, 'relation 非法');
          assertEqual(skew.relation, order < 0 ? 'actual-older' : 'actual-newer', 'relation 方向不符');
        }
        return true;
      },
    }),
    defineProperty({
      id: 'protocol-state/handshake-decision-table',
      title: '握手决策表：未知/major 不同 reject，过旧 reject-with-upgrade，其余 accept',
      area: 'protocol-state',
      gen: versionGen,
      consumes: [PROTOCOL_HANDSHAKE],
      check: (version) => {
        const first = negotiateHandshake(version);
        const second = negotiateHandshake(version);
        assertDeepEqual(first, second, '握手结果不确定');
        assertIn(['accept', 'reject', 'reject-with-upgrade'], first.decision, '握手决策非法');
        assertIn(['none', 'info', 'warn', 'fatal'], first.severity, '握手 severity 非法');
        assert(Array.isArray(first.steps) && first.steps.length > 0, '握手缺少升级步骤');
        const known = isProtocolKnown(version);
        const samesMajor = known && isSameProtocolMajor(version, PROTOCOL_CURRENT);
        if (!known || !samesMajor) {
          assertEqual(first.decision, 'reject', '未知/major 不同没有 reject');
          assertEqual(first.severity, 'fatal', 'reject 的 severity 不是 fatal');
          return true;
        }
        const baselineOrder = compareProtocol(version, PROTOCOL_BASELINE);
        if (baselineOrder !== null && baselineOrder < 0) {
          assertEqual(first.decision, 'reject-with-upgrade', '低于基线没有 reject-with-upgrade');
          return true;
        }
        assertEqual(first.decision, 'accept', '合法偏斜没有 accept');
        assert(first.severity === 'none' || first.severity === 'warn' || first.severity === 'info', 'accept 的 severity 非法');
        return true;
      },
    }),
    defineProperty({
      id: 'protocol-state/handshake-matrix',
      title: '握手矩阵行/计数与逐版本握手一致',
      area: 'protocol-state',
      gen: array(versionGen, { minLength: 1, maxLength: 5 }),
      consumes: [PROTOCOL_MATRIX],
      check: (versions) => {
        const matrix = handshakeMatrix(versions);
        assertEqual(matrix.rows.length, versions.length, '矩阵行数与版本数不符');
        assertEqual(matrix.daemon, PROTOCOL_CURRENT, '矩阵 daemon 版本不符');
        for (let index = 0; index < versions.length; index += 1) {
          assertDeepEqual(matrix.rows[index], negotiateHandshake(versions[index]), '矩阵行与单独握手不一致');
        }
        const countSum = Object.values(matrix.counts).reduce((sum, value) => sum + value, 0);
        assertEqual(countSum, versions.length, '矩阵 counts 总和与行数不符');
        for (const decision of Object.keys(matrix.counts)) {
          assertIn(['accept', 'reject', 'reject-with-upgrade'], decision, 'counts 出现未知决策');
        }
        return true;
      },
    }),
    defineProperty({
      id: 'protocol-state/features-for-call',
      title: '特性推导：结果唯一、有序、每个特性都有注册的最低版本',
      area: 'protocol-state',
      gen: record({ version: versionGen, method: methodGen, params: paramsGen }),
      consumes: [FEATURE_CALL],
      check: ({ version, method, params }) => {
        const features = featuresForCall(method, featureParams(params));
        assertEqual(new Set(features).size, features.length, '特性列表出现重复');
        for (const feature of features) {
          const floor = FEATURE_MIN_PROTOCOL[feature];
          assert(typeof floor === 'string' && /^\d+\.\d+$/.test(floor), '特性缺少合法最低版本：' + feature);
        }
        const gated = methodFeature(method);
        if (gated) assertIn(features, gated, '方法级特性缺失');
        assert(Array.isArray(featureShortfall({ protocol: version }, features)), 'featureShortfall 没有返回数组');
        if (features.length === 0) assertEqual(requiredFloorFor(features), null, '空特性集应返回 null floor');
        else assert(typeof requiredFloorFor(features) === 'string', '最低版本不是字符串');
        return true;
      },
    }),
    defineProperty({
      id: 'protocol-state/current-gate-open',
      title: '当前协议下所有方法的特性闸门通过',
      area: 'protocol-state',
      gen: record({ method: methodGen, params: paramsGen }),
      consumes: [FEATURE_GATE],
      check: ({ method, params }) => {
        const gate = protocolGate({ protocol: PROTOCOL_CURRENT }, method, featureParams(params));
        assertEqual(gate.ok, true, '当前协议下特性闸门拒绝了方法', { actual: { method, missing: gate.missing } });
        assertDeepEqual(gate.missing, [], '通过时 missing 不为空');
        assertEqual(gate.code, null, '通过时仍带错误码');
        assertEqual(gate.severity, 'none', '通过时 severity 不是 none');
        return true;
      },
    }),
    defineProperty({
      id: 'protocol-state/old-gate-evidence',
      title: '旧协议闸门拒绝时带 E_PROTOCOL_UNSUPPORTED + 缺口证据',
      area: 'protocol-state',
      gen: record({ method: methodGen, params: paramsGen }),
      consumes: [FEATURE_GATE],
      check: ({ method, params }) => {
        const bag = featureParams(params);
        const gate = protocolGate({ protocol: PROTOCOL_BASELINE }, method, bag);
        const features = featuresForCall(method, bag);
        const missing = featureShortfall({ protocol: PROTOCOL_BASELINE }, features);
        assertEqual(gate.ok, missing.length === 0, '旧协议闸门结论与缺口不一致');
        if (gate.ok) {
          assertDeepEqual(gate.missing, [], '通过时仍有缺口');
          return true;
        }
        assertEqual(gate.code, PROTOCOL_UNSUPPORTED, '拒绝错误码不是 E_PROTOCOL_UNSUPPORTED');
        assert(gate.missing.length > 0, '拒绝时没有缺口证据');
        for (const item of gate.missing) {
          assertIn(FEATURE_NAMES_IN_ORDER, item.feature, '缺口特性未注册');
          const order = compareProtocol(PROTOCOL_BASELINE, item.required);
          assert(order !== null && order < 0, '缺口特性的 required 不高于对端版本');
        }
        assert(gate.data && gate.data.actual === PROTOCOL_BASELINE, '拒绝 evidence.actual 不符');
        assert(gate.message.length > 0, '拒绝缺少 message');
        return true;
      },
    }),
    defineProperty({
      id: 'protocol-state/compatibility-report',
      title: '兼容性报告：特性计数、降级计数与 verdict 自洽',
      area: 'protocol-state',
      gen: versionGen,
      consumes: [FEATURE_MATRIX, { file: 'lib/protocol-features.mjs', symbol: 'featureMatrix' }],
      check: (version) => {
        const report = compatibilityReport({ protocol: version });
        const keys = Object.keys(report.features);
        assertEqual(report.counts.total, keys.length, 'counts.total 与特性数不符');
        assertEqual(report.counts.available + report.counts.denied, report.counts.total, 'available+denied 不等于 total');
        assert(report.counts.degradable <= report.counts.denied, 'degradable 超过 denied');
        assertDeepEqual(report.available, keys.filter((key) => report.features[key].available), 'available 列表与矩阵不一致');
        assertEqual(report.verdict, report.counts.denied === 0 ? 'compatible' : report.counts.degradable === report.counts.denied ? 'degraded' : 'incompatible', 'verdict 推导不符');
        const matrix = featureMatrix({ protocol: version });
        for (const key of keys) {
          const entry = matrix[key];
          assertEqual(entry.available, report.features[key].available, '矩阵与报告可用性不一致');
          if (entry.available) {
            const order = compareProtocol(version, entry.required);
            assert(order !== null && order >= 0, '可用特性的对端版本低于 required');
          }
        }
        assertJsonSafe(report, '兼容性报告不是 JSON 安全值');
        return true;
      },
    }),
    defineProperty({
      id: 'protocol-state/negotiate-verdict',
      title: '协商 verdict：ok ⇔ compatible，缺特性时 degraded/incompatible 与降级能力一致',
      area: 'protocol-state',
      gen: record({ version: versionGen, calls: array(record({ method: methodGen, params: paramsGen }), { maxLength: 2 }) }),
      consumes: [FEATURE_NEGOTIATE],
      check: ({ version, calls }) => {
        const request = { calls: calls.map((call) => ({ method: call.method, params: featureParams(call.params) })) };
        const first = negotiate({ protocol: version }, request);
        const second = negotiate({ protocol: version }, request);
        assertDeepEqual(first, second, '协商结果不确定');
        assertIn(['compatible', 'degraded', 'incompatible'], first.verdict, '协商 verdict 非法');
        assertEqual(first.ok, first.verdict === 'compatible', 'ok 与 verdict=compatible 不一致');
        assertEqual(first.calls.length, calls.length, 'calls 数量不符');
        for (let index = 0; index < calls.length; index += 1) {
          assertEqual(first.calls[index].method, calls[index].method, 'call 方法名不符');
          const gate = protocolGate({ protocol: version }, calls[index].method, featureParams(calls[index].params));
          assertEqual(first.calls[index].ok, gate.ok, 'call ok 与单次闸门不一致');
        }
        if (first.verdict === 'degraded') {
          assert(first.degradations.length > 0, 'degraded 缺少降级证据');
        }
        assertJsonSafe(first, '协商结果不是 JSON 安全值');
        return true;
      },
    }),
    defineProperty({
      id: 'protocol-state/degradation-metadata',
      title: '每个已注册特性都有 floor/降级元数据，degradable 与 fallback.kind 一致',
      area: 'protocol-state',
      gen: oneOf(FEATURE_NAMES_IN_ORDER.map((feature) => constant(feature))),
      consumes: [{ file: 'lib/protocol-features.mjs', symbol: 'degradationForFeature' }],
      check: (feature) => {
        const degradation = degradationForFeature(feature);
        assertEqual(degradation.feature, feature, '特性名不符');
        assert(typeof degradation.floor === 'string', '缺少 floor');
        assert(typeof degradation.kind === 'string' && degradation.kind.length > 0, 'fallback.kind 为空');
        assertEqual(degradation.degradable, degradation.kind !== 'none', 'degradable 与 kind 不一致');
        assert(typeof degradation.label === 'string' && degradation.label.length > 0, '缺少人类可读 label');
        return true;
      },
    }),
    defineProperty({
      id: 'protocol-state/method-proof-catalog',
      title: '方法证明目录：165 条全部通过校验、审计无 issue、六个维度齐全',
      area: 'protocol-state',
      gen: constant('catalog'),
      consumes: [CATALOG_PROOFS, STATE_AUDIT, { file: 'lib/method-state-machine.mjs', symbol: 'listMethodProofs' }],
      check: () => {
        const issues = validateMethodProofs();
        assert(Array.isArray(issues), 'validateMethodProofs 没有返回 issue 数组');
        assertEqual(issues.length, 0, '方法证明校验出现 issue', { actual: issues.slice(0, 3) });
        const audit = auditMethodStateMachine();
        assert(Array.isArray(audit), '审计没有返回 issue 数组');
        assertEqual(audit.length, 0, '状态机审计出现 issue', { actual: audit.slice(0, 3) });
        const proofs = listMethodProofs();
        assertEqual(proofs.length, METHOD_NAMES.length, '证明条目数与方法数不符');
        for (const proof of proofs) {
          assert(METHOD_NAMES.includes(proof.method), '证明条目含未知方法：' + proof.method);
          assert(Array.isArray(proof.pre) && Array.isArray(proof.post), '证明缺少 pre/post');
          assertEqual(typeof proof.idempotent, 'boolean', '证明 idempotent 非布尔');
          assertEqual(typeof proof.replayable, 'boolean', '证明 replayable 非布尔');
          assert(proofOf(proof.method), 'proofOf 查不到方法：' + proof.method);
        }
        const matrix = proofMatrix(MATRIX_METHODS);
        assertEqual(matrix.length, MATRIX_METHODS.length, 'proofMatrix 行数不符');
        assert(matrix.every((row) => row.known === true), 'proofMatrix 含未知方法');
        return true;
      },
    }),
    defineProperty({
      id: 'protocol-state/preconditions-tristate',
      title: '前置三态：checks 顺序/状态合法，ok/proven 与 violations/unknowns 自洽',
      area: 'protocol-state',
      gen: record({ method: methodGen, context: contextGen }),
      consumes: [STATE_PRE],
      check: ({ method, context }) => {
        const ctx = buildContext(context);
        const first = checkPreconditions(method, ctx);
        const second = checkPreconditions(method, ctx);
        assertDeepEqual(first, second, '前置判定不确定');
        assertEqual(first.known, true, '已知方法被判定为 unknown');
        assertEqual(first.ok, first.violations.length === 0, 'ok 与 violations 不一致');
        assertEqual(first.proven, first.ok && first.unknowns.length === 0, 'proven 与 unknown 不一致');
        assertDeepEqual(first.checks.map((check) => check.code), first.pre, 'checks 顺序与 pre 不一致');
        for (const check of first.checks) assertIn(CHECK_STATES, check.state, '前置状态非法');
        assertDeepEqual(first.violations, first.checks.filter((check) => check.state === 'violated').map((check) => check.code), 'violations 集合不符');
        assertDeepEqual(first.unknowns, first.checks.filter((check) => check.state === 'unknown').map((check) => check.code), 'unknowns 集合不符');
        return true;
      },
    }),
    defineProperty({
      id: 'protocol-state/preconditions-all-facts',
      title: '全知上下文可证明全部前置；全反证上下文至少产生 violation',
      area: 'protocol-state',
      gen: constant('all-facts'),
      consumes: [STATE_PRE],
      check: () => {
        const truthy = Object.fromEntries(FACT_KEYS.map((key) => [key, true]));
        truthy.params = { ref: '@e1' };
        const falsy = Object.fromEntries(FACT_KEYS.map((key) => [key, false]));
        falsy.params = {};
        for (const method of METHOD_NAMES) {
          const proven = checkPreconditions(method, truthy);
          assertEqual(proven.violations.length, 0, '全知上下文仍出现 violation：' + method, { actual: proven.violations });
          assertEqual(proven.proven, true, '全知上下文无法证明前置：' + method, { actual: proven.unknowns });
          const refuted = checkPreconditions(method, falsy);
          if (refuted.pre.length > 0) {
            assertEqual(refuted.ok, false, '全反证上下文没有 violation：' + method);
            assert(refuted.violations.length >= 1, '全反证上下文 violations 为空：' + method);
          }
          assertEqual(refuted.checks.length, refuted.pre.length, 'checks 数与 pre 数不符：' + method);
        }
        return true;
      },
    }),
    defineProperty({
      id: 'protocol-state/postconditions-tristate',
      title: '后置三态：任意 RPC 结果都不崩溃，状态合法且 proven 诚实',
      area: 'protocol-state',
      gen: record({ method: methodGen, result: resultGen }),
      consumes: [STATE_POST, { file: 'lib/method-state-machine.mjs', symbol: 'verifyPostcondition' }],
      check: ({ method, result }) => {
        const first = verifyPostconditions(method, result);
        const second = verifyPostconditions(method, result);
        assertDeepEqual(first, second, '后置核验不确定');
        assertEqual(first.known, true, '已知方法被判定为 unknown');
        assertEqual(first.ok, first.violated.length === 0, 'ok 与 violated 不一致');
        assertEqual(first.proven, first.ok && first.unverifiable.length === 0, 'proven 与 unverifiable 不一致');
        assertDeepEqual(first.checks.map((check) => check.code), first.post, 'checks 顺序与 post 不一致');
        for (const check of first.checks) {
          assertIn(VERIFY_STATES, check.state, '后置状态非法');
          const single = verifyPostcondition(check.code, result);
          assertEqual(single.state, check.state, '单项核验与整体核验不一致');
        }
        return true;
      },
    }),
    defineProperty({
      id: 'protocol-state/replay-decision-table',
      title: '重放决策：可重放/可证明未生效才允许，否则必须 resolve',
      area: 'protocol-state',
      gen: record({
        method: methodGen,
        effectState: oneOf([constant(null), constant('none'), constant('unknown'), constant('applied')]),
        dispatched: oneOf([constant(null), constant(true), constant(false)]),
        code: oneOf([constant(null), constant('E_TIMEOUT'), constant('E_BAD_ARG')]),
      }),
      consumes: [STATE_REPLAY],
      check: ({ method, effectState, dispatched, code }) => {
        const options = {};
        if (effectState !== null) options.effectState = effectState;
        if (dispatched !== null) options.dispatched = dispatched;
        if (code !== null) options.code = code;
        const first = replayDecision(method, options);
        const second = replayDecision(method, options);
        assertDeepEqual(first, second, '重放决策不确定');
        assertEqual(first.known, true, '已知方法被判定为 unknown');
        const replayable = isReplayable(method);
        const codeProvesNoEffect = Boolean(code) && !['E_TIMEOUT'].includes(code);
        const notApplied = effectState === 'none' || dispatched === false || codeProvesNoEffect;
        if (replayable) {
          assertEqual(first.allowed, true, '可重放方法被拒绝');
          assertEqual(first.requiresResolve, false, '可重放方法仍要求 resolve');
        } else if (notApplied) {
          assertEqual(first.allowed, true, '已证明未生效却拒绝重放');
          assertEqual(first.requiresResolve, false, '已证明未生效仍要求 resolve');
        } else {
          assertEqual(first.allowed, false, '不可证明时允许了自动重放');
          assertEqual(first.requiresResolve, true, '不可证明时不要求 resolve');
          assertEqual(first.action, 'resolve-ledger', '不可证明时 action 不是 resolve-ledger');
        }
        assertEqual(first.idempotent, isIdempotent(method), 'idempotent 字段与目录不一致');
        return true;
      },
    }),
    defineProperty({
      id: 'protocol-state/simulate-transitions',
      title: 'simulateCall 状态转移：阻塞/成功/失败/派发各自的证据约束',
      area: 'protocol-state',
      gen: record({ method: methodGen, scenario: oneOf([constant('dispatch'), constant('success'), constant('failure'), constant('blocked')]) }),
      consumes: [STATE_SIMULATE],
      check: ({ method, scenario }) => {
        const input = scenario === 'blocked' ? { context: { sessionActive: false, tabBound: false } }
          : scenario === 'success' ? { result: { ok: true } }
            : scenario === 'failure' ? { error: { code: 'E_TIMEOUT' } }
              : {};
        const result = simulateCall(method, input);
        assertEqual(result.known, true, '已知方法被判定为 unknown');
        assertIn(SIMULATION_OUTCOMES, result.outcome, '模拟 outcome 非法');
        assert(Array.isArray(result.phases) && result.phases.length > 0, '模拟缺少 phases');
        assertEqual(result.phases[0].phase, 'preflight', '首个 phase 不是 preflight');
        assertEqual(result.effectState, effectStateOf(method), 'effectState 与目录不一致');
        if (result.pre && result.pre.ok === false) {
          assertEqual(result.outcome, 'blocked-precondition', '前置失败没有 blocked');
          assertEqual(result.post, null, '阻塞时 post 不为 null');
          assertEqual(result.replay, null, '阻塞时 replay 不为 null');
        } else if (scenario === 'success') {
          assert(result.post, '成功场景缺少 post');
          assertIn(['succeeded-verified', 'succeeded-unverified', 'succeeded-contradiction'], result.outcome, '成功场景 outcome 不符');
        } else if (scenario === 'failure') {
          assert(result.recovery, '失败场景缺少 recovery');
          assert(result.replay, '失败场景缺少 replay');
          assertIn(['failed-known', 'failed-unknown'], result.outcome, '失败场景 outcome 不符');
        } else {
          assertEqual(result.outcome, 'dispatched-pending', '派发场景 outcome 不符');
          assertEqual(result.post, null, '派发场景 post 不为 null');
        }
        return true;
      },
    }),
    defineProperty({
      id: 'protocol-state/recovery-plan-shape',
      title: '恢复计划：未知码诚实 unknown；账本类错误必须 resolve 且禁止自动重试',
      area: 'protocol-state',
      gen: record({ method: methodGen, code: errorCodeGen }),
      consumes: [STATE_RECOVERY],
      check: ({ method, code }) => {
        const plan = recoveryPlan(method, code);
        assertEqual(plan.method, method, '计划方法名不符');
        assertEqual(plan.code, code, '计划错误码不符');
        if (!plan.known) {
          assertEqual(plan.action, null, '未知码却有 action');
          assertEqual(plan.severity, null, '未知码却有 severity');
          assertDeepEqual(plan.steps, [], '未知码却有 steps');
          return true;
        }
        assertIn(RECOVERY_SEVERITIES, plan.severity, '恢复计划 severity 非法');
        assert(Array.isArray(plan.steps) && plan.steps.length > 0, '恢复计划缺少步骤');
        assert(typeof plan.retryAllowed === 'boolean', 'retryAllowed 不是布尔');
        assert(Number.isInteger(plan.maxAttempts) && plan.maxAttempts >= 0, 'maxAttempts 非整数');
        if (['E_LEDGER_PENDING', 'E_LEDGER_CONFLICT', 'E_LEDGER_RESOLVE_REQUIRED'].includes(code)) {
          assertEqual(plan.requiresResolve, true, '账本类错误不要求 resolve');
          assertEqual(plan.retryAllowed, false, '账本类错误允许自动重试');
        }
        if (plan.retryAllowed) assertEqual(plan.retryable, true, '允许重试但 retryable=false');
        assertJsonSafe(plan, '恢复计划不是 JSON 安全值');
        return true;
      },
    }),
    defineProperty({
      id: 'protocol-state/simulate-batch',
      title: 'simulateBatch：逐调用独立、计数分组完整',
      area: 'protocol-state',
      gen: array(record({ method: methodGen, scenario: oneOf([constant('dispatch'), constant('success'), constant('failure')]) }), { maxLength: 4 }),
      consumes: [{ file: 'lib/method-state-machine.mjs', symbol: 'simulateBatch' }, STATE_SIMULATE],
      check: (calls) => {
        const input = calls.map((call) => ({
          method: call.method,
          input: call.scenario === 'success' ? { result: { ok: true } } : call.scenario === 'failure' ? { error: { code: 'E_TIMEOUT' } } : {},
        }));
        const batch = simulateBatch(input);
        assertEqual(batch.total, calls.length, '批总数不符');
        assertEqual(batch.results.length, calls.length, '批结果数不符');
        const sum = Object.values(batch.counts).reduce((total, value) => total + value, 0);
        assertEqual(sum, calls.length, 'counts 总和与调用数不符');
        for (const outcome of SIMULATION_OUTCOMES) {
          assertEqual(typeof batch.counts[outcome], 'number', '计数缺少 outcome：' + outcome);
          const actual = batch.results.filter((result) => result.outcome === outcome).length;
          assertEqual(batch.counts[outcome], actual, 'outcome 计数不符：' + outcome);
        }
        return true;
      },
    }),
    defineProperty({
      id: 'protocol-state/catalog-cross-classification',
      title: '目录交叉：effect_state 可解释、幂等/可重放为布尔且与重放决策一致',
      area: 'protocol-state',
      gen: constant('cross'),
      consumes: [
        { file: 'lib/method-state-machine.mjs', symbol: 'isIdempotent' },
        { file: 'lib/method-state-machine.mjs', symbol: 'isReplayable' },
        STATE_REPLAY,
      ],
      check: () => {
        let replayableCount = 0;
        let idempotentCount = 0;
        for (const method of METHOD_NAMES) {
          const effectState = effectStateOf(method);
          assert(typeof effectState === 'string', '方法缺少 effect_state：' + method);
          assertEqual(describeEffectState(effectState).known, true, 'effect_state 未登记：' + effectState);
          assertEqual(isIdempotent(method), isIdempotent(method) === true, 'isIdempotent 非布尔');
          assertEqual(isReplayable(method), isReplayable(method) === true, 'isReplayable 非布尔');
          if (isIdempotent(method)) idempotentCount += 1;
          if (isReplayable(method)) {
            replayableCount += 1;
            const decision = replayDecision(method, { effectState: 'unknown', dispatched: true });
            assertEqual(decision.allowed, true, '可重放方法在 UNKNOWN 下被拒绝');
            assertEqual(decision.requiresResolve, false, '可重放方法要求 resolve');
          } else {
            const decision = replayDecision(method, { effectState: 'applied', dispatched: true });
            assertEqual(decision.allowed, false, '不可重放方法在已生效后被允许重放');
            assertEqual(decision.requiresResolve, true, '不可重放方法未要求 resolve');
          }
        }
        assert(idempotentCount > 0 && replayableCount > 0, '目录统计异常');
        assert(replayableCount <= METHOD_NAMES.length, '可重放方法数超过目录');
        return true;
      },
    }),
  ],
};

export default area;
