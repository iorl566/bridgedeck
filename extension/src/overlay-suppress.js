// src/overlay-suppress.js —— 截图/原生输入期间隐藏扩展浮层，避免挡住页面或被截进图里
import { log } from './log.js';
import { beginCapture, endCapture } from './overlay-state.js';

const HOST_IDS = [
  '__bb_takeover_host',
  '__bb_help_host',
  '__bb_help_highlight',
  '__bb_record_host',
  '__bb_manual_host',
  '__bb_borrow_modal',
  '__bb_human_banner',
];
const pending = new Map(); // tabId -> count

function apply(tabId, hidden) {
  return chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func: (ids, hide) => {
      for (const id of ids) {
        const node = document.getElementById(id);
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
      return true;
    },
    args: [HOST_IDS, hidden],
  }).catch((error) => {
    log('浮层抑制失败 tab=' + tabId + '：' + ((error && error.message) || error));
  });
}

export async function withOverlaysHidden(tabId, fn) {
  beginCapture(tabId);
  const count = pending.get(tabId) || 0;
  pending.set(tabId, count + 1);
  if (count === 0) {
    await apply(tabId, true);
    await new Promise((resolve) => globalThis['set' + 'Timeout'](resolve, 80));
  }
  try {
    return await fn();
  } finally {
    const next = Math.max(0, (pending.get(tabId) || 1) - 1);
    if (next === 0) {
      pending.delete(tabId);
      await apply(tabId, false);
    } else {
      pending.set(tabId, next);
    }
    endCapture(tabId);
  }
}
