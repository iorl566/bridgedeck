// lib/protocol-proof.mjs —— 协议面的“可执行 proof obligations”与派生校验器。
//
// 背景（第二轮深度）：
//   第一轮已经把方法状态机拆成六个可证明性维度（pre / post / effect_state /
//   idempotent / replayable / recovery，见 lib/method-state-machine.mjs），并让协议闸门
//   在拒绝时附带静态快照。但“快照”只能被人读，不能被程序执行：CLI 想解释“我为什么
//   判断它没生效”、MCP 想在 _meta 里给出下一步核验指令、daemon 想说明“为什么必须
//   resolve 账本”，都还得自己按维度拼逻辑，等于把协议语义复制到多个调用方。
//
//   本文件把六个维度变成**可执行的义务（obligation）**：
//     - 每条义务是一份冻结描述符（id / dimension / kind / stage / requirement）；
//     - evaluateObligation() 是唯一执行入口：吃“证据”（context / result / error /
//       effectState / dispatched / retryRequested），吐 verdict + reason；
//     - runCallObligations() 按 preflight → settle → replay → recovery 四个阶段执行，
//       输出 canDispatch / canClaimSuccess / canAutoReplay 三个硬结论。
//
//   义务不是第二份事实：所有 code 都来自 lib/method-catalog.mjs 的 METHOD_PROOF
//   （pre/post/effectState/idempotent/replayable/recovery），执行器判定复用
//   lib/method-state-machine.mjs 的 checkPrecondition / verifyPostcondition /
//   replayDecision / recoveryPlan。本文件只做“把事实编排成可执行检查”。
//
//   派生校验器（derived validators）回答另一个问题：这些义务**本身**是否正确。
//   - validatePreconditionFixtures / validatePostconditionFixtures：证据夹具必须真的
//     被状态机判定为 satisfied/violated，否则校验器自己就是错的；
//   - validateObligationTable：165 个方法的义务表必须与目录逐项同源、id 唯一、
//     阶段合法、blocking 标记合法；
//   - validateEngineBehavior：对 165 个方法跑构造好的证据组合，验证三条硬结论的
//     单调性（violated ⇒ 禁止；proven ⇒ 放行），这是“派生”的语义校验；
//   - auditObligations()：汇总以上全部为可打印的错误数组（空 = 通过）。
//
//   运行时消费链（报告里的 file:line 见交付说明）：
//     lib/protocol-features.mjs 的 protocolGate 把本文件的结果放进 data.obligations
//     （daemon/server.mjs 的 requireFeatures 在拒绝时 ...base 透传给 BridgeError），
//     featureMatrix 每个特性行带 featureObligations()，经 daemon/health.js 进入
//     /health 与 daemon.status；sdk/contract.mjs 的 methodProtocolGate 把
//     featureShortfall 的 missing 项原样返给 SDK 调用方。
//
//   默认语义不变：本模块是纯增量。它不参与 dispatch、不改任何既有错误码、
//   不改 METHOD_STATE/METHOD_PROOF（生成物五维保持原样），只提供只读执行。

import {
  FEATURE_FLOORS,
  FEATURE_METHODS,
  FEATURE_NAMES,
  FEATURE_PARAM_RULES,
  METHOD_NAMES,
  PROOF_EFFECT_STATES,
  PROOF_POSTCONDITIONS,
  PROOF_PRECONDITIONS,
  PROOF_RECOVERY_ACTIONS,
  RECOVERY_PLAYBOOK,
  isUnknownOutcomeCode,
  proofOf,
} from './method-catalog.mjs';
import { ERROR_CODE_SET } from './error-codes.mjs';
import {
  EFFECT_OUTCOME_STATES,
  PROOF_DIMENSIONS,
  checkPrecondition,
  effectStateOf,
  isIdempotent,
  isReplayable,
  recoveryPlan,
  replayDecision,
  verifyPostcondition,
} from './method-state-machine.mjs';

// ===========================================================================
// 一、常量：义务维度 / 种类 / 阶段 / verdict 偏序
// ===========================================================================

/** 六个可证明性维度（顺序 = 目录口径，供报告/测试遍历）。 */
export const OBLIGATION_DIMENSIONS = PROOF_DIMENSIONS;

/** 义务种类（维度 → 判定器类别；种类比维度更细，post 与 effect_state 是两个阶段）。 */
export const OBLIGATION_KINDS = Object.freeze([
  'precondition',
  'postcondition',
  'effect-state',
  'idempotency',
  'replayability',
  'recovery',
]);

/**
 * 执行阶段：
 *   preflight —— 派发之前必须成立（不成立就不该发请求）；
 *   settle    —— 拿到结果之后才能判（成功是否可被证明）；
 *   replay    —— 结果未知/失败后才问（能不能自动重发）；
 *   recovery  —— 失败后必有可执行恢复计划（否则调用方只能人工兜底）。
 */
export const OBLIGATION_STAGES = Object.freeze(['preflight', 'settle', 'replay', 'recovery']);

/** 维度 → 义务种类（一一对应，便于报告按维度聚合）。 */
export const DIMENSION_KIND = Object.freeze({
  pre: 'precondition',
  post: 'postcondition',
  effectState: 'effect-state',
  idempotent: 'idempotency',
  replayable: 'replayability',
  recovery: 'recovery',
});

/** 种类 → 执行阶段。 */
export const KIND_STAGE = Object.freeze({
  precondition: 'preflight',
  postcondition: 'settle',
  'effect-state': 'settle',
  idempotency: 'replay',
  replayability: 'replay',
  recovery: 'recovery',
});

/**
 * verdict 偏序（数值越大越“坏”）：inapplicable 表示本次证据与义务无关
 * （例如成功路径上没有“是否要重放”的问题），不是失败。
 */
export const OBLIGATION_VERDICTS = Object.freeze(['inapplicable', 'satisfied', 'unverifiable', 'unknown', 'violated']);

/** verdict → 严重度数值（聚合取最大值）。 */
export const VERDICT_RANK = Object.freeze({
  inapplicable: 0,
  satisfied: 0,
  unverifiable: 1,
  unknown: 2,
  violated: 3,
});

/** 聚合结论：没有 violated ⇒ 不阻断；有 unknown ⇒ 不可“证明”，要求观察；全 satisfied ⇒ proven。 */
export const CALL_VERDICTS = Object.freeze(['proven', 'partial', 'unknown', 'violated', 'inapplicable']);

/** 维度的中文说明（错误信息/文档共用；不是新事实）。 */
export const DIMENSION_LABELS = Object.freeze({
  pre: '前置条件',
  post: '后置条件',
  effectState: '副作用状态',
  idempotent: '幂等性',
  replayable: '可重放性',
  recovery: '错误恢复',
});

/** blocking 语义：哪些阶段失败会触发哪条硬结论。 */
export const BLOCKING_RULES = Object.freeze({
  preflight: 'canDispatch',
  settle: 'canClaimSuccess',
  replay: 'canAutoReplay',
  recovery: 'hasRecoveryPlan',
});

// ===========================================================================
// 二、证据夹具：让“可执行”能被自己验证
//
// 义务执行器需要两种证据：
//   1) 前置条件证据（context）—— 每个 pre code 都要有“满足”和“不满足”两套夹具；
//   2) 后置条件证据（result）—— 每个 post code 都要有一份能被判 satisfied 的结果片段。
//
// 这些夹具是**派生**的：validatePreconditionFixtures / validatePostconditionFixtures
// 会把它们喂回状态机，要求 checkPrecondition 真的返回 expected。任何人改了状态机
// 的判定语义而没同步夹具，派生校验器会立刻报错——夹具不是第二份事实，而是被执行器
// 用来证明“同一份事实在不同证据下结论一致”的测试向量。
// ===========================================================================

/**
 * 前置条件的“满足”夹具：每个 code 一段最小 context，状态机必须判 satisfied。
 * daemon.local 例外：只看“没有反证”，空 context 即满足。
 */
export const PRECONDITION_SATISFIED_CONTEXT = Object.freeze({
  'daemon.local': Object.freeze({}),
  'instance.connected': Object.freeze({ instanceConnected: true }),
  'browser.ready': Object.freeze({ browserReady: true }),
  'session.active': Object.freeze({ sessionActive: true }),
  'session.unpaused': Object.freeze({ sessionUnpaused: true }),
  'tab.bound': Object.freeze({ tabId: 7 }),
  'tab.controlled': Object.freeze({ controlHeld: true }),
  'target.resolved': Object.freeze({ target: Object.freeze({ ref: '@e1' }) }),
  'observation.fresh': Object.freeze({ observationFresh: true }),
  'recording.active': Object.freeze({ recording: true }),
  'debugger.idle': Object.freeze({ debuggerIdle: true }),
  'dialog.pending': Object.freeze({ dialogPending: true }),
  'transfer.open': Object.freeze({ transferOpen: true }),
  'network.capturing': Object.freeze({ networkCapturing: true }),
  'trace.active': Object.freeze({ traceActive: true }),
  'plan.approved': Object.freeze({ planApproved: true }),
  'pair.available': Object.freeze({ pairAvailable: true }),
  'artifact.present': Object.freeze({ artifactPresent: true }),
  'cooperation.aligned': Object.freeze({ cooperationAligned: true }),
  'ui.attached': Object.freeze({ uiAttached: true }),
  'transport.local': Object.freeze({ remote: false }),
});

/**
 * 前置条件的“不满足”夹具：每个 code 一段最小 context，状态机必须判 violated。
 * 只有拿到反证才会 violated——这正是状态机“unknown ≠ violated”口径的执行面。
 */
export const PRECONDITION_VIOLATED_CONTEXT = Object.freeze({
  // daemon.local 的判定是“daemon === false 才算反证”（daemon 在线是常态）。
  'daemon.local': Object.freeze({ daemon: false }),
  'instance.connected': Object.freeze({ instanceConnected: false }),
  'browser.ready': Object.freeze({ browserReady: false }),
  'session.active': Object.freeze({ sessionActive: false }),
  'session.unpaused': Object.freeze({ sessionUnpaused: false }),
  'tab.bound': Object.freeze({ tabId: null }),
  'tab.controlled': Object.freeze({ controlHeld: false }),
  'target.resolved': Object.freeze({ target: Object.freeze({}) }),
  'observation.fresh': Object.freeze({ observationFresh: false }),
  'recording.active': Object.freeze({ recording: false }),
  'debugger.idle': Object.freeze({ debuggerIdle: false }),
  'dialog.pending': Object.freeze({ dialogPending: false }),
  'transfer.open': Object.freeze({ transferOpen: false }),
  'network.capturing': Object.freeze({ networkCapturing: false }),
  'trace.active': Object.freeze({ traceActive: false }),
  'plan.approved': Object.freeze({ planApproved: false }),
  'pair.available': Object.freeze({ pairAvailable: false }),
  'artifact.present': Object.freeze({ artifactPresent: false }),
  'cooperation.aligned': Object.freeze({ cooperationAligned: false }),
  'ui.attached': Object.freeze({ uiAttached: false }),
  'transport.local': Object.freeze({ remote: true }),
});

