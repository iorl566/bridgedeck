// M6 P0③ 控制面语义单测：context_id / control_policy / allow-ask-deny / handoff 窗口 /
// borrow 确认超时 / token ↔ context 双向映射。全部是真实模块 + 注入时钟，不复制实现。
//
// BSK 对照位置（实现里已注明）：crates/bsk-protocol/src/tools/cooperate.rs:29,36-43；
// crates/bsk-cli/src/cli/cooperate.rs:52-54,86-92,180-201；crates/bsk-protocol/src/compatibility.rs:139-145；
// crates/bsk-cli/src/cli/tab.rs:233；apps/extension/src/cooperation/controller.ts:795-830,1023-1035。
import test from 'node:test';
import assert from 'node:assert/strict';

const listener = () => ({ addListener() {}, removeListener() {}, hasListener: () => false });
globalThis.chrome = {
  runtime: { getManifest: () => ({ version: '0.3.0' }), onMessage: listener(), onConnect: listener(), onInstalled: listener(), onStartup: listener(), sendMessage: async () => ({}), getURL: (p) => 'chrome-extension://stub/' + p, lastError: null },
  storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} }, session: { get: async () => ({}), set: async () => {}, remove: async () => {} }, onChanged: listener() },
  alarms: { create: async () => {}, onAlarm: listener() },
  tabs: { onRemoved: listener(), onUpdated: listener(), onCreated: listener(), onActivated: listener(), query: async () => [], get: async () => null, sendMessage: async () => ({ ok: true }) },
  scripting: { executeScript: async () => [] },
  permissions: { contains: async () => true },
};

const control = await import('../../extension/src/lib/cooperate-control.js');
const {
  CONTROL_POLICY,
  CONTROL_OWNER,
  CONTROL_DECISION,
  CONTROL_ERROR,
  CONTROL_REASON,
  TARGET_CONTROL_PROTOCOL,
  DEFAULT_CONFIRMATION_TIMEOUT_MS,
  MAX_CONFIRMATION_TIMEOUT_MS,
  normalizeControlPolicy,
  normalizeControlAction,
  parseProtocolVersion,
  compareProtocolVersions,
  supportsTargetControl,
  resolvePolicyRequest,
  negotiateControlPolicy,
  acknowledgeControlPolicy,
  policyRules,
  policyOwner,
  contextIdentityOf,
  stableContextId,
  contextIdFor,
  contextReusable,
  contextIdentityDiff,
  leaseEpochOf,
  leaseContextBinding,
  reverseLeaseContextBinding,
  indexLeaseContextMappings,
  confirmationPlan,
  handoffWindow,
  policyDecision,
  controlEvidence,
  attachControlEvidence,
  describeControl,
} = control;
const { createControlPlane } = await import('../../extension/src/lib/cooperate-control-plane.js');

const RECORD = (overrides = {}) => ({
  tabId: 7,
  document: 'https://example.test/form',
  documentEpoch: 1,
  revision: 12,
  controlRevision: 3,
  authorityRevision: 2,
  frameEpoch: 4,
  epoch: 5,
  generation: 6,
  ...overrides,
});

test('control_policy 规整：只接受 auto/strict/target（BSK ControlPolicy 三态，cooperate.rs:36-43）', () => {
  assert.equal(normalizeControlPolicy('auto'), 'auto');
  assert.equal(normalizeControlPolicy('strict'), 'strict');
  assert.equal(normalizeControlPolicy('target'), 'target');
  assert.equal(normalizeControlPolicy('TARGET'), null);
  assert.equal(normalizeControlPolicy(undefined), null);
  assert.equal(normalizeControlAction('cooperate.sync'), 'sync');
  assert.equal(normalizeControlAction('wait'), 'wait');
  assert.equal(normalizeControlAction('handback'), null);
});

