// src/frame-cdp.js —— 跨源/无法注入 frame 的 CDP 兜底采集。
//
// 注入 page-lib 是快速路径；某些 frame（跨源、沙箱、注入被拒）拿不到页面侧能力时，
// 用 CDP 的 Target.setAutoAttach 发现 OOPIF，逐 target 取 AX 树渲染成只读观察文本。
// 这里只做采集，不生成可动作 ref；ref 仍由 page-lib 路径提供。
import { acquire, onEvent, release, send, sendToTarget } from './debugger.js';
import { log } from './log.js';
import { sleep } from './tabs.js';
import { renderAxObservation } from './lib/ax-render.js';
import { normalizeAxTree } from './lib/ax-normalize.js';

const AUTO_ATTACH = {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
  filter: [{ type: 'iframe', exclude: false }],
};

function walkTree(tree, sessionId, inherited) {
  const list = [];
  const stack = [{ node: tree, sessionId }];
  while (stack.length) {
    const current = stack.pop();
    if (!current || !current.node || !current.node.frame) continue;
    const frame = current.node.frame;
    list.push({
      frameId: String(frame.id),
      parentFrameId: frame.parentId ? String(frame.parentId) : '',
      url: String(frame.url || ''),
      sessionId: current.sessionId || '',
    });
    const children = current.node.childFrames || [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: children[index], sessionId: current.sessionId || inherited });
    }
  }
  return list;
}

/**
 * 返回 CDP 能看到的 frame 列表（含 OOPIF），每项带 AX 渲染文本。
 * 失败时返回 []，不抛异常，避免兜底采集把主观察拖垮。
 */
export async function collectCdpFrames(tabId, options = {}) {
  const maxNodes = Number(options.maxNodes) > 0 ? Math.min(Number(options.maxNodes), 400) : 120;
  const sessions = new Map(); // sessionId -> targetInfo
  let state;
  try {
    state = await acquire(tabId, 'cdp-frames');
  } catch (error) {
    log('CDP 兜底采集 attach 失败：' + ((error && error.message) || error));
    return [];
  }
  const offAttach = onEvent(state, 'Target.attachedToTarget', (params) => {
    const targetInfo = (params && params.targetInfo) || {};
    if (targetInfo.type && targetInfo.type !== 'iframe') return;
    const sessionId = params && params.sessionId ? String(params.sessionId) : '';
    if (!sessionId || sessions.has(sessionId)) return;
    sessions.set(sessionId, targetInfo);
    // 递归开启，保证嵌套 OOPIF 也被发现。
    sendToTarget(tabId, sessionId, 'Target.setAutoAttach', AUTO_ATTACH).catch(() => {});
  });
  const offDetach = onEvent(state, 'Target.detachedFromTarget', (params) => {
    const sessionId = params && params.sessionId ? String(params.sessionId) : '';
    if (sessionId) sessions.delete(sessionId);
  });
  try {
    await send(tabId, 'Target.setAutoAttach', AUTO_ATTACH).catch(() => {});
    // 等 attachedToTarget 事件到达；不阻塞太久。
    await sleep(350);
    const sources = [];
    const root = await send(tabId, 'Page.getFrameTree', {}).catch(() => null);
    if (root && root.frameTree) sources.push({ sessionId: '', tree: root.frameTree });
    for (const sessionId of [...sessions.keys()]) {
      const reply = await sendToTarget(tabId, sessionId, 'Page.getFrameTree', {}).catch(() => null);
      if (reply && reply.frameTree) sources.push({ sessionId, tree: reply.frameTree });
    }
    if (!sources.length) return [];
    // 子 session 的树覆盖同名 frame（OOPIF 归属子 target）。
    const byId = new Map();
    for (const source of sources) {
      for (const frame of walkTree(source.tree, source.sessionId, '')) {
        byId.set(frame.frameId, frame);
      }
    }
    const frames = [];
    for (const frame of byId.values()) {
      try {
        if (frame.sessionId) {
          await sendToTarget(tabId, frame.sessionId, 'Accessibility.enable', {}).catch(() => {});
          const tree = await sendToTarget(tabId, frame.sessionId, 'Accessibility.getFullAXTree', frame.parentFrameId ? { frameId: frame.frameId } : {});
          const text = renderAxObservation(normalizeAxTree(tree), null, { maxNodes });
          if (text && text.trim()) frames.push({ ...frame, text });
        } else {
          await send(tabId, 'Accessibility.enable', {}).catch(() => {});
          const tree = await send(tabId, 'Accessibility.getFullAXTree', frame.parentFrameId ? { frameId: frame.frameId } : {});
          const text = renderAxObservation(normalizeAxTree(tree), null, { maxNodes });
          if (text && text.trim()) frames.push({ ...frame, text });
        }
      } catch (error) {
        log('CDP 兜底帧采集失败 frame=' + frame.frameId + '：' + ((error && error.message) || error));
      }
    }
    return frames;
  } catch (error) {
    log('CDP 兜底采集失败：' + ((error && error.message) || error));
    return [];
  } finally {
    offAttach();
    offDetach();
    await release(tabId, 'cdp-frames').catch(() => {});
  }
}
