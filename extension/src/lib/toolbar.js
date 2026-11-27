// src/lib/toolbar.js —— 悬浮工具栏 controller：动作/状态/焦点/键盘可达。
//
// 0.3.0 的“悬浮工具栏”在实现上是散的：
//   - overlay-ui.js 直接拼 HTML（按钮、文案、无障碍属性都在字符串里）；
//   - cooperation.js 只聚合出一份只读快照（controller-toolbar.js），没有“动作”概念；
//   - 借用确认模态的按钮没有统一焦点管理：键盘用户 Tab 能跑到页面其他地方，
//     Escape 关闭后焦点丢到 body，读屏软件也读不到“现在等你决定”；
//   - 悬浮窗/CLI/popup 各自决定“这个按钮现在能不能点”，没有单一判定来源。
//
// 本模块把工具栏变成 controller + 视图模型两层：
//   buildToolbarModel(snapshot, options)  纯函数：把 controller-toolbar 快照翻译成
//                                         “有哪些动作、哪个可用、焦点在哪、ARIA 怎么说”；
//   createToolbarController(options)      有状态：维护每 tab 的焦点/可见性/播报队列，
//                                         处理 keydown（方向键/Home/End/Tab 焦点陷阱/
//                                         Enter/Space/数字快捷键/Escape），把动作派发
//                                         给注入的 onAction（默认只产出 intent，不执行）。
//
// 设计约束（与 0.3.0“只加不改”一致）：
//   - 纯函数 + 可注入依赖，不直接碰 DOM：渲染层（overlay-ui/extension/ui）可以照旧，
//     也可以按 model/keyboard map 逐步迁移；本模块默认不改变任何现有 UI；
//   - 动作是否可用完全由快照（controller 状态机 / 借用确认 / 抑制）决定，
//     UI 不二次推导，避免“按钮亮着但动作被拒”的打脸；
//   - 键盘事件只返回 { handled, preventDefault }，由调用方决定是否 preventDefault；
//   - 焦点陷阱只在 modal（借用确认/帮助）里开启，普通 toast 不抢页面焦点。
//
// 消费的既有路径：
//   controllerState.snapshot()        controller-state.js 的状态机快照
//   getOverlayState()                 overlay-state.js 的浮层注册表
//   buildControllerToolbarSnapshot()  controller-toolbar.js 的只读聚合（单一字段来源）
//   borrow-confirm.js 的借用状态     由调用方作为 extras.borrow 传入（不在本模块反向依赖）

import { buildControllerToolbarSnapshot, describeControllerToolbar, CONTROLLER_LABELS } from './controller-toolbar.js';
import { controllerState } from './controller-state.js';
import { getOverlayState } from '../overlay-state.js';

// 动作/模式/键盘映射契约拆在 input-toolbar-actions.js（单文件行数预算），此处按原 API 重导出。
import {
  TOOLBAR_MODES,
  TOOLBAR_MODE_LIST,
  MODAL_MODES,
  TOOLBAR_ACTION_IDS,
  ACTION_DISABLED_CODES,
  TOOLBAR_ACTIONS,
  TOOLBAR_KEYMAP,
  TOOLBAR_LETTER_SHORTCUTS,
  actionById,
  isKnownActionId,
  DEFAULT_LOCALE,
  DEFAULT_MAX_TABS,
  DEFAULT_ANNOUNCEMENT_LIMIT,
  DEFAULT_HISTORY_LIMIT,
  num,
  integer,
  clip,
  normalizeToolbarTabId as normalizeTabId,
} from './input-toolbar-actions.js';

export {
  TOOLBAR_MODES,
  TOOLBAR_MODE_LIST,
  MODAL_MODES,
  TOOLBAR_ACTION_IDS,
  ACTION_DISABLED_CODES,
  TOOLBAR_ACTIONS,
  TOOLBAR_KEYMAP,
  TOOLBAR_LETTER_SHORTCUTS,
  actionById,
} from './input-toolbar-actions.js';

export function modeFor(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return TOOLBAR_MODES.HIDDEN;
  const controller = snapshot.controller || {};
  const borrow = snapshot.borrow || {};
  const toolbar = snapshot.toolbar || {};
  if (borrow.status === 'pending') return TOOLBAR_MODES.BORROW_CONFIRM;
  if (controller.state === 'held' || controller.paused === true) return TOOLBAR_MODES.HELD;
  if (controller.state === 'handoff') return TOOLBAR_MODES.HANDOFF;
  if (controller.state === 'human') return TOOLBAR_MODES.MANUAL;
  if (controller.state === 'borrowed' || controller.borrowed === true) return TOOLBAR_MODES.BORROW_ACTIVE;
  // 借用已确认但 controller 快照暂时缺失（tab 刚恢复/快照未刷新）：仍按“已借用”呈现。
  if (borrow.status === 'confirmed') return TOOLBAR_MODES.BORROW_ACTIVE;
  const kind = String(toolbar.kind || 'none');
  if (kind === 'help') return TOOLBAR_MODES.HELP;
  if (kind === 'record') return TOOLBAR_MODES.RECORD;
  if (kind === 'manual' || kind === 'takeover') return TOOLBAR_MODES.MANUAL;
  if (toolbar.visible === true) return TOOLBAR_MODES.IDLE;
  return TOOLBAR_MODES.HIDDEN;
}

/** 模式是否可见：hidden 不渲染；其余渲染（即使动作很少）。 */
export function modeVisible(mode) {
  return mode !== TOOLBAR_MODES.HIDDEN;
}