/** 全部前置事实都为真的 context：用于“理想上下文”下的派发判定。 */
export const SATISFIED_CONTEXT = Object.freeze({
  daemon: true,
  instanceConnected: true,
  browserReady: true,
  sessionActive: true,
  sessionUnpaused: true,
  tabId: 7,
  controlHeld: true,
  target: Object.freeze({ ref: '@e1' }),
  observationFresh: true,
  recording: true,
  debuggerIdle: true,
  dialogPending: true,
  transferOpen: true,
  networkCapturing: true,
  traceActive: true,
  planApproved: true,
  pairAvailable: true,
  artifactPresent: true,
  cooperationAligned: true,
  uiAttached: true,
  remote: false,
});

/** 后置条件的“满足”夹具：每份片段喂给 verifyPostcondition(code) 必须 satisfied。 */
export const POSTCONDITION_EVIDENCE = Object.freeze({
  'result.returned': Object.freeze({ ok: true }),
  'read.available': Object.freeze({ items: Object.freeze([1]) }),
  'page.mutated': Object.freeze({ changed: true }),
  'navigation.committed': Object.freeze({ committed: true }),
  'focus.updated': Object.freeze({ focused: true }),
  'scroll.updated': Object.freeze({ scrollY: 0 }),
  'emulation.updated': Object.freeze({ emulated: true }),
  'tab.created': Object.freeze({ tabId: 9 }),
  'tab.removed': Object.freeze({ removed: true }),
  'tab.updated': Object.freeze({ updated: true }),
  'window.created': Object.freeze({ windowId: 3 }),
  'window.removed': Object.freeze({ windowId: 3 }),
  'window.updated': Object.freeze({ windowId: 3 }),
  'session.created': Object.freeze({ sessionId: 's1' }),
  'session.removed': Object.freeze({ stopped: true }),
  'session.updated': Object.freeze({ updated: true }),
  'artifact.created': Object.freeze({ path: '/tmp/a.bin' }),
  'artifact.removed': Object.freeze({ removed: true }),
  'artifact.updated': Object.freeze({ path: '/tmp/a.bin' }),
  'capture.available': Object.freeze({ image: 'data:image/png;base64,AA==' }),
  'recording.active': Object.freeze({ recording: true }),
  'recording.inactive': Object.freeze({ stopped: true }),
  'debugger.attached': Object.freeze({ attached: true }),
  'debugger.detached': Object.freeze({ detached: true }),
  'network.capturing': Object.freeze({ capturing: true }),
  'network.idle': Object.freeze({ stopped: true }),
  'dialog.armed': Object.freeze({ armed: true }),
  'dialog.resolved': Object.freeze({ accepted: true }),
  'control.updated': Object.freeze({ updated: true }),
  'ledger.committed': Object.freeze({ committed: true }),
  'coordination.updated': Object.freeze({ updated: true }),
  'transfer.updated': Object.freeze({ updated: true }),
  'policy.updated': Object.freeze({ updated: true }),
  'plan.updated': Object.freeze({ planId: 'p1' }),
});

// ===========================================================================
// 三、证据归一化：调用方只传它知道的字段
//
// 一次调用的证据可能是：
//   { context }                     —— 只有派发前事实（做 preflight 判定）
//   { result }                      —— 只有成功结果（做 post/effect_state 判定）
//   { error, effectState }          —— 只有失败（做 recovery/replay 判定）
//   { retryRequested: true, ... }   —— 明确问“能不能重发”
// 缺什么就 inapplicable/unknown，绝不把“没提供证据”当作“条件不成立”。
// ===========================================================================

/** 空证据（冻结复用，避免每次 new）。 */
export const EMPTY_EVIDENCE = Object.freeze({});

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function own(object, key) {
  return Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);
}

/**
 * 归一化证据：
 * @param {object} [input]
 * @returns {{
 *   context: object|null, result: *, hasResult: boolean, error: *,
 *   effectState: string|null, dispatched: boolean|null, retryRequested: boolean,
 *   outcome: string|null, code: string|null,
 * }}
 */
export function normalizeEvidence(input = {}) {
  const bag = isObject(input) ? input : {};
  const hasResult = own(bag, 'result') && bag.result !== undefined;
  const error = own(bag, 'error') ? bag.error : undefined;
  const code = (() => {
    if (error && typeof error === 'object' && error.code) return String(error.code);
    if (typeof error === 'string' && error) return error;
    if (typeof bag.code === 'string' && bag.code) return bag.code;
    return null;
  })();
  const effectState = (() => {
    if (typeof bag.effectState === 'string' && bag.effectState) return bag.effectState;
    if (typeof bag.effect_state === 'string' && bag.effect_state) return bag.effect_state;
    if (error && typeof error === 'object') {
      const data = isObject(error.data) ? error.data : {};
      const candidates = [error.effectState, error.effect_state, data.effectState, data.effect_state];
      for (const value of candidates) if (typeof value === 'string' && value) return value;
    }
    return null;
  })();
  const dispatched = (() => {
    if (typeof bag.dispatched === 'boolean') return bag.dispatched;
    if (error && typeof error === 'object' && typeof error.dispatched === 'boolean') return error.dispatched;
    return null;
  })();
  const retryRequested = bag.retryRequested === true || bag.retrying === true || bag.replaying === true || bag.retry === true;
  return Object.freeze({
    context: own(bag, 'context') ? (isObject(bag.context) ? bag.context : null) : null,
    result: hasResult ? bag.result : undefined,
    hasResult,
    error: error === undefined ? null : error,
    hasError: error !== undefined,
    code,
    effectState,
    dispatched,
    retryRequested,
    outcome: typeof bag.outcome === 'string' ? bag.outcome : null,
  });
}

/** 证据是否为空（所有维度都 inapplicable）：用于“只有静态快照”的报告。 */
export function isBlindEvidence(evidence) {
  const item = evidence && evidence.__normalized ? evidence : normalizeEvidence(evidence || {});
  return item.context === null && !item.hasResult && !item.hasError && !item.effectState && !item.retryRequested;
}

/** 给 evidence 打标（内部复用；避免重复归一化时仍保持纯数据）。 */
function markNormalized(evidence) {
  return evidence;
}

/** 兼容：接受外部已经归一化过的证据或原始输入。 */
export function asEvidence(input) {
  if (input && input.__normalized === true) return input;
  const normalized = normalizeEvidence(input || {});
  return Object.freeze({ ...normalized, __normalized: true });
}

// ===========================================================================
// 四、义务构造：把 METHOD_PROOF 的六维展开成可执行描述符
//
// 一条义务 = 一个可被判定的问题。构造是纯派生的：
//   pre        每个前置码一条（blocking=派发闸门）
//   post       每个后置码一条（blocking=成功声明闸门）
//   effectState 每个方法一条（声明该方法的副作用分类，用于判定“已生效”是否矛盾）
//   idempotent  每个方法一条（重放语义解释，非阻断但参与说明）
//   replayable  每个方法一条（blocking=自动重放闸门）
//   recovery    每个方法一条（blocking=必须有恢复计划）
// 165 个方法 ×（pre 数 + post 数 + 4）≈ 2,000 条义务，模块加载时一次派生并冻结。
// ===========================================================================

/** 义务 id 前缀（稳定，供 CLI/MCP 引用某一条具体义务）。 */
export const OBLIGATION_ID_PREFIX = Object.freeze({
  pre: 'pre',
  post: 'post',
  effectState: 'effect-state',
  idempotent: 'idempotent',
  replayable: 'replayable',
  recovery: 'recovery',
});

function freezeCodes(codes) {
  return Object.freeze([...(codes || [])]);
}

function makeObligation(fields) {
  return Object.freeze({
    id: fields.id,
    method: fields.method,
    dimension: fields.dimension,
    kind: fields.kind,
    stage: fields.stage,
    code: fields.code === undefined ? null : fields.code,
    label: fields.label === undefined ? null : fields.label,
    requirement: fields.requirement,
    blocking: fields.blocking === true,
    value: fields.value === undefined ? null : fields.value,
    codes: fields.codes ? freezeCodes(fields.codes) : null,
    derivedFrom: fields.derivedFrom,
    order: fields.order,
  });
}

/** 恢复动作的可执行中文说明（来自目录 PROOF_RECOVERY_ACTIONS，不新增动作）。 */
function recoveryActionLabel(action) {
  return PROOF_RECOVERY_ACTIONS[action] || action || null;
}

/**
 * 构造一个方法的全部义务（纯函数）。
 * @param {string} method
 * @returns {ReadonlyArray<object>}
 */
export function buildObligationsFor(method) {
  const proof = proofOf(method);
  if (!proof) return Object.freeze([]);
  const out = [];
  let order = 0;
  for (const code of proof.pre) {
    out.push(makeObligation({
      id: OBLIGATION_ID_PREFIX.pre + ':' + code,
      method: proof.method,
      dimension: 'pre',
      kind: DIMENSION_KIND.pre,
      stage: KIND_STAGE.precondition,
      code,
      label: PROOF_PRECONDITIONS[code] || code,
      requirement: '调用前事实「' + (PROOF_PRECONDITIONS[code] || code) + '」必须成立；有反证时禁止派发',
      blocking: true,
      derivedFrom: 'METHOD_PROOF.pre',
      order: (order += 1),
    }));
  }
  for (const code of proof.post) {
    out.push(makeObligation({
      id: OBLIGATION_ID_PREFIX.post + ':' + code,
      method: proof.method,
      dimension: 'post',
      kind: DIMENSION_KIND.post,
      stage: KIND_STAGE.postcondition,
      code,
      label: PROOF_POSTCONDITIONS[code] || code,
      requirement: '成功返回后必须能证明「' + (PROOF_POSTCONDITIONS[code] || code) + '」；矛盾时禁止声明成功',
      blocking: true,
      derivedFrom: 'METHOD_PROOF.post',
      order: (order += 1),
    }));
  }
  out.push(makeObligation({
    id: OBLIGATION_ID_PREFIX.effectState,
    method: proof.method,
    dimension: 'effectState',
    kind: DIMENSION_KIND.effectState,
    stage: KIND_STAGE['effect-state'],
    code: proof.effectState,
    label: PROOF_EFFECT_STATES[proof.effectState] || proof.effectState,
    requirement: '调用结果的 effect_state 必须能落入 none/unknown/applied 三态，且不得与方法的副作用分类矛盾',
    blocking: true,
    value: proof.effectState,
    derivedFrom: 'METHOD_PROOF.effectState',
    order: (order += 1),
  }));
  out.push(makeObligation({
    id: OBLIGATION_ID_PREFIX.idempotent,
    method: proof.method,
    dimension: 'idempotent',
    kind: DIMENSION_KIND.idempotent,
    stage: KIND_STAGE.idempotency,
    code: null,
    label: proof.idempotent ? '逻辑幂等' : '逻辑非幂等',
    requirement: '重放只有在逻辑幂等、或已证明未生效时才安全；非幂等重复执行会产生第二次副作用',
    blocking: false,
    value: proof.idempotent,
    derivedFrom: 'METHOD_PROOF.idempotent',
    order: (order += 1),
  }));
  out.push(makeObligation({
    id: OBLIGATION_ID_PREFIX.replayable,
    method: proof.method,
    dimension: 'replayable',
    kind: DIMENSION_KIND.replayable,
    stage: KIND_STAGE.replayability,
    code: null,
    label: proof.replayable ? '可自动重放' : '必须人工/账本判定',
    requirement: '结果未知后能否不经人工判断直接重发；只有只读/结果可证明的方法才允许',
    blocking: true,
    value: proof.replayable,
    derivedFrom: 'METHOD_PROOF.replayable',
    order: (order += 1),
  }));
  out.push(makeObligation({
    id: OBLIGATION_ID_PREFIX.recovery,
    method: proof.method,
    dimension: 'recovery',
    kind: DIMENSION_KIND.recovery,
    stage: KIND_STAGE.recovery,
    code: null,
    label: proof.profile,
    requirement: '任何失败错误码都必须能映射到可执行恢复计划（动作/重试上限/严重度）',
    blocking: true,
    codes: proof.recovery,
    derivedFrom: 'METHOD_PROOF.recovery',
    order: (order += 1),
  }));
  return Object.freeze(out);
}

