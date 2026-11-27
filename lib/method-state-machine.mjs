// lib/method-state-machine.mjs —— 方法状态机的“可证明性运行时”。
//
// 单一源仍是 lib/method-catalog.mjs：本文件不声明任何方法名/前置条件/错误码，
// 只做四件事（全部是纯函数，便于 CLI/MCP/daemon 在任何一侧复用，也便于单测穷举）：
//
//   1) 前置条件判定：checkPreconditions(method, context)
//      把目录里的 pre 码翻译成 satisfied / violated / unknown 三态。
//      “unknown” 与 “violated” 严格区分：缺证据不等于条件不成立，不能当成拒绝理由。
//   2) 后置条件核验：verifyPostconditions(method, result)
//      把目录里的 post 码翻译成 satisfied / violated / unverifiable。
//      RPC 结果只能证明其中一部分（例如结果里有 tabId 才能证明 tab.created），
//      证明不了的必须诚实标 unverifiable，不能伪装成功。
//   3) 幂等/重放判定：isIdempotent / isReplayable / replayDecision
//      区分“逻辑幂等”和“结果可证明”：前者是语义事实，后者才决定 UNKNOWN 后能否自动重发。
//      与意图账本的 NON_IDEMPOTENT/effect_state 口径一致（tests/unit/state-recovery.test.mjs 交叉校验）。
//   4) 错误恢复计划：recoveryPlan / recoveryForError
//      把错误码 + 方法恢复族 + 本次 effect_state 组合成可执行计划（重试几次、是否需要人、
//      是否必须先 ledger resolve、下一步具体命令）。
//
// 运行时消费链（file:line 见交付报告）：
//   lib/protocol-features.mjs 的协议闸门在拒绝时附带 proof + recoveryPlan，
//   daemon/server.mjs:1375 requireFeatures → :1386 BridgeError(data) → CLI/MCP error.data；
//   daemon/health.js:37/41 的 featureMatrix 快照把特性可用性与降级建议带进 daemon 状态。
//
// 默认语义不变：本模块是纯增量。它不参与 dispatch、不改变任何既有错误码，
// 也不改写 METHOD_STATE（生成物五维保持原样），只提供新的只读判定。

import {
  METHOD_CATALOG,
  METHOD_EFFECT_STATE,
  METHOD_IDEMPOTENT,
  METHOD_NAMES,
  METHOD_PROOF,
  METHOD_RECOVERY,
  METHOD_REPLAYABLE,
  PROOF_EFFECT_STATES,
  PROOF_POSTCONDITIONS,
  PROOF_PRECONDITIONS,
  PROOF_RECOVERY_ACTIONS,
  PROOF_RULES,
  RECOVERY_PLAYBOOK,
  RECOVERY_PROFILES,
  isUnknownOutcomeCode,
  proofOf,
  validateMethodProofs,
} from './method-catalog.mjs';
import { ERROR_CODE_SET, ERROR_RECOVERY } from './error-codes.mjs';

/** 状态机六个可证明性维度（顺序稳定，供报告/文档/测试遍历）。 */
export const PROOF_DIMENSIONS = Object.freeze(['pre', 'post', 'effectState', 'idempotent', 'replayable', 'recovery']);
/** 前置/后置判定三态。 */
export const CHECK_STATES = Object.freeze(['satisfied', 'violated', 'unknown']);
/** 后置核验允许 unverifiable（真值不可从 RPC 结果证明）。 */
export const VERIFY_STATES = Object.freeze(['satisfied', 'violated', 'unverifiable']);
/** 恢复计划严重度。 */
export const RECOVERY_SEVERITIES = Object.freeze(['recoverable', 'needs-user', 'fatal']);
/** 账本 effect_state 口径：none=可证明未生效；unknown=不可证明；applied=已生效。 */
export const EFFECT_OUTCOME_STATES = Object.freeze(['none', 'unknown', 'applied']);

// 目录常量再导出：消费方只 import 一个模块即可拿到六面事实（仍然只有一份源）。
export const PRECONDITIONS = PROOF_PRECONDITIONS;
export const POSTCONDITIONS = PROOF_POSTCONDITIONS;
export const EFFECT_STATES = PROOF_EFFECT_STATES;
export const RECOVERY_ACTIONS = PROOF_RECOVERY_ACTIONS;
export const RECOVERY = RECOVERY_PLAYBOOK;
export const RECOVERY_GROUPS = RECOVERY_PROFILES;
export const PROOF_FAMILIES = PROOF_RULES;

// ---------------------------------------------------------------------------
// 调用上下文
//
// 调用侧只需要传它真正知道的字段；缺字段一律按 unknown 处理。normalizeContext
// 接受两种形态（都常见）：
//   - 直接事实：{ sessionActive:true, tabId:7, target:{ref:'@e1'}, recording:true }
//   - 领域对象：{ session:{active:true, paused:false, tabId:7}, params:{ref:'@e1'} }
// ---------------------------------------------------------------------------

function own(object, key) {
  return Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);
}

function firstDefined(...values) {
  for (const value of values) if (value !== undefined) return value;
  return undefined;
}

function hasTarget(value) {
  if (value === true) return true;
  if (value === false || value == null) return false;
  if (typeof value !== 'object') return Boolean(value);
  return value.ref != null || value.selector != null || value.x != null || value.y != null || value.point != null;
}

/**
 * 把任意形状的上下文归一化成显式事实表。
 * 每个事实都是 true/false/undefined 三态；undefined 表示调用侧没有提供证据。
 */