test('--policy 只允许 sync/enable；缺省 auto（BSK cli/cooperate.rs:52-54,86-92）', () => {
  const sync = resolvePolicyRequest('sync', undefined);
  assert.equal(sync.ok, true);
  assert.equal(sync.policy, 'auto');
  assert.equal(sync.legacy, true);
  const strict = resolvePolicyRequest('enable', 'strict');
  assert.equal(strict.ok, true);
  assert.equal(strict.policy, 'strict');
  assert.equal(strict.legacy, false);
  const wait = resolvePolicyRequest('wait', 'target');
  assert.equal(wait.ok, false);
  assert.equal(wait.code, CONTROL_ERROR.BAD_ARG);
  assert.match(wait.error, /--policy requires cooperate sync or enable/);
  const status = resolvePolicyRequest('status', undefined);
  assert.equal(status.ok, true);
  assert.equal(status.policy, null, 'status 不携带 control_policy');
  const invalid = resolvePolicyRequest('sync', 'permissive');
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /control_policy must be auto, strict or target/);
});

test('策略协商：auto→target / 保留 strict / 会话内固定（controller.ts:795-830）', () => {
  const fresh = negotiateControlPolicy({ action: 'sync', requestedPolicy: 'auto' });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.policy, 'target');
  assert.equal(fresh.target, true);
  assert.equal(fresh.replyControlPolicy, 'target');
  const keepsStrict = negotiateControlPolicy({ action: 'sync', requestedPolicy: 'auto', sessionPolicy: 'strict' });
  assert.equal(keepsStrict.policy, 'strict');
  assert.equal(keepsStrict.target, false);
  const fixed = negotiateControlPolicy({ action: 'sync', requestedPolicy: 'strict', sessionPolicy: 'target' });
  assert.equal(fixed.ok, false);
  assert.equal(fixed.fixed, true);
  assert.match(fixed.error, /Control policy is fixed for this session/);
  assert.equal(fixed.data.effect_state, 'none');
  // legacy 缺省：请求面没有 policy 时不改变会话策略；本地缺省明确暴露（BridgeDeck target vs BSK strict）。
  const legacy = negotiateControlPolicy({ action: 'sync' });
  assert.equal(legacy.policy, 'target');
  assert.equal(legacy.localDefault, 'target');
  assert.equal(legacy.evidence.legacy, true);
  const bskDefault = negotiateControlPolicy({ action: 'sync', defaultPolicy: 'strict' });
  assert.equal(bskDefault.policy, 'strict');
});

test('协议门：TargetControl 要求协议 1.8+（compatibility.rs:139-145/:198-216）', () => {
  assert.equal(TARGET_CONTROL_PROTOCOL, '1.8');
  assert.deepEqual(parseProtocolVersion('1.8.0'), { major: 1, minor: 8 });
  assert.deepEqual(parseProtocolVersion('2'), { major: 2, minor: 0 });
  assert.equal(parseProtocolVersion(''), null);
  assert.equal(parseProtocolVersion('x.y'), null);
  assert.equal(compareProtocolVersions('1.8', '1.7'), 1);
  assert.equal(compareProtocolVersions('1.8', '1.8.0'), 0);
  for (const supported of ['1.8', '1.8.0', '1.9']) assert.equal(supportsTargetControl(supported), true, supported);
  for (const unsupported of ['', 'invalid', '1.0', '1.7', '2.0']) assert.equal(supportsTargetControl(unsupported), false, unsupported);
});

