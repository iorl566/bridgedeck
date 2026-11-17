// src/tools/file-transfer.js —— upload（input 赋值 / 文件选择器拦截 / 拖放）。
import { bridgeError } from '../errors.js';
import { execPage } from '../inject.js';
import { getTab, sleep } from '../tabs.js';
import { acquire, onEvent, release, send as cdpSend } from '../debugger.js';
import { requireTabId } from './shared.js';

/** 兜底：直接用 CDP 把真实文件路径赋给 file input（selector 精确匹配，否则第一个）。 */
async function setFirstFileInputFiles(tabId, paths, selector) {
  const doc = await cdpSend(tabId, 'DOM.getDocument', { depth: -1, pierce: false });
  let found = null;
  if (selector) {
    try {
      const queried = await cdpSend(tabId, 'DOM.querySelector', { nodeId: doc.root.nodeId, selector: String(selector) });
      if (queried && queried.nodeId) {
        const described = await cdpSend(tabId, 'DOM.describeNode', { nodeId: queried.nodeId });
        const node = described && described.node;
        if (node && node.nodeName === 'INPUT') {
          const attrs = node.attributes || [];
          const map = {};
          for (let index = 0; index + 1 < attrs.length; index += 2) map[attrs[index]] = attrs[index + 1];
          if (String(map.type || '').toLowerCase() === 'file') found = node;
        }
      }
    } catch {
      found = null;
    }
  }
  if (!found) {
    (function walk(node) {
      if (found || !node) return;
      if (node.nodeType === 1 && node.nodeName === 'INPUT') {
        const attrs = node.attributes || [];
        const map = {};
        for (let index = 0; index + 1 < attrs.length; index += 2) map[attrs[index]] = attrs[index + 1];
        if (String(map.type || '').toLowerCase() === 'file') {
          found = node;
          return;
        }
      }
      for (const child of node.children || []) walk(child);
    })(doc && doc.root);
  }
  if (!found || !found.backendNodeId) return false;
  await cdpSend(tabId, 'DOM.setFileInputFiles', { files: paths, backendNodeId: found.backendNodeId });
  return true;
}

/** upload：file input 直接赋值；按钮/标签则拦截系统文件选择器。 */
export async function upload(params = {}) {
  const tabId = requireTabId(params);
  await getTab(tabId);
  if (params.mode === 'drop') {
    const paths = Array.isArray(params.paths) ? params.paths.filter((item) => typeof item === 'string' && item) : [];
    if (!paths.length) throw bridgeError('E_BAD_ARG', 'upload --mode drop 需要文件路径');
    await execPage(tabId, 'scroll-to', { ref: params.ref, selector: params.selector }).catch(() => {});
    await sleep(150);
    const rect = await execPage(tabId, 'element-rect', { ref: params.ref, selector: params.selector });
    const x = Math.round(rect.x + rect.width / 2);
    const y = Math.round(rect.y + rect.height / 2);
    const dragData = { items: [], files: paths, dragOperationsMask: 1 };
    await acquire(tabId, 'upload-drop');
    try {
      await cdpSend(tabId, 'Input.dispatchDragEvent', { type: 'dragEnter', x, y, data: dragData });
      await cdpSend(tabId, 'Input.dispatchDragEvent', { type: 'dragOver', x, y, data: dragData });
      await cdpSend(tabId, 'Input.dispatchDragEvent', { type: 'drop', x, y, data: dragData });
      return { ok: true, via: 'drop', names: paths.map((item) => item.split(/[\\/]/).pop()) };
    } finally {
      await release(tabId, 'upload-drop').catch(() => {});
    }
  }
  const probe = await execPage(tabId, 'upload-probe', { ref: params.ref, selector: params.selector });
  if (probe && probe.isFileInput) {
    const hasInline = Array.isArray(params.files) && params.files.some((file) => file && file.base64);
    const directPaths = Array.isArray(params.paths) ? params.paths.filter((item) => typeof item === 'string' && item) : [];
    if (!hasInline && directPaths.length) {
      try {
        await acquire(tabId, 'upload');
        try {
          if (await setFirstFileInputFiles(tabId, directPaths, params.selector)) {
            return { ok: true, names: directPaths.map((item) => item.split(/[\\/]/).pop()), via: 'input-path' };
          }
        } finally {
          await release(tabId, 'upload').catch(() => {});
        }
      } catch {
        // 继续用页面内 base64 赋值
      }
    }
    return execPage(tabId, 'upload', params);
  }

  const paths = Array.isArray(params.paths) ? params.paths.filter((item) => typeof item === 'string' && item) : [];
  if (!paths.length) {
    throw bridgeError('E_BAD_ARG', '该目标不是 input[type=file]，需要文件路径（CLI 与浏览器需在同一台机器）');
  }
  const dbg = await acquire(tabId, 'upload');
  let unsubscribe = null;
  try {
    await cdpSend(tabId, 'Page.enable').catch(() => {});
    await cdpSend(tabId, 'DOM.enable').catch(() => {});
    await cdpSend(tabId, 'Page.setInterceptFileChooserDialog', { enabled: true });
    let chooser = null;
    unsubscribe = onEvent(dbg, 'Page.fileChooserOpened', (event) => {
      chooser = event;
    });
    // 先把目标滚进视口，否则 CDP 点击坐标落在视口外
    await execPage(tabId, 'scroll-to', { ref: params.ref, selector: params.selector }).catch(() => {});
    await sleep(200);
    const rect = await execPage(tabId, 'element-rect', { ref: params.ref, selector: params.selector });
    const x = Math.round(rect.x + rect.width / 2);
    const y = Math.round(rect.y + rect.height / 2);
    await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    let pressed = false;
    try {
      await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      pressed = true;
      await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
      pressed = false;
    } finally {
      if (pressed) await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }).catch(() => {});
    }
    const deadline = Date.now() + 5000;
    while (!chooser && Date.now() < deadline) await sleep(100);
    if (!chooser || !chooser.backendNodeId) {
      // 选择器没拦住：优先用 CDP 把真实路径赋给页面里的 file input（大文件 staging 也适用）
      if (paths.length) {
        try {
          if (await setFirstFileInputFiles(tabId, paths, params.selector)) {
            return { ok: true, names: paths.map((item) => item.split(/[\\/]/).pop()), via: 'hidden-input' };
          }
        } catch {
          // 继续尝试 base64 兜底
        }
      }
      // 有些站点用程序化 click 打开选择器，CDP 拦截不到；退回给页面里的隐藏 file input 赋值
      if (Array.isArray(params.files) && params.files.length) {
        const fallback = await execPage(tabId, 'upload-first', { files: params.files });
        return { ok: true, names: (fallback && fallback.names) || [], via: 'hidden-input' };
      }
      throw bridgeError('E_NO_FILE_CHOOSER', '点击后没有出现文件选择器，且没有可赋值的 input[type=file]');
    }
    await cdpSend(tabId, 'DOM.setFileInputFiles', { files: paths, backendNodeId: chooser.backendNodeId });
    return { ok: true, names: paths.map((item) => item.split(/[\\\\/]/).pop()), via: 'chooser' };
  } finally {
    if (unsubscribe) unsubscribe();
    await cdpSend(tabId, 'Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
    await release(tabId, 'upload').catch(() => {});
  }
}
