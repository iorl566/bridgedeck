// src/control.js —— 共享控制：sync 产出 context/observation，动作校验与失效
import { bridgeError } from './errors.js';
import { execPage } from './inject.js';
import { getHumanState } from './human-state.js';
import { log } from './log.js';
import { sleep } from './tabs.js';
import { getTakeoverState, resumeTakeover, setTakeoverState } from './takeover.js';
import { cooperationControllerSnapshot, readCooperationFrames, registerControllerSource, setCooperationBlocked } from './cooperation.js';
import { readSettings } from './settings.js';
import { getTabPolicy } from './tab-policy.js';
import { bumpControlGeneration, bumpRevisions, controlGeneration, controlGenerationRecord, observeControlRevisions } from './control-generation.js';
import { buildAuthority } from './lib/authority.js';
import { diffNodeSignatures, summarizeNodeSignatures } from './lib/node-signature.js';
import { controllerState, transitionBumps } from './lib/controller-state.js';
import { borrowGate } from './lib/borrow-confirm.js';
import { describeHumanInput } from './lib/attribution-evidence.js';
import { readControlledTabs } from './controlled-tabs.js';

const TAB_METHODS = new Set([
  'click', 'click-backend', 'click-point', 'shadow.click', 'hover', 'fill', 'press', 'select', 'focus', 'blur', 'scroll-to',
  'drag', 'wheel', 'evaluate', 'upload', 'download',
]);

const states = new Map(); // tabId -> { policy, contextId, observationId, generation, strictUsed }

function foldObservation(text, needle, contextLines) {
  if (!needle) return text;
  const lines = String(text || '').split('\n');
  const context = Math.min(Math.max(Number(contextLines) || 0, 0), 20);
  const keep = new Set();
  const lowered = String(needle).toLowerCase();
  lines.forEach((line, index) => {
    if (!line.toLowerCase().includes(lowered)) return;
    for (let offset = -context; offset <= context; offset += 1) {
      const target = index + offset;
      if (target >= 0 && target < lines.length) keep.add(target);
    }
  });
  if (!keep.size) return text;
  const out = [];
  let omitted = 0;
  lines.forEach((line, index) => {
    if (keep.has(index)) {
      if (omitted) {
        out.push('… (' + omitted + ' lines omitted)');
        omitted = 0;
      }
      out.push(line);
    } else {
      omitted += 1;
    }
  });
  if (omitted) out.push('… (' + omitted + ' lines omitted)');
  return out.join('\n');
}

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(16).slice(2);
}

function ensure(tabId) {
  let state = states.get(tabId);
  if (!state) {
    state = { policy: 'target', contextId: null, observationId: null, generation: 0, strictUsed: new Set(), refSignatures: new Map() };
    states.set(tabId, state);
  }
  return state;
}

// takeover 的显示状态由 takeover.js 持有；通过注册读取避免 cooperation ↔ takeover 循环依赖。
registerControllerSource('takeover', (tabId) => getTakeoverState(tabId));

/** 把 controller 迁移表声明的 bumps 落到 revision-chain（四项计数的唯一写入口）。 */
function applyTransitionBumps(tabId, moved) {
  const delta = transitionBumps(moved);
  if (!Object.keys(delta).length) return null;
  return bumpRevisions(tabId, delta);
}

/**
 * 把外部事实（暂停/借用/会话）对齐进 controller 状态机，并按迁移表推进计数。
 * 迁移被拒时只记日志与证据（deny-by-default），不把状态硬翻过去。
 */
function syncControllerState(tabId, facts = {}) {
  const source = String(facts.source || 'control');
  const held = facts.held === true;
  const borrowed = facts.borrowed === true;
  const current = controllerState.get(tabId);
  let moved;
  if (held) {
    moved = controllerState.transition(tabId, 'hold.engage', { source, reason: facts.reason });
  } else if (current === 'held') {
    moved = controllerState.transition(tabId, 'hold.release', { source });
  } else if (current == null || current === 'idle') {
    // service worker 重启后 controller 状态丢失：借用中的 tab 用 adopt 恢复 borrowed，
    // 其余按 Agent 会话认领恢复（不伪造一次陌生迁移）。
    moved = borrowed
      ? controllerState.adopt(tabId, 'borrowed', { event: 'sync.restore', source })
      : controllerState.transition(tabId, 'agent.claim', { source, hasSession: facts.hasSession !== false });
  } else {
    moved = controllerState.transition(tabId, 'agent.claim', { source, hasSession: facts.hasSession !== false });
  }
  if (moved && moved.ok) applyTransitionBumps(tabId, moved);
  else if (moved && moved.evidence) log('controller 迁移被拒绝：tab=' + tabId + ' code=' + moved.code + ' ' + current + ' -[' + 'agent.claim' + ']-> ' + (moved.evidence.to || '?'));
  return moved;
}

