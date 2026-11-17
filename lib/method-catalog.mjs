// lib/method-catalog.mjs —— 方法目录：效果分类 + 能力桶 + 回执语义。
// 这是 daemon/CLI/扩展共享的单一解释入口（比在每个调用点猜 effect 更稳定）。
import { METHOD_EFFECT } from './protocol.mjs';

const EXPLICIT = {
  observe: 'frames',
  'observe-frames': 'frames',
  snapshot: 'frames',
  'get-html': 'frames',
  click: 'input',
  hover: 'input',
  fill: 'input',
  press: 'input',
  select: 'input',
  drag: 'input',
  wheel: 'input',
  upload: 'input',
  download: 'input',
  'click-point': 'input',
  'shadow.click': 'input',
  'navigate': 'navigation',
  'reload': 'navigation',
  'navigate-back': 'navigation',
  'navigate-forward': 'navigation',
  screenshot: 'capture',
  'longshot': 'capture',
  'video.start': 'capture',
  'video.stop': 'capture',
  'debug.start': 'debug',
  'debug.stop': 'debug',
  'network.replay': 'debug',
  'cooperate.sync': 'cooperation',
  'cooperate.wait': 'cooperation',
  'cooperate.handback': 'cooperation',
  'session.start': 'session',
  'session.stop': 'session',
  'session.rebind': 'session',
  'pair.create': 'remote',
  'pair.redeem': 'remote',
  'pair.revoke': 'remote',
  'pair.renew': 'remote',
};

const RECEIPT_EFFECTS = new Set(['transient_input', 'browser_mutation']);

export function describeMethod(method) {
  const name = String(method || '');
  const effect = METHOD_EFFECT[name] || 'control_plane';
  return {
    method: name,
    effect,
    feature: EXPLICIT[name] || 'core',
    receipt: RECEIPT_EFFECTS.has(effect),
  };
}

export function listMethods() {
  return Object.keys(METHOD_EFFECT).sort().map(describeMethod);
}
