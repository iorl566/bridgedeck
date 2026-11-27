// lib/focus-policy.js —— 前台/焦点策略的唯一判定点。
//
// 原则：**默认不抢用户焦点**。
// - 会话标签页由 debugger.armTab 开启 Emulation.setFocusEmulationEnabled，页面自认可见/聚焦，
//   CDP 原生输入可以直接在后台 Agent Window 派发；
// - 只有显式 `focus: true`（CLI `--focus`）才允许 windows.update({focused:true}) /
//   tabs.update({active:true}) / Page.bringToFront 这类真正置前的操作；
// - 人工交接（request-help / borrow 确认）属于“用户主动请求的界面”，可以置前，但必须一次一格，
//   不随普通动作发生。

/** 调用方是否显式要求前台（CLI `--focus` / 扩展 params.focus）。 */
export function focusRequested(params = {}) {
  return Boolean(params && params.focus === true);
}

/**
 * 兼容旧参数：`--no-focus` 曾用于“后台开窗”，现在默认就是后台。
 * 返回值仅用于日志/诊断，不改变策略。
 */
export function legacyNoFocus(params = {}) {
  return Boolean(params && params.noFocus === true);
}

export const FOCUS_POLICY_NOTE = '默认后台执行；需要置前请显式传 --focus';