/** 人工介入：状态切到 human 并撤销动作许可（authorityRevision 由迁移表推进）。 */
function noteHumanControl(tabId, facts = {}) {
  const current = controllerState.get(tabId);
  if (current === 'held') return { ok: false, skipped: 'held', state: current };
  const moved = controllerState.transition(tabId, 'human.take', { source: facts.source || 'human-input', humanAt: facts.humanAt });
  if (moved && moved.ok) applyTransitionBumps(tabId, moved);
  return moved;
}

/** cooperate.hold：显式人工接管/交回；held 时 TAB_METHODS 会被 E_SESSION_PAUSED 拒绝。 */
export async function cooperateHold(params = {}) {
  const tabId = params.tabId;
  if (!Number.isInteger(tabId)) throw bridgeError('E_BAD_ARG', 'cooperate.hold 需要 tabId');
  const held = params.held === true;
  ensure(tabId);
  setTakeoverState(tabId, { paused: held });
  const moved = syncControllerState(tabId, { held, source: 'cooperate.hold' });
  bumpRevisions(tabId, { epoch: 1 });
  const settings = await readSettings().catch(() => null);
  if (settings && settings.cooperationGuard === true) {
    void setCooperationBlocked(tabId, !held, controlGeneration(tabId));
  }
  log('cooperate hold tab=' + tabId + ' held=' + held + ' controller=' + controllerState.get(tabId));
  const snapshot = cooperationControllerSnapshot(tabId);
  return {
    ok: true,
    held,
    controller: snapshot.controller,
    toolbar: snapshot.toolbar,
    revisions: snapshot.revisions,
    evidence: moved && moved.evidence ? moved.evidence : null,
  };
}

const NODE_SCOPE_READ_METHODS = new Set(['read', 'get-html']);

/**
 * 读取类/动作的观察代际校验：observation token 或 strict context 要求 DOM 未变。
 *
 * `nodeScope: true` + `ref`（且该 ref 在 sync 时记录过节点签名）时走**节点级**校验：
 * - 目标节点已不在文档里 → `E_TARGET_DETACHED`；
 * - 目标节点自身的文本/值/属性/状态变了 → `E_OBSERVATION_CHANGED`（`observed_changes.scope='node'`）；
 * - 只是页面其他部分变了 → 放行（这正是节点级校验的价值）。
 * 目标不是 ref 或没有签名时回退到整页 revision 校验。
 */
