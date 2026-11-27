// lib/action-policy.js —— 动作护栏表：只读判定与来源白名单的唯一来源。
// 默认 fail-closed：未登记的动作按 mutation 处理。
export const READ_ACTIONS = new Set([
  'observe', 'observe-frames', 'snapshot', 'get-html', 'screenshot',
  'read', 'extract', 'extract.discover', 'extract.table', 'extract.list',
  'wait-ms', 'wait-for-element', 'wait-for-navigation',
  'actionable', 'status', 'tab.list', 'window.list', 'session.list',
  'dialog.status', 'dialog.list', 'console', 'network.list', 'network.detail',
  'debug.current', 'debug.history', 'debug.pinned', 'debug.capabilities',
  'video.status', 'video.list', 'video.verify', 'record.status', 'record.list',
  'settings.get', 'cooperate.sync', 'cooperate.wait', 'request-help', 'tab.policy', 'webmcp.list',
]);

export const MUTATING_ACTIONS = new Set([
  'click', 'click-backend', 'click-point', 'shadow.click', 'hover',
  'fill', 'press', 'select', 'focus', 'scroll-to', 'drag', 'wheel',
  'upload', 'download', 'navigate', 'reload', 'navigate-back', 'navigate-forward',
  'evaluate', 'webmcp.call', 'blur',
  'tab.new', 'tab.close', 'tab.select', 'tab.move', 'tab.borrow', 'tab.return',
  'window.newAgent', 'window.close', 'window.focus', 'window.resize', 'window.ensureAgent',
  'dialog.accept', 'dialog.dismiss', 'plan', 'step', 'emulate',
  'video.start', 'video.stop', 'record.start', 'record.stop',
  'network.start', 'network.stop', 'network.replay',
  'debug.start', 'debug.stop', 'debug.rule_add', 'debug.rule_clear',
  'debug.rule_enable', 'debug.rule_disable', 'debug.rule_remove', 'debug.rule_import',
]);

export function isMutatingAction(method) {
  const name = String(method || '');
  if (READ_ACTIONS.has(name)) return false;
  return true;
}

export function originOf(value) {
  try {
    return new URL(String(value)).origin;
  } catch {
    return '';
  }
}

/** 返回 { code, message } 或 null。 */
export function checkActionPolicy(method, { readOnly = false, allowedOrigins = [], url = '' } = {}) {
  if (readOnly && isMutatingAction(method)) {
    return { code: 'E_READ_ONLY', message: '标签页是只读策略，拒绝执行变更动作：' + method };
  }
  const origins = Array.isArray(allowedOrigins) ? allowedOrigins.filter(Boolean) : [];
  if (origins.length && ['navigate', 'tab.new', 'download'].includes(method)) {
    const target = originOf(url);
    if (target && !origins.includes(target)) {
      return { code: 'E_FORBIDDEN', message: '标签页来源策略拒绝：' + target + ' 不在 ' + origins.join(', ') };
    }
  }
  return null;
}