/** 动作在当前快照/模式下是否可用（可用性唯一判定来源）。 */
export function evaluateAction(action, snapshot) {
  if (!action || !snapshot) return { enabled: false, code: ACTION_DISABLED_CODES.UNKNOWN, reason: '动作或快照缺失' };
  if (!isKnownActionId(action.id)) {
    return { enabled: false, code: ACTION_DISABLED_CODES.UNKNOWN, reason: '未知动作：' + String(action.id) };
  }
  const controller = snapshot.controller || {};
  const borrow = snapshot.borrow || {};
  const blocking = snapshot.blocking || {};
  const mode = modeFor(snapshot);
  const id = action.id;
  if (id === TOOLBAR_ACTION_IDS.BORROW_ALLOW || id === TOOLBAR_ACTION_IDS.BORROW_DENY) {
    if (borrow.status !== 'pending') {
      return { enabled: false, code: ACTION_DISABLED_CODES.MODE, reason: '没有待确认的借用请求' };
    }
    return { enabled: true, code: null, reason: null };
  }
  if (id === TOOLBAR_ACTION_IDS.CONTROL_HANDBACK) {
    if (controller.state === 'held' || controller.paused === true) return { enabled: true, code: null, reason: null };
    if (controller.state === 'human') return { enabled: true, code: null, reason: null };
    if (mode === TOOLBAR_MODES.BORROW_ACTIVE) return { enabled: true, code: null, reason: null };
    return { enabled: false, code: ACTION_DISABLED_CODES.MODE, reason: '当前没有需要交还的控制权' };
  }
  if (id === TOOLBAR_ACTION_IDS.CONTROL_HOLD) {
    if (controller.state === 'held') return { enabled: false, code: ACTION_DISABLED_CODES.MODE, reason: '已经暂停' };
    if (controller.state === 'handoff' && borrow.status === 'pending') {
      return { enabled: false, code: ACTION_DISABLED_CODES.PENDING, reason: '借用确认未完成，先等用户决定' };
    }
    return { enabled: true, code: null, reason: null };
  }
  if (id === TOOLBAR_ACTION_IDS.CONTROL_RESUME) {
    if (controller.state !== 'held' && controller.paused !== true) {
      return { enabled: false, code: ACTION_DISABLED_CODES.MODE, reason: '当前没有暂停' };
    }
    return { enabled: true, code: null, reason: null };
  }
  if (id === TOOLBAR_ACTION_IDS.HELP_DONE) {
    if (mode !== TOOLBAR_MODES.HELP) return { enabled: false, code: ACTION_DISABLED_CODES.MODE, reason: '没有待完成的人工协助' };
    return { enabled: true, code: null, reason: null };
  }
  if (id === TOOLBAR_ACTION_IDS.RECORD_STOP) {
    if (mode !== TOOLBAR_MODES.RECORD) return { enabled: false, code: ACTION_DISABLED_CODES.MODE, reason: '当前没有录制' };
    return { enabled: true, code: null, reason: null };
  }
  if (id === TOOLBAR_ACTION_IDS.TOOLBAR_DISMISS) {
    if (mode === TOOLBAR_MODES.BORROW_CONFIRM) {
      return { enabled: false, code: ACTION_DISABLED_CODES.PENDING, reason: '借用确认未完成：先点允许或拒绝' };
    }
    return { enabled: true, code: null, reason: null };
  }
  return { enabled: blocking.actionAllowed !== false, code: ACTION_DISABLED_CODES.BLOCKED, reason: '动作被当前控制面阻塞' };
}

/** 当前模式下应出现的动作（顺序稳定，供 UI 直接渲染 & 焦点顺序使用）。 */
export function actionsForMode(mode, snapshot) {
  return TOOLBAR_ACTIONS
    .filter((action) => action.modes.includes(mode))
    .map((action) => {
      const evaluated = evaluateAction(action, snapshot);
      return { action, ...evaluated };
    });
}

/**
 * 构造工具栏视图模型（纯函数）。
 * @param {object} snapshotInput controller-toolbar 快照，或 buildControllerToolbarSnapshot 的原始输入
 * @param {{focusedId?:string, focusedIndex?:number, dismissed?:boolean, dismissedAt?:number, now?:number,
 *          locale?:string, announcement?:object|null, helpVisible?:boolean, returnFocusTo?:string|null}} [options]
 */