export async function checkControlRevision(params = {}) {
  const tabId = params.tabId;
  const state = Number.isInteger(tabId) ? states.get(tabId) : null;
  if (!state) return;
  const nodeScope = params.nodeScope === true;
  const ref = typeof params.ref === 'string' ? params.ref : '';
  const signatures = state.refSignatures instanceof Map ? state.refSignatures : null;
  if (nodeScope && ref && signatures && signatures.has(ref)) {
    let live = null;
    try { live = await execPage(tabId, 'node-signature', { ref }); } catch { live = null; }
    if (!live || live.present !== true) {
      throw bridgeError('E_TARGET_DETACHED', '观测时的目标节点已从文档中移除（ref ' + ref + '），请重新 observe', {
        ref,
        scope: 'node',
        reason: (live && live.code) || 'detached',
        observed_revision: state.revision,
        current_revision: live && Number.isInteger(live.revision) ? live.revision : null,
      });
    }
    const diff = diffNodeSignatures(signatures.get(ref), live);
    if (diff.blockingKinds.length) {
      throw bridgeError('E_OBSERVATION_CHANGED', '目标节点在观测后已变化（' + diff.blockingKinds.join('/') + '，ref ' + ref + '），请重新 observe', {
        ref,
        scope: 'node',
        observed_revision: state.revision,
        current_revision: Number.isInteger(live.revision) ? live.revision : null,
        observed_changes: {
          scope: 'node',
          ref,
          kinds: diff.blockingKinds,
          advisory: diff.advisoryKinds,
          changes: diff.changes,
        },
      });
    }
    // 目标节点没变（只可能是页面别处或纯几何变化）：放行。
    return;
  }
  if (!Number.isInteger(state.revision)) return;
  const strictContext = state.policy === 'strict' && params.context != null;
  if (params.observation == null && !strictContext) return;
  let live = null;
  try { live = await execPage(tabId, 'revision'); } catch { return; }
  const current = live && Number.isInteger(live.revision) ? live.revision : null;
  if (current == null || current === state.revision) return;
  throw bridgeError('E_OBSERVATION_STALE', '观察后页面已变化（DOM revision ' + state.revision + ' → ' + current + '），请重新 cooperate sync', {
    observed_revision: state.revision,
    current_revision: current,
    policy: state.policy,
    observed_changes: { revision_before: state.revision, revision_after: current },
  });
}

