// src/lib/controller-toolbar.js —— controller / borrow / toolbar 的只读聚合快照。
//
// 同一个“标签页现在归谁、借用确认到哪一步、浮层在显示什么”在 0.3.0 里要从
// takeover.js、borrow-ui.js、overlay-state.js、capture-suppression.js 四处分别读，
// CLI 与悬浮窗各自拼一遍，字段名还不一样。本模块提供一个**纯函数**聚合器：
// 输入是各模块的原始快照，输出是稳定的、可直接 JSON 化的只读结构：
//
//   controller  状态机当前状态 + 四项 revision/epoch + 最近动作
//   toolbar     浮层可见性/种类/优先级/标签（UI 直接渲染，避免二次推导）
//   borrow      借用确认状态与等待时长
//   capture     引用计数抑制状态（谁在抑制、是否生效）
//   suppression dispatch/ops 的抑制看门狗作用域
//   human       人类输入归因证据（谁在动/动在哪/±1.5ms）
//   blocking    当前是否允许动作 + 拒绝原因（只报告，不替代 enforcement）
//
// 纯函数便于单测，也让 UI/CLI 共享同一份字段定义（不再各拼各的）。

export const CONTROLLER_LABELS = Object.freeze({
  idle: '空闲（无会话控制）',
  agent: 'Agent 控制中',
  human: '人工操作中',
  borrowed: '已借用用户标签页',
  held: '人工接管（已暂停）',
  handoff: '控制权交接中',
});

export const TOOLBAR_KINDS = Object.freeze(['takeover', 'borrow', 'borrow-toast', 'record', 'help', 'manual', 'none']);

function num(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function integer(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function controllerLabel(state) {
  return CONTROLLER_LABELS[String(state || '')] || CONTROLLER_LABELS.idle;
}

/** 浮层种类 → toolbar kind（borrow-toast 归到 borrow，UI 只关心“借用确认中”）。 */
function toolbarKindOf(overlays) {
  const kinds = new Set((Array.isArray(overlays) ? overlays : []).map((entry) => String(entry && entry.kind || '')));
  if (kinds.has('borrow')) return 'borrow';
  if (kinds.has('borrow-toast')) return 'borrow-toast';
  if (kinds.has('takeover')) return 'takeover';
  if (kinds.has('record')) return 'record';
  if (kinds.has('help')) return 'help';
  if (kinds.has('manual')) return 'manual';
  return 'none';
}

function normalizeOverlays(overlaysInput, now) {
  const overlays = (Array.isArray(overlaysInput) ? overlaysInput : [])
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      kind: String(entry.kind || ''),
      priority: num(entry.priority),
      since: num(entry.since),
      ageMs: num(entry.since) > 0 ? Math.max(0, now - num(entry.since)) : 0,
      token: entry.token == null ? null : String(entry.token),
    }))
    .sort((a, b) => b.priority - a.priority || a.kind.localeCompare(b.kind));
  return overlays;
}

function normalizeController(controllerInput, takeoverInput, now) {
  const controller = controllerInput && typeof controllerInput === 'object' ? controllerInput : {};
  const takeover = takeoverInput && typeof takeoverInput === 'object' ? takeoverInput : {};
  const state = controller.state || 'idle';
  return {
    state,
    label: controllerLabel(state),
    since: num(controller.since),
    heldMs: num(controller.since) > 0 ? Math.max(0, now - num(controller.since)) : 0,
    event: controller.event == null ? null : String(controller.event),
    holder: controller.holder == null ? null : String(controller.holder),
    transitions: num(controller.transitions),
    rejected: num(controller.rejected),
    lastRejection: controller.lastRejection || null,
    lastAction: controller.lastAction == null ? null : String(controller.lastAction),
    lastActionAt: num(controller.lastActionAt),
    actionCount: num(controller.actionCount),
    paused: takeover.paused === true,
    borrowed: takeover.borrowed === true,
    sessionId: takeover.sessionId == null ? null : String(takeover.sessionId),
    mode: takeover.mode == null ? (takeover.paused === true ? 'held' : null) : String(takeover.mode),
    minimized: takeover.minimized === true,
  };
}

