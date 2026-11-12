// src/diagnostics.js —— 扩展自检：弹窗/设置页/图标是否真的打进包里
export async function uiDiagnostics() {
  const checkPage = async (pagePath, needles) => {
    try {
      const url = chrome.runtime.getURL(pagePath);
      const response = await fetch(url);
      const text = await response.text();
      const missing = needles.filter((needle) => !text.includes(needle));
      return { path: pagePath, ok: response.ok && missing.length === 0, bytes: text.length, missing };
    } catch (error) {
      return { path: pagePath, ok: false, error: String((error && error.message) || error) };
    }
  };
  const checkAsset = async (assetPath) => {
    try {
      const response = await fetch(chrome.runtime.getURL(assetPath));
      return { path: assetPath, ok: response.ok, bytes: Number(response.headers.get('content-length') || 0) };
    } catch (error) {
      return { path: assetPath, ok: false, error: String((error && error.message) || error) };
    }
  };
  const popup = await checkPage('ui/popup.html', ['popup.js', 'popup.css', 'connToggle']);
  const options = await checkPage('ui/options.html', ['options.js', 'ui.css', 'instanceLabel']);
  const quick = await checkPage('ui/quick.html', ['quick.js', '视频录制', '网站调试', '长截图', '操作录制', '操作审计']);
  const record = await checkPage('ui/record.html', ['record.js', 'MP4']);
  const debugPage = await checkPage('ui/debug.html', ['debug.js', '网站调试']);
  const longshot = await checkPage('ui/longshot.html', ['longshot.js', '长截图']);
  const ops = await checkPage('ui/ops.html', ['ops.js', '操作录制']);
  const audit = await checkPage('ui/audit.html', ['audit.js', '操作审计']);
  const icons = [];
  for (const size of [16, 32, 48, 128]) {
    icons.push({ size, ...(await checkAsset('icons/icon' + size + '.png')) });
  }
  const pages = { popup, options, quick, record, debug: debugPage, longshot, ops, audit };
  const ok = Object.values(pages).every((page) => page.ok) && icons.every((icon) => icon.ok);
  return { ok, popup, options, quick, record, debug: debugPage, longshot, ops, audit, icons, packageVersion: chrome.runtime.getManifest().version };
}

import { markSelfCreated } from './tabs.js';

/** 在浏览器里打开扩展自己的页面（弹窗/设置），便于真实验证 UI 渲染。 */
export async function uiOpen(params = {}) {
  const PAGES = {
    popup: 'ui/popup.html',
    options: 'ui/options.html',
    quick: 'ui/quick.html',
    record: 'ui/record.html',
    debug: 'ui/debug.html',
    longshot: 'ui/longshot.html',
    ops: 'ui/ops.html',
    audit: 'ui/audit.html',
  };
  const page = Object.prototype.hasOwnProperty.call(PAGES, params.page) ? params.page : 'popup';
  let url = chrome.runtime.getURL(PAGES[page]);
  if (typeof params.query === 'string' && params.query) {
    url += '?' + params.query.replace(/^\?/, '');
  }
  const tab = await chrome.tabs.create({ url, active: params.active === true });
  markSelfCreated(tab.id);
  return { tabId: tab.id, windowId: tab.windowId, page, url };
}