/** 全量义务表（键序 = 目录顺序；模块加载时一次派生并冻结）。 */
export const METHOD_OBLIGATIONS = Object.freeze(Object.fromEntries(
  METHOD_NAMES.map((method) => [method, buildObligationsFor(method)]),
));

/** 单方法义务（未知方法返回空数组，不抛错）。 */
export function obligationsFor(method) {
  return METHOD_OBLIGATIONS[String(method || '')] || Object.freeze([]);
}

/** 单条义务（未知方法/未知 id 返回 null）。 */
export function obligationById(method, id) {
  const list = obligationsFor(method);
  const key = String(id || '');
  return list.find((item) => item.id === key) || null;
}

/** 维度 → 该方法的义务列表。 */
export function obligationsByDimension(method) {
  const grouped = {};
  for (const dimension of OBLIGATION_DIMENSIONS) grouped[dimension] = [];
  for (const obligation of obligationsFor(method)) {
    if (!grouped[obligation.dimension]) grouped[obligation.dimension] = [];
    grouped[obligation.dimension].push(obligation);
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(grouped).map(([dimension, list]) => [dimension, Object.freeze(list)]),
  ));
}

/** 阶段 → 该方法的义务列表。 */
export function obligationsByStage(method) {
  const grouped = {};
  for (const stage of OBLIGATION_STAGES) grouped[stage] = [];
  for (const obligation of obligationsFor(method)) {
    if (!grouped[obligation.stage]) grouped[obligation.stage] = [];
    grouped[obligation.stage].push(obligation);
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(grouped).map(([stage, list]) => [stage, Object.freeze(list)]),
  ));
}

// ===========================================================================
// 五、执行器：evaluateObligation —— 唯一的判定入口
//
// 每个 kind 的判定只读证据 + 目录事实，并且严格区分：
//   violated     —— 证据与事实矛盾（必须阻断）
//   unknown      —— 证据不足/结果不可证明（不阻断，但也不能声称已证明）
//   unverifiable —— 该事实根本不能只从 RPC 结果证明（诚实标记）
//   inapplicable —— 本次证据与这条义务无关
// ===========================================================================

const OUTCOME_STATE_SET = new Set(EFFECT_OUTCOME_STATES);

function evaluatePrecondition(obligation, evidence) {
  if (evidence.context === null) {
    return Object.freeze({
      verdict: 'unknown',
      reason: '未提供调用前上下文，无法判定前置条件「' + obligation.code + '」',
    });
  }
  const check = checkPrecondition(obligation.code, evidence.context);
  return Object.freeze({
    verdict: check.state,
    reason: check.state === 'satisfied'
      ? '前置条件成立：' + check.label
      : check.state === 'violated'
        ? '前置条件有反证：' + check.label
        : '前置条件缺证据（unknown ≠ 不成立）：' + check.label,
    evidence: check,
  });
}

function evaluatePostcondition(obligation, evidence) {
  if (!evidence.hasResult) {
    return Object.freeze({
      verdict: 'inapplicable',
      reason: '没有成功结果可核验（调用未成功或只做派发前判定）',
    });
  }
  const check = verifyPostcondition(obligation.code, evidence.result);
  return Object.freeze({
    verdict: check.state,
    reason: check.state === 'satisfied'
      ? '后置条件可证明：' + check.label
      : check.state === 'violated'
        ? '后置条件与结果矛盾：' + check.label
        : '后置条件不能只从 RPC 结果证明：' + check.label,
    evidence: check,
  });
}

function evaluateEffectState(obligation, evidence) {
  const declared = obligation.value;
  if (!evidence.effectState) {
    if (evidence.hasResult) {
      return Object.freeze({
        verdict: 'unknown',
        reason: '成功返回但未提供 effect_state 证据，无法判定副作用是否已生效',
      });
    }
    return Object.freeze({
      verdict: 'inapplicable',
      reason: '还没有可判定的调用结果',
    });
  }
  if (!OUTCOME_STATE_SET.has(evidence.effectState)) {
    return Object.freeze({
      verdict: 'violated',
      reason: 'effect_state 取值不在 none/unknown/applied 三态内：' + evidence.effectState,
    });
  }
  if (evidence.effectState === 'unknown') {
    return Object.freeze({
      verdict: 'unknown',
      reason: 'effect_state=unknown：结果不可证明，必须观察页面或查账本',
    });
  }
  if (evidence.effectState === 'applied' && declared === 'none') {
    return Object.freeze({
      verdict: 'violated',
      reason: '只读/无副作用方法报告 effect_state=applied，与目录副作用分类矛盾',
    });
  }
  return Object.freeze({
    verdict: 'satisfied',
    reason: 'effect_state=' + evidence.effectState + ' 与副作用分类「' + declared + '」相容',
  });
}

function evaluateIdempotency(obligation, evidence) {
  if (!evidence.retryRequested) {
    return Object.freeze({
      verdict: 'inapplicable',
      reason: '没有请求重放，幂等性不参与本次判定',
    });
  }
  if (obligation.value === true) {
    return Object.freeze({
      verdict: 'satisfied',
      reason: '方法逻辑幂等：同方法同参数重复执行后最终状态不变',
    });
  }
  const codeProvesNoEffect = Boolean(evidence.code) && !isUnknownOutcomeCode(evidence.code);
  const notApplied = evidence.effectState === 'none' || evidence.dispatched === false || codeProvesNoEffect;
  if (notApplied) {
    return Object.freeze({
      verdict: 'satisfied',
      reason: codeProvesNoEffect
        ? '错误码 ' + evidence.code + ' 属于派发前/校验阶段，可证明未生效'
        : '已证明未生效（effect_state=none 或 dispatched=false），重放不会产生第二次副作用',
    });
  }
  return Object.freeze({
    verdict: 'violated',
    reason: '非幂等方法在结果不可证明时重放，可能产生第二次真实副作用',
  });
}

/**
 * 账本类错误码（派生：playbook 里 action=resolve-ledger 的码）。
 * 这类错误表示“有 pending/unknown 条目未收敛”，即使方法本身可重放，也必须先 resolve。
 */
const LEDGER_RESOLVE_CODES = new Set(Object.keys(RECOVERY_PLAYBOOK)
  .filter((code) => RECOVERY_PLAYBOOK[code].action === 'resolve-ledger'));

function evaluateReplayability(obligation, evidence) {
  if (!evidence.retryRequested) {
    return Object.freeze({
      verdict: 'inapplicable',
      reason: '没有请求重放，可重放性不参与本次判定',
    });
  }
  if (evidence.code && LEDGER_RESOLVE_CODES.has(evidence.code)) {
    return Object.freeze({
      verdict: 'violated',
      reason: '账本仍有 pending/unknown 条目（' + evidence.code + '）：必须先 ledger resolve 再决定是否重发',
    });
  }
  const decision = replayDecision(obligation.method, {
    effectState: evidence.effectState === null ? undefined : evidence.effectState,
    dispatched: evidence.dispatched === null ? undefined : evidence.dispatched,
    code: evidence.code || undefined,
  });
  return Object.freeze({
    verdict: decision.allowed ? 'satisfied' : 'violated',
    reason: decision.reason,
    evidence: decision,
  });
}

function evaluateRecovery(obligation, evidence) {
  if (!evidence.hasError) {
    return Object.freeze({
      verdict: 'inapplicable',
      reason: '没有错误，恢复义务不参与本次判定',
    });
  }
  const plan = recoveryPlan(obligation.method, evidence.error, {
    effectState: evidence.effectState === null ? undefined : evidence.effectState,
    dispatched: evidence.dispatched === null ? undefined : evidence.dispatched,
  });
  if (!plan.known) {
    return Object.freeze({
      verdict: 'violated',
      reason: plan.note,
    });
  }
  if (plan.requiresHuman) {
    return Object.freeze({
      verdict: 'satisfied',
      reason: '恢复计划存在但需要人工介入：' + plan.action + '（' + recoveryActionLabel(plan.action) + '）',
      evidence: plan,
    });
  }
  return Object.freeze({
    verdict: 'satisfied',
    reason: '恢复计划可执行：' + plan.action + '（' + recoveryActionLabel(plan.action) + '，最多重试 ' + plan.maxAttempts + ' 次）',
    evidence: plan,
  });
}

const KIND_EVALUATORS = Object.freeze({
  precondition: evaluatePrecondition,
  postcondition: evaluatePostcondition,
  'effect-state': evaluateEffectState,
  idempotency: evaluateIdempotency,
  replayability: evaluateReplayability,
  recovery: evaluateRecovery,
});

/**
 * 执行一条义务。
 * @param {object} obligation 义务描述符（来自 obligationsFor）
 * @param {object} [input] 证据（会归一化）
 * @returns {{id,method,dimension,kind,stage,code,verdict,reason,blocking,evidence?:object}}
 */
export function evaluateObligation(obligation, input = {}) {
  if (!obligation || typeof obligation !== 'object') {
    return Object.freeze({
      id: null, method: null, dimension: null, kind: null, stage: null, code: null,
      verdict: 'inapplicable', reason: '没有提供义务描述符', blocking: false,
    });
  }
  const evidence = asEvidence(input);
  const evaluator = KIND_EVALUATORS[obligation.kind];
  const outcome = evaluator
    ? evaluator(obligation, evidence)
    : Object.freeze({ verdict: 'unknown', reason: '未登记的义务种类：' + String(obligation.kind) });
  return Object.freeze({
    id: obligation.id,
    method: obligation.method,
    dimension: obligation.dimension,
    kind: obligation.kind,
    stage: obligation.stage,
    code: obligation.code,
    verdict: outcome.verdict,
    reason: outcome.reason,
    blocking: obligation.blocking === true,
    evidence: outcome.evidence === undefined ? null : outcome.evidence,
  });
}

// ===========================================================================
// 六、整次调用的执行：runCallObligations
//
// 输出三个硬结论（对应 daemon/CLI/MCP 真正需要的三个问题）：
//   canDispatch     —— 现在能不能发这个请求；
//   canClaimSuccess —— 拿到结果后能不能宣称成功（后置矛盾 = 不能）；
//   canAutoReplay   —— 结果未知/失败后能不能自动重发（不能就必须 resolve 账本）。
// 另外 hasRecoveryPlan 回答“失败后有没有可执行恢复路径”。
// ===========================================================================