export function normalizeContext(context = {}) {
  const ctx = context && typeof context === 'object' ? context : {};
  const session = ctx.session && typeof ctx.session === 'object' ? ctx.session : null;
  const params = ctx.params && typeof ctx.params === 'object' ? ctx.params : {};
  const facts = {
    daemon: firstDefined(ctx.daemon, ctx.daemonRunning),
    instanceConnected: firstDefined(ctx.instanceConnected, ctx.connected, ctx.instance ? true : undefined),
    browserReady: firstDefined(ctx.browserReady, ctx.canOpenTab),
    sessionActive: firstDefined(ctx.sessionActive, session ? session.active !== false && session.stopped !== true : undefined),
    sessionUnpaused: firstDefined(ctx.sessionUnpaused, session ? session.paused !== true : undefined),
    tabBound: firstDefined(ctx.tabBound,
      own(ctx, 'tabId') ? (ctx.tabId !== undefined && ctx.tabId !== null) : undefined,
      session && own(session, 'tabId') ? session.tabId !== undefined && session.tabId !== null : undefined),
    controlHeld: firstDefined(ctx.controlHeld, ctx.control ? (ctx.control.held !== false) : undefined),
    target: firstDefined(ctx.target, hasTarget(params) ? params : undefined),
    observationFresh: firstDefined(ctx.observationFresh, ctx.fresh),
    recording: firstDefined(ctx.recording, ctx.recordingActive),
    debuggerIdle: firstDefined(ctx.debuggerIdle, ctx.debuggerFree),
    dialogPending: firstDefined(ctx.dialogPending, ctx.dialog),
    transferOpen: firstDefined(ctx.transferOpen, ctx.transfer ? ctx.transfer.open !== false : undefined),
    networkCapturing: firstDefined(ctx.networkCapturing, ctx.capturing),
    traceActive: firstDefined(ctx.traceActive, ctx.tracing),
    planApproved: firstDefined(ctx.planApproved, ctx.approvedPlan),
    pairAvailable: firstDefined(ctx.pairAvailable, ctx.pairing ? ctx.pairing.available !== false : undefined),
    artifactPresent: firstDefined(ctx.artifactPresent, ctx.artifact ? true : undefined),
    cooperationAligned: firstDefined(ctx.cooperationAligned, ctx.cooperation ? ctx.cooperation.aligned !== false : undefined),
    uiAttached: firstDefined(ctx.uiAttached, ctx.ui ? ctx.ui.attached !== false : undefined),
    transportLocal: firstDefined(ctx.transportLocal, ctx.remote === true ? false : ctx.remote === false ? true : undefined),
  };
  return Object.freeze(facts);
}

function tri(value) {
  return value === true ? 'satisfied' : value === false ? 'violated' : 'unknown';
}

/**
 * 前置条件判定器：code → (facts) → 'satisfied' | 'violated' | 'unknown'。
 * 每个判定只读事实表；不产生副作用、不访问文件/网络。
 */
const PRECONDITION_TESTS = Object.freeze({
  'daemon.local': (facts) => (facts.daemon === false ? 'violated' : 'satisfied'),
  'instance.connected': (facts) => tri(facts.instanceConnected),
  'browser.ready': (facts) => tri(facts.browserReady),
  'session.active': (facts) => tri(facts.sessionActive),
  'session.unpaused': (facts) => tri(facts.sessionUnpaused),
  'tab.bound': (facts) => tri(facts.tabBound),
  'tab.controlled': (facts) => tri(facts.controlHeld),
  'target.resolved': (facts) => (facts.target === undefined ? 'unknown' : hasTarget(facts.target) ? 'satisfied' : 'violated'),
  'observation.fresh': (facts) => tri(facts.observationFresh),
  'recording.active': (facts) => tri(facts.recording),
  'debugger.idle': (facts) => tri(facts.debuggerIdle),
  'dialog.pending': (facts) => tri(facts.dialogPending),
  'transfer.open': (facts) => tri(facts.transferOpen),
  'network.capturing': (facts) => tri(facts.networkCapturing),
  'trace.active': (facts) => tri(facts.traceActive),
  'plan.approved': (facts) => tri(facts.planApproved),
  'pair.available': (facts) => tri(facts.pairAvailable),
  'artifact.present': (facts) => tri(facts.artifactPresent),
  'cooperation.aligned': (facts) => tri(facts.cooperationAligned),
  'ui.attached': (facts) => tri(facts.uiAttached),
  'transport.local': (facts) => tri(facts.transportLocal),
});

/** 单个前置条件码的判定（未知码返回 unknown 并带 reason）。 */
export function checkPrecondition(code, context = {}) {
  const key = String(code || '');
  const facts = context && context.__facts ? context.__facts : normalizeContext(context);
  const test = PRECONDITION_TESTS[key];
  const label = PRECONDITIONS[key] || key;
  if (!test) return Object.freeze({ code: key, label, state: 'unknown', reason: '未登记的前置条件码' });
  const state = test(facts);
  return Object.freeze({
    code: key,
    label,
    state,
    reason: state === 'satisfied' ? '满足' : state === 'violated' ? '不满足：调用方提供了反证' : 'unknown：调用方没有提供该事实',
  });
}

/**
 * 判定一个方法调用的全部前置条件。
 * @returns {{method:string, ok:boolean, proven:boolean, checks:Array, violations:string[], unknowns:string[], pre:string[]}}
 *   ok       = 没有 violated（可以继续尝试；unknown 交给服务端兜底）
 *   proven   = 没有 violated 也没有 unknown（本地已证明全部前置成立）
 */
export function checkPreconditions(method, context = {}) {
  const proof = proofOf(method);
  if (!proof) return Object.freeze({ method: String(method || ''), known: false, ok: false, proven: false, checks: Object.freeze([]), violations: Object.freeze([]), unknowns: Object.freeze([]), pre: Object.freeze([]) });
  const facts = normalizeContext(context);
  const checks = proof.pre.map((code) => checkPrecondition(code, { __facts: facts }));
  const violations = checks.filter((item) => item.state === 'violated').map((item) => item.code);
  const unknowns = checks.filter((item) => item.state === 'unknown').map((item) => item.code);
  return Object.freeze({
    method: proof.method,
    known: true,
    ok: violations.length === 0,
    proven: violations.length === 0 && unknowns.length === 0,
    checks: Object.freeze(checks),
    violations: Object.freeze(violations),
    unknowns: Object.freeze(unknowns),
    pre: proof.pre,
  });
}

// ---------------------------------------------------------------------------
// 后置条件核验
//
// 后置条件分两类：
//   - 结构性：RPC 结果里一定有证据（result.returned / tab.created / session.created ...）
//   - 语义性：结果是“页面/窗口变了”这类事实，单看 RPC 返回值证明不了（page.mutated ...）
// 对语义性后置条件必须返回 unverifiable，而不是把“没写证据”判成失败/成功。
// ---------------------------------------------------------------------------

function hasKeys(value) {
  return Boolean(value) && typeof value === 'object' && Object.keys(value).length > 0;
}

function explicit(value, ...keys) {
  if (!value || typeof value !== 'object') return undefined;
  for (const key of keys) if (own(value, key)) return value[key];
  return undefined;
}

