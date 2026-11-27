// src/overlay-suppress.js —— 截图/原生输入期间隐藏扩展浮层，避免挡住页面或被截进图里
//
// 引用计数抑制在 lib/capture-suppression.js；本模块负责“DOM 到底隐藏了没有”。
// 0.3.0 用 `lease.count === 1` 决定是否 apply(true)，这有一个隐患：dispatch/ops
// 在更外层也 acquire capture 抑制之后（见 lib/suppression-scope.js 的接线），
// overlay-suppress 拿到的 count 已经是 2，于是永远不 apply，浮层就不会被隐藏。
// 现在用独立的 DOM 持有计数（domHeld）判定：第一个 DOM 持有者隐藏、最后一个恢复，
// 与全局 capture 引用计数解耦，嵌套/外层持有时行为都正确。
import { log } from './log.js';
import { captureSuppression } from './lib/capture-suppression.js';
import { beginCapture, endCapture, hasOpenOverlays } from './overlay-state.js';
import { withTimeout } from './timeout.js';

const SUPPRESS_MAX_MS = 180000;

const HOST_IDS = [
  '__bb_takeover_host',
  '__bb_help_host',
  '__bb_help_highlight',
  '__bb_record_host',
  '__bb_status_chip_host',
  '__bb_manual_host',
  '__bb_borrow_modal',
  '__bb_borrow_toast_host',
  '__bb_human_banner',
  '__bb_control_hint',
];

const domHeld = new Map(); // tabId -> 仍在抑制内的 DOM 持有者数量
const domApplied = new Map(); // tabId -> 是否真的 apply 过 hide=true
const stats = { hides: 0, restores: 0, failures: 0, unsuppressedPaths: 0 };

function apply(tabId, hidden) {
  return chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func: async (ids, hide) => {
      for (const id of ids) {
        const node = document.getElementById(id) || (id === '__bb_takeover_host' ? document.querySelector('[data-bb-ui="takeover"]') : null);
        if (!node) continue;
        if (hide) {
          if (!node.hasAttribute('data-bb-suppressed')) {
            node.setAttribute('data-bb-suppressed', node.style.visibility || '');
          }
          node.style.setProperty('visibility', 'hidden', 'important');
        } else if (node.hasAttribute('data-bb-suppressed')) {
          const previous = node.getAttribute('data-bb-suppressed');
          node.removeAttribute('data-bb-suppressed');
          if (previous) node.style.visibility = previous;
          else node.style.removeProperty('visibility');
        }
      }
      if (hide) {
        // 两帧后再返回：确保隐藏样式已完成一次渲染，截图不会把旧帧带进去。
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }
      return true;
    },
    args: [HOST_IDS, hidden],
  }).then(() => {
    if (hidden) stats.hides += 1;
    else stats.restores += 1;
    return true;
  }).catch((error) => {
    stats.failures += 1;
    log('浮层抑制失败 tab=' + tabId + '：' + ((error && error.message) || error));
    return false;
  });
}

/** 当前 tab 的浮层抑制状态：DOM 是否被隐藏 + 全局 capture 引用计数。 */
export function overlaySuppressionSnapshot(tabId) {
  const id = Number(tabId);
  const capture = captureSuppression.snapshot(Number.isInteger(id) ? id : null);
  return {
    tabId: Number.isInteger(id) ? id : null,
    domHidden: domApplied.get(id) === true,
    domHolders: domHeld.get(id) || 0,
    capture,
    counters: { ...stats },
  };
}

/** 是否处于“浮层已被隐藏”的抑制窗口（diagnostics/浮层模块可据此延后显示）。 */
export function isOverlaySuppressed(tabId) {
  return domApplied.get(Number(tabId)) === true;
}

export async function withOverlaysHidden(tabId, fn) {
  const id = Number(tabId);
  if (!Number.isInteger(id)) {
    stats.unsuppressedPaths += 1;
    return fn();
  }
  // 引用计数抑制：嵌套的截图/原生输入只有最后一个释放时才真正解除。
  const lease = captureSuppression.acquire(id, { owner: 'overlay-suppress' });
  if (!lease.ok) return fn(); // 引用超上限：宁可不隐藏，也不阻塞动作
  beginCapture(id);
  const domCount = (domHeld.get(id) || 0) + 1;
  domHeld.set(id, domCount);
  // 第一个 DOM 持有者负责隐藏；外层 dispatch/ops 的抑制引用不影响这里的判断。
  const firstDomHolder = domCount === 1;
  const shouldHide = firstDomHolder && hasOpenOverlays(id);
  if (shouldHide) {
    domApplied.set(id, true);
    await apply(id, true);
  }
  try {
    // 浮层隐藏必须有上限：动作卡死时不能让页面永久被隐藏。
    return await withTimeout(fn(), SUPPRESS_MAX_MS, 'overlay-suppress');
  } finally {
    const released = captureSuppression.release(id, lease.token);
    const remaining = Math.max(0, (domHeld.get(id) || 1) - 1);
    if (remaining === 0) domHeld.delete(id);
    else domHeld.set(id, remaining);
    // DOM 隐藏跟着“DOM 持有者归零”恢复：dispatch 在更外层持有 capture 引用时，
    // 截图/输入真正结束（本层 release）后就应该把浮层显示回来，不必等外层动作收尾。
    if (remaining === 0 && domApplied.get(id) === true) {
      domApplied.delete(id);
      await apply(id, false);
    }
    // beginCapture/endCapture 是引用计数：每次 acquire 对应一次 release（嵌套平衡）。
    endCapture(id);
  }
}

/** tab 关闭/会话收尾：清掉 DOM 计数并恢复一次（幂等）。 */
export function forgetOverlaySuppression(tabId) {
  const id = Number(tabId);
  if (!Number.isInteger(id)) return { ok: false };
  const had = domApplied.get(id) === true;
  domHeld.delete(id);
  domApplied.delete(id);
  return { ok: true, restored: had };
}