test('policy 回执：target 必须被回执，auto 接受 target|strict，strict/legacy 不拦（cooperate.rs:180-201）', () => {
  const rejected = acknowledgeControlPolicy({ context_id: 'ctx-1', control_policy: 'strict' }, 'target');
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, CONTROL_ERROR.UNSUPPORTED);
  assert.equal(rejected.data.reason, 'unsupported_feature');
  assert.equal(rejected.data.phase, 'negotiate');
  assert.equal(rejected.data.effect_state, 'none');
  assert.equal(rejected.data.required_protocol, '1.8');
  assert.equal(rejected.data.requested_policy, 'target');
  assert.equal(acknowledgeControlPolicy({ context_id: 'ctx-1', control_policy: 'target' }, 'target').ok, true);
  assert.equal(acknowledgeControlPolicy({ context_id: 'ctx-1', control_policy: 'strict' }, 'auto').ok, true);
  assert.equal(acknowledgeControlPolicy({ context_id: 'ctx-1', control_policy: 'target' }, 'auto').ok, true);
  assert.equal(acknowledgeControlPolicy({ context_id: 'ctx-1' }, 'auto').ok, false, 'auto 需要回执');
  assert.equal(acknowledgeControlPolicy({ ready: false }, 'target').ok, true, '未 ready 的应答不携带授权');
  assert.equal(acknowledgeControlPolicy({ context_id: 'legacy' }, 'strict').ok, true, 'strict 接受 legacy 应答');
});

test('policy 规则表：owner / requiresContext / strict 单次消费', () => {
  assert.equal(policyOwner('auto'), CONTROL_OWNER.SHARED);
  assert.equal(policyOwner('strict'), CONTROL_OWNER.AGENT);
  assert.equal(policyOwner('target'), CONTROL_OWNER.AGENT);
  assert.equal(policyRules('target').requiresContext, true);
  assert.equal(policyRules('target').singleUseContext, false);
  assert.equal(policyRules('strict').requiresContext, false);
  assert.equal(policyRules('strict').singleUseContext, true);
  assert.equal(policyRules('nope'), null);
});

test('context_id：稳定确定性标识，与 documentId/frame/revision/control generation 关联', () => {
  const identity = contextIdentityOf(7, RECORD(), { frameId: 2 });
  assert.equal(identity.tabId, 7);
  assert.equal(identity.documentId, 'https://example.test/form');
  assert.equal(identity.frameId, 2);
  assert.equal(identity.generation, 6);
  assert.equal(identity.epoch, 5);
  const first = stableContextId(identity);
  assert.match(first, /^ctx-[0-9a-f]{8}$/);
  assert.equal(stableContextId(contextIdentityOf(7, RECORD(), { frameId: 2 })), first, '同一上下文恒定');
  assert.notEqual(stableContextId(contextIdentityOf(7, RECORD({ revision: 13 }), { frameId: 2 })), first, 'revision 变化换代');
  assert.notEqual(stableContextId(contextIdentityOf(7, RECORD({ document: 'https://example.test/next' }), { frameId: 2 })), first, '文档变化换代');
  assert.notEqual(stableContextId(contextIdentityOf(7, RECORD({ controlRevision: 4 }), { frameId: 2 })), first, '控制权变化换代');
  assert.equal(contextIdFor(7, RECORD(), { frameId: 2 }), first);
  assert.equal(contextIdentityOf(null, RECORD()), null);
});

test('context 复用：target 在身份未变时复用；strict 不复用（controller.ts:1025-1028）', () => {
  const a = contextIdentityOf(8, RECORD({ tabId: 8 }));
  const b = contextIdentityOf(8, RECORD({ tabId: 8 }));
  const changed = contextIdentityOf(8, RECORD({ tabId: 8, revision: 99 }));
  assert.equal(contextReusable(a, b, 'target'), true);
  assert.equal(contextReusable(a, b, 'strict'), false);
  assert.equal(contextReusable(a, changed, 'target'), false);
  const diff = contextIdentityDiff(a, changed);
  assert.equal(diff.stable, false);
  assert.equal(diff.changed.some((entry) => entry.field === 'revision'), true);
  assert.equal(contextIdentityDiff(a, b).stable, true);
});