export function buildToolbarModel(snapshotInput, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const isSnapshot = snapshotInput
    && typeof snapshotInput === 'object'
    && snapshotInput.controller
    && snapshotInput.toolbar
    && typeof snapshotInput.readOnly === 'boolean';
  const snapshot = isSnapshot ? snapshotInput : buildControllerToolbarSnapshot(snapshotInput || {});
  let mode = modeFor(snapshot);
  if (options.helpVisible === true && mode !== TOOLBAR_MODES.BORROW_CONFIRM) mode = TOOLBAR_MODES.HELP;
  const dismissed = options.dismissed === true;
  const visible = modeVisible(mode) && !dismissed;
  const entries = actionsForMode(mode, snapshot).map((entry) => {
    const action = entry.action;
    const disabledCode = entry.enabled ? null : entry.code;
    return {
      id: action.id,
      label: action.label,
      ariaLabel: action.ariaLabel,
      shortcut: action.shortcut,
      method: action.method,
      intent: action.intent,
      kind: action.kind,
      variant: action.variant,
      decision: action.decision === true,
      enabled: entry.enabled === true,
      disabledCode,
      disabledReason: entry.reason || null,
      tabIndex: -1,
      role: 'button',
      aria: {
        label: action.ariaLabel,
        disabled: entry.enabled !== true,
        keyshortcuts: action.shortcut || null,
        haspopup: null,
      },
    };
  });
  // 焦点规整：默认落在第一个可用动作（决定类模态必须是“允许”），不可用就落到第一个动作。
  const enabledEntries = entries.filter((entry) => entry.enabled);
  const fallbackId = enabledEntries.length ? enabledEntries[0].id : (entries.length ? entries[0].id : null);
  const requestedId = options.focusedId == null ? null : String(options.focusedId);
  let focusedId = requestedId && entries.some((entry) => entry.id === requestedId) ? requestedId : fallbackId;
  if (options.focusedIndex != null && Number.isInteger(Number(options.focusedIndex))) {
    const index = Math.max(0, Math.min(entries.length - 1, Number(options.focusedIndex)));
    if (entries[index]) focusedId = entries[index].id;
  }
  const focusedIndex = entries.findIndex((entry) => entry.id === focusedId);
  if (focusedIndex >= 0) entries[focusedIndex].tabIndex = 0;
  const modal = MODAL_MODES.includes(mode);
  const trapped = modal && visible;
  const announcements = [];
  if (options.announcement && typeof options.announcement === 'object') {
    announcements.push({
      text: clip(options.announcement.text || '', 240),
      politeness: options.announcement.politeness === 'assertive' ? 'assertive' : 'polite',
      at: num(options.announcement.at) || now,
      seq: num(options.announcement.seq),
    });
  }
  const activeEntry = focusedIndex >= 0 ? entries[focusedIndex] : null;
  const blocking = snapshot.blocking || { blocked: false, reasons: [], primary: null };
  const borrow = snapshot.borrow || {};
  const pendingMs = borrow.status === 'pending' ? Math.max(0, num(borrow.pendingMs)) : 0;
  const timeoutMs = borrow.status === 'pending' ? Math.max(0, num(borrow.timeoutMs)) : 0;
  const labels = (snapshot.toolbar && snapshot.toolbar.labels) || { title: '', subtitle: '', mode };
  const model = {
    tabId: integer(snapshot.tabId),
    at: now,
    readOnly: true,
    mode,
    modeLabel: modeLabelOf(mode),
    visible,
    dismissed,
    modal,
    kind: snapshot.toolbar && snapshot.toolbar.kind ? snapshot.toolbar.kind : 'none',
    title: options.title != null ? String(options.title) : String(labels.title || ''),
    subtitle: options.subtitle != null ? String(options.subtitle) : String(labels.subtitle || ''),
    badges: Array.isArray(snapshot.toolbar && snapshot.toolbar.badges) ? snapshot.toolbar.badges.slice() : [],
    actions: entries,
    focus: {
      index: focusedIndex,
      activeId: focusedId,
      activeIndex: focusedIndex,
      count: entries.length,
      roving: true,
      trapped,
      wrap: true,
      returnFocusTo: options.returnFocusTo == null ? null : String(options.returnFocusTo),
      origin: options.focusOrigin ? String(options.focusOrigin) : (requestedId ? 'explicit' : 'default'),
    },
    keyboard: {
      enabled: visible,
      map: TOOLBAR_KEYMAP,
      letterShortcuts: TOOLBAR_LETTER_SHORTCUTS,
      activeShortcut: activeEntry ? activeEntry.shortcut : null,
      helpText: keyboardHelpText(entries),
    },
    aria: {
      role: 'toolbar',
      label: ariaLabelOf(mode, snapshot),
      orientation: 'horizontal',
      modal,
      busy: borrow.status === 'pending' || blocking.blocked === true,
      describedBy: 'bb-toolbar-status',
      live: announcements.length ? announcements[announcements.length - 1] : null,
      activedescendant: focusedId,
      keyshortcuts: entries.map((entry) => entry.shortcut).filter(Boolean),
      attributes: {},
    },
    status: {
      blocked: blocking.blocked === true,
      actionAllowed: blocking.actionAllowed !== false,
      primaryReason: blocking.primary || null,
      reasons: Array.isArray(blocking.reasons) ? blocking.reasons.slice() : [],
      controllerState: (snapshot.controller && snapshot.controller.state) || 'idle',
      borrowStatus: borrow.status || 'none',
      borrowRequestId: borrow.requestId || null,
      pendingMs,
      timeoutMs,
      timeLeftMs: timeoutMs > 0 ? Math.max(0, timeoutMs - pendingMs) : 0,
      capturing: snapshot.capture ? snapshot.capture.active === true : false,
      suppressed: snapshot.suppression ? snapshot.suppression.active === true : false,
      revisions: snapshot.revisions || {},
    },
    evidence: {
      at: now,
      mode,
      snapshotAt: num(snapshot.at) || now,
      sources: snapshot.evidence && snapshot.evidence.sources ? snapshot.evidence.sources : null,
      actionCount: entries.length,
      enabledCount: enabledEntries.length,
      modal,
      trapped,
      pendingMs,
      announcementSeq: announcements.length ? announcements[0].seq : 0,
    },
  };
  model.aria.attributes = ariaAttributesFor(model);
  return model;
}

function modeLabelOf(mode) {
  const map = {
    [TOOLBAR_MODES.BORROW_CONFIRM]: '借用确认',
    [TOOLBAR_MODES.BORROW_ACTIVE]: 'Agent 借用了这个标签页',
    [TOOLBAR_MODES.HELD]: '人工接管（已暂停）',
    [TOOLBAR_MODES.HANDOFF]: '控制权交接中',
    [TOOLBAR_MODES.RECORD]: '正在录制',
    [TOOLBAR_MODES.HELP]: '需要人工协助',
    [TOOLBAR_MODES.MANUAL]: '人工操作中',
    [TOOLBAR_MODES.IDLE]: '空闲',
    [TOOLBAR_MODES.HIDDEN]: '隐藏',
  };
  return map[mode] || mode;
}

function ariaLabelOf(mode, snapshot) {
  const controller = (snapshot && snapshot.controller) || {};
  const borrow = (snapshot && snapshot.borrow) || {};
  if (mode === TOOLBAR_MODES.BORROW_CONFIRM) {
    return 'BridgeDeck 借用确认：' + (borrow.title ? '页面“' + clip(borrow.title, 80) + '”' : '请选择允许或拒绝');
  }
  if (mode === TOOLBAR_MODES.HELD) return 'BridgeDeck 控制工具栏：人工接管中，可以交给 Agent 或继续';
  if (mode === TOOLBAR_MODES.HELP) return 'BridgeDeck 协助工具栏：完成页面操作后点完成';
  if (mode === TOOLBAR_MODES.RECORD) return 'BridgeDeck 录制工具栏：正在录制操作步骤';
  return 'BridgeDeck 控制工具栏：' + (CONTROLLER_LABELS[controller.state] || '当前状态');
}

