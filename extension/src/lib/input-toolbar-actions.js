// src/lib/input-toolbar-actions.js —— 工具栏动作/模式/键盘映射的单一契约（纯数据）。
//
// 从 toolbar.js 拆出的“叶子”部分：模式枚举、动作定义表、禁用码、键盘映射。
// 拆出原因：
//   1. extension/src 单文件 ≤1100 行（architecture-guards.test.mjs），toolbar 的
//      controller 与动作定义混在一个文件会超预算；
//   2. 动作定义是 UI/CLI/文档共享的稳定契约，单独放避免被实现细节牵动。
//
// 本文件不 import 任何运行时模块（controller/overlay 等都不依赖），可安全被任何层引用。
// 动作的 method 与 CLI/MCP 的 method 名对齐，便于悬浮窗直接透传命令。

export const TOOLBAR_MODES = Object.freeze({
  HIDDEN: 'hidden',
  IDLE: 'idle',
  BORROW_CONFIRM: 'borrow-confirm',
  BORROW_ACTIVE: 'borrow-active',
  HELD: 'held',
  HANDOFF: 'handoff',
  RECORD: 'record',
  HELP: 'help',
  MANUAL: 'manual',
});

export const TOOLBAR_MODE_LIST = Object.freeze(Object.values(TOOLBAR_MODES));

/** 模态模式：开启焦点陷阱，Escape 不能静默关掉（先让用户做决定）。 */
export const MODAL_MODES = Object.freeze([TOOLBAR_MODES.BORROW_CONFIRM, TOOLBAR_MODES.HELP]);

export const TOOLBAR_ACTION_IDS = Object.freeze({
  BORROW_ALLOW: 'borrow.allow',
  BORROW_DENY: 'borrow.deny',
  CONTROL_HANDBACK: 'control.handback',
  CONTROL_HOLD: 'control.hold',
  CONTROL_RESUME: 'control.resume',
  HELP_DONE: 'help.done',
  RECORD_STOP: 'record.stop',
  TOOLBAR_DISMISS: 'toolbar.dismiss',
});

export const ACTION_DISABLED_CODES = Object.freeze({
  MODE: 'E_NOT_ACTIONABLE',
  BLOCKED: 'E_NOT_ACTIONABLE',
  PENDING: 'E_HUMAN_GATE',
  NOT_ALLOWED: 'E_FORBIDDEN',
  UNKNOWN: 'E_NOT_FOUND',
  DISABLED: 'E_NOT_ACTIONABLE',
  FAILED: 'E_INTERNAL',
});

/**
 * 动作定义：单一来源。
 *   method     交给调用方 dispatch 的命令名（与 CLI/MCP 的 method 对齐，便于透传）
 *   modes      在哪些模式下出现（不出现在其它模式里，避免“灰按钮堆满工具栏”）
 *   variant    渲染建议（primary/secondary/danger/ghost），UI 可忽略
 *   decision   true 表示这是“让人做决定”的按钮（借用确认/帮助完成）
 */
