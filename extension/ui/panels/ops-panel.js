/** Inline operation-recording panel; the full page keeps export, delete and JSON. */

const $ = (id) => document.getElementById(id);

function setStatus(text, error = false) {
  $('opsStatus').textContent = text;
  $('opsStatus').style.color = error ? 'var(--danger, #dc2626)' : '';
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function renderRuns(recordings) {
  const container = $('opsRuns');
  container.replaceChildren();
  for (const recording of (recordings || []).slice(0, 3)) {
    const row = document.createElement('div');
    row.className = 'audit-run';
    const content = document.createElement('span');
    const name = document.createElement('b');
    name.textContent = recording.title || recording.url || '录制';
    const meta = document.createElement('small');
    meta.textContent = `${(recording.events || []).length} 条事件`;
    content.append(name, meta);
    row.append(content);
    container.append(row);
  }
}

async function sync() {
  try {
    const tab = await activeTab();
    const state = await chrome.runtime.sendMessage({ type: 'bb.ops.active' });
    const list = state?.active ?? state?.result?.active ?? [];
    const recording = list.find((item) => item.tabId === tab?.id);
    const running = Boolean(recording);
    $('opsStart').disabled = running;
    $('opsStop').disabled = !running;
    setStatus(running ? `录制中 · ${recording.events ?? 0} 条事件` : '未开始');
    const result = await chrome.runtime.sendMessage({ type: 'bb.ops.list' });
    renderRuns(result?.recordings ?? result?.result?.recordings ?? []);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '读取失败', true);
  }
}

/** Wire the panel controls once per popup. */
export function mountOpsPanel() {
  $('opsStart').addEventListener('click', async () => {
    const tab = await activeTab();
    if (!tab?.id) {
      setStatus('没有可录制的标签页', true);
      return;
    }
    const result = await chrome.runtime.sendMessage({ type: 'bb.ops.start', tabId: tab.id });
    if (!result?.ok) {
      setStatus(result?.error || '开始录制失败', true);
      return;
    }
    await sync();
  });
  $('opsStop').addEventListener('click', async () => {
    const tab = await activeTab();
    if (!tab?.id) return;
    const result = await chrome.runtime.sendMessage({ type: 'bb.ops.stop', tabId: tab.id });
    if (!result?.ok) {
      setStatus(result?.error || '停止录制失败', true);
      return;
    }
    setStatus(`已保存 · ${result.recording?.events?.length ?? 0} 条事件`);
    await sync();
  });
  $('opsOpen').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('ui/ops.html') });
  });
  return { sync };
}