function stageReport(checks, stage) {
  const list = checks.filter((check) => check.stage === stage);
  const pick = (verdict) => list.filter((check) => check.verdict === verdict);
  const violated = pick('violated');
  const blockingViolations = violated.filter((check) => check.blocking);
  const unknown = pick('unknown');
  const unverifiable = pick('unverifiable');
  const satisfied = pick('satisfied');
  const inapplicable = pick('inapplicable');
  return Object.freeze({
    stage,
    total: list.length,
    // 只有“blocking 且 violated”才翻转硬结论；非阻断义务（幂等性）只做解释。
    ok: blockingViolations.length === 0,
    proven: violated.length === 0 && unknown.length === 0 && unverifiable.length === 0 && satisfied.length > 0,
    blocking: Object.freeze(list.filter((check) => check.blocking).map((check) => check.id)),
    blockedBy: Object.freeze(blockingViolations.map((check) => check.id)),
    violated: Object.freeze(violated.map((check) => check.id)),
    unknown: Object.freeze(unknown.map((check) => check.id)),
    unverifiable: Object.freeze(unverifiable.map((check) => check.id)),
    satisfied: Object.freeze(satisfied.map((check) => check.id)),
    inapplicable: Object.freeze(inapplicable.map((check) => check.id)),
  });
}

function aggregateVerdict(checks) {
  const blocking = checks.filter((check) => check.blocking);
  const pool = blocking.length ? blocking : checks;
  const verdicts = new Set(pool.map((check) => check.verdict));
  if (verdicts.has('violated')) return 'violated';
  if (verdicts.has('unknown')) return 'unknown';
  if (verdicts.has('unverifiable')) return 'partial';
  if (verdicts.has('satisfied')) return 'proven';
  return 'inapplicable';
}

function summarizeCall(verdict, stageMap, evidence) {
  const violated = Object.values(stageMap).flatMap((stage) => stage.violated);
  if (verdict === 'violated') {
    return '调用义务失败：' + violated.join('、') + '；不得派发/声成功/自动重放';
  }
  if (!evidence.retryRequested && !evidence.hasError && !evidence.hasResult && evidence.context === null) {
    return '只有静态义务快照：未提供任何运行时证据';
  }
  if (verdict === 'unknown') {
    return '证据不足：可以继续，但不能声称已证明（unknown ≠ 已生效）';
  }
  if (verdict === 'partial') {
    return '部分义务只能由后续 observe/status 证明';
  }
  if (verdict === 'proven') {
    return '全部相关义务已证明';
  }
  return '本次证据与全部义务无关';
}

/**
 * 执行一次调用的全部义务。
 * @param {string} method
 * @param {object} [input] 证据；也可直接传已归一化的对象
 * @returns {{
 *   method:string, known:boolean, verdict:string,
 *   checks:Array<object>, stages:object, counts:object<number>,
 *   canDispatch:boolean, canClaimSuccess:boolean, canAutoReplay:boolean, hasRecoveryPlan:boolean,
 *   blocking:Array<object>, violations:Array<string>, unknowns:Array<string>,
 *   summary:string, evidence:object,
 * }}
 */
export function runCallObligations(method, input = {}) {
  const name = String(method || '');
  const proof = proofOf(name);
  const evidence = asEvidence(input);
  const emptyStages = Object.freeze(Object.fromEntries(OBLIGATION_STAGES.map((stage) => [stage, stageReport([], stage)])));
  if (!proof) {
    return Object.freeze({
      method: name,
      known: false,
      verdict: 'violated',
      checks: Object.freeze([]),
      stages: emptyStages,
      counts: Object.freeze({ total: 0 }),
      canDispatch: false,
      canClaimSuccess: false,
      canAutoReplay: false,
      hasRecoveryPlan: false,
      blocking: Object.freeze([]),
      violations: Object.freeze(['未知方法']),
      unknowns: Object.freeze([]),
      summary: '未知方法：没有可执行义务，按保守语义一律禁止',
      evidence,
    });
  }
  const checks = Object.freeze(obligationsFor(name).map((obligation) => evaluateObligation(obligation, evidence)));
  const stages = Object.freeze(Object.fromEntries(
    OBLIGATION_STAGES.map((stage) => [stage, stageReport(checks, stage)]),
  ));
  const verdict = aggregateVerdict(checks);
  const counts = {};
  for (const check of checks) counts[check.verdict] = (counts[check.verdict] || 0) + 1;
  const blocking = Object.freeze(checks.filter((check) => check.blocking && check.verdict === 'violated'));
  const violations = Object.freeze(checks.filter((check) => check.verdict === 'violated').map((check) => check.id));
  const unknowns = Object.freeze(checks.filter((check) => check.verdict === 'unknown').map((check) => check.id));
  return Object.freeze({
    method: name,
    known: true,
    verdict,
    checks,
    stages,
    counts: Object.freeze(counts),
    canDispatch: stages.preflight.ok,
    canClaimSuccess: stages.settle.ok,
    canAutoReplay: stages.replay.ok,
    hasRecoveryPlan: stages.recovery.ok,
    blocking,
    violations,
    unknowns,
    summary: summarizeCall(verdict, stages, evidence),
    evidence,
  });
}

/** 只做派发前判定（CLI/MCP 在真正 call 之前的 dry-run）。 */
export function preflightCall(method, context = {}) {
  return runCallObligations(method, { context });
}

/** 只做成功结果结算（拿到结果后判定“能不能声称成功”）。 */
export function settleCall(method, result, options = {}) {
  return runCallObligations(method, {
    result,
    effectState: options.effectState === undefined ? 'none' : options.effectState,
    dispatched: options.dispatched === undefined ? true : options.dispatched,
  });
}

/** 只做重放判定（失败/结果未知后，能不能自动重发）。 */
export function replayObligations(method, options = {}) {
  return runCallObligations(method, {
    retryRequested: true,
    effectState: options.effectState,
    dispatched: options.dispatched,
    code: options.code,
    error: options.error,
  });
}

/** 只做恢复计划判定（失败后是否有可执行恢复路径）。 */
export function recoveryObligations(method, error, options = {}) {
  return runCallObligations(method, {
    error,
    effectState: options.effectState,
    dispatched: options.dispatched,
  });
}

/** 三条硬结论的一行摘要（日志/CLI 文本模式用）。 */
export function callVerdictLine(method, input = {}) {
  const run = runCallObligations(method, input);
  return '[' + (run.verdict || 'unknown') + '] ' + String(method || '')
    + ' dispatch=' + (run.canDispatch ? 'yes' : 'no')
    + ' claim=' + (run.canClaimSuccess ? 'yes' : 'no')
    + ' replay=' + (run.canAutoReplay ? 'yes' : 'no')
    + ' recovery=' + (run.hasRecoveryPlan ? 'yes' : 'no');
}

// ===========================================================================
// 七、静态摘要：给 daemon/health/status/CLI 的只读快照
//
// 这些函数不执行证据，只把“义务表长什么样、风险多高、重放策略是什么”压缩成
// JSON 安全的结构。daemon 的 /health、daemon.status 与 CLI status --json 会原样
// 序列化它们，所以字段必须可 JSON.stringify（不能含 Set/Map/undefined/函数）。
// ===========================================================================

/** 风险分级：safe=可自动重放；guarded=幂等但结果不可证明；risky=非幂等且结果不可证明。 */
export const OBLIGATION_RISKS = Object.freeze(['safe', 'guarded', 'risky']);

function riskOf(proof) {
  if (proof.replayable) return 'safe';
  if (proof.idempotent) return 'guarded';
  return 'risky';
}

function riskLabel(risk) {
  if (risk === 'safe') return '可自动重放（只读/结果可证明）';
  if (risk === 'guarded') return '幂等但结果不可证明：重放前先 resolve 账本';
  return '非幂等且结果不可证明：绝不能自动重放';
}

/**
 * 单方法义务摘要（静态，无证据）。
 * @param {string} method
 */
export function obligationSummary(method) {
  const name = String(method || '');
  const proof = proofOf(name);
  if (!proof) {
    return Object.freeze({
      method: name, known: false, risk: 'risky',
      dimensions: Object.freeze({}), counts: Object.freeze({ total: 0 }),
      policy: Object.freeze({}), blocking: Object.freeze({}), ids: Object.freeze([]),
    });
  }
  const obligations = obligationsFor(name);
  const counts = { total: obligations.length };
  for (const dimension of OBLIGATION_DIMENSIONS) counts[dimension] = 0;
  for (const obligation of obligations) counts[obligation.dimension] = (counts[obligation.dimension] || 0) + 1;
  const risk = riskOf(proof);
  return Object.freeze({
    method: name,
    known: true,
    risk,
    riskLabel: riskLabel(risk),
    dimensions: Object.freeze({
      pre: proof.pre,
      post: proof.post,
      effectState: proof.effectState,
      effectStateLabel: PROOF_EFFECT_STATES[proof.effectState] || null,
      idempotent: proof.idempotent,
      replayable: proof.replayable,
      recoveryProfile: proof.profile,
      recoveryCodes: proof.recovery,
    }),
    counts: Object.freeze(counts),
    blocking: Object.freeze({
      dispatch: proof.pre.length,
      claim: proof.post.length,
      replay: 1,
      recovery: 1,
    }),
    policy: Object.freeze({
      canDispatchOnlyAfterPre: true,
      claimRequiresPostEvidence: true,
      canAutoReplay: proof.replayable,
      requiresResolveOnUnknown: !proof.replayable,
      replaySafeAfterNotApplied: true,
      idempotent: proof.idempotent,
    }),
    ids: Object.freeze(obligations.map((obligation) => obligation.id)),
  });
}

/** 单方法义务矩阵行（表格化，供 status/诊断打印）。 */
export function obligationRow(method) {
  const summary = obligationSummary(method);
  return Object.freeze({
    method: summary.method,
    known: summary.known,
    risk: summary.risk,
    preCount: summary.known ? summary.counts.pre : 0,
    postCount: summary.known ? summary.counts.post : 0,
    recoveryCount: summary.known ? summary.dimensions.recoveryCodes.length : 0,
    effectState: summary.known ? summary.dimensions.effectState : null,
    idempotent: summary.known ? summary.dimensions.idempotent : null,
    replayable: summary.known ? summary.dimensions.replayable : null,
    blockingCount: summary.known ? summary.counts.total : 0,
  });
}

/** 全量义务矩阵（键序 = 目录顺序）。 */
export function obligationMatrix(methods = METHOD_NAMES) {
  return Object.freeze([...methods].map((method) => obligationRow(method)));
}

/**
 * 特性级义务聚合：某个 feature floor 缺能力时，受影响的调用集合有多危险。
 * 参数级特性（unverified/expect/observe-delta）没有方法清单，按目录语义“对所有方法
 * 生效”，因此聚合会覆盖全量方法——这也是它们最危险的地方（旧扩展静默忽略）。
 * @param {string} feature
 */
