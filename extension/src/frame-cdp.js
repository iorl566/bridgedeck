// src/frame-cdp.js —— 跨源/无法注入 frame 的 CDP 兜底采集。
//
// 注入 page-lib 是快速路径；某些 frame（跨源、沙箱、注入被拒）拿不到页面侧能力时，
// 用 CDP 的 Target.setAutoAttach 发现 OOPIF，逐 target 取 AX 树渲染成只读观察文本。
// 这里只做采集，不生成可动作 ref；ref 仍由 page-lib 路径提供。
import { acquire, onEvent, release, send, sendToTarget } from './debugger.js';
import { log } from './log.js';
import { sleep } from './tabs.js';
import { withTimeout } from './timeout.js';
import { renderAxObservation } from './lib/ax-render.js';
import { normalizeAxTree } from './lib/ax-normalize.js';

const AUTO_ATTACH = {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
  filter: [{ type: 'iframe', exclude: false }],
};
const AUTO_DETACH = { autoAttach: false, waitForDebuggerOnStart: false, flatten: true };
const FRAME_READ_TIMEOUT_MS = 5000;
const AX_READ_TIMEOUT_MS = 5000;

function walkTree(tree, sessionId) {
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
      stack.push({ node: children[index], sessionId: current.sessionId || '' });
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
  const axTargets = new Set(); // '' (root) 或 sessionId
  const enableAx = async (sessionId) => {
    const key = sessionId || '';
    if (axTargets.has(key)) return;
    try {
      const call = sessionId
        ? sendToTarget(tabId, sessionId, 'Accessibility.enable', {})
        : send(tabId, 'Accessibility.enable', {});
      await withTimeout(call, AX_READ_TIMEOUT_MS, 'Accessibility.enable');
      axTargets.add(key);
    } catch {
      // 该 target 不可用就不采集 AX
    }
  };
  const readAx = (sessionId, params) => {
    const call = sessionId
      ? sendToTarget(tabId, sessionId, 'Accessibility.getFullAXTree', params)
      : send(tabId, 'Accessibility.getFullAXTree', params);
    return withTimeout(call, AX_READ_TIMEOUT_MS, 'Accessibility.getFullAXTree');
  };
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
    await withTimeout(send(tabId, 'Target.setAutoAttach', AUTO_ATTACH), FRAME_READ_TIMEOUT_MS, 'Target.setAutoAttach').catch(() => {});
    // 等 attachedToTarget 事件到达；不阻塞太久。
    await sleep(350);
    const sources = [];
    const root = await withTimeout(send(tabId, 'Page.getFrameTree', {}), FRAME_READ_TIMEOUT_MS, 'Page.getFrameTree').catch(() => null);
    if (root && root.frameTree) sources.push({ sessionId: '', tree: root.frameTree });
    for (const sessionId of [...sessions.keys()]) {
      const reply = await withTimeout(sendToTarget(tabId, sessionId, 'Page.getFrameTree', {}), FRAME_READ_TIMEOUT_MS, 'Page.getFrameTree').catch(() => null);
      if (reply && reply.frameTree) sources.push({ sessionId, tree: reply.frameTree });
    }
    if (!sources.length) return [];
    // 子 session 的树覆盖同名 frame（OOPIF 归属子 target）。
    const byId = new Map();
    for (const source of sources) {
      for (const frame of walkTree(source.tree, source.sessionId)) {
        byId.set(frame.frameId, frame);
      }
    }
    const frames = [];
    for (const frame of byId.values()) {
      try {
        await enableAx(frame.sessionId);
        const tree = await readAx(frame.sessionId, frame.parentFrameId ? { frameId: frame.frameId } : {});
        const text = renderAxObservation(normalizeAxTree(tree), null, { maxNodes });
        if (text && text.trim()) frames.push({ ...frame, text });
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
    // 关闭自动附加，避免后续 iframe 继续建立 session；再关 AX 域。
    await withTimeout(send(tabId, 'Target.setAutoAttach', AUTO_DETACH), 2000, 'Target.setAutoAttach off').catch(() => {});
    for (const sessionId of [...sessions.keys()]) {
      await withTimeout(sendToTarget(tabId, sessionId, 'Target.setAutoAttach', AUTO_DETACH), 2000, 'Target.setAutoAttach off').catch(() => {});
    }
    for (const key of axTargets) {
      if (key) {
        await withTimeout(sendToTarget(tabId, key, 'Accessibility.disable', {}), 2000, 'Accessibility.disable').catch(() => {});
      } else {
        await withTimeout(send(tabId, 'Accessibility.disable', {}), 2000, 'Accessibility.disable').catch(() => {});
      }
    }
    await release(tabId, 'cdp-frames').catch(() => {});
  }
}