function boolFrom(value) {
  if (value === undefined) return 'unverifiable';
  if (value === false) return 'violated';
  if (value === true) return 'satisfied';
  // 非布尔但存在的证据（路径/句柄/坐标/字节数）同样能证明事实成立。
  if (value == null) return 'unverifiable';
  return 'satisfied';
}

/** 单个后置条件码核验。 */
export function verifyPostcondition(code, result) {
  const key = String(code || '');
  const label = POSTCONDITIONS[key] || key;
  let state = 'unverifiable';
  let reason = '该事实无法只从 RPC 结果证明（需要 observe/账本/状态查询）';
  switch (key) {
    case 'result.returned':
      state = result === undefined ? 'unverifiable' : 'satisfied';
      reason = state === 'satisfied' ? '方法返回了结果对象' : '方法没有返回值，无法证明';
      break;
    case 'read.available':
      state = Array.isArray(result) || hasKeys(result) ? 'satisfied' : 'unverifiable';
      reason = state === 'satisfied' ? '结果含只读数据' : '结果为空，无法证明数据可取';
      break;
    case 'tab.created':
      state = boolFrom(explicit(result, 'tabId') != null ? true : explicit(result, 'created'));
      reason = state === 'satisfied' ? '结果带新 tabId' : '结果没有 tabId';
      break;
    case 'tab.removed':
      state = boolFrom(explicit(result, 'removed', 'closed'));
      break;
    case 'tab.updated':
      state = boolFrom(explicit(result, 'updated', 'tabId') != null ? true : explicit(result, 'updated'));
      break;
    case 'session.created':
      state = boolFrom(explicit(result, 'sessionId') != null ? true : explicit(result, 'created'));
      reason = state === 'satisfied' ? '结果带 sessionId' : '结果没有 sessionId';
      break;
    case 'session.removed':
      state = boolFrom(explicit(result, 'stopped', 'removed', 'closed'));
      break;
    case 'session.updated':
      state = boolFrom(explicit(result, 'updated') !== undefined ? explicit(result, 'updated') : (explicit(result, 'sessionId') != null ? true : undefined));
      break;
    case 'window.created':
    case 'window.removed':
    case 'window.updated':
      state = boolFrom(explicit(result, 'windowId') != null ? true : explicit(result, 'created', 'removed', 'updated'));
      break;
    case 'artifact.created':
      state = boolFrom(explicit(result, 'path', 'file', 'saved', 'artifact'));
      reason = state === 'satisfied' ? '结果带制品路径/句柄' : '结果没有制品证据';
      break;
    case 'artifact.updated':
      state = boolFrom(explicit(result, 'path', 'file', 'updated', 'state') != null ? true : explicit(result, 'updated'));
      break;
    case 'artifact.removed':
      state = boolFrom(explicit(result, 'removed', 'deleted', 'pruned'));
      break;
    case 'capture.available':
      state = boolFrom(explicit(result, 'image', 'dataUrl', 'base64', 'bytes', 'screenshot', 'captureId') != null ? true : explicit(result, 'captured'));
      reason = state === 'satisfied' ? '结果带截图数据/句柄' : '结果没有截图证据';
      break;
    case 'recording.active':
      state = boolFrom(explicit(result, 'recording') !== undefined ? explicit(result, 'recording') : (explicit(result, 'videoId', 'recordingId') != null ? true : undefined));
      break;
    case 'recording.inactive':
      // 停止录制：显式 stopped/closed 优先；其次看 recording 是否已为 false。
      state = boolFrom(explicit(result, 'stopped', 'closed') !== undefined
        ? explicit(result, 'stopped', 'closed')
        : explicit(result, 'recording') === false ? true : undefined);
      break;
    case 'debugger.attached':
      state = boolFrom(explicit(result, 'attached', 'debugger'));
      break;
    case 'debugger.detached':
      state = boolFrom(explicit(result, 'detached') !== undefined ? explicit(result, 'detached') : (explicit(result, 'attached') === false ? true : undefined));
      break;
    case 'network.capturing':
      state = boolFrom(explicit(result, 'capturing') !== undefined ? explicit(result, 'capturing') : explicit(result, 'started'));
      break;
    case 'network.idle':
      state = boolFrom(explicit(result, 'capturing') === false ? true : explicit(result, 'stopped'));
      break;
    case 'dialog.armed':
      state = boolFrom(explicit(result, 'armed'));
      break;
    case 'dialog.resolved':
      state = boolFrom(explicit(result, 'accepted', 'dismissed', 'handled'));
      break;
    case 'ledger.committed':
      state = boolFrom(explicit(result, 'committed') !== undefined ? explicit(result, 'committed') : (explicit(result, 'ok', 'receipt') === true ? true : undefined));
      break;
    case 'control.updated':
    case 'policy.updated':
    case 'coordination.updated':
    case 'transfer.updated':
    case 'plan.updated':
    case 'scroll.updated':
    case 'emulation.updated':
    case 'focus.updated':
    case 'page.mutated':
    case 'navigation.committed':
      // 这些要么由状态查询证明，要么由 result 显式带证据；否则诚实标 unverifiable。
      state = boolFrom(explicit(result, 'updated', 'changed', 'committed', 'focused', 'emulated', 'scrollY', 'scrollX', 'state', 'mode', 'planId'));
      reason = state === 'unverifiable' ? '该事实需要 observe/status 查询或显式证据，RPC 结果不足以证明' : reason;
      break;
    default:
      state = 'unverifiable';
      reason = '未登记的后置条件码';
  }
  return Object.freeze({ code: key, label, state, reason });
}

/**
 * 核验一个方法调用的全部后置条件。
 * @returns {{method, known, ok, proven, checks, satisfied, violated, unverifiable, post}}
 *   ok       = 没有 violated（结果没有和目录矛盾）
 *   proven   = 没有 violated 也没有 unverifiable（本结果能证明全部后置）
 */