test('租约 epoch 向量 + token ↔ context 双向映射（token 打码）', () => {
  const epoch = leaseEpochOf(RECORD());
  assert.deepEqual(epoch, { epoch: 5, frameEpoch: 4, controlRevision: 3, authorityRevision: 2, revision: 12, documentEpoch: 1, generation: 6 });
  const binding = leaseContextBinding({ tabId: 9, contextId: 'ctx-abc12345', token: 'tok-0123456789abcdef', leaseId: 'l-1', epoch, policy: 'target', at: 100 });
  assert.equal(binding.contextId, 'ctx-abc12345');
  assert.equal(binding.token, 'tok-01…abcdef');
  const reverse = reverseLeaseContextBinding(binding);
  assert.equal(reverse.toContext.contextId, 'ctx-abc12345');
  assert.equal(reverse.toToken.token, 'tok-01…abcdef');
  const index = indexLeaseContextMappings([binding]);
  assert.equal(index.byToken.get('tok-01…abcdef').contextId, 'ctx-abc12345');
  assert.equal(index.byContext.get('ctx-abc12345')[0].token, 'tok-01…abcdef');
});

test('borrow 确认超时映射：默认 60s / 覆盖 / 上限 / --no-confirm 废弃位 / 超时 deny', () => {
  const fallback = confirmationPlan({ now: 1000 });
  assert.equal(fallback.timeoutMs, DEFAULT_CONFIRMATION_TIMEOUT_MS);
  assert.equal(fallback.timeoutMs, 60000, 'BSK tab borrow --timeout 默认 60s（tab.rs:233）');
  assert.equal(fallback.owner, CONTROL_OWNER.HUMAN);
  assert.equal(fallback.decision, CONTROL_DECISION.ASK);
  assert.equal(fallback.onTimeout, CONTROL_DECISION.DENY);
  assert.equal(fallback.timeoutCode, CONTROL_ERROR.BORROW_TIMEOUT);
  const explicit = confirmationPlan({ timeout: 5000, requestedAt: 1000, now: 2000 });
  assert.equal(explicit.timeoutMs, 5000);
  assert.equal(explicit.deadlineAt, 6000);
  assert.equal(explicit.remainingMs, 4000);
  assert.equal(explicit.expired, false);
  assert.equal(confirmationPlan({ timeoutMs: 10, requestedAt: 1000, now: 5000 }).expired, true);
  assert.equal(confirmationPlan({ confirmation_timeout_ms: 3000 }).timeoutMs, 3000);
  assert.equal(confirmationPlan({ timeoutMs: MAX_CONFIRMATION_TIMEOUT_MS * 10 }).timeoutMs, MAX_CONFIRMATION_TIMEOUT_MS);
  const noConfirm = confirmationPlan({ noConfirm: true });
  assert.equal(noConfirm.noConfirm.provided, true);
  assert.equal(noConfirm.noConfirm.deprecated, true);
  assert.equal(noConfirm.noConfirm.decidedBy, 'extension');
  // 证据块带 contextId/policy/epoch（条件字段）。
  const evidence = confirmationPlan({ policy: 'target', contextId: 'ctx-1', epoch: 3 }).evidence;
  assert.equal(evidence.contextId, 'ctx-1');
  assert.equal(evidence.policy, 'target');
  assert.equal(evidence.epoch, 3);
});

test('交接窗口：pending → handoff/human；human/held → human；borrowed/idle 各自 owner', () => {
  const pending = handoffWindow({ controller: 'handoff', borrow: { status: 'pending', requestedAt: 1000, timeoutMs: 60000 }, policy: 'target', now: 5000 });
  assert.equal(pending.state, 'handoff');
  assert.equal(pending.owner, CONTROL_OWNER.HUMAN);
  assert.equal(pending.open, true);
  assert.equal(pending.closesAt, 61000);
  assert.equal(pending.remainingMs, 56000);
  assert.equal(pending.onTimeout, 'deny');
  assert.equal(handoffWindow({ controller: 'human', now: 1 }).owner, CONTROL_OWNER.HUMAN);
  assert.equal(handoffWindow({ controller: 'held', now: 1 }).owner, CONTROL_OWNER.HUMAN);
  assert.equal(handoffWindow({ controller: 'borrowed', now: 1 }).owner, CONTROL_OWNER.AGENT);
  assert.equal(handoffWindow({ controller: 'agent', now: 1 }).owner, CONTROL_OWNER.AGENT);
  assert.equal(handoffWindow({ controller: 'idle', now: 1 }).owner, CONTROL_OWNER.SHARED);
  // 我方 handback 状态机 → 同一个 owner 语义（human-handoff.js 映射）。
  const handback = handoffWindow({ handoffState: 'handback-pending', openedAt: 2000, now: 3000 });
  assert.equal(handback.state, 'handoff');
  assert.equal(handback.owner, CONTROL_OWNER.HUMAN);
  assert.equal(handback.closesAt, 62000);
});

