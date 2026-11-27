// src/lib/cooperate-control.js —— 共享控制面语义对齐：context_id / control_policy / allow-ask-deny。
//
// M6 矩阵 P0-4（docs/兼容目标-DIFF-MATRIX.md:70 / :491）判 partial 的原因不是“两侧没有这些东西”，
// 而是两侧的控制面仲裁语义不同：
//   兼容目标：`context_id + control_policy(auto/strict/target)` 单控制面 —— sync 应答里
//        `context_id/control_policy` 必须被显式回执（ack），policy 在会话内固定；
//        我方：passthrough token + 租约 epoch + hold 状态，context_id 是每次 sync 的随机 uuid，
//        没有“稳定标识 / 策略回执 / owner / 交接窗口 / borrow 确认超时”的可对账证据。
//
// 本模块做**加法对齐**（默认行为只加不改）：把 兼容目标 的控制面语义映射成纯函数 + 一个
// 有界的内存登记簿，供既有 cooperate/borrow/borrow-confirm 路径在**证据字段**里消费。
// 旧判定（allowed/code/state）仍由 control.js / human-gate / borrow-confirm 原样决定。
//
// 兼容目标 语义证据位置（逐条对照，供报告引用）：
//   兼容目标
//     :29 TARGET_CONTROL_PROTOCOL="1.8"；:36-43 ControlPolicy{auto,strict,target}；
//     :45-71 ActionMetadata.context_id/observation_id（sync 返回、strict 单次消费）；
//     :1 “A context is explicit caller evidence, never inferred by the daemon.”
//   .../crates/参考 CLI/src/cli/cooperate.rs
//     :52-54 --policy 仅 sync/enable；:86-92 --policy 只允许 sync/enable、缺省 auto；
//     :114-116 target 显式请求；:180-201 verify_policy 回执规则（auto 接受 target|strict，
//     target 只接受 target；reply 带 context_id 但未回执 → E_UNSUPPORTED_FEATURE）。
//   .../crates/参考协议/src/compatibility.rs
//     :139-145/:198-216 Feature::TargetControl 仅在 control_policy=target（daemon）/
//     target|auto（extension）时要求 1.8 门；:96-104 BorrowConfirmationTimeout 由
//     confirmation_timeout_ms 触发（1.2 门）。
//   .../crates/参考 CLI/src/cli/tab.rs:114-126,217-235
//     --timeout “Maximum time to wait for user confirmation (default 60s)”，
//     IPC 超时 = confirmation_timeout_ms + CANCEL_CLEANUP_TIMEOUT。
//   .../apps/extension/src/cooperation/controller.ts
//     :795-830 policy 只允许 auto/strict/target、auto→(会话策略|target)、会话内固定、
//     targetPolicy=policy==="target"；:1023-1029 应答带 context_id/control_policy；
//     :1542-1555 context_id 必须属于本会话本 tab（否则 control_context_invalid）；
//     :2120-2135 target 动作要求 context_id 匹配 + 未消费 observation；
//     :1863/:1896 strict 观察/上下文在动作后被消费（单次）。
//   `参考 CLI cooperate --help`（实测）：--context “Control context returned by cooperate
//     sync. Required for shared-tab actions”；--policy [auto, strict, target]。
//   `参考 CLI tab borrow --help`（实测）：--timeout 默认 60s；--no-confirm 已废弃
//     “The extension decides whether confirmation is required”。
//
// 约定：
//   - 纯内存 + 可注入时钟/记录源，不碰 DOM/chrome，不 import cooperate.js/borrow.js（无环）；
//   - contextId 是**确定性稳定标识**：同一 (tab,document,revision,controlRevision,authorityRevision)
//     恒定不变；导航/文档代数/控制权变化才换代。与 兼容目标 target 策略“epoch 未变则复用
//     previous context id”（controller.ts:1025-1028）对应；
//   - 所有 token 一律打码；所有函数对非法输入返回 null/结构化失败，绝不抛异常；
//   - 这里只产出“证据 + 建议判定”，不改变任何既有 allowed/code/state。

import { evidenceDigest, num, integer, clip, positive, normalizeCooperationTabId } from './input-lease-kinds.js';
import { controlGenerationRecord } from '../control-generation.js';
import { HANDOFF_STATES, DEFAULT_HANDOFF_WINDOW_MS, handoffOwner, handoffWindowFor } from './human-handoff.js';

export const CONTROL_EVIDENCE_VERSION = 1;

/** 兼容目标 TARGET_CONTROL_PROTOCOL（cooperate.rs:29）：target 控制面的协议门。 */
export const TARGET_CONTROL_PROTOCOL = '1.8';

/** 兼容目标 ControlPolicy（cooperate.rs:36-43），snake_case 与线上字段一致。 */
export const CONTROL_POLICY = Object.freeze({
  AUTO: 'auto',
  STRICT: 'strict',
  TARGET: 'target',
});

export const CONTROL_POLICY_LIST = Object.freeze(Object.values(CONTROL_POLICY));

/** 控制权 owner：谁持有授权（allow 的 owner=agent；ask/交接中=human；未协商/空闲=shared）。 */
export const CONTROL_OWNER = Object.freeze({
  AGENT: 'agent',
  HUMAN: 'human',
  SHARED: 'shared',
});