export function verifyPostconditions(method, result) {
  const proof = proofOf(method);
  if (!proof) return Object.freeze({ method: String(method || ''), known: false, ok: false, proven: false, checks: Object.freeze([]), satisfied: Object.freeze([]), violated: Object.freeze([]), unverifiable: Object.freeze([]), post: Object.freeze([]) });
  const checks = proof.post.map((code) => verifyPostcondition(code, result));
  const pick = (state) => checks.filter((item) => item.state === state).map((item) => item.code);
  const satisfied = pick('satisfied');
  const violated = pick('violated');
  const unverifiable = pick('unverifiable');
  return Object.freeze({
    method: proof.method,
    known: true,
    ok: violated.length === 0,
    proven: violated.length === 0 && unverifiable.length === 0,
    checks: Object.freeze(checks),
    satisfied: Object.freeze(satisfied),
    violated: Object.freeze(violated),
    unverifiable: Object.freeze(unverifiable),
    post: proof.post,
  });
}

// ---------------------------------------------------------------------------
// effect_state / 幂等 / 可重放
// ---------------------------------------------------------------------------

/** 方法的 effect_state 分类；未知方法返回 null。 */
export function effectStateOf(method) {
  return METHOD_EFFECT_STATE[String(method || '')] || null;
}

/** 解释 effect_state 码。 */
export function describeEffectState(code) {
  const key = String(code || '');
  return Object.freeze({ code: key, label: EFFECT_STATES[key] || null, known: Object.prototype.hasOwnProperty.call(EFFECT_STATES, key) });
}

/** 逻辑幂等：同方法同参数重复执行后最终状态不变；未知方法返回 false。 */
export function isIdempotent(method) {
  return METHOD_IDEMPOTENT[String(method || '')] === true;
}

/** 可重放：UNKNOWN 后能否不经人工判断直接重发；未知方法返回 false（保守）。 */
export function isReplayable(method) {
  return METHOD_REPLAYABLE[String(method || '')] === true;
}

/**
 * UNKNOWN（或任意失败）之后是否允许自动重发。
 * 判定顺序：
 *   1) 只读/可证明方法（replayable）→ 允许；
 *   2) 错误已证明未生效（effect_state=none / dispatched=false / 错误码本身是派发前错误）→ 允许；
 *   3) 其余 → 拒绝，交由账本/人工 resolve（保守：宁可少重放，不能二次提交）。
 * @param {string} method
 * @param {{effectState?:string, dispatched?:boolean, code?:string}} [options]
 */
export function replayDecision(method, options = {}) {
  const name = String(method || '');
  const proof = proofOf(name);
  if (!proof) return Object.freeze({ method: name, known: false, allowed: false, reason: '未知方法，禁止自动重放', action: 'abort-no-retry' });
  const effectState = options.effectState;
  const dispatched = options.dispatched;
  const code = options.code ? String(options.code) : '';
  const codeProvesNoEffect = Boolean(code) && !isUnknownOutcomeCode(code);
  const notApplied = effectState === 'none' || dispatched === false || codeProvesNoEffect;
  if (proof.replayable) {
    return Object.freeze({
      method: name, known: true, allowed: true, reason: '只读/结果可证明方法，可安全重放',
      requiresResolve: false, action: 'wait-and-retry', idempotent: proof.idempotent,
    });
  }
  if (notApplied) {
    return Object.freeze({
      method: name, known: true, allowed: true,
      reason: codeProvesNoEffect
        ? '错误码是派发前/校验阶段错误（' + code + '），可证明未生效'
        : '错误已证明未生效（effect_state=none/dispatched=false），重放不会产生第二次副作用',
      requiresResolve: false, action: 'wait-and-retry', idempotent: proof.idempotent,
    });
  }
  return Object.freeze({
    method: name,
    known: true,
    allowed: false,
    reason: proof.idempotent
      ? '方法逻辑幂等，但结果不可证明；账本口径仍要求先 resolve 再决定是否重放'
      : '非幂等且结果不可证明；重放可能产生第二次真实副作用（双击/重复提交/重复上传）',
    requiresResolve: true,
    action: 'resolve-ledger',
    idempotent: proof.idempotent,
  });
}

/** effect_state 汇总：每个分类多少方法（status/诊断展示用）。 */
export function effectStateSummary() {
  const counts = {};
  for (const row of METHOD_CATALOG) {
    const state = METHOD_EFFECT_STATE[row.method];
    counts[state] = (counts[state] || 0) + 1;
  }
  return Object.freeze({ total: METHOD_CATALOG.length, counts: Object.freeze(counts), states: Object.freeze([...Object.keys(EFFECT_STATES)]) });
}

/** 幂等/可重放汇总（供测试与文档断言，不写第二份表）。 */
export function replaySummary() {
  const idempotent = METHOD_CATALOG.filter((row) => METHOD_IDEMPOTENT[row.method]);
  const replayable = METHOD_CATALOG.filter((row) => METHOD_REPLAYABLE[row.method]);
  const mutatingIdempotent = idempotent.filter((row) => row.unknown);
  return Object.freeze({
    total: METHOD_CATALOG.length,
    idempotent: Object.freeze(idempotent.map((row) => row.method)),
    replayable: Object.freeze(replayable.map((row) => row.method)),
    notReplayable: Object.freeze(METHOD_CATALOG.filter((row) => !METHOD_REPLAYABLE[row.method]).map((row) => row.method)),
    mutatingIdempotent: Object.freeze(mutatingIdempotent.map((row) => row.method)),
    counts: Object.freeze({ idempotent: idempotent.length, replayable: replayable.length, mutatingIdempotent: mutatingIdempotent.length }),
  });
}

// ---------------------------------------------------------------------------
// 错误恢复计划
// ---------------------------------------------------------------------------