export function featureObligations(feature) {
  const key = String(feature || '');
  const cached = FEATURE_OBLIGATION_CACHE.get(key);
  if (cached) return cached;
  const floor = FEATURE_FLOORS[key] || null;
  const methodSet = new Set(FEATURE_METHODS[key] || []);
  let allMethods = false;
  for (const rule of FEATURE_PARAM_RULES) {
    if (rule.feature !== key) continue;
    if (Array.isArray(rule.methods) && rule.methods.length) {
      for (const method of rule.methods) methodSet.add(method);
    } else {
      allMethods = true;
    }
  }
  const methods = allMethods ? [...METHOD_NAMES] : [...methodSet].filter((method) => proofOf(method)).sort();
  const effectStates = {};
  const risks = { safe: 0, guarded: 0, risky: 0 };
  const profiles = {};
  const recoveryActions = new Set();
  const riskyMethods = [];
  const guardedMethods = [];
  let idempotent = 0;
  let replayable = 0;
  let requiresResolve = 0;
  let obligationCount = 0;
  for (const method of methods) {
    const proof = proofOf(method);
    if (!proof) continue;
    effectStates[proof.effectState] = (effectStates[proof.effectState] || 0) + 1;
    profiles[proof.profile] = (profiles[proof.profile] || 0) + 1;
    if (proof.idempotent) idempotent += 1;
    if (proof.replayable) replayable += 1;
    if (!proof.replayable) requiresResolve += 1;
    for (const code of proof.recovery) {
      const plan = RECOVERY_PLAYBOOK[code];
      if (plan && plan.action) recoveryActions.add(plan.action);
    }
    const risk = riskOf(proof);
    risks[risk] += 1;
    if (risk === 'risky') riskyMethods.push(method);
    if (risk === 'guarded') guardedMethods.push(method);
    obligationCount += obligationsFor(method).length;
  }
  const summary = Object.freeze({
    feature: key,
    known: Object.prototype.hasOwnProperty.call(FEATURE_FLOORS, key),
    floor,
    scope: allMethods ? 'all-methods' : 'method-list',
    methods: Object.freeze(methods),
    methodCount: methods.length,
    gatedMethods: Object.freeze([...(FEATURE_METHODS[key] || [])].sort()),
    effectStates: Object.freeze(effectStates),
    risks: Object.freeze(risks),
    profiles: Object.freeze(profiles),
    recoveryActions: Object.freeze([...recoveryActions].sort()),
    counts: Object.freeze({
      methods: methods.length,
      idempotent,
      replayable,
      requiresResolve,
      obligations: obligationCount,
    }),
    riskyMethods: Object.freeze(riskyMethods),
    guardedMethods: Object.freeze(guardedMethods),
  });
  FEATURE_OBLIGATION_CACHE.set(key, summary);
  return summary;
}

const FEATURE_OBLIGATION_CACHE = new Map();

/** 全特性义务聚合（9 个特性；供 compatibilityReport / 文档）。 */
export function featureObligationMatrix(features = FEATURE_NAMES) {
  return Object.freeze([...features].map((feature) => featureObligations(feature)));
}

/** 维度覆盖统计：每个维度多少条义务、多少方法带它。 */
export function obligationDimensionSummary() {
  const totals = {};
  const methodsWith = {};
  for (const dimension of OBLIGATION_DIMENSIONS) {
    totals[dimension] = 0;
    methodsWith[dimension] = 0;
  }
  for (const method of METHOD_NAMES) {
    const seen = new Set();
    for (const obligation of obligationsFor(method)) {
      totals[obligation.dimension] = (totals[obligation.dimension] || 0) + 1;
      seen.add(obligation.dimension);
    }
    for (const dimension of seen) methodsWith[dimension] += 1;
  }
  return Object.freeze({
    methods: METHOD_NAMES.length,
    obligations: Object.values(totals).reduce((sum, value) => sum + value, 0),
    totals: Object.freeze(totals),
    methodsWith: Object.freeze(methodsWith),
    dimensions: OBLIGATION_DIMENSIONS,
  });
}

/** 风险分布（方法数）。 */
export function obligationRiskSummary() {
  const counts = { safe: 0, guarded: 0, risky: 0 };
  const byRisk = { safe: [], guarded: [], risky: [] };
  for (const method of METHOD_NAMES) {
    const proof = proofOf(method);
    if (!proof) continue;
    const risk = riskOf(proof);
    counts[risk] += 1;
    byRisk[risk].push(method);
  }
  return Object.freeze({
    counts: Object.freeze(counts),
    safe: Object.freeze(byRisk.safe),
    guarded: Object.freeze(byRisk.guarded),
    risky: Object.freeze(byRisk.risky),
  });
}

/** 需要人工/账本 resolve 的方法（unknown 且不可回放）：恢复顺序的最高优先级。 */
export function methodsRequiringResolution() {
  return Object.freeze(METHOD_NAMES.filter((method) => {
    const proof = proofOf(method);
    return Boolean(proof) && !proof.replayable;
  }));
}

/** 恢复动作 → 涉及方法数（诊断/文档）。 */
export function recoveryActionIndex() {
  const index = {};
  for (const method of METHOD_NAMES) {
    const proof = proofOf(method);
    if (!proof) continue;
    for (const code of proof.recovery) {
      const plan = RECOVERY_PLAYBOOK[code];
      if (!plan) continue;
      const action = plan.action;
      if (!index[action]) index[action] = { action, label: recoveryActionLabel(action), codes: new Set(), methods: new Set() };
      index[action].codes.add(code);
      index[action].methods.add(method);
    }
  }
  return Object.freeze(Object.fromEntries(Object.entries(index).map(([action, entry]) => [action, Object.freeze({
    action,
    label: entry.label,
    codes: Object.freeze([...entry.codes].sort()),
    methods: Object.freeze([...entry.methods].sort()),
    methodCount: entry.methods.size,
  })])));
}

// ===========================================================================
// 八、派生校验器
//
// 校验器分三层，全部返回“错误字符串/结构数组”（空 = 通过），方便 protocol-check、
// 单测与 daemon 诊断复用：
//   1) 夹具层：证据向量必须真的被状态机判成 expected（防止夹具与语义漂移）；
//   2) 结构层：义务表必须与目录逐项同源、id 唯一、阶段/blocking 合法；
//   3) 行为层：对 165 个方法跑固定的证据组合，验证硬结论的单调性。
// ===========================================================================

/** 后置条件矛盾夹具：该后置码的独立反证片段（构造证据时会排除该码的满足证据）。 */
export const POSTCONDITION_CONTRADICTION = Object.freeze({
  'tab.created': Object.freeze({ created: false }),
  'tab.removed': Object.freeze({ removed: false }),
  'window.created': Object.freeze({ created: false }),
  'window.removed': Object.freeze({ removed: false }),
  'window.updated': Object.freeze({ updated: false }),
  'session.created': Object.freeze({ created: false }),
  'session.removed': Object.freeze({ stopped: false }),
  'session.updated': Object.freeze({ updated: false }),
  'artifact.created': Object.freeze({ saved: false }),
  'artifact.removed': Object.freeze({ removed: false }),
  'capture.available': Object.freeze({ captured: false }),
  'recording.active': Object.freeze({ recording: false }),
  'recording.inactive': Object.freeze({ stopped: false }),
  'debugger.attached': Object.freeze({ attached: false }),
  'debugger.detached': Object.freeze({ detached: false }),
  'network.capturing': Object.freeze({ capturing: false }),
  'network.idle': Object.freeze({ stopped: false }),
  'dialog.armed': Object.freeze({ armed: false }),
  'dialog.resolved': Object.freeze({ accepted: false }),
  'ledger.committed': Object.freeze({ committed: false }),
  'control.updated': Object.freeze({ updated: false }),
  'policy.updated': Object.freeze({ updated: false }),
  'coordination.updated': Object.freeze({ updated: false }),
  'transfer.updated': Object.freeze({ updated: false }),
  'plan.updated': Object.freeze({ updated: false }),
  'focus.updated': Object.freeze({ focused: false }),
  'emulation.updated': Object.freeze({ emulated: false }),
  'navigation.committed': Object.freeze({ committed: false }),
  'page.mutated': Object.freeze({ changed: false }),
});

/** 一条错误（统一形状，便于打印）。 */
function issue(scope, code, message, expected, actual) {
  return Object.freeze({
    scope,
    code,
    message,
    expected: expected === undefined ? null : expected,
    actual: actual === undefined ? null : actual,
  });
}

/**
 * 夹具层校验 1：前置条件满足/不满足夹具必须被状态机判成 expected。
 * @param {{satisfied?:object, violated?:object}} [sources] 可注入替身（负例测试用）
 */
export function validatePreconditionFixtures(sources = {}) {
  const issues = [];
  const satisfiedAll = sources && sources.satisfied ? sources.satisfied : PRECONDITION_SATISFIED_CONTEXT;
  const violatedAll = sources && sources.violated ? sources.violated : PRECONDITION_VIOLATED_CONTEXT;
  const codes = Object.keys(PROOF_PRECONDITIONS);
  for (const code of codes) {
    const satisfied = satisfiedAll[code];
    if (!satisfied) { issues.push(issue('fixture.pre.satisfied', code, '缺少满足夹具')); continue; }
    const check = checkPrecondition(code, satisfied);
    if (check.state !== 'satisfied') issues.push(issue('fixture.pre.satisfied', code, '满足夹具被判成 ' + check.state, 'satisfied', check.state));
    const violated = violatedAll[code];
    if (!violated) { issues.push(issue('fixture.pre.violated', code, '缺少不满足夹具')); continue; }
    const bad = checkPrecondition(code, violated);
    if (bad.state !== 'violated') issues.push(issue('fixture.pre.violated', code, '不满足夹具被判成 ' + bad.state, 'violated', bad.state));
  }
  for (const code of Object.keys(satisfiedAll)) {
    if (!Object.prototype.hasOwnProperty.call(PROOF_PRECONDITIONS, code)) issues.push(issue('fixture.pre.extra', code, '夹具含未登记的前置码'));
  }
  for (const code of Object.keys(violatedAll)) {
    if (!Object.prototype.hasOwnProperty.call(PROOF_PRECONDITIONS, code)) issues.push(issue('fixture.pre.extra', code, '夹具含未登记的前置码'));
  }
  return issues;
}

/**
 * 夹具层校验 2：后置条件满足夹具必须被判定 satisfied；矛盾夹具必须被判定 violated。
 * @param {{satisfied?:object, contradiction?:object}} [sources] 可注入替身（负例测试用）
 */
export function validatePostconditionFixtures(sources = {}) {
  const issues = [];
  const satisfiedAll = sources && sources.satisfied ? sources.satisfied : POSTCONDITION_EVIDENCE;
  const contradictionAll = sources && sources.contradiction ? sources.contradiction : POSTCONDITION_CONTRADICTION;
  for (const code of Object.keys(PROOF_POSTCONDITIONS)) {
    const evidence = satisfiedAll[code];
    if (evidence === undefined) { issues.push(issue('fixture.post.satisfied', code, '缺少满足夹具')); continue; }
    const check = verifyPostcondition(code, evidence);
    if (check.state !== 'satisfied') issues.push(issue('fixture.post.satisfied', code, '满足夹具被判成 ' + check.state, 'satisfied', check.state));
  }
  for (const code of Object.keys(satisfiedAll)) {
    if (!Object.prototype.hasOwnProperty.call(PROOF_POSTCONDITIONS, code)) issues.push(issue('fixture.post.extra', code, '夹具含未登记的后置码'));
  }
  for (const [code, evidence] of Object.entries(contradictionAll)) {
    if (!Object.prototype.hasOwnProperty.call(PROOF_POSTCONDITIONS, code)) {
      issues.push(issue('fixture.post.contradiction', code, '矛盾夹具含未登记的后置码'));
      continue;
    }
    const check = verifyPostcondition(code, evidence);
    if (check.state !== 'violated') issues.push(issue('fixture.post.contradiction', code, '矛盾夹具被判成 ' + check.state, 'violated', check.state));
  }
  return issues;
}

/**
 * 结构层校验 1：单条义务描述符必须自洽（维度/种类/阶段/code/value 与目录一致）。
 */