/** allow/ask/deny 三态：allow=可动作；ask=等人工确认/交接；deny=策略或证据不足。 */
export const CONTROL_DECISION = Object.freeze({
  ALLOW: 'allow',
  ASK: 'ask',
  DENY: 'deny',
});

export const CONTROL_ERROR = Object.freeze({
  BAD_ARG: 'E_BAD_ARG',
  UNSUPPORTED: 'E_UNSUPPORTED_FEATURE',
  CONTEXT_REQUIRED: 'E_CONTEXT_REQUIRED',
  CONTEXT_INVALID: 'E_CONTROL_CONTEXT_INVALID',
  OBSERVATION_REQUIRED: 'E_OBSERVATION_STALE',
  HUMAN_INTERVENTION: 'E_HUMAN_GATE',
  BORROW_PENDING: 'E_BORROW_CONFLICT',
  BORROW_TIMEOUT: 'E_BORROW_TIMEOUT',
});

export const CONTROL_REASON = Object.freeze({
  PASSIVE: 'passive-read',
  POLICY_UNACKNOWLEDGED: 'policy-not-acknowledged',
  HUMAN_INTERVENTION: 'human-intervention',
  HUMAN_HOLD: 'human-hold',
  BORROW_CONFIRMATION: 'borrow-confirmation',
  CONTEXT_REQUIRED: 'context-required',
  CONTEXT_SUPERSEDED: 'context-superseded',
  CONTEXT_CONSUMED: 'context-consumed',
  OBSERVATION_REQUIRED: 'observation-required',
  CONTEXT_VALID: 'context-valid',
  POLICY_ALLOWS: 'policy-allows',
});

/** 兼容目标 tab borrow --timeout 默认 60s（tab.rs:233 `unwrap_or(60_000)`）。 */
export const DEFAULT_CONFIRMATION_TIMEOUT_MS = 60000;

/** 防御性上限：超长确认窗口会让 handoff 永久占用动作队列（兼容目标 用 CANCEL_CLEANUP_TIMEOUT 兜底）。 */
export const MAX_CONFIRMATION_TIMEOUT_MS = 600000;

export const DEFAULT_HANDOFF_WINDOW_MS_VALUE = DEFAULT_HANDOFF_WINDOW_MS;

/** 策略规则表：owner / 是否要求 context / strict 单次消费 / 是否要求回执。 */
export const CONTROL_POLICY_RULES = Object.freeze({
  [CONTROL_POLICY.AUTO]: Object.freeze({
    policy: CONTROL_POLICY.AUTO,
    owner: CONTROL_OWNER.SHARED,
    settledPolicy: CONTROL_POLICY.TARGET,
    requiresContext: false,
    singleUseContext: false,
    requiresAcknowledgement: true,
    requiresExpect: false,
  }),
  [CONTROL_POLICY.STRICT]: Object.freeze({
    policy: CONTROL_POLICY.STRICT,
    owner: CONTROL_OWNER.AGENT,
    settledPolicy: CONTROL_POLICY.STRICT,
    requiresContext: false,
    singleUseContext: true,
    requiresAcknowledgement: false,
    requiresExpect: false,
  }),
  [CONTROL_POLICY.TARGET]: Object.freeze({
    policy: CONTROL_POLICY.TARGET,
    owner: CONTROL_OWNER.AGENT,
    settledPolicy: CONTROL_POLICY.TARGET,
    requiresContext: true,
    singleUseContext: false,
    requiresAcknowledgement: true,
    requiresExpect: false,
  }),
});