const ACTION_STEPS = Object.freeze({
  'none': () => ['无需恢复动作'],
  'fix-params': () => ['按 schema 修正参数后重新调用', '不要用相同参数原样重试'],
  'reobserve': () => ['调用 observe 重新取页面事实与 ref', '用新 ref/selector 重新调用原方法'],
  'resync-cooperation': () => ['调用 cooperate.sync 重新对齐协作上下文', '用返回的新 context 重试原动作'],
  'reopen-session': () => ['执行 session start（或 open <url>）建立新会话', '在新会话上重做动作'],
  'rebind-tab': () => ['执行 tab list 查看当前标签页', '用 session rebind 绑定目标 tab'],
  'resume-session': () => ['让用户确认是否交回控制权', '执行 session resume 后重试'],
  'release-control': () => ['确认当前 tab 控制权持有者', '用 tab return / release 归还后再操作'],
  'resolve-ledger': () => ['查看 ledger.status 找到 pending/unknown 条目', 'ledger resolve <id> --outcome confirmed|not-applied', '按结论决定是否重放'],
  'upgrade-extension': () => ['升级并重新加载浏览器扩展', '确认 hello.protocol 达到 ' + '1.9', '重连后重试'],
  'upgrade-cli': () => ['核对 CLI/daemon token 与配对状态', '升级到与扩展匹配的协议版本后重连'],
  'restart-daemon': () => ['bridge daemon status 查看 daemon 状态', '必要时 bridge daemon start 重新拉起（先停会话）'],
  'reconnect-browser': () => ['bridge doctor 检查扩展是否加载、daemon 是否可达', '确认后重试'],
  'wait-human': () => ['向用户说明需要人工完成的步骤', '等待用户确认后再继续'],
  'change-target': () => ['重新定位一个可见、可操作的目标', '换目标后重试'],
  'free-debugger': () => ['关闭 DevTools 或其它 debugger 占用', '关闭后重试'],
  'close-dialog': () => ['用 dialog.status 查看未处理对话框', 'dialog.accept/dismiss 处理后再操作'],
  'clear-transfer': () => ['调用 transfer.release 清理未完成会话', '重新 transfer.begin 后按 offset 续传'],
  'retry-download': () => ['确认浏览器下载权限与目标目录', '重试下载'],
  'enable-incognito': () => ['在扩展详情页允许 InPrivate/无痕模式', '重试'],
  'regenerate-artifact': () => ['重新执行截图/捕获（必要时去掉 stream 参数）', '用新产物继续'],
  'wait-and-retry': (plan) => ['等待约 ' + Math.max(1, Math.min(2, Number(plan.maxAttempts) || 1)) + '00ms 后重试', '最多重试 ' + (plan.maxAttempts || 1) + ' 次'],
  'abort-no-retry': () => ['不要重试：先修正语义/参数/权限', '把实际错误码与 data 报告给调用方'],
  'report-and-stop': () => ['停止自动化', '报告实际错误码、data 与证据路径'],
});

/** 执行完这些动作后重新发起调用是“新调用”而非“重放”，不触发账本冻结。 */
const SAFE_AFTER_STEPS = new Set([
  'reobserve', 'resync-cooperation', 'reopen-session', 'rebind-tab', 'resume-session',
  'fix-params', 'close-dialog', 'free-debugger', 'change-target', 'regenerate-artifact',
  'retry-download', 'clear-transfer', 'upgrade-extension', 'upgrade-cli', 'restart-daemon',
  'reconnect-browser', 'enable-incognito', 'wait-human', 'release-control',
]);

function normalizeErrorCode(errorOrCode) {
  if (errorOrCode && typeof errorOrCode === 'object') {
    return String(errorOrCode.code || errorOrCode.error || '');
  }
  return String(errorOrCode || '');
}

function effectStateFromError(error) {
  if (!error || typeof error !== 'object') return undefined;
  const data = error.data && typeof error.data === 'object' ? error.data : {};
  const candidates = [error.effectState, error.effect_state, data.effectState, data.effect_state];
  for (const value of candidates) if (typeof value === 'string' && value) return value;
  if (error.dispatched === false || data.dispatched === false) return 'none';
  return undefined;
}

/**
 * 生成恢复计划。
 * @param {string} method
 * @param {string|{code?:string}} errorOrCode
 * @param {{effectState?:string, dispatched?:boolean}} [options]
 * @returns {{
 *   method:string, code:string, known:boolean, inMethodScope:boolean,
 *   action:string|null, steps:string[], retryable:boolean, maxAttempts:number,
 *   retryAllowed:boolean, severity:string|null, requiresHuman:boolean,
 *   requiresResolve:boolean, note:string, provider:string|null
 * }}
 */
export function recoveryPlan(method, errorOrCode, options = {}) {
  const name = String(method || '');
  const proof = proofOf(name);
  const code = normalizeErrorCode(errorOrCode);
  const playbook = RECOVERY_PLAYBOOK[code] || null;
  const effectState = options.effectState !== undefined ? options.effectState : effectStateFromError(errorOrCode);
  const explicitDispatched = options.dispatched !== undefined ? options.dispatched : (errorOrCode && typeof errorOrCode === 'object' ? errorOrCode.dispatched : undefined);
  if (!playbook) {
    return Object.freeze({
      method: name, code, known: false, inMethodScope: false, action: null, steps: Object.freeze([]),
      retryable: false, maxAttempts: 0, retryAllowed: false, severity: null,
      requiresHuman: false, requiresResolve: false, note: '错误码不在方法恢复 playbook 中（可能是传输/CLI 层错误）', provider: null,
    });
  }
  const inMethodScope = Boolean(proof && proof.recovery.includes(code));
  const codeProvesNoEffect = !isUnknownOutcomeCode(code);
  const replay = replayDecision(name, { effectState, dispatched: explicitDispatched, code });
  // effectState=applied 表示副作用已经发生：任何自动重试都会造成第二次副作用，
  // 即使错误动作本身是“重连后重试”。这种情形必须交给人/账本判断。
  const retryAllowed = playbook.retryable && playbook.maxAttempts > 0 && effectState !== 'applied'
    && (replay.allowed || SAFE_AFTER_STEPS.has(playbook.action));
  const requiresResolve = code === 'E_LEDGER_RESOLVE_REQUIRED'
    || code === 'E_LEDGER_PENDING'
    || code === 'E_LEDGER_CONFLICT'
    || (replay.requiresResolve && !replay.allowed && !SAFE_AFTER_STEPS.has(playbook.action));
  const requiresHuman = playbook.severity === 'needs-user' || playbook.action === 'wait-human';
  // 账本类错误要求先 resolve：即使方法本身可重放，也必须等账本结论。
  const finalRetryAllowed = requiresResolve ? false : retryAllowed;
  // 结果可证明的方法遇到“结果未知型且可重试”的错误可以安全重试：把 playbook 的“不要重试”
  // 修正为“等待后重试”，避免把只读方法也吓成必须人工介入。
  // 不可重试的错误（E_FORBIDDEN/E_BAD_ARG/E_CANCELLED…）保持原动作：重发没有意义。
  const recommendedAction = playbook.action === 'abort-no-retry' && playbook.retryable && replay.allowed
    ? 'wait-and-retry'
    : playbook.action;
  const builder = ACTION_STEPS[recommendedAction] || ACTION_STEPS['report-and-stop'];
  const steps = Object.freeze([...builder(playbook), ...(inMethodScope ? [] : ['该错误码不在方法的常规恢复集内，恢复前先核对调用参数与作用域'])]);
  return Object.freeze({
    method: name,
    code,
    known: true,
    inMethodScope,
    action: recommendedAction,
    playbookAction: playbook.action,
    steps,
    retryable: playbook.retryable,
    maxAttempts: playbook.maxAttempts,
    retryAllowed: finalRetryAllowed,
    severity: playbook.severity,
    requiresHuman,
    requiresResolve,
    codeProvesNoEffect,
    note: playbook.note,
    provider: proof ? proof.profile : null,
  });
}

