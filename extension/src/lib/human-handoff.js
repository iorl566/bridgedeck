// src/lib/human-handoff.js —— handback 状态机的迁移表与查询（纯数据，无副作用）。
//
// 从 cooperate.js 拆出的 handback 契约：状态/事件/迁移表/规则索引。
// 调度器（cooperate.js）只负责“什么时候推进、推进后把哪些计数落到 revision-chain”，
// 这里保证“哪些迁移合法、拒绝时给调用方哪些可选事件”。
//
// 状态：idle → human-active → handback-pending → handback-done → agent-active
// 任意状态可 reset；handback-aborted 是 abort 后的显式终态（还能被人工/Agent 重新认领）。
// bumps 声明这次迁移推进哪些四项计数（controlRevision/authorityRevision/frameEpoch），
// 真正写链由 control-generation.bumpRevisions（revision-chain 唯一写入口）完成。

export const HANDOFF_STATES = Object.freeze({
  IDLE: 'idle',
  AGENT: 'agent-active',
  HUMAN: 'human-active',
  PENDING: 'handback-pending',
  DONE: 'handback-done',
  ABORTED: 'handback-aborted',
});

export const HANDOFF_EVENTS = Object.freeze({
  AGENT_CLAIM: 'agent.claim',
  HUMAN_TAKE: 'human.take',
  HANDOFF_REQUEST: 'handback.request',
  HANDOFF_COMPLETE: 'handback.complete',
  HANDOFF_ABORT: 'handback.abort',
  HANDOFF_FORCE: 'handback.force',
  RESET: 'reset',
});

export const HANDOFF_TRANSITIONS = Object.freeze([
  { from: ['idle'], event: 'agent.claim', to: 'agent-active', bumps: ['controlRevision'] },
  { from: ['idle'], event: 'human.take', to: 'human-active', bumps: ['controlRevision', 'authorityRevision'] },
  { from: ['agent-active'], event: 'human.take', to: 'human-active', bumps: ['controlRevision', 'authorityRevision'] },
  { from: ['human-active'], event: 'handback.request', to: 'handback-pending', bumps: ['controlRevision'] },
  { from: ['human-active'], event: 'handback.complete', to: 'handback-done', bumps: ['controlRevision'] },
  { from: ['human-active'], event: 'handback.force', to: 'agent-active', bumps: ['controlRevision'] },
  { from: ['handback-pending'], event: 'handback.complete', to: 'handback-done', bumps: ['controlRevision'] },
  { from: ['handback-pending'], event: 'handback.abort', to: 'handback-aborted', bumps: ['controlRevision', 'authorityRevision'] },
  { from: ['handback-pending'], event: 'human.take', to: 'human-active', bumps: ['controlRevision', 'authorityRevision'] },
  { from: ['handback-done'], event: 'agent.claim', to: 'agent-active', bumps: ['controlRevision'] },
  { from: ['handback-done'], event: 'human.take', to: 'human-active', bumps: ['controlRevision', 'authorityRevision'] },
  { from: ['handback-aborted'], event: 'human.take', to: 'human-active', bumps: ['controlRevision', 'authorityRevision'] },
  { from: ['handback-aborted'], event: 'agent.claim', to: 'agent-active', bumps: ['controlRevision'] },
  { from: Object.values(HANDOFF_STATES), event: 'reset', to: 'idle', bumps: ['controlRevision'] },
]);

const RULE_INDEX = new Map();
for (const rule of HANDOFF_TRANSITIONS) {
  for (const from of rule.from) {
    const key = from + '|' + rule.event;
    if (RULE_INDEX.has(key)) throw new Error('handback 迁移表重复：' + key);
    RULE_INDEX.set(key, rule);
  }
}

/** 查一次迁移规则；非法组合返回 null（调用方给拒绝证据，绝不静默通过）。 */
export function handoffRuleFor(fromState, event) {
  return RULE_INDEX.get(String(fromState) + '|' + String(event)) || null;
}

/** 当前状态允许的事件（拒绝证据里给调用方自我修复用）。 */
export function handoffAllowedEvents(fromState) {
  return HANDOFF_TRANSITIONS
    .filter((rule) => rule.from.includes(fromState))
    .map((rule) => rule.event);
}

/** 迁移表快照（只读，供单测/文档审计确认没有重复或悬空规则）。 */
export function handoffTransitionTable() {
  return HANDOFF_TRANSITIONS.map((rule) => ({ from: rule.from.slice(), event: rule.event, to: rule.to, bumps: rule.bumps.slice() }));
}

// ---------------------------------------------------------------------------
// 交接窗口的控制权 owner 语义（与 兼容目标 cooperate control_policy 对齐的加法字段）
//
// 兼容目标 证据：cooperate.rs:36-43 ControlPolicy；controller.ts:795-830 policy 固定/auto→target；
// cli/cooperate.rs:180-201 sync 回执；tab.rs:233 borrow 确认窗口默认 60s。
// 这里只给既有 handback 状态补“谁持有控制权、窗口何时关闭”，不改变迁移表与判定。
// ---------------------------------------------------------------------------

/** 交接状态下控制权 owner：idle=shared；agent 态=agent；human/pending/aborted=human。 */
export const HANDOFF_OWNER = Object.freeze({
  [HANDOFF_STATES.IDLE]: 'shared',
  [HANDOFF_STATES.AGENT]: 'agent',
  [HANDOFF_STATES.HUMAN]: 'human',
  [HANDOFF_STATES.PENDING]: 'human',
  [HANDOFF_STATES.DONE]: 'agent',
  [HANDOFF_STATES.ABORTED]: 'human',
});

/** 兼容目标 `tab borrow --timeout` 默认 60s（tab.rs:233）；handback-pending 的窗口宽度默认同值。 */
export const DEFAULT_HANDOFF_WINDOW_MS = 60000;

/** 状态 → owner（非法状态回退 shared，绝不抛异常）。 */
export function handoffOwner(state) {
  return HANDOFF_OWNER[String(state)] || 'shared';
}

/**
 * 交接窗口：只对 handback-pending 打开；给出 openedAt/closesAt/remainingMs/expired。
 * @param {string} state HANDOFF_STATES 之一
 * @param {{openedAt?:number, widthMs?:number, now?:number}} [options]
 */
export function handoffWindowFor(state, options = {}) {
  const normalized = String(state == null ? '' : state);
  const owner = handoffOwner(normalized);
  const open = normalized === HANDOFF_STATES.PENDING;
  const widthMs = Math.max(0, Math.floor(Number(options.widthMs) > 0 ? Number(options.widthMs) : DEFAULT_HANDOFF_WINDOW_MS));
  const openedAt = Math.max(0, Number(options.openedAt) || 0);
  const now = Math.max(0, Number(options.now) || openedAt);
  const closesAt = open && openedAt > 0 ? openedAt + widthMs : 0;
  return {
    state: normalized || HANDOFF_STATES.IDLE,
    owner,
    handoff: open,
    open,
    openedAt,
    closesAt,
    widthMs: open ? widthMs : 0,
    remainingMs: open ? Math.max(0, closesAt - now) : 0,
    expired: open && closesAt > 0 && now > closesAt,
    at: now,
  };
}