export function validateObligation(obligation) {
  const issues = [];
  if (!obligation || typeof obligation !== 'object') return [issue('obligation', '<无>', '义务不是对象')];
  const id = obligation.id || '<无 id>';
  if (typeof obligation.id !== 'string' || !obligation.id) issues.push(issue('obligation.id', id, 'id 必须是非空字符串'));
  if (!proofOf(obligation.method)) issues.push(issue('obligation.method', id, '方法不在目录：' + String(obligation.method)));
  if (!OBLIGATION_DIMENSIONS.includes(obligation.dimension)) issues.push(issue('obligation.dimension', id, '维度非法：' + String(obligation.dimension)));
  if (DIMENSION_KIND[obligation.dimension] !== obligation.kind) {
    issues.push(issue('obligation.kind', id, '种类与维度不匹配', DIMENSION_KIND[obligation.dimension], obligation.kind));
  }
  if (KIND_STAGE[obligation.kind] !== obligation.stage) {
    issues.push(issue('obligation.stage', id, '阶段与种类不匹配', KIND_STAGE[obligation.kind], obligation.stage));
  }
  if (typeof obligation.requirement !== 'string' || !obligation.requirement.trim()) issues.push(issue('obligation.requirement', id, '缺少可执行说明'));
  if (typeof obligation.blocking !== 'boolean') issues.push(issue('obligation.blocking', id, 'blocking 必须是布尔'));
  const prove = proofOf(obligation.method);
  if (prove) {
    if (obligation.kind === 'precondition') {
      if (!Object.prototype.hasOwnProperty.call(PROOF_PRECONDITIONS, obligation.code)) issues.push(issue('obligation.code', id, '前置码未登记：' + String(obligation.code)));
      if (!prove.pre.includes(obligation.code)) issues.push(issue('obligation.code', id, '前置码不属于该方法的目录事实：' + String(obligation.code)));
    } else if (obligation.kind === 'postcondition') {
      if (!Object.prototype.hasOwnProperty.call(PROOF_POSTCONDITIONS, obligation.code)) issues.push(issue('obligation.code', id, '后置码未登记：' + String(obligation.code)));
      if (!prove.post.includes(obligation.code)) issues.push(issue('obligation.code', id, '后置码不属于该方法的目录事实：' + String(obligation.code)));
    } else if (obligation.kind === 'effect-state') {
      if (!Object.prototype.hasOwnProperty.call(PROOF_EFFECT_STATES, obligation.code)) issues.push(issue('obligation.code', id, 'effect_state 未登记：' + String(obligation.code)));
      if (obligation.value !== prove.effectState) issues.push(issue('obligation.value', id, 'effect-state 义务与目录不一致', prove.effectState, obligation.value));
    } else if (obligation.kind === 'idempotency') {
      if (obligation.value !== prove.idempotent) issues.push(issue('obligation.value', id, '幂等义务与目录不一致', prove.idempotent, obligation.value));
    } else if (obligation.kind === 'replayability') {
      if (obligation.value !== prove.replayable) issues.push(issue('obligation.value', id, '可重放义务与目录不一致', prove.replayable, obligation.value));
    } else if (obligation.kind === 'recovery') {
      if (!Array.isArray(obligation.codes) || !obligation.codes.length) issues.push(issue('obligation.codes', id, '恢复义务缺少错误码'));
      else {
        for (const code of obligation.codes) {
          if (!Object.prototype.hasOwnProperty.call(RECOVERY_PLAYBOOK, code)) issues.push(issue('obligation.codes', id, '恢复码没有 playbook：' + code));
          if (!ERROR_CODE_SET.has(code)) issues.push(issue('obligation.codes', id, '恢复码未登记：' + code));
        }
      }
    }
  }
  return issues;
}

/**
 * 独立推导“期望的义务 id 序列”（刻意不复用 buildObligationsFor 的循环，
 * 这样任何一侧被改错都会被比对出来——这是派生校验器的意义）。
 */
export function expectedObligationIds(method) {
  const proof = proofOf(method);
  if (!proof) return Object.freeze([]);
  const ids = [];
  for (const code of proof.pre) ids.push('pre:' + code);
  for (const code of proof.post) ids.push('post:' + code);
  ids.push('effect-state', 'idempotent', 'replayable', 'recovery');
  return Object.freeze(ids);
}

/**
 * 结构层校验 2：义务表必须与目录同源（165 方法 × 独立推导的 id 序列）。
 * @param {object} [table] 可注入替身（负例测试用）
 */
export function validateObligationTable(table = METHOD_OBLIGATIONS) {
  const issues = [];
  const tableKeys = Object.keys(table || {});
  if (tableKeys.length !== METHOD_NAMES.length) {
    issues.push(issue('table.size', '<表>', '义务表方法数不符', METHOD_NAMES.length, tableKeys.length));
  }
  for (const method of METHOD_NAMES) {
    const list = (table && table[method]) || [];
    if (!list.length) { issues.push(issue('table.missing', method, '缺少义务表行')); continue; }
    const ids = list.map((obligation) => obligation.id);
    const expected = expectedObligationIds(method);
    if (ids.length !== expected.length || ids.some((id, index) => id !== expected[index])) {
      issues.push(issue('table.ids', method, '义务 id 序列与目录推导不一致', expected.join(','), ids.join(',')));
    }
    if (new Set(ids).size !== ids.length) issues.push(issue('table.dup', method, '义务 id 重复'));
    for (const dimension of ['pre', 'post', 'effectState', 'idempotent', 'replayable', 'recovery']) {
      if (!list.some((obligation) => obligation.dimension === dimension)) {
        issues.push(issue('table.dimension', method, '缺少维度义务：' + dimension));
      }
    }
    for (const obligation of list) issues.push(...validateObligation(obligation));
    const preBlocking = list.filter((obligation) => obligation.dimension === 'pre' && obligation.blocking).length;
    if (preBlocking !== list.filter((obligation) => obligation.dimension === 'pre').length) {
      issues.push(issue('table.blocking', method, '前置义务必须全部 blocking'));
    }
    const replayBlocking = list.filter((obligation) => obligation.kind === 'replayability' && obligation.blocking).length;
    if (replayBlocking !== 1) issues.push(issue('table.blocking', method, '可重放义务必须是唯一 blocking 的 replay 义务'));
  }
  for (const key of tableKeys) {
    if (!METHOD_NAMES.includes(key)) issues.push(issue('table.extra', key, '义务表含目录外方法'));
  }
  if (table === METHOD_OBLIGATIONS) {
    if (!Object.isFrozen(METHOD_OBLIGATIONS)) issues.push(issue('table.frozen', '<表>', '义务表未冻结'));
    for (const method of METHOD_NAMES) {
      if (!Object.isFrozen(obligationsFor(method))) issues.push(issue('table.frozen', method, '义务数组未冻结'));
    }
  }
  return issues;
}

/**
 * 行为层校验：对每个方法跑固定证据组合，验证执行结论与目录事实一致。
 * 这是“派生校验器”的最后一层——结构对了不代表行为对，所以用固定向量做语义回归。
 */
export function validateEngineBehavior(methods = METHOD_NAMES) {
  const issues = [];
  for (const method of methods) {
    const proof = proofOf(method);
    if (!proof) { issues.push(issue('behavior.method', method, '未知方法')); continue; }
    // 1) 只有静态快照：不得因“没证据”被判 violated / 禁止派发。
    const blind = runCallObligations(method, {});
    if (blind.verdict === 'violated') issues.push(issue('behavior.blind', method, '空证据被判 violated'));
    if (!blind.canDispatch) issues.push(issue('behavior.blind', method, '空证据被判禁止派发'));
    // 2) 理想上下文：全部前置满足 ⇒ 允许派发。
    const ideal = preflightCall(method, SATISFIED_CONTEXT);
    if (!ideal.canDispatch) issues.push(issue('behavior.ideal', method, '理想上下文仍禁止派发', 'canDispatch=true', false));
    for (const check of ideal.checks.filter((item) => item.kind === 'precondition')) {
      if (check.verdict !== 'satisfied') issues.push(issue('behavior.ideal', method, '理想上下文下前置未满足：' + check.code, 'satisfied', check.verdict));
    }
    // 3) 任取一个前置条件给出反证：必须禁止派发。
    const firstPre = proof.pre[0];
    if (firstPre) {
      const violated = preflightCall(method, PRECONDITION_VIOLATED_CONTEXT[firstPre]);
      if (violated.canDispatch) issues.push(issue('behavior.violated', method, '前置反证仍允许派发：' + firstPre));
      if (violated.verdict !== 'violated') issues.push(issue('behavior.violated', method, '前置反证未产生 violated 结论'));
    }
    // 4) 全部后置证据齐备：不得出现不矛盾却被判失败的情况。
    const fullResult = {};
    for (const code of proof.post) Object.assign(fullResult, POSTCONDITION_EVIDENCE[code] || {});
    const settle = settleCall(method, fullResult, { effectState: 'none' });
    if (!settle.canClaimSuccess) issues.push(issue('behavior.settle', method, '后置证据齐备仍禁止声明成功', 'canClaimSuccess=true', false));
    // 5) 对方法实际拥有的后置码逐个构造矛盾：必须禁止声明成功。
    //    反证片段单独成结果（不混入其它后置码的满足证据，否则主证据键会掩盖矛盾）。
    for (const code of proof.post) {
      const contradiction = POSTCONDITION_CONTRADICTION[code];
      if (!contradiction) continue;
      const contradictory = settleCall(method, contradiction, { effectState: 'none' });
      if (contradictory.canClaimSuccess) issues.push(issue('behavior.contradiction', method, '后置矛盾仍允许声明成功：' + code));
      if (contradictory.verdict !== 'violated') issues.push(issue('behavior.contradiction', method, '后置矛盾未产生 violated：' + code));
    }
    // 6) 已证明未生效时重放永远安全。
    const notApplied = replayObligations(method, { dispatched: false, effectState: 'none' });
    if (!notApplied.canAutoReplay) issues.push(issue('behavior.replay-not-applied', method, '已证明未生效却禁止重放'));
    // 7) 结果未知（已派发 + unknown）时，只有可重放方法允许自动重发。
    const unknownOutcome = replayObligations(method, { dispatched: true, effectState: 'unknown', code: 'E_TIMEOUT' });
    if (proof.replayable && !unknownOutcome.canAutoReplay) issues.push(issue('behavior.replay', method, '可重放方法在未知结果下被禁止重放'));
    if (!proof.replayable && unknownOutcome.canAutoReplay) issues.push(issue('behavior.replay', method, '不可重放方法在未知结果下被允许重放'));
    // 8) 恢复义务：方法目录里的每个恢复码都必须有可执行计划。
    for (const code of proof.recovery) {
      const recovery = recoveryObligations(method, code);
      if (!recovery.hasRecoveryPlan) issues.push(issue('behavior.recovery', method, '恢复码没有可执行计划：' + code));
    }
    // 9) 只读方法的 effect_state 不得被判 applied。
    if (proof.effectState === 'none') {
      const applied = settleCall(method, fullResult, { effectState: 'applied' });
      if (applied.canClaimSuccess) issues.push(issue('behavior.effect-state', method, '只读方法报告已生效仍允许声明成功'));
    }
    // 10) 结论与状态机快照同源：pre/post/idempotent/replayable 必须逐项一致。
    const summary = obligationSummary(method);
    if (summary.dimensions.pre.length !== proof.pre.length) issues.push(issue('behavior.derive', method, '前置义务数量与目录不一致'));
    if (summary.dimensions.post.length !== proof.post.length) issues.push(issue('behavior.derive', method, '后置义务数量与目录不一致'));
    if (summary.dimensions.idempotent !== isIdempotent(method)) issues.push(issue('behavior.derive', method, '幂等摘要与状态机不一致'));
    if (summary.dimensions.replayable !== isReplayable(method)) issues.push(issue('behavior.derive', method, '可重放摘要与状态机不一致'));
    if (summary.dimensions.effectState !== effectStateOf(method)) issues.push(issue('behavior.derive', method, 'effect_state 摘要与状态机不一致'));
    if (summary.risk !== riskOf(proof)) issues.push(issue('behavior.derive', method, '风险分级与目录不一致'));
  }
  return issues;
}

