// lib/protocol.mjs —— 方法效果分类与暂停闸门（CLI/daemon/扩展共享的协议事实）
//
// 参考实现把方法分成 passive_read / transient_input / browser_mutation /
// control_plane 四类，暂停时只放行前两类中的读取面和控制面。这里用同一
// 分类，避免 daemon 里维护一份手写白名单。

export const METHOD_EFFECT = {
  // 控制面：会话/浏览器/设置/审计，不触达页面
  'session.start': 'control_plane',
  'session.stop': 'control_plane',
  'session.list': 'control_plane',
  'session.rebind': 'control_plane',
  'session.pause': 'control_plane',
  'session.resume': 'control_plane',
  'browsers': 'control_plane',
  'status': 'control_plane',
  'settings.get': 'control_plane',
  'settings.set': 'control_plane',
  'pair.create': 'control_plane',
  'pair.list': 'control_plane',
  'pair.redeem': 'control_plane',
  'pair.revoke': 'control_plane',
  'local.pair': 'control_plane',
  'local.trust': 'control_plane',
  'audit.list': 'control_plane',
  'operations.list': 'control_plane',
  'operations.get': 'control_plane',
  'daemon.stop': 'control_plane',
  'video.list': 'control_plane',
  'video.prune': 'control_plane',
  'record.list': 'control_plane',
  'debug.history': 'control_plane',
  'debug.delete': 'control_plane',
  'diagnostics.ui': 'control_plane',
  'transfer.begin': 'control_plane',
  'transfer.chunk': 'control_plane',
  'transfer.finish': 'control_plane',
  'transfer.read': 'control_plane',
  'transfer.release': 'control_plane',

  // 读取面
  'observe': 'passive_read',
  'observe-frames': 'passive_read',
  'snapshot': 'passive_read',
  'get-html': 'passive_read',
  'read': 'passive_read',
  'view': 'passive_read',
  'extract': 'passive_read',
  'extract.discover': 'passive_read',
  'extract.table': 'passive_read',
  'extract.list': 'passive_read',
  'console': 'passive_read',
  'network.list': 'passive_read',
  'network.detail': 'passive_read',
  'screenshot': 'passive_read',
  'debug.current': 'passive_read',
  'debug.request': 'passive_read',
  'debug.performance': 'passive_read',
  'cooperate.sync': 'passive_read',

  // 瞬时输入：只影响悬停/探测，不提交
  'hover': 'transient_input',

  // 浏览器变更：暂停时一律阻断
  'navigate': 'browser_mutation',
  'reload': 'browser_mutation',
  'navigate-back': 'browser_mutation',
  'navigate-forward': 'browser_mutation',
  'click': 'browser_mutation',
  'fill': 'browser_mutation',
  'press': 'browser_mutation',
  'select': 'browser_mutation',
  'focus': 'browser_mutation',
  'blur': 'browser_mutation',
  'scroll-to': 'browser_mutation',
  'wheel': 'browser_mutation',
  'drag': 'browser_mutation',
  'upload': 'browser_mutation',
  'download': 'browser_mutation',
  'evaluate': 'browser_mutation',
  'emulate': 'browser_mutation',
  'network.start': 'browser_mutation',
  'network.stop': 'browser_mutation',
  'debug.start': 'browser_mutation',
  'debug.stop': 'browser_mutation',
  'record.start': 'browser_mutation',
  'record.stop': 'browser_mutation',
  'video.start': 'browser_mutation',
  'video.stop': 'browser_mutation',
  'request-help': 'browser_mutation',
  'cooperate.wait': 'browser_mutation',
  'cooperate.handback': 'browser_mutation',
  'dialog.arm': 'browser_mutation',
  'dialog.disarm': 'browser_mutation',
  'dialog.accept': 'browser_mutation',
  'dialog.dismiss': 'browser_mutation',
};

// 与扩展实现对齐补齐的方法（protocol-check 门禁发现的漂移）。
Object.assign(METHOD_EFFECT, {
  'tab.list': 'control_plane', 'tab.new': 'browser_mutation', 'tab.close': 'browser_mutation',
  'tab.select': 'browser_mutation', 'tab.move': 'browser_mutation', 'tab.borrow': 'browser_mutation',
  'tab.return': 'browser_mutation', 'window.list': 'control_plane', 'window.close': 'browser_mutation',
  'window.focus': 'browser_mutation', 'window.resize': 'browser_mutation',
  'dialog.list': 'control_plane', 'dialog.status': 'control_plane', 'dialog.handle': 'browser_mutation',
  'dialog.accept': 'browser_mutation', 'dialog.dismiss': 'browser_mutation',
  'video.status': 'control_plane', 'video.fetch': 'browser_mutation', 'video.recover': 'browser_mutation',
  'video.discard': 'browser_mutation', 'record.status': 'control_plane', 'record.start': 'browser_mutation',
  'record.stop': 'browser_mutation', 'network.replay': 'browser_mutation',
  'debug.capabilities': 'control_plane', 'debug.pin': 'browser_mutation', 'debug.pinned': 'control_plane',
  'debugger.detach': 'browser_mutation', 'screenshot.manual.start': 'browser_mutation',
  'screenshot.manual.frame': 'browser_mutation', 'screenshot.manual.save': 'browser_mutation',
  'shadow.click': 'browser_mutation', 'shadow.read': 'passive_read', 'click-point': 'browser_mutation',
  'control-hint': 'browser_mutation', 'ui.open': 'control_plane', 'operation.await': 'passive_read',
  'operation.cancel': 'control_plane', 'wait-ms': 'passive_read', 'wait-for-element': 'passive_read',
  'wait-for-navigation': 'passive_read', 'actionable': 'passive_read', 'plan': 'control_plane', 'step': 'control_plane',
});

// 扩展 HANDLERS 全覆盖补齐（protocol-check 原先的正则漏掉了下划线/大写方法名）。
Object.assign(METHOD_EFFECT, {
  'debug.rule_add': 'browser_mutation', 'debug.rule_clear': 'browser_mutation',
  'debug.rule_enable': 'browser_mutation', 'debug.rule_disable': 'browser_mutation',
  'debug.rule_remove': 'browser_mutation', 'debug.rule_import': 'browser_mutation',
  'debug.rule_list': 'passive_read', 'debug.rule_export': 'passive_read',
  'debug.fetch_probe': 'browser_mutation',
  'window.ensureAgent': 'browser_mutation', 'window.newAgent': 'browser_mutation',
});
export function effectOf(method) {
  return METHOD_EFFECT[method] || 'browser_mutation';
}

export function isAllowedWhilePaused(method) {
  const effect = effectOf(method);
  return effect === 'passive_read' || effect === 'control_plane';
}

/** 文件传输依赖 daemon 与浏览器同机路径；远程配对实例必须显式拒绝。 */
export function isFileTransferMethod(method) {
  return method === 'upload' || method === 'download';
}

export function shouldRejectRemoteTransfer(instance, method) {
  return Boolean(instance && instance.remote === true && isFileTransferMethod(method));
}

export function compareProtocol(a, b) {  const parse = (value) => {
    const match = /^(\d+)(?:\.(\d+))?$/.exec(String(value == null ? '' : value).trim());
    return match ? { major: Number(match[1]), minor: Number(match[2] || 0) } : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  if (pa.major !== pb.major) return pa.major - pb.major;
  return pa.minor - pb.minor;
}