/** 从真实错误对象（含 error.data.effect_state）生成恢复计划。 */
export function recoveryForError(method, error) {
  return recoveryPlan(method, error, { effectState: effectStateFromError(error) });
}

/** 一个方法在全部适用错误码下的完整恢复计划（矩阵，供诊断/文档/测试）。 */
export function methodRecoveryPlans(method) {
  const proof = proofOf(method);
  if (!proof) return Object.freeze({ method: String(method || ''), known: false, plans: Object.freeze([]) });
  return Object.freeze({
    method: proof.method,
    known: true,
    profile: proof.profile,
    plans: Object.freeze(proof.recovery.map((code) => recoveryPlan(proof.method, code))),
  });
}

/** 恢复矩阵：错误码 → 适用方法、方法 → 错误码（全部来自目录）。 */
export function recoveryMatrix() {
  const byMethod = {};
  const byCode = {};
  for (const row of METHOD_CATALOG) {
    const codes = METHOD_RECOVERY[row.method];
    byMethod[row.method] = Object.freeze([...codes]);
    for (const code of codes) (byCode[code] = byCode[code] || []).push(row.method);
  }
  for (const code of Object.keys(byCode)) byCode[code] = Object.freeze(byCode[code]);
  return Object.freeze({ byMethod: Object.freeze(byMethod), byCode: Object.freeze(byCode) });
}

/** 恢复面覆盖统计：playbook/错误码注册/方法适用面。 */
export function recoveryCoverage() {
  const matrix = recoveryMatrix();
  const coveredCodes = Object.keys(matrix.byCode);
  const missingFromPlaybook = coveredCodes.filter((code) => !RECOVERY_PLAYBOOK[code]);
  const unregistered = coveredCodes.filter((code) => !ERROR_CODE_SET.has(code));
  return Object.freeze({
    methods: METHOD_CATALOG.length,
    playbookCodes: Object.keys(RECOVERY_PLAYBOOK).length,
    methodVisibleCodes: coveredCodes.length,
    profiles: Object.keys(RECOVERY_PROFILES).length,
    missingFromPlaybook: Object.freeze(missingFromPlaybook),
    unregistered: Object.freeze(unregistered),
    minPerMethod: Math.min(...METHOD_CATALOG.map((row) => METHOD_RECOVERY[row.method].length)),
    maxPerMethod: Math.max(...METHOD_CATALOG.map((row) => METHOD_RECOVERY[row.method].length)),
  });
}

// ---------------------------------------------------------------------------
// 综合：可证明性义务与审计
// ---------------------------------------------------------------------------

/**
 * 一次调用的“可证明性义务”快照：六维 + 当前证据状态。
 * 这是给 CLI/MCP 在错误/诊断里展示“我为什么判断它没生效/不能重放”的结构化事实。
 */
export function proofObligations(method, input = {}) {
  const proof = proofOf(method);
  if (!proof) return Object.freeze({ method: String(method || ''), known: false, dimensions: Object.freeze({}) });
  const pre = checkPreconditions(method, input.context || {});
  const post = input.result === undefined ? null : verifyPostconditions(method, input.result);
  const replay = input.error === undefined && input.outcome === undefined
    ? null
    : replayDecision(method, {
      effectState: input.effectState !== undefined ? input.effectState : effectStateFromError(input.error),
      dispatched: input.dispatched,
      code: input.error && typeof input.error === 'object' ? input.error.code : input.code,
    });
  const recovery = input.error === undefined
    ? null
    : recoveryForError(method, input.error);
  return Object.freeze({
    method: proof.method,
    known: true,
    dimensions: Object.freeze({
      pre: Object.freeze({ codes: proof.pre, state: pre.proven ? 'proven' : pre.ok ? 'partial' : 'violated', detail: pre }),
      post: Object.freeze({ codes: proof.post, state: post ? (post.proven ? 'proven' : post.ok ? 'partial' : 'violated') : 'not-observed', detail: post }),
      effectState: Object.freeze({ value: proof.effectState, label: EFFECT_STATES[proof.effectState] || null }),
      idempotent: proof.idempotent,
      replayable: proof.replayable,
      recovery: Object.freeze({ profile: proof.profile, codes: proof.recovery, plan: recovery }),
    }),
    replay,
    recovery,
  });
}

/**
 * 六面目录 + 恢复 playbook 的运行时审计。
 * 返回错误字符串数组（空 = 通过）；与 tools/protocol-check 和单测共用。
 */
export function auditMethodStateMachine() {
  const errors = [...validateMethodProofs()];
  // playbook 自身的一致性
  for (const [code, plan] of Object.entries(RECOVERY_PLAYBOOK)) {
    if (!ERROR_CODE_SET.has(code)) errors.push('playbook 含未登记错误码：' + code);
    if (!PROOF_RECOVERY_ACTIONS[plan.action]) errors.push(code + ' 恢复动作未登记：' + plan.action);
    if (!RECOVERY_SEVERITIES.includes(plan.severity)) errors.push(code + ' 严重度非法：' + plan.severity);
    if (typeof plan.retryable !== 'boolean') errors.push(code + ' retryable 必须是布尔');
    if (!Number.isInteger(plan.maxAttempts) || plan.maxAttempts < 0) errors.push(code + ' maxAttempts 必须是非负整数');
    if (plan.retryable && plan.maxAttempts < 1) errors.push(code + ' 标记可重试但 maxAttempts=0');
    if (!plan.retryable && plan.maxAttempts > 0) errors.push(code + ' 标记不可重试但 maxAttempts>0');
    if (typeof plan.note !== 'string' || !plan.note.trim()) errors.push(code + ' 缺少 note');
    // 与 ERROR_RECOVERY 的 retry 口径交叉校验（不新增码：code 必须已在注册表）。
    const legacy = ERROR_RECOVERY[code];
    if (legacy && legacy.retry === 'no' && plan.retryable) errors.push(code + ' 与 ERROR_RECOVERY 冲突：legacy retry=no 但 playbook 可重试');
    if (legacy && legacy.retry === 'transient' && !plan.retryable) errors.push(code + ' 与 ERROR_RECOVERY 冲突：legacy retry=transient 但 playbook 不可重试');
  }
  // 恢复面完整性
  const coverage = recoveryCoverage();
  for (const code of coverage.missingFromPlaybook) errors.push('方法恢复集里的错误码缺少 playbook：' + code);
  for (const code of coverage.unregistered) errors.push('方法恢复集里的错误码未登记：' + code);
  if (coverage.minPerMethod < 1) errors.push('存在没有恢复错误码的方法');
  // 幂等/重放不变量
  for (const row of METHOD_CATALOG) {
    const proof = METHOD_PROOF[row.method];
    if (proof.replayable && row.unknown) errors.push(row.method + ' 结果不可证明却标记可重放');
    if (!proof.replayable && !row.unknown && !proof.idempotent) errors.push(row.method + ' 只读方法应幂等');
  }
  return errors;
}

