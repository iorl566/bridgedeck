// ui/preview.html —— 标签页预览 + 聚焦。截图只在本扩展页面显示，不上传。
const params = new URLSearchParams(location.search);
const wanted = Number(params.get('tabId'));
let currentTabId = Number.isInteger(wanted) && wanted > 0 ? wanted : null;

const $ = (id) => document.getElementById(id);
const status = $('status');
const meta = $('meta');
const shot = $('shot');
const empty = $('empty');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findTab() {
  if (currentTabId != null) {
    try {
      return await chrome.tabs.get(currentTabId);
    } catch {
      currentTabId = null;
    }
  }
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0] ? tabs[0] : null;
}

async function focusTab(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  if (Number.isInteger(tab.windowId)) await chrome.windows.update(tab.windowId, { focused: true });
}

async function capture() {
  status.textContent = '截取中…';
  const tab = await findTab();
  if (!tab || !Number.isInteger(tab.id)) {
    status.textContent = '没有可预览的标签页';
    empty.textContent = '没有可预览的标签页';
    return;
  }
  currentTabId = tab.id;
  meta.textContent = (tab.title || '(无标题)') + ' · ' + (tab.url || '');
  try {
    await focusTab(tab);
    await sleep(150);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    shot.src = dataUrl;
    shot.hidden = false;
    empty.hidden = true;
    status.textContent = '已更新 ' + new Date().toLocaleTimeString();
  } catch (error) {
    status.textContent = '截取失败';
    empty.hidden = false;
    shot.hidden = true;
    empty.textContent = '无法截取该标签页：' + ((error && error.message) || error);
  }
}

$('refresh').addEventListener('click', () => { void capture(); });
$('focus').addEventListener('click', async () => {
  const tab = await findTab();
  if (tab) await focusTab(tab);
});

void capture();