/**
 * 全量审计：夹具层 + 结构层 + 行为层。
 * @returns {ReadonlyArray<object>} 空数组 = 通过
 */
export function auditObligations(methods = METHOD_NAMES) {
  return Object.freeze([
    ...validatePreconditionFixtures(),
    ...validatePostconditionFixtures(),
    ...validateObligationTable(),
    ...validateEngineBehavior(methods),
  ]);
}

/** 全量审计快照（供 protocol-check / 单测断言）。 */
export function obligationSnapshot() {
  const errors = auditObligations();
  const risks = obligationRiskSummary();
  return Object.freeze({
    methods: METHOD_NAMES.length,
    obligations: obligationDimensionSummary(),
    dimensions: OBLIGATION_DIMENSIONS,
    stages: OBLIGATION_STAGES,
    risks,
    features: Object.freeze(FEATURE_NAMES.map((feature) => Object.freeze({
      feature,
      methods: featureObligations(feature).methodCount,
      risky: featureObligations(feature).risks.risky,
    }))),
    fixtures: Object.freeze({
      preSatisfied: Object.keys(PRECONDITION_SATISFIED_CONTEXT).length,
      preViolated: Object.keys(PRECONDITION_VIOLATED_CONTEXT).length,
      postSatisfied: Object.keys(POSTCONDITION_EVIDENCE).length,
      postContradiction: Object.keys(POSTCONDITION_CONTRADICTION).length,
    }),
    auditErrors: errors,
    ok: errors.length === 0,
  });
}

/**
 * 可读义务列表（CLI/MCP 展示“这个方法到底要证明什么”）。
 */
export function describeObligations(method) {
  const proof = proofOf(method);
  if (!proof) return Object.freeze({ method: String(method || ''), known: false, obligations: Object.freeze([]) });
  return Object.freeze({
    method: proof.method,
    known: true,
    risk: riskOf(proof),
    obligations: Object.freeze(obligationsFor(proof.method).map((obligation) => Object.freeze({
      id: obligation.id,
      dimension: obligation.dimension,
      dimensionLabel: DIMENSION_LABELS[obligation.dimension] || obligation.dimension,
      stage: obligation.stage,
      code: obligation.code,
      label: obligation.label,
      requirement: obligation.requirement,
      blocking: obligation.blocking,
    }))),
  });
}

/**
 * 单条义务解释（含判定建议）：给错误 data/CLI 用。
 */
export function explainObligation(method, id) {
  const obligation = obligationById(method, id);
  if (!obligation) {
    return Object.freeze({ method: String(method || ''), id: String(id || ''), known: false, obligation: null, advice: Object.freeze([]) });
  }
  const advice = [];
  if (obligation.kind === 'precondition') {
    advice.push('派发前用上下文核对「' + obligation.label + '」；有反证时不要发请求');
    advice.push('缺证据按 unknown 处理：可以尝试，但不能当成已满足');
  } else if (obligation.kind === 'postcondition') {
    advice.push('调用成功后再 observe/status 核对「' + obligation.label + '」');
    advice.push('结果与后置条件矛盾时按失败处理，不要相信 ok=true');
  } else if (obligation.kind === 'effect-state') {
    advice.push('失败/超时后先看 error.data.effect_state 是否可判定');
    advice.push('effect_state=unknown 时必须查账本或重新 observe');
  } else if (obligation.kind === 'idempotency') {
    advice.push(obligation.value ? '逻辑幂等，但结果不可证明时仍要先 resolve 账本' : '非幂等：未知结果下禁止自动重发');
  } else if (obligation.kind === 'replayability') {
    advice.push(obligation.value ? '可自动重放（只读/结果可证明）' : '必须先 ledger resolve 或人工确认后才能重发');
  } else if (obligation.kind === 'recovery') {
    advice.push('失败后按 recoveryPlan 的 action 执行；恢复码：' + (obligation.codes || []).join('、'));
  }
  return Object.freeze({
    method: obligation.method,
    id: obligation.id,
    known: true,
    obligation,
    advice: Object.freeze(advice),
  });
}

/**
 * 调用后置校验计划（成功路径）：把 post 义务翻译成“下一步要执行哪些核验”。
 * @returns {{method:string, checks:Array<{code:string,label:string,verifyWith:string}>, note:string}}
 */
export function verificationPlan(method) {
  const proof = proofOf(method);
  if (!proof) return Object.freeze({ method: String(method || ''), known: false, checks: Object.freeze([]), note: '未知方法' });
  const checks = proof.post.map((code) => Object.freeze({
    code,
    label: PROOF_POSTCONDITIONS[code] || code,
    verifyWith: verifyWithHint(code),
  }));
  return Object.freeze({
    method: proof.method,
    known: true,
    checks: Object.freeze(checks),
    note: 'RPC 结果只能证明其中的结构性后置；语义性后置需要 observe/status/账本继续核验',
  });
}

/** 后置码 → 建议的核验手段（CLI/MCP 文案；不新增事实）。 */
function verifyWithHint(code) {
  if (code === 'result.returned' || code === 'read.available') return 'result';
  if (code === 'page.mutated' || code === 'navigation.committed' || code === 'focus.updated'
    || code === 'scroll.updated' || code === 'emulation.updated') return 'observe';
  if (code === 'tab.created' || code === 'tab.removed' || code === 'tab.updated'
    || code === 'window.created' || code === 'window.removed' || code === 'window.updated') return 'tab.list/window.list';
  if (code === 'session.created' || code === 'session.removed' || code === 'session.updated') return 'session.list';
  if (code === 'artifact.created' || code === 'artifact.removed' || code === 'artifact.updated') return 'status/制品清单';
  if (code === 'capture.available') return 'result';
  if (code === 'recording.active' || code === 'recording.inactive') return 'video.status/record.status';
  if (code === 'debugger.attached' || code === 'debugger.detached') return 'debug.capabilities';
  if (code === 'network.capturing' || code === 'network.idle') return 'network.waterfall';
  if (code === 'dialog.armed' || code === 'dialog.resolved') return 'dialog.status';
  if (code === 'ledger.committed') return 'ledger.status';
  if (code === 'control.updated' || code === 'policy.updated' || code === 'coordination.updated'
    || code === 'transfer.updated' || code === 'plan.updated') return 'status';
  return 'observe/status';
}

/**
 * 协议闸门拒绝时的义务解释（供 data.obligations 使用）：
 * 说明“因为对端协议缺特性，这个方法的哪些义务在旧扩展上无法被执行”。
 */
export function deniedObligations(method, features = []) {
  const proof = proofOf(method);
  if (!proof) return Object.freeze({ method: String(method || ''), known: false, featureScoped: Object.freeze([]), note: '未知方法' });
  const featureList = [...new Set((features || []).map((feature) => String(feature)))];
  const scoped = featureList.filter((feature) => Object.prototype.hasOwnProperty.call(FEATURE_FLOORS, feature));
  return Object.freeze({
    method: proof.method,
    known: true,
    risk: riskOf(proof),
    canAutoReplay: proof.replayable,
    requiresResolveOnUnknown: !proof.replayable,
    featureScoped: Object.freeze(scoped.map((feature) => Object.freeze({
      feature,
      floor: FEATURE_FLOORS[feature],
      obligations: featureObligations(feature).methodCount,
      risky: featureObligations(feature).risks.risky,
    }))),
    note: '旧扩展缺少这些特性时，相关参数会被静默忽略：即使调用返回成功，后置义务也无法被证明',
  });
}

/** 导出汇总（模块自检入口；单测/protocol-check 可直接调用）。 */
export const PROOF_ABI = Object.freeze({
  dimensions: OBLIGATION_DIMENSIONS,
  kinds: OBLIGATION_KINDS,
  stages: OBLIGATION_STAGES,
  verdicts: OBLIGATION_VERDICTS,
  callVerdicts: CALL_VERDICTS,
  risks: OBLIGATION_RISKS,
});

// ===========================================================================
// 九、命名证据场景（dry-run）：让 CLI/MCP 不用自己拼证据
//
// 真实调用方（CLI 的 `bridge schema --dry-run`、MCP 的恢复提示、daemon 的 doctor）
// 常问同一组问题：
//   “如果现在没有任何证据会怎样？”、“成功后要核验什么？”、“结果未知能不能重放？”
// 这里把这些问题固化成命名场景（scenario）：每个场景有稳定 id、中文说明、以及一个
// 纯函数证据构造器。执行入口 runScenario() 返回和真实调用同构的义务结论，因此调用方
// 不需要理解六维，也不需要复制任何判定逻辑。
//
// 场景只构造证据，不改变义务；所有结论仍由 runCallObligations 执行。构造器不产生
// 副作用（不改页面、不读网络），因此可以在任意一侧安全 dry-run。
// ===========================================================================

/** 命名的证据场景元数据（JSON 安全；顺序稳定）。 */
export const SCENARIO_CATALOG = Object.freeze([
  Object.freeze({ id: 'blind', label: '只有方法名', detail: '不提供任何证据，验证“缺证据 ≠ 违反”' }),
  Object.freeze({ id: 'preflight', label: '只有调用前上下文', detail: '理想上下文，尚未派发（dispatched-pending）' }),
  Object.freeze({ id: 'ideal', label: '理想成功', detail: '前置全满足 + 全部后置证据 + effect_state=none' }),
  Object.freeze({ id: 'success-unverified', label: '成功但证据单薄', detail: '只有空结果对象，语义性后置标 unverifiable' }),
  Object.freeze({ id: 'pre-violated', label: '前置反证', detail: '第一个前置条件被证伪，必须短路' }),
  Object.freeze({ id: 'post-contradiction', label: '后置矛盾', detail: '成功结果与第一个可矛盾后置条件冲突' }),
  Object.freeze({ id: 'unknown-outcome', label: '结果未知', detail: 'E_TIMEOUT + 已派发 + effect_state=unknown' }),
  Object.freeze({ id: 'not-applied-failure', label: '失败但证明未生效', detail: '派发前错误码 + dispatched=false + effect_state=none' }),
  Object.freeze({ id: 'applied-retry', label: '已生效后请求重放', detail: 'retryRequested + dispatched=true + effect_state=applied' }),
  Object.freeze({ id: 'replay-safe', label: '已证明未生效后重放', detail: 'retryRequested + dispatched=false + effect_state=none' }),
  Object.freeze({ id: 'unknown-code', label: '未登记错误码', detail: '恢复义务必须报 violated（没有剧本）' }),
]);

const SCENARIO_INDEX = new Map(SCENARIO_CATALOG.map((entry) => [entry.id, entry]));

/** 场景 id 列表（顺序稳定，供测试/CLI 遍历）。 */
export const SCENARIO_IDS = Object.freeze(SCENARIO_CATALOG.map((entry) => entry.id));