/** cooperate.sync：观测一次并签发 context_id / observation_id。 */
export async function cooperateSync(params = {}) {
  const tabId = params.tabId;
  if (!Number.isInteger(tabId)) throw bridgeError('E_BAD_ARG', 'cooperate.sync 需要 tabId');
  const state = ensure(tabId);
  const requested = params.policy === 'strict'
    ? 'strict'
    : (params.policy === 'target' || params.policy === 'auto')
      ? 'target'
      : state.policy;
  state.policy = requested;
  const observation = await execPage(tabId, 'observe', { probeHover: params.probeHover === true });
  const media = await execPage(tabId, 'media-progress', {}).catch(() => null);
  // 协作读取：字段/媒体/焦点/文本尾部；内容脚本不可用时返回 null，不阻断 sync。
  const cooperation = await readCooperationFrames(tabId).catch(() => null);
  const previousContextId = state.contextId;
  state.contextId = uuid();
  state.observationId = uuid();
  if (previousContextId !== state.contextId) {
    // 上下文换代：四项计数里 epoch 与 frameEpoch 一起推进（迁移表之外的显式变化）。
    bumpRevisions(tabId, { epoch: 1, frameEpoch: 1 });
  }
  state.generation = bumpControlGeneration(tabId);
  state.strictUsed = new Set();
  state.observedAt = Date.now();
  state.revision = Number.isInteger(observation.revision) ? observation.revision : null;
  // DOM revision 走 revision-chain：同文档取 max，换文档按文档重置（不是回退）。
  const revisionRecord = observeControlRevisions(tabId, { revision: state.revision, document: observation.url || '' });
  // controller 状态对齐：暂停 → held；借用中的用户标签页 → borrowed；其余 → agent。
  const takeoverBefore = getTakeoverState(tabId);
  const controlledBefore = await readControlledTabs().catch(() => []);
  syncControllerState(tabId, {
    source: 'cooperate.sync',
    held: takeoverBefore && takeoverBefore.paused === true,
    borrowed: Array.isArray(controlledBefore) && controlledBefore.includes(tabId),
  });
  // 节点级校验：把当前 ref 表的节点签名记录下来，供 --node-scope 的后续动作/读取比对。
  state.refSignatures = new Map();
  try {
    const captured = await execPage(tabId, 'ref-signatures', { limit: 200 });
    for (const item of (captured && Array.isArray(captured.signatures) ? captured.signatures : [])) {
      if (item && typeof item.ref === 'string') state.refSignatures.set(item.ref, item);
    }
  } catch { /* 采集失败时退回整页 revision 校验 */ }
  const coopFrame = cooperation && (cooperation.aggregateFrameState || cooperation.frameState) ? (cooperation.aggregateFrameState || cooperation.frameState) : null;
  const humanAttributed = Number(coopFrame && coopFrame.humanAttributed) || 0;
  const richHuman = getHumanState(tabId);
  const humanAt = richHuman && Number(richHuman.at) ? Number(richHuman.at) : 0;
  const previousHuman = Number.isInteger(state.lastHumanAttributed) ? state.lastHumanAttributed : null;
  const previousHumanAt = Number(state.lastHumanAt) || 0;
  const contentEdits = previousHuman == null ? 0 : Math.max(0, humanAttributed - previousHuman);
  state.lastHumanAttributed = humanAttributed;
  const waitedHumanAt = Number(state.pendingHumanAt) || 0;
  const humanEdits = Math.max(
    contentEdits,
    humanAt > previousHumanAt ? 1 : 0,
    waitedHumanAt > previousHumanAt ? 1 : 0,
  );
  state.humanEditsSinceSync = humanEdits;
  if (humanEdits > 0) noteHumanControl(tabId, { source: 'human-input', humanAt: state.lastHumanAt || humanAt });
  state.lastHumanAt = Math.max(humanAt, previousHumanAt, waitedHumanAt);
  state.pendingHumanAt = 0;
  log('cooperate sync tab=' + tabId + ' policy=' + state.policy + ' context=' + state.contextId);
  const takeover = getTakeoverState(tabId);
  const tabPolicy = await getTabPolicy(tabId).catch(() => null);
  // 快照要在协作读取之后构造：归因证据用的是刚缓存的 frameState。
  const snapshot = cooperationControllerSnapshot(tabId);
  const records = controlGenerationRecord(tabId) || {};
  const authorityFour = buildAuthority({
    tabId,
    policy: state.policy,
    held: takeover && takeover.paused === true,
    readOnly: tabPolicy && tabPolicy.readOnly === true,
    borrowed: (await readControlledTabs().catch(() => [])).includes(tabId),
    generation: state.generation,
    revision: state.revision,
    contextId: state.contextId,
    observationId: state.observationId,
    humanActive: humanAt > 0 && Date.now() - humanAt < 2500,
    controlRevision: records.controlRevision || 0,
    authorityRevision: records.authorityRevision || 0,
    epoch: records.epoch || 0,
    frameEpoch: records.frameEpoch || 0,
    documentEpoch: records.documentEpoch || 0,
    controller: snapshot.controller,
    alignment: snapshot.revisions.stale ? { stale: true, side: snapshot.revisions.staleSide } : null,
    humanInput: snapshot.human,
    borrow: snapshot.borrow,
  });
  return {
    control_policy: state.policy,
    held: takeover && takeover.paused === true,
    human_edits_since_sync: humanEdits,
    reconciliation: {
      humanEdits,
      totalHumanAttributed: humanAttributed,
      lastHumanAt: state.lastHumanAt,
      inputClock: Number(coopFrame && coopFrame.inputClock) || 0,
      frames: cooperation && Number.isInteger(cooperation.frameCount) ? cooperation.frameCount : 0,
      frameGaps: cooperation && Array.isArray(cooperation.frameGaps) ? cooperation.frameGaps.length : 0,
      revision: state.revision,
    },
    control: {
      ...(cooperation && cooperation.control ? cooperation.control : {}),
      held: takeover && takeover.paused === true,
    },
    context_id: state.contextId,
    observation_id: state.observationId,
    generation: state.generation,
    controller: snapshot.controller,
    toolbar: snapshot.toolbar,
    revisions: snapshot.revisions,
    blocking: snapshot.blocking,
    human_input: snapshot.human,
    attributionSummary: describeHumanInput(snapshot.human),
    authority: {
      generation: state.generation,
      revision: coopFrame && Number.isInteger(coopFrame.revision) ? coopFrame.revision : null,
      contextId: state.contextId,
      observationId: state.observationId,
      controlRevision: records.controlRevision || 0,
      authorityRevision: records.authorityRevision || 0,
      epoch: records.epoch || 0,
      frameEpoch: records.frameEpoch || 0,
      documentEpoch: records.documentEpoch || 0,
      revisionObserved: revisionRecord ? revisionRecord.revision : null,
      frames: cooperation && Number.isInteger(cooperation.frameCount) ? cooperation.frameCount : 0,
      frameGaps: cooperation && Array.isArray(cooperation.frameGaps) ? cooperation.frameGaps.length : 0,
      stale: snapshot.revisions.stale,
      staleSide: snapshot.revisions.staleSide,
      four: authorityFour,
    },
    url: observation.url,
    title: observation.title,
    media,
    cooperation,
    evidence: {
      observedAt: state.observedAt,
      url: observation.url,
      title: observation.title,
      refs: observation.refs,
      generation: state.generation,
      contextId: state.contextId,
      observationId: state.observationId,
      mediaPlaying: media ? media.playing : 0,
    },
    observation: {
      observation_id: state.observationId,
      text: foldObservation(observation.observation, params.matchText, params.contextLines),
      refs: observation.refs,
    },
    node_scope: {
      ...summarizeNodeSignatures([...state.refSignatures.values()]),
      revision: state.revision,
      refs: state.refSignatures.size,
    },
  };
}