const CONTROL_ACTION_ALIASES = Object.freeze({
  sync: 'sync',
  'cooperate.sync': 'sync',
  enable: 'enable',
  'cooperate.enable': 'enable',
  status: 'status',
  'cooperate.status': 'status',
  wait: 'wait',
  'cooperate.wait': 'wait',
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function maskTokenSafe(token) {
  const text = String(token == null ? '' : token);
  return text.length <= 12 ? text : text.slice(0, 6) + '…' + text.slice(-6);
}

/** 规整 control_policy：非法/缺省返回 null（缺省 = legacy 调用方没传）。 */
export function normalizeControlPolicy(value) {
  const text = String(value == null ? '' : value);
  return CONTROL_POLICY_LIST.includes(text) ? text : null;
}

/** 规整 兼容目标 cooperate action：sync/enable/status/wait（兼容 `cooperate.sync` 写法）。 */
export function normalizeControlAction(value) {
  const text = String(value == null ? '' : value);
  return CONTROL_ACTION_ALIASES[text] || null;
}

/** 解析协议版本（对应 兼容目标 system.rs parse_protocol_parts：major 必须纯数字，minor 可缺省）。 */
export function parseProtocolVersion(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;
  const parts = text.split('.');
  const majorText = parts[0];
  if (!majorText || !/^\d+$/.test(majorText)) return null;
  const major = Number(majorText);
  if (!Number.isSafeInteger(major)) return null;
  let minor = 0;
  if (parts.length > 1 && parts[1] !== '') {
    if (!/^\d+$/.test(parts[1])) return null;
    minor = Number(parts[1]);
    if (!Number.isSafeInteger(minor)) return null;
  }
  return { major, minor };
}

/** 只比较 major/minor（兼容目标 compare_protocol）；非法输入返回 null。 */
export function compareProtocolVersions(left, right) {
  const a = parseProtocolVersion(left);
  const b = parseProtocolVersion(right);
  if (!a || !b) return null;
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  return 0;
}

/**
 * 兼容目标 compatibility::Feature::TargetControl.supports 的等价实现：
 * major 必须与要求版本一致（未来 major 不继承支持），且 minor 不低于 1.8。
 */
export function supportsTargetControl(protocol) {
  const required = TARGET_CONTROL_PROTOCOL;
  const parsed = parseProtocolVersion(protocol);
  const base = parseProtocolVersion(required);
  if (!parsed || !base || parsed.major !== base.major) return false;
  const order = compareProtocolVersions(protocol, required);
  return order != null && order >= 0;
}

/**
 * 兼容目标 CLI 的 --policy 约束（cooperate.rs:52-54,86-92）：
 *   - 只有 sync/enable 会携带 control_policy；缺省 auto；
 *   - status/wait 不允许 --policy。
 */
export function resolvePolicyRequest(action, requestedPolicy) {
  const normalizedAction = normalizeControlAction(action);
  if (!normalizedAction) {
    return { ok: false, code: CONTROL_ERROR.BAD_ARG, error: '未知 cooperate action：' + String(action) };
  }
  const requested = normalizeControlPolicy(requestedPolicy);
  if (requestedPolicy != null && requested == null) {
    return {
      ok: false,
      code: CONTROL_ERROR.BAD_ARG,
      error: 'control_policy must be auto, strict or target on sync/enable',
      requested: String(requestedPolicy),
    };
  }
  const carriesPolicy = normalizedAction === 'sync' || normalizedAction === 'enable';
  if (requested && !carriesPolicy) {
    return { ok: false, code: CONTROL_ERROR.BAD_ARG, error: '--policy requires cooperate sync or enable', action: normalizedAction };
  }
  return {
    ok: true,
    action: normalizedAction,
    requested,
    legacy: requested == null,
    policy: carriesPolicy ? (requested || CONTROL_POLICY.AUTO) : null,
  };
}

/**
 * 策略协商（controller.ts:795-830 / cli/cooperate.rs:91-92）：
 *   auto → 会话已有策略，否则 target；policy 在会话内固定；显式变化 → invalid_params。
 * 本地缺省（defaultPolicy）单独记录：兼容目标 controller 回落到 strict，BridgeDeck control.js
 * 本地缺省是 target（control.js:64），这个差异作为证据暴露而不是抹平。
 */
export function negotiateControlPolicy(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const request = resolvePolicyRequest(source.action, source.requestedPolicy ?? source.controlPolicy);
  if (!request.ok) return request;
  const sessionPolicy = normalizeControlPolicy(source.sessionPolicy);
  const requested = request.requested;
  const wanted = requested === CONTROL_POLICY.AUTO
    ? (sessionPolicy || CONTROL_POLICY.TARGET)
    : requested;
  if (wanted && sessionPolicy && wanted !== sessionPolicy) {
    return {
      ok: false,
      code: CONTROL_ERROR.BAD_ARG,
      error: 'Control policy is fixed for this session; start a new session to change it',
      requested: wanted,
      sessionPolicy,
      fixed: true,
      data: { phase: 'negotiate', effect_state: 'none', requested_policy: wanted, session_policy: sessionPolicy },
    };
  }
  const localDefault = normalizeControlPolicy(source.defaultPolicy) || CONTROL_POLICY.TARGET;
  const policy = sessionPolicy || wanted || localDefault;
  return {
    ok: true,
    action: request.action,
    policy,
    effectivePolicy: policy === CONTROL_POLICY.AUTO ? CONTROL_POLICY.TARGET : policy,
    requested,
    sessionPolicy,
    legacy: request.legacy,
    target: policy === CONTROL_POLICY.TARGET,
    replyControlPolicy: sessionPolicy || policy,
    localDefault,
    evidence: {
      action: request.action,
      policy,
      requested: requested || null,
      sessionPolicy: sessionPolicy || null,
      fixed: Boolean(sessionPolicy),
      legacy: request.legacy === true,
      target: policy === CONTROL_POLICY.TARGET,
    },
  };
}

/**
 * 兼容目标 verify_policy 的等价实现（cooperate.rs:180-201）：
 *   回执规则：auto 接受 target|strict；target 只接受 target；strict/缺省总是通过；
 *   reply 带 context_id 但未回执 → E_UNSUPPORTED_FEATURE（effect_state=none）；
 *   未 ready 的应答（没有 context_id）不携带授权，不拦。
 */
export function acknowledgeControlPolicy(reply, requestedPolicy) {
  const source = isPlainObject(reply) ? reply : {};
  const requested = normalizeControlPolicy(requestedPolicy);
  const acknowledgedPolicy = normalizeControlPolicy(source.control_policy);
  let acknowledged = true;
  if (requested === CONTROL_POLICY.AUTO) acknowledged = acknowledgedPolicy === CONTROL_POLICY.TARGET || acknowledgedPolicy === CONTROL_POLICY.STRICT;
  else if (requested === CONTROL_POLICY.TARGET) acknowledged = acknowledgedPolicy === CONTROL_POLICY.TARGET;
  const hasContext = source.context_id != null && source.context_id !== '';
  if (hasContext && !acknowledged) {
    return {
      ok: false,
      acknowledged: false,
      code: CONTROL_ERROR.UNSUPPORTED,
      controlPolicy: acknowledgedPolicy,
      contextId: clip(String(source.context_id), 96),
      error: 'Control policy was not acknowledged; update the CLI, restart its daemon and update the extension. With a current CLI and an older extension, pass --policy strict on every sync/enable and step to retain legacy behavior; expect conditions still require protocol 1.8',
      data: {
        reason: 'unsupported_feature',
        phase: 'negotiate',
        effect_state: 'none',
        required_protocol: TARGET_CONTROL_PROTOCOL,
        requested_policy: requested,
      },
    };
  }
  return {
    ok: true,
    acknowledged,
    controlPolicy: acknowledgedPolicy,
    contextId: hasContext ? clip(String(source.context_id), 96) : null,
    requestedPolicy: requested,
  };
}

/** 策略规则查询（非法策略返回 null，调用方自己决定 fallback）。 */
export function policyRules(policy) {
  const normalized = normalizeControlPolicy(policy);
  return normalized ? CONTROL_POLICY_RULES[normalized] : null;
}

/** owner 语义：策略的默认授权主体（auto=shared；strict/target=agent）。 */
export function policyOwner(policy) {
  const rules = policyRules(policy);
  return rules ? rules.owner : CONTROL_OWNER.SHARED;
}

// ---------------------------------------------------------------------------
// context_id：稳定标识（documentId/frame/revision/control generation 关联）
// ---------------------------------------------------------------------------

function stabilityKey(identity) {
  // 只取“控制上下文是否仍然有效”有关的字段：同一文档同一 revision 且控制权未变化 →
  // contextId 不变（对齐 兼容目标 controller.ts:1025-1028 的 target 策略复用规则）。
  return {
    tabId: identity.tabId,
    documentId: identity.documentId,
    documentEpoch: identity.documentEpoch,
    revision: identity.revision,
    controlRevision: identity.controlRevision,
    authorityRevision: identity.authorityRevision,
    frameId: identity.frameId,
  };
}

/**
 * 把四项 revision/文档事实规整成 context 身份。
 * @param {number} tabId
 * @param {object} [record] controlGenerationRecord 形状
 * @param {{documentId?:string, frameId?:number, revision?:number}} [extra]
 */
export function contextIdentityOf(tabId, record, extra = {}) {
  const id = normalizeCooperationTabId(tabId);
  if (id == null) return null;
  const rec = isPlainObject(record) ? record : (controlGenerationRecord(id) || {});
  const extras = isPlainObject(extra) ? extra : {};
  const identity = {
    tabId: id,
    documentId: clip(extras.documentId != null ? extras.documentId : rec.document || '', 512),
    documentEpoch: num(rec.documentEpoch),
    revision: num(extras.revision != null ? extras.revision : rec.revision),
    controlRevision: num(rec.controlRevision),
    authorityRevision: num(rec.authorityRevision),
    frameEpoch: num(rec.frameEpoch),
    epoch: num(rec.epoch),
    generation: num(rec.generation),
    frameId: Number.isInteger(Number(extras.frameId)) ? Number(extras.frameId) : 0,
  };
  return { ...identity, digest: evidenceDigest(stabilityKey(identity)) };
}

/** 稳定 contextId：`ctx-<8 位摘要>`；同一控制上下文恒定。 */
export function stableContextId(identity) {
  if (!identity || typeof identity !== 'object') return null;
  const key = stabilityKey(identity);
  if (key.tabId == null) return null;
  const digest = identity.digest && typeof identity.digest === 'string' ? identity.digest : evidenceDigest(key);
  return 'ctx-' + digest;
}

/** 直接由 tab + 记录推导稳定 contextId（调用方不用自己拼身份）。 */
export function contextIdFor(tabId, record, extra = {}) {
  const identity = contextIdentityOf(tabId, record, extra);
  return identity ? stableContextId(identity) : null;
}

/**
 * 两个上下文身份是否可复用同一个 contextId：
 *   - 兼容目标 target 策略在 epoch 未变时复用 previous context id；
 *   - strict 每次 sync 都是新观察基线（不复用语义，但仍给出确定性 id 便于对账）。
 */
export function contextReusable(previousIdentity, nextIdentity, policy) {
  const normalized = normalizeControlPolicy(policy);
  if (normalized !== CONTROL_POLICY.TARGET) return false;
  if (!previousIdentity || !nextIdentity) return false;
  const a = stabilityKey(previousIdentity);
  const b = stabilityKey(nextIdentity);
  return ['tabId', 'documentId', 'documentEpoch', 'revision', 'controlRevision', 'authorityRevision', 'frameId'].every((field) => a[field] === b[field]);
}

/** 上下文身份差异（换代时给出“哪一维变了”的证据）。 */
export function contextIdentityDiff(previousIdentity, nextIdentity) {
  const fields = ['tabId', 'documentId', 'documentEpoch', 'revision', 'controlRevision', 'authorityRevision', 'frameEpoch', 'epoch', 'generation'];
  const changed = [];
  const before = previousIdentity || {};
  const after = nextIdentity || {};
  for (const field of fields) {
    if (before[field] !== after[field]) changed.push({ field, before: before[field], after: after[field] });
  }
  return { changed, stable: changed.filter((entry) => ['tabId', 'documentId', 'documentEpoch', 'revision', 'controlRevision', 'authorityRevision'].includes(entry.field)).length === 0 };
}

// ---------------------------------------------------------------------------
// 租约 epoch / passthrough token ↔ context 双向映射
// ---------------------------------------------------------------------------

/** 租约 epoch 向量：把四项 revision + epoch/generation 一次读全（只读）。 */
export function leaseEpochOf(record) {
  const rec = isPlainObject(record) ? record : {};
  return {
    epoch: num(rec.epoch),
    frameEpoch: num(rec.frameEpoch),
    controlRevision: num(rec.controlRevision),
    authorityRevision: num(rec.authorityRevision),
    revision: num(rec.revision),
    documentEpoch: num(rec.documentEpoch),
    generation: num(rec.generation),
  };
}

/**
 * 一条租约 ↔ 一个 context 的双向绑定证据（token 打码）。
 * @param {{tabId?:number, contextId?:string, token?:string, tokenMasked?:string,
 *          leaseId?:string, epoch?:number|object, policy?:string, at?:number}} input
 */
export function leaseContextBinding(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const tabId = normalizeCooperationTabId(source.tabId);
  const contextId = source.contextId == null ? null : clip(String(source.contextId), 96);
  const token = source.tokenMasked != null ? clip(String(source.tokenMasked), 32) : maskTokenSafe(source.token);
  if (tabId == null && !contextId && !token) return null;
  const epochValue = isPlainObject(source.epoch) ? leaseEpochOf(source.epoch) : num(source.epoch);
  const body = {
    tabId,
    contextId: contextId || null,
    token: token || null,
    leaseId: source.leaseId == null ? null : clip(String(source.leaseId), 64),
    epoch: epochValue,
    policy: normalizeControlPolicy(source.policy),
    at: num(source.at),
  };
  return { ...body, digest: evidenceDigest(body) };
}

/** 反向映射：由绑定证据取回 (token → contextId) / (contextId → token) 两侧。 */
export function reverseLeaseContextBinding(binding) {
  const source = isPlainObject(binding) ? binding : {};
  return {
    token: source.token || null,
    contextId: source.contextId || null,
    epoch: source.epoch,
    toContext: source.contextId ? { contextId: source.contextId, token: source.token, epoch: source.epoch } : null,
    toToken: source.token ? { token: source.token, contextId: source.contextId, epoch: source.epoch } : null,
  };
}

/** 双向映射索引：一批绑定 → token→context / context→token 两个索引（有界）。 */
export function indexLeaseContextMappings(bindings, limit = 32) {
  const list = (Array.isArray(bindings) ? bindings : []).filter(Boolean).slice(0, Math.max(1, limit));
  const byToken = new Map();
  const byContext = new Map();
  for (const binding of list) {
    const reverse = reverseLeaseContextBinding(binding);
    if (reverse.token && reverse.contextId) byToken.set(reverse.token, reverse.toContext);
    if (reverse.contextId) {
      const bucket = byContext.get(reverse.contextId) || [];
      if (reverse.token) bucket.push(reverse.toToken);
      byContext.set(reverse.contextId, bucket);
    }
  }
  return { byToken, byContext, count: list.length };
}

// ---------------------------------------------------------------------------
// borrow 确认超时映射（兼容目标 tab borrow --timeout / confirmation_timeout_ms）
// ---------------------------------------------------------------------------

/**
 * 借用确认窗口：兼容目标 `--timeout`（tab.rs:233 默认 60_000）与 `confirmation_timeout_ms`
 * （compatibility.rs:96-104）的本地映射；`--no-confirm` 是废弃兼容位，确认与否由扩展决定。
 * @param {{timeoutMs?:number, timeout?:number, confirmationTimeoutMs?:number,
 *          confirmation_timeout_ms?:number, requestedAt?:number, now?:number,
 *          noConfirm?:boolean, confirmationRequired?:boolean}} [input]
 */
export function confirmationPlan(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const rawTimeout = positive(
    source.confirmationTimeoutMs != null ? source.confirmationTimeoutMs
      : (source.confirmation_timeout_ms != null ? source.confirmation_timeout_ms
        : (source.timeoutMs != null ? source.timeoutMs : source.timeout)),
    DEFAULT_CONFIRMATION_TIMEOUT_MS,
  );
  const timeoutMs = Math.min(Math.max(1, Math.floor(rawTimeout)), MAX_CONFIRMATION_TIMEOUT_MS);
  const now = num(source.now) || Date.now();
  const requestedAt = num(source.requestedAt);
  const deadlineAt = requestedAt > 0 ? requestedAt + timeoutMs : 0;
  const noConfirmProvided = source.noConfirm === true || source.no_confirm === true;
  const plan = {
    ok: true,
    owner: CONTROL_OWNER.HUMAN,
    decision: CONTROL_DECISION.ASK,
    timeoutMs,
    defaultTimeoutMs: DEFAULT_CONFIRMATION_TIMEOUT_MS,
    maxTimeoutMs: MAX_CONFIRMATION_TIMEOUT_MS,
    clamped: rawTimeout !== timeoutMs,
    requestedAt,
    deadlineAt,
    remainingMs: deadlineAt > 0 ? Math.max(0, deadlineAt - now) : timeoutMs,
    expired: deadlineAt > 0 && now > deadlineAt,
    onTimeout: CONTROL_DECISION.DENY,
    timeoutCode: CONTROL_ERROR.BORROW_TIMEOUT,
    deniedCode: 'E_BORROW_DENIED',
    noConfirm: {
      provided: noConfirmProvided,
      deprecated: noConfirmProvided,
      decidedBy: 'extension',
      effect: noConfirmProvided ? 'ignored' : 'absent',
    },
    confirmationRequired: source.confirmationRequired !== false,
  };
  plan.evidence = controlEvidence({
    policy: source.policy,
    contextId: source.contextId,
    epoch: source.epoch,
    owner: CONTROL_OWNER.HUMAN,
    decision: CONTROL_DECISION.ASK,
    reason: CONTROL_REASON.BORROW_CONFIRMATION,
    code: CONTROL_ERROR.BORROW_PENDING,
    deadlineAt,
    timeoutMs,
    at: now,
    window: { state: 'handoff', owner: CONTROL_OWNER.HUMAN, openedAt: requestedAt, closesAt: deadlineAt, widthMs: timeoutMs, remainingMs: plan.remainingMs, expired: plan.expired },
    negotiated: source.negotiated,
  });
  return plan;
}

// ---------------------------------------------------------------------------
// 交接窗口（handoff window）
// ---------------------------------------------------------------------------

/**
 * 交接窗口：controller/handoff 状态 + borrow 确认窗口 → 谁持有控制权、窗口何时关闭。
 * 兼容目标：handoff 期间动作被拒（handoff 不是 agent 态）；borrow 确认 pending = 等人工决定。
 * @param {{controller?:string, handoffState?:string, borrow?:object, policy?:string,
 *          contextId?:string, epoch?:number, now?:number, timeoutMs?:number}} [input]
 */
export function handoffWindow(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const now = num(source.now) || Date.now();
  const controller = clip(source.controller || '', 24);
  const borrow = isPlainObject(source.borrow) ? source.borrow : null;
  const borrowStatus = borrow ? clip(borrow.status || '', 24) : '';
  const policy = normalizeControlPolicy(source.policy);
  const plan = confirmationPlan({
    timeoutMs: borrow && borrow.timeoutMs != null ? borrow.timeoutMs : source.timeoutMs,
    requestedAt: borrow ? borrow.requestedAt : source.requestedAt,
    now,
    policy,
    contextId: source.contextId,
    epoch: source.epoch,
  });
  let state = 'agent';
  let owner = CONTROL_OWNER.AGENT;
  let openedAt = 0;
  let reason = null;
  if (source.handoffState != null) {
    const mapped = handoffWindowFor(source.handoffState, { now, openedAt: source.openedAt, widthMs: plan.timeoutMs });
    state = mapped.handoff ? 'handoff' : (mapped.owner === CONTROL_OWNER.HUMAN ? 'human' : 'agent');
    owner = mapped.owner;
    openedAt = mapped.openedAt;
    reason = 'handback-state';
  } else if (controller === 'held') {
    state = 'human';
    owner = CONTROL_OWNER.HUMAN;
    reason = CONTROL_REASON.HUMAN_HOLD;
  } else if (controller === 'human') {
    state = 'human';
    owner = CONTROL_OWNER.HUMAN;
    reason = CONTROL_REASON.HUMAN_INTERVENTION;
  } else if (controller === 'handoff' || borrowStatus === 'pending') {
    state = 'handoff';
    owner = CONTROL_OWNER.HUMAN;
    openedAt = num(borrow && borrow.requestedAt) || num(source.openedAt) || now;
    reason = CONTROL_REASON.BORROW_CONFIRMATION;
  } else if (controller === 'borrowed') {
    state = 'agent';
    owner = CONTROL_OWNER.AGENT;
    reason = 'borrowed';
  } else if (!controller || controller === 'idle') {
    state = 'idle';
    owner = CONTROL_OWNER.SHARED;
    reason = 'idle';
  }
  const open = state === 'handoff';
  const closesAt = open && openedAt > 0 ? openedAt + plan.timeoutMs : 0;
  const window = {
    state,
    owner,
    open,
    policy,
    openedAt,
    closesAt,
    widthMs: open ? plan.timeoutMs : 0,
    remainingMs: open ? Math.max(0, closesAt - now) : 0,
    expired: open && closesAt > 0 && now > closesAt,
    onTimeout: plan.onTimeout,
    timeoutCode: plan.timeoutCode,
    reason,
    at: now,
  };
  window.evidence = controlEvidence({
    policy,
    contextId: source.contextId,
    epoch: source.epoch,
    owner,
    decision: open ? CONTROL_DECISION.ASK : (owner === CONTROL_OWNER.AGENT ? CONTROL_DECISION.ALLOW : (owner === CONTROL_OWNER.HUMAN ? CONTROL_DECISION.DENY : null)),
    reason,
    code: open ? CONTROL_ERROR.BORROW_PENDING : (owner === CONTROL_OWNER.HUMAN ? CONTROL_ERROR.HUMAN_INTERVENTION : null),
    deadlineAt: closesAt,
    timeoutMs: plan.timeoutMs,
    at: now,
    window: { state, owner, openedAt, closesAt, widthMs: window.widthMs, remainingMs: window.remainingMs, expired: window.expired },
  });
  return window;
}

// ---------------------------------------------------------------------------
// allow / ask / deny 判定（只报告，不处决）
// ---------------------------------------------------------------------------

/**
 * 控制面判定：给出 allow/ask/deny + owner，不改变任何既有动作闸门。
 * @param {{policy?:string, requestedPolicy?:string, sessionPolicy?:string, defaultPolicy?:string,
 *          acknowledged?:boolean, action?:string|'passive', passive?:boolean,
 *          contextId?:string, currentContextId?:string, contextConsumed?:boolean,
 *          observationConsumed?:boolean, observationRequired?:boolean,
 *          humanActive?:boolean, humanCooling?:boolean, borrow?:object, borrowGate?:object,
 *          at?:number, timeoutMs?:number}} input
 */
export function policyDecision(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const negotiated = normalizeControlPolicy(source.sessionPolicy) || normalizeControlPolicy(source.policy);
  const requested = normalizeControlPolicy(source.requestedPolicy);
  const localDefault = normalizeControlPolicy(source.defaultPolicy);
  const effective = negotiated === CONTROL_POLICY.AUTO
    ? (localDefault || CONTROL_POLICY.TARGET)
    : (negotiated || (requested === CONTROL_POLICY.AUTO ? CONTROL_POLICY.TARGET : requested) || localDefault || CONTROL_POLICY.TARGET);
  const rules = policyRules(effective) || CONTROL_POLICY_RULES[CONTROL_POLICY.TARGET];
  const passive = source.action === 'passive' || source.passive === true;
  const at = num(source.at) || Date.now();
  const contextId = source.contextId == null ? null : clip(String(source.contextId), 96);
  const currentContextId = source.currentContextId == null ? null : clip(String(source.currentContextId), 96);
  const base = { policy: effective, requestedPolicy: requested, contextId, owner: rules.owner, at };
  const decide = (decision, owner, code, reason, extra = {}) => ({
    decision,
    owner,
    policy: effective,
    requestedPolicy: requested,
    negotiated: source.negotiated === true,
    code: code || null,
    reason: reason || null,
    evidence: controlEvidence({
      ...base,
      owner,
      decision,
      code,
      reason,
      ...(source.negotiated != null ? { negotiated: source.negotiated === true } : {}),
      ...extra,
      at,
    }),
  });
  if (passive) return decide(CONTROL_DECISION.ALLOW, rules.owner, null, CONTROL_REASON.PASSIVE);
  if (source.acknowledged === false) {
    return decide(CONTROL_DECISION.DENY, CONTROL_OWNER.SHARED, CONTROL_ERROR.UNSUPPORTED, CONTROL_REASON.POLICY_UNACKNOWLEDGED);
  }
  if (source.humanActive === true) {
    return decide(CONTROL_DECISION.DENY, CONTROL_OWNER.HUMAN, CONTROL_ERROR.HUMAN_INTERVENTION, CONTROL_REASON.HUMAN_INTERVENTION, { retryAfterMs: positive(source.retryAfterMs, 0) || null });
  }
  const borrow = isPlainObject(source.borrow) ? source.borrow : null;
  const borrowGate = isPlainObject(source.borrowGate) ? source.borrowGate : null;
  const borrowPending = Boolean(
    (borrow && (borrow.pending === true || borrow.status === 'pending')) ||
    (borrowGate && borrowGate.allowed === false && (borrowGate.status === 'pending' || borrowGate.code === CONTROL_ERROR.BORROW_PENDING || borrowGate.pending === true)),
  );
  if (borrowPending) {
    const plan = confirmationPlan({
      timeoutMs: borrow && borrow.timeoutMs != null ? borrow.timeoutMs : source.timeoutMs,
      requestedAt: borrow ? borrow.requestedAt : null,
      now: at,
      policy: effective,
      contextId,
    });
    return decide(CONTROL_DECISION.ASK, CONTROL_OWNER.HUMAN, CONTROL_ERROR.BORROW_PENDING, CONTROL_REASON.BORROW_CONFIRMATION, {
      deadlineAt: plan.deadlineAt,
      timeoutMs: plan.timeoutMs,
      window: { state: 'handoff', owner: CONTROL_OWNER.HUMAN, openedAt: plan.requestedAt, closesAt: plan.deadlineAt, widthMs: plan.timeoutMs, remainingMs: plan.remainingMs, expired: plan.expired },
    });
  }
  if (rules.requiresContext) {
    if (!contextId && !currentContextId) {
      return decide(CONTROL_DECISION.DENY, CONTROL_OWNER.HUMAN, CONTROL_ERROR.CONTEXT_REQUIRED, CONTROL_REASON.CONTEXT_REQUIRED, { requiresContext: true });
    }
    if (!contextId) {
      return decide(CONTROL_DECISION.DENY, CONTROL_OWNER.HUMAN, CONTROL_ERROR.CONTEXT_REQUIRED, CONTROL_REASON.CONTEXT_REQUIRED, { requiresContext: true, currentContextId });
    }
    if (currentContextId && contextId !== currentContextId) {
      return decide(CONTROL_DECISION.DENY, CONTROL_OWNER.HUMAN, CONTROL_ERROR.CONTEXT_INVALID, CONTROL_REASON.CONTEXT_SUPERSEDED, { currentContextId });
    }
  }
  if (rules.singleUseContext && source.contextConsumed === true) {
    return decide(CONTROL_DECISION.DENY, CONTROL_OWNER.HUMAN, CONTROL_ERROR.CONTEXT_REQUIRED, CONTROL_REASON.CONTEXT_CONSUMED, { singleUse: true });
  }
  if (source.observationRequired === true && source.observationConsumed === true) {
    return decide(CONTROL_DECISION.DENY, CONTROL_OWNER.HUMAN, CONTROL_ERROR.OBSERVATION_REQUIRED, CONTROL_REASON.OBSERVATION_REQUIRED);
  }
  return decide(CONTROL_DECISION.ALLOW, CONTROL_OWNER.AGENT, null, rules.requiresContext ? CONTROL_REASON.CONTEXT_VALID : CONTROL_REASON.POLICY_ALLOWS);
}

// ---------------------------------------------------------------------------
// 条件证据块（contextId / policy / epoch 只在有值时出现）
// ---------------------------------------------------------------------------

/**
 * 条件证据块：只输出调用方真实提供的字段，空输入返回 null（默认输出与旧版逐字节一致）。
 * @param {{contextId?:string, policy?:string, epoch?:number|object, owner?:string, decision?:string,
 *          code?:string|null, reason?:string|null, deadlineAt?:number, timeoutMs?:number,
 *          retryAfterMs?:number|null, window?:object, negotiated?:boolean, source?:string,
 *          binding?:object, at?:number, currentContextId?:string, singleUse?:boolean,
 *          requiresContext?:boolean, observationRequired?:boolean}} input
 */
export function controlEvidence(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const body = { version: CONTROL_EVIDENCE_VERSION };
  const policy = normalizeControlPolicy(source.policy);
  if (policy) body.policy = policy;
  const contextId = source.contextId == null ? null : clip(String(source.contextId), 96);
  if (contextId) body.contextId = contextId;
  const currentContextId = source.currentContextId == null ? null : clip(String(source.currentContextId), 96);
  if (currentContextId) body.currentContextId = currentContextId;
  if (source.epoch != null) body.epoch = isPlainObject(source.epoch) ? leaseEpochOf(source.epoch) : num(source.epoch);
  if (CONTROL_OWNER[String(source.owner || '').toUpperCase()] != null) body.owner = source.owner;
  if (CONTROL_DECISION[String(source.decision || '').toUpperCase()] != null) body.decision = source.decision;
  if (source.negotiated != null) body.negotiated = source.negotiated === true;
  if (source.source) body.source = clip(source.source, 32);
  if (source.code) body.code = clip(source.code, 48);
  if (source.reason) body.reason = clip(source.reason, 48);
  if (source.singleUse === true) body.singleUse = true;
  if (source.requiresContext === true) body.requiresContext = true;
  if (source.observationRequired === true) body.observationRequired = true;
  if (source.deadlineAt != null && num(source.deadlineAt) > 0) {
    body.deadlineAt = num(source.deadlineAt);
    if (num(source.at) > 0) body.deadlineInMs = Math.max(0, body.deadlineAt - num(source.at));
  }
  if (source.timeoutMs != null) body.timeoutMs = num(source.timeoutMs);
  if (source.retryAfterMs != null) body.retryAfterMs = num(source.retryAfterMs);
  if (isPlainObject(source.window)) {
    const window = source.window;
    body.window = {
      state: clip(window.state || '', 24),
      owner: CONTROL_OWNER[String(window.owner || '').toUpperCase()] != null ? window.owner : null,
      openedAt: num(window.openedAt),
      closesAt: num(window.closesAt),
      widthMs: num(window.widthMs),
      remainingMs: num(window.remainingMs),
      expired: window.expired === true,
    };
  }
  if (isPlainObject(source.binding)) body.binding = source.binding;
  if (Object.keys(body).length <= 1) return null;
  body.at = num(source.at) || 0;
  return body;
}

/** 条件附加：controlEvidence 为 null 时原样返回（旧输出不变）。 */
export function attachControlEvidence(target, evidence) {
  if (!isPlainObject(target) || !evidence) return target;
  return { ...target, control: evidence };
}

/** 一行文本摘要（诊断/CLI 可读）。 */
export function describeControl(control) {
  if (!control || typeof control !== 'object') return 'control: 无证据';
  const parts = [];
  if (control.policy) parts.push('policy=' + control.policy);
  if (control.owner) parts.push('owner=' + control.owner);
  if (control.decision) parts.push('decision=' + control.decision);
  if (control.contextId) parts.push('context=' + control.contextId);
  if (control.epoch != null && !isPlainObject(control.epoch)) parts.push('epoch=' + control.epoch);
  if (control.window && control.window.state) parts.push('window=' + control.window.state);
  if (control.code) parts.push('code=' + control.code);
  return parts.length ? parts.join(' ') : 'control: 无证据';
}