/** 方法六面摘要（CLI/MCP 诊断展示用；未知方法返回 null）。 */
export function describeMethodProof(method) {
  const proof = proofOf(method);
  if (!proof) return null;
  return Object.freeze({
    method: proof.method,
    rule: proof.rule,
    owner: proof.owner,
    effect: proof.effect,
    effectState: proof.effectState,
    effectStateLabel: EFFECT_STATES[proof.effectState] || null,
    pre: proof.pre,
    post: proof.post,
    idempotent: proof.idempotent,
    replayable: proof.replayable,
    replay: Object.freeze({
      autoReplay: proof.replayable,
      unknownOutcome: proof.replayable ? 'retryable' : 'requires-resolve',
    }),
    recovery: Object.freeze({
      profile: proof.profile,
      codes: proof.recovery,
      actions: Object.freeze([...new Set(proof.recovery.map((code) => RECOVERY_PLAYBOOK[code] && RECOVERY_PLAYBOOK[code].action).filter(Boolean))]),
    }),
  });
}

/** 全部方法的六面摘要（排序与目录一致）。 */
export function listMethodProofs() {
  return METHOD_CATALOG.map((row) => describeMethodProof(row.method));
}

/**
 * 状态机维度的交叉一致性快照（供 status/诊断消费）：
 * effect_state 分布、幂等/可重放计数、恢复码覆盖、审计结果。
 */
export function stateMachineSnapshot() {
  return Object.freeze({
    total: METHOD_CATALOG.length,
    dimensions: PROOF_DIMENSIONS,
    effectStates: effectStateSummary(),
    replay: replaySummary(),
    recovery: recoveryCoverage(),
    playbookCodes: Object.keys(RECOVERY_PLAYBOOK).length,
    profiles: Object.keys(RECOVERY_PROFILES).length,
    families: PROOF_RULES.length,
    auditErrors: Object.freeze(auditMethodStateMachine()),
  });
}

// ---------------------------------------------------------------------------
// 只读索引：错误码 → 恢复画像；方法 → 六面矩阵行
//
// 这两个索引是纯派生的展示/诊断视图（status、docs、测试共用）。它们不新增事实：
// 每一项都能在 METHOD_PROOF / RECOVERY_PLAYBOOK 里找到同源数据。
// ---------------------------------------------------------------------------

/**
 * 错误码 → 恢复画像：动作、严重度、适用族、适用方法数。
 * @returns {Record<string, {code:string, action:string, severity:string, retryable:boolean,
 *   maxAttempts:number, note:string, profiles:string[], methods:number, methodNames:string[]}>}
 */
export function recoveryIndex() {
  const matrix = recoveryMatrix();
  const index = {};
  for (const [code, plan] of Object.entries(RECOVERY_PLAYBOOK)) {
    const methodNames = matrix.byCode[code] || [];
    const profiles = [...new Set(methodNames.map((method) => METHOD_PROOF[method].profile))];
    index[code] = Object.freeze({
      code,
      action: plan.action,
      severity: plan.severity,
      retryable: plan.retryable,
      maxAttempts: plan.maxAttempts,
      note: plan.note,
      profiles: Object.freeze(profiles),
      methods: methodNames.length,
      methodNames: Object.freeze([...methodNames]),
    });
  }
  return Object.freeze(index);
}

/**
 * 单个错误码的恢复画像（未知码返回 known=false）。
 * 与 recoveryPlan 的区别：这里回答“这个错误码整体上是什么恢复语义”，
 * 不针对某个具体方法；适合错误码文档/诊断页。
 */
export function explainRecovery(code) {
  const key = String(code || '');
  const plan = RECOVERY_PLAYBOOK[key];
  if (!plan) {
    return Object.freeze({ code: key, known: false, action: null, steps: Object.freeze([]), profiles: Object.freeze([]), methods: 0 });
  }
  const index = recoveryIndex()[key];
  const builder = ACTION_STEPS[plan.action] || ACTION_STEPS['report-and-stop'];
  return Object.freeze({
    code: key,
    known: true,
    action: plan.action,
    actionLabel: PROOF_RECOVERY_ACTIONS[plan.action] || null,
    severity: plan.severity,
    retryable: plan.retryable,
    maxAttempts: plan.maxAttempts,
    note: plan.note,
    steps: Object.freeze(builder(plan)),
    profiles: index ? index.profiles : Object.freeze([]),
    methods: index ? index.methods : 0,
  });
}

/**
 * 方法六面矩阵行（表格化；CLI `schema --json`/诊断页可直接打印）。
 * @param {string[]} [methods]
 */
export function proofMatrix(methods = METHOD_NAMES) {
  return Object.freeze(methods.map((method) => {
    const proof = proofOf(method);
    if (!proof) {
      return Object.freeze({
        method: String(method || ''), known: false, owner: null, effect: null, effectState: null,
        idempotent: null, replayable: null, profile: null, preCount: 0, postCount: 0, recoveryCount: 0,
      });
    }
    return Object.freeze({
      method: proof.method,
      known: true,
      owner: proof.owner,
      effect: proof.effect,
      effectState: proof.effectState,
      idempotent: proof.idempotent,
      replayable: proof.replayable,
      profile: proof.profile,
      preCount: proof.pre.length,
      postCount: proof.post.length,
      recoveryCount: proof.recovery.length,
      pre: proof.pre,
      post: proof.post,
    });
  }));
}