export const TOOLBAR_ACTIONS = Object.freeze([
  Object.freeze({
    id: TOOLBAR_ACTION_IDS.BORROW_ALLOW,
    label: '允许',
    ariaLabel: '允许 Agent 使用这个标签页',
    shortcut: 'Enter',
    method: 'borrow.confirm',
    intent: { decision: 'allow', requestKey: 'allow' },
    kind: 'decision',
    variant: 'primary',
    decision: true,
    modes: [TOOLBAR_MODES.BORROW_CONFIRM],
  }),
  Object.freeze({
    id: TOOLBAR_ACTION_IDS.BORROW_DENY,
    label: '拒绝',
    ariaLabel: '拒绝 Agent 使用这个标签页',
    shortcut: 'Escape',
    method: 'borrow.reject',
    intent: { decision: 'deny', requestKey: 'deny' },
    kind: 'decision',
    variant: 'secondary',
    decision: true,
    modes: [TOOLBAR_MODES.BORROW_CONFIRM],
  }),
  Object.freeze({
    id: TOOLBAR_ACTION_IDS.CONTROL_HANDBACK,
    label: '交给 Agent',
    ariaLabel: '把控制权交回 Agent',
    shortcut: 'H',
    method: 'cooperate.handback',
    intent: { control: 'handback' },
    kind: 'control',
    variant: 'primary',
    decision: false,
    modes: [TOOLBAR_MODES.HELD, TOOLBAR_MODES.BORROW_ACTIVE, TOOLBAR_MODES.MANUAL],
  }),
  Object.freeze({
    id: TOOLBAR_ACTION_IDS.CONTROL_HOLD,
    label: '暂停',
    ariaLabel: '暂停 Agent 的自动操作',
    shortcut: 'P',
    method: 'cooperate.hold',
    intent: { control: 'hold', held: true },
    kind: 'control',
    variant: 'secondary',
    decision: false,
    modes: [TOOLBAR_MODES.BORROW_ACTIVE, TOOLBAR_MODES.IDLE],
  }),
  Object.freeze({
    id: TOOLBAR_ACTION_IDS.CONTROL_RESUME,
    label: '继续',
    ariaLabel: '恢复 Agent 的自动操作',
    shortcut: 'R',
    method: 'cooperate.hold',
    intent: { control: 'hold', held: false },
    kind: 'control',
    variant: 'primary',
    decision: false,
    modes: [TOOLBAR_MODES.HELD],
  }),
  Object.freeze({
    id: TOOLBAR_ACTION_IDS.HELP_DONE,
    label: '完成',
    ariaLabel: '我已完成需要人工协助的操作',
    shortcut: 'Enter',
    method: 'help.done',
    intent: { help: 'done' },
    kind: 'decision',
    variant: 'primary',
    decision: true,
    modes: [TOOLBAR_MODES.HELP],
  }),
  Object.freeze({
    id: TOOLBAR_ACTION_IDS.RECORD_STOP,
    label: '停止录制',
    ariaLabel: '停止录制操作步骤',
    shortcut: 'S',
    method: 'record.stop',
    intent: { record: 'stop' },
    kind: 'control',
    variant: 'secondary',
    decision: false,
    modes: [TOOLBAR_MODES.RECORD],
  }),
  Object.freeze({
    id: TOOLBAR_ACTION_IDS.TOOLBAR_DISMISS,
    label: '收起',
    ariaLabel: '收起悬浮工具栏',
    shortcut: 'Esc',
    method: 'toolbar.dismiss',
    intent: { toolbar: 'dismiss' },
    kind: 'dismiss',
    variant: 'ghost',
    decision: false,
    modes: [TOOLBAR_MODES.BORROW_ACTIVE, TOOLBAR_MODES.HELD, TOOLBAR_MODES.RECORD, TOOLBAR_MODES.MANUAL],
  }),
]);

const ACTION_BY_ID = new Map(TOOLBAR_ACTIONS.map((action) => [action.id, action]));

/** 键盘映射：key → 语义动作。方向键同时接受上下（水平/垂直布局都可用）。 */
export const TOOLBAR_KEYMAP = Object.freeze({
  next: Object.freeze(['ArrowRight', 'ArrowDown']),
  prev: Object.freeze(['ArrowLeft', 'ArrowUp']),
  first: Object.freeze(['Home']),
  last: Object.freeze(['End']),
  activate: Object.freeze(['Enter', ' ']),
  dismiss: Object.freeze(['Escape']),
  trapNext: Object.freeze(['Tab']),
  trapPrev: Object.freeze(['Shift+Tab']),
  help: Object.freeze(['?']),
});

/** 单词快捷键（无修饰键）：方便读屏/键盘用户快速执行动作。 */
export const TOOLBAR_LETTER_SHORTCUTS = Object.freeze({
  h: TOOLBAR_ACTION_IDS.CONTROL_HANDBACK,
  p: TOOLBAR_ACTION_IDS.CONTROL_HOLD,
  r: TOOLBAR_ACTION_IDS.CONTROL_RESUME,
  s: TOOLBAR_ACTION_IDS.RECORD_STOP,
  d: TOOLBAR_ACTION_IDS.TOOLBAR_DISMISS,
});

/** 按 id 取动作定义；未知返回 null（调用方给结构化错误，不抛异常）。 */
export function actionById(id) {
  return ACTION_BY_ID.get(String(id == null ? '' : id)) || null;
}

/** 动作表是否包含 id（evaluateAction 用来区分“未知动作”与“模式不匹配”）。 */
export function isKnownActionId(id) {
  return ACTION_BY_ID.has(String(id == null ? '' : id));
}

export const DEFAULT_LOCALE = 'zh';
export const DEFAULT_MAX_TABS = 256;
export const DEFAULT_ANNOUNCEMENT_LIMIT = 8;
export const DEFAULT_HISTORY_LIMIT = 32;
export const DEFAULT_FOCUS_DELAY_MS = 0;

export function num(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function integer(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

export function clip(text, limit) {
  return String(text == null ? '' : text).slice(0, limit);
}

/** toolbar 的 tabId 规整：null/''/非整数都视为没有 tab。 */
export function normalizeToolbarTabId(tabId) {
  if (tabId == null || tabId === '') return null;
  const id = Number(tabId);
  return Number.isInteger(id) ? id : null;
}