function keyboardHelpText(entries) {
  const parts = ['方向键选择', 'Enter 执行', 'Esc 收起'];
  const named = entries.filter((entry) => entry.enabled).map((entry) => entry.label + '（' + entry.id + '）');
  if (named.length) parts.push('可用动作：' + named.join('、'));
  return parts.join('；');
}

function ariaAttributesFor(model) {
  return {
    role: 'toolbar',
    'aria-label': model.aria.label,
    'aria-orientation': 'horizontal',
    'aria-busy': model.aria.busy ? 'true' : 'false',
    'aria-describedby': model.aria.describedBy,
    'data-bb-toolbar-mode': model.mode,
    'data-bb-toolbar-visible': model.visible ? 'true' : 'false',
    'data-bb-toolbar-modal': model.modal ? 'true' : 'false',
  };
}

/** 单个动作的 DOM 属性（渲染层可直接展开到元素上，保持无障碍语义一致）。 */
export function actionAriaAttributes(model, actionId) {
  if (!model || !Array.isArray(model.actions)) return null;
  const action = model.actions.find((entry) => entry.id === actionId);
  if (!action) return null;
  return {
    role: 'button',
    tabindex: action.tabIndex,
    'aria-label': action.aria.label,
    'aria-disabled': action.enabled ? 'false' : 'true',
    'aria-keyshortcuts': action.aria.keyshortcuts || undefined,
    'data-bb-action': action.id,
    'data-bb-action-enabled': action.enabled ? 'true' : 'false',
  };
}

/** 工具栏整体 ARIA 属性 + 每个动作属性 + 播报区属性：给渲染层的一页交付。 */
export function renderToolbarAria(model) {
  if (!model || typeof model !== 'object') return null;
  return {
    container: ariaAttributesFor(model),
    actions: model.actions.map((entry) => ({ id: entry.id, attributes: actionAriaAttributes(model, entry.id) })),
    live: {
      role: 'status',
      'aria-live': (model.aria.live && model.aria.live.politeness) || 'polite',
      'aria-atomic': 'true',
      text: model.aria.live ? model.aria.live.text : '',
    },
    focus: {
      activeId: model.focus.activeId,
      activedescendant: model.aria.activedescendant,
      trapped: model.focus.trapped,
      roving: model.focus.roving,
    },
  };
}

/** 一行摘要：CLI/诊断默认文本。 */
export function describeToolbar(model) {
  if (!model || typeof model !== 'object') return 'toolbar: 无模型';
  const parts = ['toolbar=' + model.mode];
  if (model.visible) parts.push('visible');
  else parts.push('hidden');
  if (model.focus && model.focus.activeId) parts.push('focus=' + model.focus.activeId);
  const enabled = (model.actions || []).filter((action) => action.enabled);
  if (enabled.length) parts.push('actions=' + enabled.map((action) => action.id).join(','));
  if (model.status && model.status.blocked) parts.push('blocked=' + (model.status.primaryReason || '?'));
  if (model.status && model.status.pendingMs > 0) parts.push('pending=' + Math.round(model.status.pendingMs) + 'ms');
  return parts.join(' ');
}

/** 精简证据：嵌进错误/快照里，避免把整个 model（含全部动作）塞进日志。 */
export function toolbarEvidence(model) {
  if (!model || typeof model !== 'object') return null;
  return {
    mode: model.mode,
    visible: model.visible === true,
    modal: model.modal === true,
    kind: model.kind,
    focusId: model.focus ? model.focus.activeId : null,
    trapped: model.focus ? model.focus.trapped === true : false,
    actions: (model.actions || []).map((action) => ({ id: action.id, enabled: action.enabled === true, disabledCode: action.disabledCode || null })),
    ariaLabel: model.aria ? model.aria.label : null,
    announcement: model.aria && model.aria.live ? model.aria.live.text : null,
    blocked: model.status ? model.status.blocked === true : false,
    primaryReason: model.status ? model.status.primaryReason : null,
    pendingMs: model.status ? model.status.pendingMs : 0,
    at: model.at,
  };
}

/**
 * 直接读活状态构造 controller-toolbar 快照（toolbar 视角）：
 * controller 从 controller-state 读，浮层从 overlay-state 读，其余由调用方传入
 * （borrow/capture/suppression/human/revisions）——避免本模块反向依赖 borrow-confirm。
 */
export function liveToolbarSnapshot(tabId, extras = {}) {
  const id = normalizeTabId(tabId);
  const at = Number.isFinite(Number(extras.at)) ? Number(extras.at) : Date.now();
  const controller = extras.controller !== undefined
    ? extras.controller
    : (id == null ? null : controllerState.snapshot(id));
  const overlays = extras.overlays !== undefined
    ? extras.overlays
    : (id == null ? { capturing: false, overlays: [] } : getOverlayState(id));
  return buildControllerToolbarSnapshot({
    tabId: id,
    at,
    controller,
    takeover: extras.takeover || null,
    borrow: extras.borrow || null,
    overlays,
    capture: extras.capture || null,
    suppression: extras.suppression || null,
    passthrough: extras.passthrough || null,
    human: extras.human || null,
    revisions: extras.revisions || null,
    generation: extras.generation,
    agentWindow: extras.agentWindow || null,
  });
}

/**
 * 借用确认被拦截时的工具栏证据（供 borrow-confirm.check 的 evidence.toolbar 使用）：
 * 只做纯模型构造，不读取借用闸门自身，避免循环依赖。
 * @param {number} tabId
 * @param {{borrow?:object, at?:number, suppress?:boolean}} [options]
 */