test('allow/ask/deny：target 上下文有效 allow、缺失/过期 deny、借用确认 ask、人机 deny', () => {
  const allow = policyDecision({ policy: 'target', contextId: 'ctx-1', currentContextId: 'ctx-1' });
  assert.equal(allow.decision, CONTROL_DECISION.ALLOW);
  assert.equal(allow.owner, CONTROL_OWNER.AGENT);
  assert.equal(allow.reason, CONTROL_REASON.CONTEXT_VALID);
  const missing = policyDecision({ policy: 'target' });
  assert.equal(missing.decision, CONTROL_DECISION.DENY);
  assert.equal(missing.owner, CONTROL_OWNER.HUMAN);
  assert.equal(missing.code, CONTROL_ERROR.CONTEXT_REQUIRED);
  const stale = policyDecision({ policy: 'target', contextId: 'ctx-old', currentContextId: 'ctx-new' });
  assert.equal(stale.decision, CONTROL_DECISION.DENY);
  assert.equal(stale.code, CONTROL_ERROR.CONTEXT_INVALID);
  assert.equal(stale.reason, CONTROL_REASON.CONTEXT_SUPERSEDED);
  const ask = policyDecision({ policy: 'target', contextId: 'ctx-1', currentContextId: 'ctx-1', borrow: { status: 'pending', requestedAt: 1000, timeoutMs: 60000 }, at: 2000 });
  assert.equal(ask.decision, CONTROL_DECISION.ASK);
  assert.equal(ask.owner, CONTROL_OWNER.HUMAN);
  assert.equal(ask.code, CONTROL_ERROR.BORROW_PENDING);
  assert.equal(ask.evidence.deadlineAt, 61000);
  const human = policyDecision({ policy: 'target', contextId: 'ctx-1', currentContextId: 'ctx-1', humanActive: true });
  assert.equal(human.decision, CONTROL_DECISION.DENY);
  assert.equal(human.code, CONTROL_ERROR.HUMAN_INTERVENTION);
  const unacked = policyDecision({ policy: 'target', contextId: 'ctx-1', currentContextId: 'ctx-1', acknowledged: false });
  assert.equal(unacked.decision, CONTROL_DECISION.DENY);
  assert.equal(unacked.owner, CONTROL_OWNER.SHARED);
  assert.equal(unacked.code, CONTROL_ERROR.UNSUPPORTED);
  const passive = policyDecision({ policy: 'target', action: 'passive' });
  assert.equal(passive.decision, CONTROL_DECISION.ALLOW, '被动读取不评估控制面条件（cooperate.rs:45-47）');
  const consumed = policyDecision({ policy: 'strict', contextId: 'ctx-1', contextConsumed: true });
  assert.equal(consumed.decision, CONTROL_DECISION.DENY);
  assert.equal(consumed.reason, CONTROL_REASON.CONTEXT_CONSUMED);
});

