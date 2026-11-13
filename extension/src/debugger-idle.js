// extension/src/debugger-idle.js —— 调试器空闲软分离的纯判定。
//
// 目标：后台/非活动标签页在最后一次 CDP 使用后保留 75s 再 detach，减少反复
// attach 的抖动与“被调试”提示；但网络录制、视频、对话框、规则、仿真等长生命周期
// feature 仍持有调试器时绝不分离，避免丢事件或丢状态。

export const DEFAULT_DEBUGGER_IDLE_MS = 75000;

/** 这些 feature 依赖持续在线的 CDP，空闲时不能分离。 */
export const LONG_LIVED_DEBUGGER_FEATURES = new Set([
  'dialog',
  'network',
  'record',
  'rules-fetch',
  'emulate',
  'fetch-probe',
]);

/**
 * @param {{
 *   attached?: boolean,
 *   tabActive?: boolean,
 *   lastActivity?: number,
 *   now?: number,
 *   idleMs?: number,
 *   activeFeatures?: string[],
 * }} state
 * @returns {boolean} true 表示可以安全 detach
 */
export function shouldIdleDetach(state = {}) {
  if (state.attached !== true) return false;
  // 只对非活动标签页做延迟分离；活动标签页仍由 release 立即 detach，避免提示条常驻。
  if (state.tabActive !== false) return false;
  const lastActivity = Number(state.lastActivity);
  if (!Number.isFinite(lastActivity) || lastActivity <= 0) return false;
  const now = Number.isFinite(Number(state.now)) ? Number(state.now) : Date.now();
  const idleMs = Number.isFinite(Number(state.idleMs)) && Number(state.idleMs) > 0
    ? Number(state.idleMs)
    : DEFAULT_DEBUGGER_IDLE_MS;
  if (now - lastActivity < idleMs) return false;
  const features = Array.isArray(state.activeFeatures) ? state.activeFeatures : [];
  return !features.some((feature) => LONG_LIVED_DEBUGGER_FEATURES.has(String(feature)));
}