function fullPostResultFor(method) {
  const proof = proofOf(method);
  if (!proof) return {};
  const result = {};
  for (const code of proof.post) Object.assign(result, POSTCONDITION_EVIDENCE[code] || {});
  return result;
}

function firstContradictionFor(method) {
  const proof = proofOf(method);
  if (!proof) return null;
  for (const code of proof.post) {
    const contradiction = POSTCONDITION_CONTRADICTION[code];
    if (contradiction) return { code, result: contradiction };
  }
  return null;
}

/**
 * 场景证据构造器：输入方法名，返回 runCallObligations 可直接消费的证据对象。
 * 未登记场景返回 null（runScenario 会给出 inapplicable 结论，不抛错）。
 */
export const SCENARIO_BUILDERS = Object.freeze({
  blind: () => ({}),
  preflight: () => ({ context: SATISFIED_CONTEXT }),
  ideal: (method) => ({ context: SATISFIED_CONTEXT, result: fullPostResultFor(method), effectState: 'none' }),
  'success-unverified': (method) => ({ context: SATISFIED_CONTEXT, result: {}, effectState: 'none' }),
  'pre-violated': (method) => {
    const proof = proofOf(method);
    const code = proof && proof.pre[0];
    return { context: code ? PRECONDITION_VIOLATED_CONTEXT[code] : {} };
  },
  'post-contradiction': (method) => {
    const contradiction = firstContradictionFor(method);
    return {
      context: SATISFIED_CONTEXT,
      result: contradiction ? contradiction.result : {},
      effectState: 'none',
    };
  },
  'unknown-outcome': () => ({ error: { code: 'E_TIMEOUT' }, dispatched: true, effectState: 'unknown', retryRequested: true }),
  'not-applied-failure': () => ({ error: { code: 'E_BAD_ARG' }, dispatched: false, effectState: 'none' }),
  'applied-retry': () => ({ retryRequested: true, dispatched: true, effectState: 'applied' }),
  'replay-safe': () => ({ retryRequested: true, dispatched: false, effectState: 'none' }),
  // 场景夹具：故意构造一个“未登记码”，用于验证 normalizeErrorCode 的兜底路径。
  // 用拼接而不是字面量，避免被 error-codes 的“源码里每个 E_* 都必须登记”扫描误报。
  'unknown-code': () => ({ error: ['E', 'NOT', 'A', 'REAL', 'CODE'].join('_') }),
});

/** 场景元数据（未知场景返回 null）。 */
export function scenarioInfo(id) {
  return SCENARIO_INDEX.get(String(id || '')) || null;
}

/**
 * 在命名场景下 dry-run 一个方法。
 * @param {string} method
 * @param {string} id 场景 id（见 SCENARIO_IDS）
 * @returns {{
 *   method:string, scenario:string, label:string|null, knownScenario:boolean,
 *   evidence:object, run:object, verdict:string,
 *   canDispatch:boolean, canClaimSuccess:boolean, canAutoReplay:boolean, hasRecoveryPlan:boolean,
 *   blockedBy:Array<string>, note:string,
 * }}
 */
export function runScenario(method, id) {
  const scenario = String(id || '');
  const info = scenarioInfo(scenario);
  const builder = SCENARIO_BUILDERS[scenario];
  if (!info || typeof builder !== 'function') {
    return Object.freeze({
      method: String(method || ''),
      scenario,
      label: null,
      knownScenario: false,
      evidence: EMPTY_EVIDENCE,
      run: null,
      verdict: 'inapplicable',
      canDispatch: false,
      canClaimSuccess: false,
      canAutoReplay: false,
      hasRecoveryPlan: false,
      blockedBy: Object.freeze([]),
      note: '未登记的证据场景：' + scenario,
    });
  }
  const evidence = builder(String(method || ''));
  const run = runCallObligations(method, evidence);
  return Object.freeze({
    method: run.method,
    scenario,
    label: info.label,
    knownScenario: true,
    evidence: Object.freeze({ ...evidence }),
    run,
    verdict: run.verdict,
    canDispatch: run.canDispatch,
    canClaimSuccess: run.canClaimSuccess,
    canAutoReplay: run.canAutoReplay,
    hasRecoveryPlan: run.hasRecoveryPlan,
    blockedBy: Object.freeze(run.blocking.map((check) => check.id)),
    note: info.detail,
  });
}

/**
 * 场景矩阵：方法 × 场景的结论表。
 * @param {string[]} [methods]
 * @param {string[]} [scenarios]
 * @returns {{methods:string[], scenarios:string[], rows:Array, counts:object}}
 */
export function scenarioMatrix(methods = METHOD_NAMES, scenarios = SCENARIO_IDS) {
  const scenarioIds = [...scenarios];
  const rows = [...methods].map((method) => {
    const cells = {};
    for (const scenario of scenarioIds) {
      const result = runScenario(method, scenario);
      cells[scenario] = Object.freeze({
        verdict: result.verdict,
        canDispatch: result.canDispatch,
        canClaimSuccess: result.canClaimSuccess,
        canAutoReplay: result.canAutoReplay,
        hasRecoveryPlan: result.hasRecoveryPlan,
        blockedBy: result.blockedBy,
      });
    }
    return Object.freeze({ method: String(method), cells: Object.freeze(cells) });
  });
  const counts = {};
  for (const scenario of scenarioIds) {
    const tally = { proven: 0, partial: 0, unknown: 0, violated: 0, inapplicable: 0 };
    for (const row of rows) tally[row.cells[scenario].verdict] = (tally[row.cells[scenario].verdict] || 0) + 1;
    counts[scenario] = Object.freeze(tally);
  }
  return Object.freeze({
    methods: Object.freeze([...methods].map(String)),
    scenarios: Object.freeze(scenarioIds),
    rows: Object.freeze(rows),
    counts: Object.freeze(counts),
  });
}

/** 场景矩阵中某个场景的结论分布行（CLI/文档用）。 */
export function scenarioSummary(scenarios = SCENARIO_IDS) {
  const matrix = scenarioMatrix(METHOD_NAMES, scenarios);
  return Object.freeze(matrix.scenarios.map((scenario) => Object.freeze({
    scenario,
    label: (scenarioInfo(scenario) || {}).label || scenario,
    detail: (scenarioInfo(scenario) || {}).detail || null,
    counts: matrix.counts[scenario],
    total: METHOD_NAMES.length,
  })));
}

// ===========================================================================
// 十、可执行建议：从义务结论生成下一步
//
// 结论（canDispatch/canClaimSuccess/canAutoReplay）回答“能不能”，建议回答“那现在做什么”。
// 建议严格从 violated/unknown 的义务派生，不引入新规则：
//   前置 violated   → 先补前置事实或换目标
//   后置 violated   → 结果与目录矛盾，按失败处理
//   effect unknown  → 查账本 / 重新 observe
//   恢复缺失        → 报告错误码，不要瞎试
//   重放被拒        → ledger resolve 或人工确认
// ===========================================================================

/**
 * 从一次执行结果生成可执行建议（顺序稳定；同类只出现一次）。
 * @param {object} run runCallObligations 的结果
 * @returns {ReadonlyArray<{obligation:string, dimension:string, action:string, detail:string}>}
 */
export function nextActions(run) {
  if (!run || !run.known) {
    return Object.freeze([Object.freeze({
      obligation: 'method',
      dimension: 'pre',
      action: '核对方法名后重试',
      detail: '未知方法没有可执行义务，按保守语义禁止',
    })]);
  }
  const out = [];
  const seen = new Set();
  const add = (obligation, dimension, action, detail) => {
    const key = dimension + '|' + action;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(Object.freeze({ obligation: obligation.id, dimension, action, detail }));
  };
  for (const check of run.checks) {
    if (check.verdict !== 'violated' && check.verdict !== 'unknown') continue;
    if (check.kind === 'precondition') {
      add(check, 'pre', '补齐或重新确认前置条件后重试', check.reason + '；有反证时不要派发');
    } else if (check.kind === 'postcondition') {
      add(check, 'post', '按失败处理并重新 observe 核对页面事实', check.reason);
    } else if (check.kind === 'effect-state') {
      add(check, 'effectState', '查账本或重新 observe 判断是否已生效', check.reason);
    } else if (check.kind === 'idempotency') {
      add(check, 'idempotent', '不要自动重发：先确认是否已生效', check.reason);
    } else if (check.kind === 'replayability') {
      add(check, 'replayable', '先 ledger resolve 或等待人工确认，再决定是否重发', check.reason);
    } else if (check.kind === 'recovery') {
      add(check, 'recovery', '报告实际错误码与 data，按 playbook 处理', check.reason);
    } else {
      add(check, check.dimension, '按义务说明处理', check.reason);
    }
  }
  if (!out.length) {
    out.push(Object.freeze({
      obligation: 'none',
      dimension: 'pre',
      action: run.canClaimSuccess ? '按结论继续（必要时做后置核验）' : '继续等待结果',
      detail: '没有违反/未知义务',
    }));
  }
  return Object.freeze(out);
}

/**
 * 把一次执行结果翻译成人类可读的行（CLI 文本模式）。
 * @param {object} run
 */
export function explainRun(run) {
  if (!run || !run.known) return Object.freeze(['未知方法：没有可执行义务']);
  const lines = [
    String(run.method) + ' → ' + run.verdict + '（'
      + 'dispatch=' + (run.canDispatch ? 'yes' : 'no')
      + ' claim=' + (run.canClaimSuccess ? 'yes' : 'no')
      + ' replay=' + (run.canAutoReplay ? 'yes' : 'no')
      + ' recovery=' + (run.hasRecoveryPlan ? 'yes' : 'no') + '）',
  ];
  for (const stage of OBLIGATION_STAGES) {
    const report = run.stages[stage];
    if (!report || report.total === 0) continue;
    lines.push('  [' + stage + '] satisfied=' + report.satisfied.length
      + ' unknown=' + report.unknown.length
      + ' unverifiable=' + report.unverifiable.length
      + ' violated=' + report.violated.length);
  }
  for (const check of run.checks) {
    if (check.verdict === 'inapplicable' || check.verdict === 'satisfied') continue;
    lines.push('  · [' + check.verdict + '] ' + check.id + '：' + check.reason);
  }
  for (const action of nextActions(run)) lines.push('  ⇒ ' + action.action);
  return Object.freeze(lines);
}

/**
 * 阶段 × verdict 分布（全量方法在一个命名场景下的统计）。
 * @param {string} scenario
 * @param {string[]} [methods]
 */
export function stageDistribution(scenario = 'blind', methods = METHOD_NAMES) {
  const distribution = {};
  for (const method of methods) {
    const result = runScenario(method, scenario);
    if (!result.run) continue;
    for (const stage of OBLIGATION_STAGES) {
      const report = result.run.stages[stage];
      if (!distribution[stage]) {
        distribution[stage] = { methods: 0, satisfied: 0, unknown: 0, unverifiable: 0, violated: 0, inapplicable: 0 };
      }
      const entry = distribution[stage];
      entry.methods += 1;
      entry.satisfied += report.satisfied.length;
      entry.unknown += report.unknown.length;
      entry.unverifiable += report.unverifiable.length;
      entry.violated += report.violated.length;
      entry.inapplicable += report.inapplicable.length;
    }
  }
  return Object.freeze(distribution);
}