test('条件证据块：空输入返回 null；contextId/policy/epoch 只在有值时出现', () => {
  assert.equal(controlEvidence({}), null);
  assert.equal(controlEvidence(), null);
  const block = controlEvidence({ contextId: 'ctx-1', policy: 'target', epoch: 4, owner: 'human', decision: 'ask', code: 'E_BORROW_CONFLICT', deadlineAt: 1000, at: 400, window: { state: 'handoff', owner: 'human', openedAt: 0, closesAt: 1000, widthMs: 600, remainingMs: 600, expired: false } });
  assert.equal(block.contextId, 'ctx-1');
  assert.equal(block.policy, 'target');
  assert.equal(block.epoch, 4);
  assert.equal(block.owner, 'human');
  assert.equal(block.decision, 'ask');
  assert.equal(block.deadlineInMs, 600);
  assert.equal(block.window.state, 'handoff');
  assert.equal(Object.prototype.hasOwnProperty.call(controlEvidence({ owner: 'agent' }), 'contextId'), false, '没有 contextId 时不出现该字段');
  assert.equal(attachControlEvidence({ a: 1 }, null).a, 1);
  assert.equal(attachControlEvidence({ a: 1 }, block).control, block);
  assert.match(describeControl(block), /policy=target owner=human decision=ask/);
});

test('控制面登记簿：policy/observe/snapshot 有界且只读', () => {
  let clock = 1000;
  const plane = createControlPlane({ now: () => clock, maxTabs: 2, maxLeases: 2, revisionRecord: (tabId) => RECORD({ tabId }) });
  assert.equal(plane.policyFor(7).negotiated, false);
  assert.equal(plane.policyFor(7).policy, 'auto');
  plane.notePolicy(7, 'target', { source: 'test' });
  assert.equal(plane.policyFor(7).policy, 'target');
  assert.equal(plane.isNegotiated(7), true);
  const first = plane.observe(7);
  assert.equal(first.contextId, contextIdFor(7, RECORD({ tabId: 7 })));
  clock += 5;
  const second = plane.observe(7);
  assert.equal(second.contextId, first.contextId, 'target 策略身份未变 → 复用');
  assert.equal(second.reused, true);
  const snapshot = plane.snapshot(7);
  assert.equal(snapshot.contextId, first.contextId);
  assert.equal(snapshot.policy, 'target');
  assert.equal(snapshot.owner, CONTROL_OWNER.AGENT);
  assert.equal(typeof snapshot.epoch, 'number');
  assert.equal(typeof snapshot.digest, 'string');
  plane.consumeContext(7);
  assert.equal(plane.isConsumed(7), true);
  assert.equal(plane.snapshot(7).owner, CONTROL_OWNER.HUMAN);
  plane.resetConsumed(7);
  assert.equal(plane.isConsumed(7), false);
  // 有界：超过 maxTabs 驱逐最旧。
  plane.observe(8);
  plane.observe(9);
  assert.equal(plane.counters().tabs <= 2, true);
  assert.equal(plane.forget(7), true);
  assert.equal(plane.counters().tabs <= 2, true);
});

test('登记簿 token↔context：bindLease/releaseLease/contextForToken/tokensForContext', () => {
  const plane = createControlPlane({ now: () => 1000, revisionRecord: (tabId) => RECORD({ tabId }) });
  plane.notePolicy(5, 'target');
  const binding = plane.bindLease({ tabId: 5, token: 'tok-aaaabbbbcccc', leaseId: 'l-5', epoch: RECORD() });
  assert.equal(binding.contextId, plane.snapshot(5).contextId);
  const byToken = plane.contextForToken('tok-aaaabbbbcccc');
  assert.equal(byToken.contextId, binding.contextId);
  assert.equal(byToken.active, true);
  const tokens = plane.tokensForContext(binding.contextId);
  assert.equal(tokens.length, 1);
  assert.match(tokens[0].token, /…/);
  assert.equal(plane.contextForToken('missing'), null);
  const released = plane.releaseLease('tok-aaaabbbbcccc');
  assert.equal(released.leaseId, 'l-5');
  assert.equal(plane.contextForToken('tok-aaaabbbbcccc'), null, '释放后双向映射同时解除');
  assert.equal(plane.tokensForContext(binding.contextId).length, 0);
});
