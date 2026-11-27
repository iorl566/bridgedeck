/** 四类权威快照：tab 归属、控制、观察、动作。只做判定，不替代已有 enforcement。
 *  四类计数各自独立推进：
 *  - control.controlRevision：接管/交回等控制面变化；
 *  - observation.epoch / frameEpoch：上下文与文档集合变化；
 *  - action.authorityRevision：人工介入撤销动作许可；
 *  - observation.revision：DOM 代数（既有）。
 *
 *  0.3.0 之后补充（全部可选、不改变既有字段）：
 *  - controller：显式 controller 状态（idle/agent/human/borrowed/held/handoff）；
 *  - revisions：四项 revision/epoch + epoch/generation 的一次性只读快照（单源在
 *    lib/revision-chain.js），
 *  - alignment：与远端（内容脚本/会话）对齐后的 stale 方向证据，
 *  - humanInput：人类输入归因证据摘要（谁在动/动在哪/±1.5ms），
 *  - borrow：借用确认闸门状态（pending 时动作不被允许）。
 */
export function buildAuthority({
  tabId = null,
  policy = 'target',
  held = false,
  readOnly = false,
  borrowed = false,
  generation = 0,
  revision = null,
  contextId = null,
  observationId = null,
  humanActive = false,
  controlRevision = 0,
  authorityRevision = 0,
  epoch = 0,
  frameEpoch = 0,
  documentEpoch = 0,
  controller = null,
  alignment = null,
  humanInput = null,
  borrow = null,
} = {}) {
  const controllerState = controller && typeof controller === 'object' && typeof controller.state === 'string'
    ? controller.state
    : null;
  // 控制权状态直接决定动作许可：held/handoff 与 held 参数等价（显式状态优先）。
  const actionDenied = held
    ? 'held'
    : controllerState === 'held'
      ? 'held'
      : controllerState === 'handoff'
        ? 'handoff'
        : readOnly
          ? 'read-only'
          : borrow && borrow.status === 'pending'
            ? 'borrow-pending'
            : null;
  const stale = Boolean(alignment && alignment.stale === true);
  const revisionOrNull = revision == null ? null : integerOr(revision, null);
  const revisions = {
    controlRevision: integerOr(controlRevision, 0),
    authorityRevision: integerOr(authorityRevision, 0),
    revision: revisionOrNull,
    frameEpoch: integerOr(frameEpoch, 0),
    epoch: integerOr(epoch, 0),
    generation: integerOr(generation, 0),
    documentEpoch: integerOr(documentEpoch, 0),
  };
  return {
    tab: {
      tabId: Number.isInteger(tabId) ? tabId : null,
      scope: readOnly ? 'read-only' : 'control',
      ownership: borrowed ? 'borrowed' : 'agent',
    },
    control: {
      policy,
      held: held === true || controllerState === 'held',
      generation: integerOr(generation, 0),
      controlRevision: integerOr(controlRevision, 0),
      humanActive: humanActive === true,
      state: controllerState,
      since: controller && Number.isFinite(Number(controller.since)) ? Number(controller.since) : null,
      label: controller && typeof controller.label === 'string' ? controller.label : null,
    },
    observation: {
      contextId: contextId || null,
      observationId: observationId || null,
      revision: revisionOrNull,
      epoch: integerOr(epoch, 0),
      frameEpoch: integerOr(frameEpoch, 0),
      documentEpoch: integerOr(documentEpoch, 0),
      live: Boolean(contextId && observationId),
    },
    action: {
      allowed: actionDenied == null,
      deniedReason: actionDenied,
      humanActive: humanActive === true,
      authorityRevision: integerOr(authorityRevision, 0),
      state: controllerState,
      stale,
    },
    revisions,
    // controller 显式状态（迁移表见 lib/controller-state.js）。
    controller: controller && typeof controller === 'object'
      ? {
        state: controllerState,
        label: typeof controller.label === 'string' ? controller.label : null,
        since: Number.isFinite(Number(controller.since)) ? Number(controller.since) : null,
        event: controller.event == null ? null : String(controller.event),
        holder: controller.holder == null ? null : String(controller.holder),
      }
      : { state: null, label: null, since: null, event: null, holder: null },
    // 四项对齐证据：远端落后（remote）需要抬高远端，本地落后（local）需要采纳远端。
    alignment: alignment && typeof alignment === 'object'
      ? {
        stale,
        side: alignment.side == null ? null : String(alignment.side),
        fields: Array.isArray(alignment.fields) ? alignment.fields : [],
        behind: Array.isArray(alignment.behind) ? alignment.behind : [],
        ahead: Array.isArray(alignment.ahead) ? alignment.ahead : [],
        maxDistance: Number(alignment.maxDistance) || 0,
      }
      : { stale: false, side: null, fields: [], behind: [], ahead: [], maxDistance: 0 },
    humanInput: humanInput && typeof humanInput === 'object'
      ? {
        who: String(humanInput.who || 'unknown'),
        basis: String(humanInput.basis || 'none'),
        where: humanInput.where || null,
        skewMs: humanInput.when && humanInput.when.skewMs != null ? humanInput.when.skewMs : null,
        toleranceMs: humanInput.when && humanInput.when.toleranceMs != null ? humanInput.when.toleranceMs : 1.5,
      }
      : null,
    borrow: borrow && typeof borrow === 'object'
      ? {
        status: String(borrow.status || 'none'),
        requestId: borrow.requestId == null ? null : String(borrow.requestId),
        pendingMs: Number(borrow.pendingMs) || 0,
      }
      : { status: 'none', requestId: null, pendingMs: 0 },
  };
}

function integerOr(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) ? number : fallback;
}