function normalizeBorrow(borrowInput, now) {
  const borrow = borrowInput && typeof borrowInput === 'object' ? borrowInput : {};
  const status = String(borrow.status || 'none');
  const requestedAt = num(borrow.requestedAt);
  return {
    status,
    requestId: borrow.requestId == null ? null : String(borrow.requestId),
    surface: borrow.surface == null ? null : String(borrow.surface),
    requestedAt,
    pendingMs: status === 'pending' && requestedAt > 0 ? Math.max(0, now - requestedAt) : num(borrow.pendingMs),
    timeoutMs: num(borrow.timeoutMs),
    controlled: borrow.controlled === true,
    title: borrow.title == null ? '' : String(borrow.title).slice(0, 200),
    decision: borrow.decision == null ? null : String(borrow.decision),
  };
}

function normalizeCapture(captureInput) {
  const capture = captureInput && typeof captureInput === 'object' ? captureInput : {};
  const holders = Array.isArray(capture.holders) ? capture.holders : [];
  return {
    count: num(capture.count),
    active: capture.active === true,
    effective: capture.effective === true,
    acked: num(capture.acked),
    frame: num(capture.frame),
    holders: holders.map((holder) => ({
      owner: String(holder && holder.owner || ''),
      acked: Boolean(holder && holder.acked),
      frames: num(holder && holder.frames),
      at: num(holder && holder.at),
    })),
    pending: (Array.isArray(capture.pending) ? capture.pending : []).map((entry) => String(entry && entry.owner || entry && entry.token || '')),
  };
}

function normalizeSuppression(suppressionInput) {
  const suppression = suppressionInput && typeof suppressionInput === 'object' ? suppressionInput : {};
  const live = (Array.isArray(suppression.live) ? suppression.live : []).map((scope) => ({
    scopeId: scope && scope.scopeId ? String(scope.scopeId) : null,
    kind: String(scope && scope.kind || ''),
    method: String(scope && scope.method || ''),
    owner: String(scope && scope.owner || ''),
    heldMs: num(scope && scope.heldMs),
    startedAt: num(scope && scope.startedAt),
  }));
  return {
    active: live.length > 0,
    live,
    count: num(suppression.count),
    effective: suppression.effective === true,
    maxHoldMs: num(suppression.maxHoldMs),
    recent: (Array.isArray(suppression.history) ? suppression.history : []).slice(-5).map((entry) => ({
      kind: String(entry && entry.kind || ''),
      scopeId: entry && entry.scopeId ? String(entry.scopeId) : null,
      outcome: entry && entry.outcome ? String(entry.outcome) : null,
      expired: entry && entry.expired === true,
      at: num(entry && (entry.endedAt || entry.at)),
    })),
  };
}

function normalizeHuman(humanInput) {
  const human = humanInput && typeof humanInput === 'object' ? humanInput : {};
  return {
    who: String(human.who || 'unknown'),
    basis: String(human.basis || 'none'),
    confidence: num(human.confidence),
    where: human.where && typeof human.where === 'object' ? human.where : { frameId: 0, kind: '', label: '' },
    when: human.when && typeof human.when === 'object' ? human.when : { toleranceMs: 1.5 },
    counts: human.counts && typeof human.counts === 'object' ? human.counts : {},
    conflict: human.conflict && typeof human.conflict === 'object' ? human.conflict : { conflicting: false },
  };
}

function normalizeRevisions(revisionsInput) {
  const revisions = revisionsInput && typeof revisionsInput === 'object' ? revisionsInput : {};
  return {
    controlRevision: num(revisions.controlRevision),
    authorityRevision: num(revisions.authorityRevision),
    revision: num(revisions.revision),
    frameEpoch: num(revisions.frameEpoch),
    epoch: num(revisions.epoch),
    generation: num(revisions.generation),
    documentEpoch: num(revisions.documentEpoch),
    document: revisions.document == null ? '' : String(revisions.document).slice(0, 200),
    updatedAt: num(revisions.updatedAt),
    stale: revisions.stale === true,
    staleSide: revisions.staleSide == null ? null : String(revisions.staleSide),
    alignedAt: num(revisions.alignedAt),
  };
}