/** cooperate.wait：等到人工停止操作（默认立即返回当前状态）。 */
export async function cooperateWait(params = {}) {
  const tabId = params.tabId;
  const state = Number.isInteger(tabId) ? states.get(tabId) : null;
  const base = {
    control_policy: state ? state.policy : null,
    context_id: state ? state.contextId : null,
    observation_id: state ? state.observationId : null,
  };
  if (!Number.isInteger(tabId)) return { state: { mode: 'ready' }, ready: true, ...base };
  const timeout = Math.min(Math.max(Number(params.timeoutMs) || 0, 0), 30000);
  const started = Date.now();
  const clearedAt = state ? state.humanClearedAt || 0 : 0;
  let sawHuman = false;
  while (true) {
    const activity = await execPage(tabId, 'human-activity', {}).catch(() => null);
    const rich = getHumanState(tabId);
    const richAt = Number(rich && rich.at) || 0;
    const last = Math.max(Number(activity && activity.lastInputAt) || 0, richAt);
    const active = (Boolean(activity && activity.active) || (richAt > 0 && Date.now() - richAt < 2000)) && last > clearedAt;
    if (active && state) state.pendingHumanAt = Math.max(Number(state.pendingHumanAt) || 0, last);
    if (active && !sawHuman) {
      sawHuman = true;
      // 检测到真实人工输入：controller 进入 human 态并撤销动作许可（authorityRevision）。
      noteHumanControl(tabId, { source: 'cooperate.wait', humanAt: last });
    }
    if (!active) {
      const snapshot = cooperationControllerSnapshot(tabId);
      return {
        state: { mode: 'ready' },
        ready: true,
        waitedMs: Date.now() - started,
        ...(rich ? { human: rich } : {}),
        ...base,
        controller: snapshot.controller,
        toolbar: snapshot.toolbar,
        revisions: snapshot.revisions,
        human_input: snapshot.human,
      };
    }
    if (Date.now() - started >= timeout) {
      const snapshot = cooperationControllerSnapshot(tabId);
      return {
        state: { mode: 'human' },
        ready: false,
        waitedMs: Date.now() - started,
        ...(rich ? { human: rich } : {}),
        ...base,
        controller: snapshot.controller,
        toolbar: snapshot.toolbar,
        revisions: snapshot.revisions,
        human_input: snapshot.human,
      };
    }
    await sleep(250);
  }
}

