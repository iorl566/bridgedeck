// lib/methods.mjs —— 方法分类与变异判定的唯一来源。
//
// daemon 的路由集合、意图账本的“是否变异”、CLI/MCP 的协议门禁都从这里取，
// 避免 LOCAL/SESSION/INSTANCE/MUTATING 四份手写清单继续漂移。
// 效果分类仍以 lib/protocol.mjs 的 METHOD_EFFECT 为准。

import { METHOD_EFFECT, effectOf } from './protocol.mjs';

// daemon 自己处理的方法（PROTOCOL §4）；daemon.stop 是内部生命周期方法。
export const LOCAL_METHODS = new Set([
  'status', 'browsers', 'session.start', 'session.stop', 'session.pause', 'session.resume', 'session.list', 'daemon.stop',
  'view', 'settings.get', 'settings.set', 'audit.list', 'operations.list', 'operations.get', 'inflight.list',
  'command.cancel', 'session.rebind', 'local.pair', 'local.trust',
  'pair.create', 'pair.list', 'pair.redeem', 'pair.revoke',
  'ledger.status', 'ledger.resolve',
  'transfer.begin', 'transfer.chunk', 'transfer.finish', 'transfer.read', 'transfer.release',
]);

// 需要会话上下文、由 daemon 注入 tabId 的扩展方法（PROTOCOL §5.2 + window.resize）。
export const SESSION_METHODS = new Set([
  'navigate', 'reload', 'navigate-back', 'navigate-forward',
  'wait-ms', 'wait-for-navigation', 'wait-for-element',
  'observe', 'observe-frames', 'shadow.click', 'shadow.read', 'snapshot', 'get-html', 'screenshot',
  'screenshot.manual.start', 'screenshot.manual.frame', 'screenshot.manual.save',
  'click', 'hover', 'fill', 'actionable', 'press', 'select', 'focus', 'scroll-to',
  'read', 'extract', 'extract.discover', 'extract.table', 'extract.list', 'drag', 'wheel', 'blur', 'upload', 'download', 'click-point',
  'dialog.arm', 'dialog.disarm', 'dialog.list', 'dialog.handle',
  'dialog.status', 'dialog.accept', 'dialog.dismiss', 'operation.await', 'operation.cancel',
  'cooperate.sync', 'cooperate.wait', 'cooperate.handback',
  'debug.start', 'debug.stop', 'debug.current', 'debug.request', 'debug.performance',
  'debug.history', 'debug.delete', 'debug.fetch_probe', 'debug.rule_add', 'debug.rule_list', 'debug.rule_clear', 'debug.rule_export', 'debug.rule_import',
  'debug.rule_enable', 'debug.rule_disable', 'debug.rule_remove', 'debug.capabilities', 'debug.pin', 'debug.pinned',
  'video.start', 'video.stop', 'video.status', 'video.list', 'video.fetch', 'video.discard', 'video.prune', 'video.recover',
  'record.start', 'record.stop', 'record.status', 'record.list',
  'network.start', 'network.stop', 'network.list', 'network.detail', 'network.replay',
  'emulate',
  'plan', 'step', 'request-help',
  'evaluate', 'console', 'window.resize', 'tab.borrow', 'tab.return',
]);

// 不需要会话、但要选一个浏览器实例的方法（PROTOCOL §5.1）。
export const INSTANCE_METHODS = new Set([
  'window.ensureAgent', 'window.newAgent', 'window.close', 'window.list', 'window.focus', 'tab.list', 'tab.new', 'tab.close', 'tab.select', 'tab.move',
  'diagnostics.ui', 'ui.open',
]);

export const EXT_METHODS = new Set([...SESSION_METHODS, ...INSTANCE_METHODS]);

// 这些方法本身在等待/解除另一个命令，不能排在它后面，否则会死锁。
export const SESSION_QUEUE_BYPASS = new Set([
  'operation.await', 'operation.cancel',
  'dialog.status', 'dialog.accept', 'dialog.dismiss',
  'cooperate.wait', 'cooperate.handback', 'cooperate.sync',
  'wait-for-navigation',
  'debug.fetch_probe',
  'request-help',
  'session.pause', 'session.resume', 'session.rebind',
]);

const MUTATING = new Set([
  'click', 'fill', 'type', 'press', 'select', 'drag', 'wheel', 'scroll-to',
  'upload', 'download', 'navigate', 'navigate-back', 'navigate-forward', 'reload',
  'back', 'forward',
  'tab.new', 'tab.close', 'tab.select', 'tab.move', 'tab.borrow',
  'window.new', 'window.close', 'window.focus', 'window.resize', 'window.ensure',
  'session.start', 'session.stop', 'session.rebind', 'session.pause',
  'emulate', 'plan',
  'video.start', 'video.stop',
  'dialog.accept', 'dialog.dismiss',
  'debug.fetch_probe', 'debug.rule_add', 'debug.rule_clear', 'debug.replay',
]);

const CONTROL_MUTATING = new Set(['session.start', 'session.start_tracked', 'session.rebind', 'plan', 'step']);

/** 是否属于需要预写意图账本的变异操作（分类逻辑从 intent-ledger 迁入）。 */
export function isMutating(method) {
  const name = String(method || '');
  if (!Object.prototype.hasOwnProperty.call(METHOD_EFFECT, name)) return MUTATING.has(name);
  const effect = effectOf(name);
  if (effect === 'browser_mutation' || effect === 'transient_input') return true;
  // 少数 control_plane 方法会创建/重建会话窗口，仍属于需要账本保护的变异。
  if (effect === 'control_plane') return CONTROL_MUTATING.has(name) || MUTATING.has(name);
  if (effect === 'passive_read') return false;
  return MUTATING.has(name);
}

/** 'local' | 'session' | 'instance' | null，供路由与门禁使用。 */
export function methodScope(method) {
  const name = String(method || '');
  if (LOCAL_METHODS.has(name)) return 'local';
  if (SESSION_METHODS.has(name)) return 'session';
  if (INSTANCE_METHODS.has(name)) return 'instance';
  return null;
}

/** 返回分类清单的错误列表；空数组表示一致。protocol-check 与单测共用。 */
export function validateMethodRegistry() {
  const errors = [];
  for (const method of SESSION_METHODS) {
    if (!METHOD_EFFECT[method]) errors.push(`会话方法 ${method} 不在 METHOD_EFFECT`);
  }
  for (const method of INSTANCE_METHODS) {
    if (!METHOD_EFFECT[method]) errors.push(`实例方法 ${method} 不在 METHOD_EFFECT`);
  }
  for (const method of LOCAL_METHODS) {
    if (EXT_METHODS.has(method)) errors.push(`方法 ${method} 同时被声明为 local 与扩展方法`);
  }
  for (const method of SESSION_METHODS) {
    if (INSTANCE_METHODS.has(method)) errors.push(`方法 ${method} 同时被声明为 session 与 instance`);
  }
  for (const method of SESSION_QUEUE_BYPASS) {
    if (!SESSION_METHODS.has(method) && !LOCAL_METHODS.has(method)) errors.push(`队列旁路方法 ${method} 没有归属`);
  }
  return errors;
}