/**
 * 恢复面按严重度分组（诊断用）：fatal / needs-user / recoverable 各自多少码、多少方法。
 */
export function recoverySeveritySummary() {
  const index = recoveryIndex();
  const counts = { recoverable: 0, 'needs-user': 0, fatal: 0 };
  const codes = { recoverable: [], 'needs-user': [], fatal: [] };
  for (const [code, entry] of Object.entries(index)) {
    counts[entry.severity] = (counts[entry.severity] || 0) + 1;
    (codes[entry.severity] = codes[entry.severity] || []).push(code);
  }
  return Object.freeze({
    counts: Object.freeze(counts),
    codes: Object.freeze(Object.fromEntries(Object.entries(codes).map(([severity, list]) => [severity, Object.freeze(list)]))),
    recoverableActions: Object.freeze(Object.entries(RECOVERY_PLAYBOOK)
      .filter(([, plan]) => plan.severity === 'recoverable')
      .map(([code, plan]) => Object.freeze({ code, action: plan.action, maxAttempts: plan.maxAttempts }))),
  });
}

// ---------------------------------------------------------------------------
// 调用模拟器：把六面组合成一次调用的阶段结论
//
// 这是纯函数版“dry-run”：不做任何 I/O，只按给定证据（上下文/结果/错误）走一遍
// preflight → settle 的状态机，输出给 CLI/MCP 的恢复决策和给测试的确定性结论。
// ---------------------------------------------------------------------------

/** 模拟调用可能的最终结论。 */
export const SIMULATION_OUTCOMES = Object.freeze([
  'blocked-precondition',   // 本地证据已证明前置条件不满足
  'succeeded-verified',      // 成功，且后置条件全部可证明
  'succeeded-unverified',    // 成功，但部分后置条件只能靠后续观察
  'succeeded-contradiction', // 结果与后置条件矛盾（调用方应视为失败）
  'failed-known',            // 失败，但可证明未生效（可安全重试）
  'failed-unknown',          // 失败，结果不可证明（必须观察/账本）
  'dispatched-pending',      // 只提供上下文，尚无结果/错误
]);

/**
 * 模拟一次方法调用。
 * @param {string} method
 * @param {{context?:object, result?:*, error?:object, effectState?:string, dispatched?:boolean}} [input]
 * @returns {{
 *   method:string, known:boolean, outcome:string, phases:Array<object>,
 *   pre:object|null, post:object|null, replay:object|null, recovery:object|null,
 *   effectState:string|null,
 * }}
 */
export function simulateCall(method, input = {}) {
  const name = String(method || '');
  const proof = proofOf(name);
  if (!proof) {
    return Object.freeze({
      method: name, known: false, outcome: 'blocked-precondition', phases: Object.freeze([]),
      pre: null, post: null, replay: null, recovery: null, effectState: null,
    });
  }
  const phases = [];
  const pre = checkPreconditions(name, input.context || {});
  phases.push(Object.freeze({
    phase: 'preflight',
    ok: pre.ok,
    proven: pre.proven,
    violations: pre.violations,
    unknowns: pre.unknowns,
  }));
  if (!pre.ok) {
    return Object.freeze({
      method: name,
      known: true,
      outcome: 'blocked-precondition',
      phases: Object.freeze(phases),
      pre,
      post: null,
      replay: null,
      recovery: null,
      effectState: proof.effectState,
    });
  }
  const effectState = input.effectState !== undefined ? input.effectState : effectStateFromError(input.error);
  if (input.result !== undefined) {
    const post = verifyPostconditions(name, input.result);
    phases.push(Object.freeze({ phase: 'settle-success', ok: post.ok, proven: post.proven, violated: post.violated, unverifiable: post.unverifiable }));
    const outcome = !post.ok ? 'succeeded-contradiction' : post.proven ? 'succeeded-verified' : 'succeeded-unverified';
    return Object.freeze({
      method: name, known: true, outcome, phases: Object.freeze(phases), pre, post,
      replay: null, recovery: null, effectState: proof.effectState,
    });
  }
  if (input.error !== undefined) {
    const recovery = recoveryPlan(name, input.error && typeof input.error === 'object' ? input.error.code : input.error, {
      effectState,
      dispatched: input.dispatched,
    });
    const replay = replayDecision(name, {
      effectState,
      dispatched: input.dispatched,
      code: input.error && typeof input.error === 'object' ? input.error.code : input.error,
    });
    phases.push(Object.freeze({
      phase: 'settle-failure',
      ok: false,
      code: recovery.code,
      codeProvesNoEffect: recovery.codeProvesNoEffect,
      retryAllowed: recovery.retryAllowed,
      requiresResolve: recovery.requiresResolve,
    }));
    return Object.freeze({
      method: name,
      known: true,
      outcome: recovery.codeProvesNoEffect || replay.allowed ? 'failed-known' : 'failed-unknown',
      phases: Object.freeze(phases),
      pre,
      post: null,
      replay,
      recovery,
      effectState: proof.effectState,
    });
  }
  phases.push(Object.freeze({ phase: 'dispatch', ok: true }));
  return Object.freeze({
    method: name, known: true, outcome: 'dispatched-pending', phases: Object.freeze(phases),
    pre, post: null, replay: null, recovery: null, effectState: proof.effectState,
  });
}

/**
 * 批量模拟：逐调用独立走状态机（不引入调用间副作用），按结论分组。
 * @param {Array<{method:string, input?:object}>} calls
 */
export function simulateBatch(calls = []) {
  const results = calls.map((call) => simulateCall(call.method, call.input || {}));
  const counts = {};
  for (const outcome of SIMULATION_OUTCOMES) counts[outcome] = 0;
  for (const item of results) counts[item.outcome] = (counts[item.outcome] || 0) + 1;
  return Object.freeze({
    total: results.length,
    results: Object.freeze(results),
    counts: Object.freeze(counts),
    blocked: Object.freeze(results.filter((item) => item.outcome === 'blocked-precondition')),
    retryable: Object.freeze(results.filter((item) => item.recovery && item.recovery.retryAllowed)),
    unknown: Object.freeze(results.filter((item) => item.outcome === 'failed-unknown')),
  });
}