/** 动作前的授权校验：context / observation / controller 状态 / 借用确认。 */
export function checkControl(params = {}) {
  const tabId = params.tabId;
  if (!Number.isInteger(tabId)) return;
  const takeover = getTakeoverState(tabId);
  const method = String(params.method || '');
  const actionMethod = TAB_METHODS.has(method);
  if (takeover && takeover.paused === true && actionMethod) {
    throw bridgeError('E_SESSION_PAUSED', '人工接管中：请先在浮层点“交给 Agent”或执行 cooperate handback');
  }
  if (actionMethod) {
    // controller 状态机是 pause/借用的显式表达：held/handoff 拒绝动作并给证据。
    const gate = controllerState.actionGate(tabId, method);
    if (!gate.allowed) {
      if (gate.code === 'E_SESSION_PAUSED') {
        throw bridgeError('E_SESSION_PAUSED', '人工接管中（controller=' + gate.state + '）：请先 cooperate handback', gate.evidence);
      }
      const borrow = borrowGate.check(tabId, method);
      throw bridgeError('E_BORROW_CONFLICT', '控制权交接中（controller=' + gate.state + '）：' + (borrow.evidence.hint || '等借用确认结束'), { ...gate.evidence, borrow: borrow.evidence });
    }
  }
  const state = states.get(tabId);
  if (params.unverified === true) {
    // --unverified：跳过观察/上下文一致性校验，但暂停、会话归属与标签页归属仍然生效。
    return;
  }
  if (state && state.policy === 'strict' && params.context == null && (params.ref || params.selector)) {
    throw bridgeError('E_CONTEXT_REQUIRED', 'strict 策略下 DOM 动作必须带 --context（先 cooperate sync 获取）');
  }
  if (params.context != null) {
    if (!state || state.contextId == null) {
      throw bridgeError('E_CONTEXT_STALE', 'context 已失效（页面导航或会话重建），请重新 cooperate sync');
    }
    if (state.policy === 'strict' && state.strictUsed.has(params.context)) {
      throw bridgeError('E_CONTEXT_STALE', '该 context 在 strict 策略下已用过，请重新 cooperate sync');
    }
    if (String(params.context) !== state.contextId) {
      throw bridgeError('E_CONTEXT_STALE', 'context 已失效（页面变化或已重新 sync），请重新 cooperate sync');
    }
    if (state.policy === 'strict') state.strictUsed.add(String(params.context));
  }
  if (params.observation != null) {
    if (!state || state.observationId == null || String(params.observation) !== state.observationId) {
      throw bridgeError('E_OBSERVATION_STALE', 'observation 已失效，请重新 cooperate sync');
    }
  }
}

/**
 * cooperate.handback：人工主动把控制权交回 agent。
 * 除扩展内 controller 迁移外，还要显式解除 daemon 侧会话暂停（force）：handback 的语义
 * 就是“人做完，Agent 可以继续”，不能等下一次 sync 的空闲自动恢复，否则后续动作会
 * 一直 E_SESSION_PAUSED。
 */
export async function cooperateHandback(params = {}) {
  const tabId = params.tabId;
  if (!Number.isInteger(tabId)) throw bridgeError('E_BAD_ARG', 'cooperate.handback 需要 tabId');
  const state = ensure(tabId);
  state.humanClearedAt = Date.now();
  // human → agent（或 idle/agent 幂等）：按迁移表推进 controlRevision。
  const moved = controllerState.transition(tabId, 'human.return', { source: 'cooperate.handback' });
  if (moved && moved.ok) applyTransitionBumps(tabId, moved);
  else if (moved) {
    const claimed = controllerState.transition(tabId, 'agent.claim', { source: 'cooperate.handback', hasSession: true });
    if (claimed && claimed.ok) applyTransitionBumps(tabId, claimed);
    else log('cooperate handback 迁移被拒绝：' + (moved && moved.code) + ' tab=' + tabId);
  }
  const resumed = await resumeTakeover(tabId, { source: 'cooperate.handback', force: true }).catch(() => null);
  const snapshot = cooperationControllerSnapshot(tabId);
  return {
    ok: true,
    state: { mode: 'ready' },
    handedBackAt: state.humanClearedAt,
    context_id: state.contextId,
    observation_id: state.observationId,
    controller: snapshot.controller,
    toolbar: snapshot.toolbar,
    session: resumed ? { paused: false, resumed: resumed.resumed === true } : { paused: null },
    evidence: moved && moved.evidence ? moved.evidence : null,
  };
}

/** 导航/文档替换会吊销 context。 */
export function noteNavigation(tabId) {
  const state = states.get(tabId);
  if (!state) return;
  state.contextId = null;
  state.observationId = null;
  state.generation = bumpControlGeneration(tabId);
  // 文档替换：frameEpoch + epoch 一起推进；DOM revision 由下一次 observe 按文档重置。
  bumpRevisions(tabId, { frameEpoch: 1, epoch: 1 });
  state.strictUsed = new Set();
  log('cooperate context 已因导航失效 tab=' + tabId);
}

export function forgetControl(tabId) {
  states.delete(tabId);
  controllerState.clear(tabId);
}

export { TAB_METHODS };
