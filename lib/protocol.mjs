// lib/protocol.mjs —— 方法效果分类与暂停闸门（CLI/daemon/扩展共享的协议事实）
//
// 参考实现把方法分成 passive_read / transient_input / browser_mutation /
// control_plane 四类，暂停时只放行前两类中的读取面和控制面。这里用同一
// 分类，避免 daemon 里维护一份手写白名单。

export const METHOD_EFFECT = {
  // 控制面：会话/浏览器/设置/审计，不触达页面
  'session.start': 'control_plane',
  'session.start_tracked': 'control_plane',
  'session.stop': 'control_plane',
  'session.stop_all': 'control_plane',
  'session.list': 'control_plane',
  'session.rebind': 'control_plane',
  'session.pause': 'control_plane',
  'session.resume': 'control_plane',
  'session.request': 'control_plane',
  'browser.list': 'control_plane',
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
  'audit.clear': 'control_plane',
  'operations.list': 'control_plane',
  'operations.get': 'control_plane',
  'daemon.stop': 'control_plane',
  'daemon.status': 'control_plane',
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
  'network.export': 'passive_read',
  'screenshot': 'passive_read',
  'debug.current': 'passive_read',
  'debug.history_detail': 'passive_read',
  'debug.requests': 'passive_read',
  'debug.request': 'passive_read',
  'debug.console': 'passive_read',
  'debug.pages': 'passive_read',
  'debug.performance': 'passive_read',
  'debug.aggregate': 'passive_read',
  'debug.duplicates': 'passive_read',
  'debug.operations': 'passive_read',
  'debug.operation': 'passive_read',
  'cooperate.sync': 'passive_read',

  // 瞬时输入：只影响悬停/探测，不提交
  'hover': 'transient_input',
  'probe-hover': 'transient_input',

  // 浏览器变更：暂停时一律阻断
  'navigate': 'browser_mutation',
  'reload': 'browser_mutation',
  'back': 'browser_mutation',
  'forward': 'browser_mutation',
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
  'network.rule_add': 'browser_mutation',
  'network.rule_clear': 'browser_mutation',
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