export function toolbarBlockedEvidence(tabId, options = {}) {
  const id = normalizeTabId(tabId);
  if (id == null || options.suppress === true) return null;
  const at = Number.isFinite(Number(options.at)) ? Number(options.at) : Date.now();
  try {
    const snapshot = liveToolbarSnapshot(id, { at, borrow: options.borrow || null });
    const model = buildToolbarModel(snapshot, { now: at });
    return {
      ...toolbarEvidence(model),
      model: { visible: model.visible, mode: model.mode, focusId: model.focus.activeId, trapped: model.focus.trapped },
    };
  } catch {
    return null;
  }
}

function emptyTabState(now) {
  return {
    tabId: null,
    visible: false,
    dismissed: false,
    dismissedAt: 0,
    focusedId: null,
    focusOrigin: 'default',
    returnFocusTo: null,
    announcement: null,
    announcementSeq: 0,
    announcements: [],
    lastAction: null,
    lastActionAt: 0,
    lastActionResult: null,
    actionCount: 0,
    keyEvents: 0,
    handledKeyEvents: 0,
    history: [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 创建 toolbar controller。
 * @param {{
 *   now?: () => number,
 *   snapshotProvider?: (tabId:number, extras:object) => object,
 *   onAction?: (action:object, model:object, meta:object) => any,
 *   announcementLimit?: number,
 *   historyLimit?: number,
 *   maxTabs?: number,
 *   locale?: string,
 * }} [options]
 */
export function createToolbarController(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const provider = typeof options.snapshotProvider === 'function'
    ? options.snapshotProvider
    : (tabId, extras) => liveToolbarSnapshot(tabId, extras);
  const onAction = typeof options.onAction === 'function' ? options.onAction : null;
  const announcementLimit = Number.isInteger(options.announcementLimit) && options.announcementLimit > 0 ? options.announcementLimit : DEFAULT_ANNOUNCEMENT_LIMIT;
  const historyLimit = Number.isInteger(options.historyLimit) && options.historyLimit > 0 ? options.historyLimit : DEFAULT_HISTORY_LIMIT;
  const maxTabs = Number.isInteger(options.maxTabs) && options.maxTabs > 0 ? options.maxTabs : DEFAULT_MAX_TABS;
  const locale = clip(options.locale || DEFAULT_LOCALE, 8);
  const states = new Map();
  const stats = { models: 0, focusMoves: 0, activations: 0, dispatchFailures: 0, keyEvents: 0, handled: 0, dismissed: 0, shows: 0, hides: 0, traps: 0 };

  function stateFor(tabId) {
    const id = normalizeTabId(tabId);
    if (id == null) return null;
    let state = states.get(id);
    if (!state) {
      if (states.size >= maxTabs) {
        const oldest = states.keys().next().value;
        if (oldest !== undefined) states.delete(oldest);
      }
      state = emptyTabState(now());
      state.tabId = id;
      states.set(id, state);
    }
    return state;
  }

  function pushHistory(state, entry) {
    state.history.push(entry);
    if (state.history.length > historyLimit) state.history.splice(0, state.history.length - historyLimit);
  }

  function snapshotOf(tabId, extras = {}) {
    const state = stateFor(tabId);
    if (!state) return null;
    const snapshot = provider(state.tabId, extras || {});
    return { snapshot, state };
  }

  /** 计算（并缓存焦点/可见性状态下的）视图模型。 */
  function model(tabId, extras = {}) {
    const resolved = snapshotOf(tabId, extras);
    if (!resolved) {
      return buildToolbarModel({ tabId: null, at: now() }, { now: now(), locale });
    }
    const { snapshot, state } = resolved;
    const modelValue = buildToolbarModel(snapshot, {
      now: now(),
      focusedId: state.focusedId,
      dismissed: state.dismissed,
      dismissedAt: state.dismissedAt,
      announcement: state.announcement,
      locale,
      returnFocusTo: state.returnFocusTo,
      focusOrigin: state.focusOrigin,
    });
    // 关闭状态会随快照变化：模式回到非 hidden 时自动重新出现（除非用户刚收起且无新决定）。
    if (!state.dismissed && modelValue.visible) state.visible = true;
    state.focusedId = modelValue.focus.activeId;
    stats.models += 1;
    return modelValue;
  }

  function refresh(tabId, extras = {}) {
    return model(tabId, extras);
  }

  function currentActions(modelValue) {
    return modelValue && Array.isArray(modelValue.actions) ? modelValue.actions : [];
  }

  /** 把焦点移到指定动作（越界时按 wrap 环绕；不可用动作也会聚焦，符合 roving tabindex 语义）。 */
  function focus(tabId, actionOrIndex, extras = {}) {
    const state = stateFor(tabId);
    if (!state) return { ok: false, code: 'E_BAD_ARG', evidence: { tabId: null } };
    const before = model(tabId, extras);
    const entries = currentActions(before);
    if (!entries.length) {
      return { ok: false, code: 'E_NOT_FOUND', evidence: { tabId: state.tabId, mode: before.mode } };
    }
    let nextIndex = -1;
    if (typeof actionOrIndex === 'number' && Number.isInteger(actionOrIndex)) {
      nextIndex = actionOrIndex;
    } else if (actionOrIndex != null) {
      nextIndex = entries.findIndex((entry) => entry.id === String(actionOrIndex));
    }
    if (nextIndex < 0) return { ok: false, code: 'E_NOT_FOUND', evidence: { tabId: state.tabId, actionId: actionOrIndex == null ? null : String(actionOrIndex) } };
    if (before.focus.wrap !== false) nextIndex = ((nextIndex % entries.length) + entries.length) % entries.length;
    else nextIndex = Math.max(0, Math.min(entries.length - 1, nextIndex));
    const target = entries[nextIndex];
    state.focusedId = target.id;
    state.focusOrigin = 'roving';
    state.updatedAt = now();
    stats.focusMoves += 1;
    const announced = announce(state.tabId, target.ariaLabel || target.label, { politeness: 'polite', source: 'focus' });
    const after = model(state.tabId, extras);
    return {
      ok: true,
      tabId: state.tabId,
      focusId: target.id,
      index: after.focus.index,
      count: entries.length,
      announcement: announced,
      model: after,
      evidence: { tabId: state.tabId, focusId: target.id, index: after.focus.index, count: entries.length, trapped: after.focus.trapped },
    };
  }

  function focusNext(tabId, extras = {}) {
    const current = model(tabId, extras);
    const entries = currentActions(current);
    if (!entries.length) return { ok: false, code: 'E_NOT_FOUND' };
    const index = current.focus.index < 0 ? 0 : (current.focus.index + 1) % entries.length;
    return focus(tabId, entries[index].id, extras);
  }

  function focusPrev(tabId, extras = {}) {
    const current = model(tabId, extras);
    const entries = currentActions(current);
    if (!entries.length) return { ok: false, code: 'E_NOT_FOUND' };
    const index = current.focus.index <= 0 ? entries.length - 1 : current.focus.index - 1;
    return focus(tabId, entries[index].id, extras);
  }

  function focusFirst(tabId, extras = {}) {
    const current = model(tabId, extras);
    const entries = currentActions(current);
    return entries.length ? focus(tabId, entries[0].id, extras) : { ok: false, code: 'E_NOT_FOUND' };
  }

  function focusLast(tabId, extras = {}) {
    const current = model(tabId, extras);
    const entries = currentActions(current);
    return entries.length ? focus(tabId, entries[entries.length - 1].id, extras) : { ok: false, code: 'E_NOT_FOUND' };
  }

  /** 播报（ARIA live）：只进有界队列，渲染层读到之后可以清掉。 */
  function announce(tabId, text, announceOptions = {}) {
    const state = stateFor(tabId);
    if (!state) return null;
    const at = now();
    state.announcementSeq += 1;
    const entry = {
      seq: state.announcementSeq,
      text: clip(text || '', 240),
      politeness: announceOptions.politeness === 'assertive' ? 'assertive' : 'polite',
      at,
      source: clip(announceOptions.source || '', 32),
    };
    state.announcement = entry;
    state.announcements.push(entry);
    if (state.announcements.length > announcementLimit) state.announcements.splice(0, state.announcements.length - announcementLimit);
    state.updatedAt = at;
    return entry;
  }

  /**
   * 执行一个动作：校验可用性 → 调 onAction（注入的派发器）→ 返回结构化结果。
   * 默认没有 onAction 时只产出 intent（不执行任何命令），保证“只加不改”。
   */
  async function activate(tabId, actionOrId, meta = {}) {
    const state = stateFor(tabId);
    if (!state) return { ok: false, code: 'E_BAD_ARG', evidence: { tabId: null } };
    const current = model(state.tabId, meta.extras || {});
    const requested = actionOrId == null ? current.focus.activeId : actionOrId;
    const action = actionById(requested);
    if (!action) {
      return { ok: false, code: ACTION_DISABLED_CODES.UNKNOWN, evidence: { tabId: state.tabId, actionId: requested == null ? null : String(requested) } };
    }
    // 可用性以模型为准（模型是唯一视图，避免这里重复推导出现两套判定）。
    const entry = currentActions(current).find((item) => item.id === action.id);
    if (!entry) {
      return { ok: false, code: ACTION_DISABLED_CODES.MODE, error: '动作不在当前模式下', evidence: { tabId: state.tabId, mode: current.mode, actionId: action.id } };
    }
    if (!entry.enabled) {
      return {
        ok: false,
        code: ACTION_DISABLED_CODES.DISABLED,
        error: entry.disabledReason || '动作当前不可用',
        actionId: action.id,
        evidence: { tabId: state.tabId, mode: current.mode, actionId: action.id, disabledCode: entry.disabledCode, reason: entry.disabledReason, model: toolbarEvidence(current) },
      };
    }
    const at = now();
    const dispatchMeta = {
      tabId: state.tabId,
      at,
      mode: current.mode,
      requestId: current.status ? current.status.borrowRequestId : null,
      source: clip(meta.source || 'toolbar', 32),
    };
    let result = null;
    let dispatched = false;
    if (onAction) {
      try {
        result = await onAction({ ...action }, current, dispatchMeta);
        dispatched = true;
      } catch (error) {
        stats.dispatchFailures += 1;
        const failure = {
          ok: false,
          code: ACTION_DISABLED_CODES.FAILED,
          actionId: action.id,
          error: clip((error && error.message) || error, 240),
          evidence: { tabId: state.tabId, actionId: action.id, at, cause: clip((error && error.message) || error, 240), model: toolbarEvidence(current) },
        };
        pushHistory(state, { kind: 'action-failed', at, actionId: action.id, code: failure.code });
        return failure;
      }
    }
    state.lastAction = action.id;
    state.lastActionAt = at;
    state.lastActionResult = result == null ? null : (typeof result === 'object' ? { ok: result.ok !== false } : { ok: true });
    state.actionCount += 1;
    state.updatedAt = at;
    stats.activations += 1;
    pushHistory(state, { kind: 'action', at, actionId: action.id, mode: current.mode, dispatched });
    if (action.kind === 'dismiss' || action.id === TOOLBAR_ACTION_IDS.TOOLBAR_DISMISS) {
      hide(state.tabId, { reason: 'action.dismiss' });
    }
    const announced = announce(state.tabId, action.label + '：' + (dispatched ? '已执行' : '已选择'), { politeness: action.decision ? 'assertive' : 'polite', source: 'action' });
    return {
      ok: true,
      tabId: state.tabId,
      actionId: action.id,
      method: action.method,
      intent: action.intent,
      dispatched,
      result,
      meta: dispatchMeta,
      announcement: announced,
      evidence: { tabId: state.tabId, actionId: action.id, method: action.method, mode: current.mode, dispatched, at, requestId: dispatchMeta.requestId },
    };
  }

  /**
   * 键盘事件处理（纯状态迁移，不碰 DOM）。
   * @param {number} tabId
   * @param {{key?:string, shiftKey?:boolean, ctrlKey?:boolean, altKey?:boolean, metaKey?:boolean,
   *          isComposing?:boolean, repeat?:boolean, code?:string}} event
   * @returns {{handled:boolean, preventDefault:boolean, action?:object, focus?:object, announcement?:object, model?:object, reason?:string}}
   */
  function keydown(tabId, event = {}) {
    const state = stateFor(tabId);
    stats.keyEvents += 1;
    if (!state) return { handled: false, preventDefault: false, reason: 'bad-tab' };
    const current = model(state.tabId);
    if (!current.visible || !current.keyboard.enabled) return { handled: false, preventDefault: false, reason: 'toolbar-hidden', model: current };
    if (event.isComposing === true) return { handled: false, preventDefault: false, reason: 'ime-composing', model: current };
    if (event.ctrlKey === true || event.metaKey === true || event.altKey === true) {
      return { handled: false, preventDefault: false, reason: 'modifier', model: current };
    }
    const key = normalizeKey(event);
    if (!key) return { handled: false, preventDefault: false, reason: 'no-key', model: current };
    const shift = event.shiftKey === true;
    // Tab / Shift+Tab：焦点陷阱只在 modal 里生效；非 modal 交给浏览器默认行为。
    if (key === 'Tab') {
      if (!shift && current.focus.trapped) {
        stats.traps += 1;
        const moved = focusNext(state.tabId);
        return { handled: true, preventDefault: true, focus: moved, model: moved.model || current, reason: 'trap-next' };
      }
      if (shift && current.focus.trapped) {
        stats.traps += 1;
        const moved = focusPrev(state.tabId);
        return { handled: true, preventDefault: true, focus: moved, model: moved.model || current, reason: 'trap-prev' };
      }
      return { handled: false, preventDefault: false, reason: 'tab-passthrough', model: current };
    }
    if (TOOLBAR_KEYMAP.dismiss.includes(key)) {
      const dismissed = dismiss(state.tabId, 'keyboard.escape');
      const announcement = announce(state.tabId, dismissed.ok ? '工具栏已收起' : '请先选择允许或拒绝', { politeness: dismissed.ok ? 'polite' : 'assertive', source: 'keyboard' });
      return {
        handled: true,
        preventDefault: true,
        action: { id: TOOLBAR_ACTION_IDS.TOOLBAR_DISMISS, method: 'toolbar.dismiss' },
        result: dismissed,
        announcement,
        model: dismissed.ok ? current : current,
        reason: dismissed.ok ? 'dismissed' : 'decision-required',
      };
    }
    if (TOOLBAR_KEYMAP.next.includes(key)) {
      const moved = focusNext(state.tabId);
      return { handled: true, preventDefault: true, focus: moved, announcement: moved.announcement, model: moved.model || current, reason: 'next' };
    }
    if (TOOLBAR_KEYMAP.prev.includes(key)) {
      const moved = focusPrev(state.tabId);
      return { handled: true, preventDefault: true, focus: moved, announcement: moved.announcement, model: moved.model || current, reason: 'prev' };
    }
    if (TOOLBAR_KEYMAP.first.includes(key)) {
      const moved = focusFirst(state.tabId);
      return { handled: true, preventDefault: true, focus: moved, announcement: moved.announcement, model: moved.model || current, reason: 'first' };
    }
    if (TOOLBAR_KEYMAP.last.includes(key)) {
      const moved = focusLast(state.tabId);
      return { handled: true, preventDefault: true, focus: moved, announcement: moved.announcement, model: moved.model || current, reason: 'last' };
    }
    if (TOOLBAR_KEYMAP.activate.includes(key)) {
      const actionId = current.focus.activeId;
      const entry = currentActions(current).find((item) => item.id === actionId);
      if (!entry) return { handled: true, preventDefault: true, reason: 'no-active-action', model: current };
      // activate 是异步的（可能派发命令）；这里同步返回“已受理”，结果由 onAction 侧异步落。
      const pending = activate(state.tabId, actionId, { source: 'keyboard' });
      if (entry.enabled && pending && typeof pending.then === 'function') {
        pending.catch(() => {});
      }
      return { handled: true, preventDefault: true, action: entry, pending, model: current, reason: 'activate' };
    }
    // 单词快捷键：只在非决定类模式下生效，避免和页面输入冲突。
    const letter = key.length === 1 ? key.toLowerCase() : '';
    if (letter && TOOLBAR_LETTER_SHORTCUTS[letter] && !MODAL_MODES.includes(current.mode)) {
      const actionId = TOOLBAR_LETTER_SHORTCUTS[letter];
      const entry = currentActions(current).find((item) => item.id === actionId);
      if (entry) {
        const pending = activate(state.tabId, actionId, { source: 'keyboard.shortcut' });
        if (pending && typeof pending.then === 'function') pending.catch(() => {});
        return { handled: true, preventDefault: true, action: entry, pending, model: current, reason: 'shortcut' };
      }
    }
    // 数字 1..9：快速执行第 N 个可用动作（决定类模态可用，方便键盘用户直接选）。
    if (key.length === 1 && /^[1-9]$/.test(key)) {
      const enabled = currentActions(current).filter((entry) => entry.enabled);
      const target = enabled[Number(key) - 1];
      if (target) {
        const pending = activate(state.tabId, target.id, { source: 'keyboard.digit' });
        if (pending && typeof pending.then === 'function') pending.catch(() => {});
        return { handled: true, preventDefault: true, action: target, pending, model: current, reason: 'digit' };
      }
      return { handled: true, preventDefault: true, reason: 'digit-no-action', model: current };
    }
    if (TOOLBAR_KEYMAP.help.includes(key)) {
      const announcement = announce(state.tabId, current.keyboard.helpText, { politeness: 'polite', source: 'keyboard.help' });
      return { handled: true, preventDefault: true, announcement, model: current, reason: 'help' };
    }
    return { handled: false, preventDefault: false, reason: 'unmapped', model: current };
  }

  function normalizeKey(event) {
    const raw = typeof event.key === 'string' ? event.key : '';
    if (!raw) return '';
    if (raw === 'Spacebar' || raw === 'Space' || raw === ' ') return ' ';
    if (raw === 'Esc') return 'Escape';
    return raw;
  }

  /** 显示工具栏（重新可见，焦点回到默认动作）。 */
  function show(tabId, extras = {}) {
    const state = stateFor(tabId);
    if (!state) return { ok: false, code: 'E_BAD_ARG' };
    state.dismissed = false;
    state.dismissedAt = 0;
    state.visible = true;
    state.updatedAt = now();
    stats.shows += 1;
    const current = model(state.tabId, extras);
    return { ok: true, tabId: state.tabId, model: current, focusId: current.focus.activeId, evidence: { tabId: state.tabId, at: state.updatedAt, mode: current.mode } };
  }

  /**
   * 收起工具栏。借用确认/帮助这类“等人做决定”的模态不允许静默收起：
   * 返回 E_TOOLBAR_DECISION_REQUIRED，由 UI 继续把焦点留在允许/拒绝上。
   */
  function dismiss(tabId, reason = 'dismiss') {
    const state = stateFor(tabId);
    if (!state) return { ok: false, code: 'E_BAD_ARG' };
    const current = model(state.tabId);
    if (current.mode === TOOLBAR_MODES.BORROW_CONFIRM) {
      return {
        ok: false,
        code: ACTION_DISABLED_CODES.PENDING,
        error: '借用确认未完成：先点允许或拒绝',
        evidence: { tabId: state.tabId, mode: current.mode, reason, required: [TOOLBAR_ACTION_IDS.BORROW_ALLOW, TOOLBAR_ACTION_IDS.BORROW_DENY] },
      };
    }
    state.dismissed = true;
    state.dismissedAt = now();
    state.visible = false;
    state.updatedAt = state.dismissedAt;
    stats.dismissed += 1;
    pushHistory(state, { kind: 'dismiss', at: state.dismissedAt, reason: clip(reason, 64), mode: current.mode });
    return {
      ok: true,
      tabId: state.tabId,
      dismissed: true,
      returnFocusTo: state.returnFocusTo || null,
      evidence: { tabId: state.tabId, at: state.dismissedAt, mode: current.mode, reason: clip(reason, 64), returnFocusTo: state.returnFocusTo || null },
    };
  }

  function hide(tabId, hideOptions = {}) {
    return dismiss(tabId, hideOptions.reason || 'hide');
  }

  function setReturnFocus(tabId, target) {
    const state = stateFor(tabId);
    if (!state) return null;
    state.returnFocusTo = target == null ? null : String(target);
    return state.returnFocusTo;
  }

  function state(tabId) {
    const id = normalizeTabId(tabId);
    const stored = id == null ? null : states.get(id);
    if (!stored) {
      return { tabId: id, visible: false, dismissed: false, focusedId: null, announcement: null, actionCount: 0, keyEvents: 0, history: [] };
    }
    return {
      tabId: stored.tabId,
      visible: stored.visible,
      dismissed: stored.dismissed,
      dismissedAt: stored.dismissedAt,
      focusedId: stored.focusedId,
      focusOrigin: stored.focusOrigin,
      returnFocusTo: stored.returnFocusTo,
      announcement: stored.announcement,
      announcements: stored.announcements.slice(-4),
      lastAction: stored.lastAction,
      lastActionAt: stored.lastActionAt,
      actionCount: stored.actionCount,
      keyEvents: stored.keyEvents,
      history: stored.history.slice(-8),
    };
  }

  function snapshot(tabId, extras = {}) {
    const modelValue = model(tabId, extras);
    return {
      tabId: modelValue.tabId,
      at: modelValue.at,
      mode: modelValue.mode,
      visible: modelValue.visible,
      model: modelValue,
      evidence: toolbarEvidence(modelValue),
      state: state(tabId),
    };
  }

  function forget(tabId) {
    const id = normalizeTabId(tabId);
    if (id == null) return false;
    return states.delete(id);
  }

  function list() {
    return [...states.keys()].map((id) => ({ tabId: id, mode: model(id).mode, visible: state(id).visible, focusedId: state(id).focusedId }));
  }

  function counters() {
    return { ...stats, tabs: states.size };
  }

  function reset() {
    const cleared = states.size;
    states.clear();
    for (const key of Object.keys(stats)) stats[key] = 0;
    return { ok: true, cleared };
  }

  return {
    model,
    refresh,
    snapshot,
    focus,
    focusNext,
    focusPrev,
    focusFirst,
    focusLast,
    activate,
    keydown,
    announce,
    show,
    hide,
    dismiss,
    setReturnFocus,
    state,
    list,
    forget,
    counters,
    reset,
    get locale() { return locale; },
  };
}

/** 后台共享单例：borrow-confirm 的拦截证据、后续 overlay/UI 迁移都从这里读。 */
export const toolbarController = createToolbarController();

/**
 * 由 controller-toolbar 快照直接描述工具栏（CLI 用，不需要 controller 状态）。
 * 与 describeControllerToolbar 互补：这里只讲“用户看到的按钮/焦点/键盘”。 */
export function describeSnapshotToolbar(snapshot, options = {}) {
  return describeToolbar(buildToolbarModel(snapshot, options));
}

export { describeControllerToolbar };
