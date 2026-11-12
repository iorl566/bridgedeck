/** Inline debug capture panel; the full page keeps rules, timelines and replay. */

const $ = (id) => document.getElementById(id);

function setStatus(text, error = false) {
  $('debugStatus').textContent = text;
  $('debugStatus').style.color = error ? 'var(--danger, #dc2626)' : '';
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sync() {
  const tab = await activeTab();
  if (!tab?.id) {
    setStatus('没有可采集的标签页', true);
    return;
  }
  const result = await chrome.runtime.sendMessage({ type: 'bb.debug.current', tabId: tab.id });
  const active = result?.ok === true && result.active === true;
  $('debugStart').disabled = active;
  $('debugStop').disabled = !active;
  if (!active) {
    setStatus('未开始');
    $('debugSummary').textContent = '';
    return;
  }
  setStatus(`采集中 · ${result.title || result.url || '当前标签页'}`);
  $('debugSummary').textContent = `${(result.requests || []).length} 请求 / ${(result.console || []).length} 输出`;
}

/** Wire the panel controls once per popup. */
export function mountDebugPanel() {
  $('debugStart').addEventListener('click', async () => {
    const tab = await activeTab();
    if (!tab?.id) {
      setStatus('没有可采集的标签页', true);
      return;
    }
    const result = await chrome.runtime.sendMessage({ type: 'bb.debug.start', tabId: tab.id });
    if (!result?.ok) {
      setStatus(result?.error || '开始采集失败', true);
      return;
    }
    await sync();
  });
  $('debugStop').addEventListener('click', async () => {
    const tab = await activeTab();
    if (!tab?.id) return;
    const result = await chrome.runtime.sendMessage({ type: 'bb.debug.stop', tabId: tab.id });
    if (!result?.ok) {
      setStatus(result?.error || '停止采集失败', true);
      return;
    }
    setStatus('已停止');
    await sync();
  });
  $('debugHistory').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('ui/debug.html') });
  });
  return { sync };
}