/** 根据状态/借用/捕获/人工活动推出 UI 徽标（顺序稳定，UI 不用自己排序）。 */
function badgesFor({ controller, borrow, capture, suppression, human }) {
  const badges = [];
  if (controller.state !== 'idle') badges.push('state:' + controller.state);
  if (controller.paused) badges.push('paused');
  if (borrow.status === 'pending') badges.push('borrow-pending');
  if (borrow.status === 'confirmed') badges.push('borrow-confirmed');
  if (capture.active) badges.push(capture.effective ? 'capturing' : 'capturing-pending');
  if (suppression.active) {
    const kinds = [...new Set(suppression.live.map((scope) => scope.kind).filter(Boolean))];
    for (const kind of kinds) badges.push('suppress:' + kind);
  }
  if (human.who === 'human' && human.conflict.conflicting) badges.push('human-conflict');
  else if (human.who === 'human') badges.push('human-active');
  return badges;
}

/** 动作闸门只读汇总：把 controller 状态、借用确认、暂停三处判断合并成一条结论。 */
function blockingFor({ controller, borrow, capture }) {
  const reasons = [];
  if (controller.state === 'held' || controller.paused) reasons.push({ code: 'E_SESSION_PAUSED', source: 'controller', message: '人工接管（暂停）中：先 cooperate handback 或浮层交给 Agent' });
  if (borrow.status === 'pending') reasons.push({ code: 'E_BORROW_CONFLICT', source: 'borrow', message: '借用确认未完成：等用户点「允许」' });
  if (controller.state === 'handoff' && borrow.status !== 'pending' && borrow.status !== 'confirmed') {
    reasons.push({ code: 'E_CONTROL_STALE', source: 'controller', message: '控制权交接中：等 handoff 结算' });
  }
  const blocked = reasons.length > 0;
  return {
    blocked,
    actionAllowed: !blocked,
    reasons,
    primary: reasons.length ? reasons[0].code : null,
    capturing: capture.active === true,
  };
}

/** 浮层标签：UI 直接渲染，避免每个调用点重复拼“Agent 已接管…”这类文案。 */
function labelsFor({ controller, borrow, toolbar }) {
  if (toolbar.kind === 'borrow' || toolbar.kind === 'borrow-toast') {
    return {
      title: 'BridgeDeck 想借用这个标签页',
      subtitle: borrow.title ? '页面：' + borrow.title : '请在页面上点「允许」或「拒绝」',
      mode: 'borrow',
    };
  }
  if (toolbar.kind === 'takeover' || controller.state === 'held' || controller.paused) {
    return {
      title: controller.state === 'held' || controller.paused ? '人工接管中' : 'Agent 已接管该标签页',
      subtitle: controller.state === 'held' || controller.paused
        ? '你随时可以把控制交回 Agent'
        : '你随时可以收回控制；Agent 的动作会显示在这里',
      mode: controller.state === 'held' || controller.paused ? 'held' : controller.state,
    };
  }
  if (toolbar.kind === 'record') return { title: '正在录制操作', subtitle: '录制期间的人工操作会被记成步骤', mode: 'record' };
  if (toolbar.kind === 'help') return { title: '需要人工协助', subtitle: '完成页面上的操作后点「完成」', mode: 'help' };
  return { title: '', subtitle: '', mode: controller.state };
}

/**
 * 构造只读快照。
 * @param {{tabId?: number|null, at?: number, controller?: object, takeover?: object, borrow?: object,
 *          overlays?: {capturing?: boolean, overlays?: Array}, capture?: object, suppression?: object,
 *          passthrough?: {list?: Array, leases?: Array}, human?: object, revisions?: object,
 *          generation?: number, agentWindow?: object|null}} [input]
 */
