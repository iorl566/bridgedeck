/** Inline video recording panel; the full page keeps the recording library. */

const $ = (id) => document.getElementById(id);

function setStatus(text, error = false) {
  const node = $('videoStatus');
  node.textContent = text;
  node.style.color = error ? 'var(--danger, #dc2626)' : '';
}

function elapsedText(startedAt) {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sync() {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'bb.rec.state' });
    const state = result?.result ?? result ?? {};
    const active = state.active === true;
    $('videoStart').disabled = active;
    $('videoStop').disabled = !active;
    if (active) {
      setStatus(`录制中 ${elapsedText(state.startedAt ?? Date.now())}`);
    } else {
      setStatus('未开始');
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '读取失败', true);
  }
}

/** Wire the panel controls once per popup. */
export function mountVideoPanel() {
  $('videoStart').addEventListener('click', async () => {
    const tab = await activeTab();
    if (!tab?.id) {
      setStatus('没有可录制的标签页', true);
      return;
    }
    const result = await chrome.runtime.sendMessage({ type: 'bb.rec.start', tabId: tab.id });
    if (!result?.ok) {
      setStatus(result?.error || '开始录制失败', true);
      return;
    }
    await sync();
  });
  $('videoStop').addEventListener('click', async () => {
    const result = await chrome.runtime.sendMessage({ type: 'bb.rec.stop' });
    if (!result?.ok) {
      setStatus(result?.error || '停止录制失败', true);
      return;
    }
    setStatus('正在写入视频…');
    setTimeout(() => void sync(), 1200);
  });
  $('videoOpen').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('ui/record.html') });
  });
  return { sync };
}