export function buildControllerToolbarSnapshot(input = {}) {
  const now = Number.isFinite(Number(input.at)) ? Number(input.at) : Date.now();
  const tabId = integer(input.tabId);
  const controller = normalizeController(input.controller, input.takeover, now);
  const borrow = normalizeBorrow(input.borrow, now);
  const overlays = normalizeOverlays(input.overlays && input.overlays.overlays, now);
  const capturingFromOverlay = Boolean(input.overlays && input.overlays.capturing === true);
  const capture = normalizeCapture(input.capture);
  const suppression = normalizeSuppression(input.suppression);
  const human = normalizeHuman(input.human);
  const revisions = normalizeRevisions({
    ...(input.revisions || {}),
    generation: input.generation != null ? input.generation : (input.revisions && input.revisions.generation),
  });
  const leases = Array.isArray(input.passthrough && input.passthrough.list)
    ? input.passthrough.list
    : Array.isArray(input.passthrough && input.passthrough.leases) ? input.passthrough.leases : [];
  const toolbar = {
    visible: overlays.length > 0 || controller.paused || borrow.status === 'pending',
    // 借用确认必然伴随一次可见 UI（模态/Toast/系统通知）；即使浮层注册表里还没登记，
    // 也要让 UI/CLI 知道“现在处在借用确认中”。
    kind: (toolbarKindOf(overlays) === 'none' && borrow.status === 'pending') ? 'borrow' : toolbarKindOf(overlays),
    priority: overlays.length ? overlays[0].priority : 0,
    overlays,
    capturing: capturingFromOverlay || capture.active === true,
    badges: [],
  };
  toolbar.labels = labelsFor({ controller, borrow, toolbar });
  toolbar.badges = badgesFor({ controller, borrow, capture, suppression, human });
  return {
    tabId,
    at: now,
    readOnly: true,
    controller,
    toolbar,
    borrow,
    capture,
    suppression,
    passthrough: {
      count: leases.length,
      leases: leases.map((lease) => ({
        token: String(lease && lease.token || ''),
        grantee: String(lease && lease.grantee || ''),
        expiresAt: num(lease && lease.expiresAt),
        used: Boolean(lease && lease.used),
      })),
    },
    human,
    revisions,
    blocking: blockingFor({ controller, borrow, capture }),
    evidence: {
      at: now,
      tabId,
      sources: {
        controller: Boolean(input.controller),
        takeover: Boolean(input.takeover),
        borrow: Boolean(input.borrow),
        overlay: Boolean(input.overlays),
        capture: Boolean(input.capture),
        suppression: Boolean(input.suppression),
        human: Boolean(input.human),
        revisions: Boolean(input.revisions || input.generation != null),
      },
      agentWindow: input.agentWindow || null,
    },
  };
}

/** 一行摘要：CLI `--json` 之外的默认文本输出用。 */
export function describeControllerToolbar(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return 'controller: 无快照';
  const controller = snapshot.controller || {};
  const toolbar = snapshot.toolbar || {};
  const borrow = snapshot.borrow || {};
  const revisions = snapshot.revisions || {};
  const parts = [
    'controller=' + (controller.state || 'idle'),
  ];
  if (controller.heldMs > 0) parts.push('held=' + Math.round(controller.heldMs) + 'ms');
  if (toolbar.kind && toolbar.kind !== 'none') parts.push('toolbar=' + toolbar.kind);
  if (borrow.status && borrow.status !== 'none') parts.push('borrow=' + borrow.status + (borrow.pendingMs ? '(' + Math.round(borrow.pendingMs) + 'ms)' : ''));
  parts.push('ctrl=' + revisions.controlRevision + '/auth=' + revisions.authorityRevision + '/rev=' + revisions.revision + '/frame=' + revisions.frameEpoch);
  if (revisions.stale) parts.push('stale=' + (revisions.staleSide || '?'));
  if (snapshot.blocking && snapshot.blocking.blocked) parts.push('blocked=' + snapshot.blocking.primary);
  return parts.join(' ');
}
